import {
  WITHDRAWAL_RECORD_VERSION,
  WITHDRAWAL_TERMINAL_PHASES,
  type WithdrawalPhase,
  type WithdrawalRecord,
} from "../core/services/bridge/types"
import type { OnNetwork } from "../types/networkStamp"
import type { Database, Write } from "./database"
import { WalletError, type ErrorCode, type Failure } from "./errors"
import { decodeRecord, encodeRecord, loadRecords, persistentStore } from "./persistentStore"
import type { Loaded } from "./recordSource"
import { derived, type ReadonlyStore } from "./store"
import {
  withdrawalTransition,
  type BurnExecutor,
  type WithdrawalEvent,
} from "./withdrawalTransition"

/** The blob older builds kept every withdrawal in, one JSON object keyed by lowercase `localId`. */
export const KEY_WITHDRAWALS = "@obsidion/withdrawals/records"

/** Longest a pre-mine `submitting` row may sit before it counts as interrupted; proving takes minutes. */
export const WITHDRAWAL_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

/** Fresh `wdraw_*` key for a record created at Confirm. */
export function newWithdrawalLocalId(): string {
  return `wdraw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export interface WithdrawalsDeps {
  /** The account's database. */
  db: Database
}

/**
 * The account's withdrawals, one record each, keyed by lowercase `localId`; the burn's `l2TxHash`
 * also resolves to its record. A record changes only through `withdrawalTransition`. Every record
 * loads; reads hold saved records only. A write without `w` commits on its own and resolves once
 * saved; with one, it joins that transaction.
 */
export interface Withdrawals {
  /** Saved records, newest first; `hydrated` once they loaded. */
  readonly list: ReadonlyStore<Loaded<WithdrawalRecord>>
  readonly ready: Promise<void>
  /** Every record, read once. */
  all(): Promise<readonly WithdrawalRecord[]>
  /** By `localId` or burn hash. */
  get(keyOrHash: string, w?: Write): Promise<WithdrawalRecord | undefined>
  byHash(l2TxHash: string, w?: Write): Promise<WithdrawalRecord | undefined>
  /** Saves `record` whole, stamped with the record version and its network. */
  create(record: OnNetwork<WithdrawalRecord>, w?: Write): Promise<WithdrawalRecord>
  /** Saves a record read off chain or another database, unless one holds its id or burn hash. */
  adopt(
    record: OnNetwork<WithdrawalRecord>,
  ): Promise<{ record: WithdrawalRecord; adopted: boolean }>
  /** The record when `event` changed it. */
  apply(keyOrHash: string, event: WithdrawalEvent, w?: Write): Promise<WithdrawalRecord | undefined>
  remove(keyOrHash: string, w?: Write): Promise<void>
  /** Fails `submitting` rows with no hash older than `maxAgeMs`; the tab that proved them closed. */
  failInterrupted(now: number, maxAgeMs: number): Promise<WithdrawalRecord[]>
  /**
   * Stamps version 1 records with their burn's executor as `burnOf` reads it. A record that names
   * a deployment `burnOf` does not know stays for the next pass.
   */
  migrateExecutors(
    burnOf: (record: WithdrawalRecord) => BurnExecutor | undefined,
  ): Promise<WithdrawalRecord[]>
}

const PREFIX = "acct/withdrawals"

const key = (id: string) => id.toLowerCase()

/** Records stored without `tokenDecimals` all burned an 18-decimal token. */
const UNSTAMPED_TOKEN_DECIMALS = 18

const PHASE_RANK: Record<WithdrawalPhase, number> = {
  submitting: 0,
  l2_mined: 1,
  awaiting_proven: 2,
  finalizing_l1: 3,
  swapping: 4,
  recoverable: 5,
  failed: 6,
  recovered: 7,
  done: 8,
}

/** Two saved copies of one record: the furthest phase, and every field either one learned. */
function merge(existing: WithdrawalRecord, incoming: WithdrawalRecord): WithdrawalRecord {
  const phase =
    PHASE_RANK[incoming.phase] >= PHASE_RANK[existing.phase] ? incoming.phase : existing.phase
  return {
    ...existing,
    ...incoming,
    localId: existing.localId,
    phase,
    l2TxHash: incoming.l2TxHash ?? existing.l2TxHash,
    blockNumber: incoming.blockNumber ?? existing.blockNumber,
    rawAmount: incoming.rawAmount ?? existing.rawAmount,
    relayerTip: incoming.relayerTip ?? existing.relayerTip,
    withdrawalFee: incoming.withdrawalFee ?? existing.withdrawalFee,
    withdrawalId: incoming.withdrawalId ?? existing.withdrawalId,
    l1TxHash: incoming.l1TxHash ?? existing.l1TxHash,
    receivedAmount: incoming.receivedAmount ?? existing.receivedAmount,
    finalizeTxHash: incoming.finalizeTxHash ?? existing.finalizeTxHash,
    failure: incoming.failure ?? existing.failure,
    endTime:
      existing.endTime != null && incoming.endTime != null
        ? Math.max(existing.endTime, incoming.endTime)
        : incoming.endTime ?? existing.endTime,
    phaseEnteredAt: incoming.phaseEnteredAt ?? existing.phaseEnteredAt,
  }
}

/** The words a failed withdrawal carried before failures were codes, by the code each one is. */
const FAILURE_TEXTS: readonly (readonly [RegExp, ErrorCode])[] = [
  [/^This withdrawal was interrupted before it finished\./, "withdrawal.interrupted"],
  [/^Withdrawal transaction dropped in a reorg$/, "withdrawal.reorged"],
  [/^The withdrawal transaction was dropped or reverted\./, "withdrawal.dropped"],
  [/not the active zk\.money tab/i, "withdrawal.inactiveTab"],
  [/^This transaction was not sent\. Please try again later\.$/, "sponsorship.paused"],
  [/^This transaction was not sent\. Aztec network fees are too high/, "sponsorship.feesTooHigh"],
  [
    /^This transaction was not sent: the account has no sponsored transactions left/,
    "sponsorship.allowanceExhausted",
  ],
]

/** A failure's text as its code: the text stays as debug detail when no code names it. */
export function withdrawalFailure(text: string): Failure {
  const code = FAILURE_TEXTS.find(([pattern]) => pattern.test(text))?.[1]
  if (code) return { code }
  return text === "Withdrawal failed"
    ? { code: "withdrawal.failed" }
    : { code: "withdrawal.failed", detail: text }
}

/** A record as this version keeps it: a stored `error` text becomes its `failure`. */
function withFailure(record: WithdrawalRecord): WithdrawalRecord {
  const { error, ...rest } = record as WithdrawalRecord & { error?: unknown }
  if (typeof error !== "string" || rest.failure) return rest
  return { ...rest, failure: withdrawalFailure(error) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The records a `KEY_WITHDRAWALS` blob holds, keyed as this store keys them; copies of one record
 * merge. A malformed blob holds none.
 */
export function decodeWithdrawals(raw: string | null | undefined): [string, WithdrawalRecord][] {
  let parsed: unknown
  try {
    parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  const out = new Map<string, WithdrawalRecord>()
  for (const value of Object.values(parsed)) {
    if (!isRecord(value) || typeof value.localId !== "string" || typeof value.phase !== "string")
      continue
    const stored = withFailure(value as unknown as WithdrawalRecord)
    const record =
      stored.tokenDecimals === undefined
        ? { ...stored, tokenDecimals: UNSTAMPED_TOKEN_DECIMALS }
        : stored
    const id = key(record.localId)
    const held = out.get(id)
    out.set(id, held ? merge(held, record) : record)
  }
  return [...out]
}

/**
 * The withdrawals a database no withdrawal store is open on holds, such as a retired rollup's: this
 * store's records, then the blob's records it lacks.
 */
export function storedWithdrawals(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): WithdrawalRecord[] {
  const out = new Map<string, WithdrawalRecord>()
  for (const k of db.keys(`${PREFIX}/`)) {
    const raw = db.get(k)
    if (raw === null || raw === undefined) continue
    const record = decodeRecord(raw) as WithdrawalRecord
    if (typeof record?.localId === "string") out.set(key(record.localId), record)
  }
  for (const [id, record] of decodeWithdrawals(db.get(KEY_WITHDRAWALS))) {
    if (!out.has(id)) out.set(id, record)
  }
  return [...out.values()]
}

export function createWithdrawals(deps: WithdrawalsDeps): Withdrawals {
  const { db } = deps
  /**
   * The first open imports the blob, each `error` text as its `failure`; a record saved under the
   * store already wins.
   */
  const migrate = async (from: number | undefined, w: Write): Promise<void> => {
    if (from !== undefined)
      throw new WalletError("invariant", `withdrawals: unknown version ${from}`)
    // A withdrawal can be funds in flight: every record carries over. The blob stays for a rollback.
    const records = decodeWithdrawals(await w.get(KEY_WITHDRAWALS))
    const saved = await w.getMany(records.map(([id]) => `${PREFIX}/${id}`))
    records.forEach(([id, record], i) => {
      if (saved[i] === undefined) w.put(`${PREFIX}/${id}`, encodeRecord(record))
    })
  }
  const store = persistentStore<WithdrawalRecord, "hash">(db, {
    prefix: PREFIX,
    version: 1,
    id: (record) => key(record.localId),
    migrate,
    indexes: { hash: (record) => (record.l2TxHash ? [key(record.l2TxHash)] : []) },
    load: "all",
  })
  const list = derived([store.view], ({ records, loaded, failed }) => ({
    records: [...records].sort((a, b) => b.startTime - a.startTime),
    hydrated: loaded && !failed,
  }))
  const all = () => loadRecords(store.view)
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  const byHash = async (l2TxHash: string, w?: Write) => {
    if (!l2TxHash) return undefined
    const hash = key(l2TxHash)
    const [indexed] = await loadRecords(store.query("hash", hash))
    const record = indexed && (await store.get(key(indexed.localId), w))
    return record?.l2TxHash && key(record.l2TxHash) === hash ? record : undefined
  }
  const get = async (keyOrHash: string, w?: Write) =>
    (await store.get(key(keyOrHash), w)) ?? byHash(keyOrHash, w)
  /** Applies each event to its record, in one transaction. */
  const applyAll = (events: readonly (readonly [string, WithdrawalEvent])[], w?: Write) =>
    writing(w, async (w) => {
      const changed: WithdrawalRecord[] = []
      const now = Date.now()
      for (const [id, event] of events) {
        const record = await get(id, w)
        const next = record && withdrawalTransition(record, event, now)
        if (!next) continue
        await store.put(next, w)
        changed.push(next)
      }
      return changed
    })

  const create = async (record: OnNetwork<WithdrawalRecord>, w?: Write) => {
    const stamped: WithdrawalRecord = {
      ...record,
      version: record.version ?? WITHDRAWAL_RECORD_VERSION,
      networkId: record.networkId.toLowerCase(),
    }
    const stored =
      WITHDRAWAL_TERMINAL_PHASES.has(stamped.phase) && !stamped.endTime
        ? { ...stamped, endTime: Date.now() }
        : stamped
    await store.put(stored, w)
    return stored
  }

  return {
    list,
    ready: store.ready,
    all,
    get,
    byHash,
    create,
    adopt: (record) =>
      writing(undefined, async (w) => {
        const held =
          (await store.get(key(record.localId), w)) ??
          (record.l2TxHash ? await byHash(record.l2TxHash, w) : undefined)
        if (held) return { record: held, adopted: false }
        return { record: await create(record, w), adopted: true }
      }),
    async apply(keyOrHash, event, w) {
      const [next] = await applyAll([[keyOrHash, event]], w)
      return next
    },
    remove: (keyOrHash, w) =>
      writing(w, async (w) => {
        const record = await get(keyOrHash, w)
        await store.remove(key(record?.localId ?? keyOrHash), w)
      }),
    async failInterrupted(now, maxAgeMs) {
      const due = (await all()).filter((r) => now - r.startTime >= maxAgeMs)
      return applyAll(due.map((r) => [r.localId, { type: "interrupted" }] as const))
    },
    async migrateExecutors(burnOf) {
      const due = (await all()).filter((r) => (r.version ?? 1) < WITHDRAWAL_RECORD_VERSION)
      return applyAll(
        due.map((r) => {
          const burn = r.deployment && !r.deployment.executor ? burnOf(r) : undefined
          return [r.localId, { type: "executorMigrated", burn }] as const
        }),
      )
    },
  }
}

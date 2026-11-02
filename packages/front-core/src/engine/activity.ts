import { PaylinkActionEnum, QueueStatus, TokenActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction, TokenTransaction, Transaction } from "../types/transactions"
import type { OnNetwork } from "../types/networkStamp"
import { TRANSACTIONS_STORAGE_KEY, ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import { normalizeTag } from "../utils/normalizeTag"
import type { Database, Write } from "./database"
import {
  decodeRecord,
  encodeRecord,
  loadRecords,
  persistentStore,
  timeKey,
  type IndexRange,
  type RecordSet,
} from "./persistentStore"
import { WalletError, type Failure } from "./errors"
import { keepOwned, activityTransition, type ActivityEvent } from "./activityTransition"
import { legacyRow, legacyRows } from "./activityLegacy"
import { memoryStore, type ReadonlyStore } from "./store"

/** Longest a pre-submit row may sit without a hash before it counts as interrupted; proving takes minutes. */
export const SEND_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

/** Rows the store keeps in memory: the newest, which Home and the recent feed read. */
export const RECENT_ROWS = 10

/**
 * - `time`: the row's timestamp.
 * - `hash`: its own hash and its refund's.
 * - `request`: the payment request it carries.
 * - `peer`: a send's or receive's counterparty, as an address and as a tag.
 * - `link`: a paylink row's secret.
 * - `pending`: every pending row, under `PENDING`.
 * - `open`: every created link still in escrow, under `OPEN`.
 * - `claimed`: a created link's claim time, kept when a reorg undoes the claim.
 */
export type ActivityIndex =
  | "time"
  | "hash"
  | "request"
  | "peer"
  | "link"
  | "pending"
  | "open"
  | "claimed"

export const PENDING = "1"
export const OPEN = "1"

export type Recorded<T extends Transaction> =
  | { tx: T; inserted: true }
  | { tx: Transaction; inserted: false }

export interface ActivityDeps {
  /** The account's database. */
  db: Database
}

/**
 * The account's activity rows, one record each: keyed by operation id for a row this device
 * started, else by tx hash. Every hash a row carries, its refund's included, resolves to that row.
 * A row's status, anchors and claim state change only through `activityTransition`. Reads hold
 * saved rows only. A write without `w` commits on its own and resolves once saved; with one, it
 * joins that transaction.
 */
export interface Activity {
  /** Settles once the open's migration and index build are saved. */
  readonly ready: Promise<void>
  /** The `RECENT_ROWS` newest rows, newest first. */
  readonly view: ReadonlyStore<RecordSet<Transaction>>
  query(index: ActivityIndex, at: string | IndexRange): ReadonlyStore<RecordSet<Transaction>>
  get(id: string, w?: Write): Promise<Transaction | undefined>
  /** The row whose own hash this is. */
  byHash(txHash: string, w?: Write): Promise<Transaction | undefined>
  /** Whether any row carries this hash, as its own or its refund's. */
  hasTxHash(txHash: string, w?: Write): Promise<boolean>
  insertPending(row: OnNetwork<Transaction>, w?: Write): Promise<void>
  /** Stamps the submitted hash on a pending row that has none. False unless the row holds one. */
  setHash(id: string, txHash: string, w?: Write): Promise<boolean>
  /** Changes fields `activityTransition` does not own. */
  patch(id: string, change: (row: Transaction) => Transaction, w?: Write): Promise<boolean>
  /** Applies `event` to the row; the row when it changed. */
  apply(id: string, event: ActivityEvent, w?: Write): Promise<Transaction | undefined>
  /**
   * The flow's own outcome. `epoch` is the row's `reorgEpoch` when the flow started, so a write
   * that a reorg overtook is ignored. True when the row changed.
   */
  settle(id: string, txHash?: string, epoch?: number): Promise<boolean>
  fail(id: string, failure: Failure, epoch?: number): Promise<boolean>
  remove(id: string, w?: Write): Promise<void>
  /** Fails rows this device started that hold no hash and are older than `maxAgeMs`. */
  failInterrupted(now: number, maxAgeMs: number): Promise<Transaction[]>
  /**
   * A row read off chain, keyed by its hash. The first writer of a hash wins, except over a row
   * whose action is `replaces`: this row takes its place, under its id.
   */
  record<T extends Transaction>(
    row: OnNetwork<T>,
    opts?: { replaces?: Transaction["action"] },
    w?: Write,
  ): Promise<Recorded<T>>
  /** Sets the memo on the row with this hash when it has none. */
  backfillMemo(txHash: string, memo: string, w?: Write): Promise<boolean>
  /** Reorg: back to pending under a new epoch, or failed for good. */
  demoteByTxHash(
    txHash: string,
    opts?: { terminal?: "failed" },
  ): Promise<{ matched: boolean; reorgEpoch?: number }>
  /** Settles by hash unless the write is from an older reorg epoch or the row was cancelled. */
  settleByHash(
    txHash: string,
    status: QueueStatus.SUCCESS | QueueStatus.FAILED,
    completionTime: number,
    reorgEpoch?: number,
  ): Promise<{ matched: boolean }>
  /** Every row, read once. */
  all(): Promise<readonly Transaction[]>
  /**
   * Rows from a retired rollup's database, in the legacy format. Nothing here can finish one, so an
   * unfinished row lands failed. A row whose hash, or link, is already here is skipped, and so is
   * one with neither, though a held row takes a counterparty tag the new copy verified. Rows keep the
   * network they were stamped with. Resolves, once saved, to how many were added.
   */
  importHistoricRows(rows: readonly object[]): Promise<number>
}

const lower = (value: string) => value.toLowerCase()

const PREFIX = "acct/activity"

/** Index values: present, lowercase, and free of the key separator. */
function values(...raw: (string | undefined | null | false)[]): string[] {
  return [...new Set(raw.flatMap((v) => (v && !v.includes("/") ? [lower(v)] : [])))]
}

/** A tag as the index keeps it, or an address lowercased. */
const peerOf = (raw: string | undefined) =>
  !raw ? undefined : /^0x/i.test(raw) ? raw : normalizeTag(raw) ?? undefined

const INDEXES: Record<ActivityIndex, (row: Transaction) => readonly string[]> = {
  time: (row) => [timeKey(row.timestamp)],
  hash: (row) => values(row.txHash, (row as PaylinkTransaction).refundTxHash),
  request: (row) => values((row as TokenTransaction).requestId),
  peer: (row) => {
    const tx = row as TokenTransaction
    if (tx.action === "send") return values(peerOf(tx.to), peerOf(tx.toTag))
    if (tx.action === "receive") return values(peerOf(tx.from), peerOf(tx.senderL2Address))
    return []
  },
  link: (row) =>
    typeof (row as PaylinkTransaction).emailPaymentAction === "string"
      ? values((row as PaylinkTransaction).payToEmailSecret)
      : [],
  pending: (row) => (row.status === "pending" ? [PENDING] : []),
  open: (row) => {
    const link = row as PaylinkTransaction
    const escrowed = !link.isClaimed && !link.isRefunded && !link.isMigrated
    return link.emailPaymentAction === PaylinkActionEnum.PAY && escrowed ? [OPEN] : []
  },
  claimed: (row) => {
    const link = row as PaylinkTransaction
    const created = link.emailPaymentAction === PaylinkActionEnum.PAY
    return created && link.claimedAt !== undefined ? [timeKey(link.claimedAt)] : []
  },
}

/**
 * The rows a database no activity store is open on holds, such as a retired rollup's: this store's
 * records, then the legacy blob's, in their own formats.
 */
export function storedActivity(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): object[] {
  const saved = db.keys(`${PREFIX}/`).flatMap((k) => {
    const raw = db.get(k)
    return raw === null || raw === undefined ? [] : [decodeRecord(raw) as object]
  })
  return [...saved, ...legacyRows((k) => db.get(k))]
}

/** Imports the legacy blob's rows on the first open; rows saved under the store already win. */
async function migrate(from: number | undefined, w: Write): Promise<void> {
  if (from === 1 || from === 2) return
  if (from !== undefined) throw new WalletError("invariant", `activity: unknown version ${from}`)
  const [own, account] = await w.getMany([TRANSACTIONS_STORAGE_KEY, ACCOUNT_STORAGE_KEY])
  const legacy = new Map<string, string | undefined>([
    [TRANSACTIONS_STORAGE_KEY, own],
    [ACCOUNT_STORAGE_KEY, account],
  ])
  const rows = new Map<string, Transaction>()
  legacyRows((key) => legacy.get(key)).forEach((row, i) => {
    const converted = legacyRow(row, i)
    rows.set(converted.id, converted)
  })
  const ids = [...rows.keys()]
  const saved = await w.getMany(ids.map((id) => `${PREFIX}/${id}`))
  ids.forEach((id, i) => {
    if (saved[i] === undefined) w.put(`${PREFIX}/${id}`, encodeRecord(rows.get(id)))
  })
}

export function createActivity(deps: ActivityDeps): Activity {
  const { db } = deps
  const store = persistentStore<Transaction, ActivityIndex>(db, {
    prefix: PREFIX,
    version: 3,
    id: (row) => row.id,
    migrate,
    indexes: INDEXES,
    load: { index: "time", window: RECENT_ROWS, reverse: true },
  })
  /** Runs `fn` in the caller's write, or in one of its own. */
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  /** Every row carrying the hash. Inside a write, rows are read through `w`, so what it staged counts. */
  const carrying = async (txHash: string, w?: Write): Promise<Transaction[]> => {
    if (!txHash) return []
    const hash = lower(txHash)
    const [indexed, keyed] = await Promise.all([
      loadRecords(store.query("hash", hash)),
      store.get(hash, w),
    ])
    const rows = new Map(indexed.map((row) => [row.id, row]))
    if (keyed) rows.set(keyed.id, keyed)
    const ids = [...rows.keys()]
    // What the write staged over the saved rows.
    const current = await Promise.all(ids.map((id) => store.get(id, w)))
    return current.flatMap((row) =>
      row &&
      (lower(row.txHash) === hash || lower((row as PaylinkTransaction).refundTxHash ?? "") === hash)
        ? [row]
        : [],
    )
  }
  const own = (rows: Transaction[], txHash: string) =>
    rows.find((row) => !!row.txHash && lower(row.txHash) === lower(txHash))
  const byHash = (txHash: string, w?: Write) =>
    carrying(txHash, w).then((rows) => own(rows, txHash))
  const apply = (id: string, event: ActivityEvent, w?: Write) =>
    store.apply(id, (row) => row && activityTransition(row, event), w)

  return {
    ready: store.ready,
    view: store.view,
    query: store.query,
    get: store.get,
    byHash,
    hasTxHash: async (txHash, w) => (await carrying(txHash, w)).length > 0,
    insertPending: (row, w) => store.put({ ...row, networkId: row.networkId.toLowerCase() }, w),
    async setHash(id, txHash, w) {
      let held = false
      const next = await store.apply(
        id,
        (row) => {
          held = !!row?.txHash
          return row && activityTransition(row, { type: "sent", txHash })
        },
        w,
      )
      return !!next || held
    },
    async patch(id, change, w) {
      return !!(await store.apply(id, (row) => row && keepOwned(row, change(row)), w))
    },
    apply,
    async settle(id, txHash, epoch) {
      return !!(await apply(id, { type: "settled", at: Date.now(), txHash, epoch }))
    },
    async fail(id, failure, epoch) {
      return !!(await apply(id, { type: "failed", at: Date.now(), failure, epoch }))
    },
    remove: store.remove,
    async failInterrupted(now, maxAgeMs) {
      const pending = await loadRecords(store.query("pending", PENDING))
      const due = pending.filter((row) => !!row.operationId && now - row.timestamp >= maxAgeMs)
      if (due.length === 0) return []
      return writing(undefined, async (w) => {
        const failed: Transaction[] = []
        for (const row of due) {
          const next = await apply(row.id, { type: "interrupted" }, w)
          if (next) failed.push(next)
        }
        return failed
      })
    },
    record: <T extends Transaction>(
      row: OnNetwork<T>,
      opts: { replaces?: Transaction["action"] } = {},
      w?: Write,
    ): Promise<Recorded<T>> =>
      writing(w, async (w): Promise<Recorded<T>> => {
        const existing = await byHash(row.txHash, w)
        if (existing && existing.action !== opts.replaces) return { tx: existing, inserted: false }
        const txHash = lower(row.txHash)
        const tx: T = {
          ...row,
          id: existing?.id ?? txHash,
          txHash,
          networkId: row.networkId.toLowerCase(),
        }
        await store.put(tx, w)
        return { tx, inserted: true }
      }),
    backfillMemo: (txHash, memo, w) =>
      writing(w, async (w) => {
        const row = await byHash(txHash, w)
        if (!row || (row as { memo?: string }).memo) return false
        return !!(await store.apply(
          row.id,
          (current) => current && keepOwned(current, { ...current, memo } as Transaction),
          w,
        ))
      }),
    demoteByTxHash: (txHash, opts = {}) =>
      writing(undefined, async (w) => {
        const row = await byHash(txHash, w)
        if (!row) return { matched: false }
        const next = await apply(
          row.id,
          { type: "demoted", at: Date.now(), terminal: opts.terminal },
          w,
        )
        return { matched: true, reorgEpoch: (next ?? row).reorgEpoch }
      }),
    settleByHash: (txHash, status, completionTime, reorgEpoch) =>
      writing(undefined, async (w) => {
        const row = await byHash(txHash, w)
        if (!row) return { matched: false }
        await apply(row.id, { type: "confirmed", at: completionTime, status, epoch: reorgEpoch }, w)
        return { matched: true }
      }),
    all: () => loadRecords(store.query("time", {})),
    importHistoricRows: (legacy) =>
      writing(undefined, async (w) => {
        const saved = await loadRecords(store.query("time", {}))
        const hashes = new Set<string>()
        const links = new Set<string>()
        const ids = new Set<string>()
        const index = (row: Transaction) => {
          ids.add(row.id)
          if (row.txHash) hashes.add(lower(row.txHash))
          const link = (row as PaylinkTransaction).paylink
          if (isLink(row) && link) links.add(link)
        }
        saved.forEach(index)
        let added = 0
        for (const [i, raw] of legacy.entries()) {
          // No queue here owns a retired rollup's row.
          const kept: Record<string, unknown> = { ...raw }
          delete kept.queueId
          const row = historicRow(legacyRow(kept, i))
          const hash = row.txHash ? lower(row.txHash) : undefined
          const link = isLink(row) ? (row as PaylinkTransaction).paylink : undefined
          if (!hash && !link) continue
          const held = hash ? await byHash(hash, w) : undefined
          if (held) {
            const next = withCounterpartyTag(held, row)
            if (next)
              await store.apply(held.id, (current) => current && keepOwned(current, next), w)
            continue
          }
          if ((hash && hashes.has(hash)) || (link && links.has(link)) || ids.has(row.id)) continue
          index(row)
          await store.put(row, w)
          added++
        }
        return added
      }),
  }
}

/** `held` with the counterparty tag a later read of the same transfer verified; undefined when none is new. */
function withCounterpartyTag(held: Transaction, row: Transaction): Transaction | undefined {
  if (held.action !== row.action) return undefined
  const into = held as TokenTransaction
  const from = row as TokenTransaction
  if (row.action === TokenActionEnum.SEND && from.toTag && !into.toTag) {
    return { ...held, toTag: from.toTag } as Transaction
  }
  if (
    row.action === TokenActionEnum.RECEIVE &&
    from.from &&
    from.senderL2Address &&
    from.from !== from.senderL2Address &&
    into.from?.toLowerCase() === from.senderL2Address.toLowerCase()
  ) {
    return { ...held, from: from.from } as Transaction
  }
  return undefined
}

const isLink = (row: Transaction) =>
  typeof (row as PaylinkTransaction).emailPaymentAction === "string"

/** A retired rollup's row as this store keeps it: nothing here can finish an unfinished one. */
function historicRow(row: Transaction): Transaction {
  if (row.status !== "pending") return row
  return {
    ...row,
    status: "failed",
    detailedStatus: QueueStatus.FAILED,
    progress: 100,
    endTime: row.endTime ?? row.timestamp,
    failure: { code: "tx.failed" },
  }
}

/** Rows the Activity screen reads per page. */
export const ACTIVITY_PAGE = 50

export interface ActivityPages {
  /** The newest rows, a page more after each `more`; a page that is loading keeps the last shown. */
  readonly rows: ReadonlyStore<RecordSet<Transaction> & { complete: boolean }>
  /** Reads one more page, once the last one loaded and filled. */
  more(): void
}

/**
 * The Activity screen's rows, newest first. Each page is a larger `time` query; the one shown stays
 * watched until the next one loads, so the list never empties while it grows.
 */
export function activityPages(
  activity: Pick<Activity, "query">,
  page = ACTIVITY_PAGE,
): ActivityPages {
  type Shown = RecordSet<Transaction> & { complete: boolean }
  type Page = { limit: number; query: ReadonlyStore<RecordSet<Transaction>> }
  const shown = memoryStore<Shown>({ records: [], loaded: false, failed: false, complete: false })
  const pageOf = (limit: number): Page => ({
    limit,
    query: activity.query("time", { reverse: true, limit }),
  })
  /** The page shown, and the larger one loading behind it. */
  let held = [pageOf(page)]
  let offs: (() => void)[] = []
  let watchers = 0
  const publish = () => {
    const next = held[held.length - 1].query.get()
    if (held.length > 1 && next.loaded) {
      // The larger page landed: the smaller one goes.
      offs.shift()?.()
      held = held.slice(1)
    } else if (held.length > 1 && next.failed) {
      // The larger page failed: the smaller one stays, and the next `more` reads it again.
      if (offs.length === held.length) offs.pop()?.()
      held = held.slice(0, -1)
    }
    const { limit, query } = held[0]
    const set = query.get()
    shown.set({ ...set, complete: set.loaded && set.records.length < limit })
  }
  const watch = ({ query }: Page) => offs.push(query.subscribe(publish))
  return {
    rows: {
      get: shown.get,
      subscribe(listener) {
        const off = shown.subscribe(listener)
        if (watchers++ === 0) {
          held.forEach(watch)
          publish()
        }
        let done = false
        return () => {
          if (done) return
          done = true
          off()
          if (--watchers > 0) return
          offs.forEach((stop) => stop())
          offs = []
        }
      },
    },
    more() {
      const current = shown.get()
      if (held.length > 1 || !current.loaded || current.complete) return
      const next = pageOf(held[0].limit + page)
      held = [...held, next]
      if (watchers > 0) watch(next)
      publish()
    },
  }
}

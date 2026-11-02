/**
 * The account's activity from the wallet databases this browser kept for retired rollups, carried into
 * the active rollup's stores: its transaction rows, its deposit and withdrawal records that settled
 * there, and those withdrawals' Savings moves. A retired rollup's row can never progress here, so an
 * unfinished one lands failed, and a deposit or withdrawal still moving there stays, for the upgrade
 * to report. Every record keeps, or takes, its retired network's id, so the active network's
 * reconcilers leave it alone; a deposit or withdrawal whose network cannot be told stays too. Runs once per account: the writes run while no
 * account switch may commit, each must reach storage, and only then is the marker written, so a read
 * that could not see every other database, or a write that failed, leaves no marker and the next boot
 * tries again.
 */
import type { IStorageAdapter } from "../storages/adapter"
import { storedActivity, type Activity } from "../../engine/activity"
import type { Transaction } from "../../types/transactions"
import {
  isSettledSipaPhase,
  KEY_SIPA_DEPOSITS,
  type SIPADepositRecord,
  type SIPADepositStore,
} from "../services/deposits/SIPADepositStore"
import { WITHDRAWAL_TERMINAL_PHASES, type WithdrawalRecord } from "../services/bridge/types"
import { storedWithdrawals, type Withdrawals } from "../../engine/withdrawals"
import { KEY_SAVINGS_MOVES, type SavingsMoveStorage } from "../services/savings/SavingsMoveStorage"
import type { SavingsMoveRecord } from "../services/savings/types"
import {
  TRANSFER_SCAN_CURSOR_PREFIX,
  transferScanNetworkOf,
} from "../services/transactions/TransferEventScanner"
import { logger } from "../../utils/logger"

export const HISTORIC_ACTIVITY_IMPORTED_KEY = "@obsidion/historic-activity/imported/v2"

const LOG_PREFIX = "[historicActivity]"

/** This account's part of one retired rollup's database. */
export interface RetiredDatabase {
  /** The rollup version the database is named for. */
  version: string
  get(key: string): string | undefined
  /** This account's keys under `prefix`. */
  keys(prefix: string): string[]
  /** The source read short: what it read is imported, and the marker waits for a full read. */
  partial?: boolean
}

/** A database held as plain entries, as a source generation's `history` hands one over. */
export function retiredDatabaseOf(
  version: string,
  entries: Readonly<Record<string, string>>,
  partial?: boolean,
): RetiredDatabase {
  const items = new Map(Object.entries(entries))
  return {
    version,
    partial,
    get: (key) => items.get(key),
    keys: (prefix) => [...items.keys()].filter((key) => key.startsWith(prefix)),
  }
}

export interface HistoricActivityImportDeps {
  /** The account's storage on the active rollup, where the marker lives. */
  storage: IStorageAdapter
  /** The marker; {@link HISTORIC_ACTIVITY_IMPORTED_KEY} for this browser's databases. */
  key?: string
  /** `read` over each retired rollup's database; rejects when one could not be read. */
  readOtherDatabases<T>(read: (db: RetiredDatabase) => T): Promise<T[]>
  transactions: Pick<Activity, "importHistoricRows">
  sipaDeposits: Pick<SIPADepositStore, "load" | "get" | "create">
  withdrawals: Pick<Withdrawals, "ready" | "adopt">
  savingsMoves: Pick<SavingsMoveStorage, "load" | "get" | "put">
  /** Whether the account the import started for is still the active one; false stops it before a write. */
  ownsStorage?: () => boolean
  /** Runs the writes while no account switch may commit; absent, they run as they are. */
  holdSession?: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface HistoricActivityImported {
  databases: number
  transactions: number
  deposits: number
  withdrawals: number
  savingsMoves: number
  /** Settled deposits and withdrawals left behind because nothing told their network. */
  unstamped: number
}

interface Snapshot {
  version: string
  /** The network the account scanned or recorded there, when exactly one is named. */
  networkId: string | undefined
  rows: Transaction[]
  deposits: SIPADepositRecord[]
  withdrawals: WithdrawalRecord[]
  savingsMoves: SavingsMoveRecord[]
  partial?: boolean
}

/** Imports once per account; null when already done. */
export async function importHistoricActivity(
  deps: HistoricActivityImportDeps,
): Promise<HistoricActivityImported | null> {
  const key = deps.key ?? HISTORIC_ACTIVITY_IMPORTED_KEY
  if ((await deps.storage.getItem(key)) !== null) return null
  const snapshots = await deps.readOtherDatabases(snapshotOf)
  const assertOwner = () => {
    if (deps.ownsStorage && !deps.ownsStorage()) {
      throw new Error("the account changed during the import")
    }
  }
  const writes = async (): Promise<HistoricActivityImported> => {
    const result: HistoricActivityImported = {
      databases: snapshots.length,
      transactions: 0,
      deposits: 0,
      withdrawals: 0,
      savingsMoves: 0,
      unstamped: 0,
    }
    assertOwner()
    await Promise.all([deps.sipaDeposits.load(), deps.withdrawals.ready, deps.savingsMoves.load()])
    for (const snapshot of snapshots) {
      assertOwner()
      result.transactions += await deps.transactions.importHistoricRows(
        snapshot.rows.map((row) => ({ ...row, networkId: row.networkId ?? snapshot.networkId })),
      )
      for (const record of snapshot.deposits) {
        if (!isSettledSipaPhase(record.phase)) continue
        const networkId = record.networkId ?? snapshot.networkId
        if (!networkId) {
          result.unstamped++
          continue
        }
        if (deps.sipaDeposits.get(record.sipaAddress)) continue
        assertOwner()
        const { sipaAddress, ...rest } = record
        if (await deps.sipaDeposits.create(sipaAddress, { ...rest, networkId }, { strict: true })) {
          result.deposits++
        }
      }
      for (const record of snapshot.withdrawals) {
        if (!WITHDRAWAL_TERMINAL_PHASES.has(record.phase)) continue
        const networkId = record.networkId ?? snapshot.networkId
        if (!networkId) {
          result.unstamped++
          continue
        }
        // Another source's copy of the same burn carries its own id.
        assertOwner()
        const { record: held, adopted } = await deps.withdrawals.adopt({ ...record, networkId })
        if (adopted) result.withdrawals++
        const withdrawalLocalId = held.localId
        const move = snapshot.savingsMoves.find((m) => m.withdrawalLocalId === record.localId)
        const current = deps.savingsMoves.get(withdrawalLocalId)
        if (!move || current?.retired) continue
        assertOwner()
        // The retired record's outcome wins over a move this rollup adopted from the burn alone.
        await deps.savingsMoves.put({ ...current, ...move, withdrawalLocalId, retired: true })
        result.savingsMoves++
      }
    }
    assertOwner()
    if (snapshots.some((s) => s.partial)) {
      logger.warn(`${LOG_PREFIX} a source read short; the rest is imported again next boot`)
      return result
    }
    await deps.storage.setItem(
      key,
      JSON.stringify({ at: Date.now(), databases: snapshots.map((s) => s.version) }),
    )
    return result
  }
  const result = await (deps.holdSession ? deps.holdSession(writes) : writes())
  logger.info(
    `${LOG_PREFIX} ${result.databases} database(s): ${result.transactions} rows, ${result.deposits} deposits, ` +
      `${result.withdrawals} withdrawals, ${result.savingsMoves} Savings moves; ${result.unstamped} without a network`,
  )
  return result
}

function snapshotOf(db: RetiredDatabase): Snapshot {
  const label = `wallet_${db.version}`
  const rows = storedActivity(db) as Transaction[]
  const deposits = parseRecords<SIPADepositRecord>(db.get(KEY_SIPA_DEPOSITS), label).filter(
    (r) => typeof r.sipaAddress === "string" && typeof r.phase === "string",
  )
  const withdrawals = storedWithdrawals(db)
  const savingsMoves = parseRecords<SavingsMoveRecord>(db.get(KEY_SAVINGS_MOVES), label).filter(
    (r) => typeof r.withdrawalLocalId === "string",
  )
  const networks = new Set<string>()
  for (const key of db.keys(TRANSFER_SCAN_CURSOR_PREFIX)) {
    const id = transferScanNetworkOf(key)
    if (id) networks.add(id)
  }
  for (const r of [...rows, ...deposits, ...withdrawals]) if (r.networkId) networks.add(r.networkId)
  if (networks.size > 1) {
    logger.warn(
      `${LOG_PREFIX} ${label} names ${networks.size} networks; its unstamped records stay`,
    )
  }
  const [networkId] = networks.size === 1 ? networks : []
  return {
    version: db.version,
    networkId,
    rows,
    deposits,
    withdrawals,
    savingsMoves,
    partial: db.partial,
  }
}

const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null

function parseJson(raw: string | undefined, label: string): unknown {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    logger.warn(`${LOG_PREFIX} ${label} holds a malformed value; skipped`)
    return undefined
  }
}

function parseRecords<T>(raw: string | undefined, label: string): T[] {
  const parsed = parseJson(raw, label)
  return isRecord(parsed) && !Array.isArray(parsed)
    ? (Object.values(parsed).filter(isRecord) as T[])
    : []
}

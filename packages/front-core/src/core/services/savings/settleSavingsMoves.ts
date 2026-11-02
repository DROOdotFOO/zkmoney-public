import {
  backfillSavingsMoveFigures,
  isSavingsMovePending,
  needsVaultFigures,
  savingsMoveOfWithdrawal,
  settleSavingsMove,
  type SavingsMoveSettleDeps,
} from "../../../oxide/savingsMoves"
import { logger } from "../../../utils/logger"
import type { WithdrawalRecord } from "../bridge/types"
import type { SavingsMoveStorage } from "./SavingsMoveStorage"
import type { SavingsMoveRecord } from "./types"

/** Burns with Sky meta the store does not know: a rescan rebuilt them, or a reload cut the move short. */
async function adoptSavingsMoves(
  store: SavingsMoveStorage,
  withdrawals: WithdrawalRecord[],
): Promise<SavingsMoveRecord[]> {
  const adopted: SavingsMoveRecord[] = []
  for (const record of withdrawals) {
    if (record.phase === "failed" || store.get(record.localId)) continue
    const move = savingsMoveOfWithdrawal(record)
    if (!move) continue
    adopted.push(await store.put({ ...move, startTime: record.startTime }))
  }
  return adopted
}

/** The first line of a refusal, short enough for a row. */
export function claimRefusalMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text
    .split("\n")[0]
    .replace(/^Error:\s*/, "")
    .trim()
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

const laterBlock = (a?: string, b?: string): string | undefined =>
  a === undefined ? b : b === undefined ? a : BigInt(a) > BigInt(b) ? a : b

type ScanRange = Pick<SavingsMoveRecord, "depositScanFrom" | "depositScanFloor">
const floorOf = (range: ScanRange) =>
  range.depositScanFloor === undefined ? -1n : BigInt(range.depositScanFloor)
const defined = (range: ScanRange): ScanRange => ({
  ...(range.depositScanFrom !== undefined ? { depositScanFrom: range.depositScanFrom } : {}),
  ...(range.depositScanFloor !== undefined ? { depositScanFloor: range.depositScanFloor } : {}),
})

/**
 * The search range to keep when a pass and another writer both moved it: the one whose floor is
 * higher (the tighter, better-known start: the move flow's head at the burn beats a floor a pass
 * estimated), else the later cursor of the same range. A cursor never moves backwards within its
 * range.
 */
function scanRange(current: ScanRange, pass: ScanRange): ScanRange {
  const a = floorOf(current)
  const b = floorOf(pass)
  if (a !== b) return defined(a > b ? current : pass)
  return defined({
    depositScanFrom: laterBlock(current.depositScanFrom, pass.depositScanFrom),
    depositScanFloor: current.depositScanFloor,
  })
}

export interface SavingsSettlePassDeps extends SavingsMoveSettleDeps {
  /** Re-reads the balances, so a claim stored now shows in its destination's balance. */
  refreshBalance?: () => Promise<void>
}

type PassArgs = Parameters<typeof settlePass> extends [SavingsMoveStorage, ...infer Rest]
  ? Rest
  : never

/** The pass running on each store, and the one queued behind it with the latest caller's inputs. */
const running = new WeakMap<SavingsMoveStorage, Promise<void>>()
type QueuedPass = { args: PassArgs; promise: Promise<void> }
const queued = new WeakMap<SavingsMoveStorage, QueuedPass>()

/**
 * One pass over every pending move: adopt the ones only the burn records know, then find and claim
 * each one's deposit. A burn that failed is left alone; it funded nothing. Each pass leaves what it
 * found on the record, so a row can say why the move still waits. A claim stored now keeps when, and
 * the balances are read at once; until its destination's balance is read after it, the move still
 * counts as funds on their way. One pass runs per store at a time; a caller during a pass gets the
 * next one, which runs on the latest caller's withdrawals, so a burn rebuilt mid-pass is adopted.
 */
export function settleSavingsMoves(
  store: SavingsMoveStorage,
  deps: SavingsSettlePassDeps,
  withdrawals: WithdrawalRecord[] = [],
  /** A found deposit the claim refused; the next pass tries again. */
  onClaimError: (move: SavingsMoveRecord, error: unknown) => void = () => {},
  now: () => number = Date.now,
): Promise<void> {
  const args: PassArgs = [deps, withdrawals, onClaimError, now]
  const next = queued.get(store)
  if (next) {
    next.args = args
    return next.promise
  }
  const current = running.get(store)
  if (!current) return run(store, args)
  const pass: QueuedPass = {
    args,
    promise: current
      .catch(() => {})
      .then((): Promise<void> => {
        queued.delete(store)
        return run(store, pass.args)
      }),
  }
  queued.set(store, pass)
  return pass.promise
}

function run(store: SavingsMoveStorage, args: PassArgs): Promise<void> {
  const pass = settlePass(store, ...args).finally(() => {
    if (running.get(store) === pass) running.delete(store)
  })
  running.set(store, pass)
  return pass
}

async function settlePass(
  store: SavingsMoveStorage,
  deps: SavingsSettlePassDeps,
  withdrawals: WithdrawalRecord[],
  onClaimError: (move: SavingsMoveRecord, error: unknown) => void,
  now: () => number,
): Promise<void> {
  await store.load()
  await adoptSavingsMoves(store, withdrawals)
  // A rebuilt burn whose block time could not be read carries the rebuild's clock, which is after
  // the deposit: the search's floor must come from the destination instead.
  const startedAtOf = (record: SavingsMoveRecord) =>
    withdrawals.find((w) => w.localId === record.withdrawalLocalId)?.startTimeEstimated
      ? undefined
      : record.startTime
  // A move stored before its factory was kept takes it from its burn's Sky meta.
  const withFactory = (record: SavingsMoveRecord): SavingsMoveRecord => {
    const factory =
      record.factory ??
      withdrawals.find((w) => w.localId === record.withdrawalLocalId)?.skyMove?.factory
    return factory && !record.factory ? { ...record, factory } : record
  }
  // Claimed before the vault's figures were kept: read them from the move's transaction, before any
  // claim. A move out's release is the tracker's hash, else found by the DAI paid to its escrow.
  if (deps.vault)
    for (const record of store.list().filter(needsVaultFigures)) {
      const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
      const { move, error } = await backfillSavingsMoveFigures(
        withFactory(record),
        deps,
        startedAtOf(record),
        burn,
      ).catch((error: unknown) => ({ move: record, error }))
      // Removed meanwhile (a cancelled move): not written back.
      const current = store.get(record.withdrawalLocalId)
      if (!current) continue
      const learned = {
        ...(move.deposit ? { deposit: move.deposit } : {}),
        ...(move.vault ? { vault: move.vault } : {}),
        ...(move.vaultUnknown ? { vaultUnknown: move.vaultUnknown } : {}),
        ...(move.vaultLookup !== undefined ? { vaultLookup: move.vaultLookup } : {}),
        ...(move.releaseScanFrom !== undefined ? { releaseScanFrom: move.releaseScanFrom } : {}),
        ...(move.runScanFrom !== undefined ? { runScanFrom: move.runScanFrom } : {}),
      }
      const changed = (Object.keys(learned) as (keyof typeof learned)[]).some(
        (key) => JSON.stringify(learned[key]) !== JSON.stringify(current[key]),
      )
      if (changed || error)
        await store.put({
          ...current,
          ...learned,
          ...(error
            ? {
                lastCheck: {
                  at: now(),
                  message: `vault figures unreadable: ${claimRefusalMessage(error)}`,
                },
              }
            : {}),
        })
    }
  for (const record of store.list()) {
    if (!isSavingsMovePending(record)) continue
    const burn = withdrawals.find((w) => w.localId === record.withdrawalLocalId)
    const startedAt = startedAtOf(record)
    if (burn?.phase === "failed") continue
    let settled: Awaited<ReturnType<typeof settleSavingsMove>>
    try {
      settled = await settleSavingsMove(withFactory(record), deps, startedAt)
    } catch (error) {
      // A chain read that failed for this move: the others still settle.
      const current = store.get(record.withdrawalLocalId)
      if (current)
        await store.put({
          ...current,
          lastCheck: { at: now(), message: `search failed: ${claimRefusalMessage(error)}` },
        })
      continue
    }
    const { move, claimError, stored } = settled
    if (claimError) onClaimError(record, claimError)
    // A claim another writer recorded meanwhile stands, and so does a better search range: neither
    // is written back. A move removed meanwhile stays removed.
    const current = store.get(record.withdrawalLocalId)
    if (!current) continue
    const deposit = current.deposit?.claimed
      ? current.deposit
      : move.deposit && stored
      ? { ...move.deposit, storedAt: now() }
      : move.deposit
    const range = scanRange(current, move)
    const lastCheck = {
      at: now(),
      message: deposit?.claimed
        ? "claimed"
        : claimError
        ? `claim refused: ${claimRefusalMessage(claimError)}`
        : deposit
        ? "deposit found, claim pending"
        : `no deposit on the destination portal yet, searched to block ${
            range.depositScanFrom ?? "0"
          }`,
    }
    await store.put({
      ...current,
      ...move,
      ...(deposit ? { deposit } : {}),
      ...range,
      lastCheck,
      ...(deposit?.claimed ? { endTime: current.endTime ?? now() } : {}),
    })
    if (stored)
      await deps
        .refreshBalance?.()
        .catch((err: unknown) => logger.warn("[settleSavingsMoves] balance refresh failed:", err))
  }
}

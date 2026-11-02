/**
 * Boot order: the balance first, since PXE runs one job at a time. A catch-up before the balance
 * settles opens the boot sync, which holds a catch-up of its own until the replays end or its wait
 * does, so the activity skeleton stays up between the scanner's pass and the replays.
 */

import { TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS } from "../core/services/transactions/TransferEventScanner"
import { logger } from "../utils/logger"
import type { CatchUp } from "./catchUp"
import { derived, memoryStore, type ReadonlyStore } from "./store"

/** Never shorter than the scanner's catch-up read: waiters would flood the first note discovery. */
export const BOOT_WAIT_MS = TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS
export const DEPOSITS_WAIT_MS = 60_000
export const BALANCE_SYNC_WAIT_MS = 180_000
export const HISTORY_WAIT_MS = 60_000

export type Milestone =
  | "firstBalance"
  | "depositsReplayed"
  | "movesReplayed"
  | "oldVersionsRead"
  | "historyAtHead"

/** A bound in ms, or `true` for the milestone's; `whenCatchingUp` applies once the boot sync opened. */
export type Wait = number | true | { ms?: number; whenCatchingUp: number }

const BOUNDS: Record<Milestone, number> = {
  firstBalance: BOOT_WAIT_MS,
  depositsReplayed: DEPOSITS_WAIT_MS,
  movesReplayed: DEPOSITS_WAIT_MS,
  oldVersionsRead: BALANCE_SYNC_WAIT_MS,
  historyAtHead: HISTORY_WAIT_MS,
}

/** Waited for in the order listed; each bound starts when the wait before it ends. */
export type After = Partial<Record<Milestone, Wait>>

type Units = { done: number; total: number }

export interface MilestoneState {
  /** Page ms each milestone was reached at. */
  at: Partial<Record<Milestone, number>>
  syncOpenedAt?: number
  depositsWaitEnded: boolean
  /** The boot sync stopped waiting for the replays, or for a first balance that never came. */
  syncWaitEnded: boolean
  deposits?: Units
  oldVersions?: Units
  /** The highest progress published; a later total never lowers it. */
  shown?: number
}

export interface BalanceSync {
  syncing: boolean
  /** Share of the replays checked, 0–1; null until a total is known. */
  progress: number | null
}

export interface Milestones {
  readonly sync: ReadonlyStore<BalanceSync>
  /** A first balance with no boot sync open also reaches `movesReplayed`: nothing is replayed. */
  mark(milestone: Milestone): void
  /** Ignored for deposits unless the boot sync is open, and for old versions once they are read. */
  progress(of: "deposits" | "oldVersions", done: number, total: number): void
  /** Reached, not given up on. */
  reached(milestone: Milestone): boolean
  /** True once each milestone is reached or its wait ran out; false on abort or `stop`. */
  after(after: After, signal?: AbortSignal): Promise<boolean>
  stop(): void
}

const has = (s: MilestoneState, m: Milestone) => s.at[m] !== undefined

const settled = (s: MilestoneState) =>
  has(s, "firstBalance") &&
  ((has(s, "depositsReplayed") && has(s, "movesReplayed")) || s.depositsWaitEnded)

export function selectSync(s: MilestoneState): BalanceSync {
  const replayed =
    has(s, "depositsReplayed") && has(s, "movesReplayed") && has(s, "oldVersionsRead")
  const syncing = s.syncOpenedAt !== undefined && !s.syncWaitEnded && !(settled(s) && replayed)
  // An unreported pass counts as one unit not done.
  const deposits = s.deposits ?? { done: 0, total: 1 }
  const old = s.oldVersions ?? { done: 0, total: 1 }
  const known = !!s.deposits?.total || !!s.oldVersions?.total
  const share = (deposits.done + old.done) / (deposits.total + old.total)
  return { syncing, progress: syncing && known ? Math.max(share, s.shown ?? 0) : null }
}

export function createMilestones(deps: {
  catchUp: CatchUp
  waits?: Partial<{ boot: number; deposits: number; sync: number }>
}): Milestones {
  const now = () => globalThis.performance?.now() ?? Date.now()
  const waits = { boot: BOOT_WAIT_MS, deposits: DEPOSITS_WAIT_MS, sync: BALANCE_SYNC_WAIT_MS }
  Object.assign(waits, deps.waits)
  const state = memoryStore<MilestoneState>({
    at: {},
    depositsWaitEnded: false,
    syncWaitEnded: false,
  })
  const ended = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let hold: (() => void) | undefined
  let unwatch = () => {}
  let logged = false

  const write = (change: (s: MilestoneState) => MilestoneState) => {
    if (ended.signal.aborted) return
    state.update((s) => {
      const next = change(s)
      return { ...next, shown: selectSync(next).progress ?? next.shown }
    })
    const s = state.get()
    if (!logged && settled(s)) {
      logged = true
      unwatch()
      logger.log(`[boot] balance settled at ${Math.round(now())}ms`)
    }
    if (hold && !selectSync(s).syncing) hold = void hold()
  }
  const later = (ms: number, change: (s: MilestoneState) => MilestoneState) =>
    timers.add(setTimeout(() => write(change), ms))

  const onCatchUp = () => {
    const s = state.get()
    if (!deps.catchUp.status.get() || s.syncOpenedAt !== undefined || settled(s)) return
    hold = deps.catchUp.begin()
    write((s) => ({ ...s, syncOpenedAt: now() }))
    // A first balance that never comes has no replay to wait for.
    later(2 * waits.boot, (s) => (has(s, "firstBalance") ? s : { ...s, syncWaitEnded: true }))
  }
  unwatch = deps.catchUp.status.subscribe(onCatchUp)
  onCatchUp()

  function mark(m: Milestone): void {
    if (has(state.get(), m)) return
    write((s) => {
      const at = { ...s.at, [m]: now() }
      if (m === "firstBalance" && s.syncOpenedAt === undefined) at.movesReplayed = at.firstBalance
      const deposits = s.deposits?.total ?? 0
      const old = s.oldVersions?.total ?? 0
      if (m === "depositsReplayed") s = { ...s, deposits: { done: deposits, total: deposits } }
      if (m === "oldVersionsRead") s = { ...s, oldVersions: { done: old, total: old } }
      return { ...s, at }
    })
    if (m !== "firstBalance") return
    later(waits.deposits, (s) => ({ ...s, depositsWaitEnded: true }))
    later(waits.sync, (s) => ({ ...s, syncWaitEnded: true }))
  }

  /** True once `m` is reached or `ms` passes; false on abort. */
  const reachedWithin = (m: Milestone, ms: number, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (has(state.get(), m) || signal.aborted) return resolve(!signal.aborted)
      const end = (value: boolean) => {
        clearTimeout(timer)
        off()
        signal.removeEventListener("abort", aborted)
        resolve(value)
      }
      const aborted = () => end(false)
      const timer = setTimeout(() => end(true), ms)
      const off = state.subscribe(() => has(state.get(), m) && end(true))
      signal.addEventListener("abort", aborted)
    })

  return {
    sync: derived(
      [state.readonly],
      selectSync,
      (a, b) => a.syncing === b.syncing && a.progress === b.progress,
    ),
    mark,
    progress(of, done, total) {
      const s = state.get()
      if (of === "deposits" ? !selectSync(s).syncing : has(s, "oldVersionsRead")) return
      write((s) => ({ ...s, [of]: { done, total } }))
    },
    reached: (m) => has(state.get(), m),
    async after(after, signal) {
      const stop = new AbortController()
      const abort = () => stop.abort()
      const sources = [signal, ended.signal]
      for (const s of sources) s?.addEventListener("abort", abort)
      if (sources.some((s) => s?.aborted)) abort()
      try {
        // Always yields, so a mark issued beside the call is seen.
        await Promise.resolve()
        for (const [m, wait] of Object.entries(after) as [Milestone, Wait][]) {
          const catchingUp = state.get().syncOpenedAt !== undefined
          const bound = wait === true ? BOUNDS[m] : wait
          const ms =
            typeof bound === "number"
              ? bound
              : catchingUp
              ? bound.whenCatchingUp
              : bound.ms ?? BOUNDS[m]
          if (!(await reachedWithin(m, ms, stop.signal))) return false
        }
        return !stop.signal.aborted
      } finally {
        for (const s of sources) s?.removeEventListener("abort", abort)
      }
    },
    stop() {
      ended.abort()
      unwatch()
      for (const timer of timers) clearTimeout(timer)
      hold = void hold?.()
    },
  }
}

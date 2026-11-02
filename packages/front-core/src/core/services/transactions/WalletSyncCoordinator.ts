/**
 * WalletSyncCoordinator — the one owner of the wallet's chain view. Each pass of its
 * `TransferEventScanner` (the only reader that syncs PXE) reads the private balances at the same
 * anchor and writes them to `BalanceStorage`: Main's token, and any other the source reads
 * (Savings' shares). The UI renders from that store; nothing else in the app syncs PXE to read a
 * balance. The `transferScan` runtime task runs the passes.
 *
 * Every "refresh now" in the app wakes that task: pull-to-refresh and `loadAssets` through the
 * static `refresh()`, a send or withdrawal terminalising through the store watches below. The
 * watches diff terminal keys so pending-row progress writes never trigger a sync, and skip receive
 * rows because those are written by the pass itself. A write that moves the balance but no
 * `Transfer` event (a claimed deposit) uses `refreshBalance()` instead, which never waits behind a
 * scan pass.
 *
 * Its first published balance reaches `firstBalance`; its first pass to reach head, `historyAtHead`.
 */

import { type WalletBalanceRead, type WalletSyncSource, TokenActionEnum } from "@obsidion/sdk"
import type { Transaction } from "../../../types/transactions"
import type { WithdrawalRecord } from "../bridge/types"
import type { ReadonlyStore } from "../../../engine/store"
import type { RecordSet } from "../../../engine/persistentStore"
import type { Milestones } from "../../../engine/milestones"
import { WalletError } from "../../../engine/errors"
import {
  TransferEventScanner,
  type TransferEventScannerOptions,
  type TransferScanContext,
  type TransferScanPass,
} from "./TransferEventScanner"

/** Collapses a burst of refresh requests (e.g. several terminal writes) into one refresh. */
const REFRESH_DEBOUNCE_MS = 500
/** Longest a `refresh()` issued with no running task waits for a pass. */
const REFRESH_WAIT_MS = 60_000
/** Balance-only reads before falling back to a full pass; a concurrent sync can move the anchor. */
const BALANCE_READ_ATTEMPTS = 3

export interface WalletSyncCoordinatorOptions
  extends Omit<TransferEventScannerOptions, "onSynced" | "onCaughtUp"> {
  source: WalletSyncSource
  balance: {
    store: {
      /** False when a newer read is already stored; `strict` rejects a refused write. */
      updateBalance(
        scope: string,
        token: string,
        balance: bigint,
        anchor?: number,
        opts?: { strict?: boolean; readAt?: number },
      ): Promise<boolean>
    }
    scope: string
    /** Main's token: the balance every snapshot must carry, and the one boot waits for. */
    tokenAddress: string
  }
  /**
   * The newest activity rows and every pending one: a new terminal send among them, or a pending
   * row that leaves them wherever it settled, triggers a refresh.
   */
  transactions?: ReadonlyStore<RecordSet<Transaction>>
  /** Withdrawals live in their own store; a record leaving `submitting` triggers a refresh. */
  withdrawals?: ReadonlyStore<{ records: readonly WithdrawalRecord[]; hydrated: boolean }>
  milestones?: Pick<Milestones, "mark">
}

/** How the coordinator reaches the task that runs its passes. */
export interface SyncLink {
  /** Runs a full pass; settles once a pass begun after the call ends. */
  wake(): Promise<void>
  /** Passes may run now: the page is visible. */
  live(): boolean
}

export class WalletSyncCoordinator {
  // ponytail: one session per process (one wallet at a time); key by account if that changes
  private static session: { coordinator: WalletSyncCoordinator; link: SyncLink } | null = null
  private static pending: { promise: Promise<void>; settle: () => void } | null = null

  private static live(): { coordinator: WalletSyncCoordinator; link: SyncLink } | null {
    const session = WalletSyncCoordinator.session
    return session?.link.live() ? session : null
  }

  /**
   * Sync now through the running task. With none running (cold start, its task still building, the
   * page hidden) the promise settles after the next pass, or after `REFRESH_WAIT_MS` so a caller's
   * spinner can never hang on a pass that never comes.
   */
  static refresh(): Promise<void> {
    const live = WalletSyncCoordinator.live()
    if (live) return live.link.wake()
    WalletSyncCoordinator.pending ??= WalletSyncCoordinator.request()
    return WalletSyncCoordinator.pending.promise
  }

  /** A waiting `refresh()`: a pass that takes it settles it, and so does its own cap. */
  private static request(): { promise: Promise<void>; settle: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    const request = {
      promise,
      settle: () => {
        clearTimeout(timer)
        if (WalletSyncCoordinator.pending === request) WalletSyncCoordinator.pending = null
        resolve()
      },
    }
    const timer = setTimeout(request.settle, REFRESH_WAIT_MS)
    return request
  }

  /** The balance alone at a fresh anchor; without a running task, same as `refresh()`. */
  static refreshBalance(): Promise<void> {
    const live = WalletSyncCoordinator.live()
    if (!live) return WalletSyncCoordinator.refresh()
    return live.coordinator.readBalanceCoalesced().then(
      () => {},
      () => live.link.wake(),
    )
  }

  /**
   * The balance alone, read after every pass already in flight has published, so a deposit imported
   * before the call is in it. True only once that read is stored durably: failed reads fall back to
   * a full pass, which refreshes the view but confirms nothing, and with no running task nothing is
   * read.
   */
  static async confirmBalance(): Promise<boolean> {
    const live = WalletSyncCoordinator.live()
    if (!live) return false
    await live.coordinator.drained()
    try {
      return await live.coordinator.readBalanceCoalesced()
    } catch {
      await live.link.wake()
      return false
    }
  }

  private static takePending(): { settle: () => void } | null {
    const pending = WalletSyncCoordinator.pending
    WalletSyncCoordinator.pending = null
    return pending
  }

  private readonly opts: WalletSyncCoordinatorOptions
  private readonly scanner: TransferEventScanner
  private inFlight: Promise<boolean> | null = null
  private balanceRead: Promise<boolean> | null = null
  private balanceReadQueued: Promise<boolean> | null = null

  constructor(options: WalletSyncCoordinatorOptions) {
    this.opts = options
    this.scanner = new TransferEventScanner({
      ...options,
      onSynced: async (anchor, read) => {
        await this.writeBalances(read, anchor)
        options.milestones?.mark("firstBalance")
      },
      onCaughtUp: () => options.milestones?.mark("historyAtHead"),
    })
  }

  /**
   * One scan pass. A `refresh()` that found no running task settles once it ends. An aborted pass
   * lets go of `drained()` and that refresh at once.
   */
  async pass(context: TransferScanContext, opts: TransferScanPass = {}): Promise<boolean> {
    const waiting = WalletSyncCoordinator.takePending()
    const pass = (this.inFlight = this.scanner.pass(context, opts))
    const release = () => {
      if (this.inFlight === pass) this.inFlight = null
      waiting?.settle()
    }
    opts.signal?.addEventListener("abort", release)
    try {
      return await pass
    } finally {
      opts.signal?.removeEventListener("abort", release)
      release()
    }
  }

  /**
   * Routes the static refreshes through `link`, and wakes it, debounced, on a new terminal send or
   * a withdrawal leaving `submitting`. Returns the detach.
   */
  attach(link: SyncLink): () => void {
    let debounce: ReturnType<typeof setTimeout> | undefined
    const wake = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void link.wake(), REFRESH_DEBOUNCE_MS)
    }
    const off: (() => void)[] = []
    const { transactions, withdrawals } = this.opts
    if (transactions) {
      const seen = watch(wake)
      const left = watchLeaving(wake)
      const check = () => {
        const rows = transactions.get()
        if (!rows.loaded) return
        seen(terminalKeys(rows.records))
        left(pendingKeys(rows.records))
      }
      off.push(transactions.subscribe(check))
      check()
    }
    if (withdrawals) {
      const seen = watch(wake)
      const check = () => {
        const list = withdrawals.get()
        if (list.hydrated) seen(advancedKeys(list.records))
      }
      off.push(withdrawals.subscribe(check))
      check()
    }
    const session = { coordinator: this, link }
    WalletSyncCoordinator.session = session
    return () => {
      for (const stop of off) stop()
      clearTimeout(debounce)
      if (WalletSyncCoordinator.session === session) WalletSyncCoordinator.session = null
    }
  }

  /** Settles once no pass is in flight: every pass begun before the call has published. */
  async drained(): Promise<void> {
    while (this.inFlight) await this.inFlight.then(noop, noop)
  }

  /**
   * One read in flight plus one trailing, so a burst of claims costs at most two reads. A caller
   * joins only a read that has not started, so its read always begins after the call.
   */
  readBalanceCoalesced(): Promise<boolean> {
    if (this.balanceReadQueued) return this.balanceReadQueued
    if (!this.balanceRead) return (this.balanceRead = this.runBalanceRead())
    this.balanceReadQueued = this.balanceRead.then(noop, noop).then(() => {
      this.balanceReadQueued = null
      return (this.balanceRead = this.runBalanceRead())
    })
    return this.balanceReadQueued
  }

  private runBalanceRead(): Promise<boolean> {
    return this.readBalanceNow().finally(() => {
      this.balanceRead = null
    })
  }

  private async writeBalances(
    { balances, readAt }: Partial<WalletBalanceRead> = {},
    anchor: number,
    opts?: { strict?: boolean },
  ): Promise<boolean> {
    const { store, scope, tokenAddress } = this.opts.balance
    if (balances?.[tokenAddress] === undefined)
      throw new WalletError("balance.unread", "wallet snapshot omitted its balance")
    let stored = false
    for (const [token, value] of Object.entries(balances)) {
      const wrote = await store.updateBalance(scope, token, value, anchor, {
        ...opts,
        readAt: readAt?.[token],
      })
      if (token === tokenAddress) stored = wrote
    }
    return stored
  }

  /** Whether Main's balance was stored, not passed over for a newer read. */
  private async readBalanceNow(): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { anchorBlock, ...read } = await this.opts.source.readBalanceSnapshot()
        return await this.writeBalances(read, anchorBlock, { strict: true })
      } catch (err) {
        if (attempt >= BALANCE_READ_ATTEMPTS) throw err
      }
    }
  }
}

const noop = () => {}

/** Calls `changed` when a snapshot holds a key the last one lacked; the first only baselines. */
function watch(changed: () => void): (current: Set<string>) => void {
  let previous: Set<string> | undefined
  return (current) => {
    const grew = previous !== undefined && [...current].some((key) => !previous!.has(key))
    previous = current
    if (grew) changed()
  }
}

/** Calls `changed` when a key of the previous set is gone from the current one. */
function watchLeaving(changed: () => void): (current: Set<string>) => void {
  let previous: Set<string> | undefined
  return (current) => {
    const shrank = previous !== undefined && [...previous].some((key) => !current.has(key))
    previous = current
    if (shrank) changed()
  }
}

function pendingKeys(txs: readonly Transaction[]): Set<string> {
  const out = new Set<string>()
  for (const tx of txs) if (tx.status === "pending") out.add(tx.id)
  return out
}

function terminalKeys(txs: readonly Transaction[]): Set<string> {
  const out = new Set<string>()
  for (const tx of txs) {
    if (tx.status === "pending") continue
    if ("action" in tx && tx.action === TokenActionEnum.RECEIVE) continue
    out.add(tx.txHash || tx.id)
  }
  return out
}

function advancedKeys(records: readonly WithdrawalRecord[]): Set<string> {
  const out = new Set<string>()
  for (const r of records) if (r.phase !== "submitting") out.add(r.l2TxHash || r.localId)
  return out
}

/**
 * ActivityFeed — Unified subscribe-able stream of activity items.
 *
 * SIPA deposits and upgrade batches as one chronological feed. Withdrawals reach the screens
 * through the session's withdrawal store and the engine's feed selectors.
 *
 * Eventually-consistent by construction — each store persists independently
 * via single-key IStorageAdapter writes. Snapshot consistency within a single
 * render is not required by any current consumer.
 */

import type { SIPADepositRecord, SIPADepositStore } from "../deposits/SIPADepositStore"
import { isStuckSweep, STUCK_SWEEP_MS } from "../deposits/sipaStuck"
import { sipaCredits } from "../deposits/sipaCredits"
import type { Address } from "viem"
import type { SipaProcessingState } from "../deposits/sipaProcessing"
import type { WithdrawalRecord } from "./types"
import type { UpgradeActivity, UpgradeBatchItem } from "../../migration/upgradeActivity"
import { chainUpgradeBatches } from "../../migration/chainUpgradeBatches"
import { logger } from "../../../utils/logger"

export type BridgeActivityItem =
  /**
   * `processing` is set while the deposit waits for a sweep and a processing source is attached.
   * `credit` is set on a deposit split out of its address's record: another token it credited.
   */
  | {
      kind: "bridge.sipaDeposit"
      record: SIPADepositRecord
      processing?: SipaProcessingState
      credit?: Address
    }
  | { kind: "bridge.withdrawal"; record: WithdrawalRecord }

/** A refund batch of an upgrade: its exit from the old version, paired with its arrival by recipient. */
export type UpgradeActivityItem = { kind: "upgrade.batch"; batch: UpgradeBatchItem }

export type ActivityItem = BridgeActivityItem | UpgradeActivityItem

type ChangedListener = (items: ActivityItem[]) => void

/** Derived processing state for deposits waiting for a sweep (`createSipaProcessingObserver`). */
export interface SipaProcessingSource {
  stateFor(sipaAddress: string): SipaProcessingState | undefined
  subscribe(listener: () => void): () => void
}

export class ActivityFeed {
  private static instance: ActivityFeed | null = null
  private sipaDeposits: SIPADepositStore
  private changedListeners = new Set<ChangedListener>()
  private unsubSipaDeposits: (() => void) | null = null
  private processing: SipaProcessingSource | null = null
  private unsubProcessing: (() => void) | null = null
  private upgrades: UpgradeActivity | null = null
  private unsubUpgrades: (() => void) | null = null
  /** Fires when a deposit hidden behind its own withdrawal has sat long enough to need the user. */
  private wake: ReturnType<typeof setTimeout> | null = null

  private constructor(sipaDeposits: SIPADepositStore) {
    this.sipaDeposits = sipaDeposits
  }

  /**
   * Singleton accessor. The first call must supply the SIPA deposit store. Subsequent calls
   * return the same instance regardless of arguments.
   */
  static get(sipaDeposits?: SIPADepositStore): ActivityFeed {
    if (!ActivityFeed.instance) {
      if (!sipaDeposits) {
        throw new Error("First call to ActivityFeed.get() requires the SIPADepositStore")
      }
      ActivityFeed.instance = new ActivityFeed(sipaDeposits)
    }
    return ActivityFeed.instance
  }

  /**
   * Returns the merged list newest-first. Every store is read at call time, so
   * this is always up to date with whatever each store has persisted.
   */
  list(): ActivityItem[] {
    const now = Date.now()
    // A shown deposit's processing reason waits for the stuck clock (`sipaReasonShown`).
    this.wakeFor(this.processing ? this.sipaDeposits.list() : [], now)
    const items: ActivityItem[] = [
      ...this.sipaDeposits.list().flatMap<ActivityItem>((stored) =>
        sipaCredits(stored).map(({ record, token }) => {
          if (token) return { kind: "bridge.sipaDeposit", record, credit: token }
          const processing = this.processing?.stateFor(record.sipaAddress)
          return processing
            ? { kind: "bridge.sipaDeposit", record, processing }
            : { kind: "bridge.sipaDeposit", record }
        }),
      ),
      ...[...(this.upgrades?.items() ?? []), ...this.chainUpgrades()].map<ActivityItem>(
        (batch) => ({ kind: "upgrade.batch", batch }),
      ),
    ]
    items.sort((a, b) => itemStartTime(b) - itemStartTime(a))
    return items
  }

  /** Deposits no run of this device covers, once its runs are read, so none is listed twice. */
  private chainUpgrades(): UpgradeBatchItem[] {
    if (this.upgrades && !this.upgrades.loaded()) return []
    return chainUpgradeBatches(this.sipaDeposits.list(), this.upgrades?.recipients() ?? new Set())
  }

  /**
   * A deposit still sweeping starts stating its processing reason once its sweep has stalled; no
   * store write marks that moment, so the feed re-emits when the earliest such clock runs out.
   */
  private wakeFor(records: readonly SIPADepositRecord[], now: number): void {
    if (this.wake) clearTimeout(this.wake)
    this.wake = null
    const due = records
      .filter((r) => (r.phase === "sweeping" || r.phase === "broadcast") && !r.sweepTxHash)
      .map((r) => r.startTime + STUCK_SWEEP_MS)
      .filter((at) => at > now)
    if (due.length === 0 || this.changedListeners.size === 0) return
    this.wake = setTimeout(() => this.emit(), Math.max(0, Math.min(...due) - now))
  }

  /**
   * Attach the source that explains why pending deposits wait. The feed annotates their items with it and re-emits when
   * it changes, so every consumer of the feed reads the same reason.
   */
  setProcessingSource(source: SipaProcessingSource | null): void {
    this.unsubProcessing?.()
    this.unsubProcessing = null
    this.processing = source
    if (this.changedListeners.size > 0) this.ensureSubscribed()
    this.emit()
  }

  /** Attach the upgrade runs whose batches the feed lists; it re-emits when one changes. */
  setUpgradeSource(source: UpgradeActivity | null): void {
    this.unsubUpgrades?.()
    this.unsubUpgrades = null
    this.upgrades = source
    if (this.changedListeners.size > 0) this.ensureSubscribed()
    this.emit()
  }

  /**
   * Subscribe to feed changes. Fires when any store emits onListChanged.
   * Returns an unsubscribe function; the aggregator stays lazily connected to
   * the stores for the lifetime of the process.
   */
  onChanged(listener: ChangedListener): () => void {
    this.changedListeners.add(listener)
    this.ensureSubscribed()
    return () => {
      this.changedListeners.delete(listener)
    }
  }

  private ensureSubscribed(): void {
    if (!this.unsubSipaDeposits) {
      this.unsubSipaDeposits = this.sipaDeposits.onListChanged(() => this.emit())
    }
    if (!this.unsubProcessing && this.processing) {
      this.unsubProcessing = this.processing.subscribe(() => this.emit())
    }
    if (!this.unsubUpgrades && this.upgrades) {
      this.unsubUpgrades = this.upgrades.onChanged(() => this.emit())
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.changedListeners) {
      try {
        listener(snapshot)
      } catch (err) {
        logger.warn("[ActivityFeed] listener error:", err)
      }
    }
  }
}

export const BridgeActivityFeed = ActivityFeed

/**
 * A SIPA this wallet funded with its own burn (a paylink-paid registration) reads as one story:
 * the withdrawal row. The deposit record stays off the feed only while it needs nothing from the
 * user; a failed or recoverable deposit, a sweep that has stalled, or one whose funding burn
 * failed, surfaces so its error and recovery actions are reachable. The hidden record still drives
 * the claim in the background.
 */
export function hiddenBehindOwnWithdrawal(
  record: SIPADepositRecord,
  withdrawals: readonly WithdrawalRecord[],
  now: number,
): boolean {
  if (record.phase === "failed" || record.phase === "recoverable") return false
  if (isStuckSweep(record, now)) return false
  const sipa = record.sipaAddress.toLowerCase()
  // A migration's arrival is a row of its own: the move is two legs, and the arrival ends it.
  const funding = withdrawals.filter(
    (w) => w.recipient.toLowerCase() === sipa && w.intent !== "migration",
  )
  return funding.length > 0 && funding.some((w) => w.phase !== "failed")
}

export function itemStartTime(item: ActivityItem): number {
  return "record" in item ? item.record.startTime : item.batch.startTime
}

export function isBridgeActivityItem(item: ActivityItem): item is BridgeActivityItem {
  return item.kind === "bridge.sipaDeposit" || item.kind === "bridge.withdrawal"
}

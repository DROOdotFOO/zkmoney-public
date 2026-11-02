/**
 * PendingPaylinkMigrationService — the upgrade's deferred lane for paylinks it cannot move. A
 * creator paylink inside its claim window has no refund path (the contract asserts
 * chain time is past `until_claimable`), so the residual probe hands every still-escrowed historic
 * paylink to `recordPending` and `reconcile` re-derives each record from its row and chain time on
 * every boot. A `claimable` record gets one "reclaim" notice (fire-once by id, so a missed one is
 * recorded next boot);
 * the reclaim itself is the ordinary post-expiry refund, after which the returned balance is a
 * plain residual for the migration.
 */

import {
  isPaylinkTransaction,
  type PaylinkTransaction,
  type Transaction,
} from "../../../types/transactions"
import { logger } from "../../../utils/logger"
import { bestEffort } from "../../../engine/errors"
import { notElsewhere } from "../../../types/networkStamp"
import type { Notifications } from "../../../engine/notifications"
import type {
  PendingPaylinkMigrationStore,
  PendingPaylinkMigrationRecord,
} from "./PendingPaylinkMigrationStore"
import type { CheckSpent } from "./PaylinkClaimReconciler"
import { paylinkRefundEligibility } from "./refundParamsFromRow"

export function paylinkReclaimableNotificationId(txHash: string): string {
  return `paylink:reclaimable:${txHash.toLowerCase()}`
}

export interface PendingPaylinkMigrationServiceDeps {
  store: PendingPaylinkMigrationStore
  notifications: Pick<Notifications, "has" | "record" | "retract">
  /** Active account's `transactions[]` — the rows the records re-derive from. */
  accountTransactions: () => Promise<readonly Transaction[] | null>
  /**
   * On-chain nullifier read, consulted once before a reclaim notice: a claim that landed in the
   * window but has not reached the row yet must not be announced as reclaimable. Until it is
   * available no notice is recorded; records still advance.
   */
  checkSpent?: CheckSpent
  /**
   * False once the stores write under another account than the one this service is for. Its queued
   * and running work then stops before its next write; that account's next session redoes it.
   */
  ownsStorage?: () => boolean
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

/** Work in flight on each store. Every service over one store runs its changes one at a time. */
const storeWork = new WeakMap<PendingPaylinkMigrationStore, Promise<unknown>>()

function exclusive<T>(store: PendingPaylinkMigrationStore, work: () => Promise<T>): Promise<T> {
  const run = (storeWork.get(store) ?? Promise.resolve()).then(work, work)
  storeWork.set(
    store,
    run.catch(() => {}),
  )
  return run
}

/** Ends a job whose account no longer owns the stores. */
class AccountChanged extends Error {}

export class PendingPaylinkMigrationService {
  private readonly now: () => number

  constructor(private readonly deps: PendingPaylinkMigrationServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Still-escrowed rows the residual probe attributed to a retired deployment, whatever their window state. */
  recordPending(rows: PaylinkTransaction[], networkId: string): Promise<void> {
    return this.exclusive(() => this.record(rows, networkId), undefined)
  }

  private async record(rows: PaylinkTransaction[], networkId: string): Promise<void> {
    const { store } = this.deps
    await store.load()
    const nowMs = this.now()
    for (const row of rows) {
      if (!row.txHash || row.untilClaimable == null) continue
      // A live record is never pulled back by a stale probe. A resolved one is re-opened: a claim
      // demotion can put the escrow back in play.
      const existing = store.get(row.txHash)
      if (existing && existing.status !== "resolved") continue
      this.assertOwner()
      await store.set({
        txHash: row.txHash,
        untilClaimable: row.untilClaimable,
        tokenAddress: row.tokenAddress,
        networkId: networkId.toLowerCase(),
        flavor: row.flavor,
        status: "waiting",
        detectedAtMs: nowMs,
        updatedAtMs: nowMs,
      })
    }
  }

  /**
   * Drops the records and reclaim notices of the links funded by `txHashes`, whose portals froze. A
   * frozen migration refunds those escrows to L1, and an L2 reclaim after the freeze makes notes
   * outside the frozen snapshot.
   */
  retire(txHashes: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const { store, notifications } = this.deps
      await store.load()
      for (const txHash of txHashes) {
        this.assertOwner()
        await store.remove(txHash)
        this.assertOwner()
        await notifications.retract(paylinkReclaimableNotificationId(txHash))
      }
    }, undefined)
  }

  /**
   * Re-derive every unresolved record from its row and `nowSec` (chain-tip seconds, never the wall
   * clock — the contract gates on block time) on `networkId`. Returns the full list for the caller's UI.
   */
  reconcile(nowSec: number, networkId: string): Promise<PendingPaylinkMigrationRecord[]> {
    return this.exclusive(() => this.rederive(nowSec, networkId), [])
  }

  /** Runs `work` in the store's turn; work whose account changed ends with `dropped`. */
  private exclusive<T>(work: () => Promise<T>, dropped: T): Promise<T> {
    return exclusive(this.deps.store, async () => {
      try {
        this.assertOwner()
        return await work()
      } catch (err) {
        if (err instanceof AccountChanged) return dropped
        throw err
      }
    })
  }

  private assertOwner(): void {
    if (this.deps.ownsStorage?.() === false) throw new AccountChanged()
  }

  private async rederive(
    nowSec: number,
    networkId: string,
  ): Promise<PendingPaylinkMigrationRecord[]> {
    const { store } = this.deps
    await store.load()
    let transactions: readonly Transaction[] | null
    try {
      transactions = await this.deps.accountTransactions()
    } catch (err) {
      logger.warn("[PendingPaylinkMigrationService] account read failed:", err)
      return store.list()
    }
    if (!transactions) return store.list()
    const rowsByHash = new Map(
      transactions.filter(isPaylinkTransaction).map((row) => [row.txHash?.toLowerCase(), row]),
    )

    for (const record of store.list()) {
      if (record.status === "resolved") continue
      // Another network's escrow: this chain's clock and nullifier tree say nothing about it.
      if (!notElsewhere(record, networkId)) continue
      const row = rowsByHash.get(record.txHash.toLowerCase())
      const next = row ? this.derive(record, row, nowSec) : this.resolved(record, "unavailable")
      if (next.status !== record.status) {
        this.assertOwner()
        await store.set(next)
      }
      // Recorded from state, not from the transition, so a notice that was cut off is recorded later.
      if (next.status === "claimable" && row) await this.notify(next, row)
    }
    return store.list()
  }

  private async notify(
    record: PendingPaylinkMigrationRecord,
    row: PaylinkTransaction,
  ): Promise<void> {
    const { store, notifications, checkSpent } = this.deps
    const id = paylinkReclaimableNotificationId(row.txHash)
    if (await notifications.has(id)) return
    // No check, no notice: the entry is fire-once, so it must never precede the nullifier read.
    if (!checkSpent) return
    let spent: boolean | undefined
    try {
      spent = (await checkSpent([row])).get(row.txHash)
    } catch (err) {
      logger.warn("[PendingPaylinkMigrationService] spent check failed:", err)
    }
    // Unknown: no notice this run; the next reconcile asks again.
    if (spent === undefined) return
    // Every spend path consumes the same nullifier; with no local refund signal it was a claim.
    this.assertOwner()
    if (spent) {
      await store.set(this.resolved(record, "claimed"))
      return
    }
    // A notice that fails to save is recorded on the next reconcile; the other links still run.
    await bestEffort(
      "unknown",
      notifications.record({
        id,
        at: this.now(),
        kind: "reclaimable",
        data: { txHash: row.txHash },
      }),
    )
  }

  private derive(
    record: PendingPaylinkMigrationRecord,
    row: PaylinkTransaction,
    nowSec: number,
  ): PendingPaylinkMigrationRecord {
    const { eligible, reason } = paylinkRefundEligibility(row, nowSec)
    if (eligible) return { ...record, status: "claimable", updatedAtMs: this.now() }
    if (reason === "within-window") return record
    return this.resolved(record, reason ?? "unavailable")
  }

  private resolved(
    record: PendingPaylinkMigrationRecord,
    resolvedReason: NonNullable<PendingPaylinkMigrationRecord["resolvedReason"]>,
  ): PendingPaylinkMigrationRecord {
    return { ...record, status: "resolved", resolvedReason, updatedAtMs: this.now() }
  }
}

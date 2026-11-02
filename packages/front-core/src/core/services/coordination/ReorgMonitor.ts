// Receipt-driven reorg layer. One serialized pass rewrites every non-finalized txHash-bearing
// record on the active network from its receipt: demote on regression (with a grace-window alert
// debounce), quiet re-confirm on re-inclusion, terminal-fail on drop/revert, anchor + tier rewrite
// as the chain advances. The session's reorg task (engine/reorg.ts) runs the passes — the receipt is
// the source of truth, so reorgs need no separate detection channel.

import { QueueStatus, TokenActionEnum } from "@obsidion/sdk"
import {
  hasBlockMoved,
  INCLUDED_TIERS,
  isRevertedInclusion,
  type ReorgNodeLike,
  type ReorgTxReceiptLike,
} from "../chain/receiptTypes"
import { loadRecords, timeKey } from "../../../engine/persistentStore"
// type-only store imports: value imports here would close an import cycle through the
// services barrel (a store → services index → coordination → this file). `activity` reaches no
// services module.
import { PENDING, type Activity } from "../../../engine/activity"
import type { Withdrawals } from "../../../engine/withdrawals"
import type { WithdrawalRecord } from "../bridge/types"
import type { SIPADepositStore } from "../deposits/SIPADepositStore"
import type { Transaction } from "../../../types"
import { stampedOn } from "../../../types/networkStamp"
import { makeLimiter } from "../../../utils/makeLimiter"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"

// `reorgEpoch` identifies the reorg episode the outcome belongs to (notification identity).
// `incoming` marks a payment this wallet received, so the alert speaks to the recipient.
// `source: "withdrawal"` marks a withdrawal record's burn; its record reports the failure and the corrective says so.
export type ConfirmationOutcome = { txHash: string } & (
  | { type: "demoted" }
  | { type: "re-confirmed"; hadAlerted: boolean; reorgEpoch?: number; source?: "withdrawal" }
  | { type: "failed"; reorgEpoch?: number; incoming?: true; source?: "withdrawal" }
  | { type: "grace-expired"; reorgEpoch?: number; incoming?: true }
  | { type: "finalized" }
)

export type ConfirmationListener = (outcome: ConfirmationOutcome) => void

export type ReorgTransactionStore = Pick<
  Activity,
  "query" | "byHash" | "apply" | "demoteByTxHash" | "settleByHash"
>
export type ReorgWithdrawalStore = Pick<Withdrawals, "all" | "apply">
export type ReorgSipaStore = Pick<SIPADepositStore, "load" | "list" | "demote">

/** What a pass reads the chain through. */
export interface ReorgChain {
  node: ReorgNodeLike
  /** Only records stamped with it are checked: a node that never saw a hash reads it as dropped. */
  networkId: string
}

export interface ReorgMonitorDeps {
  /** Injected store surfaces; an omitted store's surface is skipped. */
  transactionStorage?: ReorgTransactionStore
  withdrawalStorage?: ReorgWithdrawalStore
  sipaDepositStore?: ReorgSipaStore
  concurrency?: number
  /** How long a demoted payment may stay un-re-included before the alert fires. */
  graceWindowMs?: number
  onOutcome?: ConfirmationListener
  /** Optional clock for tests; defaults to `Date.now`. */
  now?: () => number
}

export interface ReorgPassSummary {
  checked: number
  demoted: number
  failed: number
  reConfirmed: number
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_GRACE_WINDOW_MS = 90_000
/** How far back a pass reads settled rows; a pending row is read at any age. */
export const REORG_MARGIN_MS = 24 * 60 * 60 * 1000
/**
 * How long to wait before believing a "dropped" answer for a tx that is still being sent. Shorter
 * than the poll interval, so the very next poll is the one that decides: if the node still says
 * dropped then, the tx really was dropped. Far longer than the moment the check guards against,
 * which lasts only as long as one sendTx call.
 */
const DROPPED_SETTLE_MS = 10_000
/**
 * How long a withdrawal's burn must keep reading dropped before the record fails. Ten polls and
 * about four mainnet slots, so a replica trailing by blocks has caught up: failing late costs
 * nothing, failing a burn that landed reports funds lost. Measured from the record's
 * `burnDroppedAt`, so it spans page loads.
 */
const DROPPED_BURN_SETTLE_MS = 5 * 60_000

export class ReorgMonitor {
  private readonly deps: ReorgMonitorDeps
  private readonly graceWindowMs: number
  private readonly now: () => number

  /** txHash (lowercase) → alert debounce for a demoted payment. In-memory: a restart re-seeds a fresh window. */
  private readonly grace = new Map<string, { deadline: number; alerted: boolean }>()

  constructor(deps: ReorgMonitorDeps) {
    this.deps = deps
    this.graceWindowMs = deps.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS
    this.now = deps.now ?? Date.now
  }

  private emit(outcome: ConfirmationOutcome): void {
    try {
      this.deps.onOutcome?.(outcome)
    } catch (err) {
      console.warn("[ReorgMonitor] listener threw:", err)
    }
  }

  /** One pass; its caller runs one at a time. */
  async runPass({ node, networkId }: ReorgChain): Promise<ReorgPassSummary> {
    const summary: ReorgPassSummary = { checked: 0, demoted: 0, failed: 0, reConfirmed: 0 }
    const limit = makeLimiter(this.deps.concurrency ?? DEFAULT_CONCURRENCY)

    // Throw → null: transient RPC failure leaves the record unchanged, never classifies as dropped.
    const fetchReceipt = async (txHash: string): Promise<ReorgTxReceiptLike | null> => {
      summary.checked++
      try {
        return await node.getTxReceipt(txHash)
      } catch {
        return null
      }
    }

    const jobs: Promise<void>[] = []
    const push = (fn: () => Promise<void>) => {
      jobs.push(
        limit(fn).catch((err) => {
          console.warn("[ReorgMonitor] record reconcile failed:", err)
        }),
      )
    }

    // --- Activity rows: every txHash-bearing row across all kinds, including
    // failed rows for the re-inclusion corrective path. CANCELLED rows were aborted before
    // submit and carry no receipt to reconcile.
    const txStore = this.deps.transactionStorage
    if (txStore) {
      const [recent, pending] = await Promise.all([
        loadRecords(txStore.query("time", { after: timeKey(this.now() - REORG_MARGIN_MS) })),
        loadRecords(txStore.query("pending", PENDING)),
      ])
      const read = new Map([...recent, ...pending].map((row) => [row.id, row]))
      const rows = [...read.values()].filter(
        (tx) =>
          !!tx.txHash &&
          tx.tier !== TxStatus.FINALIZED &&
          tx.detailedStatus !== QueueStatus.CANCELLED &&
          stampedOn(tx, networkId),
      )
      for (const row of rows) {
        push(() => this.reconcileTxRow(txStore, row, fetchReceipt, summary))
      }
    }

    // A tx hash whose receipt regressing undoes the phase it advanced. `gone` covers dropped AND
    // included-but-reverted — either way the tx's effect is not on chain.
    const checkRegression = (txHash: string, undo: (gone: boolean) => Promise<void>) =>
      push(async () => {
        const receipt = await fetchReceipt(txHash)
        if (!receipt) return
        const gone = receipt.status === TxStatus.DROPPED || isRevertedInclusion(receipt)
        if (gone || receipt.status === TxStatus.PENDING) {
          await undo(gone)
        }
      })

    // Withdrawals: post-mine phases re-verify the burn receipt, and a dropped-burn failure stays
    // in the walk so its burn showing up revives it. Phase advancement stays owned by the
    // withdrawal tracker.
    const withdrawalStore = this.deps.withdrawalStorage
    if (withdrawalStore) {
      const rows = (await withdrawalStore.all()).filter(
        (r) =>
          !!r.l2TxHash &&
          r.phase !== "done" &&
          (r.phase !== "failed" || !!r.droppedBurn) &&
          r.phase !== "submitting" &&
          stampedOn(r, networkId),
      )
      for (const row of rows) {
        push(() => this.reconcileWithdrawal(withdrawalStore, row, fetchReceipt, summary))
      }
    }

    // SIPA deposits: only the L2-derived `claimed` phase is receipt-checkable.
    const sipaStore = this.deps.sipaDepositStore
    if (sipaStore) {
      await sipaStore.load()
      const rows = sipaStore
        .list()
        .filter((r) => r.phase === "claimed" && !!r.claimTxHash && stampedOn(r, networkId))
      for (const row of rows) {
        checkRegression(row.claimTxHash as string, async () => {
          await sipaStore.demote(row.sipaAddress, "pendingClaim")
          summary.demoted++
          this.emit({ type: "demoted", txHash: row.claimTxHash as string })
        })
      }
    }

    await Promise.all(jobs)
    return summary
  }

  private async reconcileTxRow(
    store: ReorgTransactionStore,
    row: Transaction,
    fetchReceipt: (txHash: string) => Promise<ReorgTxReceiptLike | null>,
    summary: ReorgPassSummary,
  ): Promise<void> {
    const txHash = row.txHash
    const key = txHash.toLowerCase()
    const epoch = row.reorgEpoch
    const incoming =
      "action" in row && row.action === TokenActionEnum.RECEIVE ? { incoming: true as const } : {}
    // Demoted by the reorg layer: pending with a bumped epoch. A restart loses the in-memory
    // debounce, so a demoted row found without one gets a fresh window.
    const demoted = row.status === "pending" && (epoch ?? 0) > 0
    if (demoted && !this.grace.has(key)) {
      this.grace.set(key, { deadline: this.now() + this.graceWindowMs, alerted: false })
    }

    const receipt = await fetchReceipt(txHash)
    if (!receipt) return
    const status = receipt.status

    const writeAnchor = async (tier: TxStatus) => {
      const changed =
        row.tier !== tier ||
        (receipt.blockNumber !== undefined && row.blockNumber !== receipt.blockNumber) ||
        (receipt.blockHash !== undefined && row.blockHash !== receipt.blockHash)
      if (!changed) return
      const current = await store.byHash(txHash)
      if (!current) return
      await store.apply(current.id, {
        type: "anchored",
        tier,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      })
    }

    if (status === TxStatus.DROPPED || isRevertedInclusion(receipt)) {
      if (row.status !== "failed") {
        if (status === TxStatus.DROPPED && row.status === "pending" && !demoted) {
          // A pending row gets its hash a moment before the node receives the tx, and the node
          // answers "dropped" for any hash it has not seen. So the first dropped answer for a
          // pending row may only mean the send has not landed yet. Record when we first saw it
          // and check again on a later pass; fail the row only if it still reads dropped then. If
          // the node includes the tx in the meantime, the included branch above clears the entry.
          const entry = this.grace.get(key)
          if (!entry) {
            this.grace.set(key, { deadline: this.now() + DROPPED_SETTLE_MS, alerted: false })
            return
          }
          if (this.now() < entry.deadline) return
        }
        if (demoted) {
          // Already inside a reorg episode: terminalize without opening a new one, so the
          // failure alert shares the episode's epoch and dedupes against a grace-expired alert.
          await store.settleByHash(txHash, QueueStatus.FAILED, this.now(), epoch)
          summary.failed++
          this.grace.delete(key)
          this.emit({ type: "failed", txHash, reorgEpoch: epoch, ...incoming })
        } else {
          const result = await store.demoteByTxHash(txHash, { terminal: "failed" })
          summary.failed++
          this.grace.delete(key)
          this.emit({ type: "failed", txHash, reorgEpoch: result.reorgEpoch, ...incoming })
        }
      }
      return
    }

    // The re-inclusion corrective needs a vouched success: an adapter without
    // executionResult can never flip a failed row back to SUCCESS.
    const canCorrectFailed = receipt.executionResult === TxExecutionResult.SUCCESS

    if (status === TxStatus.FINALIZED || INCLUDED_TIERS.has(status)) {
      if (row.status === "success") {
        if (status !== TxStatus.FINALIZED && hasBlockMoved(row, receipt)) {
          // moved blocks between checks: demote now, re-confirm at the new anchor next pass
          await store.demoteByTxHash(txHash)
          summary.demoted++
          this.grace.set(key, { deadline: this.now() + this.graceWindowMs, alerted: false })
          this.emit({ type: "demoted", txHash })
          return
        }
        await writeAnchor(status)
      } else {
        // demoted → re-included, failed → re-included (corrective), or confirmed while closed
        if (row.status === "failed" && !canCorrectFailed) return
        const hadAlerted = row.status === "failed" || (this.grace.get(key)?.alerted ?? false)
        await writeAnchor(status)
        await store.settleByHash(txHash, QueueStatus.SUCCESS, this.now(), epoch)
        summary.reConfirmed++
        this.grace.delete(key)
        this.emit({ type: "re-confirmed", txHash, hadAlerted, reorgEpoch: epoch })
      }
      if (status === TxStatus.FINALIZED) this.emit({ type: "finalized", txHash })
      return
    }

    if (status === TxStatus.PENDING) {
      // A confirmed row regressed to the mempool: demote and start the grace window.
      // Still-pending in-flight rows stay with their flow (its epoch-less settle must not be
      // fenced by a needless demote); failed rows wait for inclusion.
      if (row.status === "success") {
        await store.demoteByTxHash(txHash)
        summary.demoted++
        this.grace.set(key, { deadline: this.now() + this.graceWindowMs, alerted: false })
        this.emit({ type: "demoted", txHash })
        return
      }
      if (demoted) {
        const entry = this.grace.get(key)
        if (entry && !entry.alerted && this.now() >= entry.deadline) {
          entry.alerted = true
          this.emit({ type: "grace-expired", txHash, reorgEpoch: epoch, ...incoming })
        }
      }
      return
    }
    // unknown status value: hold
  }

  private async reconcileWithdrawal(
    store: ReorgWithdrawalStore,
    row: WithdrawalRecord,
    fetchReceipt: (txHash: string) => Promise<ReorgTxReceiptLike | null>,
    summary: ReorgPassSummary,
  ): Promise<void> {
    const txHash = row.l2TxHash as string
    const receipt = await fetchReceipt(txHash)
    if (!receipt) return
    const status = receipt.status

    if (row.phase === "failed") {
      // The vouching a payment's corrective needs: an included receipt that says SUCCESS.
      const included = status === TxStatus.FINALIZED || INCLUDED_TIERS.has(status)
      if (!included || receipt.executionResult !== TxExecutionResult.SUCCESS) return
      if (!(await store.apply(row.localId, { type: "revived" }))) return
      summary.reConfirmed++
      // The failure's epoch, so the corrective pairs with the alert it answers.
      this.emit({
        type: "re-confirmed",
        txHash,
        hadAlerted: true,
        reorgEpoch: row.reorgEpoch,
        source: "withdrawal",
      })
      return
    }

    if (status === TxStatus.DROPPED) {
      // The node answers "dropped" for any hash it has not seen, and a replica may not have seen
      // a burn mined moments ago. Fail only if a look past the settle window still reads dropped.
      if (row.burnDroppedAt === undefined) {
        await store.apply(row.localId, { type: "burnDropped", at: this.now() })
        return
      }
      if (this.now() - row.burnDroppedAt < DROPPED_BURN_SETTLE_MS) return
    }

    // The transition refuses a released record; only a record it changed is reported.
    if (status === TxStatus.DROPPED || isRevertedInclusion(receipt)) {
      const failed = await store.apply(row.localId, { type: "demoted", droppedBurn: true })
      if (!failed) return
      summary.failed++
      this.emit({ type: "failed", txHash, reorgEpoch: failed.reorgEpoch, source: "withdrawal" })
    } else if (status === TxStatus.PENDING) {
      if (!(await store.apply(row.localId, { type: "demoted" }))) return
      summary.demoted++
      this.emit({ type: "demoted", txHash })
    } else if (row.burnDroppedAt !== undefined) {
      await store.apply(row.localId, { type: "burnDropped", at: undefined })
    }
  }
}

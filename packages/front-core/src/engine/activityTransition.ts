import { PaylinkActionEnum, QueueStatus } from "@obsidion/core/constants"
import type { PaylinkTransaction, Transaction, TransactionStatus } from "../types/transactions"
import type { Failure } from "./errors"

type RefundKind = NonNullable<PaylinkTransaction["refundKind"]>

/**
 * What changes an activity row's status, its reorg anchors, or a created paylink's claim state. The
 * flow that started a row writes `sent`, `settled` and `failed`; the chain writes `confirmed`,
 * `demoted` and `anchored`; boot writes `interrupted`. `epoch` is the row's `reorgEpoch` when the
 * writer read it; absent, it is 0, where every row starts.
 */
export type ActivityEvent =
  | { type: "sent"; txHash: string }
  | { type: "settled"; at: number; txHash?: string; epoch?: number }
  | { type: "failed"; at: number; failure: Failure; epoch?: number }
  | { type: "interrupted" }
  | {
      type: "confirmed"
      at: number
      status: QueueStatus.SUCCESS | QueueStatus.FAILED
      epoch?: number
    }
  | { type: "demoted"; at: number; terminal?: "failed" }
  | { type: "anchored"; tier: Transaction["tier"]; blockNumber?: number; blockHash?: string }
  /**
   * A claim spent the link's escrow, seen at `at`. `by`: this account claimed it (`self`), so the
   * link goes, or the chain showed another's claim.
   */
  | { type: "claimed"; at: number; epoch?: number; refundInFlight: boolean; by: "self" | "chain" }
  /** A reorg unspent a claimed escrow. */
  | { type: "unclaimed"; epoch?: number }
  | { type: "refundSubmitted"; refundTxHash: string; refundKind: RefundKind }
  | { type: "refunded"; refundTxHash?: string; refundKind?: RefundKind }
  /** The submitted refund `refundTxHash` failed, so the link is refundable again. */
  | { type: "refundDropped"; refundTxHash: string }
  /** An upgrade returned the link's escrow on L1, which leaves its L2 note unspent. */
  | { type: "migrated" }

/**
 * The one place a row's status, anchors and claim state change; `undefined` leaves it as it is.
 * - A cancelled row never changes, nor does a migrated link's claim state.
 * - A `settled`, `failed`, `confirmed`, `claimed` or `unclaimed` from another epoch than the row's
 *   is ignored, so a write a reorg overtook never lands.
 * - A flow settles or fails a pending row only; the chain may correct a terminal one.
 * - A row takes one hash, while pending, and succeeds only with one.
 * - Claim state moves only on a created link's row: claimed and refunded exclude each other, and a
 *   link with a refund in flight or submitted is not claimed. A claim this account made overrides
 *   one the chain showed first.
 */
export function activityTransition(
  row: Transaction,
  event: ActivityEvent,
): Transaction | undefined {
  if (row.detailedStatus === QueueStatus.CANCELLED) return undefined
  const epoch = row.reorgEpoch ?? 0
  if (FENCED.has(event.type) && ((event as { epoch?: number }).epoch ?? 0) !== epoch) {
    return undefined
  }
  if (CLAIM_EVENTS.has(event.type)) return claimTransition(row, event)
  const pending = row.status === "pending"
  switch (event.type) {
    case "sent":
      if (!pending || row.txHash) return undefined
      return { ...row, txHash: event.txHash, detailedStatus: QueueStatus.MINING }
    case "settled": {
      const txHash = row.txHash || event.txHash
      if (!pending || !txHash) return undefined
      return { ...row, txHash, ...ended("success", event.at) }
    }
    case "failed":
      if (!pending) return undefined
      return { ...row, ...ended("failed", event.at), failure: event.failure }
    case "interrupted":
      if (!pending || row.txHash) return undefined
      return {
        ...row,
        status: "failed",
        detailedStatus: QueueStatus.FAILED,
        failure: { code: "tx.interrupted" },
      }
    case "confirmed":
      if (event.status === QueueStatus.SUCCESS && !row.txHash) return undefined
      return {
        ...row,
        ...ended(event.status === QueueStatus.SUCCESS ? "success" : "failed", event.at),
      }
    case "demoted":
      return event.terminal === "failed"
        ? { ...row, ...ended("failed", event.at), reorgEpoch: epoch + 1 }
        : {
            ...row,
            status: "pending",
            detailedStatus: QueueStatus.PENDING,
            endTime: undefined,
            reorgEpoch: epoch + 1,
          }
    case "anchored":
      return {
        ...row,
        tier: event.tier,
        blockNumber: event.blockNumber ?? row.blockNumber,
        blockHash: event.blockHash ?? row.blockHash,
      }
    default:
      return undefined
  }
}

const FENCED = new Set<ActivityEvent["type"]>([
  "settled",
  "failed",
  "confirmed",
  "claimed",
  "unclaimed",
])
const CLAIM_EVENTS = new Set<ActivityEvent["type"]>([
  "claimed",
  "unclaimed",
  "refundSubmitted",
  "refunded",
  "refundDropped",
  "migrated",
])

function claimTransition(row: Transaction, event: ActivityEvent): Transaction | undefined {
  const link = row as PaylinkTransaction
  if (link.emailPaymentAction !== PaylinkActionEnum.PAY || link.isMigrated) return undefined
  switch (event.type) {
    case "claimed": {
      if (link.isRefunded || link.refundTxHash || event.refundInFlight) return undefined
      const self = event.by === "self"
      if (link.isClaimed) {
        return self && link.claimedBy !== "self"
          ? { ...link, claimedBy: "self", paylink: undefined }
          : undefined
      }
      return {
        ...link,
        isClaimed: true,
        claimedAt: link.claimedAt ?? event.at,
        claimedBy: self ? "self" : link.claimedBy ?? event.by,
        ...(self ? { paylink: undefined } : {}),
      }
    }
    case "unclaimed":
      if (!link.isClaimed) return undefined
      return { ...link, isClaimed: false, reorgEpoch: (link.reorgEpoch ?? 0) + 1 }
    case "refundSubmitted":
      if (link.isRefunded) return undefined
      return { ...link, refundTxHash: event.refundTxHash, refundKind: event.refundKind }
    case "refunded":
      if (link.isRefunded) return undefined
      return {
        ...link,
        isRefunded: true,
        ...(link.isClaimed ? { isClaimed: false } : {}),
        paylink: undefined,
        refundTxHash: event.refundTxHash ?? link.refundTxHash,
        refundKind: event.refundKind ?? link.refundKind,
      }
    case "refundDropped":
      if (link.isRefunded || link.refundTxHash !== event.refundTxHash) return undefined
      return { ...link, refundTxHash: undefined, refundKind: undefined }
    case "migrated":
      if (link.isClaimed || link.isRefunded) return undefined
      return { ...link, isMigrated: true }
    default:
      return undefined
  }
}

/** The fields only `activityTransition` writes. */
const OWNED = [
  "status",
  "detailedStatus",
  "progress",
  "endTime",
  "failure",
  "txHash",
  "reorgEpoch",
  "tier",
  "blockNumber",
  "blockHash",
  "isClaimed",
  "claimedAt",
  "claimedBy",
  "isRefunded",
  "refundTxHash",
  "refundKind",
  "isMigrated",
]

/** `next` with `row`'s fields that only `activityTransition` writes. */
export function keepOwned(row: Transaction, next: Transaction): Transaction {
  const out: Record<string, unknown> = { ...next }
  const from = row as Record<string, unknown>
  for (const field of OWNED) {
    if (field in from) out[field] = from[field]
    else delete out[field]
  }
  return out as Transaction
}

function ended(status: TransactionStatus, at: number) {
  return {
    status,
    detailedStatus: status === "success" ? QueueStatus.SUCCESS : QueueStatus.FAILED,
    progress: 100,
    endTime: at,
  }
}

import {
  provingProgress,
  ProvingStage,
  type ProvingProgressEvent,
} from "@obsidion/proving-progress"
import { TxHash, TxStatus } from "@aztec-labs/stdlib/tx"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { Hex } from "viem"
import { isRevertedInclusion, type ReorgTxReceiptLike } from "../chain/receiptTypes"

/** Only node receipt evidence, never a computed hash or a transport error, determines failure. */
export function isFailedSubmission(
  receipt: Pick<ReorgTxReceiptLike, "status" | "executionResult">,
): boolean {
  return receipt.status === TxStatus.DROPPED || isRevertedInclusion(receipt)
}

/**
 * The transaction reached the node but its outcome is unknown. Flows throw this in place of the
 * transport error so callers report the row as pending and let the chain settle it; reporting a
 * failure here is what invites a second payment.
 */
export class TxInFlightError extends Error {
  constructor(readonly txHash: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "TxInFlightError"
  }
}

/**
 * A node refused the transaction because one it holds already spends the same notes, and it
 * refuses every retry until that one lands or expires.
 */
export class PendingTxConflictError extends Error {
  constructor(readonly txHash: Hex, message: string, cause: unknown) {
    super(message, { cause })
    this.name = "PendingTxConflictError"
  }
}

/** The pending transaction a node named when it refused one spending the same notes. */
export function conflictingPendingTx(err: unknown): Hex | undefined {
  for (let e: unknown = err; e !== undefined; e = e instanceof Error ? e.cause : undefined) {
    const hash = /Nullifier conflict with existing tx (0x[0-9a-fA-F]{64})/.exec(
      e instanceof Error ? e.message : String(e),
    )?.[1]
    if (hash) return hash.toLowerCase() as Hex
  }
  return undefined
}

export interface SubmissionTracker {
  /** The hash emitted at the submit boundary; undefined until then. */
  readonly txHash: Hex | undefined
  /**
   * The hash while the transaction may still land, else null: nothing was submitted, or a receipt
   * says dropped or reverted. Never rejects — an unreachable node keeps the hash, because
   * ambiguity resolves in favour of the transaction existing.
   */
  survived(node: Pick<AztecNode, "getTxReceipt">): Promise<Hex | null>
  /** Detach the listener. */
  stop(): void
}

/**
 * Watches one operation across the submit boundary. The wallet awaits the flow's `onTxHash`, which
 * saves the hash, then emits `ProvingStage.Mining` with it just before `aztecNode.sendTx`. A
 * rejection before Mining sent nothing; one after it says nothing about whether the transaction
 * reached the node, and only a receipt does. Mining is announced as `tx-hash-saved`: this is the
 * one place a flow's record becomes safe to reload over. An operation that owns several records
 * saves them all in one `onTxHash` and announces from one tracker; the others pass
 * `announce: false`.
 */
export function trackSubmission(
  operationId: string,
  opts: { announce?: boolean } = {},
): SubmissionTracker {
  let txHash: Hex | undefined

  const onMining = (event: ProvingProgressEvent) => {
    if (event.operationId !== operationId || event.stage !== ProvingStage.Mining || !event.txHash)
      return
    if (txHash) return
    txHash = event.txHash as Hex
    if (opts.announce !== false) provingProgress.emitTxHashSaved(operationId, txHash)
  }
  provingProgress.on("stage-start", onMining)

  return {
    get txHash() {
      return txHash
    },
    async survived(node) {
      if (!txHash) return null
      try {
        if (isFailedSubmission(await node.getTxReceipt(TxHash.fromString(txHash)))) return null
      } catch {
        // No receipt is not evidence of failure.
      }
      return txHash
    },
    stop() {
      provingProgress.off("stage-start", onMining)
    },
  }
}

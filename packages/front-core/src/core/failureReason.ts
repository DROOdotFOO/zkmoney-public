import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { Transaction } from "../types"

/** Why a pre-submit row failed when its tab closed, per action: the row's Reason and the bell both say it. */
export const INTERRUPTED_ERRORS = {
  send: "The tab closed before it was sent. The amount is still in your balance.",
  paylinkCreate: "The tab closed before the link was funded. The amount is still in your balance.",
  paylinkClaim: "The tab closed before your claim was sent. The link can still be claimed.",
  other: "The tab closed before it was sent.",
} as const

function interruptedErrorFor(tx: Transaction): string {
  if (tx.action === "send") return INTERRUPTED_ERRORS.send
  if (tx.action === PaylinkActionEnum.PAY) return INTERRUPTED_ERRORS.paylinkCreate
  if (tx.action === PaylinkActionEnum.CLAIM) return INTERRUPTED_ERRORS.paylinkClaim
  return INTERRUPTED_ERRORS.other
}

/** Why one of the user's own rows failed, when no plainer reason is known. */
const FAILED_ERRORS: Partial<Record<string, string>> = {
  send: "It didn't go through. The amount is still in your balance.",
  [PaylinkActionEnum.PAY]: "It didn't go through. The amount is still in your balance.",
  [PaylinkActionEnum.CLAIM]: "It didn't go through.",
}

/** The opening of the reason a transaction or a move a reorg took back shows. */
export const REORGED_ERROR = "Reverted by the network."

/** Why a row a reorg took back failed, by its action; `REORGED_ERROR` for any other. */
const REORGED_ERRORS: Partial<Record<string, string>> = {
  receive: `${REORGED_ERROR} It isn't in your balance.`,
  send: `${REORGED_ERROR} The amount is still in your balance.`,
  [PaylinkActionEnum.PAY]: `${REORGED_ERROR} The amount is still in your balance.`,
}

/**
 * A failed row's reason in its action's words: the tab-close text, the reorg that took back a
 * landed row, else a plain line for the user's own send, link or claim.
 */
export function failureReason(tx: Transaction): string | undefined {
  if (tx.status !== "failed") return
  if (tx.failure?.code === "tx.interrupted") return interruptedErrorFor(tx)
  // Only the reorg layer bumps the epoch; a block anchor means the row had landed before it failed.
  if ((tx.reorgEpoch ?? 0) > 0 && tx.blockNumber !== undefined) {
    return REORGED_ERRORS[tx.action] ?? REORGED_ERROR
  }
  return FAILED_ERRORS[tx.action]
}

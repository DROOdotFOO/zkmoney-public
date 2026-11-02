/**
 * Why an in-flight withdrawal is still waiting. Each post-mine phase waits on a different thing —
 * the Aztec tx, Ethereum accepting the withdrawal, a relayer's release, or the user's own release
 * tx — and only the first of those leaves the balance untouched, so the note says which one it is
 * and whether the amount is already gone. `finalizing_l1` splits on `finalizeTxHash`, and
 * `swapping` on `swapExecuteTxHash`: a transaction already in flight waits on itself, not on a
 * relayer.
 */
import {
  canSelfExecuteSwap,
  canSelfFinalizeWithdrawal,
  isWithdrawalDelayed,
  WITHDRAWAL_TERMINAL_PHASES,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { unswappableCopy } from "./unswappableCopy"
import { withdrawalFailureText } from "./withdrawalFailure"

const PROVING =
  "Your device is proving this withdrawal privately. The amount is still in your balance."

const SUBMITTING =
  "Waiting for the Aztec transaction to be mined. The amount is still in your balance until then."

const RELEASING =
  "The amount has been deducted from your balance. This withdrawal is being released to Ethereum, which can take up to 40 minutes. Once Ethereum accepts it, a relayer sends the funds to the recipient."

const AWAITING_RELAYER =
  "The amount has been deducted from your balance and Ethereum has accepted this withdrawal. Waiting for a relayer to send the transaction that pays the recipient."

const SEND_IT_YOURSELF = "It's taking longer than usual, so you can send that transaction yourself."

const AWAITING_OWN_FINALIZATION =
  "Your finalization transaction has been sent. Waiting for it to confirm and for the funds to reach the recipient."

const AWAITING_SWAP =
  "The DAI has been released to the swap escrow. Waiting for a relayer to run the swap that pays the recipient."

const RUN_IT_YOURSELF = "It's taking longer than usual, so you can run the swap yourself."

const AWAITING_OWN_SWAP =
  "Your swap transaction has been sent. Waiting for it to confirm and for the recipient to be paid."

/** Undefined where there is no wait left to explain: a released withdrawal, or one with no error to show. */
export function waitingNote(record: WithdrawalRecord): string | undefined {
  switch (record.phase) {
    case "submitting":
      return record.l2TxHash ? SUBMITTING : PROVING
    case "l2_mined":
    case "awaiting_proven":
      return withSwapLeg(RELEASING, record)
    case "finalizing_l1":
      if (record.finalizeTxHash) return withSwapLeg(AWAITING_OWN_FINALIZATION, record)
      return withSwapLeg(
        canSelfFinalizeWithdrawal(record)
          ? `${AWAITING_RELAYER} ${SEND_IT_YOURSELF}`
          : AWAITING_RELAYER,
        record,
      )
    case "swapping":
      if (record.swapExecuteTxHash) return AWAITING_OWN_SWAP
      return canSelfExecuteSwap(record) ? `${AWAITING_SWAP} ${RUN_IT_YOURSELF}` : AWAITING_SWAP
    case "recoverable":
      return unswappableCopy(record)
    case "failed":
      return withdrawalFailureText(record)
    case "done":
    case "recovered":
      return undefined
  }
}

const RELEASES_ON_ITS_OWN =
  "Ethereum releases the funds on its own, usually in about 15 minutes. Reopen this link to check on it."
const RELEASE_DELAYED = "This is taking longer than usual."
const RELEASE_IT_YOURSELF = `${RELEASE_DELAYED} No relayer has released it, so you can send the Ethereum transaction that does it yourself.`
const SWAP_IT_YOURSELF = `${RELEASE_DELAYED} No relayer has run the swap, so you can run it yourself.`

/**
 * A cash-out visitor's wait once the burn is sent, until it ends. The page has no activity list, so
 * this note is where a late release names the exit the page offers.
 */
export function releaseNote(
  record: WithdrawalRecord,
  now: number = Date.now(),
): string | undefined {
  if (record.phase === "recoverable") return unswappableCopy(record)
  if (!record.l2TxHash || WITHDRAWAL_TERMINAL_PHASES.has(record.phase)) return
  if (canSelfFinalizeWithdrawal(record, now)) return withSwapLeg(RELEASE_IT_YOURSELF, record)
  if (canSelfExecuteSwap(record, now)) return SWAP_IT_YOURSELF
  if (isWithdrawalDelayed(record, now)) return RELEASE_DELAYED
  return withSwapLeg(RELEASES_ON_ITS_OWN, record)
}

// The release pays a swap escrow, not the recipient — say so wherever a note promises the release.
function withSwapLeg(note: string, record: Pick<WithdrawalRecord, "swapOutput">): string {
  return record.swapOutput
    ? `${note} The released funds are swapped to ${record.swapOutput} before they reach the recipient.`
    : note
}

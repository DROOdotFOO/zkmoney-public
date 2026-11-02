/**
 * Which recovery a creator's own paylink row offers, in the activity list and its detail sheet, and
 * which links a backup passkey add waits for.
 *
 * Both recoveries spend the escrow's single nullifier, so at most one is ever on offer and neither
 * survives a claim: `cancel` is the in-window refund (`now <= refundableUntil`, a window that opens
 * at creation and may overlap the claim window; offered only while `canCancelAt` says a proof can
 * still land before it closes), `reclaim` is the post-expiry refund (`now > untilClaimable`). The
 * contract decides the branch itself; this only picks the copy. Between the refund window closing
 * and expiry only the recipient can move the funds.
 *
 * The window arithmetic and every material/lifecycle guard come from the shared
 * `isPaylinkInRefundWindow` / `paylinkRefundEligibility`.
 */
import { PAYLINK_CANCEL_MARGIN_SECONDS, PaylinkActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction } from "../../../types/transactions"
import type { PaylinkStatusKind } from "./paylinkStatus"
import { isPaylinkInRefundWindow, paylinkRefundEligibility } from "./refundParamsFromRow"

export type CreatorLinkAction = "reclaim" | "cancel"

/**
 * True while a creator's cancel can still land before `refundable_until`. The refund tx expires
 * there, and proof + inclusion must finish first, so the offer closes a margin early.
 */
export function canCancelAt(refundableUntil: number, chainNow: number): boolean {
  return chainNow + Number(PAYLINK_CANCEL_MARGIN_SECONDS) < refundableUntil
}

/** Statuses that still hold spendable escrow; anything else has already consumed the nullifier. */
export function paylinkStatusIsUnspent(status: PaylinkStatusKind): boolean {
  return status === "awaitingClaim" || status === "expired"
}

/**
 * A link made on another rollup than `network`, the active one. This build can't act on it there;
 * the upgrade refunds it.
 */
export function isOtherRollupLink(
  row: Pick<PaylinkTransaction, "networkId">,
  network: string | undefined,
): boolean {
  return !!network && !!row.networkId && row.networkId.toLowerCase() !== network.toLowerCase()
}

/**
 * Whether `account` made the link. A row without `obsidionAccountAddress` predates that field and
 * counts as the account's: this wallet's store holds only its own rows.
 */
export function linkMadeBy(row: PaylinkTransaction, account: string): boolean {
  const creator = row.obsidionAccountAddress
  return !creator || creator.toLowerCase() === account.toLowerCase()
}

/**
 * A link `account` made on `network` whose escrow it can still take back, now or after expiry. Only
 * the creator can, so once a backup passkey add moves the wallet off `account` such a link is
 * stranded. A create still in flight counts, since its escrow may land.
 */
export function isOpenCreatorLink(
  row: PaylinkTransaction,
  account: string,
  network: string | undefined,
): boolean {
  if (row.emailPaymentAction !== PaylinkActionEnum.PAY || !linkMadeBy(row, account)) return false
  if (row.flavor !== "email" && row.flavor !== "direct") return false
  if (isOtherRollupLink(row, network)) return false
  if (row.status === "pending") return true
  // A time past every expiry lifts the window checks, leaving only spent and missing material.
  return paylinkRefundEligibility(row, Number.POSITIVE_INFINITY).eligible
}

export function creatorLinkAction(
  row: PaylinkTransaction,
  opts: {
    /** Chain-tip seconds where readable — the contract checks block time at inclusion. */
    nowSec: number
    /** The modal's on-open status refresh, folded over the row's own flags. */
    liveStatus: PaylinkStatusKind
    /** The account this session acts as, or undefined before it is known. */
    account?: string
  },
): CreatorLinkAction | null {
  if (!paylinkStatusIsUnspent(opts.liveStatus)) return null
  // A known account that isn't the row's creator can't authorize the escrow's spend. An unknown one
  // can't contradict the row's own stamp, and these rows are this device's.
  if (opts.account && !linkMadeBy(row, opts.account)) return null
  if (row.flavor !== "email" && row.flavor !== "direct") return null
  if (!paylinkRefundEligibility(row, opts.nowSec).eligible) return null
  if (isPaylinkInRefundWindow(row, opts.nowSec)) {
    return canCancelAt(row.refundableUntil!, opts.nowSec) ? "cancel" : null
  }
  return "reclaim"
}

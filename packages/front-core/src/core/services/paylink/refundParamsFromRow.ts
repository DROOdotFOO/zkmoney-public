import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  PaylinkService,
  type CreatedPaylinkParams,
  type PaylinkParams,
  type PaylinkWindow,
} from "@obsidion/sdk"
import { isPaylinkTransaction, type PaylinkTransaction, type Transaction } from "../../../types"
import { isRefundInFlight } from "./refundInFlight"

/**
 * The link a creator-side refund reconstructs the escrow from, decoded from the row's persisted
 * `paylink`. Decoding the row's OWN encrypted-at-rest link is creator-side and distinct from
 * parsing an external share URL, which stays recipient-only.
 *
 * Returns `null` (never throws) when the row can't yield a refund input: missing/scrubbed
 * `paylink`, missing `fallbackSecret` (a row that never finished creating), or a malformed link. A
 * `null` result drives a disabled refund CTA.
 */
export async function refundParamsFromRow(row: PaylinkTransaction): Promise<PaylinkParams | null> {
  if (!row.paylink || !row.fallbackSecret) return null
  try {
    return await PaylinkService.parsePaylinkUrl(row.paylink)
  } catch {
    return null
  }
}

/**
 * The links the creator's `rows` record, with the fallback secret each escrow's refund signs with. A
 * row without that material or with a malformed link is skipped.
 */
export async function creatorLinksFromRows(
  rows: readonly Transaction[],
): Promise<CreatedPaylinkParams[]> {
  const links: CreatedPaylinkParams[] = []
  for (const row of rows) {
    if (!isPaylinkTransaction(row)) continue
    const params = await refundParamsFromRow(row)
    if (!params) continue
    try {
      links.push({ ...params, fallbackSecret: Fr.fromString(row.fallbackSecret!) })
    } catch {
      // A malformed fallback secret recovers nothing.
    }
  }
  return links
}

/**
 * The deposit window every create site passes, from one clock reading. Claims open after
 * `graceSec`; the creator can refund from creation until expiry, so an unclaimed link is always
 * recoverable. Past `untilClaimable` the contract's expired refund branch takes over.
 */
export function paylinkWindows(nowSec: bigint, expirySec: bigint, graceSec: bigint): PaylinkWindow {
  const untilClaimable = nowSec + expirySec
  return { fromClaimable: nowSec + graceSec, untilClaimable, refundableUntil: untilClaimable }
}

/**
 * True while the row's creator refund window (which opens at creation) is still open. Display
 * only: the contract decides the branch itself from chain time. Rows without a persisted window
 * are never in it. Pure and time-injected for deterministic use.
 */
export function isPaylinkInRefundWindow(row: PaylinkTransaction, nowSec: number): boolean {
  return row.refundableUntil != null && nowSec <= row.refundableUntil
}

export type PaylinkRefundIneligibleReason =
  | "within-window"
  | "claimed"
  | "refunded"
  | "migrated"
  | "unavailable"

export type PaylinkRefundEligibility = {
  eligible: boolean
  reason?: PaylinkRefundIneligibleReason
}

/**
 * Synchronous, cheap-field eligibility check for the creator-side refund CTA.
 * No link decode happens here — the async `refundParamsFromRow` decode runs only
 * when the user taps the CTA. Refund is eligible inside the refund window or
 * after the claim window expires, for an unclaimed, unrefunded PAY row that
 * still carries the refund material (`paylink` + `fallbackSecret` + expiry).
 * CLAIM_BACK/REFUNDED rows and rows missing material are never eligible;
 * `"within-window"` means the recipient can still claim and the creator cannot
 * refund.
 */
export function paylinkRefundEligibility(
  row: PaylinkTransaction,
  nowSec: number,
): PaylinkRefundEligibility {
  if (row.emailPaymentAction !== "Pay To Email") return { eligible: false, reason: "unavailable" }
  // A failed create never escrowed funds — there is nothing to refund.
  if (row.status === "failed") return { eligible: false, reason: "unavailable" }
  if (row.isRefunded) return { eligible: false, reason: "refunded" }
  if (row.isClaimed) return { eligible: false, reason: "claimed" }
  if (row.isMigrated) return { eligible: false, reason: "migrated" }
  if (!row.paylink || !row.fallbackSecret || row.untilClaimable == null) {
    return { eligible: false, reason: "unavailable" }
  }
  if (isPaylinkInRefundWindow(row, nowSec) || nowSec > row.untilClaimable) return { eligible: true }
  return { eligible: false, reason: "within-window" }
}

/**
 * Creator PAY rows whose escrow the v4->v5 migration should attempt: refund material intact AND
 * decodable, no local in-flight/migrated signal, and a create `txHash` (the spend-metadata anchor
 * and the row key). Local `isClaimed`/`isRefunded` flags are deliberately NOT trusted: a claim or
 * refund seen only in the pending chain is demoted at cutover (the portal freezes at the proven
 * checkpoint), so the exit runtime derives spentness from frozen chain state — a truly spent
 * escrow resolves to an empty unit there. The decode gate keeps a malformed-but-present link from
 * ever reaching the exit runtime — such rows are skipped with a log, never failed on. The
 * decoded params are discarded; only raw row strings cross the migration seam.
 */
export async function eligibleEscrowRows(rows: Transaction[]): Promise<PaylinkTransaction[]> {
  const out: PaylinkTransaction[] = []
  for (const tx of rows) {
    const row = tx as PaylinkTransaction
    if (row.emailPaymentAction !== "Pay To Email") continue
    if (row.isMigrated) continue
    if (!row.paylink || !row.fallbackSecret || !row.txHash) continue
    if (isRefundInFlight(row.payToEmailSecret ?? "")) continue
    if ((await refundParamsFromRow(row)) === null) {
      console.warn(`[MigrationEscrow] row ${row.txHash} skipped: paylink material does not decode`)
      continue
    }
    out.push(row)
  }
  return out
}

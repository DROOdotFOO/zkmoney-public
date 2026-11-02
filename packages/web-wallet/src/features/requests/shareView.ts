import type { PaymentRequest } from "@obsidion/front-core"
import { requestAmountLabel } from "../../ui/format"

const MS_PER_DAY = 86_400_000

/** Badge styles understood by the design-system StatusBadge. */
export type ShareStatusStyle = "awaitingClaim" | "paid" | "cancelled" | "failed"

export interface ShareStatus {
  label: string
  badgeStyle: ShareStatusStyle
  /** True while the link can still be paid — gates the share buttons and cancel. */
  active: boolean
}

/** What the Share modal's Status row says about a request link. */
export function requestShareStatus(request: PaymentRequest, now: number): ShareStatus {
  if (request.status === "fulfilled") return { label: "Paid", badgeStyle: "paid", active: false }
  if (request.status === "cancelled")
    return { label: "Cancelled", badgeStyle: "cancelled", active: false }
  if (request.status === "declined")
    return { label: "Declined", badgeStyle: "cancelled", active: false }
  if (request.expiresAt != null && now > request.expiresAt)
    return { label: "Expired", badgeStyle: "failed", active: false }
  // "Unpaid" is the word the activity row uses for the same link — one vocabulary for one object.
  return { label: "Unpaid", badgeStyle: "awaitingClaim", active: true }
}

/** "7 days" / "Expired", or null for a link with no expiry. Days round up, so a
 * freshly minted 7-day link reads "7 days" for its whole first day. */
export function linkExpiryLabel(expiresAt: number | undefined, now: number): string | null {
  if (expiresAt == null) return null
  const remaining = expiresAt - now
  if (remaining <= 0) return "Expired"
  const days = Math.ceil(remaining / MS_PER_DAY)
  return days === 1 ? "1 day" : `${days} days`
}

/** The message a shared request link travels with, so the chat shows a sentence and not a bare URL. */
export function requestShareText(amount: number): string {
  return amount > 0 ? `Requesting ${requestAmountLabel(amount)} on zk.money` : "Requesting a payment on zk.money"
}

import { parseAmount } from "../../ui/format"
/**
 * Pure logic for the contact payment-request flow (U12): outgoing-row construction, best-effort
 * XMTP announce, and the decline transition. Deps are injected so vitest covers it without a
 * client. Delivery never blocks or invalidates the local row — the store is authoritative.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { parseUnits } from "viem"
import type { RequestBroadcaster, Requests, StoredRequest } from "@obsidion/front-core"

/** Mint a pending outgoing contact-request row, or null when the amount doesn't parse positive. */
export function newOutgoingRequest(
  contactTag: string,
  amountText: string,
  decimals: number,
  note?: string,
): StoredRequest | null {
  const amount = parseAmount(amountText)
  if (!Number.isFinite(amount) || amount <= 0) return null
  let amountAtomic: string
  try {
    // parseUnits over the raw text keeps exact base units (no float round-trip, no 1e-7 notation).
    amountAtomic = parseUnits(amountText.trim(), decimals).toString()
  } catch {
    return null
  }
  return {
    // A field: the fulfilling send carries it in the on-chain `Transfer.meta`.
    id: Fr.random().toString(),
    contactTag,
    amount,
    asset: WALLET_TOKEN_SYMBOL,
    direction: "outgoing",
    status: "pending",
    createdAt: Date.now(),
    kind: "contact",
    amountAtomic,
    tokenDecimals: decimals,
    note: note?.trim() || undefined,
  }
}

export interface AnnounceDeps {
  broadcaster: Pick<RequestBroadcaster, "announce">
  /** Registry tag → published XMTP address; null when the tag has no binding. */
  resolveXmtpAddress(tag: string): Promise<string | null>
  requesterTag: string
  networkId: string
  token: { address: string; symbol?: string; decimals: number }
}

/** Best-effort announce of a persisted outgoing row: whether it reached the payer. Never throws. */
export async function announceOutgoingRequest(
  request: StoredRequest,
  deps: AnnounceDeps,
): Promise<boolean> {
  try {
    const xmtpAddress = await deps.resolveXmtpAddress(request.contactTag)
    if (!xmtpAddress) return false
    const status = await deps.broadcaster.announce({
      recipientXmtpAddress: xmtpAddress,
      requestId: request.id,
      requesterTag: deps.requesterTag,
      amountAtomic:
        request.amountAtomic ??
        BigInt(Math.round(request.amount * 10 ** deps.token.decimals)).toString(),
      token: deps.token,
      networkId: deps.networkId,
      note: request.note,
      expiresAt: request.expiresAt,
    })
    return status.status === "sent"
  } catch (err) {
    console.warn("[requestFlow] announce failed", err)
    return false
  }
}

export interface DeclineDeps {
  store: Pick<Requests, "get" | "decline">
  /** Null when no leader XMTP client exists — the local flip still applies. */
  broadcaster: Pick<RequestBroadcaster, "signalDeclined"> | null
  resolveXmtpAddress(tag: string): Promise<string | null>
  networkId: string
}

/**
 * Decline a pending incoming request, then signal the requester best-effort over XMTP. Returns
 * whether the local flip applied.
 */
export async function declineIncomingRequest(id: string, deps: DeclineDeps): Promise<boolean> {
  const target = await deps.store.get(id)
  const { applied } = await deps.store.decline(id)
  if (!applied) return false
  if (!deps.broadcaster || !target?.contactTag) return true
  try {
    const xmtpAddress = await deps.resolveXmtpAddress(target.contactTag)
    if (!xmtpAddress) return true
    await deps.broadcaster.signalDeclined({
      recipientXmtpAddress: xmtpAddress,
      requestId: id,
      networkId: target.networkId ?? deps.networkId,
    })
  } catch (err) {
    console.warn("[requestFlow] declined signal failed", err)
  }
  return true
}

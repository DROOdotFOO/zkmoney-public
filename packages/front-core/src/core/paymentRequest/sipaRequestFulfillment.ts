/**
 * Creator-side join: a claimed SIPA deposit whose address matches a minted
 * request-link row fulfills that request. Mint itself publishes the SIPA, so
 * SIPA event discovery (`broadcast`) is not payment — only `claimed` (balance-visible)
 * counts, same bar as L2 send verification.
 */
import { depositAmounts } from "../services/deposits/depositAmounts.js"
import type { SIPADepositRecord } from "../services/deposits/SIPADepositStore.js"
import type { StoredRequest } from "../../engine/requests.js"

type SipaFulfillmentRecord = Pick<
  SIPADepositRecord,
  "phase" | "sipaAddress" | "amount" | "netAmount" | "fee" | "claimTxHash" | "sweepTxHash"
>

type SipaFulfillmentRequest = Pick<StoredRequest, "direction" | "sipaAddress" | "amountAtomic">

/** True when this claimed deposit closes the request: same SIPA, net credits at least the asked amount. */
export function sipaDepositFulfillsRequest(
  record: SipaFulfillmentRecord,
  request: SipaFulfillmentRequest,
): boolean {
  if (record.phase !== "claimed") return false
  if (request.direction !== "outgoing") return false
  if (!request.sipaAddress) return false
  if (record.sipaAddress.toLowerCase() !== request.sipaAddress.toLowerCase()) return false
  const requested = BigInt(request.amountAtomic ?? "0")
  if (requested === 0n) return true
  return depositAmounts(record).netAtomic >= requested
}

/** Lowercased SIPA addresses stamped on stored requests — Activity hides matching deposits. */
export function requestLinkedSipaAddresses(
  requests: ReadonlyArray<Pick<StoredRequest, "sipaAddress">>,
): Set<string> {
  const out = new Set<string>()
  for (const request of requests) {
    if (request.sipaAddress) out.add(request.sipaAddress.toLowerCase())
  }
  return out
}

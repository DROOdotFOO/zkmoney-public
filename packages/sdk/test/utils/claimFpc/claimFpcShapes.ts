/**
 * A gas-table flavor key ("sponsor[authorize_intents,oxide_token.transfer,oxide_token.publish_da]")
 * IS a batch shape, so it also names the calls a production send declares gas for. Parsing it keeps
 * the suites' declared limits in step with the table they measure, with nothing to restate — and it
 * follows the fixture's policy, so a suite on a per-call policy declares that policy's inventory
 * while an open one declares the flat caps.
 */
import { PROOF_FIELD_COUNT, VKEY_FIELD_COUNT } from "@obsidion/core/constants"
import {
  claimFpcSponsoredFee,
  type SponsorableCall,
} from "../../../src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import type { ClaimFpcPolicy } from "../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"

/** The calls a flavor key carries, as `claimFpcCallGas` keys them. An email claim gets the
 * arg-count shape the inventory disambiguates the flavors by. */
export function flavorCalls(flavor: string): SponsorableCall[] {
  const shape = flavor.slice(flavor.indexOf("[") + 1, -1)
  return shape.split(",").map((leg) => {
    const fn = leg.includes(".") ? leg.slice(leg.indexOf(".") + 1) : leg
    return {
      name: fn,
      ...(leg === "paylink_email.claim" || leg === "paylink_email.claim_to_l1"
        ? { args: new Array<unknown>(VKEY_FIELD_COUNT + PROOF_FIELD_COUNT) }
        : {}),
    }
  })
}

/** The `fee` a wallet would send this shape with under `policy`. */
export function sponsoredFeeFor(policy: ClaimFpcPolicy, flavor: string) {
  return claimFpcSponsoredFee(policy, flavorCalls(flavor))
}

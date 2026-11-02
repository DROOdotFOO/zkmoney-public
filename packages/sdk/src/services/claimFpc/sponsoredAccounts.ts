import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ClaimSponsorContext } from "./claimSponsor.js"

/**
 * How a sponsored batch names its accounts: the FPC's `user` is the payer, whose subscription note
 * it spends; the acting account owns the batch's intents and signs. Both are read, so a payer other
 * than the acting account is a scope beside it. The FPC never ties `user` to an account call, so
 * the payer signs nothing.
 */
export function sponsoredAccounts(
  sponsor: ClaimSponsorContext,
  acting: AztecAddress,
): {
  args: { user: AztecAddress; intentsAccount?: AztecAddress }
  scopes: AztecAddress[]
} {
  const payer = sponsor.payer ?? acting
  if (payer.equals(acting)) return { args: { user: acting }, scopes: [acting] }
  return { args: { user: payer, intentsAccount: acting }, scopes: [payer, acting] }
}

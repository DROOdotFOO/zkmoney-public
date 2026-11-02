// A counterfactual oxide token needs its address-bound immutables in every PXE that calls it.
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { OxideTokenImmutables } from "@oxide/oxide-lib/token_immutables.js"

/** The immutables of the oxide token at `token`. Throws for a token the source does not know. */
export type OxideTokenImmutablesSource = (token: AztecAddress) => Promise<OxideTokenImmutables>

export { readOxideTokenImmutables } from "@oxide/oxide-client/token_registration.js"
export type { OxideTokenImmutables }
export type { PortalDomain } from "@oxide/oxide-lib/types.js"

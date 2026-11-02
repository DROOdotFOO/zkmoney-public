/**
 * SIPA name resolution — the sender-side CCIP-read (EIP-3668) resolve of
 * `<label>.<ensDomain>` to the recipient's counterfactual SIPA deposit
 * address. The Resolver module's `resolve` reverts with `OffchainLookup`; viem's
 * `ccipRead` performs the gateway HTTP leg and completes the round-trip
 * through `resolveWithProof` — all inside one `readContract`, so no proof
 * plumbing lives here. The proof only attests name→address integrity and is
 * verified in-place by the Resolver; the money path (funding the returned
 * address) is a plain ERC-20 transfer.
 *
 * Lives in sdk because these are contract reads; front-core never originates
 * a contract call.
 */

import { BaseError, HttpRequestError, type Address, type PublicClient } from "viem"
import { resolveName } from "@oxide/l1-contracts"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * The resolver gateway refused the name (409): no sweep can deposit its SIPA, e.g. because its
 * account is still on a retired rollup.
 */
export class SipaNameUndepositableError extends Error {
  constructor(name: string, options?: ErrorOptions) {
    super(`"${name}" cannot receive deposits`, options)
    this.name = "SipaNameUndepositableError"
  }
}

const isUndepositableRefusal = (err: unknown) =>
  err instanceof BaseError && !!err.walk((e) => e instanceof HttpRequestError && e.status === 409)

/**
 * CCIP-resolve `name` (e.g. `alice.oxidestaging.eth`) to a SIPA deposit address.
 * Throws on a zero-address result — funding the zero address is
 * unrecoverable, so an unresolvable name must never reach the send path.
 * Throws {@link SipaNameUndepositableError} when the gateway refuses the name.
 * The resolved address is single-use and short-lived (the resolver's
 * retention window); resolve fresh per deposit, never cache.
 */
export async function resolveSipaAddress(
  publicClient: PublicClient,
  sipaResolver: Address,
  name: string,
): Promise<Address> {
  const address = await resolveName(publicClient, sipaResolver, name).catch((err: unknown) => {
    throw isUndepositableRefusal(err) ? new SipaNameUndepositableError(name, { cause: err }) : err
  })
  if (address.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`SIPA resolve returned the zero address for "${name}"`)
  }
  return address
}

/**
 * The SIPAFactory's on-chain CREATE2 predictor, re-exported so front-core
 * parity tests consume the contract read through
 * sdk instead of originating it themselves.
 */
export { predictSIPA } from "@oxide/l1-contracts"

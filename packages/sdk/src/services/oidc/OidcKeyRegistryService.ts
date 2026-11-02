import { DEFAULT_CONTRACTS, type OidcKeyRegistryContract } from "@obsidion/contracts"
import { ServiceContractBase } from "../ServiceBase.js"
import { assert } from "ts-essentials"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { Account } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"

/**
 * OidcKeyRegistry: on-chain attestation of the currently-trusted Apple/Google JWKS used to claim
 * email payment links. Exposes the JWKS + aud allowlist checks needed to
 * pre-validate cached zkJWT proofs before reuse.
 */
export class OidcKeyRegistryService extends ServiceContractBase {
  constructor(wallet: ObsidionWallet, oidcKeyRegistryAddress?: AztecAddress) {
    super(DEFAULT_CONTRACTS.oidcKeyRegistry, wallet, oidcKeyRegistryAddress)
  }

  public async getOidcKeyRegistryContract(): Promise<OidcKeyRegistryContract> {
    return (await this.getContract()) as OidcKeyRegistryContract
  }

  /**
   * Check whether a JWK (Poseidon2 hash of the RSA public key) is trusted for the given issuer at
   * the registry's CURRENT generation. Cached zkJWT proofs should be validated against this before
   * reuse to avoid on-chain reverts from `PaylinkEmail.claim`'s `assert_valid`. The issuer
   * (`issHash`) is required because trusted keys are issuer-scoped.
   */
  public async isValidJwk(
    jwkId: string | bigint,
    account: Account,
    issHash?: string | bigint,
  ): Promise<boolean> {
    assert(issHash !== undefined, "Issuer hash is required for OIDC JWK validation")
    const registry = await this.getOidcKeyRegistryContract()
    const simResult = await registry.methods
      .is_valid_jwk(Fr.fromString(issHash.toString()), Fr.fromString(jwkId.toString()))
      .simulate({ from: account.getAddress() })
    return simResult.result
  }

  /**
   * Check whether an `aud` hash (Poseidon2 hash of the OAuth client id) is on the allowlist.
   * Counterpart of `isValidJwk` — both must pass before a cached zkJWT proof may be reused.
   */
  public async isAudAllowed(audHash: string | bigint, account: Account): Promise<boolean> {
    const registry = await this.getOidcKeyRegistryContract()
    const simResult = await registry.methods
      .is_aud_allowed(Fr.fromString(audHash.toString()))
      .simulate({ from: account.getAddress() })
    return simResult.result
  }
}

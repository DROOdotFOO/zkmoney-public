// Server-side admin operations for the OidcKeyRegistry contract.
// Only the backend should instantiate this — handles deployment, JWK/AUD management.

import type { Account } from "@aztec-labs/aztec.js/account"
import { BatchCall, type SendInteractionOptions } from "@aztec-labs/aztec.js/contracts"
import type { ContractService, OidcKeyRegistryContract } from "@obsidion/contracts"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { PublicKeyRegistry, SUPPORTED_OIDC_ISSUERS } from "../../email/PublicKeyRegistry.js"
import { processAud, processIssuer } from "../../email/utils.js"
import type { ObsidionWalletBackend } from "../../obsidion/ObsidionWalletBackend.js"
import { ServiceContractBase } from "../ServiceBase.js"

const MAX_KEYS_PER_ISSUER = 10

export class OidcKeyRegistryServer extends ServiceContractBase {
  public networkId: string

  constructor(
    wallet: ObsidionWalletBackend,
    admin: Account,
    networkId: string,
    contractService?: ContractService,
  ) {
    super(DEFAULT_CONTRACTS.oidcKeyRegistry, wallet, undefined, admin, contractService)
    this.networkId = networkId
  }

  public async getOidcKeyRegistry(): Promise<OidcKeyRegistryContract> {
    return (await this.getContract()) as OidcKeyRegistryContract
  }

  private issuerToHash(issuerOrHash: string | bigint): bigint {
    if (typeof issuerOrHash === "bigint") return issuerOrHash
    if (issuerOrHash.startsWith("0x")) return BigInt(issuerOrHash)
    return BigInt(processIssuer(issuerOrHash))
  }

  private padJwkIds(jwkIds: bigint[]): bigint[] {
    if (jwkIds.length > MAX_KEYS_PER_ISSUER) {
      throw new Error(`Too many JWKs for issuer: ${jwkIds.length} > ${MAX_KEYS_PER_ISSUER}`)
    }
    return [...jwkIds, ...Array(MAX_KEYS_PER_ISSUER - jwkIds.length).fill(0n)]
  }

  public async simulatePublicIsValidJwk(
    jwkId: bigint,
    issuerOrHash: string | bigint,
  ): Promise<boolean> {
    const registry = await this.getOidcKeyRegistry()
    const hIss = this.issuerToHash(issuerOrHash)
    const { result } = await registry.methods
      .is_valid_jwk(hIss, jwkId)
      .simulate({ from: this.getDeployer() })
    return result
  }

  public async setIssuerJwks(
    issuerOrHash: string | bigint,
    jwkIds: bigint[],
    options?: SendInteractionOptions,
  ) {
    try {
      const registry = await this.getOidcKeyRegistry()
      const sendOptions = await this.getSendOptions(this.getDeployer(), { sendOptions: options })
      const hIss = this.issuerToHash(issuerOrHash)
      const paddedJwkIds = this.padJwkIds(jwkIds)

      await registry.methods.set_issuer_jwks(hIss, paddedJwkIds, jwkIds.length).send(sendOptions)

      console.log(`Issuer JWK set updated`, {
        hIss: `0x${hIss.toString(16)}`,
        count: jwkIds.length,
      })
    } catch (error) {
      // Rethrow: the caller must see a failed write and abort the run — especially once fees
      // are paid via the PasswordFPC.
      console.error("Error updating issuer JWK set:", error)
      throw error
    }
  }

  public async syncProviderJwksToContract(options?: SendInteractionOptions) {
    const pkr = new PublicKeyRegistry()
    for (const issuer of SUPPORTED_OIDC_ISSUERS) {
      const keys = await pkr.getPublicKeysByIssuer(issuer)
      await this.setIssuerJwks(
        issuer,
        keys.filter((key) => key.jwk_id != null).map((key) => BigInt(key.jwk_id!)),
        options,
      )
    }
  }

  /** @deprecated OIDC JWK rotation replaces an issuer set; prefer setIssuerJwks. */
  public async addJWK(jwkId: bigint, issuer: string, options?: SendInteractionOptions) {
    await this.setIssuerJwks(issuer, [jwkId], options)
  }

  /** @deprecated OIDC JWK rotation invalidates/replaces an issuer set, not a single key. */
  public async removeJWK(
    _jwkId: bigint,
    issuer: string,
    options?: SendInteractionOptions,
  ): Promise<void> {
    await this.setIssuerJwks(issuer, [], options)
  }

  // Throws on failure — a swallowed error here reports an aud as registered when it is not,
  // and every claim carrying it then reverts on-chain.
  public async addAudToContract(aud: string, options?: SendInteractionOptions) {
    console.log("addAudToContract...")
    const audHash = processAud(aud)
    const registry = await this.getOidcKeyRegistry()

    const { result: isAudInContract } = await registry.methods
      .is_aud_allowed(BigInt(audHash))
      .simulate({ from: this.getDeployer() })
    if (isAudInContract) {
      console.log("Aud already in contract")
      return
    }

    const sendOptions = await this.getSendOptions(this.getDeployer(), { sendOptions: options })
    // send() waits for mining; the wait override covers testnet inclusion times.
    await registry.methods.add_aud(BigInt(audHash)).send({ ...sendOptions, wait: { timeout: 180 } })

    const { result: nowAllowed } = await registry.methods
      .is_aud_allowed(BigInt(audHash))
      .simulate({ from: this.getDeployer() })
    if (!nowAllowed) {
      throw new Error(`add_aud mined but ${aud} still reads as not allowed`)
    }
    console.log("Aud added to contract")
  }

  // Throws on failure, same contract as addAudToContract.
  public async removeAudFromContract(aud: string, options?: SendInteractionOptions) {
    const registry = await this.getOidcKeyRegistry()
    const audHash = processAud(aud)

    const sendOptions = await this.getSendOptions(this.getDeployer(), { sendOptions: options })
    await registry.methods
      .remove_aud(BigInt(audHash))
      .send({ ...sendOptions, wait: { timeout: 180 } })
    console.log("Aud removed from contract")
  }

  async deployOidcKeyRegistry(options?: SendInteractionOptions): Promise<OidcKeyRegistryContract> {
    const sendOptions = await this.getSendOptions(this.getDeployer(), { sendOptions: options })
    const contract = (await this.deployContract(
      [this.getDeployer(), this.getDeployer()],
      sendOptions,
    )) as OidcKeyRegistryContract
    return contract
  }

  async deployOidcKeyRegistryAndInitialize(aud: string, options?: SendInteractionOptions) {
    console.log("Deploying and initializing OidcKeyRegistry contract...")
    const registry = await this.deployOidcKeyRegistry(options)

    console.log("Adding audience to contract...")
    await this.addAudToContract(aud, options)

    return registry
  }

  public async batchAddAudsAndJWKs(
    auds: string[],
    jwkIds: bigint[],
    options?: SendInteractionOptions,
  ) {
    const issuerJwks = Object.fromEntries(SUPPORTED_OIDC_ISSUERS.map((issuer) => [issuer, jwkIds]))
    await this.batchAddAudsAndIssuerJwks(auds, issuerJwks, options)
  }

  public async batchAddAudsAndIssuerJwks(
    auds: string[],
    issuerJwks: Record<string, bigint[]>,
    options?: SendInteractionOptions,
  ) {
    const registry = await this.getOidcKeyRegistry()
    const sendOptions = await this.getSendOptions(this.getDeployer(), { sendOptions: options })
    const issuerEntries = Object.entries(issuerJwks)
    const totalJwks = issuerEntries.reduce((sum, [, ids]) => sum + ids.length, 0)

    const calls = [
      ...auds.map((aud) => registry.methods.add_aud(BigInt(processAud(aud)))),
      ...issuerEntries.map(([issuer, jwkIds]) =>
        registry.methods.set_issuer_jwks(
          this.issuerToHash(issuer),
          this.padJwkIds(jwkIds),
          jwkIds.length,
        ),
      ),
    ]

    if (auds.length === 0 && totalJwks === 0) {
      console.log("No AUDs or JWKs to add")
      return
    }

    // Aztec account entrypoint allows max 5 function calls per tx (including fee payment).
    // So we can fit at most 4 calls per batch.
    const MAX_CALLS_PER_BATCH = 4
    console.log(
      `Batch adding ${auds.length} AUDs and ${totalJwks} JWKs across ${issuerEntries.length} issuers...`,
    )

    for (let i = 0; i < calls.length; i += MAX_CALLS_PER_BATCH) {
      const chunk = calls.slice(i, i + MAX_CALLS_PER_BATCH)
      console.log(
        `  Sending batch ${Math.floor(i / MAX_CALLS_PER_BATCH) + 1} (${chunk.length} calls)...`,
      )
      await new BatchCall(this.wallet, chunk).send(sendOptions)
    }

    console.log("Batch add complete")
  }
}

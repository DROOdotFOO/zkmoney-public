import type { Account } from "@aztec-labs/aztec.js/account"
import type { ChainInfo } from "@aztec-labs/entrypoints/interfaces"
import type { GasSettings } from "@aztec-labs/stdlib/gas"
import {
  ObsidionAccountEntrypoint,
  type AlphaEntrypointOptions,
} from "./ObsidionAccountEntrypoint.js"
import { type Fq, Fr } from "@aztec-labs/aztec.js/fields"
import { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import type {
  CompleteAddress,
  NodeInfo,
  ContractInstanceWithAddress,
} from "@aztec-labs/stdlib/contract"
import type { TxExecutionRequest } from "@aztec-labs/stdlib/tx"
import type { AlphaAuthProvider } from "../auth/AlphaAuthProvider.js"
import type { ObsidionAccountContractManager } from "./ObsidionAccountContractManager.js"
import type { AlphaPasskeySet } from "./alphaPasskeySet.js"
import {
  type CallIntent,
  computeAuthWitMessageHash,
  type IntentInnerHash,
} from "@aztec-labs/aztec.js/authorization"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { MAX_WITNESS_LEN } from "../../../utils/constants.js"

/**
 * Alpha account implementation.
 * Non-modular: no module dispatch, no recovery, no delegation.
 * Signature verification is inline in the contract, against the passkey set committed into the
 * address: any member of the set signs. The wallet keeps one instance per address and installs the
 * provider of its newest request as the signer (`setAuthProvider`).
 */
export class ObsidionAccount implements Account {
  private entrypoint: ObsidionAccountEntrypoint
  private currentAuthProvider: AlphaAuthProvider
  private chainId: Fr
  private version: Fr

  constructor(
    private completeAddress: CompleteAddress,
    private manager: ObsidionAccountContractManager,
    authProvider: AlphaAuthProvider,
    nodeInfo: Pick<NodeInfo, "l1ChainId" | "rollupVersion">,
  ) {
    this.chainId = new Fr(nodeInfo.l1ChainId)
    this.version = new Fr(nodeInfo.rollupVersion)
    this.currentAuthProvider = authProvider

    this.entrypoint = new ObsidionAccountEntrypoint(
      completeAddress.address,
      this.currentAuthProvider,
    )
  }

  getChainId(): Fr {
    return this.chainId
  }

  getVersion(): Fr {
    return this.version
  }

  async getEncryptionSecret(): Promise<Fq> {
    return await this.manager.getEncryptionSecret()
  }

  /** Raw master tagging public key point (v5 PublicKeys only exposes its hash). */
  async getTaggingPublicKey() {
    return await this.manager.getMasterTaggingPublicKey()
  }

  public getCompleteAddress() {
    return this.completeAddress
  }

  public getAddress() {
    return this.completeAddress.address
  }

  wrapExecutionPayload(
    exec: ExecutionPayload,
    chainInfo: ChainInfo,
    options?: any,
  ): Promise<ExecutionPayload> {
    return this.entrypoint.wrapExecutionPayload(exec, chainInfo, options)
  }

  public async createTxExecutionRequest(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options: AlphaEntrypointOptions,
  ): Promise<TxExecutionRequest> {
    await this.manager.ensureContractRegistered()
    return this.entrypoint.createTxExecutionRequest(exec, gasSettings, chainInfo, options)
  }

  /**
   * Build a per-intent AuthWitness for the alpha account.
   *
   * The alpha account contract (`packages/contracts/contracts/alpha/alpha_account/src/main.nr`)
   * authorizes intents via membership in `storage.intents_hashes`, populated by
   * `entrypoint_with_intent.execute_calls` from the `intent_hashes` argument that is
   * itself bound by the user's combined-payload signature in
   * `ObsidionAccountEntrypoint.createTxExecutionRequest`. The
   * per-intent witness bytes are never read on-chain — `verify_private_authwit`
   * only consults the stored intent-hash note. See the doc comment above
   * `verify_private_authwit` in the Noir source for the contract-side invariant.
   *
   * Behavior:
   *   - `CallIntent | IntentInnerHash`: derive the message hash and return a
   *     witness-less `AuthWitness` (`MAX_WITNESS_LEN × Fr.ZERO`). The single real
   *     signature per tx is the combined-payload sign emitted by the entrypoint.
   *   - Raw `Fr | Buffer`: throw. The alpha account auth model is intent-hash
   *     storage, not arbitrary message signing. A caller passing a pre-computed
   *     hash here is almost certainly expecting a real signature (custom auth,
   *     off-chain attestation) — returning a zero witness would be a footgun.
   *     If such a use case ever lands, route it through a new dedicated API.
   *
   * Do NOT re-introduce a signing call here. The entrypoint's one signature, over the
   * payload hash bound to this account, chain and version, is the real per-tx signature.
   */
  async createAuthWit(
    messageHashOrIntent: Fr | Buffer | CallIntent | IntentInnerHash,
  ): Promise<AuthWitness> {
    if (Buffer.isBuffer(messageHashOrIntent) || messageHashOrIntent instanceof Fr) {
      throw new Error(
        "ObsidionAccount.createAuthWit: raw-hash input not supported. The alpha account's auth model authorizes intents via stored intent hashes, not signed witness bytes. Pass a CallIntent or IntentInnerHash, or sign the hash through a different surface.",
      )
    }

    const messageHash = await this.getMessageHash(messageHashOrIntent)
    return new AuthWitness(messageHash, new Array(MAX_WITNESS_LEN).fill(Fr.ZERO))
  }

  private getMessageHash(intent: IntentInnerHash | CallIntent): Promise<Fr> {
    const chainId = this.getChainId()
    const version = this.getVersion()
    return computeAuthWitMessageHash(intent, { chainId, version })
  }

  public getAuthProvider(): AlphaAuthProvider {
    return this.currentAuthProvider
  }

  /** The passkey set committed into this account's address. */
  public async getPasskeySet(): Promise<AlphaPasskeySet> {
    return this.manager.getPasskeySet()
  }

  /** Registers the account in the PXE once; a failed attempt is retried by the next call. */
  public register(): Promise<void> {
    return this.manager.register()
  }

  public async getContractInstance(): Promise<ContractInstanceWithAddress> {
    return this.manager.getContractInstance()
  }

  public makeSpendMetadataResolver() {
    return this.manager.makeSpendMetadataResolver()
  }

  public makeDepositSpendMetadataResolver() {
    return this.manager.makeDepositSpendMetadataResolver()
  }

  public setAuthProvider(authProvider: AlphaAuthProvider): void {
    this.currentAuthProvider = authProvider
    this.entrypoint.setAuthProvider(authProvider)
  }
}

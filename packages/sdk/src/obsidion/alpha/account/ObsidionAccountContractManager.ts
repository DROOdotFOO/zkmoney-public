import {
  CompleteAddress,
  type ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import {
  computeAddressSecret,
  deriveKeys,
  deriveMasterIncomingViewingSecretKey,
} from "@aztec-labs/stdlib/keys"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { ContractService, type ContractName } from "@obsidion/contracts"
import type { PXE } from "@aztec-labs/pxe/client/lazy"
import type {
  DepositSpendMetadata,
  DepositSpendMetadataResolver,
  SpendMetadata,
  SpendMetadataResolver,
} from "@oxide/oxide-client/token_operations_collector.js"
import { deriveAccountSecretKey } from "./accountSecretKey.js"
import type { AlphaPasskeySet } from "./alphaPasskeySet.js"

export const DEFAULT_ACCOUNT_SALT = new Fr(1n)

export interface AlphaContractManagerOptions {
  artifact: ContractArtifact
  contractName: ContractName
  /** The PXE of the wallet that runs the account; registration writes here. */
  pxe: PXE
}

/**
 * Contract manager for ObsidionAccountAlpha.
 * Accepts an injected ContractArtifact and contractName, enabling the same
 * class to serve both production (WebAuthn) and test (K256) variants.
 * Uses ContractService to register into the wallet's PXE.
 *
 * The address is a function of the master secret key and the passkey set, through the account secret
 * key derived from the master secret: the set's hash is the instance's `immutables_hash`, so an
 * account is bound to one set of keys for its whole life.
 */
export class ObsidionAccountContractManager {
  private contractService: ContractService = ContractService.getInstance()
  private contractRegistration: Promise<void> | null = null
  private instance: ContractInstanceWithAddress | null = null
  private completeAddress: CompleteAddress | null = null
  private readonly secretKey: Fr
  private readonly passkeySet: AlphaPasskeySet
  private readonly artifact: ContractArtifact
  private readonly contractName: ContractName
  private readonly pxe: PXE

  public static async create(
    masterSecretKey: Fr,
    passkeySet: AlphaPasskeySet,
    options: AlphaContractManagerOptions,
  ) {
    const manager = new ObsidionAccountContractManager(masterSecretKey, passkeySet, options)
    await manager.getContractInstance()
    return manager
  }

  /**
   * Restore from a stored complete address. The complete address is re-derived from the master
   * secret and the passkey set and must equal the stored one: a stored address the current derivation
   * does not reproduce is an account this wallet cannot run, and it must not be registered or
   * used. The derived preimage is what the manager keeps, so a stored copy with stale public keys
   * behind a matching address never reaches encryption or spend metadata.
   */
  public static async createFromCompleteAddress(
    masterSecretKey: Fr,
    passkeySet: AlphaPasskeySet,
    completeAddress: CompleteAddress,
    options: AlphaContractManagerOptions,
  ) {
    const manager = new ObsidionAccountContractManager(masterSecretKey, passkeySet, options)
    const derived = await manager.getCompleteAddress()
    if (!derived.equals(completeAddress)) {
      throw new Error(
        `stored account ${completeAddress.address.toString()} is not the account this master secret and ` +
          `passkey set derive (${derived.address.toString()}); this wallet needs re-onboarding`,
      )
    }
    return manager
  }

  private constructor(
    masterSecretKey: Fr,
    passkeySet: AlphaPasskeySet,
    options: AlphaContractManagerOptions,
  ) {
    this.secretKey = deriveAccountSecretKey(masterSecretKey)
    this.passkeySet = passkeySet
    this.artifact = options.artifact
    this.contractName = options.contractName
    this.pxe = options.pxe
  }

  get address(): AztecAddress {
    if (!this.instance) {
      throw new Error("Instance not yet computed. Call getContractInstance() first.")
    }
    return this.instance.address
  }

  getContractArtifact(): ContractArtifact {
    return this.artifact
  }

  /** The passkey set committed into the address. */
  getPasskeySet(): AlphaPasskeySet {
    return this.passkeySet
  }

  async getContractInstance(): Promise<ContractInstanceWithAddress> {
    if (this.instance) return this.instance

    this.instance = await getContractInstanceFromInstantiationParams(this.artifact, {
      salt: DEFAULT_ACCOUNT_SALT,
      publicKeys: (await deriveKeys(this.secretKey)).publicKeys,
      immutablesHash: this.passkeySet.immutablesHash,
    })
    return this.instance
  }

  async getCompleteAddress(): Promise<CompleteAddress> {
    if (this.completeAddress) return this.completeAddress

    const instance = await this.getContractInstance()
    this.completeAddress = await CompleteAddress.fromSecretKeyAndInstance(this.secretKey, instance)
    return this.completeAddress
  }

  /** Registers once; concurrent callers share the attempt, and a failed one is retried by the next call. */
  public register(): Promise<void> {
    this.contractRegistration ??= this.registerAccount().catch((error) => {
      this.contractRegistration = null
      throw error
    })
    return this.contractRegistration
  }

  /** Awaits a registration in flight, if any; never starts one. */
  public async ensureContractRegistered(): Promise<void> {
    if (this.contractRegistration) {
      await this.contractRegistration
    }
  }

  public async getEncryptionSecret() {
    return computeAddressSecret(
      await (await this.getCompleteAddress()).getPreaddress(),
      deriveMasterIncomingViewingSecretKey(this.secretKey),
    )
  }

  /**
   * Raw master tagging public key point. v5 `PublicKeys` carries only the
   * domain-separated hash, so consumers that need the point (tag attestation)
   * re-derive it from the account secret here.
   */
  public async getMasterTaggingPublicKey() {
    return (await deriveKeys(this.secretKey)).masterTaggingPublicKey
  }

  /** Register the account and its contract in the PXE; a failure is the caller's, not logged away. */
  public async registerAccount(): Promise<void> {
    const instance = await this.getContractInstance()
    await this.contractService.registerUserAccount(
      instance,
      this.secretKey,
      this.contractName,
      this.pxe,
    )
  }

  /**
   * Build a {@link SpendMetadataResolver} bound to THIS account.
   *
   * The TEE signer's spend validation needs the owner's `ownerAddressPreimage`
   * (CompleteAddress) plus the `masterNullifierHidingKey` for each nullified
   * note. Oxide's upstream `buildSpendMetadata` helper hardcodes
   * `SchnorrAccountContract`, so it can't compute the right preimage for an
   * obsidion-account owner — the contract instance (and hence address) would
   * be derived from the wrong artifact.
   *
   * This helper closes over the account's `secretKey` privately. Callers
   * (TokenService.sendToken / TokenService.exitToL1Private) receive the
   * resolver closure but never the underlying secret. The closure asserts
   * that each nullified note's `owner` equals this account's deployed
   * address — guards against accidentally wiring the wrong account.
   */
  public async makeSpendMetadataResolver(): Promise<SpendMetadataResolver> {
    const completeAddress = await this.getCompleteAddress()
    const keys = await deriveKeys(this.secretKey)
    const ownerAddress = completeAddress.address
    return async (nullified): Promise<SpendMetadata> => {
      if (!nullified.owner.equals(ownerAddress)) {
        throw new Error(
          `[ObsidionAccountContractManager.makeSpendMetadataResolver] Owner mismatch: nullified note owner ${nullified.owner} != account address ${ownerAddress}`,
        )
      }
      return {
        creationTxHash: nullified.creationTxHash,
        ownerAddressPreimage: completeAddress,
        masterNullifierHidingKey: keys.masterNullifierHidingSecretKey,
      }
    }
  }

  /**
   * Resolves a spent deposit's recipient into the metadata the
   * TEE needs to key the deposit-message nullifier. Same guard shape as
   * {@link makeSpendMetadataResolver}: the closure asserts the claim's
   * recipient is this account.
   */
  public async makeDepositSpendMetadataResolver(): Promise<DepositSpendMetadataResolver> {
    const completeAddress = await this.getCompleteAddress()
    const keys = await deriveKeys(this.secretKey)
    const ownerAddress = completeAddress.address
    return async (recipient): Promise<DepositSpendMetadata> => {
      if (!recipient.equals(ownerAddress)) {
        throw new Error(
          `[ObsidionAccountContractManager.makeDepositSpendMetadataResolver] Recipient mismatch: deposit claim recipient ${recipient} != account address ${ownerAddress}`,
        )
      }
      return {
        ownerAddressPreimage: completeAddress,
        masterNullifierHidingKey: keys.masterNullifierHidingSecretKey,
      }
    }
  }
}

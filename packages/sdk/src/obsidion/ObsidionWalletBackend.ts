import {
  SchnorrAccountContract,
  SchnorrAccountContractArtifact,
  SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact,
} from "@aztec-labs/accounts/schnorr"
import { AccountManager, ContractInitializationStatus } from "@aztec-labs/aztec.js/wallet"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { Account, Salt } from "@aztec-labs/aztec.js/account"
import { Fr, type Fq } from "@aztec-labs/aztec.js/fields"
import {
  deriveMasterIncomingViewingSecretKey,
  deriveMasterMessageSigningSecretKey,
} from "@aztec-labs/stdlib/keys"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  ObsidionWallet,
  readNetworkId,
  type CreateWalletOptions,
  type ObsidionWalletOptions,
} from "./ObsidionWallet.js"
import type { AlphaAuthProvider } from "./alpha/auth/AlphaAuthProvider.js"
import { ObsidionFeeJuicePaymentMethod } from "../feePaymentMethod/obsidion_feepayment_method.js"
import {
  createPXE,
  getPXEConfig,
  type PXE,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec-labs/pxe/server"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { SendInteractionOptions, WaitOpts } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"

/**
 * ObsidionWalletBackend - Backend-only wallet extension for administrative operations.
 *
 * This class extends ObsidionWallet with additional methods for backend services:
 * - createAdminAccount: Create standard Schnorr accounts for deployer/admin purposes
 *
 * Unlike ObsidionWallet, this wallet:
 * - CANNOT create Obsidion accounts (createObsidionAccount throws)
 * - CAN create standard Schnorr accounts for deployment operations
 *
 * Use this in backend services that need deployer accounts but should NOT
 * create user-facing Obsidion accounts.
 */
export class ObsidionWalletBackend extends ObsidionWallet {
  // Deploy tooling: wait for CHECKPOINTED — deploy steps assume prior txs are settled on L1, and
  // sandbox runs share anvil account #0 with the sequencer's L1 publisher.
  public override readonly defaultWaitOpts: WaitOpts = {}

  /** Our own Sponsored FPC address (set after deployment) */
  private ownSponsorFPCAddress: AztecAddress | null = null

  /**
   * When true, a deploy with no SponsorFPC pays from the sender's own fee juice
   * instead of throwing. Enabled only for the mainnet minimal deploy, which
   * skips the drainable SponsorFPC; testnet/sandbox keep the fail-loud guard.
   */
  private allowDirectFeeJuice = false

  constructor(pxe: PXE, node: AztecNode, networkId: string, walletOpts?: ObsidionWalletOptions) {
    super(pxe, node, networkId, walletOpts)
  }

  /**
   * Set the address of our own Sponsored FPC
   * This should be called after deploying our Sponsored FPC
   */
  setOwnSponsorFPCAddress(address: AztecAddress): void {
    this.ownSponsorFPCAddress = address
  }

  /** Allow SponsorFPC-less deploys to pay from the sender's own fee juice (mainnet). */
  setAllowDirectFeeJuice(allow: boolean): void {
    this.allowDirectFeeJuice = allow
  }

  /**
   * Get the address of our own Sponsored FPC
   */
  getOwnSponsorFPCAddress(): AztecAddress | null {
    return this.ownSponsorFPCAddress
  }

  static override async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
    walletOpts?: CreateWalletOptions,
  ): Promise<ObsidionWalletBackend> {
    const networkId = await readNetworkId(node, walletOpts)
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      autoSync: overridePXEConfig?.autoSync ?? false,
      ...overridePXEConfig,
    })
    // Honor caller-provided dataDirectory (e.g. tests that want isolation);
    // default to the rollup-keyed path so prod restarts reuse the cache.
    pxeConfig.dataDirectory = pxeConfig.dataDirectory ?? `pxe-${networkId}`

    const pxe = await createPXE(node, pxeConfig, options)
    return new ObsidionWalletBackend(pxe, node, networkId, walletOpts)
  }

  /**
   * Default fee payer for backend deploys: our own SponsorFPC once
   * setOwnSponsorFPCAddress has been called. With no SponsorFPC it throws unless
   * setAllowDirectFeeJuice(true) was called (the mainnet minimal deploy, which
   * skips the drainable SponsorFPC), in which case the sender pays from its own
   * bridged fee juice.
   *
   * @param from - The address to send from
   */
  override async getDefaultSendOptions(from: AztecAddress): Promise<SendInteractionOptions> {
    if (!this.ownSponsorFPCAddress) {
      if (!this.allowDirectFeeJuice) {
        // testnet/sandbox always deploy a SponsorFPC; a null address here means
        // it is missing, which bricks app boot (initFPC requires it off-mainnet).
        // Fail loud rather than deploy into a broken registry.
        throw new Error(
          "Own Sponsor FPC address not set. Deploy the SponsorFPC first, or enable direct " +
            "fee-juice payment (mainnet minimal deploy) via setAllowDirectFeeJuice.",
        )
      }
      // Mainnet skips the drainable SponsorFPC: `{ from }` with no fee payer
      // makes the base wallet select PREEXISTING_FEE_JUICE, so the sender (admin)
      // pays from its own bridged balance.
      return { from }
    }

    return {
      from,
      fee: {
        paymentMethod: new ObsidionFeeJuicePaymentMethod(
          this.ownSponsorFPCAddress,
          await this.getGasSettings(),
        ),
      },
    }
  }

  /**
   * Create and deploy an admin Schnorr account for backend deployment operations.
   *
   * This creates a standard Aztec Schnorr account suitable for:
   * - Deploying contracts
   * - Administrative operations
   * - Backend service accounts
   *
   * The account is automatically deployed if not already initialized.
   * On testnet/mainnet, a fee payment method (e.g., Aztec's existing Sponsored FPC)
   * should be provided to pay for the deployment transaction.
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment (optional, uses Fr.random() if not provided)
   * @param signingKey - Optional signing key (derived from secret if not provided)
   * @param feePaymentMethod - Optional fee payment method for deploying the account (for testnet/mainnet)
   * @returns Object containing AccountManager and the deployed account
   */
  async createAdminAccount(
    secret: Fr,
    salt?: Salt,
    signingKey?: Fq,
    feePaymentMethod?: FeePaymentMethod,
    // v5's prefunded genesis accounts (getInitialTestAccountsData) are
    // `schnorr_initializerless`: no constructor, address derives from the signing key.
    // Reproducing one requires the initializerless contract class + skipping deployment.
    initializerless = false,
  ): Promise<{ manager: AccountManager; account: Account }> {
    const sk = signingKey ?? deriveMasterIncomingViewingSecretKey(secret)
    const contract = initializerless
      ? new SchnorrInitializerlessAccountContract(sk)
      : new SchnorrAccountContract(sk)
    const artifact = initializerless
      ? SchnorrInitializerlessAccountContractArtifact
      : SchnorrAccountContractArtifact
    const accountSalt = salt ?? Fr.random()

    const accountManager = await AccountManager.create(this, secret, contract, {
      salt: accountSalt,
    })
    const instance = accountManager.getInstance()

    // Register the contract with the PXE
    await this.registerContract(instance, artifact, accountManager.getSecretKey())

    const completeAddress = await accountManager.getCompleteAddress()
    // Casting here to base account, changed from accountwithsecretkey which is less versatile
    const account = accountManager.getAccountContract().getAccount(completeAddress) as Account
    // Tag as "schnorr" either way — the initializerless variant shares the Schnorr entrypoint,
    // so the same simulation stub applies.
    this.addAccount(account.getAddress(), account, "schnorr")

    // Initializerless accounts have no on-chain deploy: the signing pubkey is committed
    // into the address via `immutablesHash`, and the contract's `constructor` is a
    // client-side `abi_utility` that materializes that pubkey into a local PXE capsule
    // (PUB_KEY_SLOT). We must run it once here — otherwise the entrypoint's `is_valid_impl`
    // `load` returns empty and panics "Public key was not stored in the PXE, call
    // `constructor` first" on the account's first tx. Mirrors aztec's TestWallet.createAccount
    // and EmbeddedWallet.createAccountInternal. (`getDeployMethod` throws for these — no
    // initializer to send — so there is no deploy round-trip.)
    if (initializerless) {
      const constructorAbi = artifact.functions.find((f) => f.name === "constructor")
      if (!constructorAbi) {
        throw new Error(
          "SchnorrInitializerlessAccount artifact is missing its `constructor` utility",
        )
      }
      const { x, y } = await contract.getSigningPublicKey()
      const seedCapsule = new ContractFunctionInteraction(this, instance.address, constructorAbi, [
        x,
        y,
      ])
      await seedCapsule.simulate({ from: instance.address })
      return { manager: accountManager, account }
    }

    // Check if the contract is already initialized on-chain by checking the nullifier tree
    const contractMetadata = await this.getContractMetadata(account.getAddress())

    if (contractMetadata.initializationStatus !== ContractInitializationStatus.INITIALIZED) {
      console.log("Deploying admin account...")
      const deployMethod = await accountManager.getDeployMethod()

      // Build send options with optional fee payment method
      const sendOptions = {
        // Signerless deployment uses the NO_FROM sentinel (routes through DefaultEntrypoint
        // inside BaseWallet). Passing AztecAddress.ZERO would fail because the wallet no
        // longer creates a SignerlessAccount for ZERO.
        from: NO_FROM,
        universalDeploy: true,
        contractAddressSalt: new Fr(accountSalt),
        fee: {
          paymentMethod: feePaymentMethod,
          gasSettings: await this.getGasSettings(),
        },
      }
      const { contract } = await deployMethod.send(sendOptions)
      console.log(`Admin account deployed: ${contract.address}`)
    } else {
      console.log("Admin account already initialized on-chain, skipping deployment")
    }

    return { manager: accountManager, account }
  }

  /**
   * Get an existing admin Schnorr account from secret and salt.
   *
   * Use this when the account has already been deployed and you need to recover it.
   *
   * @param secret - The secret key for the account
   * @param salt - The salt used during deployment
   * @param signingKey - Optional signing key (derived from secret if not provided)
   * @returns Object containing AccountManager and the account
   */
  async getAdminAccount(secret: Fr, salt: Salt, signingKey?: Fq): Promise<Account> {
    const sk = signingKey ?? deriveMasterIncomingViewingSecretKey(secret)
    const contract = new SchnorrAccountContract(sk)

    const accountManager = await AccountManager.create(this, secret, contract, { salt })
    const instance = accountManager.getInstance()

    // Register the contract with the PXE
    await this.registerContract(
      instance,
      SchnorrAccountContractArtifact,
      accountManager.getSecretKey(),
    )

    const account = await accountManager.getAccount()
    this.addAccount(account.getAddress(), account, "schnorr")

    return account
  }

  /**
   * Override createObsidionAccount to prevent usage in backend wallet.
   *
   * Backend wallets should not create Obsidion accounts - those are for
   * user-facing applications only. Use createAdminAccount() instead for
   * deployer/admin accounts.
   */
  override async createObsidionAccount(
    _secretKey: Fr,
    _authProvider: AlphaAuthProvider,
  ): Promise<never> {
    throw new Error(
      "createObsidionAccount is not implemented in backend wallet. " +
        "Use createAdminAccount() for deployer/admin accounts instead.",
    )
  }
}

/**
 * Recover the initializerless Schnorr account used by deployment tooling and backend operators.
 * Keeping this beside ObsidionWalletBackend gives the deployer, the sandbox tooling and the backend
 * services one public SDK entrypoint.
 */
export async function getDeployAdminAccount(
  wallet: ObsidionWalletBackend,
  secret: Fr,
): Promise<Account> {
  const { account } = await wallet.createAdminAccount(
    secret,
    Fr.ZERO,
    deriveMasterMessageSigningSecretKey(secret),
    undefined,
    true,
  )
  return account
}

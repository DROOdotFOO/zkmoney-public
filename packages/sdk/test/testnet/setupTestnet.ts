/**
 * Testnet harness for SDK E2E gates.
 *
 * Mirrors the sandbox `setupTest` but targets the public Aztec testnet
 * (URL pinned in `@obsidion/core/constants`) and pays fees via Obsidion's
 * own `sponsorFPC` — seeded from the committed staging profile document's
 * live version — so the test account does NOT need pre-funded fee juice.
 *
 * Default behavior:
 *   - Connects to `TESTNET_NODE_URL` from `@obsidion/core/constants`.
 *   - Generates a fresh K256 signing key + secret key per process via
 *     `Fr.random()` — no operator setup.
 *   - Seeds Obsidion's `sponsorFPC` and `passwordFPC` from the profile
 *     document and registers them in PXE so the fee call decodes against
 *     the right contract class; the oxide token comes from the oxide
 *     overlay, never a seed.
 *   - The account needs no deployment: its first tx is an ordinary
 *     `entrypoint` paid through the sponsor FPC.
 *
 * Required env:
 *   OXIDE_MANIFEST_URL, OXIDE_PORTAL — the oxide manifest pointer; the
 *     token overlay and the TEE signer resolve through it.
 *
 * Optional env:
 *   TESTNET_NODE_URL_OVERRIDE        — point at a fork / staging.
 *   TESTNET_PROFILE_PATH             — override the profile document path.
 *   OXIDE_EXPECTED_GIT_SHA           — same-sha drift pin for the manifest.
 *   TESTNET_L1_RPC_URL               — L1 JSON-RPC for the TEE binding.
 *   TESTNET_SKIP=1                   — skip every testnet suite.
 */
import { readFileSync } from "fs"
import { resolve as resolvePath } from "path"
import { Fr, type Fq } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Gas, GasSettings } from "@aztec-labs/stdlib/gas"
import { deriveMasterIncomingViewingSecretKey } from "@aztec-labs/stdlib/keys"
import { TESTNET_NODE_URL, AZTEC_NODE_API_KEY, DEFAULT_CONTRACTS } from "@obsidion/core/constants"

import {
  ContractService,
  EcdsaK256AlphaAuthProvider,
  Network,
  NodeContractServiceStorage,
  type ObsidionAccount,
  ObsidionFeeJuicePaymentMethod,
  PasswordFPCPaymentMethod,
  createNode,
} from "../../src/index.js"
import { ObsidionWalletTest } from "../../src/obsidion/ObsidionWalletTest.js"
import type { SpendMetadataResolver } from "@oxide/oxide-client/token_operations_collector.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { buildSpendMetadata } from "@oxide/oxide-client/spend_metadata.js"
import { NO_FROM, type Account, type Salt } from "@aztec-labs/aztec.js/account"
import { ContractInitializationStatus } from "@aztec-labs/aztec.js/wallet"

/**
 * Optional knobs for a benchmark/multi-wallet caller. Default (no options)
 * preserves the original behavior — fresh random keys, default data dir,
 * no-op teardown — so existing testnet suites are unaffected.
 */
export interface SetupTestnetOptions {
  /**
   * Account type. "alpha" (default) = ObsidionAccount with ECDSA K256 auth.
   * "schnorr" = a plain Schnorr account mirroring the fee-service admin —
   * signing key DERIVED from the secret, no separate ECDSA key.
   */
  accountType?: "alpha" | "schnorr"
  /** Fixed Aztec secret key (stable, pre-fundable address). Random if unset. */
  secretKey?: Fr
  /** Fixed K256 signing key (alpha only; schnorr derives from the secret). Random if unset. */
  signingKey?: Buffer
  /** PXE store dir. Pass a unique `pxe-`-prefixed value for a cold store. */
  dataDirectory?: string
  /** Build the real testnet oxide TEE signer + spend-metadata resolver. */
  attachTeeSigner?: boolean
  /** Front-end composition supplies the front-core TEE source without reversing the package graph. */
  loadTeeSigner?(l1RpcUrl: string): Promise<RegisteredTeeSigner | undefined>
  /**
   * Deploy the account on-chain. A fresh Schnorr account needs this (it does
   * not auto-deploy); alpha accounts auto-deploy on their first tx, so this is
   * a no-op for them. Idempotent — skips if already initialized on-chain.
   */
  deployAccount?: boolean
}

export interface TestnetSetupResult {
  wallet: ObsidionWalletTest
  /** ObsidionAccount for "alpha", a Schnorr Account for "schnorr". */
  account: Account
  fromAddress: AztecAddress
  secretKey: Fr
  /** Present only for "alpha" accounts. */
  authProvider?: EcdsaK256AlphaAuthProvider
  /** Obsidion sponsorFPC payment method, ready to thread through fee opts. */
  sponsoredFeePaymentMethod: ObsidionFeeJuicePaymentMethod
  /** Obsidion sponsorFPC contract address, resolved from the profile document. */
  sponsorFpcAddress: AztecAddress
  /** Obsidion passwordFPC contract address (testnet sponsored-fee path). */
  passwordFpcAddress?: AztecAddress
  /** PasswordFPC payment method — built only when FPC_PASSWORD is set. */
  passwordFeePaymentMethod?: PasswordFPCPaymentMethod
  teardown: () => Promise<void>
  /** Present only when `attachTeeSigner` was set: the real testnet oxide TEE signer. */
  teeSigner?: RegisteredTeeSigner
  /** Present only when `attachTeeSigner` was set: this account's spend-metadata resolver. */
  resolveSpendMetadata?: SpendMetadataResolver
}

const TESTNET_FEE_MULTIPLIER = 2n

export async function setupTestnet(options?: SetupTestnetOptions): Promise<TestnetSetupResult> {
  const nodeUrl = process.env.TESTNET_NODE_URL_OVERRIDE ?? TESTNET_NODE_URL
  const profilePath =
    process.env.TESTNET_PROFILE_PATH ??
    resolvePath(__dirname, "../../../backend/config-service/profiles/staging-v5.json")
  const oxideManifestUrl = process.env.OXIDE_MANIFEST_URL
  const oxidePortal = process.env.OXIDE_PORTAL
  if (!oxideManifestUrl || !oxidePortal) {
    throw new Error(
      "[setupTestnet] OXIDE_MANIFEST_URL and OXIDE_PORTAL are required — the token overlay and " +
        "the TEE signer resolve through the oxide manifest pointer.",
    )
  }
  console.log(`[setupTestnet] node: ${nodeUrl}`)
  console.log(`[setupTestnet] profile: ${profilePath}`)
  console.log(`[setupTestnet] oxide manifest: ${oxideManifestUrl} (${oxidePortal})`)

  const node = createNode(nodeUrl, AZTEC_NODE_API_KEY)
  // PXE MUST run with `proverEnabled: true` for testnet — the node's
  // `TxProofValidator` uses a real BB circuit verifier that rejects the
  // test prover's fake proofs with `Invalid proof`. Mirrors
  // `packages/tooling/l2-contracts-deployer/scripts/bridgeFeeJuice.ts` which sets
  // `proverEnabled = !isSandbox`. (Server-side PXE proving for testnet
  // is several seconds per circuit — WASM via bb.js.)
  const wallet = await ObsidionWalletTest.create(node, {
    proverEnabled: true,
    dataDirectory: options?.dataDirectory,
  })

  // CRITICAL: ObsidionWalletTest.completeFeeOptions defaults the fee
  // payer to upstream Aztec's SponsoredFPC (sponsored.aztec) when the
  // executionPayload doesn't embed a feePayer. On testnet that FPC has
  // ZERO fee juice (the canonical sponsored.aztec deployment is
  // sandbox-only). Patch completeFeeOptions to route through Obsidion's
  // own sponsorFPC (resolved below) — same architectural pattern as
  // Aztec's, but funded.
  // We do this by attaching the override AFTER the sponsorFPC address
  // is resolved (further down in this function).

  // ContractService must be initialized BEFORE createObsidionAccount. The harness owns its
  // address store: the deployed contracts are seeded from the staging profile document's live
  // version below, so we resolve the Obsidion sponsorFPC deployment (rather than the upstream
  // Aztec SponsoredFPC, which is a different contract). oxideToken is deliberately NOT
  // seeded — the profile never carries it, and the ContractService oxide overlay supplies it
  // from the manifest pointer above.
  ContractService.resetInstance()
  const storage = new NodeContractServiceStorage(Network.TESTNET)
  const profile = JSON.parse(readFileSync(profilePath, "utf-8")) as {
    current?: string
    versions?: Record<string, { contracts?: Record<string, { address?: string }> }>
  }
  const contracts = profile.versions?.[profile.current ?? ""]?.contracts ?? {}
  for (const name of [DEFAULT_CONTRACTS.sponsorFPC, DEFAULT_CONTRACTS.passwordFPC]) {
    const address = contracts[name]?.address
    if (typeof address === "string" && address.length > 0) {
      await storage.setContractAddress(name, AztecAddress.fromStringUnsafe(address))
    }
  }
  // local-ledger: ObsidionWalletTest pulls ObsidionAccountAlphaTest (a TEST-only
  // artifact) which the deployed slots do not describe.
  const contractService = ContractService.getInstance(
    storage,
    wallet.node,
    wallet.pxe,
    Network.TESTNET,
    {
      source: "local-ledger",
      oxideEnvProfile: {
        manifestUrl: oxideManifestUrl,
        portal: oxidePortal,
        expectedGitSha: process.env.OXIDE_EXPECTED_GIT_SHA || undefined,
      },
    },
  )

  // Register the sponsorFPC contract instance + artifact in PXE so fee-method
  // calls decode against the right contract class.
  await contractService.registerContractWithName(DEFAULT_CONTRACTS.sponsorFPC)
  const sponsorFpcAddress = await contractService.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)
  if (!sponsorFpcAddress) {
    throw new Error(`[setupTestnet] sponsorFPC has no address in the profile ${profilePath}`)
  }
  console.log(`[setupTestnet] sponsorFPC: ${sponsorFpcAddress.toString()}`)

  // Token-op callers (paylink deposit/claim, balance reads) need the
  // oxide-token contract instance in THIS wallet's PXE, or simulating
  // `balance_of_private` / the transfer fails with "No contract instance
  // found". `contractService` is bound to this wallet's pxe, so this
  // registers it per-wallet. Gated on attachTeeSigner (the token-op path)
  // so non-token testnet suites are unchanged.
  let passwordFpcAddress: AztecAddress | undefined
  if (options?.attachTeeSigner) {
    await contractService.registerContractWithName(DEFAULT_CONTRACTS.oxideToken)
    // PasswordFPC: the testnet sponsored-fee path (the same FPC the bridge-
    // relayer pays L2 claims through). Register it in this wallet's PXE so its
    // fee_entrypoint_private decodes; the payment method is built below once
    // gasSettings exists, when FPC_PASSWORD is present.
    await contractService.registerContractWithName(DEFAULT_CONTRACTS.passwordFPC)
    passwordFpcAddress = await contractService.getContractAddress(DEFAULT_CONTRACTS.passwordFPC)
  }

  // Build the Obsidion sponsorFPC payment method. Selector is
  // `fee_entrypoint_private(u128, Field)` per
  // `packages/contracts/contracts/fee_paying/sponsor_fpc/src/main.nr`.
  // gasSettings: scale current min fees just like ObsidionWallet does
  // internally (see getGasSettings — protected, so we mirror the math).
  const minFees = await wallet.node.getCurrentMinFees()
  const maxFeesPerGas = minFees.mul(TESTNET_FEE_MULTIPLIER)
  // v5 GasSettings.fallback requires explicit gasLimits — the network's per-tx admission limit.
  const { txsLimits } = await wallet.node.getNodeInfo()
  const gasSettings = GasSettings.fallback({ maxFeesPerGas, gasLimits: Gas.from(txsLimits.gas) })
  const sponsoredFeePaymentMethod = new ObsidionFeeJuicePaymentMethod(
    sponsorFpcAddress,
    gasSettings,
  )
  // PasswordFPC method for testnet sends (paylink create/claim). Routes fees
  // through Obsidion's password-gated FPC instead of the upstream Aztec
  // SponsoredFPC (which carries no testnet balance). Undefined when the FPC
  // isn't registered (non-token suites) or FPC_PASSWORD is unset.
  const fpcPassword = process.env.FPC_PASSWORD
  const passwordFeePaymentMethod =
    passwordFpcAddress && fpcPassword
      ? new PasswordFPCPaymentMethod(fpcPassword, passwordFpcAddress, gasSettings)
      : undefined

  // Patch ObsidionWalletTest.completeFeeOptions to default to Obsidion's
  // sponsorFPC instead of Aztec's. Without this, sendTx for an alpha
  // account routes through Aztec's SponsoredFPC (zero balance on
  // testnet), giving a misleading `Insufficient fee payer balance`
  // error.
  // Architecture: alpha account contract maps `fee_method = EXTERNAL`
  // to a no-op (only PREEXISTING_FEE_JUICE / FEE_JUICE_WITH_CLAIM
  // trigger `set_as_fee_payer`). EXTERNAL relies on the
  // `walletFeePaymentMethod`'s embedded call (`fee_entrypoint_private`
  // for our SponsorFPC) to mark the FPC as fee payer.
  // We override the FULL completeFeeOptions because the test wallet's
  // current override hardcodes Aztec's SponsoredFPC.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(wallet as any).completeFeeOptions = async function (config: any): Promise<any> {
    const { gasSettings: configGas, feePayer } = config
    const maxFeesPerGas =
      configGas?.maxFeesPerGas ??
      (await this.aztecNode.getCurrentMinFees()).mul(TESTNET_FEE_MULTIPLIER)
    // Mirror BaseWallet's GasSettings.fallback; v5 requires explicit gasLimits.
    const { txsLimits: limits } = await this.aztecNode.getNodeInfo()
    const fullGasSettings =
      configGas?.gasLimits && configGas?.teardownGasLimits
        ? configGas
        : GasSettings.fallback({ maxFeesPerGas, gasLimits: Gas.from(limits.gas) })

    if (!feePayer) {
      // Default path: route through Obsidion's sponsorFPC.
      const obsidionFpcMethod = new ObsidionFeeJuicePaymentMethod(
        sponsorFpcAddress,
        fullGasSettings,
      )
      return {
        gasSettings: fullGasSettings,
        walletFeePaymentMethod: obsidionFpcMethod,
        // EXTERNAL=0: alpha entrypoint won't call `set_as_fee_payer`
        // itself; the FPC's `fee_entrypoint_private` does it via the
        // fee call merged into the payload.
        // (Enum: EXTERNAL=0, PREEXISTING_FEE_JUICE=1, FEE_JUICE_WITH_CLAIM=2.)
        accountFeePaymentMethodOptions: 0 /* EXTERNAL */,
      }
    }

    // Embedded feePayer path: defer to base behavior (no walletFeePaymentMethod).
    const accountFeePaymentMethodOptions = config.from?.equals?.(feePayer)
      ? 2 /* FEE_JUICE_WITH_CLAIM */
      : 0 /* EXTERNAL */
    return {
      gasSettings: fullGasSettings,
      walletFeePaymentMethod: undefined,
      accountFeePaymentMethodOptions,
    }
  }

  // Patch getDefaultSendOptions too. The paylink create/claim fee resolver
  // (resolveFeePaymentMethod) falls back to wallet.getDefaultSendOptions(sender)
  // when no explicit fee is threaded, and ObsidionWalletTest's version returns
  // the upstream Aztec SponsoredFPC — undeployed on testnet, so it throws
  // "SponsoredFPC not deployed." Route the no-options default through Obsidion's
  // own FPC: the PasswordFPC when FPC_PASSWORD is set, else the fee-juice
  // sponsorFPC. Explicit-options calls defer to the original behavior.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origGetDefaultSendOptions = (wallet as any).getDefaultSendOptions.bind(wallet)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(wallet as any).getDefaultSendOptions = async function (from: AztecAddress, opts?: any) {
    if (opts) return origGetDefaultSendOptions(from, opts)
    return {
      from,
      fee: { paymentMethod: passwordFeePaymentMethod ?? sponsoredFeePaymentMethod, gasSettings },
    }
  }

  // Aztec secret key. Fixed (stable, pre-fundable address) when provided via
  // options; otherwise fresh per process.
  const accountType = options?.accountType ?? "alpha"
  const secretKey = options?.secretKey ?? Fr.random()

  // "schnorr" mirrors the fee-service admin: a plain Schnorr account whose
  // signing key is DERIVED from the secret (no separate ECDSA key). Captured
  // so the spend-metadata resolver can reuse it (buildSpendMetadata needs
  // secret + salt + signingKey). "alpha" keeps the ECDSA K256 auth provider.
  let account: Account
  let authProvider: EcdsaK256AlphaAuthProvider | undefined
  let schnorrSigningKey: Fq | undefined
  const schnorrSalt: Salt = Fr.ONE

  if (accountType === "schnorr") {
    schnorrSigningKey = deriveMasterIncomingViewingSecretKey(secretKey)
    const manager = await wallet.createSchnorrAccount(secretKey, schnorrSalt, schnorrSigningKey)
    account = await manager.getAccount()
    if (options?.deployAccount) {
      // A fresh Schnorr account does not auto-deploy. Mirror
      // ObsidionWalletBackend.createAdminAccount: idempotent init-status
      // check, then a signerless universal deploy paid via the sponsorFPC.
      const meta = await wallet.getContractMetadata(account.getAddress())
      if (meta.initializationStatus !== ContractInitializationStatus.INITIALIZED) {
        console.log(
          `[setupTestnet] deploying schnorr account ${account.getAddress().toString()}...`,
        )
        const deployMethod = await manager.getDeployMethod()
        // Assign to a variable first (not a fresh object literal) so TS's
        // excess-property check doesn't reject `universalDeploy` — it's
        // accepted at runtime but absent from the declared DeployOptions type
        // (same pattern as ObsidionWalletBackend.createAdminAccount).
        const deploySendOptions = {
          from: NO_FROM,
          universalDeploy: true,
          contractAddressSalt: new Fr(schnorrSalt),
          fee: { paymentMethod: sponsoredFeePaymentMethod, gasSettings },
        }
        await deployMethod.send(deploySendOptions)
        console.log("[setupTestnet] schnorr account deployed")
      } else {
        console.log("[setupTestnet] schnorr account already initialized on-chain")
      }
    }
  } else {
    const signingKey = options?.signingKey ?? new Fr(Fr.random().toBigInt() % Fr.MODULUS).toBuffer()
    authProvider = new EcdsaK256AlphaAuthProvider(signingKey)
    account = await wallet.createObsidionAccount(secretKey, authProvider)
  }
  const fromAddress = account.getAddress()
  console.log(
    `[setupTestnet] ${accountType} account: ${fromAddress.toString()} ` +
      `(keys: ${options?.secretKey ? "fixed" : "fresh"})`,
  )

  // Optional: wire the real testnet oxide TEE signer (mirrors the app's
  // createOxideTeeSignerSource path). oxide-token / paylink ops won't
  // validate without it. The oxide env-registry client must fetch its
  // manifest tuple before the signer can load — the same lifecycle the
  // app's ContractServiceProvider drives via client.initialize().
  let teeSigner: RegisteredTeeSigner | undefined
  let resolveSpendMetadata: SpendMetadataResolver | undefined
  if (options?.attachTeeSigner) {
    const oxide = contractService.getOxideClient()
    if (!oxide) {
      throw new Error("[setupTestnet] attachTeeSigner: no oxide client for this network")
    }
    await oxide.initialize()
    if (!oxide.getCurrentTuple()) {
      throw new Error(
        "[setupTestnet] attachTeeSigner: oxide manifest tuple unavailable after initialize()",
      )
    }
    const l1RpcUrl = process.env.TESTNET_L1_RPC_URL
    if (!l1RpcUrl) {
      throw new Error(
        "[setupTestnet] attachTeeSigner needs TESTNET_L1_RPC_URL (L1 JSON-RPC for the testnet binding)",
      )
    }
    if (!options.loadTeeSigner) {
      throw new Error(
        "[setupTestnet] attachTeeSigner needs a front-end supplied loadTeeSigner callback",
      )
    }
    teeSigner = await options.loadTeeSigner(l1RpcUrl)
    if (!teeSigner) {
      throw new Error("[setupTestnet] attachTeeSigner: TEE signer failed to load from oxide tuple")
    }
    if (accountType === "schnorr") {
      // Build the resolver from the account's own key material, mirroring the
      // sandbox's buildSpendMetadata resolver (ObsidionAccount's
      // makeSpendMetadataResolver does not apply to a Schnorr account).
      const sgk = schnorrSigningKey!
      resolveSpendMetadata = async (nullified) => {
        if (!nullified.owner.equals(fromAddress)) {
          throw new Error(
            `[setupTestnet] spend-metadata owner mismatch: ${nullified.owner} != ${fromAddress}`,
          )
        }
        return buildSpendMetadata({
          secret: secretKey,
          salt: schnorrSalt,
          signingKey: sgk,
          creationTxHash: nullified.creationTxHash,
        })
      }
    } else {
      resolveSpendMetadata = await (account as ObsidionAccount).makeSpendMetadataResolver()
    }
    console.log("[setupTestnet] TEE signer attached")
  }

  return {
    wallet,
    account,
    fromAddress,
    secretKey,
    authProvider,
    sponsoredFeePaymentMethod,
    sponsorFpcAddress,
    passwordFpcAddress,
    passwordFeePaymentMethod,
    teeSigner,
    resolveSpendMetadata,
    // Opt-in teardown: only a caller that passed `options` (benchmark /
    // cold-store runs) gets a real PXE close. Default callers keep the
    // historical no-op so the existing testnet suites that share a
    // singleFork process are unaffected.
    teardown: async () => {
      if (options) {
        await wallet.stop()
      }
    },
  }
}

/**
 * Skip-gate for the testnet suite. The testnet URL is pinned in
 * `@obsidion/core/constants`; the only opt-out is the explicit
 * `TESTNET_SKIP=1` flag (intended for CI).
 */
export function skipUnlessTestnet(): boolean {
  return process.env.TESTNET_SKIP === "1"
}

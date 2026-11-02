import {
  BaseWallet,
  buildMergedSimulationResult,
  extractOptimizablePublicStaticCalls,
  simulateViaNode,
  type FeeOptions,
} from "@aztec-labs/wallet-sdk/base-wallet"
import {
  ContractService,
  DEFAULT_CONTRACTS,
  getSimulatedAlphaAccountArtifact,
  type ContractName,
} from "@obsidion/contracts"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { SimulationOverrides, type ContractOverrides } from "@aztec-labs/stdlib/tx"
import { StubAlphaAuthProvider } from "./alpha/auth/StubAlphaAuthProvider.js"
import { ObsidionAccountEntrypoint } from "./alpha/account/ObsidionAccountEntrypoint.js"
import { BaseAccount } from "@aztec-labs/aztec.js/account"
import {
  createStubSchnorrAccount,
  getStubSchnorrAccountContractArtifact,
} from "@aztec-labs/accounts/schnorr/stub/lazy"
import {
  createStubEcdsaAccount,
  getStubEcdsaAccountContractArtifact,
} from "@aztec-labs/accounts/ecdsa/stub/lazy"
import { getPXEConfig, type PXEConfig } from "@aztec-labs/pxe/config"
import {
  createPXE as createPXELazy,
  type PXE,
  type PXECreationOptions,
} from "@aztec-labs/pxe/client/lazy"
import { ObsidionAccount } from "./alpha/account/ObsidionAccount.js"
import {
  ObsidionAccountContractManager,
  type AlphaContractManagerOptions,
} from "./alpha/account/ObsidionAccountContractManager.js"
import { alphaPasskeySet } from "./alpha/account/alphaPasskeySet.js"
import type { AlphaAuthProvider } from "./alpha/auth/AlphaAuthProvider.js"
import {
  collectOffchainEffects,
  type ExecutionPayload,
  mergeExecutionPayloads,
  type TxExecutionRequest,
  type TxProfileResult,
  type UtilityExecutionResult,
} from "@aztec-labs/stdlib/tx"
import { CallAuthorizationRequest } from "@aztec-labs/aztec.js/authorization"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  type Aliased,
  TxSimulationResultWithAppOffset,
  type ExecuteUtilityOptions,
  type PrivateEvent,
  type PrivateEventFilter,
  type ProfileOptions,
} from "@aztec-labs/aztec.js/wallet"
import { type Account, NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type {
  SendInteractionOptions,
  SimulateInteractionOptions,
} from "@aztec-labs/aztec.js/contracts"
import type { CompleteAddress } from "@aztec-labs/aztec.js/addresses"
import type { NodeInfo } from "@aztec-labs/stdlib/contract"
import type { ChainInfo } from "@aztec-labs/entrypoints/interfaces"
import type {
  ContractArtifact,
  FunctionCall,
  EventMetadataDefinition,
} from "@aztec-labs/stdlib/abi"
import { FEE_MULTIPLIER, getBlockBaseMaxFees } from "../utils/index.js"
import { DEFAULT_WAIT_OPTS } from "../utils/constants.js"
import { CLAIM_FPC_MAX_FEES_PER_GAS } from "../feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import {
  AccountFeePaymentMethodOptions,
  type DefaultAccountEntrypointOptions,
} from "@aztec-labs/entrypoints/account"
import { Gas, GasSettings } from "@aztec-labs/stdlib/gas"
import { assertProvenGasWithinLimits, type PayloadFinalizer } from "./stagedExecution.js"
import { FeeUnavailableError } from "./FeeUnavailableError.js"
import {
  ProvingStage,
  provingProgress,
  type OriginalFlowKind,
  type ProvingOperationContext,
  type TxKind,
} from "@obsidion/proving-progress"
import {
  proveTxWithProgress,
  readPerfLogFlag,
  readTimingBenchFlag,
} from "./proving-progress-helpers.js"
import { benchmarkRegistry } from "./benchmark/benchmarkRegistry.js"
import {
  benchNow,
  extractProveTimings,
  formatProveTxPerfLine,
} from "./benchmark/proveTimingExtract.js"
import { extractSimFunctions } from "./benchmark/simFunctionExtract.js"
import {
  type InteractionWaitOptions,
  NO_WAIT,
  type SendReturn,
  type WaitOpts,
  extractOffchainOutput,
} from "@aztec-labs/aztec.js/contracts"
import { getGasLimits } from "@aztec-labs/wallet-sdk/base-wallet"
import type { SendOptions } from "@aztec-labs/aztec.js/wallet"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { displayDebugLogs } from "@aztec-labs/pxe/client/lazy"
import { inspect } from "util"
import {
  InMemoryPendingTxStore,
  MAX_TX_LIFETIME_MS,
  type IPendingTxStore,
  type PendingTxRecord,
} from "./pending/index.js"

export type CreateObsidionAccountWalletOptions = {
  timeout?: number
  updateStatus?: (status: string) => void
}

export type GetObsidionAccountWalletOptions = {
  completeAddress?: CompleteAddress
  register?: boolean
}

export interface FeePaymentOptions {
  gasSettings?: GasSettings
}

/** The chain identity every signing and derivation site binds to. */
export type WalletChainInfo = Pick<NodeInfo, "l1ChainId" | "rollupVersion">

export interface ObsidionWalletOptions {
  /** Defaults to in-memory; a platform may inject the encrypted front-core `PendingTxStore`. */
  pendingTxStore?: IPendingTxStore
  /**
   * Identity the composition root verified against L1. Pinned, it replaces the node's answer at
   * every tx context, authwit hash, account build and link stamp; absent, the node's answer is
   * taken.
   */
  chainInfo?: WalletChainInfo
}

/** `networkId` is the pinned rollup address; absent, `create` reads the node's. */
export type CreateWalletOptions = ObsidionWalletOptions & { networkId?: string }

/**
 * `aztecNode.sendTx` succeeded but the pending record did not persist. Carries `txHash` so the
 * caller can show "submitted, tracking failed" rather than a generic send failure.
 */
export class SubmittedPendingRecordPersistError extends Error {
  override readonly name = "SubmittedPendingRecordPersistError"
  constructor(public readonly txHash: string, public override readonly cause: Error) {
    super(`Tx ${txHash} submitted but pending-record persist failed: ${cause.message}`)
  }
}

/** Monotonically increasing counter for `operationId`s — survives hot reload. */
let _operationCounter = 0
const _nextOperationId = (kind: TxKind) => `${kind}_${++_operationCounter}_${Date.now()}`

/**
 * Lets the UI mint the op id at Confirm and pass it through `sendTx` opts, so its row and the
 * wallet's `provingProgress` events share one id.
 */
export function nextOperationId(kind: TxKind): string {
  return _nextOperationId(kind)
}

/**
 * Picks the stub class for kernelless simulation. Both ECDSA curves share one stub: its `is_valid`
 * returns true unconditionally.
 */
export type AlphaAccountType = "alpha" | "schnorr" | "ecdsasecp256k1" | "ecdsasecp256r1"

/**
 * Awaited with the proven tx's hash and its expiry before the node takes it; a rejection sends
 * nothing. `expiresAtMs` is the kernel expiry as {@link txExpiresAtMs} caps it.
 */
export type TxHashCallback = (txHash: string, tx: { expiresAtMs: number }) => Promise<void>

/**
 * When a tx is dead for sure: the kernel's `expirationTimestamp` (UInt64 seconds) capped at 24h
 * from `now`. A missing or absurd kernel value is the cap alone.
 */
export function txExpiresAtMs(kernelExpirationTimestamp?: bigint, now = Date.now()): number {
  const ceilingMs = now + MAX_TX_LIFETIME_MS
  if (kernelExpirationTimestamp === undefined || kernelExpirationTimestamp <= 0n) return ceilingMs
  const kernelMs = Number(kernelExpirationTimestamp) * 1000
  return Number.isFinite(kernelMs) && kernelMs > 0 ? Math.min(kernelMs, ceilingMs) : ceilingMs
}

/** The pinned rollup address, else the node's. */
export async function readNetworkId(
  node: AztecNode,
  opts?: { networkId?: string },
): Promise<string> {
  return opts?.networkId ?? (await node.getNodeInfo()).l1ContractAddresses.rollupAddress.toString()
}

/** Wallet for the alpha (non-modular) account system. Auth is handled by AlphaAuthProvider. */
export class ObsidionWallet extends BaseWallet {
  public accounts: Map<string, Account> = new Map()
  /**
   * Merged under caller opts on every tx wait. The product wallet resolves at PROPOSED; test and
   * backend wallets override to `{}` (CHECKPOINTED) because sdk integration tests share anvil
   * account #0 with the sandbox sequencer's L1 publisher.
   */
  public readonly defaultWaitOpts: WaitOpts = DEFAULT_WAIT_OPTS
  /** address -> account type, for stub selection. Missing addresses default to `'alpha'`. */
  public accountTypes: Map<string, AlphaAccountType> = new Map()

  /** Public so tests can introspect; the store API is the only mutation path. */
  public readonly pendingTxStore: IPendingTxStore

  private readonly pinnedChainInfo: WalletChainInfo | undefined

  /** The rollup's L1 address: the network the wallet's records belong to. */
  constructor(
    public pxe: PXE,
    public node: AztecNode,
    public readonly networkId: string,
    opts?: ObsidionWalletOptions,
  ) {
    super(pxe, node)
    this.pendingTxStore = opts?.pendingTxStore ?? new InMemoryPendingTxStore()
    this.pinnedChainInfo = opts?.chainInfo
  }

  /** The pin as `Fr`s, else the base class's node snapshot; feeds every tx context and authwit. */
  override async getChainInfo(): Promise<ChainInfo> {
    if (!this.pinnedChainInfo) return super.getChainInfo()
    return {
      chainId: new Fr(this.pinnedChainInfo.l1ChainId),
      version: new Fr(this.pinnedChainInfo.rollupVersion),
    }
  }

  /** Whether network fees are above what the ClaimFPC sponsors, so every sponsored tx would fail now. */
  async sponsoredFeesAboveCap(): Promise<boolean> {
    const fees = await this.getMinFees()
    const cap = CLAIM_FPC_MAX_FEES_PER_GAS
    return fees.feePerDaGas > cap.feePerDaGas || fees.feePerL2Gas > cap.feePerL2Gas
  }

  /** The pinned identity as numbers, else the node's; for account builds and link stamps. */
  async getNodeIdentity(): Promise<WalletChainInfo> {
    if (this.pinnedChainInfo) return this.pinnedChainInfo
    const { l1ChainId, rollupVersion } = await this.node.getNodeInfo()
    return { l1ChainId, rollupVersion }
  }

  static async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
    walletOpts?: CreateWalletOptions,
  ): Promise<ObsidionWallet> {
    const networkId = await readNetworkId(node, walletOpts)
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      ...overridePXEConfig,
      // The wallet owns sync cadence (see the manual-sync section). Forced LAST: an override that
      // seeds from `getPXEConfig()` carries `autoSync: true` and would otherwise win.
      autoSync: false,
    })
    // Rollup-keyed default so restarts reuse the cache; tests pass their own for isolation.
    pxeConfig.dataDirectory ??= `pxe-${networkId}`

    const pxe = await createPXELazy(node, pxeConfig, options)
    return new ObsidionWallet(pxe, node, networkId, walletOpts)
  }

  /**
   * Wrap an existing PXE. Only the DI unit tests use this, with stubs. A real PXE injected here
   * should have `autoSync: false`; stubs need a no-op `sync()`.
   */
  static async createWithPXE(
    pxe: PXE,
    node: AztecNode,
    networkId: string,
    walletOpts?: ObsidionWalletOptions,
  ): Promise<ObsidionWallet> {
    return new ObsidionWallet(pxe, node, networkId, walletOpts)
  }

  protected addAccount(
    address: AztecAddress,
    account: Account,
    type: AlphaAccountType = "alpha",
  ): void {
    this.accounts.set(address.toString(), account)
    this.accountTypes.set(address.toString(), type)
  }

  protected async getAccountArtifact(): Promise<ContractArtifact> {
    return ContractService.getInstance().getArtifactForContract(this.getAccountContractName())
  }

  protected getAccountContractName(): ContractName {
    return DEFAULT_CONTRACTS.obsidionAccountAlpha
  }

  protected async getContractManagerOptions(): Promise<AlphaContractManagerOptions> {
    return {
      artifact: await this.getAccountArtifact(),
      contractName: this.getAccountContractName(),
      pxe: this.pxe,
    }
  }

  /**
   * The registered account for the master secret and the provider's passkey set: one shared
   * `ObsidionAccount` per address, with this provider as its signer when the call is the newest
   * for that address (see `acquireAccount`). Rejects when registration fails or when a newer
   * request has installed another signer.
   */
  async createObsidionAccount(
    masterSecretKey: Fr,
    authProvider: AlphaAuthProvider,
    options?: CreateObsidionAccountWalletOptions,
  ) {
    options?.updateStatus?.(`Crafting account...`)
    return this.acquireAccount(masterSecretKey, authProvider, { register: true })
  }

  /**
   * Address from a candidate MSK and a passkey set with no side effects (no PXE registration, no
   * `addAccount`), so recovery can check a candidate against the stored address before committing
   * it. `passkeys` are the 64-byte x‖y keys the account is bound to, in any order.
   */
  public async deriveAccountAddress(
    masterSecretKey: Fr,
    passkeys: readonly string[],
  ): Promise<AztecAddress> {
    const accountContractManager = await ObsidionAccountContractManager.create(
      masterSecretKey,
      await alphaPasskeySet(passkeys),
      await this.getContractManagerOptions(),
    )
    const completeAddress = await accountContractManager.getCompleteAddress()
    return completeAddress.address
  }

  /**
   * The account the master secret and the provider's passkey set derive, built once and shared. The
   * identity is derived before anything is looked up or registered: a stored complete address
   * that the inputs do not reproduce is refused, and never shares another account's build.
   */
  public async getObsidionAccountWallet(
    masterSecretKey: Fr,
    authProvider: AlphaAuthProvider,
    options: GetObsidionAccountWalletOptions,
  ): Promise<ObsidionAccount> {
    return this.acquireAccount(masterSecretKey, authProvider, options)
  }

  /** In-flight account builds by derived address, so concurrent callers for one account share a build. */
  private accountBuilds = new Map<string, Promise<ObsidionAccount>>()
  /** Per derived address, the sequence of the newest request that reached its signer. */
  private signerSequences = new Map<string, number>()
  private requestSequence = 0

  /**
   * One `ObsidionAccount` per address; the provider of the newest request for that address is its
   * signer. The sequence is taken before the first await, so "newest" is call order, not
   * completion order: an older request that resumes after a newer one installed another provider
   * is refused as stale instead of signing with a key its caller did not ask for. A request that
   * fails validation (a refused stored address, a provider whose key is not in its set) or
   * registration never reaches the signer. A registering request awaits the manager's
   * deduplicated registration before the signer decision, so one refused as stale has still
   * registered the account, and a failed registration caches no account.
   */
  private async acquireAccount(
    masterSecretKey: Fr,
    authProvider: AlphaAuthProvider,
    options: GetObsidionAccountWalletOptions,
  ): Promise<ObsidionAccount> {
    const sequence = ++this.requestSequence
    const cmOptions = await this.getContractManagerOptions()
    const passkeySet = await authProvider.getPasskeySet()
    const manager = options.completeAddress
      ? await ObsidionAccountContractManager.createFromCompleteAddress(
          masterSecretKey,
          passkeySet,
          options.completeAddress,
          cmOptions,
        )
      : await ObsidionAccountContractManager.create(masterSecretKey, passkeySet, cmOptions)
    const key = manager.address.toString()

    // Cache and in-flight lookups stay synchronous, so concurrent first requests share one build.
    const existing = this.accounts.get(key)
    let build = this.accountBuilds.get(key)
    if (!build && existing instanceof ObsidionAccount) {
      build = Promise.resolve(existing)
    } else if (!build) {
      const started = (async () => {
        const obsidionAccount = new ObsidionAccount(
          await manager.getCompleteAddress(),
          manager,
          authProvider,
          await this.getNodeIdentity(),
        )
        // A build asked to register is cached only once registered.
        if (options.register) await obsidionAccount.register()
        this.addAccount(manager.address, obsidionAccount)
        return obsidionAccount
      })().finally(() => {
        if (this.accountBuilds.get(key) === started) this.accountBuilds.delete(key)
      })
      this.accountBuilds.set(key, started)
      build = started
    }
    const account = await build
    if (options.register) await account.register()

    // No await between the sequence check and the signer update.
    if (sequence > (this.signerSequences.get(key) ?? 0)) {
      this.signerSequences.set(key, sequence)
      if (account.getAuthProvider() !== authProvider) account.setAuthProvider(authProvider)
    } else if (account.getAuthProvider() !== authProvider) {
      throw new Error(`stale request for account ${key}: a newer request installed another signer`)
    }
    return account
  }

  /** Fails closed: no default fee payer (a sponsor FPC is drainable on mainnet). */
  async getDefaultSendOptions(
    _from: AztecAddress,
    _options?: FeePaymentOptions,
  ): Promise<SendInteractionOptions> {
    throw new FeeUnavailableError()
  }

  // TODO: use this with the simulation results
  protected async getGasSettings(): Promise<GasSettings> {
    // Block base fee, not the min-fee floor, or the tx is dropped as underpriced.
    const maxFeesPerGas = (await getBlockBaseMaxFees(this.node)).mul(FEE_MULTIPLIER)
    // gasLimits = the network's per-tx admission limit.
    const { txsLimits } = await this.node.getNodeInfo()
    const settings = GasSettings.fallback({
      maxFeesPerGas,
      gasLimits: Gas.from(txsLimits.gas),
    })
    return settings
  }

  public async getAccountFromAddress(address: AztecAddress): Promise<Account> {
    const account = this.accounts.get(address?.toString() ?? "")
    if (!account) {
      throw new Error(`Account not found in wallet for address: ${address}`)
    }
    return account
  }

  public async getAccounts(): Promise<Aliased<AztecAddress>[]> {
    return Array.from(this.accounts.values()).map((account) => ({
      alias: account.getAddress().toString(),
      item: account.getAddress(),
    }))
  }

  /**
   * Two legs in parallel, merged back into call order: leading public-static calls go straight to
   * `node.simulatePublicCalls`; the rest run through the stub-account entrypoint with the sender's
   * class overridden, so PXE skips kernels. Authwits pass through unchecked (the stub's
   * `verify_private_authwit` always returns valid).
   */
  override async simulateTx(
    executionPayload: ExecutionPayload,
    opts: SimulateInteractionOptions,
  ): Promise<TxSimulationResultWithAppOffset> {
    // `sendTx` calls `simulateTxAssumingSynced` directly under its own single sync.
    await this.syncPXEUnlessPinned()
    return this.simulateTxAssumingSynced(executionPayload, opts)
  }

  /** `simulateTx` without the entry sync. The caller owns freshness. */
  private async simulateTxAssumingSynced(
    executionPayload: ExecutionPayload,
    opts: SimulateInteractionOptions,
    forEstimation = false,
  ): Promise<TxSimulationResultWithAppOffset> {
    const feeOptions = await this.completeFeeOptions({
      from: opts.from,
      feePayer: executionPayload.feePayer,
      gasSettings: opts.fee?.gasSettings,
      forEstimation,
    })

    // NO_FROM has no sender for the public-static fast path; everything goes through the entrypoint.
    const { optimizableCalls, remainingCalls } =
      opts.from === NO_FROM
        ? { optimizableCalls: [], remainingCalls: executionPayload.calls }
        : extractOptimizablePublicStaticCalls(executionPayload)
    const remainingPayload: ExecutionPayload = {
      ...executionPayload,
      calls: remainingCalls,
    }

    // PXE's synced header, or the node's on cold start.
    const chainInfo = await this.getChainInfo()
    let blockHeader
    try {
      blockHeader = await this.pxe.getSyncedBlockHeader()
    } catch {
      blockHeader = (await this.node.getBlockData("latest"))?.header
    }
    if (!blockHeader) {
      throw new Error("Could not resolve a block header for simulation")
    }

    const [optimizedResults, normalResult] = await Promise.all([
      optimizableCalls.length > 0
        ? simulateViaNode(
            this.node,
            optimizableCalls,
            // Never NO_FROM here: optimizableCalls is empty for it.
            opts.from as AztecAddress,
            chainInfo,
            feeOptions.gasSettings,
            blockHeader,
            opts.skipFeeEnforcement ?? true,
            this.getContractName.bind(this),
          )
        : Promise.resolve([]),
      remainingCalls.length > 0
        ? opts.from === NO_FROM
          ? // No sender account to stub; upstream's DefaultEntrypoint.
            this.simulateViaEntrypoint(remainingPayload, {
              from: opts.from,
              feeOptions,
              additionalScopes: opts.additionalScopes,
              skipTxValidation: opts.skipTxValidation ?? true,
              skipFeeEnforcement: opts.skipFeeEnforcement ?? true,
              sendMessagesAs: opts.sendMessagesAs,
            })
          : this.simulateViaStubEntrypoint(remainingPayload, {
              from: opts.from,
              feeOptions,
              additionalScopes: opts.additionalScopes,
              skipTxValidation: opts.skipTxValidation ?? true,
              skipFeeEnforcement: opts.skipFeeEnforcement ?? true,
              sendMessagesAs: opts.sendMessagesAs,
            })
        : Promise.resolve(null),
    ])

    return buildMergedSimulationResult(optimizedResults, normalResult)
  }

  /**
   * Stub-account txRequest simulated with the sender's class re-pointed to the simulated stub. Do
   * not pass `skipKernels: false`: PXE rejects contract overrides with kernel execution.
   */
  protected async simulateViaStubEntrypoint(
    executionPayload: ExecutionPayload,
    opts: {
      from: AztecAddress
      feeOptions: FeeOptions
      additionalScopes?: AztecAddress[]
      skipTxValidation: boolean
      skipFeeEnforcement: boolean
      sendMessagesAs?: AztecAddress
    },
  ): Promise<TxSimulationResultWithAppOffset> {
    const {
      from,
      feeOptions,
      additionalScopes,
      skipTxValidation,
      skipFeeEnforcement,
      sendMessagesAs,
    } = opts

    const feeExecutionPayload = await feeOptions.walletFeePaymentMethod?.getExecutionPayload()
    const finalExecutionPayload = feeExecutionPayload
      ? mergeExecutionPayloads([feeExecutionPayload, executionPayload])
      : executionPayload

    const scopes = this.scopesFrom(from, additionalScopes ?? [], sendMessagesAs)
    const overrides = await this.buildAccountOverrides(scopes)

    const stubAccount = await this.createStubAccount(from)
    const executionOptions: DefaultAccountEntrypointOptions = {
      txNonce: Fr.random(),
      feePaymentMethodOptions:
        feeOptions.accountFeePaymentMethodOptions ?? AccountFeePaymentMethodOptions.EXTERNAL,
    }
    const txRequest = await stubAccount.createTxExecutionRequest(
      finalExecutionPayload,
      feeOptions.gasSettings,
      await this.getChainInfo(),
      executionOptions,
    )

    const result = await this.pxe.simulateTx(txRequest, {
      simulatePublic: true,
      skipTxValidation,
      skipFeeEnforcement,
      overrides,
      scopes,
      senderForTags: this.senderForTagsFrom(from, sendMessagesAs),
    })

    const appCallOffset = (feeExecutionPayload?.calls.length ?? 0) + 1
    return TxSimulationResultWithAppOffset.fromResultAndOffset(result, appCallOffset)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Manual PXE sync
  //
  // The PXE runs with `autoSync: false`; the wallet syncs on demand:
  //   - `sendTx`: one sync covering pre-simulation, finalize and proving.
  //   - `simulateTx` and the read paths below: one sync on entry, unless a send is in flight.
  //   - proves outside `sendTx` (test wallets): `proveTxWithProgress`'s `sync` flag.
  // No boot-time sync.
  //
  // ANCHOR PIN: adopting a newer anchor block wipes the PXE's contract-sync cache and forces the
  // next execution to re-run full note discovery (tens of seconds on a populated account). It
  // also re-opens the sim-vs-attestation drift window the single send sync closes. So while a
  // send is in flight, reads skip their sync and execute at the send's anchor — at most one
  // send-duration stale, fine for balances, events and profiling. Snapshots run one at a time and
  // hold reads' syncs the same way, so no read moves the anchor a snapshot checks.
  // ────────────────────────────────────────────────────────────────────────

  /** In-flight `sendTx` count. A depth only as re-entrancy hygiene; sends are single-flight. */
  private anchorPinDepth = 0
  /** A snapshot is reading. Unlike a send's pin, it never blocks a send. */
  private snapshotHeld = false
  private snapshots: Promise<unknown> = Promise.resolve()

  private async syncPXEUnlessPinned(): Promise<void> {
    if (this.anchorPinDepth > 0 || this.snapshotHeld) {
      return
    }
    await this.pxe.sync()
  }

  override async executeUtility(
    call: FunctionCall,
    opts: ExecuteUtilityOptions,
  ): Promise<UtilityExecutionResult> {
    await this.syncPXEUnlessPinned()
    return super.executeUtility(call, opts)
  }

  /** Utility read at the current anchor, no entry sync. For callers that just synced. */
  executeUtilityAssumingSynced(
    call: FunctionCall,
    opts: ExecuteUtilityOptions,
  ): Promise<UtilityExecutionResult> {
    return super.executeUtility(call, opts)
  }

  /**
   * Events plus a projection on one sync. Throws if the anchor moved in between (a send's entry
   * sync can advance PXE); callers retry rather than publish mixed state. `assumeSynced` skips the
   * entry sync, for a caller reading several ranges at the anchor its first read adopted.
   */
  async getPrivateEventsSnapshot<T, P>(
    eventDef: EventMetadataDefinition,
    eventFilter: PrivateEventFilter,
    readProjection: () => Promise<P>,
    opts: { assumeSynced?: boolean } = {},
  ): Promise<{ events: PrivateEvent<T>[]; projection: P; anchorBlock: number }> {
    const { value, anchorBlock } = await this.readAtOneAnchor(async () => {
      const events = await super.getPrivateEvents<T>(eventDef, eventFilter)
      return { events, projection: await readProjection() }
    }, opts)
    return { ...value, anchorBlock }
  }

  /** `read` on one sync, with the anchor it ran at. Throws like `getPrivateEventsSnapshot`. */
  async getSnapshot<P>(read: () => Promise<P>): Promise<{ value: P; anchorBlock: number }> {
    return this.readAtOneAnchor(read, {})
  }

  /** Queued behind any snapshot in flight, so each one's entry sync follows the call. */
  private readAtOneAnchor<P>(
    read: () => Promise<P>,
    opts: { assumeSynced?: boolean },
  ): Promise<{ value: P; anchorBlock: number }> {
    const turn = this.snapshots.then(() => this.readHeld(read, opts))
    this.snapshots = turn.catch(() => {})
    return turn
  }

  private async readHeld<P>(
    read: () => Promise<P>,
    opts: { assumeSynced?: boolean },
  ): Promise<{ value: P; anchorBlock: number }> {
    // Held before the entry sync: a sync queued earlier lands before it, none can start after it.
    this.snapshotHeld = true
    try {
      if (!opts.assumeSynced && this.anchorPinDepth === 0) await this.pxe.sync()
      const before = await this.pxe.getSyncedBlockHeader()
      const beforeHash = (await before.hash()).toString()
      const value = await read()
      const after = await this.pxe.getSyncedBlockHeader()
      if ((await after.hash()).toString() !== beforeHash) {
        throw new Error("PXE anchor changed during wallet snapshot; retry the read")
      }
      return { value, anchorBlock: Number(before.globalVariables.blockNumber) }
    } finally {
      this.snapshotHeld = false
    }
  }

  override async getPrivateEvents<T>(
    eventDef: EventMetadataDefinition,
    eventFilter: PrivateEventFilter,
  ): Promise<PrivateEvent<T>[]> {
    await this.syncPXEUnlessPinned()
    return super.getPrivateEvents(eventDef, eventFilter)
  }

  override async profileTx(
    executionPayload: ExecutionPayload,
    opts: ProfileOptions,
  ): Promise<TxProfileResult> {
    await this.syncPXEUnlessPinned()
    return super.profileTx(executionPayload, opts)
  }

  /**
   * Drives provingProgress events around the upstream send.
   *
   * Emits: reset on entry; Simulating right before `pxe.proveTx` (inside `proveTxWithProgress`;
   * Witgen/Proving come only from an injected prover that emits them); Mining after
   * `toTx()` and right before `aztecNode.sendTx`.
   *
   * Builds, proves and submits inside `withProvingScope`. Persist happens after a successful
   * submit, so a submit error has nothing to clean up.
   */
  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W> & {
      operationId?: string
      /** Flow that originated the tx; threaded to op-id minting, scope and pending record. Defaults to `"send"`. */
      kind?: OriginalFlowKind
      /**
       * Staged execution (`stagedExecution.ts`): the given payload is only simulated; the
       * finalizer's payload is what gets proven and persisted. Gas limits become
       * `estimate(pre-sim) + gasDelta`, checked against the proven tx before submit. Producer:
       * `buildTeeOperation`.
       */
      finalize?: PayloadFinalizer
      /**
       * Lazy-start gate. Sync, pre-simulation, finalize, estimation and zero-witness authwit
       * capture run before it (node + TEE, no passkey, no scope, no submit); everything after
       * blocks on it. Reject with an AbortError to abort before signing.
       */
      confirmGate?: Promise<unknown>
      onTxHash?: TxHashCallback
    },
  ): Promise<SendReturn<W>> {
    // Read before the entry sync: the sync is the first timed phase.
    const timingBench = readTimingBenchFlag()

    // Single-flight for the pin's whole lifetime. A second send that starts here re-selects the
    // notes the first is spending; the chain then rejects it with "Existing nullifier".
    // withProvingScope cannot close that window — it is entered only after sync, simulation,
    // finalize, and confirmGate.
    if (this.anchorPinDepth > 0) {
      const err = new Error("Another transaction is still in progress")
      err.name = "LocalProvingInFlight"
      throw err
    }

    // Pin before the entry sync so no unpinned await exists in the send. Released exactly once on
    // every exit path.
    this.anchorPinDepth++
    let pinReleased = false
    const releaseAnchorPin = (): void => {
      if (!pinReleased) {
        pinReleased = true
        this.anchorPinDepth--
      }
    }

    // THE sync for the whole send: pre-simulation, finalize (TEE attestation) and proving all
    // execute at this anchor.
    let entrySyncMs = 0
    try {
      const t_entrySync = timingBench ? benchNow() : 0
      await this.pxe.sync()
      entrySyncMs = timingBench ? benchNow() - t_entrySync : 0
    } catch (err) {
      releaseAnchorPin()
      throw err
    }

    // NO_FROM sends (FPC-sponsored batches, signerless deploys) ride the same pipeline: both
    // `simulateTxAssumingSynced` and `buildSendRequest` dispatch to upstream's DefaultEntrypoint.
    // Only pending-record persistence is skipped for them.

    const proveTxPerfLogs = readPerfLogFlag()
    let simulationMs = 0
    let simFunctions: ReturnType<typeof extractSimFunctions>

    const t_total_start = Date.now()

    // Resolved before the scope so the stage emits below and the scope itself share one id.
    // A caller-supplied id wins, so the UI row and the wallet emit the same one.
    const flowKind: OriginalFlowKind = opts.kind ?? "send"
    const opId: string = opts.operationId ?? _nextOperationId(flowKind)

    try {
      // Inside the try: a throwing listener must not leak the pin.
      provingProgress.emitReset()

      if (timingBench) {
        // Bench-only anchor-drift probe; compared against the proven anchor below.
        let simAnchorBlock = "?"
        try {
          const h = await this.pxe.getSyncedBlockHeader()
          simAnchorBlock = h.globalVariables.blockNumber.toString()
        } catch {
          /* bench-only; ignore */
        }
        this.log.info(
          `[LazySim] sendTx entry op=${opId} confirmGate=${
            opts.confirmGate !== undefined
          } simAnchorBlock=${simAnchorBlock}`,
        )
      }

      let feeOptions = await this.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: opts.fee?.gasSettings,
      })

      // ─── (0) Kernelless pre-simulation ──────────────────────────────────
      // Yields the authwits contract code requested via `emit_offchain_effect` and the exact gas
      // the prove will use (padding 0: gas is deterministic per call). Caller-supplied limits still
      // win.
      const t_simulation = timingBench || proveTxPerfLogs ? benchNow() : 0
      const simResult = await this.simulateTxAssumingSynced(
        executionPayload,
        {
          from: opts.from,
          additionalScopes: opts.additionalScopes,
          sendMessagesAs: opts.sendMessagesAs,
          skipTxValidation: true,
          skipFeeEnforcement: true,
          // Caller-declared limits bind estimation too: FPC max-fee checks reject the estimation
          // defaults, which sit an order of magnitude above any real tx.
          fee: opts.fee,
        },
        // Estimation pass: completeFeeOptions loosens gas for the sim.
        true,
      )
      if (timingBench || proveTxPerfLogs) simulationMs = benchNow() - t_simulation
      if (timingBench) {
        try {
          simFunctions = extractSimFunctions(simResult.stats?.timings)
        } catch {
          simFunctions = undefined
        }
      }

      const offchainEffects = collectOffchainEffects(simResult.privateExecutionResult)
      const capturedWitnesses = await Promise.all(
        offchainEffects.map(async (effect) => {
          try {
            const req = await CallAuthorizationRequest.fromFields(effect.data)
            return await this.createAuthWit(req.onBehalfOf, {
              consumer: effect.contractAddress,
              innerHash: req.innerHash,
            })
          } catch {
            // Other offchain effects (e.g. paylink ciphertexts) fail `fromFields`; not ours.
            return undefined
          }
        }),
      )
      // ─── (0b) Staged finalize ───────────────────────────────────────────
      // Runs outside `withProvingScope`: a throw here is a plain rejection with no terminal emit.
      let effectivePayload = executionPayload
      let declaredDeltaGas = Gas.empty()
      if (opts.finalize) {
        const finalized = await opts.finalize(simResult)
        // Fee options were derived from the simulated feePayer and are not recomputed.
        const simFeePayer = executionPayload.feePayer
        const finalFeePayer = finalized.payload.feePayer
        const feePayerMatches =
          simFeePayer === undefined || finalFeePayer === undefined
            ? simFeePayer === finalFeePayer
            : simFeePayer.equals(finalFeePayer)
        if (!feePayerMatches) {
          throw new Error(
            `sendTx finalize: finalized payload feePayer (${
              finalFeePayer?.toString() ?? "none"
            }) ` + `differs from the simulated payload's (${simFeePayer?.toString() ?? "none"})`,
          )
        }
        effectivePayload = finalized.payload
        if (finalized.gasDelta) {
          const { daGas, l2Gas } = finalized.gasDelta
          // Sanity only; the kernel tail and the pre-submit guard enforce correctness.
          if (
            !Number.isSafeInteger(daGas) ||
            !Number.isSafeInteger(l2Gas) ||
            daGas < 0 ||
            l2Gas < 0
          ) {
            throw new Error(
              `sendTx finalize: invalid gasDelta (da=${daGas}, l2=${l2Gas}) — must be non-negative integers`,
            )
          }
          declaredDeltaGas = finalized.gasDelta
        }
      }

      // Dedupe by requestHash: the same payload is reused across retries, and a duplicate authwit
      // shifts `intentHashes` out of step with the entrypoint capsule. On the staged path the
      // witnesses came from the preparatory payload but belong to the finalized one; the emitting
      // calls are identical in both.
      for (const aw of capturedWitnesses) {
        if (
          aw &&
          !effectivePayload.authWitnesses.some((existing) =>
            existing.requestHash.equals(aw.requestHash),
          )
        ) {
          effectivePayload.authWitnesses.push(aw)
        }
      }

      // Limits = simulation estimate + finalizer-declared delta (the finalized payload's extra
      // consumption was never simulated). Caller-supplied limits win wholesale.
      const { txsLimits } = await this.node.getNodeInfo()
      const estimated = getGasLimits(simResult.gasUsed, Gas.from(txsLimits.gas), 0)
      const accurateGasSettings = GasSettings.from({
        ...feeOptions.gasSettings,
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits.add(declaredDeltaGas),
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
      })
      feeOptions = { ...feeOptions, gasSettings: accurateGasSettings }

      // ─── Confirm gate ──────────────────────────────────────────────────
      // Nothing below (passkey sign, prove, submit) runs until it resolves.
      if (opts.confirmGate) {
        const t_gate = timingBench ? benchNow() : 0
        if (timingBench) {
          this.log.info(
            `[LazySim] gate reached op=${opId} preConfirmMs=${Math.round(
              entrySyncMs + simulationMs,
            )} (sync+sim; awaiting user confirm before sign/prove/submit)`,
          )
        }
        try {
          await opts.confirmGate
        } catch (gateErr) {
          if (timingBench) {
            this.log.info(
              `[LazySim] gate rejected op=${opId} gateWaitMs=${Math.round(
                benchNow() - t_gate,
              )} reason=${(gateErr as Error)?.name ?? "unknown"}`,
            )
          }
          throw gateErr
        }
        if (timingBench) {
          this.log.info(
            `[LazySim] gate resolved op=${opId} gateWaitMs=${Math.round(
              benchNow() - t_gate,
            )} — proceeding to sign/prove/submit`,
          )
        }
      }

      // ─── Sign, prove, submit ────────────────────────────────────────────
      const t_pre_prove_start = Date.now()
      const txNonce = Fr.random()
      const txRequest = await this.buildSendRequest(
        effectivePayload,
        opts.from,
        feeOptions,
        txNonce,
      )
      const pre_prove_ms = Date.now() - t_pre_prove_start

      const scopeResult = await this.withProvingScope(
        async () => {
          const provenTx = await proveTxWithProgress(
            this.pxe,
            txRequest,
            {
              scopes: this.scopesFrom(opts.from, opts.additionalScopes ?? [], opts.sendMessagesAs),
              senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
            },
            { perfLog: proveTxPerfLogs, logger: this.log },
          )
          const proveTimings = proveTxPerfLogs ? provenTx.stats?.timings : undefined
          // Prove-side benchmark scalars, read+cached in-process BEFORE
          // `toTx()` so a benchmarked sample never depends on post-prove
          // transforms; contributed to the registry after a successful submit.
          // Defensive: extraction must never throw into the send path — a
          // malformed/unexpected stats shape degrades to `null` (incomplete).
          let benchProveScalars: ReturnType<typeof extractProveTimings> = null
          if (timingBench) {
            try {
              benchProveScalars = extractProveTimings(provenTx.stats?.timings)
            } catch {
              benchProveScalars = null
            }
          }

          // The sequencer would reject an over-limit tx anyway; failing here is free and the
          // message says whether to suspect the finalizer or estimation drift.
          assertProvenGasWithinLimits(
            provenTx.publicInputs.gasUsed,
            feeOptions.gasSettings.gasLimits,
            opts.finalize
              ? "Staged send: the finalizer's gasDelta likely under-declares what the finalized payload consumes."
              : "The simulation-derived estimate diverged from proving (PXE state may have changed between the two).",
          )

          if (timingBench) {
            // Bench-only probes. Anchor: with autoSync off the proven anchor always equals the sim
            // anchor, so chainTip (a plain RPC read) is the witness that a block crossed the window
            // and the pin held. Nullifiers: index 0 is poseidon2([tx_nonce]) and always differs;
            // matching spent-note nullifiers across runs mean same-note re-selection.
            let chainTip = "?"
            try {
              chainTip = (await this.aztecNode.getBlockNumber()).toString()
            } catch {
              /* bench-only; ignore */
            }
            this.log.info(
              `[LazySim] proven anchor op=${opId} provenAnchorBlock=${provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.blockNumber.toString()} chainTip=${chainTip}`,
            )

            try {
              const nullifiers = provenTx.publicInputs
                .getNonEmptyNullifiers()
                .map((n) => n.toString())
              this.log.info(
                `[LazySim] proven nullifiers op=${opId} count=${
                  nullifiers.length
                } [${nullifiers.join(", ")}]`,
              )
            } catch {
              /* bench-only; ignore */
            }
          }

          const offchainOutput = extractOffchainOutput(
            provenTx.getOffchainEffects(),
            provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
          )
          const tx = await provenTx.toTx()
          const txHash = tx.getTxHash()
          if (await this.aztecNode.getTxEffect(txHash)) {
            throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`)
          }
          await opts.onTxHash?.(txHash.toString(), {
            expiresAtMs: txExpiresAtMs(provenTx.publicInputs.expirationTimestamp),
          })

          // The op id and the client-side txHash let the caller stamp the real hash on its row
          // before submit (`trackSubmission`), without waiting for the post-mining patch.
          provingProgress.emitStageStart(ProvingStage.Mining, opId, txHash.toString())
          this.log.debug(`Sending transaction ${txHash}`)

          await this.aztecNode.sendTx(tx).catch((err) => {
            throw this.contextualizeError(err, inspect(tx))
          })
          this.log.info(`Sent transaction ${txHash}`)

          // Only after a successful submit (a persist-error tx is still on-chain, so before the
          // persist). Gated on staged sends with a caller id, symmetric with the finalizer's
          // `contributeTee`: anything else would mint a never-finalizable orphan.
          if (timingBench && opts.finalize && opts.operationId) {
            benchmarkRegistry.contributeProve(opId, {
              flow: flowKind,
              sync: entrySyncMs + (benchProveScalars?.sync ?? 0),
              simulation: simulationMs,
              userWitgen: benchProveScalars?.userWitgen ?? 0,
              kernelWitgen: benchProveScalars?.kernelWitgen ?? 0,
              proving: benchProveScalars?.proving ?? 0,
              unaccounted: benchProveScalars?.unaccounted ?? 0,
              incomplete: benchProveScalars === null,
              simFunctions,
            })
          }

          // The record is what lets the lifecycle flip the activity row to mined or dropped. NO_FROM
          // (sponsored batches, signerless deploys) has no activity row to flip.
          if (opts.from !== NO_FROM) {
            try {
              await this.persistPendingRecord(
                txHash.toString(),
                provenTx.publicInputs.expirationTimestamp,
              )
            } catch (persistErr) {
              throw new SubmittedPendingRecordPersistError(
                txHash.toString(),
                persistErr instanceof Error ? persistErr : new Error(String(persistErr)),
              )
            }
          }

          return { txHash, offchainOutput, proveTimings }
        },
        flowKind,
        { operationId: opId },
      )

      const { txHash, offchainOutput, proveTimings } = scopeResult

      if (proveTxPerfLogs) {
        // A malformed stats shape must not fail a submitted send.
        try {
          this.log.info(
            formatProveTxPerfLine({
              preProveMs: pre_prove_ms,
              simulationMs,
              proveTimings,
              totalMs: Date.now() - t_total_start,
            }),
          )
        } catch {
          /* perf log only */
        }
      }

      if (opts.wait === NO_WAIT) {
        return { txHash, ...offchainOutput } as SendReturn<W>
      }

      const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined
      const receipt = await waitForTx(this.aztecNode, txHash, {
        ...this.defaultWaitOpts,
        ...waitOpts,
      })
      provingProgress.emitStageComplete(ProvingStage.Mining, opId)

      if (receipt.isMined() && receipt.debugLogs?.length) {
        await displayDebugLogs(receipt.debugLogs, this.getContractName.bind(this))
      }

      return { receipt, ...offchainOutput } as SendReturn<W>
    } catch (err) {
      provingProgress.emitReset()
      throw err
    } finally {
      // Also covers a `wait`-ful caller's `waitForTx`.
      releaseAnchorPin()
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Proving scope: one registered proving operation at a time
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Run `fn` in a fresh `ProvingOperationContext`, so stage events carry this operation's id.
   * Throws `LocalProvingInFlight` if one is already registered. The context is cleared on exit.
   */
  public async withProvingScope<T>(
    fn: (ctx: ProvingOperationContext) => Promise<T>,
    kind: TxKind,
    opts?: { operationId?: string },
  ): Promise<T> {
    const ctx: ProvingOperationContext = {
      operationId: opts?.operationId ?? _nextOperationId(kind),
      kind,
    }
    provingProgress.registerOperationContext(ctx)
    try {
      return await fn(ctx)
    } finally {
      const live = provingProgress.getCurrentOperationContext()
      if (live && live.operationId === ctx.operationId) {
        provingProgress.clearOperationContext()
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // sendTx helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Builds the tx request for `sendTx`. NO_FROM (FPC-sponsored batches, signerless deploys)
   * delegates to upstream: no account means no txNonce option. The account path mirrors upstream
   * with an explicit `txNonce` (upstream hard-codes `Fr.random()`).
   */
  private async buildSendRequest(
    executionPayload: ExecutionPayload,
    from: AztecAddress | typeof NO_FROM,
    feeOptions: FeeOptions,
    txNonce: Fr,
  ): Promise<TxExecutionRequest> {
    if (from === NO_FROM) {
      const txRequest = await super.createTxExecutionRequestFromPayloadAndFee(
        executionPayload,
        NO_FROM,
        feeOptions,
      )
      return txRequest
    }

    const feeExecutionPayload = await feeOptions.walletFeePaymentMethod?.getExecutionPayload()
    const finalExecutionPayload = feeExecutionPayload
      ? mergeExecutionPayloads([feeExecutionPayload, executionPayload])
      : executionPayload
    const chainInfo = await this.getChainInfo()

    const fromAccount = await this.getAccountFromAddress(from)
    const executionOptions: DefaultAccountEntrypointOptions = {
      txNonce,
      feePaymentMethodOptions:
        feeOptions.accountFeePaymentMethodOptions ?? AccountFeePaymentMethodOptions.EXTERNAL,
    }
    return await fromAccount.createTxExecutionRequest(
      finalExecutionPayload,
      feeOptions.gasSettings,
      chainInfo,
      executionOptions,
    )
  }

  /** Once the expiry lapses the tx is dead on chain and the record must go too. */
  private async persistPendingRecord(
    txHash: string,
    kernelExpirationTimestamp?: bigint,
  ): Promise<void> {
    const submittedAt = Date.now()
    const record: PendingTxRecord = {
      txHash,
      expiresAtMs: txExpiresAtMs(kernelExpirationTimestamp, submittedAt),
      submittedAt,
    }
    await this.pendingTxStore.create(record)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Kernelless-simulation stubs
  //
  // Each registered account's class is re-pointed to a stub in `SimulationOverrides`, so PXE
  // dispatches the entrypoint against stripped validation and (with `skipKernels: true`) skips the
  // signature circuit. Stubs: our `ObsidionAccountAlphaSimulated` for alpha (Noir source under
  // `packages/contracts/contracts/alpha/alpha_account_simulated/`), upstream's schnorr and ecdsa
  // stubs for the rest.
  // ────────────────────────────────────────────────────────────────────────

  private stubClassIds: Map<AlphaAccountType, Fr> = new Map()

  private stubArtifacts: Map<AlphaAccountType, ContractArtifact> = new Map()

  /** Single-flight so concurrent first simulations do not each register every stub. */
  private stubClassesInitPromise: Promise<void> | undefined

  /** Registers the stub artifacts with PXE and caches their class ids. Idempotent; lazy. */
  protected async initStubClasses(): Promise<void> {
    if (this.stubClassIds.size > 0) return
    if (this.stubClassesInitPromise) return this.stubClassesInitPromise

    // The id costs a full class hash, and so does registering. A PXE that kept the class from an
    // earlier session is not asked to hash it again.
    const registerStub = async (artifact: ContractArtifact) => {
      const { id } = await getContractClassFromArtifact(artifact)
      if (!(await this.pxe.getContractArtifact(id))) await this.pxe.registerContractClass(artifact)
      return id
    }

    this.stubClassesInitPromise = (async () => {
      // Alpha and alpha-test share the artifact: they differ only in signature scheme.
      const alphaArtifact = await getSimulatedAlphaAccountArtifact()
      const alphaId = await registerStub(alphaArtifact)
      this.stubArtifacts.set("alpha", alphaArtifact)
      this.stubClassIds.set("alpha", alphaId)

      const schnorrArtifact = await getStubSchnorrAccountContractArtifact()
      const schnorrId = await registerStub(schnorrArtifact)
      this.stubArtifacts.set("schnorr", schnorrArtifact)
      this.stubClassIds.set("schnorr", schnorrId)

      const ecdsaArtifact = await getStubEcdsaAccountContractArtifact()
      const ecdsaId = await registerStub(ecdsaArtifact)
      this.stubArtifacts.set("ecdsasecp256k1", ecdsaArtifact)
      this.stubArtifacts.set("ecdsasecp256r1", ecdsaArtifact)
      this.stubClassIds.set("ecdsasecp256k1", ecdsaId)
      this.stubClassIds.set("ecdsasecp256r1", ecdsaId)
    })()

    try {
      await this.stubClassesInitPromise
    } catch (err) {
      // Let the next caller retry instead of poisoning the cache.
      this.stubClassesInitPromise = undefined
      throw err
    }
  }

  /**
   * Overrides for the tagged accounts among `addresses` only. Non-account scopes (e.g. paylink
   * contracts) lack the entrypoint selectors and would fail mid-simulation; addresses PXE does not
   * know yet (first-tx setup) are skipped so the simulation still runs.
   */
  protected async buildAccountOverrides(addresses: AztecAddress[]): Promise<SimulationOverrides> {
    if (addresses.length === 0) {
      return new SimulationOverrides({})
    }

    await this.initStubClasses()
    const contracts: ContractOverrides = {}

    for (const address of addresses) {
      const type = this.accountTypes.get(address.toString())
      if (!type) continue
      const instance = await this.pxe.getContractInstance(address)
      if (!instance) continue
      const stubClassId = this.stubClassIds.get(type)
      const stubArtifact = this.stubArtifacts.get(type)
      if (!stubClassId || !stubArtifact) continue
      contracts[address.toString()] = {
        instance: {
          ...instance,
          currentContractClassId: stubClassId,
        },
      }
    }

    return new SimulationOverrides({ contracts })
  }

  /** Stub `BaseAccount` for the address's tagged type, so the caller just calls `createTxExecutionRequest`. */
  protected async createStubAccount(from: AztecAddress): Promise<BaseAccount> {
    const realAccount = await this.getAccountFromAddress(from)
    const completeAddress = realAccount.getCompleteAddress()
    const type = this.accountTypes.get(from.toString()) ?? "alpha"

    if (type === "alpha") {
      const stubAuth = new StubAlphaAuthProvider()
      const entrypoint = new ObsidionAccountEntrypoint(from, stubAuth)
      return new BaseAccount(entrypoint, stubAuth, completeAddress)
    }
    if (type === "schnorr") {
      return createStubSchnorrAccount(completeAddress)
    }
    return createStubEcdsaAccount(completeAddress)
  }
}

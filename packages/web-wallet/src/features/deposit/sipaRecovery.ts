import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
/**
 * The `recoverERC20` / `recoverETH` exit in the browser: pulls a SIPA deposit the sweep path can
 * never move back out to an L1 address the user controls. front-core's `runSipaRecovery` owns the key derivation,
 * the signature and the store write; this file supplies the browser collaborators — an L1
 * submission channel and the pre-submit balance read that stops a recovery from settling a record
 * it never moved.
 *
 * Two channels, because the desktop launcher's Chrome profile carries no wallet extension:
 * an injected wallet both pays the gas and receives the funds, while the launcher hands the
 * prepared transaction to a helper page in the user's default browser and the funds go to an
 * address the user types (any EOA can submit — only `target` is paid).
 */
import {
  erc20Abi,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem"
import {
  claimRefusalReason,
  createRegistrationSipaDeriver,
  depositAmounts,
  isNameBlocked,
  isNameReserved,
  deriveStealthKey,
  isStuckSweep,
  deriveBootstrapKey,
  createOxideL1Reader,
  signAccountDigest,
  runSipaRecovery,
  STUCK_SWEEP_MS,
  sipaDeployArgCandidates,
  SIPADepositStore,
  type SIPADepositRecord,
  type SipaRecoverCandidate,
  type SipaRecoveryDeps,
  isNativeEth,
  isSettledSipaPhase,
  NATIVE_ETH,
  type SipaFundingToken,
} from "@obsidion/front-core"
import {
  predictAccountAddress,
  encodeAccountInitCode,
  detectHistoricDeployments,
  readDepositSIPAImplementation,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig, l1ChainFor, type WebWalletConfig } from "../../config/env"
import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import { registrationRefundConfirmed } from "../onboarding/registrationQuoteRecovery"
import { healRegistrationDeposits } from "../onboarding/registrationDepositSeed"
import { seedRederivedRegistrations } from "../onboarding/registrationRederive"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { registrationRecordForSipa } from "../onboarding/webRegistration"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { isDesktopL1SubmitActive, submitViaDesktopBridge } from "../../platform/desktopBridge"
import { WebStorageAdapter } from "../../platform/storage/WebStorageAdapter"
import { getL1Clients } from "./l1Wallet"
import { EmptyDepositError } from "./depositReadErrors"
import { AlreadySweptError, readSipaDeployed, UNTRACKED_TOKEN_ZERO } from "./sipaSweep"
import { predictSipaCandidate } from "./sipaPredict"
import { recoveryProbeTokens } from "./loadDepositFacts"

/** The stuck-sweep clock the activity feed and both exits share. */
export { isStuckSweep, STUCK_SWEEP_MS }


/** Progress of one L1 submission — shared by both exits. */
export type L1ExitStage = "signing" | "awaiting-browser" | "confirming"

/** Who the transaction pays and how it reaches L1. Shared by the recovery and self-sweep exits. */
export interface L1ExitChannel {
  /** Receives the recovered funds, the deposit fee on a self-sweep, or a finalize's relayer tip. */
  target: Address
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>
  /** False on a reverted transaction. */
  waitForReceipt: (hash: Hex) => Promise<boolean>
}

export interface RecoveryDeps {
  channel: L1ExitChannel
  chainId: number
  /** Every token any row of the table accepts, the manifest token first. */
  tokens: [SipaFundingToken, ...SipaFundingToken[]]
  readBalance: (sipa: Address, token: Address) => Promise<bigint>
  readEthBalance: (sipa: Address) => Promise<bigint>
  /** A confirmed recovery's receipt, for what it moved. */
  readReceipt: (hash: Hex) => Promise<TransactionReceipt>
  /** Deploy capability for an undeployed SIPA (see `SipaRecoveryDeps.deployment`). */
  deployment: SipaRecoveryDeps["deployment"]
  store: Pick<SIPADepositStore, "get" | "upsert" | "update">
  stealthKey: () => Promise<SipaRecoveryDeps["stealthKey"]>
  signAccount?: SipaRecoveryDeps["signAccount"]
  accountInitCode?: Hex
  /**
   * A token the person names in Settings, recovered with the others. A settled record keeps its
   * history: the recovery writes nothing to it or to its registration.
   */
  stranded?: SipaFundingToken
  /** Injectable for tests. */
  run?: typeof runSipaRecovery
}

/**
 * Guard the recovery, then run it. It moves every token that has a balance when it is read, so no
 * sweep has to move a token left at an address the recovery deploys. A token without a balance is
 * left out, because its recovery call reverts on the empty balance.
 */
export async function recoverSipaDeposit(
  record: SIPADepositRecord,
  deps: RecoveryDeps,
): Promise<Hex> {
  if (!record.messageSecret) {
    throw new Error(
      "This wallet is still looking up this deposit's details. Recovery becomes available once it has them.",
    )
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  // A record naming a token off the list (a historic deployment's) is read too.
  const named = record.tokenAddress
  const erc20s: SipaFundingToken[] = [...deps.tokens]
  const addToken = (t: SipaFundingToken) => {
    if (!isNativeEth(t.address) && !erc20s.some((e) => same(e.address, t.address))) erc20s.push(t)
  }
  if (named)
    addToken({
      address: named,
      symbol: record.tokenSymbol ?? "",
      decimals: record.tokenDecimals ?? deps.tokens[0].decimals,
    })
  const stranded = deps.stranded
  if (stranded) addToken(stranded)
  const account = record.origin?.protocol === "account"
  const listed = account ? [...erc20s, NATIVE_ETH] : erc20s
  const balances = await Promise.all(
    listed.map((t) =>
      isNativeEth(t.address)
        ? deps.readEthBalance(record.sipaAddress)
        : deps.readBalance(record.sipaAddress, t.address),
    ),
  )
  const held = listed.filter((_, i) => balances[i]! > 0n)
  if (stranded && !held.some((t) => same(t.address, stranded.address))) {
    throw new Error(`This deposit address no longer holds any ${stranded.symbol}.`)
  }
  const token = held.find((t) => named && same(t.address, named)) ?? held[0]
  if (!token) {
    if (isNativeEth(named)) {
      throw new Error(
        account
          ? "This deposit address holds no ETH. It may already have been recovered."
          : "This deposit address cannot recover ETH. Contact support to move it.",
      )
    }
    throw named ? new AlreadySweptError() : new Error(UNTRACKED_TOKEN_ZERO)
  }
  const moved =
    named && same(token.address, named)
      ? record
      : {
          ...record,
          tokenAddress: token.address,
          tokenSymbol: token.symbol,
          tokenDecimals: token.decimals,
        }
  const others = held.filter((t) => t !== token).map((t) => t.address)
  // Checked at each write: a sync can settle the record while the recovery is signed.
  let kept = false
  const store: RecoveryDeps["store"] = stranded
    ? {
        get: (sipa) => deps.store.get(sipa),
        update: (sipa, patch) => deps.store.update(sipa, patch),
        upsert: async (sipa, patch) =>
          (await deps.store.update(sipa, (current) => {
            if (!isSettledSipaPhase(current.phase)) return patch
            kept = true
            return null
          })) ?? record,
      }
    : deps.store
  const hash = await runRecovery(moved, [token.address, ...others], { ...deps, store })
  if (kept) return hash
  await registrationRefundConfirmed(
    record.sipaAddress,
    (held.find((t) => !isNativeEth(t.address)) ?? token).address,
    deps.chainId,
    hash,
    deps.readReceipt,
  ).catch(() => {})
  return hash
}

async function runRecovery(
  record: SIPADepositRecord,
  tokens: [Address, ...Address[]],
  deps: RecoveryDeps,
) {
  return await (deps.run ?? runSipaRecovery)({
    record,
    stealthKey: await deps.stealthKey(),
    signAccount: deps.signAccount,
    accountInitCode: deps.accountInitCode,
    target: deps.channel.target,
    tokens,
    chainId: deps.chainId,
    deployment: deps.deployment,
    sendTransaction: deps.channel.sendTransaction,
    waitForReceipt: deps.channel.waitForReceipt,
    store: deps.store,
  })
}

/**
 * The injected wallet pays the gas and is itself the destination. Receipts are polled over the
 * app's own RPC, not the wallet's: connected over a scanned QR the wallet is a phone behind a
 * WalletConnect relay, and plenty of mobile wallets answer no reads at all. `readClient` overrides
 * that for callers whose environment cannot reach the RPC.
 */
export async function injectedWalletChannel(
  config: WebWalletConfig,
  opts: {
    from?: Hex
    onStage?: (stage: L1ExitStage) => void
    readClient?: PublicClient
  } = {},
): Promise<L1ExitChannel> {
  const { walletClient, account, chain } = await getL1Clients(config.l1ChainId, opts.from)
  const publicClient = opts.readClient ?? l1PublicClient(config)
  return {
    target: account,
    sendTransaction: async (to, data) => {
      const block = await publicClient.getBlock({ blockTag: "latest" })
      // EIP-7825 caps individual transactions on Ethereum and Sepolia independently of the
      // block limit. Local/other chains retain their own block limit.
      const transactionCap = chain.id === 1 || chain.id === 11155111 ? 16_777_216n : block.gasLimit
      const limit = block.gasLimit < transactionCap ? block.gasLimit : transactionCap
      // Bound the estimate too: some RPCs otherwise simulate against the larger block limit.
      // Propagate estimation errors before signing; never let a wallet substitute a fallback.
      const estimate = await publicClient.estimateGas({ to, data, account, gas: limit })
      if (estimate > limit) {
        throw new Error("This transaction exceeds the network's gas limit and cannot be submitted.")
      }
      const buffered = (estimate * 120n + 99n) / 100n
      const gas = buffered < limit ? buffered : limit
      opts.onStage?.("signing")
      return walletClient.sendTransaction({ to, data, account, chain, gas })
    },
    waitForReceipt: async (hash) => {
      opts.onStage?.("confirming")
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      return receipt.status === "success"
    },
  }
}

export interface DesktopBridgeChannelParams {
  /**
   * Who the transaction pays. Typed by the user on the deposit exits; on a withdrawal finalize it
   * is the withdrawal's own recipient, which takes the relayer tip.
   */
  destination: Address
  /** The only account the helper page may pay from. */
  from?: Address
  chainId: number
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  /** Helper-page summary; the network row is appended. */
  display: { title: string; lines: [string, string][] }
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/** Submission through the desktop launcher's helper page in the user's default browser. */
export function desktopBridgeChannel(params: DesktopBridgeChannelParams): L1ExitChannel {
  return {
    target: params.destination,
    sendTransaction: (to, data) => {
      params.onStage?.("awaiting-browser")
      return submitViaDesktopBridge({
        onHelperOpened: params.onHelperOpened,
        tx: { from: params.from, to, data, chainId: params.chainId },
        display: {
          title: params.display.title,
          lines: [...params.display.lines, ["Network", l1ChainFor(params.chainId).name]],
        },
      })
    },
    waitForReceipt: async (hash) => {
      params.onStage?.("confirming")
      const receipt = await params.publicClient.waitForTransactionReceipt({ hash })
      return receipt.status === "success"
    },
  }
}

/** The user's stealth keypair; unavailable while the session is locked. */
async function webStealthKey(): Promise<SipaRecoveryDeps["stealthKey"]> {
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  return deriveStealthKey(msk)
}

export interface RecoverDepositOptions {
  /** Required in bridge mode: where the recovered funds go. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting (and receiving) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  stranded?: RecoveryDeps["stranded"]
}

/** Recover `record` over whichever channel this build has. Resolves to the L1 recovery tx hash. */
export async function recoverDeposit(
  record: SIPADepositRecord,
  opts: RecoverDepositOptions = {},
): Promise<Hex> {
  const config = getConfig()
  if (record.l1ChainId !== config.l1ChainId)
    throw new Error("Switch to the deposit's original chain before recovery")
  const publicClient = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const token = requireTupleField(tuple, "token") as Address

  let channel: L1ExitChannel
  if (isDesktopL1SubmitActive()) {
    const destination = opts.destination
    if (!destination || !isAddress(destination)) {
      throw new Error("Enter the Ethereum address that should receive the recovered funds.")
    }
    channel = desktopBridgeChannel({
      destination,
      chainId: config.l1ChainId,
      publicClient,
      display: {
        title: "Recover your zk.money deposit",
        lines: [
          [
            "Amount",
            opts.stranded
              ? `All ${opts.stranded.symbol}, and any deposit tokens at the address`
              : `${depositAmounts(record).grossDisplay} ${
                  record.tokenSymbol
                }, and any other tokens at the address`,
          ],
          ["Deposit address", record.sipaAddress],
          ["Recovered to", destination],
        ],
      },
      onHelperOpened: opts.onHelperOpened,
      onStage: opts.onStage,
    })
  } else {
    channel = await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }

  const keys = await getAuthService().sessionKeys()
  if (!keys) throw new Error("Unlock the wallet before recovery")
  const bootstrap = deriveBootstrapKey(keys.secretKey)
  const passkey = await oxideAccountPasskey(keys.authProvider)
  const reader = createOxideL1Reader(publicClient)
  let accountInitCode: Hex | undefined
  if (record.origin?.protocol === "account") {
    const predicted = await predictAccountAddress(
      publicClient,
      record.origin.accountFactory,
      bootstrap.address,
    )
    if (predicted.toLowerCase() !== record.origin.recoveryAccount.toLowerCase())
      throw new Error("Wallet keys do not match this deposit's recovery account")
    const code = await reader.getCode(predicted)
    if (!code || code === "0x")
      accountInitCode = encodeAccountInitCode(record.origin.accountFactory, bootstrap.address)
  }

  return await recoverSipaDeposit(record, {
    channel,
    chainId: config.l1ChainId,
    tokens: await recoveryProbeTokens(config, token),
    readBalance: (sipa, token) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sipa],
      }),
    readEthBalance: (address) => publicClient.getBalance({ address }),
    readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
    deployment: await recoveryDeployment(publicClient, record, tuple),
    store: SIPADepositStore.get(new WebStorageAdapter()),
    stealthKey: webStealthKey,
    accountInitCode,
    stranded: opts.stranded,
    signAccount: (account, hash) =>
      signAccountDigest({ account, hash, chainId: config.l1ChainId, bootstrap, reader, passkey }),
  })
}

/**
 * Deploy capability for the current manifest tuple: an unswept deposit is counterfactual, so
 * recovery must be able to deploy it. The implementation read is best-effort — an unreadable
 * factory yields no deposit candidates and the recovery fails closed instead of submitting a no-op.
 */
async function recoveryDeployment(
  publicClient: PublicClient,
  record: SIPADepositRecord,
  tuple: OxideEnvTuple,
): Promise<SipaRecoveryDeps["deployment"]> {
  const deployments: Parameters<typeof sipaDeployArgCandidates>[1] = []
  if (!record.origin) {
    const config = getConfig()
    const { historic } = await detectHistoricDeployments({
      ...config.oxideProfile,
      network: config.network,
      publicClient,
      sourcePortals: new Set(config.sourceRollupNodes?.keys()),
    })
    for (const candidate of [tuple, ...historic]) {
      if (
        candidate.sipaRecoveryProtocol === "account" ||
        !candidate.sipaFactory ||
        !/^\d+$/.test(candidate.rollupVersion ?? "")
      )
        continue
      const implementation =
        (candidate.depositSIPAImplementation as Address | undefined) ??
        (await readDepositSIPAImplementation(publicClient, candidate.sipaFactory as Address).catch(
          () => undefined,
        ))
      if (implementation)
        deployments.push({
          sipaFactory: candidate.sipaFactory as Address,
          rollupVersion: BigInt(candidate.rollupVersion),
          implementation,
        })
    }
  }
  const registration =
    record.origin || (await readSipaDeployed(publicClient, record.sipaAddress))
      ? null
      : await registrationCandidate(record)
  return {
    readDeployed: (sipa) => readSipaDeployed(publicClient, sipa),
    candidates: [
      ...sipaDeployArgCandidates(record, deployments),
      ...(registration ? [registration] : []),
    ],
    predict: (candidate) => predictSipaCandidate(publicClient, candidate),
  }
}

/**
 * The CREATE2 args of a registration SIPA, or null for a plain deposit. A registration SIPA
 * commits to the registration intent (registration implementation, non-resweepable), which the
 * pending record does not persist — it is re-derived from the unlocked master secret.
 */
async function registrationCandidate(
  record: SIPADepositRecord,
): Promise<SipaRecoverCandidate | null> {
  const pending = registrationRecordForSipa(record.sipaAddress)
  // Legacy records lack the payment committed into the address; do not substitute a current quote.
  if (!pending || pending.fee === undefined || pending.beneficiary === undefined) return null
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  const config = getConfig()
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  const derive = createRegistrationSipaDeriver({
    publicClient,
    env,
    tuple,
  })
  const derivation = await derive({
    owner: pending.account as Address,
    nameHash: pending.nameHash,
    l2Address: pending.l2Address,
    fee: BigInt(pending.fee),
    beneficiary: pending.beneficiary,
    masterSecret: msk,
  })
  const sipaFactory = requireTupleField(tuple, "sipaFactory") as Address
  return "recoveryAddress" in derivation.sipaArgs
    ? { protocol: "legacy-eoa", sipaFactory, args: derivation.sipaArgs }
    : { protocol: "account", sipaFactory, args: derivation.sipaArgs }
}

/** What the Settings recovery needs for a token stranded at one of this wallet's deposit addresses. */
export interface StrandedToken {
  record: SIPADepositRecord
  token: SipaFundingToken
  balance: string
}

export async function readStrandedToken(
  sipa: Address,
  token: Address,
  networkId: string,
): Promise<StrandedToken> {
  const config = getConfig()
  const store = SIPADepositStore.get(new WebStorageAdapter())
  const stored = async () => {
    await store.load()
    return store.get(sipa)
  }
  // A registration address has a deposit record only once one is seeded: from this device's
  // registration record, else re-derived from the master secret and the wallet's name.
  const ok = () => true
  const failed = () => false
  const healed = await healRegistrationDeposits(config, networkId).then(ok, failed)
  const rederived =
    (await stored()) !== null ||
    (await rederiveRegistrationDeposit(config, networkId, sipa).then(ok, failed))
  const record = await stored()
  if (!record) {
    throw new Error(
      healed && rederived
        ? "This wallet has no deposit at that address. Open the wallet that made the address and try there."
        : "Couldn't check this wallet's registration addresses. Check your connection and try again.",
    )
  }
  if (record.l1ChainId !== config.l1ChainId) {
    throw new Error("This deposit address is on another network. Switch networks and try again.")
  }
  if (!record.messageSecret) {
    throw new Error(
      "This wallet is still looking up this deposit's details. Try again once it has them.",
    )
  }
  const client = l1PublicClient(config)
  const erc20 = { address: token, abi: erc20Abi } as const
  const balance = await client
    .readContract({ ...erc20, functionName: "balanceOf", args: [sipa] })
    .catch(() => {
      throw new Error("That address is not an ERC-20 token on this network.")
    })
  if (balance === 0n) throw new EmptyDepositError()
  const [symbol, decimals] = await Promise.all([
    client.readContract({ ...erc20, functionName: "symbol" }).catch(() => "tokens"),
    client.readContract({ ...erc20, functionName: "decimals" }).catch(() => undefined),
  ])
  // Recovery needs only the address; without decimals the amount cannot be shown, so it reads "All".
  return {
    record,
    token: { address: token, symbol, decimals: decimals ?? 18 },
    balance: decimals === undefined ? "All" : formatUnits(balance, decimals),
  }
}

/**
 * Seeds this wallet's registration address when it is `sipa`, as on a device with no registration
 * record. A claim's fee is the last try; a refused claim means this name's address is not found.
 */
async function rederiveRegistrationDeposit(
  config: WebWalletConfig,
  networkId: string,
  sipa: Address,
) {
  const identity = loadWalletIdentity()
  const secret = await getAuthService().getSecretKey()
  if (!identity?.handle || !secret) return
  const target = sipa.toLowerCase()
  const l2Address = identity.address as Hex
  await seedRederivedRegistrations(config, networkId, secret, identity.handle, l2Address, {
    keep: async (found) =>
      found.filter((f) => f.derivation.sipaAddress.toLowerCase() === target).slice(0, 1),
    quotedFee: async (deps, owner, nameHash) => {
      const claim = await deps.accountService
        .signDomain({ nameHash, userAddress: owner })
        .catch((err: unknown) => {
          if (isNameReserved(err) || isNameBlocked(err)) return undefined
          if (claimRefusalReason(err) === "name_registered") return undefined
          throw err
        })
      return claim?.terms ? BigInt(claim.terms.fee) : undefined
    },
  })
}

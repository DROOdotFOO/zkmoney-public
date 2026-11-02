/**
 * SIPA reads and sweep-call builders: the contract-touching primitives of the deposit claim path.
 * The claim inputs (inbox index, credited amount, L1→L2 message key) come from the portal's
 * `Deposit` event, which `sipaChain.ts` reads for every SIPA at once. The one L2 write-shaped call
 * (`store_deposit`) is a TokenService method because the token contract lives there.
 */

import type { Address, Hex, PublicClient } from "viem"
import {
  encodeFunctionData,
  erc20Abi,
  multicall3Abi,
  toFunctionSelector,
  zeroAddress,
} from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import { MAX_RPC_LEN } from "@aztec-labs/stdlib/interfaces/api-limit"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import { computeSiloedDepositMessageNullifier } from "@oxide/oxide-lib/deposit_message_hashing.js"
import {
  encodeDeploySIPA,
  encodeRegistrationProofs,
  encodeLegacyRegistrationProofs,
  encodeSweep,
  type DomainAuthArg,
  type R1InstallArg,
  type SignedTermsArg,
  type SipaDeployArgs,
  type SweepArgs,
} from "@oxide/l1-contracts"
import {
  encodeLegacySipaDeploy,
  encodeLegacySipaRecoverERC20,
  type LegacySipaDeployArgs,
} from "@oxide/l1-contracts/legacy_sipa.js"
import {
  encodeSipaRecoverERC20,
  encodeSipaRecoverETH,
  type SipaRecoveryArgs,
} from "@oxide/l1-contracts/sipa_recovery.js"
import { chunkedContractEvents } from "../helpers/l1Logs.js"
import { readSipaPortalTerms, type SipaRoute } from "../../oxide/portal/sipaPortalTerms.js"
import { readSipaEvents, type SipaEvent } from "@oxide/oxide-client/sipa_event_calls.js"
import type { PrivateEventFilter, Wallet } from "@aztec-labs/aztec.js/wallet"
import { OxideTokenContract } from "@obsidion/contracts"

export type { SipaEvent }

/** The canonical cross-chain Multicall3 deployment. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address

/** Inner calls per Multicall3 `eth_call`: at ~8k gas each a batch stays far under node gas caps. */
const BALANCE_CALLS_PER_MULTICALL = 1_000

/** What every deposit of one recipient through one token shares in its consumed check. */
export interface SipaDepositClaimScope {
  l2Token: AztecAddress
  masterNullifierHidingKey: GrumpkinScalar
}

/**
 * Which deposits the chain has consumed, in order, by their L1→L2 message hashes: the `key` each
 * portal `Deposit` log carries. Each nullifier is derived from that hash and the recipient's NHK,
 * and they go to the node in batched `findLeavesIndexes` lookups, as many as one request takes,
 * every request at once.
 */
export async function readSipaDepositsConsumed(
  node: Pick<AztecNode, "findLeavesIndexes">,
  scope: SipaDepositClaimScope,
  messageHashes: readonly Hex[],
): Promise<boolean[]> {
  const nullifiers = await Promise.all(
    messageHashes.map((hash) =>
      computeSiloedDepositMessageNullifier(
        scope.l2Token as never,
        Fr.fromHexString(hash) as never,
        scope.masterNullifierHidingKey as never,
      ),
    ),
  )
  const batches: (typeof nullifiers)[] = []
  for (let i = 0; i < nullifiers.length; i += MAX_RPC_LEN) {
    batches.push(nullifiers.slice(i, i + MAX_RPC_LEN))
  }
  const found = await Promise.all(
    batches.map((batch) =>
      node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, batch as never),
    ),
  )
  return found.flat().map((leaf) => leaf !== undefined)
}

/** Cap on the backward sweep scan when no explicit `fromBlock` is given. ~7 days of Sepolia blocks. */
const SWEEP_MAX_LOOKBACK_BLOCKS = 50_000n

/** The sweep and funding readers' window: the caller's range, else the finite look-back. */
async function sweepScanWindow(
  publicClient: PublicClient,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<{ from: bigint; to: bigint }> {
  // `cacheTime: 0` because viem caches `getBlockNumber` for a polling interval by default, which
  // makes the head lag a block or two. This value is an upper BOUND on the scan, so a lagging one
  // silently excludes the newest logs — a caller that sweeps and then reads sees nothing at all.
  const to = toBlock ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))
  const from = fromBlock ?? (to > SWEEP_MAX_LOOKBACK_BLOCKS ? to - SWEEP_MAX_LOOKBACK_BLOCKS : 0n)
  return { from, to }
}

/** An ERC-20 `Transfer` into a SIPA — the funding-attribution source. */
export interface SipaFundingTransfer {
  /** Token-level sender. A contract-mediated transfer attributes the intermediary, not the wallet. */
  from: Address
  amount: bigint
  blockNumber: bigint
  txHash: Hex
}

/** L1 block time in ms; undefined when the read fails so a wall-clock stamp can stand in. */
export async function readBlockTimeMs(
  publicClient: PublicClient,
  blockNumber: bigint,
): Promise<number | undefined> {
  try {
    return Number((await publicClient.getBlock({ blockNumber })).timestamp) * 1000
  } catch {
    return undefined
  }
}

/**
 * Read the token `Transfer(to = sipa)` logs — who funded a SIPA, and with which
 * tx. Client-side replacement for the data the retired ens-gateway's on-chain
 * Transfer scan used to report. Same window semantics as `readSweepEvents`.
 */
export async function readFundingTransfers(
  publicClient: PublicClient,
  token: Address,
  sipa: Address,
  fromBlock?: bigint,
  toBlock?: bigint,
): Promise<SipaFundingTransfer[]> {
  const window = await sweepScanWindow(publicClient, fromBlock, toBlock)
  const logs = await chunkedContractEvents(
    publicClient,
    { address: token, abi: erc20Abi, eventName: "Transfer", args: { to: sipa } },
    window.from,
    window.to,
  )
  return logs.map(toFundingTransfer)
}

function toFundingTransfer(log: unknown): SipaFundingTransfer {
  const { args, blockNumber, transactionHash } = log as {
    args: { from: Address; value: bigint }
    blockNumber: bigint
    transactionHash: Hex
  }
  return { from: args.from, amount: args.value, blockNumber, txHash: transactionHash }
}

/**
 * Every SIPA's balance of each token, plus its ETH under `zeroAddress`, through Multicall3. Keyed by
 * lowercased SIPA, then lowercased token. A failed read is absent, so the caller can retry it alone.
 */
export async function readSipaBalancesMany(
  publicClient: PublicClient,
  sipas: readonly Address[],
  tokens: readonly Address[],
  multicall3: Address = MULTICALL3_ADDRESS,
): Promise<Map<string, Map<string, bigint>>> {
  const reads = sipas.flatMap((sipa) => [
    ...tokens.map((token) => ({
      sipa,
      token,
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sipa],
    })),
    {
      sipa,
      token: zeroAddress,
      address: multicall3,
      abi: multicall3Abi,
      functionName: "getEthBalance",
      args: [sipa],
    },
  ])
  const out = new Map(sipas.map((sipa) => [sipa.toLowerCase(), new Map<string, bigint>()]))
  if (reads.length === 0) return out
  const results = await publicClient.multicall({
    contracts: reads,
    multicallAddress: multicall3,
    allowFailure: true,
    // viem chunks by inner calldata bytes; a balanceOf/getEthBalance call is 36.
    batchSize: BALANCE_CALLS_PER_MULTICALL * 36,
  } as never)
  const answers = results as { status: string; result?: unknown }[]
  reads.forEach(({ sipa, token }, i) => {
    const answer = answers[i]
    if (answer?.status === "success")
      out.get(sipa.toLowerCase())!.set(token.toLowerCase(), answer.result as bigint)
  })
  return out
}

/** `holder`'s balance of `token` at `blockTag`. */
export function readTokenBalanceAt(
  publicClient: PublicClient,
  token: Address,
  holder: Address,
  blockTag: "finalized" | "latest",
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
    blockTag,
  })
}

/**
 * Which of `sipas` are deployed clones, lowercased, through one Multicall3 call (`eth_getCode` cannot
 * be batched into one). A call to an address without code succeeds with no data; a clone answers
 * `intentHash()` or reverts. A sweep deploys its SIPA, so a deployed one was swept or recovered.
 */
export async function readSipaDeployedMany(
  publicClient: PublicClient,
  sipas: readonly Address[],
  multicall3: Address = MULTICALL3_ADDRESS,
): Promise<Set<string>> {
  if (sipas.length === 0) return new Set()
  const callData = toFunctionSelector("intentHash()")
  const results = (await publicClient.readContract({
    address: multicall3,
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [sipas.map((target) => ({ target, allowFailure: true, callData }))],
  } as never)) as readonly { success: boolean; returnData: Hex }[]
  return new Set(
    sipas
      .filter((_, i) => !(results[i]!.success && results[i]!.returnData === "0x"))
      .map((sipa) => sipa.toLowerCase()),
  )
}

/** Addresses whose balances one {@link readSipaHoldingsAtHead} call reads, each with its own tokens. */
export interface SipaHoldingRead {
  sipa: Address
  tokens: readonly Address[]
}

/**
 * Each SIPA's balance of its own tokens plus its ETH under `zeroAddress`, and the block's timestamp,
 * in exactly one Multicall3 `aggregate3` `eth_call` (up to `BALANCE_CALLS_PER_MULTICALL` inner
 * calls; more throws). Keyed like {@link readSipaBalancesMany}. A failed timestamp read throws.
 */
export async function readSipaHoldingsAtHead(
  publicClient: PublicClient,
  holdings: readonly SipaHoldingRead[],
  multicall3: Address = MULTICALL3_ADDRESS,
): Promise<{ timestamp: bigint; balances: Map<string, Map<string, bigint>> }> {
  const reads = holdings.flatMap(({ sipa, tokens }) => [
    ...tokens.map((token) => ({
      sipa,
      token,
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sipa],
    })),
    {
      sipa,
      token: zeroAddress,
      address: multicall3,
      abi: multicall3Abi,
      functionName: "getEthBalance",
      args: [sipa],
    },
  ])
  if (reads.length + 1 > BALANCE_CALLS_PER_MULTICALL)
    throw new Error(`${reads.length + 1} balance reads exceed one Multicall3 call`)
  const results = (await publicClient.multicall({
    contracts: [
      { address: multicall3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
      ...reads,
    ],
    multicallAddress: multicall3,
    allowFailure: true,
    // Zero turns viem's chunking off.
    batchSize: 0,
  } as never)) as { status: string; result?: unknown; error?: unknown }[]
  const [stamp, ...answers] = results
  if (stamp?.status !== "success") throw stamp?.error ?? new Error("block timestamp read failed")
  const balances = new Map(
    holdings.map(({ sipa }) => [sipa.toLowerCase(), new Map<string, bigint>()]),
  )
  reads.forEach(({ sipa, token }, i) => {
    const answer = answers[i]
    if (answer?.status === "success")
      balances.get(sipa.toLowerCase())!.set(token.toLowerCase(), answer.result as bigint)
  })
  return { timestamp: stamp.result as bigint, balances }
}

/** Where a SIPA's current funding sits between the deposit fee and the per-transaction cap. */
export interface SipaFundingStatus {
  /** The SIPA's current `token` balance, in the sent token's own units. */
  balance: bigint
  /** `balance` in the fee's denomination: the figure to compare with `fee` and the cap. */
  scaledBalance: bigint
  /** The route's fee: the floor a sweep pays. */
  fee: bigint
  sweepable: boolean
}

/**
 * Classify a funded-but-unswept SIPA against the two-sided sweep window:
 * `fee < balance ≤ txAmountCap + fee`. A sweep pays the deposit fee out of the WHOLE balance and
 * deposits the rest into the portal, which credits `balance − fee`; the per-transaction cap
 * measures that credited amount. `recoverERC20` is the only exit outside the window.
 * `balance = 0` after a sweep is normal.
 *
 * `route` is the forwarding-table row the sweep charges. It is read only without `params.fee`,
 * which supplies the floor when the caller already holds it. `txAmountCap` is the portal's
 * `TX_AMOUNT_CAP()`.
 *
 * `params.balanceScale` normalizes the balance into the fee's denomination when the sent token's
 * decimals differ (mainnet: the sweep swaps USDC/USDT ~1:1 into 18-dec DAI, which the fee and the
 * cap are measured in — pass `10^(18 - sentDecimals)`). The returned `balance` stays raw.
 */
export async function readSipaFundingStatus(
  publicClient: PublicClient,
  params: {
    sipa: Address
    token: Address
    txAmountCap: bigint
    balanceScale?: bigint
    /** The balance when the caller already read it; skips the `balanceOf` read. */
    balance?: bigint
  } & ({ fee: bigint; route?: SipaRoute } | { fee?: undefined; route: SipaRoute }),
): Promise<SipaFundingStatus> {
  const [balance, fee] = await Promise.all([
    params.balance ??
      (publicClient.readContract({
        address: params.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [params.sipa],
      } as never) as Promise<bigint>),
    params.fee !== undefined ? params.fee : readDepositFee(publicClient, params.route),
  ])
  const scaledBalance = balance * (params.balanceScale ?? 1n)
  return {
    balance,
    scaledBalance,
    fee,
    sweepable: scaledBalance > fee && scaledBalance - fee <= params.txAmountCap,
  }
}

/**
 * The fee a sweep on `route` pays: the row's sweep tip plus its beneficiary fee. Each intent has
 * its own row, so a registration costs more than a plain deposit. It is the deposit floor. The
 * receive UX pre-checks the send against it: a sweep at or below it hard-reverts, and a third-party
 * sender has no client guard, which is why the recovery affordance exists.
 *
 * Read off the table, never a clone: the quote a payer is shown exists before any SIPA is deployed.
 */
export async function readDepositFee(
  publicClient: PublicClient,
  route: SipaRoute,
): Promise<bigint> {
  return (await readSipaPortalTerms(publicClient, route)).depositFee
}

/** The L1 transaction target + calldata for a recipient-self-sweep. */
export interface SipaSweepCall {
  to: Address
  data: Hex
}

/** `token` is the ERC-20 to recover, or `zeroAddress` for the SIPA's ETH balance. */
type RecoveryCall = { sipa: Address; token: Address } & (
  | { protocol: "legacy-eoa"; signature: Hex; target: Address; nonce: Hex }
  | ({ protocol: "account" } & SipaRecoveryArgs)
)

export function encodeRecoverCall(params: RecoveryCall): SipaSweepCall {
  if (params.token === zeroAddress) {
    // oxide ships no legacy recoverETH encoder; legacy SIPAs exist only on retired deployments.
    if (params.protocol === "legacy-eoa")
      throw new Error("ETH recovery needs an account-protocol SIPA")
    return { to: params.sipa, data: encodeSipaRecoverETH(params) }
  }
  return {
    to: params.sipa,
    data:
      params.protocol === "legacy-eoa"
        ? encodeLegacySipaRecoverERC20(params)
        : encodeSipaRecoverERC20(params),
  }
}

/** @deprecated Use `encodeRecoverCall`, which also encodes `recoverETH`. */
export const encodeRecoverErc20Call = encodeRecoverCall

type RecoveryDeployment =
  | { protocol: "legacy-eoa"; sipaFactory: Address; args: LegacySipaDeployArgs }
  | { protocol: "account"; sipaFactory: Address; args: SipaDeployArgs }

/** One transaction that recovers each of `recoveries`, one token each, from the same SIPA. */
export function buildSipaRecoverCall(params: {
  deployed: boolean
  deployment?: RecoveryDeployment
  recoveries: readonly [RecoveryCall, ...RecoveryCall[]]
  accountInitCode?: Hex
  multicall3?: Address
}): SipaSweepCall {
  const protocol = params.recoveries[0].protocol
  if (params.recoveries.some((r) => r.protocol !== protocol)) {
    throw new Error("All SIPA recoveries in one transaction must use one protocol")
  }
  const calls: { target: Address; allowFailure: boolean; callData: Hex }[] = []
  if (params.accountInitCode) {
    if (protocol !== "account" || !/^0x[0-9a-fA-F]{48,}$/.test(params.accountInitCode)) {
      throw new Error("Account initialization is only valid for account recovery")
    }
    calls.push({
      target: params.accountInitCode.slice(0, 42) as Address,
      allowFailure: false,
      callData: `0x${params.accountInitCode.slice(42)}`,
    })
  }
  if (!params.deployed) {
    const deployment = params.deployment
    if (!deployment || deployment.protocol !== protocol) {
      throw new Error("Matching SIPA recovery and deployment protocols are required")
    }
    calls.push({
      target: deployment.sipaFactory,
      allowFailure: false,
      callData:
        deployment.protocol === "legacy-eoa"
          ? encodeLegacySipaDeploy(deployment.args)
          : encodeDeploySIPA(deployment.args),
    })
  }
  if (!calls.length && params.recoveries.length === 1)
    return encodeRecoverCall(params.recoveries[0])
  for (const recovery of params.recoveries) {
    const call = encodeRecoverCall(recovery)
    calls.push({ target: call.to, allowFailure: false, callData: call.data })
  }
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

/**
 * Build the permissionless deploy-and-sweep transaction (the recipient-side
 * fallback for when no relayer picks a discovered deposit up). It claims no
 * subsidy: an undeployed SIPA is deployed and swept atomically through
 * Multicall3 `aggregate3` (both sub-calls all-or-nothing); a deployed SIPA is
 * swept directly — a second `deploySIPA` would revert on the CREATE2
 * collision. Pass the recipient's own L1 address as `sweepArgs.relayer` so the
 * deposit fee returns to them. Submission is the caller's channel (external
 * wallet pays gas).
 */
export type SipaSweepDeployArgs = SipaDeployArgs | LegacySipaDeployArgs

export function buildSipaSweepCall(params: {
  /** Whether the SIPA already has code (`getCode` non-empty). */
  deployed: boolean
  /** The CREATE2 deployer the deploy leg targets. */
  sipaFactory: Address
  sipa: Address
  deployArgs: SipaSweepDeployArgs
  sweepArgs: SweepArgs
  multicall3?: Address
}): SipaSweepCall {
  const sweepData = encodeSweep(params.sweepArgs)
  if (params.deployed) {
    return { to: params.sipa, data: sweepData }
  }
  const calls = [
    {
      target: params.sipaFactory,
      allowFailure: false,
      callData:
        "recoveryAddress" in params.deployArgs
          ? encodeLegacySipaDeploy(params.deployArgs)
          : encodeDeploySIPA(params.deployArgs),
    },
    { target: params.sipa, allowFailure: false, callData: sweepData },
  ]
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

/**
 * The registration self-sweep call: the SAME deploy-and-sweep a relayer runs for a RegistrationSIPA
 * (the register-deploy-and-sweep inside `RegistrationSIPA._execute`), submitted by the user as their
 * own relayer. Mirrors {@link buildSipaSweepCall} for a plain deposit, but reveals the registration
 * record as `intentData` and packs the consent/domain/terms as `proofs`. Naming the user's own L1
 * address as `relayer` returns the deposit fee to them; the on-chain registration fee still comes out
 * of the deposit — bypassing the relayer changes who submits, not what is charged.
 */
export function buildRegistrationSweepCall(params: {
  /** Whether the SIPA already has code (`getCode` non-empty). */
  deployed: boolean
  /** The CREATE2 deployer the deploy leg targets. */
  sipaFactory: Address
  sipa: Address
  /** The registration SIPA's create2 deploy args; its `intentHash` is `keccak256(registrationData)`. */
  deployArgs: SipaSweepDeployArgs
  /** ABI-encoded registration intent — the sweep's revealed `intentData`. */
  registrationData: Hex
  consentSig: Hex
  bootstrap: Address
  domainAuth: DomainAuthArg
  /** {@link EMPTY_SIGNED_TERMS} to register on the contract's immutable schedule. */
  signedTerms: SignedTermsArg
  /** The passkey install the sweep bundles through the EntryPoint. */
  r1Install: R1InstallArg
  token: Address
  /** Credited the deposit fee — the user's own L1 address for a self-sweep. */
  relayer: Address
  multicall3?: Address
}): SipaSweepCall {
  return buildSipaSweepCall({
    deployed: params.deployed,
    sipaFactory: params.sipaFactory,
    sipa: params.sipa,
    deployArgs: params.deployArgs,
    sweepArgs: {
      token: params.token,
      relayer: params.relayer,
      intentData: params.registrationData,
      proofs: ("recoveryAddress" in params.deployArgs
        ? encodeLegacyRegistrationProofs
        : encodeRegistrationProofs)({
        consentSig: params.consentSig,
        bootstrap: params.bootstrap,
        domainAuth: params.domainAuth,
        signedTerms: params.signedTerms,
        r1Install: params.r1Install,
      }),
    },
    multicall3: params.multicall3,
  })
}

/**
 * The sweep encoder and the two argument shapes `buildSipaSweepCall` takes,
 * re-exported so callers outside this workspace (the web wallet) name the
 * vendored types directly instead of re-deriving them from the builder's
 * signature.
 */
export { encodeSweep } from "@oxide/l1-contracts"
export type { SipaDeployArgs, SweepArgs } from "@oxide/l1-contracts"

/** The registration sweep's domain-auth struct (oxide `DomainAuthArg`). */
export type SweepSigStruct = DomainAuthArg
/** The operator-signed terms struct and its "no terms" marker (the immutable schedule applies). */
export { EMPTY_SIGNED_TERMS } from "@oxide/l1-contracts"
export type { SignedTermsArg } from "@oxide/l1-contracts"

/** Read the `SIPA` events sent to `recipient` on `token`. Register the sender with the wallet first. */
export function fetchSipaEvents(
  wallet: Pick<Wallet, "getPrivateEvents">,
  token: AztecAddress,
  recipient: AztecAddress,
  filter?: Pick<PrivateEventFilter, "fromBlock" | "toBlock" | "txHash">,
): Promise<SipaEvent[]> {
  return readSipaEvents(wallet, OxideTokenContract.events.SIPA, token, recipient, filter)
}

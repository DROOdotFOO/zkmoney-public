import type { LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
/**
 * SIPA intent builders — the wallet-side wrappers over the vendored intent codec.
 *
 * Every SIPA commits to one word, `intentHash = keccak256(intentData)`, and its CREATE2
 * address commits to `(implementation, intentHash, plumbing)` where the implementation IS
 * the intent type (a `DepositSIPA` / `RegistrationSIPA` clone) and the plumbing names the
 * forwarding table that routes its sweeps. `intentData` and any
 * `proofs` are revealed at sweep. The record encoders, the deploy/sweep/predict encoders,
 * and the payload frame all live in `@oxide/l1-contracts`; these builders assemble the
 * `(implementation, intentHash, intentData, proofs)` tuple one intent at a time and pack it
 * for the L2 broadcast.
 */

import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  encodeDepositIntentData,
  buildSipaDeployAndSweepOperation,
  buildSipaSweepOperation,
  depositPayoutTokenFor,
  DepositSubsidyAbi,
  predictSIPA,
  type SipaDeployArgs,
  encodeRegistrationIntentData,
  encodeRegistrationProofs,
  readForwardingTableRow,
  readSIPAImplementation,
  SIPAFactoryAbi,
  SipaIntent as OxideSipaIntent,
  type DomainAuthArg,
  type ForwardingTableRow,
  type R1InstallArg,
  type RegistrationIntent,
  type SignedTermsArg,
} from "@oxide/l1-contracts"
import {
  broadcastL1Operation,
  broadcastL1OperationPair,
  type L1OperationBroadcaster,
  type L1OperationPairBroadcaster,
} from "@oxide/oxide-client/broadcaster_calls.js"
import { notifySipaRecipient, type SipaNotifier } from "@oxide/oxide-client/sipa_event_calls.js"
import {
  encodeL1OperationCalldata,
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { erc20Abi, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem"
import { chunkedContractEvents } from "../helpers/l1Logs.js"

/**
 * An unset pointer reads as the zero address rather than reverting. Deriving over it yields an
 * address whose clone can never run code, so a deposit sent there is unreachable. Fail closed.
 */
function requireBlessedImplementation(implementation: Address, family: string): Address {
  if (/^0x0+$/i.test(implementation)) {
    throw new Error(`SIPAFactory has no ${family} implementation`)
  }
  return implementation
}

/** The deposit implementation new SIPAs clone (`SIPAFactory.implementationFor`). */
export async function readDepositSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
): Promise<Address> {
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    OxideSipaIntent.Deposit,
  )
  return requireBlessedImplementation(implementation, "deposit")
}

/** The registration implementation new SIPAs clone. */
export async function readRegistrationSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
): Promise<Address> {
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    OxideSipaIntent.Registration,
  )
  return requireBlessedImplementation(implementation, "registration")
}

/** The user-op implementation new SIPAs clone. */
export async function readUserOpSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
): Promise<Address> {
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    OxideSipaIntent.UserOp,
  )
  return requireBlessedImplementation(implementation, "user-op")
}

/**
 * Every implementation the factory has blessed for `intent`, the one new SIPAs clone first. A bless
 * replaces that one and keeps the earlier ones blessed, so a SIPA predicted on an earlier
 * implementation still has code and still sweeps. Blesses are few and indexed, so the factory's
 * whole history is one request where the RPC allows it. Where it does not, the read covers
 * `fromBlock` to the head and misses an implementation blessed earlier and since replaced.
 */
export async function readBlessedImplementations(
  publicClient: PublicClient,
  sipaFactory: Address,
  intent: OxideSipaIntent,
  fromBlock = 0n,
): Promise<Address[]> {
  const [current, head] = await Promise.all([
    readSIPAImplementation(publicClient, sipaFactory, intent),
    publicClient.getBlockNumber(),
  ])
  const request = {
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    eventName: "ImplementationBlessed",
    args: { intent },
  }
  const logs = (await publicClient
    .getContractEvents({ ...request, fromBlock: 0n, toBlock: head } as never)
    .catch(() => chunkedContractEvents(publicClient, request, fromBlock, head))) as {
    args: { implementation: Address; intent: number | bigint }
  }[]
  const seen = new Set<string>()
  const blessed: Address[] = []
  const add = (implementation: Address) => {
    if (/^0x0+$/i.test(implementation) || seen.has(implementation.toLowerCase())) return
    seen.add(implementation.toLowerCase())
    blessed.push(implementation)
  }
  add(current)
  for (const { args } of logs) if (Number(args.intent) === intent) add(args.implementation)
  return blessed
}

/**
 * The intent a deployed clone was cloned for, as the factory derives it from the clone's own code
 * and arguments: `None` for an address that is not one of its clones.
 */
export async function readSipaIntent(
  publicClient: PublicClient,
  sipaFactory: Address,
  clone: Address,
): Promise<OxideSipaIntent> {
  return Number(
    await publicClient.readContract({
      address: sipaFactory,
      abi: SIPAFactoryAbi,
      functionName: "sipaIntentOf",
      args: [clone],
    }),
  ) as OxideSipaIntent
}

/**
 * The implementation a deployed clone delegates to, read from the clone's own code. The zero address
 * for an address without a clone's code.
 */
export async function readSipaCloneImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
  clone: Address,
): Promise<Address> {
  return (await publicClient.readContract({
    address: sipaFactory,
    abi: SIPAFactoryAbi,
    functionName: "cloneImplementation",
    args: [clone],
  })) as Address
}

/**
 * `DepositSubsidy.$depositConfig()`: the profit the subsidy pays a relayer on top of the gas it
 * prices (the sweep fee caps it), the most it pays for one sweep, and the least a sweep must credit
 * on L2 to be paid at all.
 */
export interface DepositSubsidyConfig {
  targetRelayerProfit: bigint
  maxSubsidyPerOperation: bigint
  minCreditedAmount: bigint
}

export async function readDepositSubsidyConfig(
  publicClient: PublicClient,
  depositSubsidy: Address,
): Promise<DepositSubsidyConfig> {
  const [targetRelayerProfit, maxSubsidyPerOperation, minCreditedAmount] =
    (await publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "$depositConfig",
    })) as readonly [bigint, bigint, bigint]
  return { targetRelayerProfit, maxSubsidyPerOperation, minCreditedAmount }
}

export type SweepRouteDeadReason =
  | "the forwarding table has no row for the token and intent"
  | "the subsidy pays no relayer profit"
  | "the row's tip is zero, so the subsidy pays no relayer profit"
  | "the subsidy's cap is zero"
  | "the subsidy holds none of the token"

export type SweepRouteLiveness =
  | { live: true; row: ForwardingTableRow; config: DepositSubsidyConfig; balance: bigint }
  | { live: false; reason: SweepRouteDeadReason }

/**
 * Whether a sweep of `token` for `intent` is configured to pay a relayer: the row exists, the
 * subsidy pays a profit on top of the gas, and it can pay. Configuration only; a quote says
 * whether it pays enough.
 */
export async function readSweepRouteLiveness(
  publicClient: PublicClient,
  args: {
    forwardingTable: Address
    token: Address
    depositSubsidy: Address
    intent: OxideSipaIntent
  },
): Promise<SweepRouteLiveness> {
  const [row, config, balance] = await Promise.all([
    readForwardingTableRow(publicClient, args.forwardingTable, args.token, args.intent),
    readDepositSubsidyConfig(publicClient, args.depositSubsidy),
    publicClient.readContract({
      address: args.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [args.depositSubsidy],
    }),
  ])
  if (!row)
    return { live: false, reason: "the forwarding table has no row for the token and intent" }
  if (config.targetRelayerProfit === 0n) {
    return { live: false, reason: "the subsidy pays no relayer profit" }
  }
  if (row.sweepTip === 0n) {
    return { live: false, reason: "the row's tip is zero, so the subsidy pays no relayer profit" }
  }
  if (config.maxSubsidyPerOperation === 0n) {
    return { live: false, reason: "the subsidy's cap is zero" }
  }
  if (balance === 0n) return { live: false, reason: "the subsidy holds none of the token" }
  return { live: true, row, config, balance }
}

/** A built intent: what a SIPA commits to plus what the sweep reveals. */
export interface SipaIntent {
  /** The intent-type implementation each SIPA clones (`DepositSIPA` / `RegistrationSIPA`). */
  implementation: Address
  /** `keccak256(intentData)` — the single committed word, baked into the clone. */
  intentHash: Hex
  /** The abi-encoded intent record, re-hashed against `intentHash` at sweep. */
  intentData: Hex
  /** Non-committed data the intent's `_execute` consumes; `0x` for a deposit. */
  proofs: Hex
}

/**
 * The deposit intent: forward the whole balance to an L2 recipient, no fee, no side effect.
 * `implementation` is the factory's `implementationFor(Deposit)`.
 */
export function buildDepositIntent(params: {
  implementation: Address
  recipientCommitment: Hex
}): SipaIntent {
  const intentData = encodeDepositIntentData(params.recipientCommitment)
  return {
    implementation: params.implementation,
    intentHash: keccak256(intentData),
    intentData,
    proofs: "0x",
  }
}

/**
 * The registration intent: register the identity record, fee to the beneficiary, remainder to the
 * owner. `implementation` is the factory's `implementationFor(Registration)`.
 */
export function buildRegistrationIntent(params: {
  implementation: Address
  intent: RegistrationIntent
  consentSig: Hex
  bootstrap: Address
  domainAuth: DomainAuthArg
  signedTerms: SignedTermsArg
  r1Install: R1InstallArg
}): SipaIntent {
  const intentData = encodeRegistrationIntentData(params.intent)
  const proofs = encodeRegistrationProofs({
    consentSig: params.consentSig,
    bootstrap: params.bootstrap,
    domainAuth: params.domainAuth,
    signedTerms: params.signedTerms,
    r1Install: params.r1Install,
  })
  return {
    implementation: params.implementation,
    intentHash: keccak256(intentData),
    intentData,
    proofs,
  }
}

/** Split a `bytes32` intentHash into the two big-endian u128 limbs the `SIPA` event carries. */
export function splitIntentHash(intentHash: Hex): { hi: bigint; lo: bigint } {
  const value = BigInt(intentHash)
  return { hi: value >> 128n, lo: value & ((1n << 128n) - 1n) }
}

/** Recombine the event's two big-endian u128 limbs back into the `bytes32` intentHash. */
export function joinIntentHash(hi: bigint, lo: bigint): Hex {
  return toHex((hi << 128n) | lo, { size: 32 })
}

/** What the recipient of a SIPA learns from its `SIPA` event. */
export interface SipaNotification {
  recipient: AztecAddress
  sharedSecretSalt: Fr
  resweepable: boolean
  /** `keccak256(intentData)`, the word the SIPA address commits to. */
  intentHash: Hex
}

/** The Broadcaster calls a SIPA broadcast makes: one operation per call, or two in the pair tier. */
export type SipaOperationBroadcaster = L1OperationBroadcaster & L1OperationPairBroadcaster

const fitsPairTier = (operation: BroadcastL1Operation) =>
  encodeL1OperationCalldata(operation.calldata).tier.method === "broadcast_l1_operation_2k"

/**
 * Publish a SIPA: the token's `SIPA` event to its recipient, then the L1 operations that sweep it. The calls must ride
 * one L2 tx, and a sponsored tx carries at most `MAX_SPONSORED_CALLS`, so operations that fit the 2k tier ride two per
 * call.
 */
export function buildSipaBroadcast(
  token: SipaNotifier,
  broadcaster: SipaOperationBroadcaster,
  notification: SipaNotification,
  operations: BroadcastL1Operation[],
): ContractFunctionInteraction[] {
  const { recipient, ...event } = notification
  const pairable = operations.filter(fitsPairTier)
  const pairs = Array.from({ length: Math.floor(pairable.length / 2) }, (_, i) =>
    broadcastL1OperationPair(broadcaster, [pairable[2 * i]!, pairable[2 * i + 1]!]),
  )
  const singles = [
    ...operations.filter((operation) => !fitsPairTier(operation)),
    ...pairable.slice(pairs.length * 2),
  ].map((operation) => broadcastL1Operation(broadcaster, operation))
  return [notifySipaRecipient(token, recipient, event), ...pairs, ...singles]
}

/** Re-exported so a caller names the intent/auth shapes the builders take from one import site. */
export type { RegistrationIntent, DomainAuthArg }
export type { RegistrationProofs, R1InstallArg, K1PointArg } from "@oxide/l1-contracts"
/** Re-exported so an out-of-workspace caller (the web wallet's registration broadcast) can assemble a
 *  registration intent's `proofs` without importing the vendored package directly. */
export { encodeRegistrationProofs, encodeLegacyRegistrationProofs } from "@oxide/l1-contracts"

export {
  buildSipaDeployAndSweepOperation,
  predictAccountAddress,
  predictAccountAddressLocally,
  encodeAccountInitCode,
  depositPayoutTokenFor,
  SipaIntent as OxideSipaIntent,
} from "@oxide/l1-contracts"
export { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
export { predictLegacySIPA } from "@oxide/l1-contracts/legacy_sipa.js"

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** One token a SIPA broadcast sweeps, through the deposit subsidy of the row the sweep settles on. */
export interface SipaSweepRoute {
  /** The token the SIPA is funded with: the swept token and the balance the relayer waits for. */
  token: Address
  /** The settling row's portal. */
  portal: Address
  /** The settling row's subsidy. It pays the sweep and must serve `portal`. */
  depositSubsidy: Address
}

/** The SIPA a deploy-and-sweep must deploy, and the routes whose subsidies deploy it. */
export interface SubsidySweepTarget {
  routes: readonly Pick<SipaSweepRoute, "portal" | "depositSubsidy">[]
  sipaFactory: Address
  intent: OxideSipaIntent
  deployArgs: SipaDeployArgs
  intentData: Hex
  sipa: Address
}

/**
 * `DepositSubsidy.deployAndSweepForSubsidy` deploys the SIPA it derives from its own factory and rollup version and
 * the broadcast's table, and sweeps only into its own portal. Refuse to publish unless every route's subsidy deploys
 * `sipa` and serves the route's portal: otherwise a funded address is never swept. A SIPA that has code is swept as is.
 */
export async function assertSubsidySweepsSipa(
  publicClient: PublicClient,
  params: SubsidySweepTarget,
): Promise<void> {
  const portals = new Map<string, Address>()
  for (const { depositSubsidy, portal } of params.routes) {
    const known = portals.get(depositSubsidy.toLowerCase())
    if (known && !sameAddress(known, portal)) {
      throw new Error(
        `Deposit subsidy ${depositSubsidy} is routed for portals ${known} and ${portal}`,
      )
    }
    portals.set(depositSubsidy.toLowerCase(), portal)
  }
  if (!portals.size) throw new Error("A SIPA broadcast needs at least one sweep route")
  await Promise.all(
    [...portals].map(([depositSubsidy, portal]) =>
      assertOneSubsidySweepsSipa(publicClient, {
        ...params,
        depositSubsidy: depositSubsidy as Address,
        portal,
      }),
    ),
  )
}

async function assertOneSubsidySweepsSipa(
  publicClient: PublicClient,
  params: Omit<SubsidySweepTarget, "routes"> & { depositSubsidy: Address; portal: Address },
): Promise<void> {
  const { depositSubsidy, deployArgs } = params
  const [portal, sipaFactory, rollupVersion] = await Promise.all([
    publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "PORTAL",
    }),
    publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "SIPA_FACTORY",
    }),
    publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "ROLLUP_VERSION",
    }),
  ])
  const refuse = (reason: string) => {
    throw new Error(
      `Deposit subsidy ${depositSubsidy} would not sweep SIPA ${params.sipa}: ${reason}`,
    )
  }
  if (!sameAddress(portal, params.portal))
    refuse(`it serves portal ${portal}, not ${params.portal}`)
  if (!sameAddress(sipaFactory, params.sipaFactory)) refuse(`it deploys through ${sipaFactory}`)
  const intentHash = keccak256(params.intentData)
  if (intentHash.toLowerCase() !== deployArgs.intentHash.toLowerCase()) {
    refuse(`the intent data hashes to ${intentHash}, not ${deployArgs.intentHash}`)
  }
  const implementation = await readSIPAImplementation(publicClient, sipaFactory, params.intent)
  if (!sameAddress(implementation, deployArgs.implementation)) {
    refuse(`the factory's implementation is ${implementation}`)
  }
  const predicted = await predictSIPA(
    publicClient,
    sipaFactory,
    implementation,
    intentHash,
    deployArgs.recoveryCommitment,
    rollupVersion,
    deployArgs.resweepable,
    deployArgs.forwardingTable,
  )
  if (!sameAddress(predicted, params.sipa)) refuse(`it would deploy ${predicted}`)
}

/**
 * Publish a SIPA with one sweep operation per route, deploying it first when it has no code. A relayer never rewrites
 * an operation, so a token without a route is never swept.
 */
export function buildSipaSweepBroadcasts(
  notifier: SipaNotifier,
  broadcaster: SipaOperationBroadcaster,
  params: SipaNotification & {
    sipa: Address
    deployed: boolean
    sipaFactory: Address
    intent: OxideSipaIntent
    deployArgs: SipaDeployArgs | LegacySipaDeployArgs
    intentData: Hex
    proofs: Hex
    operationExecutor: Address
    chainId: bigint
    routes: readonly SipaSweepRoute[]
  },
): ContractFunctionInteraction[] {
  const byToken = new Map<string, SipaSweepRoute>()
  for (const route of params.routes) {
    const known = byToken.get(route.token.toLowerCase())
    if (
      known &&
      (!sameAddress(known.depositSubsidy, route.depositSubsidy) ||
        !sameAddress(known.portal, route.portal))
    ) {
      throw new Error(`Token ${route.token} is routed through two rows`)
    }
    byToken.set(route.token.toLowerCase(), known ?? route)
  }
  const routes = [...byToken.values()]
  if (!routes.length) throw new Error("A SIPA broadcast needs at least one sweep route")
  return buildSipaBroadcast(
    notifier,
    broadcaster,
    params,
    routes.map(({ token, depositSubsidy }) => {
      const sweep = {
        sipa: params.sipa,
        sweepArgs: {
          token,
          relayer: params.operationExecutor,
          intentData: params.intentData,
          proofs: params.proofs,
        },
        depositSubsidy,
        payoutToken: depositPayoutTokenFor(
          params.chainId,
          EthAddress.fromString(token),
        ).toString() as Address,
        condition: L1OperationCondition.balance(
          EthAddress.fromString(token),
          EthAddress.fromString(params.sipa),
        ),
      }
      return params.deployed
        ? buildSipaSweepOperation(sweep)
        : buildSipaDeployAndSweepOperation({
            ...sweep,
            sipaFactory: params.sipaFactory,
            intent: params.intent,
            deployArgs: params.deployArgs,
          })
    }),
  )
}

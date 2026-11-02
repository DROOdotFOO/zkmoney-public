/**
 * Moves into and out of Sky savings run through a `SkyEscrow`, which pays whoever runs it a DAI tip. The
 * tip is priced the way the swap escrow's is, by oxide's relayer quote: the relayer's exact
 * `OperationExecutor.execute`, simulated against the counterfactual escrow funded by state override.
 */
import {
  SkyEscrowFactoryAbi,
  SkyRoute,
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
  type SkyEscrowArgs,
} from "@oxide/experiments/sky/sky_savings.js"
import { PlainWithdrawalSubsidyAbi, encodeEscrowRecoverERC20 } from "@oxide/l1-contracts"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  estimateL1OperationFeeValues,
} from "@oxide/oxide-client/l1_operation_quote.js"
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  multicall3Abi,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { MULTICALL3_ADDRESS } from "../../services/sipa/sipaClaim.js"
import { quoteL1OperationTip, type RelayerTipEstimate } from "../tip/l1OperationQuote.js"
import type { SwapEscrowCall, SwapRecovery } from "./swapOnWithdraw.js"
import { findBalanceOfSlot, mappingSlot } from "./swapOnWithdrawSimulator.js"
import {
  PAR_TIP_TOKEN,
  netOfSubsidy,
  readTipPrices,
  tipQuote,
  withTipMargin,
  type TipTokenPrice,
} from "../tip/tipQuote.js"

/** The run opens neither commitment; both only need to be nonzero and field-sized. */
const SIMULATION_COMMITMENT = `0x00${keccak256(
  new TextEncoder().encode("obsidion.sky-savings.simulation"),
).slice(4)}` as const
const SIMULATION_NONCE = keccak256(
  new TextEncoder().encode("obsidion.sky-savings.simulation-nonce"),
)
/** Every Sky savings tip is paid in DAI, a move out's after the redeem, so sUSDS's vault rate never prices one. */
export const SKY_TIP_TOKEN: TipTokenPrice = PAR_TIP_TOKEN

/** Gas depends on whether the tip transfer writes a nonzero balance, not on the amount, so 1 wei prices any tip. */
const SIMULATION_TIP = 1n

export interface SkyEscrowDeployment {
  skyEscrowFactory: Address
  operationExecutor: Address
  /** What the escrow holds and pays its tip in: DAI on both routes. */
  dai: Address
  /** A withdrawal subsidy on the same chain; its `PRICE_FEED` prices the relayer's gas. */
  withdrawalSubsidy: Address
}

/** The escrow would hold too little to pay the tip that runs it. */
export class SkyTipExceedsFundingError extends RangeError {
  constructor(readonly tip: RelayerTipEstimate, readonly escrowFunding: bigint) {
    super(
      `sky savings: the relayer tip ${tip.relayerTip} leaves nothing of the ${escrowFunding} escrowed`,
    )
  }
}

export async function quoteSkyEscrowTip(
  client: Pick<
    PublicClient,
    "getBlock" | "estimateMaxPriorityFeePerGas" | "simulateBlocks" | "readContract"
  >,
  deployment: SkyEscrowDeployment,
  args: {
    route: SkyRoute
    /** DAI the release leaves at the escrow. */
    escrowFunding: bigint
    /** Whoever sends the run in the simulation; any address. */
    sender: Address
  },
): Promise<RelayerTipEstimate> {
  const escrowArgs: SkyEscrowArgs = {
    route: args.route,
    recipientCommitment: SIMULATION_COMMITMENT,
    recoveryCommitment: SIMULATION_COMMITMENT,
    relayerTip: SIMULATION_TIP,
    nonce: SIMULATION_NONCE,
  }
  const escrow = predictSkyEscrowAddressLocally(deployment.skyEscrowFactory, escrowArgs)
  const [balanceOfSlot, ethUsdFeed] = await Promise.all([
    findBalanceOfSlot(client, deployment.dai),
    client.readContract({
      address: deployment.withdrawalSubsidy,
      abi: PlainWithdrawalSubsidyAbi,
      functionName: "PRICE_FEED",
    }),
  ])
  const tip = await quoteL1OperationTip(client, {
    executor: deployment.operationExecutor,
    sender: args.sender,
    eth: { feed: ethUsdFeed },
    token: SKY_TIP_TOKEN,
    payout: SIMULATION_TIP,
    operation: {
      target: deployment.skyEscrowFactory,
      calldata: encodeSkyEscrowDeploy(escrowArgs),
      payoutToken: deployment.dai,
    },
    stateOverrides: [
      {
        address: deployment.dai,
        stateDiff: [
          {
            slot: mappingSlot(escrow, balanceOfSlot),
            value: numberToHex(args.escrowFunding, { size: 32 }),
          },
        ],
      },
    ],
  })
  if (args.escrowFunding <= tip.relayerTip)
    throw new SkyTipExceedsFundingError(tip, args.escrowFunding)
  return tip
}

/**
 * Gas a move's release uses through the relayer's `OperationExecutor`. A stake's is a plain DAI release, as measured
 * on the sandbox. An unstake's adds the Sky executor's redeem and conversion, measured on mainnet by oxide's
 * `SkySavings.fork.t.sol` as the difference between its two releases.
 */
export const SKY_RELEASE_GAS: Record<SkyRoute, bigint> = {
  [SkyRoute.Stake]: 215_000n,
  [SkyRoute.Unstake]: 335_000n,
}

/** `IExecutor.Flow.Withdrawal`. */
const WITHDRAWAL_FLOW = 0

/**
 * The DAI tip a move's release offers: the relayer's floor for the release less the withdrawal subsidy it collects,
 * and nothing once the subsidy covers it. The relayer runs each L1 operation only when that operation pays for
 * itself, so the escrow tip cannot pay for the release. A release cannot be simulated before its proof lands, so
 * oxide's quote prices its measured gas.
 */
export async function quoteSkyReleaseTip(
  client: Pick<PublicClient, "call" | "getBlock" | "estimateMaxPriorityFeePerGas" | "readContract">,
  /** The source deployment's withdrawal subsidy, which the release claims. */
  withdrawalSubsidy: Address,
  route: SkyRoute,
): Promise<RelayerTipEstimate & { subsidy: bigint }> {
  const [block, feed, feeValues] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    client.readContract({
      address: withdrawalSubsidy,
      abi: PlainWithdrawalSubsidyAbi,
      functionName: "PRICE_FEED",
    }),
    estimateL1OperationFeeValues(client),
  ])
  const baseFee = block.baseFeePerGas ?? 0n
  const [prices, quoted] = await Promise.all([
    readTipPrices(client, { eth: { feed }, token: SKY_TIP_TOKEN }),
    // The subsidy pays at the release's gas price: the base fee plus the relayer's priority fee.
    client.call({
      to: withdrawalSubsidy,
      data: encodeFunctionData({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        args: [WITHDRAWAL_FLOW],
      }),
      gasPrice: baseFee + feeValues.maxPriorityFeePerGas,
    }),
  ])
  const subsidy = quoted.data
    ? decodeFunctionResult({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        data: quoted.data,
      })
    : 0n
  const gasUsed = SKY_RELEASE_GAS[route]
  // The relayer covers the two gas-cost words of the executor call, as oxide's quote does.
  const minPayout = tipQuote(prices, {
    gasToCover: gasUsed + 2n * UINT256_EXTRA_CALLDATA_GAS,
    block,
    feeValues,
  })
  // The margin covers the whole release: the subsidy is capped and can drain, so it need not rise with gas.
  return {
    relayerTip: netOfSubsidy(withTipMargin(minPayout), subsidy),
    minPayout,
    gasUsed,
    maxFeePerGas: feeValues.maxFeePerGas,
    usdPerEth: prices.usdPerEth,
    baseFee,
    priorityFee: feeValues.maxPriorityFeePerGas,
    subsidy,
  }
}

/** Run a Sky escrow nobody relayed: `deployAndExecute(args)`, which pays the sender its tip. Any EOA can send it. */
export function buildSkyEscrowRunCall(factory: Address, args: SkyEscrowArgs): SwapEscrowCall {
  return { to: factory, data: encodeSkyEscrowDeploy(args) }
}

/**
 * `recoverERC20` on a Sky escrow, signed by its recovery account. An escrow that never ran has no code,
 * so the factory's deploy-only `deploy` and the recovery then ride one Multicall3 `aggregate3`, as the
 * swap escrow's recovery does. Any EOA can send it.
 */
export function buildSkyEscrowRecoverCall(params: {
  deployed: boolean
  factory: Address
  escrow: Address
  args: SkyEscrowArgs
  recovery: SwapRecovery
  signature: Hex
  target: Address
  token: Address
  nonce: Hex
  /** Unix seconds after which the escrow refuses the signature. */
  deadline: bigint
}): SwapEscrowCall {
  const recoverData = encodeEscrowRecoverERC20({
    recoverySalt: params.recovery.salt.toString() as Hex,
    account: params.recovery.account,
    signature: params.signature,
    target: params.target,
    token: params.token,
    nonce: params.nonce,
    deadline: params.deadline,
  })
  if (params.deployed) return { to: params.escrow, data: recoverData }
  const deploy = encodeFunctionData({
    abi: SkyEscrowFactoryAbi,
    functionName: "deploy",
    args: [params.args],
  })
  const calls = [
    { target: params.factory, allowFailure: false, callData: deploy },
    { target: params.escrow, allowFailure: false, callData: recoverData },
  ]
  return {
    to: MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

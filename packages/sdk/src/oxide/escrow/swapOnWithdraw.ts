import type { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  LegacySwapEscrowFactoryAbi,
  MAX_DAI_FOR_GAS,
  SwapEscrowFactoryAbi,
  SwapRoute,
  encodeEscrowRecoverERC20,
  encodeLegacySwapEscrowDeploy,
  encodeSwapEscrowDeploy,
  predictLegacySwapEscrowAddressLocally,
  predictSwapEscrowAddressLocally,
  type LegacySwapEscrowArgs,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { encodeFunctionData, multicall3Abi } from "viem"
import type { Address, Hex } from "viem"
import type { SwapEscrowOutput } from "@obsidion/core/types"
import { MULTICALL3_ADDRESS } from "../../services/sipa/sipaClaim.js"

/** The escrow's committed values, re-exported so consumers name the vendored types directly. */
export type { LegacySwapEscrowArgs, SwapEscrowArgs } from "@oxide/l1-contracts"
export { SWAP_ON_WITHDRAW_OUTPUTS } from "@obsidion/core/constants"
export type { SwapEscrowOutput, SwapOnWithdrawOutput } from "@obsidion/core/types"
/** The most DAI one escrow swaps to ETH for gas. */
export { MAX_DAI_FOR_GAS }

/**
 * The values an escrow address commits to, in the layout of the factory that derives it. Every new
 * withdrawal is `v2`. A `legacy` escrow comes from a factory without `daiForGas`; it can still need
 * its swap run or its DAI recovered.
 */
export type SwapEscrowCommitment =
  | { layout: "v2"; args: SwapEscrowArgs }
  | { layout: "legacy"; args: LegacySwapEscrowArgs }

export type SwapEscrowLayout = SwapEscrowCommitment["layout"]

export function predictSwapEscrow(factory: Address, commitment: SwapEscrowCommitment): Address {
  return commitment.layout === "v2"
    ? predictSwapEscrowAddressLocally(factory, commitment.args)
    : predictLegacySwapEscrowAddressLocally(factory, commitment.args)
}

/** `factory.deployAndExecute(args)` calldata in the escrow's layout. */
export function encodeSwapEscrowExecute(commitment: SwapEscrowCommitment): Hex {
  return commitment.layout === "v2"
    ? encodeSwapEscrowDeploy(commitment.args)
    : encodeLegacySwapEscrowDeploy(commitment.args)
}

/** `factory.deploy(args)` calldata in the escrow's layout: the clone without the swap. */
function encodeSwapEscrowDeployOnly(commitment: SwapEscrowCommitment): Hex {
  return commitment.layout === "v2"
    ? encodeFunctionData({
        abi: SwapEscrowFactoryAbi,
        functionName: "deploy",
        args: [commitment.args],
      })
    : encodeFunctionData({
        abi: LegacySwapEscrowFactoryAbi,
        functionName: "deploy",
        args: [commitment.args],
      })
}

/**
 * A swap-on-withdraw, planned before the burn: the withdrawal pays a counterfactual `SwapEscrow`
 * whose CREATE2 address commits to `escrowArgs`. The burn and the broadcast that tells relayers to
 * run the swap are built from `escrowArgs` by `planWithdrawal`, through oxide-client's
 * `buildSwapOnWithdraw`, and ride one L2 tx.
 */
export interface SwapOnWithdrawPlan {
  /** The counterfactual escrow the withdrawal must burn to. */
  escrow: Address
  /** The values the escrow address commits to. Persist them with the withdrawal record: they
   *  rebuild the factory `deployAndExecute` call if the broadcast ever has to be re-sent by hand
   *  (relayers only retain its calldata for the submitted→finalized window). */
  escrowArgs: SwapEscrowArgs
  /** `SwapEscrowFactory.deployAndExecute(escrowArgs)` calldata — the broadcast payload. */
  deployCalldata: Hex
  recovery: SwapRecovery
}

/**
 * Who can take back DAI the swap route cannot deliver: `account` signs `recoverERC20` through
 * ERC-1271, and `salt` hides it in the escrow's `recoveryCommitment`.
 */
export interface SwapRecovery {
  account: Address
  salt: Fr
}

const ROUTE_BY_OUTPUT: Record<SwapEscrowOutput, SwapRoute> = {
  USDC: SwapRoute.USDC,
  USDT: SwapRoute.USDT,
  ETH: SwapRoute.ETH,
  DAI: SwapRoute.DAI,
}

export function swapRouteForOutput(output: SwapEscrowOutput): SwapRoute {
  return ROUTE_BY_OUTPUT[output]
}

/** Inverse of `swapRouteForOutput`; undefined for a route id no output maps to. */
export function swapOutputForRoute(route: number): SwapEscrowOutput | undefined {
  return (Object.keys(ROUTE_BY_OUTPUT) as SwapEscrowOutput[]).find(
    (output) => ROUTE_BY_OUTPUT[output] === route,
  )
}

/** Everything the portal, the executor and the escrow take out of a burn before the swap runs. */
export interface SwapDeductions {
  /** The plain withdrawal executor's `FEE()`. */
  withdrawalFee: bigint
  /** The relayer tip the plain withdrawal executor pays out of the burn. */
  withdrawalRelayerTip: bigint
  proverTip: bigint
  /** DAI the escrow pays whoever completes the swap. */
  relayerTip: bigint
}

/**
 * What the escrow actually swaps: the burn minus every deduction ahead of it. The portal takes the
 * prover tip, the executor takes its fee and pays the withdrawal relayer tip, then the escrow holds
 * back its own relayer tip, so this — not the typed amount — is the quote's exact input and the
 * amount the route must be able to fill.
 */
export function swapInputAmount(amount: bigint, deductions: SwapDeductions): bigint {
  return (
    amount -
    deductions.withdrawalFee -
    deductions.withdrawalRelayerTip -
    deductions.proverTip -
    deductions.relayerTip
  )
}

export function planSwapOnWithdraw(args: {
  /** The manifest's `swapEscrowFactoryV2`: the factory whose `Args` carry `daiForGas`. */
  swapEscrowFactoryV2: Address
  output: SwapEscrowOutput
  /** Final L1 recipient of the swap output. It must accept ETH on the ETH route and with `daiForGas`. */
  l1Recipient: Address
  /** DAI of the escrow's balance it swaps to ETH for `l1Recipient` before the route. Defaults to 0. */
  daiForGas?: bigint
  recovery: SwapRecovery
  /** The gross burn amount, raw token units. */
  amount: bigint
  withdrawalFee: bigint
  withdrawalRelayerTip: bigint
  proverTip: bigint
  /** DAI the escrow pays whoever completes the swap. */
  relayerTip: bigint
  /**
   * Per-withdrawal value the escrow address commits to; the caller allocates it because the
   * recovery salt may be derived from it before the plan exists.
   */
  nonce: Hex
}): SwapOnWithdrawPlan {
  // The factory executes only once the escrow balance EXCEEDS the tip, so a swap input at or below
  // zero leaves the operation deferring forever.
  const { daiForGas = 0n } = args
  const swapInput = swapInputAmount(args.amount, args)
  if (swapInput <= daiForGas) {
    throw new Error(
      `planSwapOnWithdraw: nothing left to swap — amount ${args.amount} minus withdrawalFee ` +
        `${args.withdrawalFee}, withdrawalRelayerTip ${args.withdrawalRelayerTip}, proverTip ${args.proverTip} ` +
        `and relayerTip ${args.relayerTip} leaves ${swapInput}, with ${daiForGas} of it for gas`,
    )
  }
  // No key signs for the zero address, so the escrow could never be recovered.
  if (BigInt(args.recovery.account) === 0n) {
    throw new Error("planSwapOnWithdraw: the recovery account must be nonzero")
  }
  const escrowArgs: SwapEscrowArgs = {
    route: swapRouteForOutput(args.output),
    recipient: args.l1Recipient,
    daiForGas,
    // 0: the gas swap is at most MAX_DAI_FOR_GAS, too small to sandwich at a profit, and a floor it
    // missed would revert the whole escrow, funds included.
    minEthForGas: 0n,
    recoveryCommitment: deriveRecoveryCommitment(
      args.recovery.salt,
      EthAddress.fromString(args.recovery.account),
    ).toString() as Hex,
    relayerTip: args.relayerTip,
    nonce: args.nonce,
  }
  return {
    escrow: predictSwapEscrowAddressLocally(args.swapEscrowFactoryV2, escrowArgs),
    escrowArgs,
    deployCalldata: encodeSwapEscrowDeploy(escrowArgs),
    recovery: args.recovery,
  }
}

/** An L1 transaction target + calldata for the user's own channel to submit. */
export interface SwapEscrowCall {
  to: Address
  data: Hex
}

/** `SwapEscrowFactory.deployAndExecute(args)`: run the swap and keep the tip — the permissionless self-execution path. */
export function buildSwapEscrowExecuteCall(
  factory: Address,
  commitment: SwapEscrowCommitment,
): SwapEscrowCall {
  return { to: factory, data: encodeSwapEscrowExecute(commitment) }
}

/**
 * `SwapEscrow.recoverERC20`, the escape hatch for DAI the committed route cannot deliver: the
 * recovery account's ERC-1271 signature over `escrowERC20RecoveryDigest`, plus the salt and
 * account that open the escrow's `recoveryCommitment`. A reverting `deployAndExecute` unwinds the
 * clone, so an escrow whose swap never ran has no code: the deploy-only `deploy` leg and the
 * recovery then ride one Multicall3 `aggregate3`, all-or-nothing, the way {@link buildSipaSweepCall}
 * deploys and sweeps a SIPA. Any EOA can submit.
 */
export function buildSwapEscrowRecoverCall(params: {
  /** Whether the escrow already has code (`getCode` non-empty). */
  deployed: boolean
  factory: Address
  escrow: Address
  commitment: SwapEscrowCommitment
  recovery: SwapRecovery
  signature: Hex
  target: Address
  token: Address
  nonce: Hex
  /** Unix seconds after which the escrow refuses the signature. */
  deadline: bigint
  multicall3?: Address
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
  if (params.deployed) {
    return { to: params.escrow, data: recoverData }
  }
  const calls = [
    {
      target: params.factory,
      allowFailure: false,
      callData: encodeSwapEscrowDeployOnly(params.commitment),
    },
    { target: params.escrow, allowFailure: false, callData: recoverData },
  ]
  return {
    to: params.multicall3 ?? MULTICALL3_ADDRESS,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
  }
}

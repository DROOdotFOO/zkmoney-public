/**
 * Prices a swap-on-withdraw: the relayer tip its escrow commits to, quoted on the exact L1 operation the relayer
 * will send, `OperationExecutor.execute` of `factory.deployAndExecute(args)` paid in DAI, with the counterfactual
 * escrow funded by a state override.
 *
 * The same simulation runs the swap, so the payout estimate is the executed route (3pool for the stables,
 * 3pool + Universal Router for ETH, the DAI itself on the DAI route) and any gas swap on the live pools, exact to
 * the wei at simulation time.
 */
import {
  SwapEscrowAbi,
  SwapEscrowFactoryAbi,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  multicall3Abi,
  numberToHex,
  slice,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import type { SwapEscrowOutput } from "@obsidion/core/types"
import { MULTICALL3_ADDRESS } from "../../services/sipa/sipaClaim.js"
import { quoteL1OperationTip, type RelayerTipEstimate } from "../tip/l1OperationQuote.js"
import { swapRouteForOutput, type SwapDeductions } from "./swapOnWithdraw.js"

const MULTICALL3_ETH_BALANCE_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const

type Multicall3Call = { target: Address; allowFailure: boolean; callData: Hex }

/** Storage slots probed for the token's `balanceOf` mapping. DAI keeps it at 2, OpenZeppelin's ERC20 at 0. */
const BALANCE_SLOT_CANDIDATES = 32
const BALANCE_SLOT_MARKER = 1n << 128n
const BALANCE_PROBE_HOLDER = "0x1111111111111111111111111111111111111111" as Address

/**
 * The simulated escrow's nonce. Only the tip has to match the real escrow; its address does not, and the
 * real nonce is drawn by the gateway when the withdrawal is built.
 */
const SIMULATION_NONCE = keccak256(new TextEncoder().encode("obsidion.swap-on-withdraw.simulation"))
/** The execution path never reads the recovery commitment; it only has to be nonzero. */
const SIMULATION_RECOVERY_COMMITMENT = keccak256(
  new TextEncoder().encode("obsidion.swap-on-withdraw.simulation-recovery"),
)
/**
 * The tip the quote simulates with. Gas depends on whether each tip transfer writes a nonzero balance, not on the
 * amount, so 1 wei prices any committed tip.
 */
const SIMULATION_TIP = 1n
/**
 * Sends the simulated `execute`, as the relayer sends from its own EOA. The recipient as sender would be warm and
 * funded, pricing its gas low.
 */
const SIMULATION_SENDER = slice(
  keccak256(new TextEncoder().encode("obsidion.swap-on-withdraw.simulation-sender")),
  12,
) as Address

export type { RelayerTipEstimate }

export interface SwapSimulation extends RelayerTipEstimate {
  /** What the recipient receives, in the output asset's smallest unit. */
  amountOut: bigint
  /** Decimal exponent of `amountOut`. Read off the output token; ETH is 18. */
  decimals: number
  /** ETH the gas swap pays the recipient, wei. 0 without `daiForGas`. */
  gasOut: bigint
}

/** The tip is known but the amount leaves the escrow nothing to swap after paying it. */
export class SwapTipExceedsInputError extends RangeError {
  constructor(readonly tip: RelayerTipEstimate, readonly escrowFunding: bigint) {
    super(
      `swap-on-withdraw: the relayer tip ${tip.relayerTip} leaves nothing of the ${escrowFunding} the escrow ` +
        "would receive",
    )
  }
}

/** `keccak256(abi.encode(key, slot))`: where a Solidity `mapping(address => uint256)` at `slot` keeps `key`. */
export function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]))
}

/**
 * The storage slot of `token`'s `balanceOf` mapping, found by overriding every candidate slot with a
 * distinct marker in one `eth_call` and reading which one `balanceOf` returns.
 */
export async function findBalanceOfSlot(
  client: Pick<PublicClient, "readContract">,
  token: Address,
): Promise<bigint> {
  const stateDiff = Array.from({ length: BALANCE_SLOT_CANDIDATES }, (_, slot) => ({
    slot: mappingSlot(BALANCE_PROBE_HOLDER, BigInt(slot)),
    value: numberToHex(BALANCE_SLOT_MARKER + BigInt(slot), { size: 32 }),
  }))
  const read = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BALANCE_PROBE_HOLDER],
    stateOverride: [{ address: token, stateDiff }],
  })
  const slot = read - BALANCE_SLOT_MARKER
  if (slot < 0n || slot >= BigInt(BALANCE_SLOT_CANDIDATES)) {
    throw new Error(
      `${token}: balanceOf does not read a Solidity mapping in storage slots 0-${
        BALANCE_SLOT_CANDIDATES - 1
      }, ` + "so an escrow cannot be funded by state override",
    )
  }
  return slot
}

export interface SwapSimulationArgs {
  output: SwapEscrowOutput
  /** The gross burn amount, raw token units. */
  amount: bigint
  /** What the portal and the executor take out of the burn before the escrow sees it. */
  deductions: Omit<SwapDeductions, "relayerTip">
  /** Final L1 recipient of the swap output. The payout is measured on it. */
  recipient: Address
  /** DAI the escrow swaps to ETH for the recipient before the route. */
  daiForGas?: bigint
}

export class SwapOnWithdrawSimulator {
  private deployment?: Promise<{
    implementation: Address
    ethUsdFeed: Address
    outputToken: Record<Exclude<SwapEscrowOutput, "ETH">, { address: Address; decimals: number }>
  }>
  private balanceOfSlot?: Promise<bigint>

  constructor(
    private readonly client: PublicClient,
    private readonly tuple: {
      swapEscrowFactoryV2: Address
      operationExecutor: Address
      token: Address
    },
  ) {}

  async simulate(args: SwapSimulationArgs): Promise<SwapSimulation> {
    const { withdrawalFee, withdrawalRelayerTip, proverTip } = args.deductions
    const daiForGas = args.daiForGas ?? 0n
    const escrowFunding = args.amount - withdrawalFee - withdrawalRelayerTip - proverTip
    if (escrowFunding <= daiForGas) {
      throw new RangeError(
        `swap-on-withdraw: the amount does not cover the withdrawal fees${
          daiForGas > 0n ? " and the gas swap" : ""
        }`,
      )
    }

    const [deployment, balanceOfSlot] = await Promise.all([
      this.readDeployment(),
      this.readBalanceOfSlot(),
    ])
    const simulatedArgs = this.escrowArgs(args, SIMULATION_TIP)
    // The escrow pays its tip in DAI.
    const tip = await quoteL1OperationTip(this.client, {
      executor: this.tuple.operationExecutor,
      sender: SIMULATION_SENDER,
      eth: { feed: deployment.ethUsdFeed },
      payout: SIMULATION_TIP,
      operation: {
        target: this.tuple.swapEscrowFactoryV2,
        calldata: encodeSwapEscrowDeploy(simulatedArgs),
        payoutToken: this.tuple.token,
      },
      stateOverrides: this.fundingOverride(simulatedArgs, escrowFunding, balanceOfSlot),
    })
    if (escrowFunding - tip.relayerTip <= daiForGas) {
      throw new SwapTipExceedsInputError(tip, escrowFunding)
    }

    const finalArgs = this.escrowArgs(args, tip.relayerTip)
    const { amountOut, gasOut } = await this.payout(
      args,
      finalArgs,
      this.fundingOverride(finalArgs, escrowFunding, balanceOfSlot),
      deployment.outputToken,
    )
    const decimals = args.output === "ETH" ? 18 : deployment.outputToken[args.output].decimals
    return { ...tip, amountOut, decimals, gasOut }
  }

  private escrowArgs(args: SwapSimulationArgs, relayerTip: bigint): SwapEscrowArgs {
    return {
      route: swapRouteForOutput(args.output),
      recipient: args.recipient,
      daiForGas: args.daiForGas ?? 0n,
      minEthForGas: 0n,
      recoveryCommitment: SIMULATION_RECOVERY_COMMITMENT,
      relayerTip,
      nonce: SIMULATION_NONCE,
    }
  }

  /** The escrow holding what the portal will release to it, before anything is deployed. */
  private fundingOverride(
    escrowArgs: SwapEscrowArgs,
    escrowFunding: bigint,
    balanceOfSlot: bigint,
  ): StateOverride {
    const escrow = predictSwapEscrowAddressLocally(this.tuple.swapEscrowFactoryV2, escrowArgs)
    return [
      {
        address: this.tuple.token,
        stateDiff: [
          {
            slot: mappingSlot(escrow, balanceOfSlot),
            value: numberToHex(escrowFunding, { size: 32 }),
          },
        ],
      },
    ]
  }

  /**
   * What the executed swap pays the recipient, on the route and in gas: their balances read before and after
   * `deployAndExecute` in one Multicall3 `aggregate3`, all under the funding override.
   */
  private async payout(
    args: SwapSimulationArgs,
    escrowArgs: SwapEscrowArgs,
    stateOverride: StateOverride,
    outputToken: Awaited<NonNullable<SwapOnWithdrawSimulator["deployment"]>>["outputToken"],
  ): Promise<{ amountOut: bigint; gasOut: bigint }> {
    const ethBalance: Multicall3Call = {
      target: MULTICALL3_ADDRESS,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: MULTICALL3_ETH_BALANCE_ABI,
        functionName: "getEthBalance",
        args: [args.recipient],
      }),
    }
    const routeBalance: Multicall3Call =
      args.output === "ETH"
        ? ethBalance
        : {
            target: outputToken[args.output].address,
            allowFailure: false,
            callData: encodeFunctionData({
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [args.recipient],
            }),
          }
    const balances = escrowArgs.daiForGas > 0n ? [routeBalance, ethBalance] : [routeBalance]
    const calls: Multicall3Call[] = [
      ...balances,
      {
        target: this.tuple.swapEscrowFactoryV2,
        allowFailure: false,
        callData: encodeSwapEscrowDeploy(escrowArgs),
      },
      ...balances,
    ]
    const { data } = await this.client.call({
      to: MULTICALL3_ADDRESS,
      data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
      account: args.recipient,
      stateOverride,
    })
    if (!data) throw new Error("swap-on-withdraw: Multicall3 aggregate3 returned no data")
    const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data })
    const balance = (index: number): bigint =>
      decodeAbiParameters([{ type: "uint256" }], results[index]!.returnData)[0]
    const delta = (index: number) => balance(balances.length + 1 + index) - balance(index)
    return { amountOut: delta(0), gasOut: balances.length > 1 ? delta(1) : 0n }
  }

  private readDeployment() {
    this.deployment ??= (async () => {
      const implementation = await this.client.readContract({
        address: this.tuple.swapEscrowFactoryV2,
        abi: SwapEscrowFactoryAbi,
        functionName: "IMPLEMENTATION",
      })
      const readImplementation = (functionName: "ETH_USD_FEED" | "USDC" | "USDT") =>
        this.client.readContract({ address: implementation, abi: SwapEscrowAbi, functionName })
      const [ethUsdFeed, usdc, usdt] = await Promise.all([
        readImplementation("ETH_USD_FEED"),
        readImplementation("USDC"),
        readImplementation("USDT"),
      ])
      const readDecimals = (address: Address) =>
        this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" })
      const [usdcDecimals, usdtDecimals, daiDecimals] = await Promise.all([
        readDecimals(usdc),
        readDecimals(usdt),
        readDecimals(this.tuple.token),
      ])
      return {
        implementation,
        ethUsdFeed,
        outputToken: {
          USDC: { address: usdc, decimals: usdcDecimals },
          USDT: { address: usdt, decimals: usdtDecimals },
          DAI: { address: this.tuple.token, decimals: daiDecimals },
        },
      }
    })()
    this.deployment.catch(() => {
      this.deployment = undefined
    })
    return this.deployment
  }

  private readBalanceOfSlot(): Promise<bigint> {
    this.balanceOfSlot ??= findBalanceOfSlot(this.client, this.tuple.token)
    this.balanceOfSlot.catch(() => {
      this.balanceOfSlot = undefined
    })
    return this.balanceOfSlot
  }
}

import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { DepositSubsidyAbi, OperationExecutorAbi } from "@oxide/l1-contracts"
import { LegacyOperationExecutorAbi } from "@oxide/l1-contracts/legacy_operation_executor.js"
import { readUsdPerEth, weiToUSD } from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  quoteL1Operation,
  readOperationExecutorVersion,
  relayerGasCost,
  simulateL1Operation,
} from "@oxide/oxide-client/l1_operation_quote.js"
import type { BroadcastL1Operation } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { decodeFunctionResult, numberToHex, type Address, type Hex, type PublicClient } from "viem"
import { findBalanceOfSlot, mappingSlot } from "../escrow/swapOnWithdrawSimulator.js"
import {
  PAR_TIP_TOKEN,
  ethUsdFeedOf,
  readTokenPrice,
  usdToToken,
  withTipMargin,
  type EthUsdSource,
  type TipTokenPrice,
} from "./tipQuote.js"

type QuoteArgs = Parameters<typeof quoteL1Operation>[1]
type QuoteClient = Parameters<typeof quoteL1Operation>[0]

/**
 * `quoteL1Operation` through an executor of either shape. Executors deployed before the six-argument `execute` take
 * four, and only the executor's own call succeeds.
 */
export async function quoteEitherExecutor(
  client: QuoteClient,
  args: Omit<QuoteArgs, "executorVersion">,
): ReturnType<typeof quoteL1Operation> {
  try {
    return await Promise.any([
      quoteL1Operation(client, { ...args, executorVersion: "gas-to-cover" }),
      quoteL1Operation(client, { ...args, executorVersion: "legacy" }),
    ])
  } catch (err) {
    const { errors } = err as AggregateError
    const [current, legacy] = errors.map((e) => (e instanceof Error ? e.message : String(e)))
    throw new AggregateError(
      errors,
      `six-argument execute: ${current}; four-argument execute: ${legacy}`,
    )
  }
}

/** The relayer's quote for an L1 operation, and the tip that clears it. Amounts are payout-token units. */
export interface RelayerTipEstimate {
  /** What the operation commits to paying whoever runs it. */
  relayerTip: bigint
  /** What the relayer's `minPayout` demands for this exact transaction now. */
  minPayout: bigint
  /** Gas the transaction used in the simulation, after refunds. */
  gasUsed: bigint
  /** The max fee per gas the relayer would send with, wei. */
  maxFeePerGas: bigint
  /** The ETH/USD feed answer, 8 decimals. */
  usdPerEth: bigint
  /** The base fee the quote was simulated at, wei. */
  baseFee: bigint
  /** The priority fee the relayer would sign, wei. */
  priorityFee: bigint
}

/** Simulates the operation as the relayer will send it and prices its gas in the payout token. */
export async function quoteL1OperationTip(
  client: QuoteClient,
  args: Omit<QuoteArgs, "executorVersion" | "ethUsdFeed"> & {
    eth: EthUsdSource
    /** The payout token. An 18-dec dollar token by default. */
    token?: TipTokenPrice
  },
): Promise<RelayerTipEstimate> {
  const { eth, token = PAR_TIP_TOKEN, ...simulation } = args
  const [quote, price] = await Promise.all([
    quoteEitherExecutor(client, { ...simulation, ethUsdFeed: ethUsdFeedOf(eth) }),
    readTokenPrice(client, token),
  ])
  // Oxide quotes `minPayout` in 18-dec USD.
  const minPayout = usdToToken(quote.minPayout, price)
  return {
    relayerTip: withTipMargin(minPayout),
    minPayout,
    gasUsed: quote.gasUsed,
    maxFeePerGas: quote.maxFeePerGas,
    usdPerEth: quote.usdPerEth,
    baseFee: quote.baseFeePerGas,
    priorityFee: quote.maxPriorityFeePerGas,
  }
}

/** What a backup rotation's sweep pays the relayer against what the relayer requires, token units. */
export interface BackupSweepQuote {
  /** The executor's return: the sweep tip plus the subsidy, at the quote block's base fee. */
  payout: bigint
  /** The relayer's gas cost for the operation at the quote price. */
  floor: bigint
  gasToCover: bigint
  gasUsed: bigint
  baseFeePerGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** The subsidy's ETH/USD feed answer, 8 decimals. */
  usdPerEth: bigint
}

export class UnprofitableSweepError extends Error {
  constructor(readonly payout: bigint, readonly floor: bigint) {
    super(`The sweep pays ${payout} against a relayer floor of ${floor}`)
    this.name = "UnprofitableSweepError"
  }
}

/**
 * Prices a rotation's deploy-and-sweep as the relayer will: the SIPA is given `funding` of the token
 * by storage override, the operation is simulated once for its payout and once more with that
 * payout as the executor's floor for the gas it covers, and the relayer's floor is that gas at the
 * quote price off the subsidy's own feed.
 */
export async function quoteBackupSweep(
  client: QuoteClient & Pick<PublicClient, "getCode">,
  args: {
    operation: BroadcastL1Operation
    executor: Address
    /** Whoever sends the operation in the simulation; any address. */
    sender: Address
    sipa: Address
    token: Address
    depositSubsidy: Address
    /** The token the SIPA holds when it is swept. */
    funding: bigint
  },
): Promise<BackupSweepQuote> {
  const { executor, sender } = args
  const operation = {
    target: args.operation.target.toString() as Address,
    calldata: `0x${args.operation.calldata.toString("hex")}` as Hex,
    payoutToken: args.operation.payoutToken.toString() as Address,
  }
  const [version, balanceOfSlot, feed, quoteBlock] = await Promise.all([
    readOperationExecutorVersion(client, executor),
    findBalanceOfSlot(client, args.token),
    client.readContract({
      address: args.depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "PRICE_FEED",
    }) as Promise<Address>,
    client.getBlock({ blockTag: "latest" }),
  ])
  const [feeValues, usdPerEth] = await Promise.all([
    estimateL1OperationFeeValues(client, quoteBlock),
    readUsdPerEth(client, EthAddress.fromString(feed)),
  ])
  const stateOverrides = [
    {
      address: args.token,
      stateDiff: [
        {
          slot: mappingSlot(args.sipa, balanceOfSlot),
          value: numberToHex(args.funding, { size: 32 }),
        },
      ],
    },
  ]
  const simulate = (minPayout: bigint) =>
    simulateL1Operation(client, {
      executor,
      executorVersion: version,
      sender,
      operation,
      feeValues,
      minPayout,
      quoteBlock,
      stateOverrides,
    })
  const run = await simulate(0n)
  if (run.status === "failure") {
    throw new Error(`The backup sweep does not run: ${run.error.message}`)
  }
  const payout = decodeFunctionResult({
    abi: version === "legacy" ? LegacyOperationExecutorAbi : OperationExecutorAbi,
    functionName: "execute",
    data: run.data,
  }) as bigint
  const priced = await simulate(payout)
  if (priced.status === "failure") {
    throw new Error(`The backup sweep does not pay its own payout: ${priced.error.message}`)
  }
  const floor = relayerGasCost(
    version,
    priced.gasToCover,
    quoteBlock,
    feeValues,
    weiToUSD(WEI_PER_ETH, usdPerEth),
  )
  return {
    payout,
    floor,
    gasToCover: priced.gasToCover,
    gasUsed: priced.gasUsed,
    baseFeePerGas: priced.baseFeePerGas,
    maxFeePerGas: feeValues.maxFeePerGas,
    maxPriorityFeePerGas: feeValues.maxPriorityFeePerGas,
    usdPerEth,
  }
}

/** The relayer takes a sweep whose payout covers its floor. */
export function assertBackupSweepProfitable(quote: BackupSweepQuote): void {
  if (quote.payout < quote.floor) throw new UnprofitableSweepError(quote.payout, quote.floor)
}

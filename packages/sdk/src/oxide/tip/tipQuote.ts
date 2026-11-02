/**
 * Prices every relayer and prover tip the wallet offers. A tip pays for L1 gas in the token the operation pays out,
 * so a quote needs the ETH/USD price and that token's price. Each quote states the token's price source here; the
 * gas maths stays oxide's.
 *
 * The source must value the token as the relayer does on that path, or the tip misses its floor. Oxide's relayer
 * values every L1 operation's payout at one USD per 18-dec unit (`L1OperationSubmitter`), so L1 operation tips are
 * priced at `PAR_TIP_TOKEN` only. A prover claim is valued at the relayer's price oracle's rate.
 */
import {
  ETH_USD_FEED_DECIMALS,
  priceFeedForChainId,
  readUsdPerEth,
  weiToUSD,
} from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  WEI_PER_ETH,
  gasCostAtQuotePrice,
  type L1OperationQuoteBlock,
} from "@oxide/oxide-client/l1_operation_quote.js"
import {
  PAR_TOKEN_PRICE,
  type PortalTokenPrice,
} from "@oxide/oxide-client/partial_epoch_proof_profit.js"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Address, FeeValuesEIP1559, PublicClient } from "viem"
import { L1_OPERATION_TIP_MARGIN_BPS } from "@obsidion/core/constants"

/** How a tip token is valued in USD. */
export type TipTokenPrice =
  /** A fixed price: one USD per whole token for a dollar-pegged token. */
  | { kind: "fixed"; price: PortalTokenPrice }
  /**
   * A Chainlink token/USD feed with `ETH_USD_FEED_DECIMALS` decimals that answers at least hourly: `readUsdPerEth`
   * refuses an older answer.
   */
  | { kind: "feed"; feed: Address; decimals: number }

/** An 18-dec dollar token such as DAI; what the relayer assumes for every L1 operation payout. */
export const PAR_TIP_TOKEN: TipTokenPrice = { kind: "fixed", price: PAR_TOKEN_PRICE }

/** Where the ETH/USD price comes from: the chain's canonical feed, or one a contract names. */
export type EthUsdSource = { chainId: bigint } | { feed: Address }

type FeedReader = Parameters<typeof readUsdPerEth>[0]
type TipPriceReader = FeedReader & Pick<PublicClient, "readContract">

export function ethUsdFeedOf(source: EthUsdSource): Address {
  return "feed" in source
    ? source.feed
    : (priceFeedForChainId(source.chainId).toString() as Address)
}

const FEED_DECIMALS_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const

const FEED_TO_USD = 10n ** (18n - ETH_USD_FEED_DECIMALS)

/** USD per whole token, 18 decimals. Throws on a stale or non-positive feed answer. */
export async function readTokenPrice(
  client: TipPriceReader,
  token: TipTokenPrice,
): Promise<PortalTokenPrice> {
  switch (token.kind) {
    case "fixed":
      return token.price
    case "feed": {
      const [feedDecimals, answer] = await Promise.all([
        client.readContract({
          address: token.feed,
          abi: FEED_DECIMALS_ABI,
          functionName: "decimals",
        }),
        readUsdPerEth(client, EthAddress.fromString(token.feed)),
      ])
      if (BigInt(feedDecimals) !== ETH_USD_FEED_DECIMALS)
        throw new Error(
          `price feed ${token.feed} answers with ${feedDecimals} decimals, not ${ETH_USD_FEED_DECIMALS}`,
        )
      return { usdPerToken: answer * FEED_TO_USD, decimals: token.decimals }
    }
  }
}

export interface TipPrices {
  /** ETH/USD feed answer, `ETH_USD_FEED_DECIMALS` decimals. */
  usdPerEth: bigint
  token: PortalTokenPrice
}

export async function readTipPrices(
  client: TipPriceReader,
  args: { eth: EthUsdSource; token?: TipTokenPrice },
): Promise<TipPrices> {
  const [usdPerEth, token] = await Promise.all([
    readUsdPerEth(client, EthAddress.fromString(ethUsdFeedOf(args.eth))),
    readTokenPrice(client, args.token ?? PAR_TIP_TOKEN),
  ])
  return { usdPerEth, token }
}

/** The token amount worth `usd` (18 decimals), rounded up as a cost must be. */
export function usdToToken(usd: bigint, price: PortalTokenPrice): bigint {
  return (usd * 10n ** BigInt(price.decimals) + price.usdPerToken - 1n) / price.usdPerToken
}

/** Token units one ETH is worth: `OperationExecutor.execute`'s `tokenWeiPerEth`. */
export function tokenWeiPerEth(prices: TipPrices): bigint {
  return usdToToken(weiToUSD(WEI_PER_ETH, prices.usdPerEth), prices.token)
}

/** The token amount that pays for `gasToCover` at the relayer's quote price: the base fee plus the priority fee. */
export function tipQuote(
  prices: TipPrices,
  gas: { gasToCover: bigint; block: L1OperationQuoteBlock; feeValues: FeeValuesEIP1559 },
): bigint {
  return gasCostAtQuotePrice(gas.gasToCover, gas.block, gas.feeValues, tokenWeiPerEth(prices))
}

/** The relayer's floor with the wallet's margin, which covers gas rising before the relayer sends. */
export function withTipMargin(minPayout: bigint): bigint {
  return (minPayout * L1_OPERATION_TIP_MARGIN_BPS + 9_999n) / 10_000n
}

/**
 * What the tip still owes once a subsidy pays part of the relayer's cost. Subsidies pay in the tip's token, so the
 * two subtract as token amounts.
 */
export function netOfSubsidy(tip: bigint, subsidy: bigint): bigint {
  return tip > subsidy ? tip - subsidy : 0n
}

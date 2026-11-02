import { describe, expect, it, vi } from "vitest"
import { parseGwei, type Address, type PublicClient } from "viem"
import { ETH_USD_FEED_DECIMALS } from "@oxide/oxide-client/eth_usd_price_feed.js"
import { estimateL1OperationFeeValues } from "@oxide/oxide-client/l1_operation_quote.js"
import {
  PAR_TIP_TOKEN,
  ethUsdFeedOf,
  netOfSubsidy,
  readTipPrices,
  tipQuote,
  type TipTokenPrice,
} from "../../../src/oxide/tip/tipQuote.js"

const NOW = 1_800_000_000n
const ETH_FEED = ethUsdFeedOf({ chainId: 1n }).toLowerCase()
const TOKEN_FEED = "0x000000000000000000000000000000000000feed" as Address
const usd = (dollars: bigint) => dollars * 10n ** ETH_USD_FEED_DECIMALS
// With oxide's capped priority fee, gas costs 10 gwei.
const BLOCK = { number: 7n, baseFeePerGas: parseGwei("9.9") }
const GAS = 1_000_000n

function fakeClient({
  usdPerEth = usd(3000n),
  usdPerToken = usd(1n),
  feedDecimals = 8,
  updatedAt = NOW,
  tokenUpdatedAt = NOW,
} = {}) {
  return {
    getBlock: vi.fn(async () => ({ ...BLOCK, timestamp: NOW })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => parseGwei("1")),
    readContract: vi.fn(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === "decimals") return feedDecimals
        return address.toLowerCase() === ETH_FEED
          ? [1n, usdPerEth, 0n, updatedAt, 1n]
          : [1n, usdPerToken, 0n, tokenUpdatedAt, 1n]
      },
    ),
  }
}

async function tipIn(token: TipTokenPrice, client = fakeClient()) {
  const c = client as unknown as PublicClient
  const prices = await readTipPrices(c, { eth: { chainId: 1n }, token })
  return tipQuote(prices, {
    gasToCover: GAS,
    block: BLOCK,
    feeValues: await estimateL1OperationFeeValues(c),
  })
}

describe("tipQuote", () => {
  it("prices a dollar token's tip as the USD cost of the gas", async () => {
    // 1M gas at 10 gwei is 0.01 ETH: $30 at $3,000.
    expect(await tipIn(PAR_TIP_TOKEN)).toBe(30n * 10n ** 18n)
  })

  it("scales a non-dollar token's tip with its price", async () => {
    const feed = (dollars: bigint) =>
      tipIn(
        { kind: "feed", feed: TOKEN_FEED, decimals: 18 },
        fakeClient({ usdPerToken: usd(dollars) }),
      )
    expect(await feed(1n)).toBe(30n * 10n ** 18n)
    expect(await feed(3000n)).toBe(10n ** 16n)
    expect(await feed(2n)).toBe((await feed(1n)) / 2n)
  })

  it("quotes in the token's own decimals", async () => {
    const usdc: TipTokenPrice = { kind: "fixed", price: { usdPerToken: 10n ** 18n, decimals: 6 } }
    expect(await tipIn(usdc)).toBe(30n * 10n ** 6n)
  })

  it("fails on a stale ETH/USD feed", async () => {
    await expect(
      tipIn(PAR_TIP_TOKEN, fakeClient({ updatedAt: NOW - 2n * 60n * 60n })),
    ).rejects.toThrow(/stale/)
  })

  it("fails on a stale token feed", async () => {
    const token: TipTokenPrice = { kind: "feed", feed: TOKEN_FEED, decimals: 18 }
    await expect(
      tipIn(token, fakeClient({ tokenUpdatedAt: NOW - 2n * 60n * 60n })),
    ).rejects.toThrow(/stale/)
  })

  it("refuses a token feed that does not answer with 8 decimals", async () => {
    const token: TipTokenPrice = { kind: "feed", feed: TOKEN_FEED, decimals: 18 }
    await expect(tipIn(token, fakeClient({ feedDecimals: 18 }))).rejects.toThrow(/18 decimals/)
  })

  it("reads the feed a contract names instead of the chain's", async () => {
    const client = fakeClient()
    await readTipPrices(client as unknown as PublicClient, { eth: { feed: TOKEN_FEED } })
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN_FEED }),
    )
  })
})

describe("netOfSubsidy", () => {
  it("leaves what the subsidy does not cover, and nothing once it covers the tip", () => {
    expect(netOfSubsidy(10n, 3n)).toBe(7n)
    expect(netOfSubsidy(10n, 10n)).toBe(0n)
    expect(netOfSubsidy(10n, 30n)).toBe(0n)
  })
})

/** A rotation sweep priced as the relayer prices it, over a fake executor and subsidy. */
import { describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { OperationExecutorAbi } from "@oxide/l1-contracts"
import { LegacyOperationExecutorAbi } from "@oxide/l1-contracts/legacy_operation_executor.js"
import {
  ETH_USD_FEED_DECIMALS,
  ETH_USD_MAX_PRICE_AGE_SECONDS,
  weiToUSD,
} from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  GAS_COST_ARGS_CALLDATA_GAS,
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  gasCostAtQuotePrice,
  gasCostInToken,
} from "@oxide/oxide-client/l1_operation_quote.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  encodeFunctionResult,
  getAbiItem,
  numberToHex,
  parseGwei,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import {
  UnprofitableSweepError,
  assertBackupSweepProfitable,
  quoteBackupSweep,
} from "../../../src/oxide/tip/l1OperationQuote.js"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"

const addr = (tag: string) => `0x${tag.padStart(40, "0")}` as Address
const EXECUTOR = addr("e0")
const SUBSIDY = addr("5b5")
const TOKEN = addr("70")
const SIPA = addr("51a")
const FEED = addr("feed")
const SENDER = addr("b0b")
const TOKEN_SLOT = 2n
const NOW = 1_800_000_000n
const BASE_FEE = parseGwei("10")
const PRIORITY_FEE = parseGwei("1")
const BLOCK = { number: 7n, baseFeePerGas: BASE_FEE, timestamp: NOW, gasLimit: 30_000_000n }
const FEES = await estimateL1OperationFeeValues({
  getBlock: async () => BLOCK,
  estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
} as unknown as PublicClient)
const ETH_USD = 3000n * 10n ** ETH_USD_FEED_DECIMALS
const TOKEN_WEI_PER_ETH = weiToUSD(WEI_PER_ETH, ETH_USD)
const GAS_USED = 500_000n
const GAS_TO_COVER = GAS_USED + GAS_COST_ARGS_CALLDATA_GAS
const FLOOR = gasCostAtQuotePrice(GAS_TO_COVER, BLOCK, FEES, TOKEN_WEI_PER_ETH)
const FUNDING = 3n * 10n ** 18n
const OPERATION = {
  target: EthAddress.fromString(SUBSIDY),
  payoutToken: EthAddress.fromString(TOKEN),
  calldata: Buffer.from("abcdef", "hex"),
  condition: L1OperationCondition.immediate(),
}

interface SimulatedCall {
  to: Address
  functionName: string
  args: readonly unknown[]
}

function fakeClient(opts: {
  payout: bigint
  legacy?: boolean
  feedUpdatedAt?: bigint
  reverts?: boolean
}) {
  const { payout, legacy = false, feedUpdatedAt = NOW, reverts = false } = opts
  const abi = legacy ? LegacyOperationExecutorAbi : OperationExecutorAbi
  const selector = toFunctionSelector(getAbiItem({ abi, name: "execute" }))
  return {
    getCode: vi.fn(async () => `0x6080${selector.slice(2)}` as Hex),
    readContract: vi.fn(
      async ({
        functionName,
        args,
        stateOverride,
      }: {
        functionName: string
        args?: readonly unknown[]
        stateOverride?: StateOverride
      }) => {
        switch (functionName) {
          case "PRICE_FEED":
            return FEED
          case "latestRoundData":
            return [0n, ETH_USD, 0n, feedUpdatedAt, 0n]
          case "balanceOf": {
            const wanted = mappingSlot(args![0] as Address, TOKEN_SLOT)
            const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
            return hit ? BigInt(hit.value) : 0n
          }
          default:
            throw new Error(`unexpected read ${functionName}`)
        }
      },
    ),
    getBlock: vi.fn(async () => BLOCK),
    estimateMaxPriorityFeePerGas: vi.fn(async () => PRIORITY_FEE),
    simulateBlocks: vi.fn(
      async ({
        blocks,
      }: {
        blocks: { stateOverrides: StateOverride; calls: SimulatedCall[] }[]
      }) => {
        const minPayout = blocks[0]!.calls[0]!.args[3] as bigint
        if (reverts || minPayout > payout) {
          return [
            {
              calls: [
                {
                  status: "failure",
                  error: new Error(
                    reverts ? "SIPA__SweepBelowCharges" : "OperationExecutor__InsufficientPayout",
                  ),
                  gasUsed: 0n,
                },
              ],
            },
          ]
        }
        return [
          {
            calls: [
              {
                status: "success",
                result: payout,
                gasUsed: GAS_USED,
                data: encodeFunctionResult({ abi, functionName: "execute", result: payout }),
                logs: [],
              },
            ],
          },
        ]
      },
    ),
  }
}

const quote = (client: ReturnType<typeof fakeClient>) =>
  quoteBackupSweep(client as unknown as Parameters<typeof quoteBackupSweep>[0], {
    operation: OPERATION,
    executor: EXECUTOR,
    sender: SENDER,
    sipa: SIPA,
    token: TOKEN,
    depositSubsidy: SUBSIDY,
    funding: FUNDING,
  })

const simulated = (client: ReturnType<typeof fakeClient>) =>
  client.simulateBlocks.mock.calls.map(
    ([request]) =>
      (request as { blocks: { stateOverrides: StateOverride; calls: SimulatedCall[] }[] })
        .blocks[0]!,
  )

describe("quoteBackupSweep", () => {
  it("takes the executor's payout, then prices the gas of a run that demands that payout", async () => {
    const client = fakeClient({ payout: FLOOR + 1n })

    const result = await quote(client)

    expect(result).toEqual({
      payout: FLOOR + 1n,
      floor: FLOOR,
      gasToCover: GAS_TO_COVER,
      gasUsed: GAS_USED,
      baseFeePerGas: BASE_FEE,
      maxFeePerGas: FEES.maxFeePerGas,
      maxPriorityFeePerGas: FEES.maxPriorityFeePerGas,
      usdPerEth: ETH_USD,
    })
    expect(() => assertBackupSweepProfitable(result)).not.toThrow()

    const [first, second] = simulated(client)
    const call = first!.calls[0]!
    expect([call.to, call.functionName]).toEqual([EXECUTOR, "execute"])
    expect(call.args).toEqual([SUBSIDY, "0xabcdef", TOKEN, 0n, 0n, 0n])
    expect(second!.calls[0]!.args[3]).toBe(FLOOR + 1n)
    // The SIPA holds the funding by storage override in both runs.
    for (const block of [first!, second!]) {
      expect(block.stateOverrides).toContainEqual({
        address: TOKEN,
        stateDiff: [
          { slot: mappingSlot(SIPA, TOKEN_SLOT), value: numberToHex(FUNDING, { size: 32 }) },
        ],
      })
    }
  })

  it("is unprofitable when the payout is under the relayer's floor", async () => {
    const result = await quote(fakeClient({ payout: FLOOR - 1n }))
    expect(result.payout).toBeLessThan(result.floor)
    const refusal = (() => {
      try {
        assertBackupSweepProfitable(result)
      } catch (err) {
        return err
      }
    })()
    expect(refusal).toBeInstanceOf(UnprofitableSweepError)
    expect(refusal).toMatchObject({ payout: FLOOR - 1n, floor: FLOOR })
  })

  it("prices a four-argument executor at the max fee it would send with", async () => {
    const client = fakeClient({ payout: 10n ** 21n, legacy: true })
    const result = await quote(client)
    expect(result.floor).toBe(gasCostInToken(GAS_TO_COVER, FEES.maxFeePerGas, TOKEN_WEI_PER_ETH))
    expect(result.payout).toBe(10n ** 21n)
    expect(simulated(client)[0]!.calls[0]!.args).toHaveLength(4)
  })

  it("refuses a sweep that reverts, and a stale feed", async () => {
    await expect(quote(fakeClient({ payout: FLOOR, reverts: true }))).rejects.toThrow(
      /does not run/,
    )
    await expect(
      quote(fakeClient({ payout: FLOOR, feedUpdatedAt: NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n })),
    ).rejects.toThrow(/stale/)
  })
})

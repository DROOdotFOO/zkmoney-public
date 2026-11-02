import { describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import {
  SwapTipExceedsInputError,
  type RelayerTipEstimate,
  type SwapOnWithdrawSimulator,
  type SwapSimulation,
  type SwapSimulationArgs,
} from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"
import { quoteFundedSandboxSwap } from "./quoteFundedSandboxSwap.js"

const DAI = 10n ** 18n
const deductions = { withdrawalFee: DAI / 5n, withdrawalRelayerTip: DAI / 10n, proverTip: 0n }
const args: SwapSimulationArgs = {
  output: "USDC",
  amount: 20n * DAI,
  deductions,
  recipient: "0x0000000000000000000000000000000000000001" as Address,
}
const tip = (relayerTip: bigint): RelayerTipEstimate => ({
  relayerTip,
  minPayout: relayerTip,
  gasUsed: 1n,
  maxFeePerGas: 1n,
  usdPerEth: 1n,
  baseFee: 1n,
  priorityFee: 0n,
})
const quote = (relayerTip: bigint): SwapSimulation => ({
  ...tip(relayerTip),
  amountOut: 1n,
  decimals: 6,
  gasOut: 0n,
})

function fakeSimulator(
  simulate: (request: SwapSimulationArgs) => Promise<SwapSimulation>,
): Pick<SwapOnWithdrawSimulator, "simulate"> {
  return { simulate }
}

describe("quoteFundedSandboxSwap", () => {
  it("keeps the original fixture amount when it covers the live quote", async () => {
    const simulate = vi.fn(async () => quote(1n * DAI))

    await expect(quoteFundedSandboxSwap(fakeSimulator(simulate), args)).resolves.toEqual({
      amount: 20n * DAI,
      quote: quote(1n * DAI),
    })
    expect(simulate).toHaveBeenCalledOnce()
  })

  it("uses an insufficient quote to retain 20 DAI after deductions and the relayer tip", async () => {
    const firstTip = 201_349_152_002_796_516_000n
    const convergedTip = 228_099_888_003_168_054_000n
    const simulate = vi
      .fn<(request: SwapSimulationArgs) => Promise<SwapSimulation>>()
      .mockRejectedValueOnce(
        new SwapTipExceedsInputError(tip(firstTip), 19_900_000_000_000_000_000n),
      )
      .mockRejectedValueOnce(new SwapTipExceedsInputError(tip(convergedTip), 20n * DAI))
      .mockResolvedValueOnce(quote(convergedTip))

    const result = await quoteFundedSandboxSwap(fakeSimulator(simulate), args)

    const fundedAmount =
      deductions.withdrawalFee + deductions.withdrawalRelayerTip + convergedTip + 20n * DAI
    expect(result).toEqual({ amount: fundedAmount, quote: quote(convergedTip) })
    expect(simulate).toHaveBeenNthCalledWith(3, expect.objectContaining({ amount: fundedAmount }))
  })

  it("bounds repeated fee movement to three live quotes", async () => {
    const simulate = vi.fn(async () => {
      throw new SwapTipExceedsInputError(tip(201n * DAI), 20n * DAI)
    })

    await expect(quoteFundedSandboxSwap(fakeSimulator(simulate), args)).rejects.toThrow(
      /after 3 live quotes/,
    )
    expect(simulate).toHaveBeenCalledTimes(3)
  })
})

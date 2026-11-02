// @vitest-environment node
/** A manual sweep reads the row of the token it sweeps, and scales a swap input into that row's token units. */
import { describe, expect, it } from "vitest"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  ROW_DAI,
  ROW_USDC,
  twoRowTokens,
} from "../../support/depositTokens"
import type { Address } from "viem"

const { recordedSweepRow, sweepRowOf } = await import("../../../src/features/deposit/sipaSweep")

describe("a manual sweep's row", () => {
  it("reads the token's own row, unscaled, for a row token", () => {
    expect(sweepRowOf(twoRowTokens(), ROW_USDC)).toEqual({
      rowToken: ROW_USDC,
      decimals: 6,
      balanceScale: 1n,
    })
    expect(sweepRowOf(twoRowTokens(), ROW_DAI)?.rowToken).toBe(ROW_DAI)
  })

  it("reads a swap input's row and scales it into the row token's units", () => {
    expect(sweepRowOf(mainnetTokens(), MAINNET_USDC)).toEqual({
      rowToken: MAINNET_DAI,
      decimals: 6,
      balanceScale: 10n ** 12n,
    })
  })

  it("has no row for a token the table does not list", () => {
    expect(sweepRowOf(twoRowTokens(), `0x${"ee".repeat(20)}`)).toBeUndefined()
  })
})

describe("a manual sweep's row in the table its address was made under", () => {
  const decimals: Record<string, number> = {
    [MAINNET_DAI.toLowerCase()]: 18,
    [MAINNET_USDC.toLowerCase()]: 6,
    [ROW_USDC.toLowerCase()]: 6,
  }
  const decimalsOf = async (token: Address) => decimals[token.toLowerCase()]!

  it("reads a row token's own row, whether or not the current table lists it", async () => {
    expect(await recordedSweepRow(11155111, ROW_USDC, decimalsOf)).toEqual({
      rowToken: ROW_USDC,
      decimals: 6,
      balanceScale: 1n,
    })
    expect((await recordedSweepRow(1, MAINNET_DAI, decimalsOf)).rowToken).toBe(MAINNET_DAI)
  })

  it("reads a swap input's row from the chain's swap rule and scales it", async () => {
    const row = await recordedSweepRow(1, MAINNET_USDC, decimalsOf)
    expect(row.rowToken.toLowerCase()).toBe(MAINNET_DAI.toLowerCase())
    expect(row).toMatchObject({ decimals: 6, balanceScale: 10n ** 12n })
  })
})

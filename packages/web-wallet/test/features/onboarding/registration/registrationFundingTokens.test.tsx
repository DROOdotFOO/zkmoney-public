/**
 * A mainnet registration SIPA may be funded in USDC or USDT, which the sweep swaps into DAI. The
 * Activity row keeps the token that funded it and normalizes the whole deposit into fee-token
 * units for the credit maths.
 */
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { registrationFunding } from "../../../../src/features/onboarding/registrationFunding"

const dai = { address: `0x${"d4".repeat(20)}` as Address, symbol: "DAI", decimals: 18 }
const usdc = { address: `0x${"a0".repeat(20)}` as Address, symbol: "USDC", decimals: 6 }
const FUNDER = `0x${"11".repeat(20)}` as Address
const TOPPER = `0x${"33".repeat(20)}` as Address
const transfer = (from: Address, amount: bigint, blockNumber: bigint) => ({
  from,
  amount,
  blockNumber,
  txHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
})

describe("registrationFunding", () => {
  it("sums a topped-up USDC deposit under its own token, funder first, normalized to DAI", () => {
    const funding = registrationFunding(
      [dai, usdc],
      [[], [transfer(FUNDER, 10_000_000n, 5n), transfer(TOPPER, 5_000_000n, 9n)]],
    )
    expect(funding).toEqual({
      from: FUNDER,
      txHash: transfer(FUNDER, 0n, 5n).txHash,
      token: usdc,
      amount: 15_000_000n,
      normalized: 15n * 10n ** 18n,
    })
  })

  it("folds a top-up in another token into the normalized total only", () => {
    const funding = registrationFunding(
      [dai, usdc],
      [[transfer(FUNDER, 10n * 10n ** 18n, 5n)], [transfer(TOPPER, 5_000_000n, 9n)]],
    )
    expect(funding).toMatchObject({
      token: dai,
      amount: 10n * 10n ** 18n,
      normalized: 15n * 10n ** 18n,
    })
    expect(registrationFunding([dai, usdc], [[], []])).toBeNull()
  })
})

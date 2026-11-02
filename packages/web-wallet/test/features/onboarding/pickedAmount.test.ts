import { describe, expect, it } from "vitest"
import { pickedAmount } from "../../../src/features/onboarding/steps/DepositAddress"

describe("pickedAmount", () => {
  it("keeps the fee token's units", () => {
    expect(pickedAmount(15n * 10n ** 18n, 18, { decimals: 18 })).toBe(15n * 10n ** 18n)
  })
  it("rounds a partial remainder up, never under", () => {
    expect(pickedAmount(10n ** 18n + 1n, 18, { decimals: 6 })).toBe(1_000_001n)
  })
})

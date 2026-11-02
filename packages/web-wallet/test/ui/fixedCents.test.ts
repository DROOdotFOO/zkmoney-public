// @vitest-environment node
import { describe, expect, it } from "vitest"
import { fixedCents } from "../../src/ui/format"

describe("fixedCents", () => {
  it("rounds half up to cents for any token decimals", () => {
    expect(fixedCents({ atomic: 1_005_000_000_000_000_000n, decimals: 18 })).toBe("1.01")
    expect(fixedCents({ atomic: 1_004_999n, decimals: 6 })).toBe("1.00")
    expect(fixedCents({ atomic: 123n, decimals: 2 })).toBe("1.23")
  })

  it("scales up tokens with fewer than two decimals", () => {
    expect(fixedCents({ atomic: 7n, decimals: 0 })).toBe("7.00")
    expect(fixedCents({ atomic: 75n, decimals: 1 })).toBe("7.50")
  })

  it("reads no balance as zero", () => {
    expect(fixedCents(null)).toBe("0.00")
  })
})

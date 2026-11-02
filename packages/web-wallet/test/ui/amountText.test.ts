import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { amountError, floorToCents, parseAmount } from "../../src/ui/format"

describe("amountError", () => {
  it("says nothing for an empty or acceptable field", () => {
    for (const text of ["", "2", "2.", ".5", "10.25"])
      expect(amountError(text), text).toBeUndefined()
  })

  it("names what is wrong with the text", () => {
    expect(amountError("2-")).toBe("Enter a number")
    expect(amountError("1e3")).toBe("Enter a number")
    expect(amountError("1.11111111")).toBe("Use up to 2 decimal places")
    expect(amountError("0.001")).toBe("Use up to 2 decimal places")
  })
})

describe("parseAmount", () => {
  it("is NaN exactly when amountError would show", () => {
    expect(parseAmount("10.25")).toBe(10.25)
    for (const text of ["", "2-", "1.111"]) expect(parseAmount(text), text).toBeNaN()
  })
})

describe("floorToCents", () => {
  it("drops sub-cent dust so MAX text always passes and never overspends", () => {
    expect(floorToCents(parseUnits("4.119999999999999999", 18), 18)).toBe("4.11")
    expect(floorToCents(parseUnits("100", 18), 18)).toBe("100")
    expect(floorToCents(parseUnits("0.000001", 6), 6)).toBe("0")
    expect(amountError(floorToCents(parseUnits("4.119999999999999999", 18), 18))).toBeUndefined()
  })
})

it("rejects amounts whose cents cannot survive the UI number conversion", () => {
  expect(amountError("9007199254740993")).toBe("Amount is too large")
  expect(amountError("90071992547409.91")).toBe("Amount is too large")
  expect(parseAmount("1000000000.01")).toBe(1000000000.01)
})

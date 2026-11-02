import { describe, expect, it } from "vitest"
import { decimalInput } from "../../../src/ui/format"
import { parseRequestAmount } from "../../../src/features/receive/receiveView"

describe("parseRequestAmount", () => {
  it("accepts positive amounts, with or without a $ prefix", () => {
    expect(parseRequestAmount("10")).toBe(10)
    expect(parseRequestAmount("$10.50")).toBe(10.5)
    expect(parseRequestAmount(" $3 ")).toBe(3)
  })

  it("rejects empty, zero, negative, and non-numeric input", () => {
    expect(parseRequestAmount("")).toBeNull()
    expect(parseRequestAmount("0")).toBeNull()
    expect(parseRequestAmount("-4")).toBeNull()
    expect(parseRequestAmount("ten")).toBeNull()
    expect(parseRequestAmount("$")).toBeNull()
  })
})

describe("request amount safety", () => {
  it.each(["1,000", "1,23e3", "1.001", "0x10", "Infinity", "9007199254740993"])(
    "rejects %s instead of changing its value",
    (input) => {
      expect(parseRequestAmount(input)).toBeNull()
      expect(parseRequestAmount(decimalInput(input))).toBeNull()
    },
  )
})

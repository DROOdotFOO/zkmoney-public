import { describe, expect, it } from "vitest"
import { isWalletTokenSymbol } from "../../src/utils/tokenIdentity"

describe("isWalletTokenSymbol", () => {
  it("accepts the wallet's token symbol", () => {
    expect(isWalletTokenSymbol("DAI")).toBe(true)
  })

  it("is case-insensitive, matching the existing asset-key scan", () => {
    expect(isWalletTokenSymbol("dai")).toBe(true)
    expect(isWalletTokenSymbol("Dai")).toBe(true)
  })

  it("rejects symbols that are not this token", () => {
    expect(isWalletTokenSymbol("BOLD")).toBe(false)
    expect(isWalletTokenSymbol("ETH")).toBe(false)
    expect(isWalletTokenSymbol("??")).toBe(false)
    expect(isWalletTokenSymbol("")).toBe(false)
  })
})

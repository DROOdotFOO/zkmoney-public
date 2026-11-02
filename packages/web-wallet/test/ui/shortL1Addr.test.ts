import { describe, expect, it } from "vitest"
import { shortL1Addr } from "../../src/ui/format"

describe("shortL1Addr", () => {
  it("checksums and keeps MetaMask's 7 leading and 5 trailing characters", () => {
    expect(shortL1Addr("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe("0xd8dA6…96045")
  })
})

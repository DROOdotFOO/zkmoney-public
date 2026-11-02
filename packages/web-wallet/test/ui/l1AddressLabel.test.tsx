import { act } from "react"
import { createRoot } from "react-dom/client"
import { blo } from "blo"
import { getAddress } from "viem"
import { describe, expect, it } from "vitest"
import { L1AddressLabel } from "../../src/ui/L1AddressLabel"

const ADDRESS = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"

async function blockieOf(address: string): Promise<string | null> {
  const container = document.createElement("div")
  await act(async () => createRoot(container).render(<L1AddressLabel address={address} />))
  return container.querySelector("img.ww-blockie")?.getAttribute("src") ?? null
}

describe("L1AddressLabel", () => {
  it("draws the address's blockie, the same for any casing", async () => {
    const expected = blo(getAddress(ADDRESS))
    expect(await blockieOf(ADDRESS)).toBe(expected)
    expect(await blockieOf(getAddress(ADDRESS))).toBe(expected)
  })
})

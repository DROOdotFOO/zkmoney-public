import { beforeEach, describe, expect, it, vi } from "vitest"

let m: typeof import("../../../src/platform/storage/activeTab")

beforeEach(async () => {
  vi.resetModules()
  m = await import("../../../src/platform/storage/activeTab")
})

describe("active tab", () => {
  it("is active only between activation and revocation, and never again after", () => {
    const { activateTab, isActiveTab, revokeTab } = m
    expect(isActiveTab()).toBe(false)
    activateTab()
    expect(isActiveTab()).toBe(true)
    revokeTab()
    expect(() => activateTab()).toThrow("activateTab called on a revoked tab")
    expect(isActiveTab()).toBe(false)
  })

  it("sends no transaction from a revoked tab, and still reads the node", async () => {
    const { InactiveTabError, activateTab, revokeTab, sendOnlyWhileActive } = m
    activateTab()
    const sendTx = vi.fn(async () => {})
    const node = sendOnlyWhileActive({ sendTx, getBlockNumber: async () => 7 })
    await node.sendTx()
    revokeTab()
    await expect(node.sendTx()).rejects.toThrow(InactiveTabError)
    expect(sendTx).toHaveBeenCalledTimes(1)
    expect(await node.getBlockNumber()).toBe(7)
  })
})

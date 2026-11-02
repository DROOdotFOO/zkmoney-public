import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  retired: vi.fn(),
  otherGeneration: vi.fn(),
  accountAddress: vi.fn(),
  load: vi.fn(),
}))

vi.mock("../../../src/config/oxideTuple", () => ({ getRetiredRollupSources: h.retired }))
vi.mock("../../../src/platform/sourceGeneration", () => ({
  isOtherGeneration: h.otherGeneration,
  loadSourceGeneration: h.load,
  nodeAztecMajor: async () => "5",
}))

const { generationAddresses } = await import("../../../src/features/onboarding/generationAddresses")

const V5_PORTAL = "0x" + "ab".repeat(20)
const V5_NODE = "https://v5.rpc.example"
const contracts = { network: "testnet", contracts: {} }
const config = {
  network: "testnet",
  sourceRollupNodes: new Map([[V5_PORTAL, V5_NODE]]),
  sourceRollups: [{ nodeUrl: V5_NODE, contracts }],
} as never
const msk = { toString: () => "0x01" } as never

beforeEach(() => {
  vi.clearAllMocks()
  h.retired.mockResolvedValue([{ portal: V5_PORTAL.toUpperCase(), rollupVersion: "5" }])
  h.otherGeneration.mockResolvedValue(true)
  h.load.mockResolvedValue({ accountAddress: h.accountAddress })
  h.accountAddress.mockResolvedValue("0xv5")
})

describe("generationAddresses", () => {
  it("keeps this rollup's address for a rollup no retired deployment names", async () => {
    await expect(generationAddresses(config, "0xpub")(msk, "0xv6")("7")).resolves.toBe("0xv6")
    expect(h.load).not.toHaveBeenCalled()
  })

  it("keeps this rollup's address for a retired rollup of this generation", async () => {
    h.otherGeneration.mockResolvedValue(false)
    await expect(generationAddresses(config, "0xpub")(msk, "0xv6")("5")).resolves.toBe("0xv6")
    expect(h.load).not.toHaveBeenCalled()
  })

  it("derives the address on another generation's rollup with that generation", async () => {
    await expect(generationAddresses(config, "0xpub")(msk, "0xv6")("5")).resolves.toBe("0xv5")
    expect(h.accountAddress).toHaveBeenCalledWith({
      secretKey: "0x01",
      publicKeyHex: "0xpub",
      network: "testnet",
      contracts,
    })
  })
})

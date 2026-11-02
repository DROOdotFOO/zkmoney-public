import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"

const h = vi.hoisted(() => ({
  open: vi.fn(),
  switchSession: vi.fn(),
  otherGeneration: vi.fn(),
  isFrozen: vi.fn(),
  nodes: new Map<string, string>(),
}))

vi.mock("@obsidion/sdk", () => ({
  detectHistoricDeployments: vi.fn(),
  loadTeeSigner: vi.fn(),
  TokenService: {},
}))
vi.mock("../../src/config/env", () => ({ getConfig: () => ({ sourceRollupNodes: h.nodes }) }))
vi.mock("../../src/config/oxideTuple", () => ({ l1PublicClient: vi.fn() }))
vi.mock("../../src/features/token/oxideToken", () => ({
  portalContract: () => ({ isFrozen: h.isFrozen }),
}))
vi.mock("../../src/platform/sourceRollupWallet", () => ({ openSourceRollupWallet: h.open }))
vi.mock("../../src/platform/sourceGeneration", () => ({
  isOtherGeneration: h.otherGeneration,
  openSourceGenerationSession: h.switchSession,
}))

const { isReadableSource, sourceChain } = await import(
  "../../src/features/migration/historicTokenContext"
)

const tuple = (portal: string, rollupVersion: string) =>
  ({ portal, rollupVersion } as OxideEnvTuple)
const account = {} as never
const active = { wallet: {}, account } as never
const current = tuple("0x" + "01".repeat(20), "7")
const retired = tuple("0x" + "AB".repeat(20), "6")

beforeEach(() => {
  vi.clearAllMocks()
  h.nodes.clear()
  h.otherGeneration.mockResolvedValue(false)
})

describe("sourceChain", () => {
  it("opens a rollup of this generation through the node the profile names for the portal", async () => {
    h.nodes.set("0x" + "ab".repeat(20), "https://old.rpc.example")
    h.open.mockResolvedValue({ wallet: "source", account: "sourceAccount" })
    await expect(sourceChain(active, current, retired)).resolves.toEqual({
      kind: "pxe",
      wallet: "source",
      account: "sourceAccount",
    })
    expect(h.open).toHaveBeenCalledWith("https://old.rpc.example", account)
  })

  it("opens another generation's rollup through that generation's session", async () => {
    h.nodes.set("0x" + "ab".repeat(20), "https://v5.rpc.example")
    h.otherGeneration.mockResolvedValue(true)
    h.switchSession.mockResolvedValue("session")
    await expect(sourceChain(active, current, retired)).resolves.toEqual({
      kind: "generation",
      session: "session",
    })
    expect(h.switchSession).toHaveBeenCalledWith("https://v5.rpc.example", account)
    expect(h.open).not.toHaveBeenCalled()
  })

  it("refuses a portal on another rollup that no profile version reaches", async () => {
    await expect(sourceChain(active, current, tuple("0x" + "cd".repeat(20), "6"))).rejects.toThrow(
      /No node is configured/,
    )
  })
})

describe("isReadableSource", () => {
  beforeEach(() => h.nodes.set("0x" + "ab".repeat(20), "https://v5.rpc.example"))

  it("reads a source of this generation, live or frozen", async () => {
    await expect(isReadableSource(current, retired)).resolves.toBe(true)
    expect(h.isFrozen).not.toHaveBeenCalled()
  })

  it("reads another generation's source only once its portal is frozen", async () => {
    h.otherGeneration.mockResolvedValue(true)
    h.isFrozen.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(isReadableSource(current, retired)).resolves.toBe(false)
    await expect(isReadableSource(current, retired)).resolves.toBe(true)
  })
})

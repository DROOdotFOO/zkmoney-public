/** An address committed to an earlier table still finds a bridge the pinned deployment has since replaced. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { OxideDeployment } from "@obsidion/core/oxide"
import type { WebWalletConfig } from "../../src/config/env"

const h = vi.hoisted(() => ({ readDeploymentTable: vi.fn() }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readDeploymentTable: h.readDeploymentTable,
}))

const { getSipaDeploymentTable } = await import("../../src/config/oxideTuple")

const MANIFEST_URL = "https://oxide.example/sipa-table.json"
const address = (byte: string) => `0x${byte.repeat(20)}`
const PINNED_TABLE = address("fb")
const EARLIER_TABLE = address("fa")
const DAI = address("da")
const USDC = address("c0")

const bridge = (token: string, portal: string) => ({
  token,
  portal,
  l2Token: `0x${portal.slice(2, 4).repeat(32)}`,
})
const deployment = (label: string, forwardingTable: string, bridges: ReturnType<typeof bridge>[]) => ({
  label,
  updatedAt: "2026-10-20T00:00:00Z",
  deployedAt: "2026-10-01T00:00:00Z",
  enclaveUrl: "https://fleet.example/rpc",
  rollupVersion: "1",
  chainId: "11155111",
  forwardingTable,
  feeToken: DAI,
  bridges,
})
const manifest = {
  schemaVersion: "5",
  deployments: [
    deployment("v6.1", PINNED_TABLE, [bridge(DAI, address("a1")), bridge(USDC, address("b2"))]),
    deployment("v6.0", EARLIER_TABLE, [bridge(USDC, address("b0"))]),
  ],
}

const config = {
  oxideProfile: { manifestUrl: MANIFEST_URL, portal: address("a1") },
  network: Network.TESTNET,
  l1RpcUrl: "http://l1.test",
} as unknown as WebWalletConfig

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(manifest))))
  h.readDeploymentTable.mockReset().mockResolvedValue({ rows: [] })
})
afterEach(() => vi.unstubAllGlobals())

describe("getSipaDeploymentTable", () => {
  it("reads an earlier table over the pinned bridges, then every other bridge the manifest lists", async () => {
    await getSipaDeploymentTable(config, EARLIER_TABLE)

    const [, read] = h.readDeploymentTable.mock.calls[0] as [unknown, OxideDeployment]
    expect(read.forwardingTable).toBe(EARLIER_TABLE)
    expect(read.bridges.map(({ portal }) => portal)).toEqual([
      address("a1"),
      address("b2"),
      address("b0"),
    ])
  })
})

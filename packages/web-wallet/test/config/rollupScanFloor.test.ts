/**
 * `rollupScanFloor` bounds log scans about a rollup by the earliest deployment the manifest lists on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ oxideManifestDeployments: vi.fn() }))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  oxideManifestDeployments: h.oxideManifestDeployments,
}))

import { Network } from "@obsidion/core/constants"
import type { PublicClient } from "viem"
import { rollupScanFloor } from "../../src/config/oxideTuple"
import type { WebWalletConfig } from "../../src/config/env"

const config = (manifestUrl: string) =>
  ({
    oxideProfile: { manifestUrl, portal: "0xabc" },
    network: Network.TESTNET,
  } as unknown as WebWalletConfig)

const client = { getBlockNumber: async () => 30_000n } as unknown as PublicClient

const deployment = (rollupVersion: string, ...blocks: string[]) => ({
  rollupVersion,
  bridges: blocks.map((deployedAtBlock) => ({
    tuple: { rollupVersion, deployedAt: "2026-01-01T00:00:00Z", deployedAtBlock },
  })),
})

describe("rollupScanFloor", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    h.oxideManifestDeployments.mockReset()
  })

  it("is the first block of the earliest deployment on the rollup", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }))
    h.oxideManifestDeployments.mockReturnValue([
      deployment("1", "20000", "12000"),
      deployment("2", "5000"),
      deployment("1", "15000"),
    ])
    expect(await rollupScanFloor(config("https://m.example/a.json"), client, "1")).toBe(12_000n)
  })

  it("is undefined when the manifest lists no deployment on the rollup, or cannot be read", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }))
    h.oxideManifestDeployments.mockReturnValue([deployment("2", "5000")])
    expect(await rollupScanFloor(config("https://m.example/b.json"), client, "1")).toBeUndefined()

    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }))
    expect(await rollupScanFloor(config("https://m.example/c.json"), client, "1")).toBeUndefined()
  })
})

/**
 * `getRetiredRollupSources` must never cache a promise that can hang forever: a stalled fetch
 * would otherwise pin every later sign-in attempt on the same stuck promise.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  loadRetiredRollupSources: vi.fn(),
  loadOxideManifestTuple: vi.fn(),
}))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  loadRetiredRollupSources: h.loadRetiredRollupSources,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  loadOxideManifestTuple: h.loadOxideManifestTuple,
}))

import { Network } from "@obsidion/core/constants"
import {
  ASSET_TUPLE_TIMEOUT_MS,
  getOtherManifestSources,
  getRetiredRollupSources,
} from "../../src/config/oxideTuple"
import type { WebWalletConfig } from "../../src/config/env"

const CONFIG = {
  oxideProfile: { manifestUrl: "https://oxide.example/manifest.json", portal: "0xabc" },
  network: Network.TESTNET,
} as unknown as WebWalletConfig

describe("getRetiredRollupSources", () => {
  afterEach(() => {
    vi.useRealTimers()
    h.loadRetiredRollupSources.mockReset()
  })

  it("waits as long as a portal tuple fetch before rejecting a stalled fetch", async () => {
    vi.useFakeTimers()
    h.loadRetiredRollupSources.mockReturnValue(new Promise(() => {}))

    let error: unknown
    const settled = getRetiredRollupSources(CONFIG).catch((e: unknown) => {
      error = e
    })
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS - 1)
    expect(error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(String(error)).toMatch(/timed out/)
  })

  it("retries on the next call instead of reusing the timed-out promise", async () => {
    vi.useFakeTimers()
    h.loadRetiredRollupSources.mockReturnValueOnce(new Promise(() => {}))
    const first = expect(getRetiredRollupSources(CONFIG)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await first

    vi.useRealTimers()
    h.loadRetiredRollupSources.mockResolvedValueOnce([])
    await expect(getRetiredRollupSources(CONFIG)).resolves.toEqual([])
  })
})

describe("getOtherManifestSources", () => {
  const WITH_V5 = {
    ...CONFIG,
    oxideProfile: { ...CONFIG.oxideProfile, portal: "0xv6" },
    sourceRollups: [
      {
        manifestUrl: "https://oxide.example/staging.v4.json",
        pins: [{ portal: "0xv5" }],
      },
    ],
  } as unknown as WebWalletConfig

  afterEach(() => {
    vi.useRealTimers()
    h.loadOxideManifestTuple.mockReset()
  })

  it("retries a stalled manifest on the next call", async () => {
    vi.useFakeTimers()
    h.loadOxideManifestTuple.mockReturnValueOnce(new Promise(() => {}))
    const first = expect(getOtherManifestSources(WITH_V5)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(ASSET_TUPLE_TIMEOUT_MS)
    await first

    vi.useRealTimers()
    h.loadOxideManifestTuple.mockResolvedValueOnce({ portal: "0xv5" })
    await expect(getOtherManifestSources(WITH_V5)).resolves.toEqual([{ portal: "0xv5" }])
  })
})

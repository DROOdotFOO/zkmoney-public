import { beforeEach, describe, expect, it, vi } from "vitest"
import { pinnedOxideDeployment } from "@obsidion/core/oxide"

const DAI = "0x00000000000000000000000000000000000000d1"
const SUSDS = "0x00000000000000000000000000000000000000d2"
const MAIN_PORTAL = "0x00000000000000000000000000000000000000aa"
const SKY_PORTAL = "0x00000000000000000000000000000000000000bb"
const l2 = (byte: string) => `0x${byte.repeat(32)}`

const bridge = (key: string, token: string, portal: string, byte: string) => ({
  key,
  bridgeId: `brg-${key}-sandbox`,
  token,
  portal,
  l2Token: l2(byte),
  plainWithdrawalExecutor: `0x${byte.repeat(20)}`,
})

const manifest = (features?: unknown) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "sandbox",
      deployedAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      chainId: "31337",
      rollupVersion: "1",
      enclaveUrl: "http://localhost:5071/rpc",
      ...(features ? { features } : {}),
      bridges: [bridge("susds", SUSDS, SKY_PORTAL, "b2"), bridge("dai", DAI, MAIN_PORTAL, "a1")],
    },
  ],
})

const sky = (roles: Record<string, string>) => ({
  "fea-sky-sandbox": {
    project: "sky",
    bridges: roles,
    contracts: {
      skyWithdrawalExecutor: `0x${"e5".repeat(20)}`,
      skyEscrowFactory: `0x${"fa".repeat(20)}`,
    },
  },
})

const state = vi.hoisted(() => ({ manifest: undefined as unknown, url: 0, hang: false }))
vi.mock("../../../src/config/oxideTuple", () => ({
  ASSET_TUPLE_TIMEOUT_MS: 20_000,
  oxideProfileKey: (config: { oxideProfile: { manifestUrl: string; portal: string } }) =>
    `${config.oxideProfile.manifestUrl}|${config.oxideProfile.portal}`,
  getOxideDeployment: async () =>
    state.hang
      ? new Promise(() => {})
      : pinnedOxideDeployment(state.manifest, { portal: MAIN_PORTAL }),
  getOxideTuple: async () =>
    pinnedOxideDeployment(state.manifest, { portal: MAIN_PORTAL }).pinned.tuple,
  l1PublicClient: () => ({
    readContract: async () => {
      throw new Error("no L1 read expected")
    },
  }),
}))
vi.mock("../../../src/config/env", () => ({
  // A fresh manifest URL per test, so each reads its own manifest.
  getConfig: () => ({
    oxideProfile: { manifestUrl: `http://manifest.test/${state.url}.json`, portal: MAIN_PORTAL },
  }),
}))
import { getConfig } from "../../../src/config/env"
import { getSavingsTuple, moveSummary } from "../../../src/features/savings/savingsGateway"

beforeEach(() => {
  state.url += 1
})

describe("getSavingsTuple", () => {
  it("is the sUSDS bridge the pinned deployment's Sky feature binds", async () => {
    state.manifest = manifest(sky({ sUsds: "brg-susds-sandbox", dai: "brg-dai-sandbox" }))
    await expect(getSavingsTuple(getConfig())).resolves.toMatchObject({ portal: SKY_PORTAL })
  })

  it("is nothing where the deployment names no Sky savings", async () => {
    state.manifest = manifest()
    await expect(getSavingsTuple(getConfig())).resolves.toBeUndefined()
  })

  it("is nothing where the feature pairs Savings with another bridge than Main", async () => {
    state.manifest = manifest(sky({ sUsds: "brg-susds-sandbox", dai: "brg-susds-sandbox" }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(getSavingsTuple(getConfig())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not the pinned portal"))
    warn.mockRestore()
  })
})

describe("getSkySavings", () => {
  it("gives up on a stalled read, and reads again on the next call", async () => {
    vi.useFakeTimers()
    try {
      state.manifest = manifest(sky({ sUsds: "brg-susds-sandbox", dai: "brg-dai-sandbox" }))
      state.hang = true
      const stalled = expect(getSavingsTuple(getConfig())).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(20_000)
      await stalled
      state.hang = false
      await expect(getSavingsTuple(getConfig())).resolves.toMatchObject({ portal: SKY_PORTAL })
    } finally {
      state.hang = false
      vi.useRealTimers()
    }
  })
})

describe("moveSummary", () => {
  const ONE = 10n ** 18n
  it("names a move by its dollar value and route, pricing a move out's shares at the vault", () => {
    expect(moveSummary("in", 25n * ONE)).toBe("$25.00 to Savings")
    expect(moveSummary("in", 25n * ONE + 5n * 10n ** 17n)).toBe("$25.50 to Savings")
    // A move out of 255.178858708317111766 shares at a 1.07 share price is $273.04, not the share count.
    const price = (107n * ONE) / 100n
    expect(moveSummary("out", 255_178858708317111766n, price)).toBe("$273.04 to Main Account")
    // MAX out burns every share: the summary is the position's value.
    const shares = 700n * ONE
    expect(moveSummary("out", shares, 714287899390558444472n / 700n)).toBe(
      "$714.28 to Main Account",
    )
    expect(moveSummary("out", shares)).toBe("Savings to Main Account")
  })
})

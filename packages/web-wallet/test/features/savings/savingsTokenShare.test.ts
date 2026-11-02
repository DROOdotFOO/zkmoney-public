import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ create: vi.fn(), manifestDown: false }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  TokenService: { create: h.create },
}))
const SAVINGS = { portal: `0x${"bb".repeat(20)}`, l2Token: `0x${"2b".repeat(32)}` }
const MAIN = { portal: `0x${"aa".repeat(20)}` }
const SKY_EXECUTOR = `0x${"5e".repeat(20)}`
const OLDER_SKY_EXECUTOR = `0x${"0e".repeat(20)}`
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  resolveSkySavings: async () => ({
    deployments: { main: MAIN, savings: SAVINGS, skyExecutor: SKY_EXECUTOR },
    factory: {},
  }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideDeployment: async () => ({ deployment: {} }),
  getOxideTuple: async () => MAIN,
  getManifestDeployments: async () =>
    h.manifestDown
      ? Promise.reject(new Error("manifest down"))
      : [
          {
            features: [
              {
                project: "sky",
                bridges: {},
                contracts: { skyWithdrawalExecutor: OLDER_SKY_EXECUTOR },
              },
              {
                project: "swap",
                bridges: {},
                contracts: { skyWithdrawalExecutor: `0x${"77".repeat(20)}` },
              },
            ],
          },
        ],
  l1PublicClient: () => ({}),
  oxideProfileKey: () => "profile",
  ASSET_TUPLE_TIMEOUT_MS: 20_000,
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { manifestUrl: "http://manifest.test", portal: MAIN.portal } }),
}))
import type { ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import { savingsRescanToken } from "../../../src/features/savings/savingsGateway"

const account = (address: string) =>
  ({ getAddress: () => ({ toString: () => address }) } as unknown as ObsidionAccount)

describe("the Savings token service", () => {
  it("is created once per wallet and account, and again after a failed create", async () => {
    const wallet = {} as ObsidionWallet
    const service = { id: "susds" }
    h.create.mockRejectedValueOnce(new Error("node down")).mockResolvedValue(service)

    await expect(savingsRescanToken(wallet, account("0xa"))).rejects.toThrow("node down")
    const first = await savingsRescanToken(wallet, account("0xa"))
    const second = await savingsRescanToken(wallet, account("0xa"))
    expect(first?.tokenService).toBe(service)
    expect(second?.tokenService).toBe(service)
    expect(h.create).toHaveBeenCalledTimes(2)

    await savingsRescanToken(wallet, account("0xb"))
    await savingsRescanToken({} as ObsidionWallet, account("0xa"))
    expect(h.create).toHaveBeenCalledTimes(4)
  })
})

describe("the Savings rescan", () => {
  it("reads a burn through a Sky executor the manifest knows as a move out, and any other as plain", async () => {
    h.create.mockResolvedValue({ id: "susds" })
    const token = await savingsRescanToken({} as ObsidionWallet, account("0xc"))

    expect(token?.executorKind?.(SKY_EXECUTOR.toUpperCase().replace("0X", "0x") as never)).toBe(
      "sky",
    )
    expect(token?.executorKind?.(OLDER_SKY_EXECUTOR as never)).toBe("sky")
    expect(token?.executorKind?.(`0x${"77".repeat(20)}` as never)).toBe("plain")
    expect(token?.executorKind?.(`0x${"e2".repeat(20)}` as never)).toBe("plain")
    expect(token?.partial).toBeUndefined()
  })
})

describe("the Savings rescan with no manifest", () => {
  it("says the manifest read failed, and knows today's Sky executor alone, for a partial pass", async () => {
    h.create.mockResolvedValue({ id: "susds" })
    h.manifestDown = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const token = await savingsRescanToken({} as ObsidionWallet, account("0xd"))

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("manifest read failed"),
        expect.objectContaining({ message: "manifest down" }),
      )
      expect(token?.executorKind?.(SKY_EXECUTOR as never)).toBe("sky")
      expect(token?.executorKind?.(OLDER_SKY_EXECUTOR as never)).toBe("plain")
      expect(token?.partial).toBe(true)
    } finally {
      h.manifestDown = false
      warn.mockRestore()
    }
  })
})

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getContractAddress, type Address } from "viem"

const h = vi.hoisted(() => ({
  readClaimFpcIdentityCatalog: vi.fn(),
  createOxideL1Reader: vi.fn(),
  getRetiredRollupSources: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readClaimFpcIdentityCatalog: h.readClaimFpcIdentityCatalog,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader: h.createOxideL1Reader,
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLE,
  l1PublicClient: () => L1_CLIENT,
  getRetiredRollupSources: h.getRetiredRollupSources,
}))

import {
  OxideIdentityUnavailableError,
  requireVerifiedIdentity,
  resolveOxideIdentity,
} from "@obsidion/front-core"
import { loadOxideGenerations } from "../../../src/features/onboarding/oxideGenerations"

const REGISTRY = "0x1111111111111111111111111111111111111111"
const TUPLE = { registry: REGISTRY }
const L1_CLIENT = { kind: "l1-client" }
const READER = { kind: "reader" }
const BINDINGS = [
  {
    fpcAddress: "0x0a",
    accountFactory: "0x3333333333333333333333333333333333333333",
    implementation: "0x4444444444444444444444444444444444444444",
    namePortal: "0x5555555555555555555555555555555555555555",
  },
  {
    fpcAddress: "0x0b",
    accountFactory: "0x6666666666666666666666666666666666666666",
    implementation: "0x7777777777777777777777777777777777777777",
    namePortal: "0x8888888888888888888888888888888888888888",
  },
]

const wallet = (rollupVersion: number) => ({
  node: { getNodeInfo: vi.fn() },
  getNodeIdentity: async () => ({ l1ChainId: 11155111, rollupVersion }),
})

const RETIRED_TUPLE = {
  rollupVersion: "6",
  accountFactory: "0x9999999999999999999999999999999999999999",
  namePortal: "0x8888888888888888888888888888888888888888",
  portal: "0x1111111111111111111111111111111111111111",
}

describe("loadOxideGenerations", () => {
  beforeEach(() => {
    h.getRetiredRollupSources.mockReset().mockResolvedValue([])
    h.readClaimFpcIdentityCatalog.mockReset()
    h.createOxideL1Reader.mockReset()
  })

  it("merges a retired rollup's manifest-derived candidate without any live read of it", async () => {
    h.readClaimFpcIdentityCatalog.mockResolvedValue(BINDINGS)
    h.createOxideL1Reader.mockReturnValue(READER)
    h.getRetiredRollupSources.mockResolvedValue([RETIRED_TUPLE])

    const deps = await loadOxideGenerations(wallet(3) as never, {} as never, {} as never)

    expect(deps.admissibleRollupVersions).toEqual(new Set(["3", "6"]))
    expect(deps.catalog.map((g) => g.rollupVersion)).toEqual(["3", "3", "6"])
    expect(deps.catalog.at(-1)).toMatchObject({
      accountFactory: RETIRED_TUPLE.accountFactory,
      namePortal: RETIRED_TUPLE.namePortal,
      rollupVersion: "6",
    })
    // The retired candidate is built from static manifest fields alone: the only live catalog
    // read is the one call for the current rollup, never anything keyed by the retired rollup.
    expect(h.readClaimFpcIdentityCatalog).toHaveBeenCalledTimes(1)
  })

  it("keeps the current-rollup catalog but marks it incomplete when the retired-deployments fetch fails", async () => {
    h.readClaimFpcIdentityCatalog.mockResolvedValue(BINDINGS)
    h.createOxideL1Reader.mockReturnValue(READER)
    h.getRetiredRollupSources.mockRejectedValue(new Error("manifest fetch failed"))

    const deps = await loadOxideGenerations(wallet(3) as never, {} as never, {} as never)

    expect(deps.admissibleRollupVersions).toEqual(new Set(["3"]))
    expect(deps.catalog.map((g) => g.rollupVersion)).toEqual(["3", "3"])
    expect(deps.catalogIncomplete).toBe(true)
  })

  describe("a passkey the current rollup's factories hold no name for", () => {
    const unnamedUnderCurrentFactories = {
      readNameOf: async () => `0x${"00".repeat(32)}`,
      readAccountMetadataRegistry: async () => REGISTRY,
      readUserRecord: async () => null,
      readNamePortalRegistry: async () => REGISTRY,
      readFactoryImplementation: async (factory: Address) =>
        getContractAddress({ from: factory, nonce: 1n }),
    }
    const signIn = async () => {
      h.readClaimFpcIdentityCatalog.mockResolvedValue(BINDINGS)
      h.createOxideL1Reader.mockReturnValue(unnamedUnderCurrentFactories)
      const deps = await loadOxideGenerations(wallet(3) as never, {} as never, {} as never)
      const outcome = await resolveOxideIdentity(
        deps,
        "0x00000000000000000000000000000000000000b0",
        `0x${"11".repeat(32)}`,
      )
      return () => requireVerifiedIdentity(outcome)
    }

    it("is refused, not offered a name claim, when the retired read fails", async () => {
      // Its account may sit under a factory only a retired rollup lists.
      h.getRetiredRollupSources.mockRejectedValue(new Error("manifest fetch failed"))
      expect(await signIn()).toThrow(OxideIdentityUnavailableError)
    })

    it("reads as a new user when the retired read succeeds", async () => {
      expect((await signIn())()).toBeUndefined()
    })
  })
})

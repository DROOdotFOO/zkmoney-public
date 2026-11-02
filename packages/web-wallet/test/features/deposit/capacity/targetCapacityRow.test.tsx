import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { tokenOption } from "../../../support/depositTokens"

const h = vi.hoisted(() => ({
  records: [] as unknown[],
  terms: vi.fn(),
}))

const DAI = `0x${"da".repeat(20)}` as Address
const SUSDS = `0x${"5d".repeat(20)}` as Address
const TABLE = `0x${"fb".repeat(20)}` as Address
const SIPA = `0x${"ab".repeat(20)}` as Address

vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<object>()),
  readSipaPortalTerms: h.terms,
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<object>()),
  useCachedRecords: () => ({ records: h.records, hydrated: true }),
}))
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => ({ l1ChainId: 31337 }),
}))
vi.mock("../../../../src/config/oxideTuple", async (original) => ({
  ...(await original<object>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts } = await import("../../../support/depositTokens")
  const dai = tokenOption("DAI", DAI)
  return mockLoadDepositFacts(importOriginal, () => ({
    options: [dai, tokenOption("sUSDS", SUSDS)],
    offered: [dai],
    settlement: dai,
  }))
})
vi.mock("../../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: async () => undefined,
  depositCapacityStore: () => ({
    subscribe: () => () => {},
    getState: () => undefined,
    retry: async () => {},
    policy: { staleAfterMs: 1 },
  }),
}))

const { useTargetCapacity } = await import("../../../../src/features/deposit/targetCapacity")

function recorded(tokenAddress?: Address): SIPADepositRecord {
  return {
    sipaAddress: SIPA,
    phase: "sweeping",
    l1ChainId: 31337,
    tokenAddress,
    origin: { protocol: "account", forwardingTable: TABLE },
  } as unknown as SIPADepositRecord
}

let root: Root
let seen: ReturnType<typeof useTargetCapacity> | undefined

function Probe() {
  seen = useTargetCapacity({ kind: "recorded", sipaAddress: SIPA })
  return null
}

beforeEach(() => {
  seen = undefined
  h.terms.mockReset()
  h.terms.mockImplementation(async (_client: unknown, route: { token: Address }) => ({
    portal: route.token === SUSDS ? `0x${"55".repeat(20)}` : `0x${"dd".repeat(20)}`,
    token: route.token,
    txAmountCap: 1n,
    depositFee: 0n,
  }))
  root = createRoot(document.createElement("div"))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

describe("useTargetCapacity for a recorded deposit", () => {
  it("reads the terms of the row its funds are in", async () => {
    h.records = [recorded(SUSDS)]
    await act(async () => root.render(<Probe />))
    expect(h.terms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: SUSDS }),
    )
    expect(seen?.terms?.token).toBe(SUSDS)
  })

  it("reads the intent's settlement row while no token is recorded", async () => {
    h.records = [recorded(undefined)]
    await act(async () => root.render(<Probe />))
    expect(h.terms).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ token: DAI }))
  })
})

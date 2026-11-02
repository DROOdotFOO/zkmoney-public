/**
 * sourceFrozenEscrows — which of this browser's link rows become discovery hints for a frozen source:
 * the rows the residual probe attributes to it, in this rollup's database and earlier ones, and only
 * links on the source's chain and rollup, read for one account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { SessionChangedError } from "../../../../src/platform/auth/sessionErrors"

const h = vi.hoisted(() => ({
  discover: vi.fn(),
  rows: [] as unknown[],
  otherRows: [] as unknown[],
  storageId: "acct-a" as string | null,
  onOtherRead: () => {},
  onDecode: () => {},
  reads: 0,
  decodes: 0,
  marked: [] as string[],
  locked: 0,
}))

vi.mock("@obsidion/sdk", () => ({
  ContractService: { getInstance: () => ({}) },
  createTransferEventSource: () => ({}),
  discoverFrozenEscrows: h.discover,
  PaylinkService: class {},
  TokenService: { create: async () => ({}) },
}))
vi.mock("../../../../src/platform/session", () => ({
  session: () => ({
    activity: {
      all: async () => {
        h.reads++
        return h.rows
      },
    },
  }),
}))
vi.mock("@obsidion/front-core", () => ({
  // A database stands for its own rows here.
  storedActivity: (rows: unknown[]) => rows,
  markPaylinkMigrated: (txHash: string) => {
    h.marked.push(txHash)
    return true
  },
  creatorLinksFromRows: async (rows: Array<{ link: unknown }>) => {
    h.decodes++
    h.onDecode()
    return rows.map((row) => row.link)
  },
}))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({
  webStorage: {
    readOtherDatabases: async <T>(read: (db: unknown[]) => T) => {
      h.onOtherRead()
      return [read(h.otherRows)]
    },
  },
}))
vi.mock("../../../../src/platform/storage/activeStorage", () => ({
  getActiveStorageId: () => h.storageId,
  withSessionLock: async <T>(fn: () => Promise<T>) => {
    h.locked++
    return fn()
  },
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({ l1ChainId: 31337 }) }))

const { markRefundedSourceLinks, sourceFrozenEscrows, sourceLinkRows } = await import(
  "../../../../src/features/migration/sourceFrozenEscrows"
)

const SOURCE_TOKEN = "0x" + "01".repeat(32)
const tuple = { l2Token: SOURCE_TOKEN, rollupVersion: "7" } as OxideEnvTuple
const current = { timestamp: "2026-08-14T10:00:00.000Z" } as OxideEnvTuple
const before = Date.parse("2026-08-01T00:00:00Z")
const link = (name: string, rollupVersion = 7, chainId = 31337) => ({
  name,
  rollupVersion,
  chainId,
})
const row = (name: string, over: Record<string, unknown> = {}) => ({
  emailPaymentAction: "Pay To Email",
  timestamp: before,
  link: link(name),
  ...over,
})
const names = (rows: Array<{ link: { name: string } }>) => rows.map((r) => r.link.name)
const read = () => sourceLinkRows({ tuple, current, storageId: "acct-a" })

describe("sourceLinkRows", () => {
  beforeEach(() => {
    h.storageId = "acct-a"
    h.onOtherRead = () => {}
    h.onDecode = () => {}
    h.otherRows = []
    h.reads = 0
    h.decodes = 0
  })

  it("fails when the account changes during the read", async () => {
    h.rows = [row("legacy")]
    h.onOtherRead = () => {
      h.storageId = "acct-b"
    }
    await expect(read()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.decodes).toBe(0)
  })

  it("fails when the account changes while the links decode", async () => {
    h.rows = [row("legacy")]
    h.onDecode = () => {
      h.storageId = "acct-b"
    }
    await expect(read()).rejects.toBeInstanceOf(SessionChangedError)
  })

  it("reads nothing for another account", async () => {
    h.storageId = "acct-b"
    await expect(read()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.reads).toBe(0)
  })
})

describe("sourceFrozenEscrows", () => {
  beforeEach(() => {
    h.discover.mockReset()
    h.discover.mockResolvedValue([])
  })

  it("hints the links of the rows it is given", async () => {
    await sourceFrozenEscrows({
      chain: { wallet: {} as never, account: { getAddress: () => "0xacc" } as never },
      tuple,
      masterSecret: {} as never,
      rows: [row("a"), row("b")] as never,
    })
    expect(h.discover.mock.calls[0]![0].hints.map((l: { name: string }) => l.name)).toEqual([
      "a",
      "b",
    ])
  })
})

describe("markRefundedSourceLinks", () => {
  const refundedLinks = vi.fn()
  const mark = () =>
    markRefundedSourceLinks({
      session: { refundedLinks } as never,
      tuple,
      current,
      storageId: "acct-a",
    })

  beforeEach(() => {
    h.storageId = "acct-a"
    h.onOtherRead = () => {}
    h.onDecode = () => {}
    h.otherRows = []
    h.marked = []
    h.locked = 0
    refundedLinks.mockReset()
  })

  it("asks the session about the source's rows on this rollup and marks the refunded ones under the session lock", async () => {
    h.rows = [row("legacy")]
    h.otherRows = [row("earlierRollup", { tokenAddress: SOURCE_TOKEN })]
    refundedLinks.mockResolvedValue(["0xa", "0xb"])
    await mark()
    expect(refundedLinks).toHaveBeenCalledWith({ tuple, paylinkRows: expect.any(Function) })
    expect(names((await refundedLinks.mock.calls[0]![0].paylinkRows()) as never)).toEqual([
      "legacy",
    ])
    expect(h.marked).toEqual(["0xa", "0xb"])
    expect(h.locked).toBe(1)
  })

  it("writes nothing when no link was refunded", async () => {
    refundedLinks.mockResolvedValue([])
    await mark()
    expect(h.locked).toBe(0)
  })

  it("writes nothing once the account has changed", async () => {
    refundedLinks.mockImplementation(async () => {
      h.storageId = "acct-b"
      return ["0xa"]
    })
    await expect(mark()).rejects.toBeInstanceOf(SessionChangedError)
    expect(h.marked).toEqual([])
  })
})

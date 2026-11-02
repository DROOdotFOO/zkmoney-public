import { beforeEach, describe, expect, it, vi } from "vitest"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"

type Refund = { ids: string[]; usd: string; l1TxHash?: string }
type Record = { id: string; refunds: Refund[]; phase: string; feeUsd: string }

const m = vi.hoisted(() => ({
  order: [] as string[],
  register: vi.fn(),
  saved: [] as Record[],
  pending: [] as Record[],
  settle: vi.fn(),
  producing: vi.fn(),
}))
vi.mock("@obsidion/front-core", () => ({ runMetadataMigration: m.register }))
vi.mock("@obsidion/sdk", () => ({
  FrozenMetadataMigrationSource: class {},
  // One batch per candidate that moves at least the minimum.
  planFrozenSelfRefunds: (o: { candidates: { amount: string }[]; minimumAmount: bigint }) =>
    o.candidates
      .filter((c) => BigInt(c.amount) >= o.minimumAmount)
      .map((c) => ({ amount: BigInt(c.amount) })),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ getBlockNumber: async () => 100n }),
}))
vi.mock("../../../src/features/migration/freezeWatch", () => ({ pause: async () => {} }))
vi.mock("../../../src/features/withdraw/oldVersionWithdrawals", () => ({
  getOldVersionWithdrawalStore: () => ({
    load: async () => {},
    list: () => m.pending,
    put: async (record: Record) => {
      m.saved.push(record)
      return record
    },
    update: async (_id: string, change: (record: Record) => Record) => {
      const next = change(m.saved.at(-1)!)
      m.saved.push(next)
      return next
    },
  }),
  pendingRefundIds: (records: Record[]) =>
    new Set(records.flatMap((r) => r.refunds.filter((f) => !f.l1TxHash).flatMap((f) => f.ids))),
  withdrawalSent: (record: Record) => record.refunds.reduce((sum, f) => sum + BigInt(f.usd), 0n),
  settleOldVersionWithdrawal: m.settle,
  setProducingOldVersionWithdrawal: m.producing,
}))

const { FrozenMetadataMigrationSource } = await import("@obsidion/sdk")
const { zkMoneyExit } = await import("../../../src/features/withdraw/zkMoneyExit")

const TO = `0x${"12".repeat(20)}` as const

function source(name: string, savings: boolean, amounts: bigint[]) {
  const candidates = amounts.map((amount, i) => ({ id: `${name}${i}`, amount: String(amount) }))
  const frozen = Object.assign(Object.create(FrozenMetadataMigrationSource.prototype), {
    runtime: { candidates: async () => ({ candidates }) },
    refundTo: vi.fn(
      async (_to, _tip, opts: { skip: Set<string>; onSent(refund: unknown): Promise<void> }) => {
        m.order.push(`refund ${name}`)
        const ids = candidates.filter((c) => !opts.skip.has(c.id)).map((c) => c.id)
        if (!ids.length) return { sent: [], stranded: 0n, waiting: 0n }
        await opts.onSent({ ids: [ids[0]], amount: amounts[0]!, txHash: `0xl2${name}` })
        return { sent: [], stranded: 1n, waiting: 2n }
      },
    ),
  })
  return {
    ws: {
      source: { portal: `0x${name}` },
      savings,
      open: async () => ({ source: frozen }),
      registration: async () => ({ controller: { load: async () => {} } }),
    } as never,
    read: { candidates } as never,
    frozen,
  }
}

// Savings shares are worth twice their units here.
const usd = (ws: { savings: boolean }, amount: bigint) => (ws.savings ? 2n * amount : amount)

beforeEach(() => {
  m.order = []
  m.saved = []
  m.pending = []
  m.producing.mockReset()
  m.register.mockReset().mockImplementation(async () => {
    m.order.push("register")
    return { phase: "done" }
  })
  // The portals run the refunds on the second look.
  m.settle.mockReset().mockImplementation(async (id: string) => {
    const record = m.saved.at(-1)!
    expect(record.id).toBe(id)
    return m.settle.mock.calls.length < 2
      ? record
      : {
          ...record,
          phase: "done",
          refunds: record.refunds.map((f, i) => ({ ...f, l1TxHash: `0xl1${i}` })),
        }
  })
})

describe("withdrawing old versions' funds to Ethereum from zk.money", () => {
  it("claims the name, records each refund as it is sent, then waits for Ethereum", async () => {
    const savings = source("s", true, [5n * TIP])
    const main = source("m", false, [3n * TIP])

    const result = await zkMoneyExit().run(
      [savings.ws, main.ws],
      TO,
      (stage) => m.order.push(stage),
      usd,
    )

    // Safe to close only once every refund is broadcast.
    expect(m.order).toEqual(["preparing", "register", "refund m", "refund s", "sending"])
    expect(main.frozen.refundTo).toHaveBeenCalledWith(TO, TIP, expect.anything())
    expect(m.saved.map((r) => r.refunds.length)).toEqual([1, 2, 2])
    expect(m.saved.at(-1)).toMatchObject({
      phase: "sending",
      allSent: true,
      feeUsd: String(TIP + 2n * TIP),
      refunds: [
        { ids: ["m0"], usd: String(2n * TIP), sentAt: expect.any(Number) },
        { ids: ["s0"], usd: String(2n * 4n * TIP), sentAt: expect.any(Number) },
      ],
    })
    expect(result).toEqual({ sent: 2n * TIP + 8n * TIP, left: 3n + 6n, hash: "0xl11" })
    // Process manually stays off the record only while the run sends.
    expect(m.producing.mock.calls).toEqual([[m.saved[0]!.id], [undefined]])
  })

  it("sends nothing when the name claim stops", async () => {
    m.register.mockResolvedValue({ phase: "needsAttention", error: "The record update failed" })
    const main = source("m", false, [3n * TIP])

    await expect(zkMoneyExit().run([main.ws], TO, () => {}, usd)).rejects.toThrow(
      "The record update failed",
    )
    expect(main.frozen.refundTo).not.toHaveBeenCalled()
  })

  it("never sends a refund again while it is on its way", async () => {
    m.pending = [
      { id: "earlier", phase: "sending", feeUsd: "0", refunds: [{ ids: ["m0"], usd: "1" }] },
    ]
    const main = source("m", false, [3n * TIP])
    const stages: string[] = []

    expect(await zkMoneyExit().fee([main])).toEqual({
      moving: { main: 0n, savings: 0n },
      tips: { main: 0n, savings: 0n },
    })
    await expect(
      zkMoneyExit().run([main.ws], TO, (stage) => stages.push(stage), usd),
    ).rejects.toThrow("Nothing is left to send")
    expect(stages).toEqual(["preparing"])
  })

  it("quotes what the refunds move and one tip for each refund that covers it", async () => {
    const main = source("m", false, [3n * TIP, TIP, 2n * TIP])
    const savings = source("s", true, [5n * TIP])

    expect(await zkMoneyExit().fee([main, savings])).toEqual({
      moving: { main: 5n * TIP, savings: 5n * TIP },
      tips: { main: 2n * TIP, savings: TIP },
    })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  noted: vi.fn(),
  /** The refund nullifier each L1 transaction ran. */
  ran: new Map<string, string>(),
}))
vi.mock("@obsidion/front-core", () => ({
  OldVersionWithdrawalStorage: class {
    load = async () => {}
    get = (id: string) => m.records.get(id) ?? null
    put = async (record: { id: string }) => {
      m.records.set(record.id, record)
      return record
    }
    update = async (id: string, change: (record: unknown) => unknown) => {
      const next = change(m.records.get(id))
      m.records.set(id, next)
      return next
    }
  },
  useCachedRecords: () => ({ records: [], hydrated: true }),
  SWAP_STUCK_THRESHOLD_MS: 5 * 60 * 1000,
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({
    getBlockNumber: async () => 25_000n,
    getContractEvents: async ({ args }: { args: { nullifier: string[] } }) =>
      [...m.ran]
        .filter(([, id]) => args.nullifier.includes(id))
        .map(([transactionHash]) => ({ transactionHash })),
  }),
}))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../../../../src/features/savings/savingsMoveStore", () => ({ noteRefundedSavingsMoves: m.noted }))

const {
  noteSelfRefunded,
  oldVersionRefundOffer,
  setProducingOldVersionWithdrawal,
  settleOldVersionWithdrawal,
} = await import("../../../../src/features/withdraw/oldVersionWithdrawals")

const TO = `0x${"f1".repeat(20)}`
const record = {
  id: "w1",
  startTime: 1,
  to: TO,
  feeUsd: String(2n * 10n ** 17n),
  fromBlock: "10",
  allSent: true,
  phase: "sending",
  refunds: [
    {
      portal: "0xold",
      ids: ["a"],
      deposits: [{ leafIndex: "7", amount: "1" }],
      usd: String(1965n * 10n ** 16n),
      l2TxHash: "0x01",
    },
    { portal: "0xold", ids: ["b", "c"], usd: String(965n * 10n ** 16n), l2TxHash: "0x02" },
  ],
}

beforeEach(() => {
  m.records = new Map([["w1", record]])
  m.ran = new Map()
  m.noted.mockReset()
})

describe("following a withdrawal of old-version funds", () => {
  it("stays pending until the portal ran every refund", async () => {
    m.ran.set("0xaaa", "a")
    expect(await settleOldVersionWithdrawal("w1")).toMatchObject({
      phase: "sending",
      refunds: [{ l1TxHash: "0xaaa" }, { ids: ["b", "c"] }],
    })
    // The Savings moves whose deposits the refund returned end as recovered.
    expect(m.noted).toHaveBeenCalledWith([{ leafIndex: "7", amount: "1" }], TO, "0xaaa")

    m.ran.set("0xbbb", "c")
    expect(await settleOldVersionWithdrawal("w1")).toMatchObject({
      phase: "done",
      refunds: [{ l1TxHash: "0xaaa" }, { l1TxHash: "0xbbb" }],
    })
  })

  it("ends a withdrawal whose broadcasts L2 dropped as failed, freeing its funds", async () => {
    const dropped = async () => "dropped" as const
    expect(await settleOldVersionWithdrawal("w1", dropped)).toMatchObject({
      phase: "failed",
      refunds: [{ dropped: true }, { dropped: true }],
    })
  })

  it("keeps a refund the run adds during a check, and stays pending until the run sent its last", async () => {
    m.ran.set("0xaaa", "a")
    m.ran.set("0xbbb", "b")
    m.records.set("w1", { ...record, allSent: false })
    const settling = settleOldVersionWithdrawal("w1")
    // The run sends a third refund while the check reads L1.
    const third = { portal: "0xold", ids: ["d"], usd: "1", l2TxHash: "0x03" }
    m.records.set("w1", { ...record, allSent: false, refunds: [...record.refunds, third] })
    expect(await settling).toMatchObject({
      phase: "sending",
      refunds: [{ l1TxHash: "0xaaa" }, { l1TxHash: "0xbbb" }, { ids: ["d"] }],
    })
  })
})

describe("processing an old-version withdrawal manually", () => {
  const WAIT = 5 * 60 * 1000
  const late = record.startTime + WAIT

  it("offers the first refund no relayer ran once a swap's wait passed since it was sent", () => {
    const sent = {
      ...record,
      refunds: [
        { ...record.refunds[0], sentAt: 100 },
        { ...record.refunds[1], sentAt: 100 + 3 * 60 * 1000 },
      ],
    }
    expect(oldVersionRefundOffer(sent as never, 100 + WAIT - 1)).toBeUndefined()
    expect(oldVersionRefundOffer(sent as never, 100 + WAIT)).toMatchObject({ l2TxHash: "0x01" })
    const ran = { ...sent, refunds: [{ ...sent.refunds[0], l1TxHash: "0xaaa" }, sent.refunds[1]] }
    expect(oldVersionRefundOffer(ran as never, 100 + WAIT)).toBeUndefined()
    expect(oldVersionRefundOffer(ran as never, sent.refunds[1].sentAt + WAIT)).toMatchObject({
      l2TxHash: "0x02",
    })
  })

  it("offers nothing on a withdrawal that ended, or whose refunds ran or were dropped", () => {
    expect(oldVersionRefundOffer({ ...record, phase: "done" } as never, late)).toBeUndefined()
    const refunds = [
      { ...record.refunds[0], l1TxHash: "0xaaa" },
      { ...record.refunds[1], dropped: true },
    ]
    expect(oldVersionRefundOffer({ ...record, refunds } as never, late)).toBeUndefined()
  })

  it("offers nothing while this tab's zk.money run is still sending it", () => {
    setProducingOldVersionWithdrawal("w1")
    expect(oldVersionRefundOffer(record as never, late)).toBeUndefined()
    setProducingOldVersionWithdrawal(undefined)
    expect(oldVersionRefundOffer(record as never, late)).toBeDefined()
  })

  it("ends the withdrawal once the user sent its last refund, even after L2 dropped its broadcast", async () => {
    // The run that sent it stopped before it saved its last send.
    const { allSent: _, ...stopped } = record
    m.records.set("w1", {
      ...stopped,
      refunds: [
        { ...record.refunds[0], l1TxHash: "0xaaa" },
        { ...record.refunds[1], dropped: true },
      ],
    })
    expect(await noteSelfRefunded("w1", record.refunds[1] as never, "0xself")).toMatchObject({
      phase: "done",
      allSent: true,
      refunds: [{ l1TxHash: "0xaaa" }, { l1TxHash: "0xself", dropped: undefined }],
    })
    expect(m.noted).toHaveBeenCalledWith([], TO, "0xself")
  })

  it("keeps a refund the user sent counted when a check that read L2 before it lands after", async () => {
    m.records.set("w1", {
      ...record,
      refunds: [{ ...record.refunds[0], l1TxHash: "0xaaa" }, record.refunds[1]],
    })
    const dropped = async () => {
      // The user's refund is saved while the check waits on L2.
      await noteSelfRefunded("w1", record.refunds[1] as never, "0xself")
      return "dropped" as const
    }
    const settled = await settleOldVersionWithdrawal("w1", dropped)
    expect(settled).toMatchObject({ phase: "done", refunds: [{}, { l1TxHash: "0xself" }] })
    expect(settled!.refunds[1]!.dropped).toBeFalsy()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"

vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../../src/features/deposit/sipaRecovery", () => ({}))
vi.mock("../../../../src/features/migration/oldVersionWithdraw", () => ({}))
vi.mock("../../../../src/features/withdraw/oldVersionWithdrawals", () => ({}))

const { selfRefundOldVersionWithdrawal } = await import(
  "../../../../src/features/withdraw/oldVersionSelfRefund"
)

const TO = `0x${"f1".repeat(20)}`
const PAYER = `0x${"44".repeat(20)}` as Address
const PORTAL = `0x${"cc".repeat(20)}`
const HASH = `0x${"ab".repeat(32)}` as Hex

const refund = { portal: PORTAL, ids: ["b", "c"], usd: "1", l2TxHash: "0x02" }
const record = {
  id: "w1",
  startTime: 1,
  to: TO,
  feeUsd: "0",
  fromBlock: "10",
  allSent: true,
  phase: "sending" as const,
  refunds: [{ portal: PORTAL, ids: ["a"], usd: "1", l2TxHash: "0x01", l1TxHash: "0xaaa" }, refund],
}

let left: Map<string, "note" | "escrow-note">
let ranOnL1: boolean
const runtime = {
  candidates: vi.fn(async () => ({
    maxNotesPerBatch: 10,
    maxBatchAmount: 1_000n,
    candidates: [...left].map(([id, kind]) => ({ id, amount: "5", kind })),
  })),
  build: vi.fn(async () => ({
    amount: 10n,
    operation: { target: EthAddress.fromString(PORTAL), calldata: Buffer.from("cafe", "hex") },
  })),
}
const lock = vi.fn(<T>(fn: () => Promise<T>) => fn())
const open = vi.fn(async () => ({ runtime, lock, symbol: "DAI", decimals: 18 }))
const channel = {
  target: PAYER,
  sendTransaction: vi.fn(async () => HASH),
  waitForReceipt: vi.fn(async () => true),
}
const settle = vi.fn(async () => ({
  ...record,
  refunds: [record.refunds[0]!, { ...refund, ...(ranOnL1 ? { l1TxHash: "0xrelayer" } : {}) }],
}))

const saveRun = vi.fn(async () => {})
const send = () =>
  selfRefundOldVersionWithdrawal(record, refund, { channel, open, settle, saveRun } as never)

beforeEach(() => {
  left = new Map([
    ["b", "note"],
    ["c", "note"],
    ["z", "note"],
  ])
  ranOnL1 = false
  vi.clearAllMocks()
})

describe("processing an old-version refund from the user's wallet", () => {
  it("rebuilds the same refund to the withdrawal's address, tipping the wallet that sends it", async () => {
    expect(await send()).toBe(HASH)
    expect(open).toHaveBeenCalledWith(PAYER)
    expect(lock).toHaveBeenCalledOnce()
    expect(runtime.build).toHaveBeenCalledWith({ kind: "note", ids: ["b", "c"] }, TO, TIP)
    expect(channel.sendTransaction).toHaveBeenCalledWith(PORTAL, "0xcafe")
    expect(saveRun).toHaveBeenCalledWith("w1", refund, HASH)
  })

  it("sends nothing once a relayer ran the refund", async () => {
    ranOnL1 = true
    await expect(send()).rejects.toThrow(/A relayer sent this withdrawal first/)
    expect(open).not.toHaveBeenCalled()
  })

  it("sends nothing when a relayer runs it before the portal is read", async () => {
    left.delete("c")
    settle
      .mockImplementationOnce(async () => record)
      .mockImplementationOnce(async () => {
        ranOnL1 = true
        return settle()
      })
    await expect(send()).rejects.toThrow(/A relayer sent this withdrawal first/)
    expect(runtime.build).not.toHaveBeenCalled()
  })

  it("refuses a refund whose funds the portal no longer lists", async () => {
    left.delete("c")
    await expect(send()).rejects.toThrow(/can't be refunded right now/)
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses a refund that would mix kinds of funds", async () => {
    left.set("c", "escrow-note")
    await expect(send()).rejects.toThrow(/mixes kinds/)
    expect(runtime.build).not.toHaveBeenCalled()
  })

  it.each([
    ["a relayer ran it meanwhile", true, /A relayer sent this withdrawal first/],
    ["nothing ran", false, /reverted, so nothing moved/],
  ])("explains a reverted transaction when %s", async (_, ran, message) => {
    channel.waitForReceipt.mockImplementationOnce(async () => {
      ranOnL1 = ran
      return false
    })
    await expect(send()).rejects.toThrow(message)
    expect(saveRun).not.toHaveBeenCalled()
  })

  it("says a relayer was first when it wins while estimating its gas", async () => {
    channel.sendTransaction.mockImplementationOnce(async () => {
      ranOnL1 = true
      throw new Error("A selected frozen note is no longer refundable")
    })
    await expect(send()).rejects.toThrow(/A relayer sent this withdrawal first/)
    expect(saveRun).not.toHaveBeenCalled()
  })

  it("keeps the wallet's own error when nothing ran", async () => {
    const rejected = Object.assign(new Error("User rejected"), { code: 4001 })
    channel.sendTransaction.mockRejectedValueOnce(rejected)
    await expect(send()).rejects.toBe(rejected)
  })
})

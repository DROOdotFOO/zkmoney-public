import { describe, expect, it, vi } from "vitest"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
  estimateFrozenSelfRefundCost,
  nextFrozenSelfRefund,
  planFrozenSelfRefunds,
} from "../../../src/services/migration/FrozenRefundMigrationRuntime.js"

describe("nextFrozenSelfRefund", () => {
  const recipient = "0x00000000000000000000000000000000000000aa"
  const selfRuntime = (
    candidates: Array<{ id: string; amount: string; leafIndex?: string }>,
    waiting = 0n,
    kind: "note" | "frozen-deposit" = "note",
  ) => ({
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n,
      waiting,
      candidates: candidates.map((c) => ({ ...c, kind })),
    })),
    build: vi.fn<
      (selection: { ids: string[] }) => Promise<{
        amount: bigint
        operation: { target: EthAddress; calldata: Buffer }
      }>
    >(async () => ({
      amount: 5n,
      operation: {
        target: EthAddress.fromString("0x00000000000000000000000000000000000000bb"),
        calldata: Buffer.from([0x12, 0x34]),
      },
    })),
  })

  it("proves a capped batch paid in full to the submitter, with no relayer tip", async () => {
    const rt = selfRuntime(
      [
        { id: "a", amount: "1" },
        { id: "b", amount: "2" },
        { id: "c", amount: "3" },
      ],
      7n,
    )
    const next = await nextFrozenSelfRefund(rt as never, recipient, { fresh: true })
    expect(rt.candidates).toHaveBeenCalledWith({ fresh: true })
    expect(rt.build).toHaveBeenCalledWith(
      { kind: "note", ids: expect.any(Array), amount: expect.any(BigInt) },
      recipient,
      0n,
    )
    expect(rt.build.mock.calls[0]![0].ids).toHaveLength(2)
    expect(next).toEqual({
      remaining: 6n,
      waiting: 7n,
      refund: {
        ids: rt.build.mock.calls[0]![0].ids,
        deposits: [],
        amount: 5n,
        to: "0x00000000000000000000000000000000000000bb",
        data: "0x1234",
      },
    })
  })

  it("names the deposits a refund covers by their Inbox leaf index and amount", async () => {
    const rt = selfRuntime([{ id: "d", amount: "4", leafIndex: "9" }], 0n, "frozen-deposit")
    expect((await nextFrozenSelfRefund(rt as never, recipient)).refund?.deposits).toEqual([
      { leafIndex: "9", amount: "4" },
    ])
  })

  it("builds nothing once no refundable batch is left", async () => {
    const rt = selfRuntime([], 7n)
    expect(await nextFrozenSelfRefund(rt as never, recipient)).toEqual({
      remaining: 0n,
      waiting: 7n,
    })
    expect(rt.build).not.toHaveBeenCalled()
  })
})

describe("planFrozenSelfRefunds", () => {
  it("plans every capped batch nextFrozenSelfRefund would send", () => {
    const batches = planFrozenSelfRefunds({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n,
      candidates: [
        { id: "a", amount: "1", kind: "note" },
        { id: "b", amount: "2", kind: "note" },
        { id: "c", amount: "3", kind: "note" },
        { id: "d", amount: "9", kind: "frozen-deposit" },
      ],
    })
    expect(batches.map((b) => b.kind).sort()).toEqual(["frozen-deposit", "note", "note"])
    expect(batches.flatMap((b) => b.ids).sort()).toEqual(["a", "b", "c", "d"])
  })
})

describe("estimateFrozenSelfRefundCost", () => {
  it("prices each refund at the subsidy's modeled gas, the gas price and its feed", async () => {
    const gas: Record<string, bigint> = {
      FROZEN_NOTES_REFUND_TX_GAS: 2_350_000n,
      FROZEN_DEPOSITS_REFUND_TX_GAS: 2_245_000n,
    }
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "PRICE_FEED"
          ? "0x00000000000000000000000000000000000000fe"
          : functionName === "latestRoundData"
          ? [1n, 2000n * 10n ** 8n, 0n, 100n, 1n]
          : gas[functionName],
      ),
      getBlock: vi.fn(async () => ({ timestamp: 100n })),
      getGasPrice: vi.fn(async () => 10n ** 9n),
    }
    const cost = await estimateFrozenSelfRefundCost(
      client as never,
      "0x00000000000000000000000000000000000000aa",
      ["note", "note", "frozen-deposit"],
    )
    expect(cost.wei).toBe((2n * 2_350_000n + 2_245_000n) * 10n ** 9n)
    // 0.006945 ETH at $2,000.
    expect(cost.usd).toBe(1389n * 10n ** 16n)
  })
})

import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"

import type { SavingsMoveRecord } from "@obsidion/front-core"
import { getSavingsMoveStore } from "../../../src/features/savings/savingsMoveStore"

const { frozenExitSummary, runFrozenExit } = await import("../../../src/features/withdraw/frozenExitRun")

const USER = `0x${"44".repeat(20)}` as Address
const PORTAL = `0x${"cc".repeat(20)}`

/** A frozen portal holding `notes`, which refunds whatever a confirmed transaction named. */
function frozenPortal(notes: Record<string, bigint>, kind: "note" | "frozen-deposit" = "note") {
  const left = new Map(Object.entries(notes))
  let pending: string[] = []
  const runtime = {
    candidates: vi.fn(async (_opts?: { fresh?: boolean }) => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1_000n,
      waiting: 9n,
      candidates: [...left].map(([id, amount]) => ({
        id,
        amount: String(amount),
        kind,
        ...(kind === "frozen-deposit" ? { leafIndex: `${id}-leaf` } : {}),
      })) as Array<{ id: string; amount: string; kind: typeof kind; leafIndex?: string }>,
    })),
    build: vi.fn(async ({ ids }: { ids: string[] }, recipient: Address, tip: bigint) => {
      expect([recipient, tip]).toEqual([USER, 0n])
      pending = ids
      return {
        amount: ids.reduce((sum, id) => sum + left.get(id)!, 0n),
        operation: { target: EthAddress.fromString(PORTAL), calldata: Buffer.from(ids.join(",")) },
      }
    }),
  }
  let n = 0
  const channel = {
    target: USER,
    sendTransaction: vi.fn(async (to: Address) => {
      expect(to).toBe(PORTAL)
      return `0x${String(++n).padStart(64, "0")}` as Hex
    }),
    waitForReceipt: vi.fn(async () => {
      pending.forEach((id) => left.delete(id))
      return true
    }),
  }
  return { runtime, channel }
}

describe("the frozen-portal exit", () => {
  it.each([
    ["at once", false],
    ["when a timed-out receipt confirms on the next run", true],
  ])(
    "marks an old version's Savings move recovered once its refund runs, %s",
    async (_, timeout) => {
      const moves = getSavingsMoveStore()
      const move = (id: string, deposit: { inboxIndex: string; amount: string }) =>
        ({
          withdrawalLocalId: id,
          direction: "in",
          amount: "1",
          startTime: 1,
          retired: true,
          deposit: { ...deposit, claimed: false },
        } as SavingsMoveRecord)
      await moves.put(move("a", { inboxIndex: "a-leaf", amount: "1" }))
      // Another rollup's Inbox can hold the same leaf index.
      await moves.put(move("other", { inboxIndex: "a-leaf", amount: "7" }))
      const { runtime, channel } = frozenPortal({ a: 1n }, "frozen-deposit")
      if (timeout) {
        channel.waitForReceipt.mockRejectedValueOnce(new Error("timed out"))
        await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/timed out/)
        expect(moves.get("a")?.recovered).toBeUndefined()
      }
      await runFrozenExit(runtime as never, channel)
      const [hash] = await Promise.all(channel.sendTransaction.mock.results.map((r) => r.value))
      expect(moves.get("a")?.recovered).toEqual({ to: USER, txHashes: [hash] })
      expect(moves.get("other")?.recovered).toBeUndefined()
      await moves.remove("a")
      await moves.remove("other")
    },
  )

  it("counts a note above the portal's cap as not yet withdrawable", async () => {
    const { runtime } = frozenPortal({ a: 1n, big: 5_000n })
    expect(frozenExitSummary(await runtime.candidates({ fresh: true }))).toEqual({
      refundable: 1n,
      links: 0n,
      waiting: 5_009n,
    })
  })

  it("refunds payment link notes with the account's and names their part", async () => {
    const { runtime } = frozenPortal({ a: 1n })
    runtime.candidates.mockResolvedValueOnce({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1_000n,
      waiting: 0n,
      candidates: [
        { id: "a", amount: "1", kind: "note" as const },
        { id: "l", amount: "4", kind: "escrow-note" as never },
      ],
    })
    expect(frozenExitSummary(await runtime.candidates({ fresh: true }))).toEqual({
      refundable: 5n,
      links: 4n,
      waiting: 0n,
    })
  })

  it("stops on a reverted refund", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockResolvedValueOnce(false)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/reverted/)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("waits for a refund whose receipt timed out before sending again", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockRejectedValueOnce(new Error("timed out"))
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/timed out/)
    await runFrozenExit(runtime as never, channel)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("refuses a second run while one is in flight", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    const first = runFrozenExit(runtime as never, channel)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/already running/)
    await expect(first).resolves.toMatchObject({ refunded: 1n })
  })

  it("never sends a batch again while the portal still lists it", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockResolvedValue(true)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/already sent/)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })
})

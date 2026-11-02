/** How a sent broadcast's receipt reads to the ledger: included, still pending, or dropped. */
import { describe, expect, it } from "vitest"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { broadcastState } from "../../../src/features/broadcasts/broadcastState"

const hash = `0x${"11".repeat(32)}`
const wallet = (receipt: () => Promise<unknown>) =>
  ({ node: { getTxReceipt: receipt } } as unknown as Parameters<typeof broadcastState>[0])

describe("broadcastState", () => {
  it("reads an included broadcast as included", async () => {
    const w = wallet(async () => ({
      status: TxStatus.PROVEN,
      executionResult: TxExecutionResult.SUCCESS,
      blockNumber: 12,
    }))
    expect(await broadcastState(w, hash)).toBe("included")
  })

  it("reads a broadcast the node still holds as pending", async () => {
    const w = wallet(async () => ({ status: TxStatus.PENDING }))
    expect(await broadcastState(w, hash)).toBe("pending")
  })

  it("reads a dropped or reverted broadcast as dropped", async () => {
    expect(
      await broadcastState(
        wallet(async () => ({ status: TxStatus.DROPPED })),
        hash,
      ),
    ).toBe("dropped")
    const reverted = wallet(async () => ({
      status: TxStatus.PROVEN,
      executionResult: TxExecutionResult.REVERTED,
      blockNumber: 12,
    }))
    expect(await broadcastState(reverted, hash)).toBe("dropped")
  })

  it("treats an unreachable node as pending, so nothing is repeated on a guess", async () => {
    const w = wallet(async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(await broadcastState(w, hash)).toBe("pending")
  })
})

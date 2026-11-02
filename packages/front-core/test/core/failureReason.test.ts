// @vitest-environment node
import { describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { failureReason, REORGED_ERROR } from "../../src/core/failureReason"
import type { Transaction } from "../../src/types/transactions"

const row = (action: string, over: Partial<Transaction> = {}) =>
  ({
    id: "r",
    action,
    status: "failed",
    timestamp: 1,
    txHash: "0x1",
    amountAtomic: 0n,
    ...over,
  } as Transaction)

describe("failureReason", () => {
  it("names the reorg for a landed row it took back, and only for a landed one", () => {
    const reorged = { reorgEpoch: 1, blockNumber: 42 }
    for (const action of ["receive", "send", PaylinkActionEnum.PAY, PaylinkActionEnum.CLAIM]) {
      expect(failureReason(row(action, reorged))?.startsWith(REORGED_ERROR)).toBe(true)
    }
    // A send the network dropped before it ever landed was no reorg.
    expect(failureReason(row("send", { reorgEpoch: 1 }))).toBe(failureReason(row("send")))
    expect(failureReason(row("receive", { ...reorged, status: "success" }))).toBeUndefined()
  })
})

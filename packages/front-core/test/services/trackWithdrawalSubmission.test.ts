import { memoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
import { beforeEach, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec-labs/stdlib/tx"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { createWithdrawals, type Withdrawals } from "../../src/engine/withdrawals"
import { trackWithdrawalSubmission } from "../../src/engine/withdrawalTracker"

const hash = `0x${"11".repeat(32)}` as const
let store: Withdrawals
beforeEach(async () => {
  store = createWithdrawals({ db: openDatabase(memoryBackend()) })
  await store.create({
    networkId: "0xnet",
    localId: "test",
    recipient: `0x${"22".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "1",
    tokenSymbol: "DAI",
    source: "paylink",
    phase: "submitting",
    startTime: Date.now(),
  })
})

it.each([TxStatus.DROPPED, TxStatus.PROVEN])(
  "does not recover unsuccessful receipt %s as pending",
  async (status) => {
    const monitor = trackWithdrawalSubmission(store, "test", "op")
    try {
      provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
      const node = {
        getTxReceipt: vi.fn(async () => ({ status, executionResult: TxExecutionResult.REVERTED })),
      }
      expect(await monitor.recover(node as never)).toBeNull()
    } finally {
      monitor.stop()
    }
  },
)

it("keeps an ambiguous transport failure and ignores unrelated operations", async () => {
  const monitor = trackWithdrawalSubmission(store, "test", "op")
  const node = {
    getTxReceipt: vi.fn(async () => {
      throw new Error("offline")
    }),
  }
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "unrelated", hash)
    expect(await monitor.recover(node as never)).toBeNull()
    await monitor.stamp(hash)
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await monitor.recover(node as never)).toMatchObject({
      phase: "submitting",
      l2TxHash: hash,
    })
  } finally {
    monitor.stop()
  }
  provingProgress.emitStageStart(ProvingStage.Mining, "op", `0x${"33".repeat(32)}`)
  expect((await store.get("test"))?.l2TxHash).toBe(hash)
})

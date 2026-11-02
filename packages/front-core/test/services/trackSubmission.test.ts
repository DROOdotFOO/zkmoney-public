import { expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec-labs/stdlib/tx"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import {
  conflictingPendingTx,
  trackSubmission,
} from "../../src/core/services/transactions/trackSubmission"

const hash = `0x${"11".repeat(32)}` as const
const receipt = (status: TxStatus, executionResult?: TxExecutionResult) => ({
  getTxReceipt: vi.fn(async () => ({ status, executionResult })),
})

it("reports nothing submitted when the boundary was never crossed", async () => {
  const submission = trackSubmission("op")
  try {
    expect(submission.txHash).toBeUndefined()
    expect(await submission.survived(receipt(TxStatus.SUCCESS) as never)).toBeNull()
  } finally {
    submission.stop()
  }
})

it("survives a receipt that does not prove failure", async () => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    const node = receipt(TxStatus.PROVEN, TxExecutionResult.SUCCESS)
    expect(await submission.survived(node as never)).toBe(hash)
  } finally {
    submission.stop()
  }
})

it.each([
  ["dropped", TxStatus.DROPPED, undefined],
  ["reverted", TxStatus.PROVEN, TxExecutionResult.REVERTED],
])("does not survive a %s receipt", async (_label, status, execution) => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await submission.survived(receipt(status, execution) as never)).toBeNull()
  } finally {
    submission.stop()
  }
})

// The bug this exists for: an unreachable node is not evidence the transfer failed.
it("keeps the hash when the receipt lookup itself fails", async () => {
  const submission = trackSubmission("op")
  const node = {
    getTxReceipt: vi.fn(async () => {
      throw new Error("offline")
    }),
  }
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await submission.survived(node as never)).toBe(hash)
  } finally {
    submission.stop()
  }
})

it("ignores another operation's boundary", async () => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "other", hash)
    expect(submission.txHash).toBeUndefined()
    expect(await submission.survived(receipt(TxStatus.PROVEN) as never)).toBeNull()
  } finally {
    submission.stop()
  }
})

it("stops listening after stop", () => {
  const submission = trackSubmission("op")
  submission.stop()
  provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
  expect(submission.txHash).toBeUndefined()
})

// The wallet emits Mining only once the flow's `onTxHash` saved the hash, so Mining is the save.
it.each([
  ["by default", {}, [{ operationId: "op", txHash: hash }]],
  ["not for a record riding another's tx", { announce: false }, []],
])("announces the hash as saved at the boundary, once, %s", async (_label, opts, expected) => {
  const saved = vi.fn()
  provingProgress.on("tx-hash-saved", saved)
  const submission = trackSubmission("op", opts)
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(saved.mock.calls.map(([event]) => event)).toEqual(expected)
  } finally {
    submission.stop()
    provingProgress.off("tx-hash-saved", saved)
  }
})

it("names the pending transaction a node refused a conflicting one for, through any cause", () => {
  const held = `0x${"0A".repeat(32)}`
  const refusal = new Error(
    `Nullifier conflict with existing tx ${held}. Minimum required fee: 1, got: 0`,
  )
  expect(conflictingPendingTx(refusal)).toBe(held.toLowerCase())
  expect(conflictingPendingTx(new Error("send failed", { cause: refusal }))).toBe(
    held.toLowerCase(),
  )
  expect(conflictingPendingTx(new Error("Receipt timed out"))).toBeUndefined()
})

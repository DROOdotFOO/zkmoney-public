import { describe, expect, it } from "vitest"
import { sourceSavingsDeposits } from "../../../../src/features/migration/sourceSavingsDeposits"

const target = {
  portal: "sky-v5",
  rollupVersion: "5",
  plainWithdrawalExecutor: "executor",
} as never

describe("source Savings deposit recovery", () => {
  it("propagates source-event failures instead of reporting an empty deposit list", async () => {
    const unavailable = new Error("source unavailable")
    const savingsMoves = async () => {
      throw unavailable
    }
    await expect(
      sourceSavingsDeposits({
        chain: { kind: "generation", session: { address: "account", savingsMoves } } as never,
        tuple: target,
        sourceTuples: [target],
        publicClient: {} as never,
        masterSecret: {} as never,
        scanHead: 2000n,
      }),
    ).rejects.toBe(unavailable)
  })
})

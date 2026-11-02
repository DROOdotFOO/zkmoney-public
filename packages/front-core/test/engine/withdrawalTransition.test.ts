import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import {
  isDemotable,
  withdrawalTransition,
  type WithdrawalEvent,
} from "../../src/engine/withdrawalTransition"

const HASH = `0x${"ab".repeat(32)}` as const
const NOW = 9_000

const base = {
  localId: "w1",
  recipient: "0x0000000000000000000000000000000000000001",
  recipientProvenance: "saved-recipient",
  amount: "1",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  startTime: 1_000,
} as const

const states: Record<string, Partial<WithdrawalRecord>> = {
  "submitting": { phase: "submitting" },
  "submitting+hash": { phase: "submitting", l2TxHash: HASH },
  "l2_mined": { phase: "l2_mined", l2TxHash: HASH },
  "awaiting_proven": { phase: "awaiting_proven", l2TxHash: HASH, endTime: 5 },
  "finalizing_l1": { phase: "finalizing_l1", l2TxHash: HASH, finalizeTxHash: "0xf" },
  "swapping": { phase: "swapping", l2TxHash: HASH },
  "done": { phase: "done", l2TxHash: HASH, endTime: 7 },
  "failed": { phase: "failed", failure: { code: "withdrawal.failed" }, endTime: 7 },
  "dropped": { phase: "failed", l2TxHash: HASH, droppedBurn: true, reorgEpoch: 1, endTime: 7 },
  "demoted@1": { phase: "l2_mined", l2TxHash: HASH, reorgEpoch: 1 },
}

const record = (state: string) => ({ ...base, ...states[state] } as WithdrawalRecord)

const events: Record<string, WithdrawalEvent> = {
  "patch done": { type: "patch", fields: { phase: "done" } },
  "patch done@1": { type: "patch", fields: { phase: "done", reorgEpoch: 1 } },
  "demoted": { type: "demoted" },
  "demoted dropped": { type: "demoted", droppedBurn: true },
  "revived": { type: "revived" },
  "burnDropped": { type: "burnDropped", at: 50 },
  "interrupted": { type: "interrupted" },
}

// `phase epoch endTime`, or "-" when the record is left as it is.
const table: Record<string, Record<string, string>> = {
  "submitting": {
    "patch done": `done 0 ${NOW}`,
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "-",
    "burnDropped": "-",
    "interrupted": `failed 0 ${NOW}`,
  },
  "submitting+hash": {
    "patch done": `done 0 ${NOW}`,
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "-",
    "burnDropped": "-",
    "interrupted": "-",
  },
  "l2_mined": {
    "patch done": `done 0 ${NOW}`,
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "l2_mined 1 -",
    "demoted dropped": `failed 1 ${NOW}`,
    "revived": "-",
    "burnDropped": "l2_mined 0 -",
    "interrupted": "-",
  },
  "awaiting_proven": {
    "patch done": "done 0 5",
    "patch done@1": "done 1 5",
    "demoted": "l2_mined 1 -",
    "demoted dropped": `failed 1 ${NOW}`,
    "revived": "-",
    "burnDropped": "awaiting_proven 0 5",
    "interrupted": "-",
  },
  "finalizing_l1": {
    "patch done": `done 0 ${NOW}`,
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "awaiting_proven 1 -",
    "demoted dropped": `failed 1 ${NOW}`,
    "revived": "-",
    "burnDropped": "finalizing_l1 0 -",
    "interrupted": "-",
  },
  "swapping": {
    "patch done": `done 0 ${NOW}`,
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "-",
    "burnDropped": "-",
    "interrupted": "-",
  },
  "done": {
    "patch done": "done 0 7",
    "patch done@1": "done 1 7",
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "-",
    "burnDropped": "-",
    "interrupted": "-",
  },
  "failed": {
    "patch done": "done 0 7",
    "patch done@1": "done 1 7",
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "-",
    "burnDropped": "-",
    "interrupted": "-",
  },
  "dropped": {
    "patch done": "-",
    "patch done@1": "done 1 7",
    "demoted": "-",
    "demoted dropped": "-",
    "revived": "l2_mined 2 -",
    "burnDropped": "-",
    "interrupted": "-",
  },
  "demoted@1": {
    "patch done": "-",
    "patch done@1": `done 1 ${NOW}`,
    "demoted": "l2_mined 2 -",
    "demoted dropped": `failed 2 ${NOW}`,
    "revived": "-",
    "burnDropped": "l2_mined 1 -",
    "interrupted": "-",
  },
}

const outcome = (next: WithdrawalRecord | undefined) =>
  next ? `${next.phase} ${next.reorgEpoch ?? 0} ${next.endTime ?? "-"}` : "-"

describe("withdrawalTransition: every event against every state", () => {
  for (const [state, row] of Object.entries(table)) {
    for (const [name, expected] of Object.entries(row)) {
      it(`${state} + ${name} → ${expected}`, () => {
        expect(outcome(withdrawalTransition(record(state), events[name], NOW))).toBe(expected)
      })
    }
  }
})

describe("withdrawalTransition: what each event writes", () => {
  it("a patch keeps the localId and merges its fields", () => {
    const next = withdrawalTransition(
      record("l2_mined"),
      { type: "patch", fields: { phase: "l2_mined", localId: "other", withdrawalId: "0x1" } },
      NOW,
    )
    expect(next).toMatchObject({ localId: "w1", withdrawalId: "0x1" })
  })

  it("mined stamps the burn data, keeps known figures and the first mined time", () => {
    const seeded = { ...record("submitting"), rawAmount: "10", relayerTip: "1", minedAt: 3 }
    expect(
      withdrawalTransition(seeded, { type: "mined", l2TxHash: HASH, blockNumber: 4 }, NOW),
    ).toMatchObject({
      phase: "l2_mined",
      l2TxHash: HASH,
      blockNumber: 4,
      rawAmount: "10",
      relayerTip: "1",
      minedAt: 3,
    })
    const fresh = withdrawalTransition(
      record("submitting"),
      { type: "mined", l2TxHash: HASH, blockNumber: 4, rawAmount: "9", relayerTip: "2" },
      NOW,
    )
    expect(fresh).toMatchObject({ rawAmount: "9", relayerTip: "2", minedAt: NOW })
  })

  it("mined refuses a hash that is not 32 bytes of hex", () => {
    expect(() =>
      withdrawalTransition(
        record("submitting"),
        { type: "mined", l2TxHash: "0x12", blockNumber: 1 },
        NOW,
      ),
    ).toThrow(/32-byte/)
  })

  it("a demote drops the finalization hash and re-dates the phase", () => {
    expect(withdrawalTransition(record("finalizing_l1"), { type: "demoted" }, NOW)).toMatchObject({
      finalizeTxHash: undefined,
      phaseEnteredAt: NOW,
    })
    expect(
      withdrawalTransition(record("l2_mined"), { type: "demoted", droppedBurn: true }, NOW),
    ).toMatchObject({ droppedBurn: true, failure: { code: "withdrawal.reorged" } })
  })

  it("a revive clears the failure", () => {
    const revived = withdrawalTransition(
      { ...record("dropped"), burnDroppedAt: 2 },
      { type: "revived" },
      NOW,
    )
    expect(revived).toMatchObject({
      failure: undefined,
      droppedBurn: undefined,
      burnDroppedAt: undefined,
    })
  })

  it("burnDropped keeps the first time, and clears in any phase", () => {
    const at = withdrawalTransition(record("l2_mined"), { type: "burnDropped", at: 50 }, NOW)!
    expect(at.burnDroppedAt).toBe(50)
    expect(withdrawalTransition(at, { type: "burnDropped", at: 60 }, NOW)).toBeUndefined()
    const done = { ...record("done"), burnDroppedAt: 50 }
    expect(
      withdrawalTransition(done, { type: "burnDropped", at: undefined }, NOW)?.burnDroppedAt,
    ).toBeUndefined()
    expect(
      withdrawalTransition(record("done"), { type: "burnDropped", at: undefined }, NOW),
    ).toBeUndefined()
  })

  it("interrupted fails the record as interrupted", () => {
    expect(
      withdrawalTransition(record("submitting"), { type: "interrupted" }, NOW)?.failure,
    ).toEqual({ code: "withdrawal.interrupted" })
  })

  it("executorMigrated stamps a version 1 record once", () => {
    const v1 = {
      ...record("done"),
      deployment: { portal: "0xp", l2Token: "0xt" },
    } as WithdrawalRecord
    const burn = { executor: "0xe" as const, withdrawalFee: 5n }
    const next = withdrawalTransition(v1, { type: "executorMigrated", burn }, NOW)!
    expect(next).toMatchObject({ version: 2, deployment: { executor: "0xe" }, withdrawalFee: "5" })
    expect(withdrawalTransition(next, { type: "executorMigrated", burn }, NOW)).toBeUndefined()
    expect(withdrawalTransition(v1, { type: "executorMigrated" }, NOW)).toBeUndefined()
    const named = { ...v1, withdrawalFee: "3" }
    expect(
      withdrawalTransition(named, { type: "executorMigrated", burn }, NOW)?.withdrawalFee,
    ).toBe("3")
    const undeployed = { ...record("done") }
    expect(withdrawalTransition(undeployed, { type: "executorMigrated" }, NOW)?.version).toBe(2)
  })

  it("only a mined, unreleased, unfailed record is demotable", () => {
    expect(
      ["l2_mined", "awaiting_proven", "finalizing_l1"].every((p) => isDemotable(p as never)),
    ).toBe(true)
    expect(
      ["submitting", "swapping", "recoverable", "recovered", "done", "failed"].some((p) =>
        isDemotable(p as never),
      ),
    ).toBe(false)
  })
})

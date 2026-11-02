import { describe, expect, it } from "vitest"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { failureCode } from "../../../../src/lib/analytics"
import {
  createClaimSweepReporter,
  createSyncFailureReporter,
  newlyClaimedRecords,
  settlesBootBalance,
} from "../../../../src/features/deposit/useSipaDeposits"

function record(over: Partial<SIPADepositRecord>): SIPADepositRecord {
  return {
    sipaAddress: "0xaaaa",
    recipientL2Address: "0x1",
    messageSecret: "0x2",
    recipientHash: "0x3",
    recoveryAddress: "0x4",
    l1ChainId: 31337,
    amount: "5",
    tokenSymbol: "DAI",
    phase: "claimed",
    startTime: 1_000,
    endTime: 61_000,
    ...over,
  } as SIPADepositRecord
}

describe("newlyClaimedRecords", () => {
  it("ignores non-terminal phases and pre-seeded history", () => {
    const seen = new Set<string>(["0xold"])
    const snapshot = [
      record({ sipaAddress: "0xold" }),
      record({ sipaAddress: "0xpending", phase: "pendingClaim" }),
      record({ sipaAddress: "0xnew" }),
    ]
    const fresh = newlyClaimedRecords(snapshot, seen)
    expect(fresh.map((r) => r.sipaAddress)).toEqual(["0xnew"])
  })
})

describe("createClaimSweepReporter", () => {
  const SINCE = 100_000
  // record() settles at endTime 61_000 — before SINCE, so it is history.
  const history = record({ sipaAddress: "0xhistory" })
  const settledNow = record({ sipaAddress: "0xnew", startTime: SINCE, endTime: SINCE + 5_000 })

  it("reports a claim that settles after `since`, exactly once", () => {
    const report = createClaimSweepReporter(SINCE)
    report([history])
    expect(report([history, settledNow]).map((r) => r.sipaAddress)).toEqual(["0xnew"])
    expect(report([history, settledNow])).toEqual([])
  })

  it("re-reports nothing on a remount", () => {
    createClaimSweepReporter(SINCE)([history, settledNow])
    // A later mount sees both as already settled.
    expect(createClaimSweepReporter(SINCE + 10_000)([history, settledNow])).toEqual([])
  })

  it("treats a claimed record with no endTime as history", () => {
    const report = createClaimSweepReporter(SINCE)
    expect(report([record({ sipaAddress: "0xnoend", endTime: undefined })])).toEqual([])
  })
})

describe("deposit failure codes", () => {
  it("labels a locked-session resolve", () => {
    expect(
      failureCode(new Error("no account for this session — enter with your passkey first")),
    ).toBe("wallet_locked")
  })
})

describe("settlesBootBalance", () => {
  const result = (failed: number) => ({
    discovered: 2,
    active: 0,
    skipped: 0,
    claimed: 1,
    pendingSettlement: 0,
    recoverable: 0,
    reconciled: 0,
    failed,
    complete: failed === 0,
  })

  it("settles on a clean pass only", () => {
    expect(settlesBootBalance(result(0))).toBe(true)
    expect(settlesBootBalance(result(1))).toBe(false)
    expect(settlesBootBalance(null)).toBe(false)
  })
})

describe("createSyncFailureReporter", () => {
  it("reports a run of failing syncs once, and again once a clean sync comes between", () => {
    const report = createSyncFailureReporter()
    expect([1, 1, 1, 0, 2].map(report)).toEqual([true, false, false, false, true])
  })
})

import { describe, expect, it } from "vitest"
import { PaylinkActionEnum, QueueStatus } from "@obsidion/core/constants"
import {
  keepOwned,
  activityTransition,
  type ActivityEvent,
} from "../../src/engine/activityTransition"
import type { PaylinkTransaction, Transaction } from "../../src/types/transactions"

const base = { id: "r", timestamp: 1, amountAtomic: 0n, action: "send" } as Transaction

const states: Record<string, Partial<Transaction>> = {
  unsent: { status: "pending", txHash: "", detailedStatus: QueueStatus.PENDING },
  sent: { status: "pending", txHash: "0xh", detailedStatus: QueueStatus.MINING },
  success: { status: "success", txHash: "0xh", detailedStatus: QueueStatus.SUCCESS },
  failed: { status: "failed", txHash: "0xh", detailedStatus: QueueStatus.FAILED },
  demoted: { status: "pending", txHash: "0xh", detailedStatus: QueueStatus.PENDING, reorgEpoch: 1 },
  cancelled: { status: "failed", txHash: "", detailedStatus: QueueStatus.CANCELLED },
}

const failure = { code: "tx.failed" } as const
const S = QueueStatus.SUCCESS
const F = QueueStatus.FAILED
const events: Record<string, ActivityEvent> = {
  "sent": { type: "sent", txHash: "0xnew" },
  "settled": { type: "settled", at: 5 },
  "settled@1": { type: "settled", at: 5, epoch: 1 },
  "failed": { type: "failed", at: 5, failure },
  "failed@1": { type: "failed", at: 5, failure, epoch: 1 },
  "interrupted": { type: "interrupted" },
  "confirmed ok": { type: "confirmed", at: 5, status: S },
  "confirmed ok@1": { type: "confirmed", at: 5, status: S, epoch: 1 },
  "confirmed failed": { type: "confirmed", at: 5, status: F },
  "demoted": { type: "demoted", at: 5 },
  "demoted failed": { type: "demoted", at: 5, terminal: "failed" },
  "anchored": { type: "anchored", tier: "proposed" as Transaction["tier"], blockNumber: 7 },
}

// `status detailedStatus epoch`, or "-" when the row is left as it is.
const P = "pending pending"
const expected: Record<string, Record<string, string>> = {
  "sent": {
    unsent: "pending mining 0",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "-",
    cancelled: "-",
  },
  "settled": {
    unsent: "-",
    sent: "success success 0",
    success: "-",
    failed: "-",
    demoted: "-",
    cancelled: "-",
  },
  "settled@1": {
    unsent: "-",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "success success 1",
    cancelled: "-",
  },
  "failed": {
    unsent: "failed failed 0",
    sent: "failed failed 0",
    success: "-",
    failed: "-",
    demoted: "-",
    cancelled: "-",
  },
  "failed@1": {
    unsent: "-",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "failed failed 1",
    cancelled: "-",
  },
  "interrupted": {
    unsent: "failed failed 0",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "-",
    cancelled: "-",
  },
  "confirmed ok": {
    unsent: "-",
    sent: "success success 0",
    success: "success success 0",
    failed: "success success 0",
    demoted: "-",
    cancelled: "-",
  },
  "confirmed ok@1": {
    unsent: "-",
    sent: "-",
    success: "-",
    failed: "-",
    demoted: "success success 1",
    cancelled: "-",
  },
  "confirmed failed": {
    unsent: "failed failed 0",
    sent: "failed failed 0",
    success: "failed failed 0",
    failed: "failed failed 0",
    demoted: "-",
    cancelled: "-",
  },
  "demoted": {
    unsent: `${P} 1`,
    sent: `${P} 1`,
    success: `${P} 1`,
    failed: `${P} 1`,
    demoted: `${P} 2`,
    cancelled: "-",
  },
  "demoted failed": {
    unsent: "failed failed 1",
    sent: "failed failed 1",
    success: "failed failed 1",
    failed: "failed failed 1",
    demoted: "failed failed 2",
    cancelled: "-",
  },
  "anchored": {
    unsent: "pending pending 0",
    sent: "pending mining 0",
    success: "success success 0",
    failed: "failed failed 0",
    demoted: `${P} 1`,
    cancelled: "-",
  },
}

const summary = (row: Transaction | undefined) =>
  row ? `${row.status} ${row.detailedStatus} ${row.reorgEpoch ?? 0}` : "-"

describe("activity transition: status", () => {
  for (const [eventName, event] of Object.entries(events)) {
    for (const [stateName, state] of Object.entries(states)) {
      it(`${eventName} on ${stateName}`, () => {
        const next = activityTransition({ ...base, ...state } as Transaction, event)
        expect(summary(next)).toBe(expected[eventName][stateName])
      })
    }
  }

  it("keeps the first hash, and settles a hashless row only with one", () => {
    const sent = { ...base, ...states.sent } as Transaction
    expect(activityTransition(sent, { type: "settled", at: 5, txHash: "0xother" })?.txHash).toBe(
      "0xh",
    )
    const unsent = { ...base, ...states.unsent } as Transaction
    expect(activityTransition(unsent, { type: "settled", at: 5, txHash: "0xh" })?.txHash).toBe(
      "0xh",
    )
  })
})

const link = {
  ...base,
  action: PaylinkActionEnum.PAY,
  emailPaymentAction: PaylinkActionEnum.PAY,
  flavor: "direct",
  status: "success",
  txHash: "0xh",
  paylink: "url",
} as PaylinkTransaction

const linkStates: Record<string, Partial<PaylinkTransaction>> = {
  open: {},
  claimed: { isClaimed: true },
  refunding: { refundTxHash: "0xr", refundKind: "cancel" },
  refunded: { isRefunded: true, refundTxHash: "0xr", paylink: undefined },
  reorged: { reorgEpoch: 1 },
  migrated: { isMigrated: true },
  send: { emailPaymentAction: undefined, action: "send" } as never,
}

const claimEvents: Record<string, ActivityEvent> = {
  "claimed": { type: "claimed", at: 5, refundInFlight: false, by: "chain" },
  "claimed in flight": { type: "claimed", at: 5, refundInFlight: true, by: "chain" },
  "claimed own": { type: "claimed", at: 5, refundInFlight: false, by: "self" },
  "claimed@1": { type: "claimed", at: 5, epoch: 1, refundInFlight: false, by: "chain" },
  "unclaimed": { type: "unclaimed" },
  "refundSubmitted": { type: "refundSubmitted", refundTxHash: "0xr2", refundKind: "reclaim" },
  "refunded": { type: "refunded", refundTxHash: "0xr" },
  "refundDropped": { type: "refundDropped", refundTxHash: "0xr" },
  "migrated": { type: "migrated" },
}

// M migrated, C claimed, R refunded, r a refund hash, L the link; then the epoch. "-" leaves the row.
const claimExpected: Record<string, Record<string, string>> = {
  "claimed": {
    open: "CL 0",
    claimed: "-",
    refunding: "-",
    refunded: "-",
    reorged: "-",
    migrated: "-",
    send: "-",
  },
  "claimed in flight": {
    open: "-",
    claimed: "-",
    refunding: "-",
    refunded: "-",
    reorged: "-",
    migrated: "-",
    send: "-",
  },
  "claimed own": {
    open: "C 0",
    claimed: "C 0",
    refunding: "-",
    refunded: "-",
    reorged: "-",
    migrated: "-",
    send: "-",
  },
  "claimed@1": {
    open: "-",
    claimed: "-",
    refunding: "-",
    refunded: "-",
    reorged: "CL 1",
    migrated: "-",
    send: "-",
  },
  "unclaimed": {
    open: "-",
    claimed: "L 1",
    refunding: "-",
    refunded: "-",
    reorged: "-",
    migrated: "-",
    send: "-",
  },
  "refundSubmitted": {
    open: "rL 0",
    claimed: "CrL 0",
    refunding: "rL 0",
    refunded: "-",
    reorged: "rL 1",
    migrated: "-",
    send: "-",
  },
  "refunded": {
    open: "Rr 0",
    claimed: "Rr 0",
    refunding: "Rr 0",
    refunded: "-",
    reorged: "Rr 1",
    migrated: "-",
    send: "-",
  },
  "refundDropped": {
    open: "-",
    claimed: "-",
    refunding: "L 0",
    refunded: "-",
    reorged: "-",
    migrated: "-",
    send: "-",
  },
  "migrated": {
    open: "ML 0",
    claimed: "-",
    refunding: "MrL 0",
    refunded: "-",
    reorged: "ML 1",
    migrated: "-",
    send: "-",
  },
}

const claimSummary = (row: Transaction | undefined) => {
  if (!row) return "-"
  const l = row as PaylinkTransaction
  const flags = `${l.isMigrated ? "M" : ""}${l.isClaimed ? "C" : ""}${l.isRefunded ? "R" : ""}${
    l.refundTxHash ? "r" : ""
  }`
  return `${flags}${l.paylink ? "L" : ""} ${l.reorgEpoch ?? 0}`
}

describe("activity transition: a created link's claim state", () => {
  for (const [eventName, event] of Object.entries(claimEvents)) {
    for (const [stateName, state] of Object.entries(linkStates)) {
      it(`${eventName} on ${stateName}`, () => {
        const next = activityTransition({ ...link, ...state } as Transaction, event)
        expect(claimSummary(next)).toBe(claimExpected[eventName][stateName])
      })
    }
  }
})

describe("activity transition: claimedAt and claimedBy", () => {
  const claim = (at: number, epoch?: number) =>
    ({ type: "claimed", at, epoch, refundInFlight: false, by: "chain" } as const)

  it("stamps the first claim and its claimer, and a claim after a reorg keeps both", () => {
    const own = activityTransition(link, { ...claim(5), by: "self" }) as PaylinkTransaction
    expect(own).toMatchObject({ claimedAt: 5, claimedBy: "self" })
    const reverted = activityTransition(own, { type: "unclaimed" }) as PaylinkTransaction
    expect(activityTransition(reverted, claim(9, 1))).toMatchObject({
      claimedAt: 5,
      claimedBy: "self",
    })
  })

  it("stamps a claim the chain showed as the chain's", () => {
    expect(activityTransition(link, claim(5))).toMatchObject({ claimedBy: "chain" })
  })

  it("lets this account's claim correct one the chain showed first, and never the reverse", () => {
    const chain = activityTransition(link, claim(5)) as PaylinkTransaction
    const own = activityTransition(chain, { ...claim(7), by: "self" }) as PaylinkTransaction
    expect(own).toMatchObject({ isClaimed: true, claimedAt: 5, claimedBy: "self" })
    expect(own.paylink).toBeUndefined()
    expect(activityTransition(own, claim(9))).toBeUndefined()
    expect(activityTransition(own, { ...claim(9), by: "self" })).toBeUndefined()
    const reverted = activityTransition(chain, { type: "unclaimed" }) as PaylinkTransaction
    expect(activityTransition(reverted, { ...claim(9, 1), by: "self" })).toMatchObject({
      claimedAt: 5,
      claimedBy: "self",
    })
  })
})

describe("keepOwned", () => {
  it("keeps every field a transition owns, and takes the rest", () => {
    const row = { ...link, isClaimed: true, reorgEpoch: 2, tier: "proposed" } as Transaction
    const next = keepOwned(row, {
      ...row,
      isClaimed: false,
      reorgEpoch: 0,
      status: "failed",
      memo: "hi",
    } as Transaction)
    expect(next).toMatchObject({ isClaimed: true, reorgEpoch: 2, status: "success", memo: "hi" })
  })
})

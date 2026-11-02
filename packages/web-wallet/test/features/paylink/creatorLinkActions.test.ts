/**
 * The detail modal's creator-recovery gate: which of "Reclaim funds" / "Cancel link" a stored PAY
 * row offers — Cancel inside the refund window, Reclaim after expiry — across lifecycle flags, the
 * on-open status refresh, and whether the session's account is the row's creator.
 */
import { describe, expect, it } from "vitest"
import type { PaylinkStatusKind, PaylinkTransaction } from "@obsidion/front-core"
import {
  creatorLinkAction,
  isOpenCreatorLink,
  isOtherRollupLink,
  paylinkStatusIsUnspent,
} from "@obsidion/front-core"

const CREATOR = `0x${"22".repeat(32)}`
const OTHER = `0x${"33".repeat(32)}`
const NOW = 1_800_000_000

/**
 * A complete creator create row: claim window open, refund window already closed, nothing spent,
 * refund material intact. Overrides open the refund window or expire the link.
 */
function payRow(over: Partial<PaylinkTransaction> = {}): PaylinkTransaction {
  return {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    status: "success",
    timestamp: NOW * 1000,
    txHash: `0x${"ab".repeat(32)}`,
    paylink: "https://wallet.example/link#frag",
    payToEmailSecret: `0x${"44".repeat(32)}`,
    fallbackSecret: `0x${"55".repeat(32)}`,
    obsidionAccountAddress: CREATOR,
    fromClaimable: 0,
    untilClaimable: NOW + 86_400,
    refundableUntil: NOW - 1,
    ...over,
  } as PaylinkTransaction
}

const gate = (
  row: PaylinkTransaction,
  liveStatus: PaylinkStatusKind = "awaitingClaim",
  account = CREATOR,
) => creatorLinkAction(row, { nowSec: NOW, liveStatus, account })

describe("paylinkStatusIsUnspent", () => {
  it("admits only the statuses whose escrow still holds funds", () => {
    expect(paylinkStatusIsUnspent("awaitingClaim")).toBe(true)
    expect(paylinkStatusIsUnspent("expired")).toBe(true)
    expect(paylinkStatusIsUnspent("claimed")).toBe(false)
    expect(paylinkStatusIsUnspent("refunded")).toBe(false)
    expect(paylinkStatusIsUnspent("migrated")).toBe(false)
  })
})

describe("creatorLinkAction", () => {
  it("offers cancel inside the refund window, even while the link is claimable", () => {
    expect(gate(payRow({ refundableUntil: NOW + 60 }))).toBe("cancel")
    expect(gate(payRow({ flavor: "email", refundableUntil: NOW + 60 }))).toBe("cancel")
  })

  it("offers reclaim on a link past its window", () => {
    expect(gate(payRow({ untilClaimable: NOW - 1 }), "expired")).toBe("reclaim")
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "expired")).toBe("reclaim")
  })

  it("withdraws the CTA when the on-open refresh finds the link claimed", () => {
    // The row's own flags still read unclaimed — web has no reconciler, so this is the only signal.
    expect(gate(payRow({ refundableUntil: NOW + 60 }), "claimed")).toBeNull()
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "claimed")).toBeNull()
  })

  it("offers nothing to an account that is not the row's creator", () => {
    expect(gate(payRow({ refundableUntil: NOW + 60 }), "awaitingClaim", OTHER)).toBeNull()
    expect(gate(payRow({ flavor: "email", untilClaimable: NOW - 1 }), "expired", OTHER)).toBeNull()
  })

  it("reads the creator stamp whatever its case", () => {
    expect(
      gate(payRow({ refundableUntil: NOW + 60 }), "awaitingClaim", CREATOR.toUpperCase()),
    ).toBe("cancel")
  })

  it("keeps the offer when the session account is not known yet", () => {
    expect(
      creatorLinkAction(payRow({ refundableUntil: NOW + 60 }), {
        nowSec: NOW,
        liveStatus: "awaitingClaim",
      }),
    ).toBe("cancel")
  })

  it("offers nothing on a failed create, which escrowed nothing", () => {
    expect(gate(payRow({ status: "failed", refundableUntil: NOW + 60 }))).toBeNull()
  })

  it("offers nothing on a zk-flavored row, which web never creates", () => {
    expect(gate(payRow({ flavor: "zk", untilClaimable: NOW - 1 }), "expired")).toBeNull()
  })

  it("withholds cancel inside the proving margin before refundableUntil", () => {
    expect(gate(payRow({ refundableUntil: NOW + 31 }))).toBe("cancel")
    expect(gate(payRow({ refundableUntil: NOW + 30 }))).toBeNull()
    expect(gate(payRow({ refundableUntil: NOW + 1 }))).toBeNull()
  })
})

describe("isOtherRollupLink", () => {
  it("names a link stamped with another rollup, and nothing before the network is known", () => {
    expect(isOtherRollupLink({ networkId: "0xOLD" }, undefined)).toBe(false)
    expect(isOtherRollupLink({ networkId: "0xOLD" }, "0xNEW")).toBe(true)
    expect(isOtherRollupLink({ networkId: "0xnew" }, "0xNEW")).toBe(false)
    expect(isOtherRollupLink({}, "0xNEW")).toBe(false)
  })
})

describe("isOpenCreatorLink", () => {
  const open = (over: Partial<PaylinkTransaction> = {}, account = CREATOR, network?: string) =>
    isOpenCreatorLink(payRow(over), account, network)

  it("is a link the account can take back now or once it expires", () => {
    expect(open({ refundableUntil: NOW + 60 })).toBe(true)
    expect(open()).toBe(true)
    expect(open({ untilClaimable: NOW - 1 })).toBe(true)
    expect(open({ flavor: "email" })).toBe(true)
    expect(open({}, CREATOR.toUpperCase())).toBe(true)
  })

  it("is a create still in flight, whose escrow may land", () => {
    expect(open({ status: "pending", paylink: undefined, untilClaimable: undefined })).toBe(true)
  })

  it("is a refund on its way that has not landed", () => {
    expect(open({ refundTxHash: `0x${"77".repeat(32)}` })).toBe(true)
  })

  it("is not a link another account made, as a rotated account's are to the next one", () => {
    expect(open({}, OTHER)).toBe(false)
  })

  it("is not a claim leg, a zk link, or a link on another rollup", () => {
    expect(open({ emailPaymentAction: "Claim With Email" })).toBe(false)
    expect(open({ flavor: "zk" })).toBe(false)
    expect(open({ networkId: "0xOLD" }, CREATOR, "0xNEW")).toBe(false)
  })
})

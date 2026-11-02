import { describe, expect, it } from "vitest"
import { paylinkRefundEligibility } from "../../src/core/services/paylink/refundParamsFromRow"
import type { PaylinkTransaction } from "../../src/types"
import { seededActivity } from "../utils/activityFixture"

// A successful refund writes `isRefunded` (and scrubs `paylink`) through the activity store; every
// entry point's CTA re-reads `paylinkRefundEligibility` off the current row, so the same PAY row
// that was eligible must read as ineligible afterwards — no manual refresh.

const ACCOUNT = "0x" + "a".repeat(64)
const SECRET = "0xsecret"

// A complete, refundable PAY row (window [1000, 2000]). `nowSec=3000` (expired)
// makes it eligible before the refund write lands.
const refundablePayRow = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: Date.now(),
    status: "success",
    txHash: "0xrow",
    payToEmailSecret: SECRET,
    obsidionAccountAddress: ACCOUNT,
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    fromClaimable: 1000,
    untilClaimable: 2000,
    ...overrides,
  } as PaylinkTransaction)

describe("paylink refund eligibility re-read after a refund write (R11)", () => {
  it("flips the same PAY row's CTA from eligible to ineligible after isRefunded is written", async () => {
    const storage = seededActivity([refundablePayRow()])

    // Before the refund write, the CTA is eligible (expired window).
    const before = (await storage.get("0xrow")) as PaylinkTransaction
    expect(paylinkRefundEligibility(before, 3000)).toEqual({ eligible: true })

    // The refund write: sets `isRefunded`, scrubs `paylink`.
    const wrote = await storage.apply("0xrow", { type: "refunded" })
    expect((wrote as PaylinkTransaction | undefined)?.isRefunded).toBe(true)

    // Re-reading the same row yields ineligible — `refunded` wins over the scrubbed-link
    // `unavailable` reason.
    const after = (await storage.get("0xrow")) as PaylinkTransaction
    expect(after.isRefunded).toBe(true)
    expect(paylinkRefundEligibility(after, 3000)).toEqual({
      eligible: false,
      reason: "refunded",
    })
  })
})

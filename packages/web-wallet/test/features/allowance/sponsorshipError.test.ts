/**
 * Only a refusal on the account's registered allowance gets the allowance copy. The voucher and
 * registration-broadcast rails refuse with the same assertion, but their one-use allowance is not the
 * account's and never renews, so those failures keep their flow's own report.
 */
import { describe, expect, it } from "vitest"
import { sponsorshipErrorCopy } from "../../../src/features/allowance/sponsorshipError"

const exhausted = new Error("Simulation failed", {
  cause: new Error("Assertion failed: allowance exhausted"),
})

describe("sponsorshipErrorCopy", () => {
  it.each([
    "contact:send",
    "paylink:create",
    "withdraw:submit",
    "deposit:resolve",
    "request-link:create",
  ])("explains a refused %s batch, wherever the reason sits", (context) => {
    const copy = sponsorshipErrorCopy(exhausted, context)
    expect(copy?.title).toBe("No sponsored transactions left")
    expect(copy?.message).toMatch(/was not sent/)
    expect(copy?.message).not.toMatch(/pay|fee/i)
  })

  it("leaves a voucher or registration refusal to its flow's own report", () => {
    expect(sponsorshipErrorCopy(exhausted, "paylink:claim")).toBeUndefined()
    expect(sponsorshipErrorCopy(exhausted, "onboarding:register")).toBeUndefined()
  })

  it.each(["contact:send", "paylink:claim", "onboarding:register"])(
    "explains a %s batch the drained FPC could not pay for",
    (context) => {
      const drained = new Error(
        "Invalid tx: Insufficient fee payer balance (required=7484993534692000000, available=7303099756045634134)",
      )
      const copy = sponsorshipErrorCopy(drained, context)
      expect(copy?.title).toBe("Sponsored transactions paused")
      expect(copy?.message).toMatch(/was not sent/)
    },
  )

  it.each(["contact:send", "withdraw:submit", "paylink:claim"])(
    "explains a %s batch priced above the FPC's fee cap",
    (context) => {
      const overCap = new Error(
        "Assertion failed: Gas settings exceed whitelist max_fee 'assert(max_possible_fee <= max_fee, " +
          '"Gas settings exceed whitelist max_fee")\'',
      )
      const copy = sponsorshipErrorCopy(overCap, context)
      expect(copy?.title).toBe("Network fees are too high")
      expect(copy?.message).toMatch(/was not sent/)
      expect(copy?.link?.href).toBe("https://docs.zk.money/docs/limits")
    },
  )

  it("leaves every other failure to the generic report", () => {
    expect(
      sponsorshipErrorCopy(new Error("No active subscription for this rail"), "contact:send"),
    ).toBeUndefined()
    expect(sponsorshipErrorCopy("network down", "withdraw:submit")).toBeUndefined()
  })
})

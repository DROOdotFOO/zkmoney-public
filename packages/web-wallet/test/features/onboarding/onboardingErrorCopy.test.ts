import { describe, expect, it } from "vitest"
import { AccountServiceError } from "@obsidion/front-core"
import { claimErrorMessage } from "../../../src/features/onboarding/onboardingErrorCopy"
import { NameTakenError } from "../../../src/features/onboarding/oxideOnboarding"

const SERVER_MESSAGE = "a still-live NameClaim binds this device/name to another address"
const conflict = new AccountServiceError(409, SERVER_MESSAGE, {
  error: SERVER_MESSAGE,
  reason: "claim_conflict",
})

describe("claimErrorMessage", () => {
  it("a retryable witness failure says the payment is not visible yet, and invites a retry", () => {
    const err = Object.assign(
      new Error("The link's note is not under block 12. Try again after the next block."),
      {
        name: "GoldenTicketWitnessError",
        retryable: true,
      },
    )
    expect(claimErrorMessage(err)).toContain("isn't visible on the network yet")
  })

  it("tells the three name refusals apart, and none of them borrows the conflict's deadline", () => {
    const registered = claimErrorMessage(new NameTakenError("registered", "satoshi"))
    const reserved = claimErrorMessage(new NameTakenError("reserved", "satoshi"))
    const blocked = claimErrorMessage(new NameTakenError("blocked", "admin"))

    expect(registered).toContain("already belongs to an account")
    expect(reserved).toContain("another account's signup")
    expect(blocked).toContain("can't be used")
    expect(new Set([registered, reserved, blocked]).size).toBe(3)
    // A reservation carries no deadline, and retrying the same tag reaches the same refusal.
    for (const message of [registered, reserved, blocked]) {
      expect(message).not.toContain("It clears")
      expect(message).not.toMatch(/Try again/)
      expect(message).toContain("different tag")
    }
  })

  it("says when a claim conflict clears instead of asking for an immediate retry", () => {
    const nowMs = Date.UTC(2026, 8, 1, 12, 0, 0)
    const until = Math.floor(nowMs / 1000) + 1800
    const time = new Date(until * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })

    const message = claimErrorMessage(conflict, { until, nowMs })

    expect(message).toContain(`It clears at ${time}.`)
    expect(message).toMatch(/Try again after that\.$/)
    expect(message).not.toMatch(/\. Try again\.$/)
    expect(message).not.toContain(SERVER_MESSAGE)
  })

  it("falls back to the validity window when the deadline is unknown or already past", () => {
    const nowMs = Date.UTC(2026, 8, 1, 12, 0, 0)
    expect(claimErrorMessage(conflict, { nowMs })).toContain("It clears within an hour.")
    expect(claimErrorMessage(conflict, { until: Math.floor(nowMs / 1000) - 60, nowMs })).toContain(
      "It clears within an hour.",
    )
    expect(claimErrorMessage(conflict, { until: Number.NaN, nowMs })).toContain(
      "It clears within an hour.",
    )
  })

  it("names the tag whose attempts budget is spent instead of inviting a retry", () => {
    const spent = new AccountServiceError(429, "no attempts left", {
      reason: "claim_attempts_exhausted",
    })

    expect(claimErrorMessage(spent, { tag: "taga" })).toBe(
      "This device has used up its claim attempts on @taga. Pick a different tag to carry on.",
    )
  })

  it("keeps the retry lead for every other failure", () => {
    expect(claimErrorMessage(new Error("boom"))).toBe("Couldn't claim your tag. boom. Try again.")
    const inflight = new AccountServiceError(409, "in flight", { reason: "claim_inflight" })
    expect(claimErrorMessage(inflight, { until: 1 })).toBe(
      "Couldn't claim your tag. in flight. Try again.",
    )
  })

  it("does not call a paylink shortfall a failed tag claim", () => {
    expect(claimErrorMessage(new Error("this payment cannot cover the account deposit"))).toBe(
      "Couldn't finish signup with this payment. this payment cannot cover the account deposit. Try again.",
    )
    expect(
      claimErrorMessage(
        new Error(
          "this payment's ticket did not waive the tag price, so the deposit is still the paid schedule",
        ),
      ),
    ).toMatch(/^Couldn't finish signup with this payment\./)
  })

  it("says what a golden ticket circuit refusal means, never the bare assert", () => {
    expect(claimErrorMessage(new Error("escrow class is not a paylink"))).toBe(
      "Couldn't finish signup with this payment. Its link was made with another version of the app.",
    )
    expect(claimErrorMessage(new Error("paylink amount below threshold"))).toMatch(
      /^Couldn't finish signup with this payment\. It's below the amount/,
    )
    // Not a sync delay: retrying proves the same leaf.
    const notUnderRoot = claimErrorMessage(new Error("paylink note is not under the root"))
    expect(notUnderRoot).toBe(
      "Couldn't finish signup with this payment. Its link can't be proven to waive the tag price.",
    )
    expect(notUnderRoot).not.toMatch(/try again/i)
    for (const raw of ["Assertion failed", "Assertion failed: some other check"]) {
      const message = claimErrorMessage(new Error(raw))
      expect(message).not.toContain("Assertion failed")
      expect(message).toBe("Couldn't claim your tag. Your payment couldn't be proven. Try again.")
    }
  })

  it("says what the service's class-pair refusals mean, never the raw code", () => {
    const unreviewed = claimErrorMessage(
      new AccountServiceError(400, "ticket_class_unreviewed", { error: "ticket_class_unreviewed" }),
    )
    expect(unreviewed).toBe(
      "Couldn't finish signup with this payment. Its link was made with another version of the app.",
    )
    const unavailable = claimErrorMessage(
      new AccountServiceError(503, "ticket_classes_unavailable", {
        error: "ticket_classes_unavailable",
      }),
    )
    expect(unavailable).toBe(
      "Couldn't finish signup with this payment right now. Try again in a moment.",
    )
  })
})

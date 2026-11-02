import { beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_STASH_KEY,
  TICKET_STASH_KEY,
  clearClaimStash,
  clearTicketSignup,
  peekClaimStash,
  peekTicketSignup,
  stashClaimLink,
  stashTicketSignup,
} from "../../../../src/features/paylink/claimStash"

const ticket = {
  fragment: "frag-a",
  threshold: "2000000000000000000",
  schedule: { fee: "500000000000000000", minDeposit: "0" },
}

describe("claim stash — the ticket-funded signup marker", () => {
  beforeEach(() => sessionStorage.clear())

  it("a marker for another link is stale, never a ticket for the new one", () => {
    stashTicketSignup(ticket)
    stashClaimLink("frag-b")
    expect(peekTicketSignup()).toBeNull()
    expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
  })

  it("settling the claim clears both; dropping the intent alone keeps the link for Home", () => {
    stashTicketSignup(ticket)
    clearClaimStash("other")
    expect(peekTicketSignup()).toEqual(ticket)
    clearClaimStash("frag-a")
    expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
    expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()

    stashTicketSignup(ticket)
    clearTicketSignup()
    expect(peekClaimStash()).toBe("frag-a")
    expect(peekTicketSignup()).toBeNull()
  })
})

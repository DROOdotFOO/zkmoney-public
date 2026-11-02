import { beforeEach, describe, expect, it } from "vitest"
import {
  beginTicketSignupAccount,
  boundToTicketSignup,
  completeTicketSignupAccount,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
} from "../../../../src/features/paylink/ticketSignupAccount"

const account = { credentialId: "created-passkey", l2Address: `0x${"ab".repeat(32)}` }

describe("ticket signup creation checkpoints", () => {
  beforeEach(() => localStorage.clear())

  it("an interrupted attempt cannot be mistaken for an account or a new signup", async () => {
    const attempt = await beginTicketSignupAccount("rp", "link", "alice")
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(attempt)
    expect(() => loadTicketSignupAccount("rp", "link")).toThrow("previous passkey attempt")
    await expect(beginTicketSignupAccount("rp", "link", "bob")).rejects.toThrow(
      "already has a signup",
    )
  })

  it("a late completion cannot overwrite an explicitly restarted attempt", async () => {
    const first = await beginTicketSignupAccount("rp", "link", "alice")
    restartTicketSignupAccount("rp", "link", first.attemptId)
    const second = await beginTicketSignupAccount("rp", "link", "bob")
    await expect(
      completeTicketSignupAccount("rp", "link", first.attemptId, account),
    ).rejects.toThrow("no longer active")
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(second)
  })

  it("a tab that saw an older attempt cannot restart the one another tab began since", async () => {
    const first = await beginTicketSignupAccount("rp", "link", "alice")
    // Tab A restarts and opens its ceremony while tab B still shows the first attempt.
    restartTicketSignupAccount("rp", "link", first.attemptId)
    const second = await beginTicketSignupAccount("rp", "link", "alice")
    expect(() => restartTicketSignupAccount("rp", "link", first.attemptId)).toThrow(
      "restarted in another tab",
    )
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(second)
    await completeTicketSignupAccount("rp", "link", second.attemptId, account)
    expect(loadTicketSignupAccount("rp", "link")).toEqual({ ...account, tag: "alice" })
  })
})

describe("boundToTicketSignup", () => {
  beforeEach(() => localStorage.clear())

  it("names only a completed binding's passkey on its own rpId", async () => {
    const attempt = await beginTicketSignupAccount("rp", "link", "alice")
    expect(boundToTicketSignup("rp", account.credentialId)).toBe(false)
    await completeTicketSignupAccount("rp", "link", attempt.attemptId, account)
    expect(boundToTicketSignup("rp", account.credentialId)).toBe(true)
    expect(boundToTicketSignup("rp", "another-passkey")).toBe(false)
    expect(boundToTicketSignup("other-rp", account.credentialId)).toBe(false)
  })
})

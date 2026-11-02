/**
 * Which stashed link Home claims with the registration burn: only the one whose ticket paid for
 * this account's still-unfunded signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore, type PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import {
  DAI as ONE,
  pendingRecord,
  resetRegistrationStores,
  SIPA,
  ticketBoundTerms,
  ticketSignupStash,
} from "../../../support/registrationFixtures"

// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
  type RegistrationTerms,
} from "../../../../src/features/onboarding/registrationTerms"
import { stashClaimLink, stashTicketSignup } from "../../../../src/features/paylink/claimStash"
import {
  bindLinkDeposit,
  boundTicketSignup,
  ticketActivation,
  ticketSignupCommitted,
  ticketSignupRegistration,
  ticketSignupContinuation,
  unfundedRegistration,
} from "../../../../src/features/paylink/ticketContinuation"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const record = (over: Partial<PendingRegistrationRecord> = {}) =>
  pendingRecord({ account: ACCOUNT, l2Address: L2_ADDRESS, ...over })
const terms = (over: Partial<RegistrationTerms> = {}) =>
  saveRegistrationTerms(ticketBoundTerms({ account: ACCOUNT, ...over }))
const stash = (fragment = "paylink-frag") =>
  stashTicketSignup(ticketSignupStash({ fragment, amount: (20n * ONE).toString() }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetRegistrationStores()
})

describe("ticketSignupContinuation", () => {
  const burning = [{ recipient: SIPA, phase: "pending" }]

  it("recognises the bound link reopened on a tab that lost its marker, from the terms alone", async () => {
    stash()
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe("ready")
    // The user entered the wallet, closed the tab and opened the link again: /link's signed-in
    // hand-off stashes the bare fragment. The binding outlives the marker.
    sessionStorage.clear()
    stashClaimLink("paylink-frag")
    const found = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(found?.activation.state).toBe("ready")
    // Rebuilt from the terms: the split they signed, no amount or memo until the link is read.
    expect(found?.stash).toEqual({
      fragment: "paylink-frag",
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
    })
    // Terms without a signed schedule rebuild nothing: the renewal has to price the split first.
    terms({ fee: undefined, minDeposit: undefined })
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT, "taga"))).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })

  it("is nothing for another account, a funded or settled registration, or terms a paylink cannot fund", async () => {
    stash()
    const store = PendingRegistrationStore.get(webStorage)
    terms()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()

    await store.upsert(ACCOUNT, {}, record())
    expect(ticketSignupContinuation("paylink-frag", `0x${"ef".repeat(32)}`, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", undefined, [])).toBeNull()

    // Funded or swept by other means, the registration no longer needs the link; funded by this
    // account's own burn, the link's review still reports it, submitted, until the name confirms.
    await store.upsert(ACCOUNT, { fundedAt: Date.now() }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)?.activation).toEqual({
      state: "submitted",
    })
    await store.upsert(ACCOUNT, { phase: "funded" }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)?.activation).toEqual({
      state: "submitted",
    })
    await store.upsert(
      ACCOUNT,
      { fundedAt: undefined, phase: "awaiting_deposit", sweptAt: Date.now() },
      record(),
    )
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await store.upsert(ACCOUNT, { sweptAt: undefined, phase: "confirmed" }, record())
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, burning)).toBeNull()

    await store.upsert(ACCOUNT, { phase: "awaiting_deposit" }, record())
    terms({ paylinkFunded: false })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    terms({ tag: "other" })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })

  it("a later link cannot attach to the signup an earlier link paid for", async () => {
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, record())
    terms()
    stash()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).not.toBeNull()
    // Another visitor picked link B on this tab and walked away; A's terms are still the last signed.
    stash("link-b")
    expect(ticketSignupContinuation("link-b", L2_ADDRESS, [])).toBeNull()
    // A write that keeps the funding keeps the link; only dropping the funding frees the signup.
    terms({ paylinkId: undefined })
    stash()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).not.toBeNull()
    terms({ paylinkFunded: false })
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
  })
})

describe("boundTicketSignup / ticketSignupCommitted", () => {
  it("rebuilds a deposit the link pays at the name's price as paid, never as a ticket", () => {
    stashClaimLink("paylink-frag")
    const paid = ticketBoundTerms({ account: ACCOUNT, deadline: 1, paylinkDeposit: true })
    expect(boundTicketSignup(paid)).toMatchObject({ fragment: "paylink-frag", paid: true })
    expect(
      boundTicketSignup(ticketBoundTerms({ account: ACCOUNT, deadline: 1 })),
    ).not.toHaveProperty("paid")
  })

  it("selects the link's registration rather than a newer unrelated record, until it settles", async () => {
    const store = PendingRegistrationStore.get(webStorage)
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60000 }))
    terms()
    await store.upsert(
      "0x00000000000000000000000000000000000000bb",
      {},
      record({ tag: "bob", l2Address: `0x${"ef".repeat(32)}` }),
    )
    expect(ticketSignupCommitted("paylink-frag")).toBe(true)
    expect(ticketSignupCommitted("link-b")).toBe(false)
    expect(ticketSignupRegistration("paylink-frag", L2_ADDRESS)?.account).toBe(ACCOUNT)
    expect(ticketSignupRegistration("paylink-frag", `0x${"ef".repeat(32)}`)).toBeNull()
    await store.close(ACCOUNT, "confirmed")
    expect(ticketSignupCommitted("paylink-frag")).toBe(false)
  })
})

describe("ticketActivation", () => {
  const full = record

  it("keeps a blocked or lapsed binding a ticket, with the way back to its renewal", () => {
    stash()
    terms({ paylinkBlocked: true })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "blocked",
    })
    // A block outlasts every write that does not lift it.
    terms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "blocked",
    })
    terms({ deadline: Math.floor(Date.now() / 1000) - 60, paylinkBlocked: false })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "renew",
    })
    terms({ fee: undefined, minDeposit: undefined })
    expect(ticketActivation(full(), loadRegistrationTerms(ACCOUNT, "taga"), [])).toMatchObject({
      state: "renew",
    })
  })
})

describe("an entered account's registration a link funds", () => {
  /** A drawn tag's live signed deposit, with nothing at its address yet. */
  const waiting = async (over: Partial<PendingRegistrationRecord> = {}) => {
    const rec = record(over)
    await PendingRegistrationStore.get(webStorage).upsert(ACCOUNT, {}, rec)
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(ONE / 2n),
      minDeposit: String(ONE),
      feeWaived: true,
    })
    return rec
  }

  it.each([
    ["funded already", { fundedAt: 1 }],
    [
      "whose address can never be published",
      { broadcast: false, replaced: { sipaAddress: SIPA, refunded: false, broadcastSpent: true } },
    ],
  ])("offers nothing for a registration %s", async (_, over) => {
    await waiting(over)
    expect(unfundedRegistration(L2_ADDRESS, [])).toBeNull()
  })

  it("offers nothing once a link funds it, and the binding makes Home's claim of that link fund it", async () => {
    stashClaimLink("paylink-frag")
    const rec = await waiting()
    expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toBeNull()
    await bindLinkDeposit(
      rec,
      { fragment: "paylink-frag", amount: 52n * ONE, senderTag: "maple" },
      ONE / 10n,
      "faster",
    )
    expect(unfundedRegistration(L2_ADDRESS, [])).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: "id:paylink-frag",
      proverTip: String(ONE / 10n),
    })
    // The hero reads it as claiming, not as waiting for a deposit.
    expect(ticketActivation(rec, loadRegistrationTerms(ACCOUNT, "taga"), [])?.state).toBe("ready")
    const continued = ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])
    expect(continued?.activation.state).toBe("ready")
    // Who sent it and how much, kept with the binding for once the link reads as claimed.
    expect(continued?.stash).toMatchObject({ amount: String(52n * ONE), senderTag: "maple" })
  })
})

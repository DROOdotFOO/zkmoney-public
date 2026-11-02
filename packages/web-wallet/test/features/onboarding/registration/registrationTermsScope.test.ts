import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NameClaimResponse } from "@obsidion/core/types"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"
import { keccak256, toBytes } from "viem"
import {
  askedTotal,
  claimTerms,
  clearRegistrationTerms,
  floorExceedsAsk,
  loadRegistrationTerms,
  registrationDepositCredit,
  registrationDepositGross,
  quoteExpired,
  quotedRegistrationKind,
  registrationQuote,
  rememberReissuedClaim,
  reservedUntil,
  saveRegistrationTerms,
  scheduleForRecord,
  signedSchedule,
  registrationOffer,
  wireTermsFundTicket,
  termsUnpriced,
  type RegistrationTerms,
} from "../../../../src/features/onboarding/registrationTerms"
import { stashTicketSignup } from "../../../../src/features/paylink/claimStash"
import { linkIdentity } from "../../../../src/features/paylink/linkIdentity"
import { boundTicketSignup } from "../../../../src/features/paylink/ticketContinuation"
import { PAID_ASK, RANDOM, RANDOM_ASK } from "../../../support/registrationPrices"
import { signOut } from "../../../../src/features/identity/signOut"
import { testWalletDbs } from "../../../support/fakeWalletDb"
import {
  dai,
  earnedTerms,
  ticketBoundTerms,
  ticketSignupStash,
} from "../../../support/registrationFixtures"

// The real codec needs a node realm (see linkIdentity.test.ts); here a hash stands in for it,
// with the one property the binding relies on: the identity carries nothing of the fragment.
vi.mock("../../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => {
    if (fragment === "not-a-link") throw new Error("Invalid paylink link")
    return keccak256(toBytes(`link:${fragment}`))
  },
}))

const PAYLINK_FRAGMENT = "inline-bearer-secret"

const ACCOUNT_A = "0x00000000000000000000000000000000000000aa"
const ACCOUNT_B = "0x00000000000000000000000000000000000000bb"

const stale = () =>
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "oldtag",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: String(5n * 10n ** 18n),
    minDeposit: String(10n * 10n ** 18n),
    feeWaived: false,
  })

beforeEach(() => {
  localStorage.clear()
})

describe("saving registration terms", () => {
  it("resolves once saved, and rejects with the terms unsaved when the save fails", async () => {
    await stale()
    const key = walletStorage.keys().find((k) => walletStorage.getItem(k)?.includes("oldtag"))
    expect(key && walletStorage.getCommitted(key)).toBeTruthy()
    const dbs = testWalletDbs()
    dbs.onApply = () => {
      throw new Error("disk")
    }
    try {
      await expect(stale()).rejects.toThrow("disk")
    } finally {
      dbs.onApply = undefined
    }
  })
})

describe("registration terms are scoped to one account", () => {
  it("a caller that names no account gets nothing", () => {
    stale()
    // The terms step runs before any record exists, so it has no account to name. Handing it the
    // last claim's quote priced a new tag off a dead reservation.
    expect(loadRegistrationTerms(undefined)).toBeNull()
  })

  it.each([
    ["another account", ACCOUNT_B, undefined],
    ["the owning account in another case", ACCOUNT_A.toUpperCase(), "oldtag"],
  ])("only the owning account reads them, in any case: %s", (_, account, tag) => {
    stale()
    expect(loadRegistrationTerms(account)?.tag).toBe(tag)
  })

  it("the same device's next tag does not inherit the last tag's quote", () => {
    stale()
    // One passkey CREATE2-derives one OxideAccount, so every claim from this device shares an
    // account. Only the tag separates the quote that priced @oldtag from the next one.
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.tag).toBe("oldtag")
    expect(loadRegistrationTerms(ACCOUNT_A, "OLDTAG")?.tag).toBe("oldtag")
  })

  it("keeps one registration's schedule when another on the same account is stored or cleared", () => {
    stale()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "newtag",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(1n * 10n ** 18n),
      minDeposit: String(2n * 10n ** 18n),
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe(String(5n * 10n ** 18n))
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")?.fee).toBe(String(1n * 10n ** 18n))
    clearRegistrationTerms(ACCOUNT_A, "newtag")
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe(String(5n * 10n ** 18n))
    clearRegistrationTerms(ACCOUNT_A, "oldtag")
    expect(loadRegistrationTerms(ACCOUNT_A)).toBeNull()
  })
})

describe("terms written under the single legacy key", () => {
  const LEGACY_KEY = "webwallet.registration.terms"
  const legacy = (over: Partial<RegistrationTerms> = {}) =>
    walletStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        account: ACCOUNT_A,
        tag: "oldtag",
        deadline: 100,
        fee: "5",
        minDeposit: "10",
        ...over,
      }),
    )

  it("still read by the registration they were written for", () => {
    legacy()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe("5")
    expect(loadRegistrationTerms(ACCOUNT_A)?.fee).toBe("5")
  })

  it("never read for another account or another tag", () => {
    legacy()
    expect(loadRegistrationTerms(ACCOUNT_B, "oldtag")).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")).toBeNull()
  })

  it("move to their own key on the next write", () => {
    legacy()
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "oldtag", deadline: 200, fee: "5" })
    expect(walletStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.deadline).toBe(200)
  })

  it("are left alone by a write for a different registration", () => {
    legacy()
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "newtag", deadline: 200 })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe("5")
  })
})

describe("an unpriced quote prices nothing", () => {
  it("all-zero signed terms are a claim server with no schedule, not a free tag", () => {
    const zero = { fee: "0", minDeposit: "0" }
    expect(termsUnpriced(zero)).toBe(true)
    expect(signedSchedule(zero)).toBeUndefined()
  })

  it("a zero fee over a real minimum is still a priced quote", () => {
    const zeroFee = { fee: "0", minDeposit: String(5n * 10n ** 18n) }
    expect(termsUnpriced(zeroFee)).toBe(false)
    expect(signedSchedule(zeroFee)).toEqual({ min: 5n * 10n ** 18n, fee: 0n })
  })

  it("terms carrying no schedule at all fall through without claiming to be unpriced", () => {
    expect(termsUnpriced({})).toBe(false)
    expect(signedSchedule({})).toBeUndefined()
  })
})

describe("a re-issued claim against the stored quote", () => {
  const RECORD = { account: ACCOUNT_A, tag: "oldtag", fee: "5000000000000000000" }
  const priced = () =>
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "oldtag",
      deadline: 100,
      fee: RECORD.fee,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
      depositAmount: "7",
    })

  it("replaces the schedule when the claim prices the committed fee", () => {
    priced()
    rememberReissuedClaim(RECORD, {
      hold: { deadline: "500" },
      terms: earnedTerms({ fee: RECORD.fee, minDeposit: "9", reduced: false }),
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")).toMatchObject({
      deadline: 500,
      minDeposit: "9",
      feeWaived: false,
      depositAmount: "7",
    })
  })

  it("refreshes only the deadline when the claim carries no schedule", () => {
    priced()
    rememberReissuedClaim(RECORD, { hold: { deadline: "500" } })
    // Silence is not evidence the signed schedule was wrong.
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")).toMatchObject({
      deadline: 500,
      fee: RECORD.fee,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
      depositAmount: "7",
    })
  })

  it("names no waiver for a record that never stored one", () => {
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "oldtag", deadline: 100 })
    rememberReissuedClaim({ account: ACCOUNT_A, tag: "oldtag" }, { hold: { deadline: "500" } })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.feeWaived).toBeUndefined()
  })
})

describe("the reservation's deadline", () => {
  const NOW = 1_000_000_000_000

  it("keeps the claim server's hold as the reservation's one deadline", () => {
    const hold = NOW / 1000 + 7 * 86_400
    const claim: NameClaimResponse = {
      signature: "0x",
      nonce: "1",
      deadline: String(NOW / 1000 + 14 * 86_400),
      hold: { deadline: String(hold) },
      terms: {
        fee: "1",
        minDeposit: "9",
        nonce: "1",
        deadline: String(NOW / 1000 + 86_400),
        signature: "0x",
        reduced: false,
        ticket: false,
      },
    }
    expect(claimTerms(claim).deadline).toBe(hold)
    expect(reservedUntil(claimTerms(claim), NOW)).toBe(hold * 1000)
  })

  it("names the reservation's end only while it holds", () => {
    const live = NOW / 1000 + 60
    expect(reservedUntil({ deadline: live }, NOW)).toBe(live * 1000)
    expect(reservedUntil({ deadline: NOW / 1000 - 60 }, NOW)).toBeUndefined()
    expect(reservedUntil({ deadline: 0 }, NOW)).toBeUndefined()
    expect(reservedUntil(null, NOW)).toBeUndefined()
  })

  it("an unknown claim deadline never reads as expired", () => {
    expect(quoteExpired({ deadline: NOW / 1000 - 60 }, NOW)).toBe(true)
    expect(quoteExpired({ deadline: NOW / 1000 + 60 }, NOW)).toBe(false)
    expect(quoteExpired({ deadline: 0 }, NOW)).toBe(false)
    expect(quoteExpired(null, NOW)).toBe(false)
  })
})

describe("the schedule that prices one registration", () => {
  const signed = { fee: "5", minDeposit: "10" }

  it("prefers the signed schedule over the deployment's", () => {
    expect(scheduleForRecord(signed, { min: 2n, fee: 9n }, undefined)).toEqual({
      min: 10n,
      fee: 5n,
    })
  })

  it("prices nothing off a signed schedule that names another fee", () => {
    // A signed minimum paired with the committed fee would be a schedule nobody signed.
    expect(scheduleForRecord(signed, undefined, 9n)).toBeUndefined()
  })

  it("prices nothing off a deployment schedule that names another fee", () => {
    expect(scheduleForRecord(null, { min: 2n, fee: 9n }, 5n)).toBeUndefined()
  })

  it("takes either schedule when it names the committed fee", () => {
    expect(scheduleForRecord(signed, undefined, 5n)).toEqual({ min: 10n, fee: 5n })
    expect(scheduleForRecord(null, { min: 2n, fee: 9n }, 9n)).toEqual({ min: 2n, fee: 9n })
  })
})

describe("what a registration deposit is worth", () => {
  it.each([
    ["nothing while the funding read is out", 0n, undefined, 0n, undefined],
    ["the live balance while the address holds it", 7n, undefined, 0n, 7n],
    ["the stamped amount before the funding read lands", 0n, undefined, 3n, 3n],
    ["nothing for a landed read of no transfers", 0n, 0n, 0n, 0n],
    ["the summed funding of a topped-up deposit, not its first tranche", 0n, 11n, 5n, 11n],
    ["the stamped amount over a landed read that missed it", 0n, 0n, 5n, 5n],
  ])("the gross is %s", (_, live, fundedTotal, stamped, gross) => {
    expect(registrationDepositGross(live, fundedTotal, stamped)).toBe(gross)
  })

  it("the wire ticket flag, not a reduced flag or a low fee, makes terms a paylink can pay", () => {
    const sweep = { fee: String(5n * 10n ** 17n), minDeposit: "0" }
    expect(wireTermsFundTicket({ ...sweep, ticket: true })).toBe(true)
    expect(wireTermsFundTicket({ ...sweep, ticket: true, reduced: true })).toBe(true)
    // Reduced alone is an earned tag: its deposit is asked for, never burned from a link.
    expect(wireTermsFundTicket({ ...sweep, reduced: true })).toBe(false)
    expect(wireTermsFundTicket(sweep)).toBe(false)
    // A ticket that prices no sweep, or nothing at all, cannot be paid by a burn.
    expect(
      wireTermsFundTicket({ fee: "0", minDeposit: String(5n * 10n ** 18n), ticket: true }),
    ).toBe(false)
    expect(wireTermsFundTicket({ fee: "0", minDeposit: "0", ticket: true })).toBe(false)
    expect(wireTermsFundTicket(undefined)).toBe(false)
  })

  it("the stored ticket binding decides the funding before the reduced flag does", () => {
    const stored = { fee: String(5n * 10n ** 17n), minDeposit: "0", feeWaived: true }
    expect(registrationOffer(stored)).toEqual({ kind: "earned_tag", funding: "external_deposit" })
    expect(registrationOffer({ ...stored, feeWaived: false })).toEqual({
      kind: "standard",
      funding: "external_deposit",
    })
    const bound = { ...stored, paylinkFunded: true, paylinkId: "id:link" }
    expect(registrationOffer(bound)).toEqual({
      kind: "golden_ticket",
      funding: "paylink",
      paylinkId: "id:link",
      blocked: false,
    })
    expect(registrationOffer({ ...bound, paylinkBlocked: true })).toMatchObject({
      funding: "paylink",
      blocked: true,
    })
    // A funded flag without the link's identity names no link to continue with.
    expect(registrationOffer({ ...stored, paylinkFunded: true }).funding).toBe("external_deposit")
    // An unpriced quote cannot waive a fee it never priced.
    expect(registrationOffer({ fee: "0", minDeposit: "0", feeWaived: true }).kind).toBe("standard")
  })
})

describe("registrationDepositCredit", () => {
  const base = { floor: 11n, feeOwed: 1n }

  it("calls a deposit short of the floor short, and names no credit for it", () => {
    // A settled verdict, not a read in flight: the row shows what was deposited.
    expect(registrationDepositCredit({ ...base, gross: 10n })).toEqual({ short: true })
  })

  it.each(["gross", "floor", "feeOwed"] as const)(
    "withholds both figures while the %s is unread",
    (unread) => {
      expect(registrationDepositCredit({ ...base, gross: 11n, [unread]: undefined })).toEqual({
        short: false,
      })
    },
  )

  it.each([
    ["no fee", { ...base, gross: 15n, feeOwed: 0n }, 15n],
    // 14.7 sent against a 14.5 floor: the chain takes it, so the row projects a credit rather
    // than reporting the whole gross as still-short.
    [
      "a deposit over the floor but under the asked total",
      { gross: dai(14.7), floor: dai(14.5), feeOwed: dai(5) },
      dai(9.7),
    ],
  ])("nets %s", (_, input, credit) => {
    expect(registrationDepositCredit(input)).toEqual({ credit, short: false })
  })
})

describe("a paylink-funded registration names its link without its secret", () => {
  const TERMS_KEY = `webwallet.registration.terms:${ACCOUNT_A}:taga`
  const funded = () =>
    saveRegistrationTerms(
      ticketBoundTerms({
        account: ACCOUNT_A,
        deadline: 1_100,
        fee: "1",
        paylinkId: linkIdentity(PAYLINK_FRAGMENT),
      }),
    )
  const stash = () =>
    stashTicketSignup(
      ticketSignupStash({ fragment: PAYLINK_FRAGMENT, schedule: { fee: "1", minDeposit: "0" } }),
    )

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("survives sign-out and a closed tab in storage, with no bearer secret in it", async () => {
    stash()
    funded()
    await signOut()
    sessionStorage.clear()
    const stored = walletStorage.getCommitted(TERMS_KEY)!
    expect(stored).not.toContain(PAYLINK_FRAGMENT)
    expect(stored).toContain(linkIdentity(PAYLINK_FRAGMENT))
    // The link reopened in the tab binds again by identity alone.
    stash()
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT_A, "taga"))?.fragment).toBe(
      PAYLINK_FRAGMENT,
    )
  })

  it("keeps the binding through every write that does not name the funding", () => {
    funded()
    // A deposit stamp, a deadline refresh, a schedule rewrite: none of them drop the link.
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "taga",
      deadline: 1_200,
      fee: "1",
      minDeposit: "0",
    })
    saveRegistrationTerms({
      ...loadRegistrationTerms(ACCOUNT_A, "taga")!,
      depositAmount: "5",
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1_200,
      depositAmount: "5",
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga")).funding).toBe("paylink")
  })

  it("never carries one registration's link into another account or tag", () => {
    funded()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "tagb",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    saveRegistrationTerms({
      account: ACCOUNT_B,
      tag: "taga",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "tagb")?.paylinkFunded).toBeUndefined()
    expect(loadRegistrationTerms(ACCOUNT_B, "taga")?.paylinkFunded).toBeUndefined()
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "tagb")).funding).toBe(
      "external_deposit",
    )
  })

  it("a renewal the link can pay keeps the binding and lifts a block; one it cannot pay blocks it", () => {
    funded()
    const record = { account: ACCOUNT_A, tag: "taga", fee: "1" }
    const refused = rememberReissuedClaim(record, {
      hold: { deadline: "1300" },
      terms: earnedTerms({ fee: "1", minDeposit: "0" }),
    })
    expect(refused.ticketRefused).toBe(true)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1300,
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
      paylinkBlocked: true,
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga"))).toMatchObject({
      funding: "paylink",
      blocked: true,
    })
    // Renewed terms carrying no schedule leave the block, and the signed amounts, standing.
    expect(rememberReissuedClaim(record, { hold: { deadline: "1400" } }).ticketRefused).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1400,
      fee: "1",
      minDeposit: "0",
      paylinkBlocked: true,
    })
    const renewed = rememberReissuedClaim(record, {
      hold: { deadline: "1500" },
      terms: earnedTerms({ fee: "1", minDeposit: "0", ticket: true }),
    })
    expect(renewed.ticketRefused).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1500,
      paylinkFunded: true,
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")?.paylinkBlocked).toBeUndefined()
  })

  it("a renewal that prices another fee keeps the stored quote and blocks the link on it", () => {
    funded()
    const before = loadRegistrationTerms(ACCOUNT_A, "taga")!
    const refused = rememberReissuedClaim(
      { account: ACCOUNT_A, tag: "taga", fee: "1" },
      {
        hold: { deadline: "1300" },
        terms: earnedTerms({ fee: "2", minDeposit: "0", ticket: true }),
      },
    )
    expect(refused.ticketRefused).toBe(true)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toEqual({ ...before, paylinkBlocked: true })
    // An ordinary registration on the same terms is simply left alone.
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "tagb",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    const plain = loadRegistrationTerms(ACCOUNT_A, "tagb")
    expect(
      rememberReissuedClaim(
        { account: ACCOUNT_A, tag: "tagb", fee: "1" },
        { hold: { deadline: "1300" }, terms: earnedTerms({ fee: "2", reduced: false }) },
      ).ticketRefused,
    ).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "tagb")).toEqual(plain)
  })

  it("only a write that names the funding as none drops the link", () => {
    funded()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "taga",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
      paylinkFunded: false,
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga")).funding).toBe(
      "external_deposit",
    )
  })
})

it("preserves the campaign expectation when the same quote is refreshed, but never transfers it to another tag", () => {
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "earned",
    deadline: 0,
    feeWaived: false,
    earnedExpected: true,
  })
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "earned",
    deadline: 100,
    feeWaived: false,
    fee: "5",
    minDeposit: "10",
  })
  expect(loadRegistrationTerms(ACCOUNT_A, "earned")).toMatchObject({
    earnedExpected: true,
    feeWaived: false,
  })
  saveRegistrationTerms({ account: ACCOUNT_A, tag: "different", deadline: 100, feeWaived: false })
  expect(loadRegistrationTerms(ACCOUNT_A, "different")?.earnedExpected).toBeUndefined()
})

describe("what to ask for and what the chain takes are two figures", () => {
  // The default schedules: each floor is its fee plus its minimum.
  const earned = RANDOM
  // An earned schedule whose floor is over the earned ask.
  const overAsk = { min: RANDOM_ASK, fee: RANDOM.fee }

  it.each([["before any schedule is known, with no split", undefined, undefined, undefined]])(
    "asks the constant standard total %s",
    (_, schedule, fee, floor) => {
      expect(registrationQuote(schedule, "standard")).toEqual({ total: PAID_ASK, fee, floor })
    },
  )

  it("asks the earned total for an earned schedule, with headroom over its floor", () => {
    const quote = registrationQuote(earned, "earned_tag")
    expect(quote.total).toBe(RANDOM_ASK)
    expect(quote.floor).toBe(earned.fee + earned.min)
    expect(registrationQuote(undefined, "earned_tag").total).toBe(RANDOM_ASK)
  })

  it("reads a signed earned floor under the ask as quotable, and one over it as not", () => {
    expect(floorExceedsAsk(earned, "earned_tag")).toBe(false)
    expect(floorExceedsAsk(overAsk, "earned_tag")).toBe(true)
    // The standard ask leaves the same schedule inside its own bar.
    expect(floorExceedsAsk(overAsk, "standard")).toBe(false)
  })

  it("refuses a kind nothing here prices, rather than quoting it as standard", () => {
    // The compiler forbids this; the runtime backstop is what stops a third kind priced as the
    // cheapest one if a wire value ever reaches here uncoerced.
    expect(() => askedTotal("future_kind" as never)).toThrow("future_kind")
  })

  it("reports a floor above the asked total and quotes the floor, never a refused figure", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // Renders call this, so a misconfigured deployment must not take the screen down with it.
      const quote = registrationQuote({ min: dai(15), fee: dai(1) }, "standard")
      expect(quote.total).toBe(dai(16))
      expect(quote.floor).toBe(dai(16))
      expect(report).toHaveBeenCalledTimes(1)
      // Once per distinct message: a re-render must not fill the console.
      registrationQuote({ min: dai(15), fee: dai(1) }, "standard")
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      report.mockRestore()
    }
  })

  it("decides the kind a registration is quoted as", () => {
    expect(quotedRegistrationKind(false, undefined)).toBe("standard")
    expect(quotedRegistrationKind(undefined, earned)).toBe("standard")
    expect(quotedRegistrationKind(true, earned)).toBe("earned_tag")
    // A waived schedule whose floor outgrew the earned ask is quoted on the standard one.
    expect(quotedRegistrationKind(true, overAsk)).toBe("standard")
    // With no schedule the waiver's hint stands.
    expect(quotedRegistrationKind(true, undefined)).toBe("earned_tag")
  })
})

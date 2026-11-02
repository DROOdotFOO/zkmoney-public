import { describe, expect, it } from "vitest"
import {
  aboutLimitsView,
  type AboutLimitsFacts,
  type AboutLimitsView,
  type CapacityFacts,
  type CapacityObservation,
  type ProductLimitFacts,
  type SponsorshipFacts,
} from "../../../src/features/limits/aboutLimitsView"
import { CAPACITY_LOW, CAPACITY_NONE } from "../../../src/features/deposit/fundingCapacity"
import * as copy from "../../../src/features/limits/limitsCopy"
import { LIMIT, grouped } from "../../support/publicLimit"

const E18 = 10n ** 18n
const format = { time: (ms: number) => `time:${ms}` }

const product: ProductLimitFacts = {
  deposit: { maximumUsd: String(LIMIT) },
  withdrawal: { maximumUsd: String(LIMIT) },
  send: { maximumUsd: String(LIMIT) },
}

const dai: CapacityObservation = {
  available: 1_234_567_890_000_000_000_000n,
  ceiling: 50_000n * E18,
  // 50,000 per 86,400 s, floored to base units.
  ratePerSecond: 578_703_703_703_703_703n,
  decimals: 18,
  tokenSymbol: "DAI",
  observedAt: 1_000,
}

const view = (facts: Partial<AboutLimitsFacts>) =>
  aboutLimitsView(
    {
      product,
      capacity: { state: "fresh", observation: dai },
      sponsorship: { state: "available", uses: 3, renews: true, refillPeriodSeconds: 86_400 },
      ...facts,
    },
    format,
  )

const row = (section: { rows: { label: string; value: string }[] }, label: string) =>
  section.rows.find((r) => r.label === label)?.value

const sectionText = (section: AboutLimitsView[keyof AboutLimitsView]) =>
  [
    section.status?.text ?? "",
    ...section.rows.flatMap((r) => [r.label, r.value]),
    ...section.notes,
  ].join("\n")

const allText = (v: AboutLimitsView) =>
  [v.operation, v.capacity, v.sponsorship].map(sectionText).join("\n")

const CAPACITY_STATES: (CapacityFacts | undefined)[] = [
  undefined,
  { state: "loading" },
  { state: "fresh", observation: dai },
  { state: "fresh", observation: { ...dai, ratePerSecond: 0n } },
  { state: "stale", observation: dai },
  { state: "unavailable" },
  { state: "unavailable", observation: dai },
  { state: "unsupported" },
  { state: "fresh" },
]

const SPONSORSHIP_STATES: SponsorshipFacts[] = [
  { state: "loading" },
  { state: "unavailable" },
  { state: "unsupported" },
  { state: "no-account" },
  { state: "not-subscribed", maxTx: 100, renews: true, refillPeriodSeconds: 86_400 },
  { state: "not-subscribed", maxTx: 1, renews: false },
  { state: "available", uses: 1, renews: true, refillPeriodSeconds: 86_400 },
  { state: "available", uses: 1, renews: false },
  { state: "available", uses: 1 },
  { state: "available", uses: 1, maxTx: 100, renews: true, refillPeriodSeconds: 86_400 },
  { state: "renewal-unknown", maxTx: 100, refillPeriodSeconds: 86_400 },
  { state: "renewal-unknown", maxTx: 100 },
  { state: "spent" },
]

describe("aboutLimitsView per-transaction maximum", () => {
  it("keeps a missing or malformed maximum unknown instead of inventing one", () => {
    const partial = view({ product: { deposit: product.deposit } }).operation
    expect(partial.state).toBe("partial")
    expect(row(partial, copy.LIMIT_ROW.withdrawal)).toBe(copy.UNAVAILABLE)
    expect(partial.notes).toContain(copy.LIMIT_NOTE)

    const malformed = view({
      product: { deposit: { maximumUsd: grouped(LIMIT) } },
    })
    expect(malformed.operation.state).toBe("unknown")
    expect(row(malformed.operation, copy.LIMIT_ROW.deposit)).toBe(copy.UNAVAILABLE)

    const none = view({ product: {} }).operation
    expect(none.state).toBe("unknown")
    expect(none.notes).toEqual([])
  })
})

describe("aboutLimitsView shared capacity", () => {
  it("shows a fresh read in token units, floored, with the injected check time", () => {
    const { capacity } = view({})
    expect(capacity.state).toBe("fresh")
    expect(capacity.status?.text).toBe(copy.CAPACITY_FRESH)
    // 1,234.56789 must not round up to .57.
    expect(row(capacity, copy.CAPACITY_ROW.available)).toBe("1,234.56 DAI")
    expect(row(capacity, copy.CAPACITY_ROW.total)).toBe("50,000 DAI")
    expect(row(capacity, copy.CAPACITY_ROW.rate)).toBe(copy.ratePerMinute("34.72 DAI"))
    expect(row(capacity, copy.CAPACITY_ROW.checked)).toBe("time:1000")
    expect(capacity.rows.some((r) => r.value.includes("$"))).toBe(false)
    expect(capacity.canRetry).toBe(false)
  })

  it("keeps 6-decimal precision and never shows a positive rate as zero", () => {
    const usdc = {
      ...dai,
      decimals: 6,
      tokenSymbol: "USDC",
      available: 1_500_000_000n,
      ceiling: 2_000_000_000n,
    }
    const at = (ratePerSecond: bigint) =>
      view({ capacity: { state: "fresh", observation: { ...usdc, ratePerSecond } } }).capacity
    const slow = at(1n)
    expect(row(slow, copy.CAPACITY_ROW.available)).toBe("1,500 USDC")
    expect(row(slow, copy.CAPACITY_ROW.rate)).toBe(copy.rateUnderCent("USDC"))
    expect(row(at(200n), copy.CAPACITY_ROW.rate)).toBe(copy.ratePerMinute("0.01 USDC"))
  })

  it("states the refill model, that withdrawals do not restore it, and no reservation", () => {
    const { notes } = view({}).capacity
    expect(notes).toEqual([
      copy.CAPACITY_DISCLOSURE,
      copy.WITHDRAWALS_NOTE,
      copy.CAPACITY_NOT_RESERVED_NOTE,
    ])
  })

  it("does not claim a refill when the read shows a zero rate", () => {
    const capacity = view({
      capacity: { state: "fresh", observation: { ...dai, ratePerSecond: 0n } },
    }).capacity
    expect(row(capacity, copy.CAPACITY_ROW.rate)).toBe(copy.NO_REFILL)
    expect(capacity.notes).toContain(copy.NO_REFILL_DISCLOSURE)
    expect(capacity.notes).not.toContain(copy.CAPACITY_DISCLOSURE)
  })

  it("uses the funding panel's figure for the available amount when it is given", () => {
    const capacity = view({
      capacity: { state: "stale", observation: dai, label: "1,234.56 DAI (not current)" },
    }).capacity
    expect(row(capacity, copy.CAPACITY_ROW.available)).toBe("1,234.56 DAI (not current)")
    expect(row(capacity, copy.CAPACITY_ROW.total)).toBe("50,000 DAI")
  })

  it("shows the funding panel's sentence and retry for a current read", () => {
    const low = view({
      capacity: {
        state: "fresh",
        observation: dai,
        notice: CAPACITY_LOW,
        offerRetry: false,
      },
    }).capacity
    expect(low.state).toBe("fresh")
    expect(low.status).toEqual({ text: CAPACITY_LOW, icon: "alert-triangle" })
    expect(low.canRetry).toBe(false)
    const empty = view({
      capacity: { state: "fresh", observation: dai, notice: CAPACITY_NONE, offerRetry: true },
    }).capacity
    expect(empty.status).toEqual({ text: CAPACITY_NONE, icon: "alert-triangle" })
    expect(empty.canRetry).toBe(true)
    // A stale read keeps its own status: the panel's sentence describes a current read only.
    const stale = view({
      capacity: { state: "stale", observation: dai, notice: CAPACITY_NONE, offerRetry: true },
    }).capacity
    expect(stale.status?.text).toBe(copy.CAPACITY_STALE)
  })

  it("never shows amounts for a failed, loading, unsupported or empty read", () => {
    for (const facts of [
      { state: "unavailable", observation: dai },
      { state: "loading", observation: dai },
      { state: "unsupported" },
      { state: "fresh" },
      { state: "stale" },
    ] as CapacityFacts[]) {
      const capacity = view({ capacity: facts }).capacity
      expect(capacity.rows).toEqual([])
      expect(sectionText(capacity)).not.toMatch(/\b0 DAI\b/)
    }
    expect(view({ capacity: { state: "fresh" } }).capacity.state).toBe("unavailable")
    expect(view({ capacity: { state: "unavailable" } }).capacity.status?.text).toBe(
      copy.CAPACITY_UNAVAILABLE,
    )
    // Unsupported means the wallet cannot read capacity, not that the network has none.
    expect(view({ capacity: { state: "unsupported" } }).capacity.status?.text).toBe(
      copy.CAPACITY_UNSUPPORTED,
    )
  })

  it("offers a retry only when a read failed or went stale", () => {
    const retry = (facts: CapacityFacts) => view({ capacity: facts }).capacity.canRetry
    expect(retry({ state: "loading" })).toBe(false)
    expect(retry({ state: "unsupported" })).toBe(false)
    expect(retry({ state: "unavailable" })).toBe(true)
    expect(retry({ state: "stale", observation: dai })).toBe(true)
  })
})

describe("aboutLimitsView sponsorship allowance", () => {
  const sponsorship = (facts: SponsorshipFacts) => view({ sponsorship: facts }).sponsorship

  it("gives every allowance state but the first its own status text", () => {
    // Variants of one state share its status text; the rows tell them apart.
    const variant = (s: SponsorshipFacts) =>
      (s.state === "available" && (s.renews !== true || s.maxTx !== undefined)) ||
      (s.state === "renewal-unknown" && !s.refillPeriodSeconds) ||
      s.state === "not-subscribed"
    const texts = SPONSORSHIP_STATES.filter((s) => !variant(s)).map(
      (s) => sponsorship(s).status?.text,
    )
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts.every(Boolean)).toBe(true)
  })

  it("shows remaining uses, the configured allowance and its renewal period", () => {
    const available = sponsorship({
      state: "available",
      uses: 3,
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(available.status?.text).toBe(copy.usesLeft(3))
    expect(row(available, copy.SPONSORSHIP_ROW.allowance)).toBe("100")
    expect(row(available, copy.SPONSORSHIP_ROW.renews)).toBe(copy.renewsAfterUsedUp("24 hours"))
    expect(row(sponsorship({ state: "available", uses: 3 }), copy.SPONSORSHIP_ROW.renews)).toBe(
      copy.RENEWS_VALUE.unknown,
    )
  })

  it("splits the spent uses between your transactions and deposit addresses", () => {
    const usage = { yours: 4, depositAddresses: 2 }
    const available = sponsorship({ state: "available", uses: 4, maxTx: 10, usage })
    expect(row(available, copy.SPONSORSHIP_ROW.usedByYou)).toBe("4")
    expect(row(available, copy.SPONSORSHIP_ROW.usedByAddresses)).toBe("2")
    expect(
      row(
        sponsorship({ state: "renewal-unknown", maxTx: 6, usage }),
        copy.SPONSORSHIP_ROW.usedByAddresses,
      ),
    ).toBe("2")
    expect(
      row(sponsorship({ state: "available", uses: 4 }), copy.SPONSORSHIP_ROW.usedByYou),
    ).toBeUndefined()
  })

  it("shows the first allowance without a status line", () => {
    const opening = sponsorship({
      state: "not-subscribed",
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(opening.status).toBeUndefined()
    expect(row(opening, copy.SPONSORSHIP_ROW.firstAllowance)).toBe("100")
    expect(row(opening, copy.SPONSORSHIP_ROW.renews)).toBe(copy.renewsAfterUsedUp("24 hours"))
    expect(opening.notes).toEqual([copy.ALLOWANCE_SCOPE])
  })

  it("offers a retry only when the allowance read failed", () => {
    for (const facts of SPONSORSHIP_STATES) {
      expect(sponsorship(facts).canRetry).toBe(facts.state === "unavailable")
    }
  })

  it("says a stored zero that may renew is unknown, never used up", () => {
    const unknown = sponsorship({
      state: "renewal-unknown",
      maxTx: 100,
      refillPeriodSeconds: 86_400,
    })
    expect(unknown.state).toBe("renewal-unknown")
    expect(unknown.status?.text).toBe(copy.SPONSORSHIP_STATUS.renewalUnknown)
    expect(unknown.status?.icon).toBe("info-circle")
    expect(row(unknown, copy.SPONSORSHIP_ROW.allowance)).toBe("100")
    expect(row(unknown, copy.SPONSORSHIP_ROW.renews)).toBe(copy.renewsAfterUsedUp("24 hours"))
    // The next eligible action is never held back.
    expect(unknown.notes).toContain(copy.RENEWAL_UNKNOWN_NOTE)
  })

  it("never describes a non-renewing allowance as renewing", () => {
    const nonRenewing: SponsorshipFacts[] = [
      { state: "spent" },
      { state: "available", uses: 1, renews: false },
      { state: "not-subscribed", maxTx: 1, renews: false },
    ]
    for (const facts of nonRenewing) {
      expect(row(sponsorship(facts), copy.SPONSORSHIP_ROW.renews)).toBe(copy.RENEWS_VALUE.no)
    }
  })

  it("states the allowance scope with the allowance sheet's wording", () => {
    for (const facts of SPONSORSHIP_STATES) {
      expect(sponsorship(facts).notes[0]).toBe(copy.ALLOWANCE_SCOPE)
    }
  })
})

describe("aboutLimitsView wording across every state", () => {
  it("never shows the internal ceiling", () => {
    for (const capacity of CAPACITY_STATES) {
      for (const sponsorship of SPONSORSHIP_STATES) {
        expect(allText(view({ capacity, sponsorship }))).not.toMatch(/2,?583/)
      }
    }
  })
})

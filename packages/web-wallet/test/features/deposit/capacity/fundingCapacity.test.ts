/**
 * The capacity copy and gate for each eligibility, derived from real store states through 1146's evaluator, so the
 * wording follows the contract rather than a hand-written eligibility.
 */
import { describe, expect, it } from "vitest"
import {
  evaluateCapacityEligibility,
  PortalCapacityReferenceError,
  type PortalCapacityState,
  type RequiredCredit,
} from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import { CAPACITY_CHECKING, CAPACITY_UNAVAILABLE } from "../../../../src/features/limits/limitsCopy"
import {
  CAPACITY_FITS,
  CAPACITY_LOW,
  CAPACITY_NONE,
  capacityAllowsFunding,
  capacityAmount,
  capacityFinding,
  capacityStateLabel,
  fundingCapacityView,
  fundingEligibility,
  type FundingMode,
  type UnknownCapacityPolicy,
} from "../../../../src/features/deposit/fundingCapacity"

const DAI = 10n ** 18n
const TX_AMOUNT_CAP = 5166n * DAI
const NOW = 1_800_000_000_000
const key = {
  chainId: 1,
  portal: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
} as const
const snapshot = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacitySnapshot => ({
  chainId: 1,
  portal: key.portal,
  token: key.token,
  decimals: 18,
  blockNumber: 10n,
  blockTimestamp: BigInt(NOW / 1000),
  rateAtomicPerSecond: (50_000n * DAI) / 86_400n,
  globalLimitAtomic: 50_000n * DAI,
  availableAtomic: 500n * DAI,
  txAmountCapAtomic: TX_AMOUNT_CAP,
  ...over,
})
const fresh = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacityState => ({
  status: "fresh",
  key,
  snapshot: snapshot(over),
  fetchedAt: NOW - 1_000,
})
const known = (whole: bigint, extra = 0n): Extract<RequiredCredit, { status: "known" }> => ({
  status: "known",
  atomic: whole * DAI + extra,
  token: key.token,
  decimals: 18,
})

const eligibilityFor = (state: PortalCapacityState, required: RequiredCredit) =>
  evaluateCapacityEligibility({ state, required, now: NOW })

function view(
  state: PortalCapacityState,
  required: RequiredCredit,
  mode: FundingMode = "editable",
  exactCredit = true,
  unknownCapacity?: UnknownCapacityPolicy,
  sentSymbol = exactCredit ? "DAI" : "USDC",
) {
  return fundingCapacityView({
    eligibility: eligibilityFor(state, required),
    mode,
    symbol: "DAI",
    sentSymbol,
    exactCredit,
    minimumAtomic: DAI,
    unknownCapacity,
  })
}

const loading: PortalCapacityState = { status: "loading", key }
const aged: PortalCapacityState = {
  status: "stale",
  key,
  reason: "age",
  snapshot: snapshot({ availableAtomic: 0n }),
  fetchedAt: NOW - 40_000,
}
const clockAhead: PortalCapacityState = {
  status: "stale",
  key,
  reason: "head",
  head: { cause: "old", blockAgeMs: 3_600_000 },
  snapshot: snapshot({ availableAtomic: 0n }),
  fetchedAt: NOW - 1_000,
}
const failed: PortalCapacityState = {
  status: "unavailable",
  key,
  error: new Error("rpc"),
  failedAt: NOW,
  lastSnapshot: snapshot({ availableAtomic: 0n }),
  lastFetchedAt: NOW - 50_000,
}
/** A read whose reference L1 time failed for `reason`. */
const referenceFailed = (
  reason: ConstructorParameters<typeof PortalCapacityReferenceError>[0],
): PortalCapacityState => ({
  status: "unavailable",
  key,
  error: new PortalCapacityReferenceError(reason, "reference"),
  failedAt: NOW,
})
const unsupported: PortalCapacityState = {
  status: "unsupported",
  key,
  reason: "chain-mismatch",
  detail: "x",
}

describe("fundingCapacityView", () => {
  it("blocks 2,000 against 500 available, names both, and offers the available amount", () => {
    const v = view(fresh(), known(2_000n))
    expect(v.canFund).toBe(false)
    expect(v.statusText).toBe("This deposit needs 2,000 DAI; 500 DAI is available now.")
    expect(v.detailText).toBe("Capacity refills continuously. Check again later.")
    expect(v.availableAmount).toBe("500")
    expect(v.offerRetry).toBe(true)
  })

  it("says nothing about time when the portal does not refill", () => {
    const v = view(fresh({ rateAtomicPerSecond: 0n }), known(2_000n))
    expect(v.detailText).toBe("No automatic refill is configured.")
  })

  it("keeps a fixed amount and offers no smaller one", () => {
    const v = view(fresh(), known(2_000n), "fixed")
    expect(v.statusText).toBe("This payment needs 2,000 DAI; 500 DAI is available now.")
    expect(v.availableAmount).toBeUndefined()
  })

  it("does not offer an available amount below the form minimum", () => {
    expect(view(fresh({ availableAtomic: DAI / 2n }), known(2n)).availableAmount).toBeUndefined()
  })

  it("rounds the available amount down to what can be typed", () => {
    const v = view(fresh({ availableAtomic: 12n * DAI + 345n * 10n ** 15n }), known(20n))
    expect(v.availableAmount).toBe("12.34")
  })

  it("blocks an amount above the bucket ceiling with no wait estimate", () => {
    const v = view(fresh({ globalLimitAtomic: 1_000n * DAI }), known(2_000n))
    expect(v.statusText).toMatch(/can't fit the network's deposit capacity, even when it is full/)
    expect(v.detailText).toBeUndefined()
    expect(v.offerRetry).toBe(false)
  })

  it("warns generically when capacity is low, without counting deposits", () => {
    const low = fresh({ availableAtomic: 1_000n * DAI })
    expect(view(low, known(100n))).toMatchObject({
      canFund: true,
      tone: "warn",
      statusText: CAPACITY_FITS,
      detailText: CAPACITY_LOW,
    })
    expect(view(low, { status: "unknown" }, "address").statusText).toBe(CAPACITY_LOW)
  })

  it("under hold, blocks a conversion route whose credit is unknown, even with a full bucket", () => {
    const v = view(
      fresh({ availableAtomic: 50_000n * DAI }),
      { status: "unknown" },
      "editable",
      false,
    )
    expect(v.canFund).toBe(false)
    expect(v.statusText).toBe("Capacity can't be checked for USDC deposits right now.")
    expect(v.availableAmount).toBeUndefined()
  })

  it("adds nothing of its own above the operation cap; the amount form explains that limit", () => {
    const v = view(fresh(), {
      status: "known",
      atomic: TX_AMOUNT_CAP + 1n,
      token: key.token,
      decimals: 18,
    })
    expect(v.canFund).toBe(false)
    expect(v.statusText).toBeUndefined()
    expect(v.detailText).toBeUndefined()
  })

  it("pauses while loading, and never calls a stale or failed reading current", () => {
    const loadingState: PortalCapacityState = { status: "loading", key }
    expect(view(loadingState, known(10n))).toMatchObject({ tone: "checking", canFund: false })
    expect(capacityStateLabel(loadingState, "DAI")).toBe(CAPACITY_CHECKING)

    const agedState: PortalCapacityState = {
      status: "stale",
      key,
      reason: "age",
      snapshot: snapshot(),
      fetchedAt: NOW - 40_000,
    }
    expect(view(agedState, known(10n))).toMatchObject({ canFund: false, offerRetry: true })
    expect(capacityStateLabel(agedState, "DAI")).toBe("500 DAI (not current)")

    const failedState: PortalCapacityState = {
      status: "unavailable",
      key,
      error: new Error("rpc"),
      failedAt: NOW,
      lastSnapshot: snapshot(),
      lastFetchedAt: NOW - 50_000,
    }
    expect(view(failedState, known(10n))).toMatchObject({
      canFund: false,
      offerRetry: true,
      statusText: CAPACITY_UNAVAILABLE,
    })
    expect(capacityStateLabel(failedState, "DAI")).toBe("500 DAI (not current)")
  })

  it("points at the device clock when the block reads as old, without promising Retry fixes it", () => {
    const v = view(
      {
        status: "stale",
        key,
        reason: "head",
        head: { cause: "old", blockAgeMs: 3_600_000 },
        snapshot: snapshot(),
        fetchedAt: NOW - 1_000,
      },
      known(10n),
    )
    expect(v.canFund).toBe(false)
    expect(v.statusText).toBe("The capacity reading looks out of date.")
    expect(v.detailText).toMatch(/device's date and time/)
  })
})

describe("fundingCapacityView under the proceed policy", () => {
  it("holds a conversion credit against an empty bucket, and says so", () => {
    const v = view(
      fresh({ availableAtomic: 0n }),
      { status: "unknown" },
      "editable",
      false,
      "proceed",
    )
    expect(v).toMatchObject({ canFund: false, statusText: CAPACITY_NONE, offerRetry: true })
  })

  it("keeps every known shortfall and impossible amount", () => {
    expect(view(fresh(), known(2_000n), "editable", true, "proceed")).toMatchObject({
      canFund: false,
      statusText: "This deposit needs 2,000 DAI; 500 DAI is available now.",
      availableAmount: "500",
    })
    expect(
      view(fresh({ globalLimitAtomic: 1_000n * DAI }), known(2_000n), "editable", true, "proceed"),
    ).toMatchObject({ canFund: false, tone: "blocked" })
    expect(
      view(fresh(), { ...known(0n), atomic: TX_AMOUNT_CAP + 1n }, "editable", true, "proceed")
        .canFund,
    ).toBe(false)
    expect(
      view(fresh({ availableAtomic: 0n }), known(10n), "editable", true, "proceed"),
    ).toMatchObject({
      canFund: false,
      statusText: "This deposit needs 10 DAI; 0 DAI is available now.",
    })
  })

  it("keeps a chain, portal, token or decimals mismatch held", () => {
    for (const reason of ["chain-mismatch", "portal-mismatch", "token-mismatch"] as const) {
      const state: PortalCapacityState = { status: "unsupported", key, reason, detail: "x" }
      expect(view(state, known(10n), "editable", true, "proceed")).toMatchObject({
        canFund: false,
        offerRetry: false,
      })
    }
    for (const required of [
      { ...known(10n), token: "0x3333333333333333333333333333333333333333" },
      { ...known(10n), decimals: 6 },
    ]) {
      expect(view(fresh(), required, "editable", true, "proceed").canFund).toBe(false)
    }
  })

  it("says nothing at all about capacity it could not establish", () => {
    for (const state of [
      loading,
      aged,
      clockAhead,
      failed,
      fresh(),
      fresh({ availableAtomic: 1n }),
    ]) {
      for (const required of [{ status: "unknown" } as const, known(10n)]) {
        const v = view(state, required, "editable", required.status === "known", "proceed")
        if (capacityFinding(eligibilityFor(state, required)) !== "unknown") continue
        expect(v).toEqual({ tone: "ok", canFund: true, offerRetry: false })
      }
    }
  })
})

describe("capacityFinding and capacityAllowsFunding", () => {
  const cases: [string, PortalCapacityState, RequiredCredit, string][] = [
    ["a fit", fresh(), known(10n), "fits"],
    ["a loading read", loading, known(10n), "unknown"],
    ["an aged read", aged, known(10n), "unknown"],
    ["a clock-ahead read", clockAhead, known(10n), "unknown"],
    ["a failed read", failed, known(10n), "unknown"],
    [
      "an unknown credit and a low bucket",
      fresh({ availableAtomic: 1n }),
      { status: "unknown" },
      "unknown",
    ],
    [
      "an unknown credit and an empty bucket",
      fresh({ availableAtomic: 0n }),
      { status: "unknown" },
      "short",
    ],
    ["a shortfall", fresh(), known(2_000n), "short"],
    [
      "an amount above the ceiling",
      fresh({ globalLimitAtomic: 1_000n * DAI }),
      known(2_000n),
      "short",
    ],
    ["a chain mismatch", unsupported, known(10n), "unsupported"],
    [
      "a node that follows another chain",
      referenceFailed("chain-mismatch"),
      known(10n),
      "unsupported",
    ],
    ["a node that has not synced L1", referenceFailed("unsynced"), known(10n), "unknown"],
    [
      "a portal without capacity getters",
      { status: "unsupported", key, reason: "no-capacity-getters", detail: "x" },
      known(10n),
      "unknown",
    ],
  ]

  it.each(cases)("classifies %s", (_case, state, required, finding) => {
    expect(capacityFinding(eligibilityFor(state, required))).toBe(finding)
  })

  it.each(cases)(
    "the view's gate for %s is the gate the last check applies, under both policies",
    (_case, state, required) => {
      const eligibility = eligibilityFor(state, required)
      for (const policy of ["hold", "proceed"] as const) {
        const v = view(state, required, "editable", required.status === "known", policy)
        expect(v.canFund).toBe(capacityAllowsFunding(eligibility, policy))
      }
      expect(capacityAllowsFunding(eligibility, "hold")).toBe(eligibility.kind === "fits")
    },
  )
})

describe("fundingEligibility", () => {
  /** A failed read after a snapshot fetched `age` ms ago. */
  const failedAfter = (
    over: Partial<PortalCapacitySnapshot>,
    lastWasFresh = true,
    age = 1_000,
  ): PortalCapacityState => ({
    status: "unavailable",
    key,
    error: new Error("rpc"),
    failedAt: NOW,
    lastSnapshot: snapshot(over),
    lastFetchedAt: NOW - age,
    lastWasFresh,
  })
  const funding = (
    state: PortalCapacityState,
    required: RequiredCredit,
    unknownCapacity?: UnknownCapacityPolicy,
  ) => fundingEligibility({ state, required, now: NOW, unknownCapacity })

  it("under proceed, keeps a current shortfall, empty bucket or mismatch that a failed read follows", () => {
    const shortfall = funding(failedAfter({}), known(2_000n), "proceed")
    expect(shortfall.kind).toBe("exceeds-available")
    const v = fundingCapacityView({
      eligibility: shortfall,
      mode: "editable",
      symbol: "DAI",
      sentSymbol: "DAI",
      exactCredit: true,
      unknownCapacity: "proceed",
    })
    expect(v).toMatchObject({
      canFund: false,
      statusText: "This deposit needs 2,000 DAI; 500 DAI is available now.",
    })
    expect(
      funding(failedAfter({ availableAtomic: 0n }), { status: "unknown" }, "proceed"),
    ).toMatchObject({ kind: "amount-unknown", zero: true })
    expect(
      funding(failedAfter({ globalLimitAtomic: 1_000n * DAI }), known(2_000n), "proceed").kind,
    ).toBe("exceeds-ceiling")
    expect(funding(failedAfter({ decimals: 6 }), known(10n), "proceed").kind).toBe("unsupported")
  })

  it("under proceed, leaves a failed read unknown when its last snapshot fits, is no longer current, or was not published fresh", () => {
    const unknown = [
      funding(failedAfter({}), known(10n), "proceed"),
      funding(failedAfter({ availableAtomic: 1n }), { status: "unknown" }, "proceed"),
      funding(failedAfter({}, true, 30_000), known(2_000n), "proceed"),
      funding(failedAfter({}, false), known(2_000n), "proceed"),
    ]
    for (const eligibility of unknown) {
      expect(eligibility.kind).toBe("unavailable")
      expect(capacityAllowsFunding(eligibility, "proceed")).toBe(true)
    }
  })

  it("under hold, is the plain evaluation", () => {
    for (const policy of [undefined, "hold"] as const) {
      expect(funding(failedAfter({}), known(2_000n), policy)).toEqual(
        eligibilityFor(failedAfter({}), known(2_000n)),
      )
    }
  })
})

describe("capacity figures", () => {
  it("formats base units rounded down to cents, with grouping", () => {
    expect(capacityAmount(12_400n * DAI + 5n * 10n ** 17n, 18, "DAI")).toBe("12,400.5 DAI")
    expect(capacityAmount(999n, 18, "DAI")).toBe("0 DAI")
    expect(capacityAmount(1_234_567n, 6, "USDC")).toBe("1.23 USDC")
  })

  it("labels a missing state as checking", () => {
    expect(capacityStateLabel(undefined, "DAI")).toBe(CAPACITY_CHECKING)
  })
})

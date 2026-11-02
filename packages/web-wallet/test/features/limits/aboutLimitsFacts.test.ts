import { describe, expect, it } from "vitest"
import {
  deriveAllowanceState,
  type AllowanceSnapshot,
  type PortalCapacityState,
} from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import { capacityFacts, sponsorshipFacts } from "../../../src/features/limits/aboutLimitsFacts"
import { CAPACITY_LOW } from "../../../src/features/deposit/fundingCapacity"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const allowance = (overrides: Partial<ClaimFpcAllowance> = {}): ClaimFpcAllowance => ({
  subscribed: true,
  uses: 0,
  maxTx: 100,
  refillPeriod: 86_400,
  ...overrides,
})

const ready = (read: ClaimFpcAllowance): AllowanceSnapshot => ({
  status: "ready",
  scope: "account|sandbox",
  read: { fpcAddress: "0xfpc", railId: 1, payer: "account", allowance: read },
  state: deriveAllowanceState(read),
  refreshing: false,
})

describe("sponsorshipFacts", () => {
  it("maps a pending or failed read without inventing a state", () => {
    expect(sponsorshipFacts({ status: "signed-out" })).toEqual({ state: "loading" })
    expect(sponsorshipFacts({ status: "loading", scope: "s" })).toEqual({ state: "loading" })
    expect(
      sponsorshipFacts({ status: "unavailable", scope: "s", error: new Error("rpc") }),
    ).toEqual({
      state: "unavailable",
    })
  })

  it("maps each allowance state, with the rail's configured allowance and renewal period", () => {
    expect(sponsorshipFacts(ready(allowance({ subscribed: false })))).toEqual({
      state: "not-subscribed",
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance({ uses: 3 })))).toEqual({
      state: "available",
      uses: 3,
      maxTx: 100,
      renews: true,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance()))).toEqual({
      state: "renewal-unknown",
      maxTx: 100,
      refillPeriodSeconds: 86_400,
    })
    expect(sponsorshipFacts(ready(allowance({ refillPeriod: 0 })))).toEqual({ state: "spent" })
  })
})

describe("capacityFacts", () => {
  const key = { chainId: 1, portal: "0xportal", token: DAI } as PortalCapacityState["key"]
  const snapshot = {
    chainId: 1,
    portal: "0xportal",
    token: DAI,
    decimals: 18,
    blockNumber: 9n,
    blockTimestamp: 1_000n,
    rateAtomicPerSecond: 5n,
    globalLimitAtomic: 50_000n * 10n ** 18n,
    availableAtomic: 1_234_567n * 10n ** 15n,
    txAmountCapAtomic: 5166n * 10n ** 18n,
  } as Extract<PortalCapacityState, { status: "fresh" }>["snapshot"]

  it("maps a read with its values and the funding panel's figure", () => {
    const fresh = capacityFacts({ status: "fresh", key, snapshot, fetchedAt: 42 }, "DAI")
    expect(fresh).toEqual({
      state: "fresh",
      observation: {
        available: snapshot.availableAtomic,
        ceiling: snapshot.globalLimitAtomic,
        ratePerSecond: 5n,
        decimals: 18,
        tokenSymbol: "DAI",
        observedAt: 42,
      },
      label: "1,234.56 DAI",
      notice: undefined,
      offerRetry: undefined,
    })
    const panel = { statusText: CAPACITY_LOW, offerRetry: false }
    expect(
      capacityFacts({ status: "fresh", key, snapshot, fetchedAt: 42 }, "DAI", panel),
    ).toMatchObject({ notice: CAPACITY_LOW, offerRetry: false })
    const stale = capacityFacts(
      { status: "stale", key, snapshot, fetchedAt: 42, reason: "age" },
      "DAI",
    )
    expect(stale.state).toBe("stale")
    expect(stale.label).toBe("1,234.56 DAI (not current)")
  })

  it("keeps a pending, failed or unsupported read free of amounts", () => {
    expect(capacityFacts(undefined, "DAI")).toEqual({ state: "loading" })
    expect(capacityFacts({ status: "loading", key }, "DAI")).toEqual({ state: "loading" })
    const failed = capacityFacts(
      {
        status: "unavailable",
        key,
        error: new Error("rpc"),
        failedAt: 1,
        lastSnapshot: snapshot,
        lastFetchedAt: 1,
      },
      "DAI",
    )
    expect(failed).toEqual({ state: "unavailable" })
    expect(
      capacityFacts({ status: "unsupported", key, reason: "token-mismatch", detail: "x" }, "DAI"),
    ).toEqual({ state: "unsupported" })
  })
})

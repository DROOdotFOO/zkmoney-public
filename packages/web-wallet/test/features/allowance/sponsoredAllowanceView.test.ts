/**
 * What the wallet says about the sponsored-transaction allowance, from the existing ClaimFPC reads. A
 * stored zero that may renew blocks nothing.
 */
import { describe, expect, it } from "vitest"
import { deriveAllowanceState, type AllowanceSnapshot } from "@obsidion/front-core"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import { formatPeriod, sponsoredActionBlock } from "../../../src/features/allowance/allowanceView"

type Ready = Extract<AllowanceSnapshot, { status: "ready" }>

const ready = (over: Partial<ClaimFpcAllowance>): Ready => {
  const allowance = { subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...over }
  return {
    status: "ready",
    scope: "alice|sandbox",
    read: { fpcAddress: "0xf9c", railId: 1, payer: "alice", allowance },
    state: deriveAllowanceState(allowance),
    refreshing: false,
  }
}

describe("sponsoredActionBlock", () => {
  it("blocks only a fresh stored zero on a rail that never renews", () => {
    expect(sponsoredActionBlock(ready({ maxTx: 1, refillPeriod: 0 }))).toBe(
      "No sponsored transactions left. This allowance does not renew.",
    )
  })

  it("does not block on a cached refusal while a new read is running", () => {
    expect(
      sponsoredActionBlock({ ...ready({ maxTx: 1, refillPeriod: 0 }), refreshing: true }),
    ).toBeUndefined()
  })

  it("lets through a zero that may renew, uses left, a new account, and a failed or pending read", () => {
    expect(sponsoredActionBlock(ready({}))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ uses: 3 }))).toBeUndefined()
    expect(sponsoredActionBlock(ready({ subscribed: false }))).toBeUndefined()
    expect(
      sponsoredActionBlock({ status: "unavailable", scope: "a", error: new Error("x") }),
    ).toBeUndefined()
    expect(sponsoredActionBlock({ status: "loading", scope: "a" })).toBeUndefined()
  })
})

describe("formatPeriod", () => {
  it("states a refill period plainly", () => {
    expect(formatPeriod(86_400)).toBe("24 hours")
    expect(formatPeriod(7 * 86_400)).toBe("7 days")
    expect(formatPeriod(3_600)).toBe("1 hour")
    expect(formatPeriod(90)).toBe("90 seconds")
  })
})

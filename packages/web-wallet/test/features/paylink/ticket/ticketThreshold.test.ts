/**
 * The golden-ticket threshold check a new ticket signup starts on. It compares base units, so a
 * figure rounded for display can never pass a note one wei short, or refuse one exactly at it.
 */
import { describe, expect, it } from "vitest"
import { linkBaseUnits, ticketEligibility } from "../../../../src/features/paylink/ticketThreshold"

const ONE = 10n ** 18n

describe("ticketEligibility", () => {
  it.each([
    ["one wei below", 3n * ONE - 1n, "below_threshold"],
    ["exactly at", 3n * ONE, "eligible"],
  ] as const)("a note %s the threshold is %s", (_label, amount, expected) => {
    expect(ticketEligibility(amount.toString(), (3n * ONE).toString())).toBe(expected)
  })
})

describe("linkBaseUnits", () => {
  it("reads the page's figure back to the note's exact base units", () => {
    expect(linkBaseUnits("25", 18)).toBe((25n * ONE).toString())
    expect(linkBaseUnits("2.999999999999999999", 18)).toBe((3n * ONE - 1n).toString())
    expect(linkBaseUnits("0.000000000000000001", 18)).toBe("1")
  })
})

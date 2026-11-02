import { describe, expect, it } from "vitest"
import type { SipaProcessingState } from "@obsidion/front-core"
import {
  capacityAmount,
  heldDepositLine,
  processingCopy,
} from "../../../src/features/deposit/processingCopy"

const E18 = 10n ** 18n
const AT = Date.UTC(2026, 8, 25, 12)

const text = (state: SipaProcessingState) => {
  const copy = processingCopy(state, "DAI")
  return [copy.headline, copy.funds, ...copy.lines].filter(Boolean).join(" ")
}

/** Wording that would promise the deposit goes through, name a cause for an earlier failure, or reset daily. */
const PROMISES =
  /automatic(ally)? (processed|swept)|will be (processed|swept)|midnight|tomorrow|reserved|guarantee/i

describe("processingCopy", () => {
  it("shows an estimate only when one is supported, rounded up and conditional", () => {
    const at = (refill: Extract<SipaProcessingState["reason"], { kind: "capacity" }>["refill"]) =>
      text({
        reason: {
          kind: "capacity",
          requiredAtomic: 2n,
          availableAtomic: 1n,
          refill,
          decimals: 18,
          observedAt: AT,
        },
      })
    // 2,000 needed with 500 available at the source-default rate of ~34.72 per minute is 43.2 min.
    expect(at({ status: "estimate", seconds: 2_592n })).toContain(
      "Estimated capacity in about 44 min, if no one else uses it.",
    )
    expect(at({ status: "estimate", seconds: 3_600n })).toContain("about 1 h,")
    expect(at({ status: "unknown" })).not.toMatch(/Estimated|minute|\bmin\b/)
    expect(at({ status: "none" })).toContain("No automatic refill is configured.")
    expect(at({ status: "none" })).not.toMatch(/Estimated/)
  })

  it("never offers a wait for a deposit that cannot fit", () => {
    for (const state of [
      {
        reason: {
          kind: "ceiling" as const,
          requiredAtomic: 60_000n * E18,
          ceilingAtomic: 50_000n * E18,
          decimals: 18,
          observedAt: AT,
        },
      },
      { reason: { kind: "operation-cap" as const, observedAt: AT } },
    ]) {
      const copy = processingCopy(state, "DAI")
      expect(copy.lines.join(" ")).toContain("Waiting won't change this.")
      expect(copy.lines.join(" ")).not.toMatch(/Estimated|refill/)
      expect(copy.canCheckAgain).toBe(false)
    }
  })

  it("gives no fit verdict for a converted deposit", () => {
    const line = text({
      reason: {
        kind: "unavailable",
        cause: "amount-unknown",
        availableAtomic: 50_000n * E18,
        decimals: 18,
        observedAt: AT,
      },
    })
    expect(line).toContain("50,000 DAI of network capacity is available now.")
    expect(line).toContain("can't tell how much of this deposit the network would credit")
    expect(line).not.toContain("converted")
  })

  it("keeps a failed read's last reading marked as possibly out of date", () => {
    const copy = processingCopy(
      {
        reason: {
          kind: "unavailable",
          cause: "capacity-unread",
          last: { availableAtomic: 0n, decimals: 18, observedAt: AT },
        },
      },
      "DAI",
    )
    expect(copy.headline).toBe("Reason unavailable")
    expect(copy.lines.join(" ")).toContain("could not determine why processing is delayed")
    expect(copy.lines.join(" ")).toContain(
      "The last reading showed 0 DAI available. It may have changed since.",
    )
    expect(copy.checkedAt).toBe(AT)
  })

  it("says why the sweep still waits when a read cannot clear a known blocker", () => {
    const copy = processingCopy(
      {
        reason: { kind: "unavailable", cause: "capacity-unread" },
        blocker: { kind: "capacity", observedAt: AT },
      },
      "DAI",
    )
    expect(copy.lines.at(-1)).toBe(
      "Network capacity was insufficient when last checked, so the manual sweep stays unavailable until a new reading shows enough.",
    )
  })

  it("never promises that a new reading clears a blocker refill cannot lift", () => {
    for (const kind of ["ceiling", "operation-cap"] as const) {
      const copy = processingCopy(
        {
          reason: { kind: "unavailable", cause: "capacity-unread" },
          blocker: { kind, observedAt: AT },
        },
        "DAI",
      )
      expect(copy.lines.at(-1)).toMatch(/so the manual sweep stays unavailable\.$/)
      expect(copy.lines.at(-1)).not.toContain("new reading")
    }
  })

  it("promises neither processing, a reset nor a reservation in any state", () => {
    const states: SipaProcessingState[] = [
      {
        reason: {
          kind: "capacity",
          availableAtomic: 0n,
          refill: { status: "none" },
          decimals: 18,
          observedAt: AT,
        },
      },
      { reason: { kind: "processing", availableAtomic: E18, decimals: 18, observedAt: AT } },
      { reason: { kind: "checking" } },
      { reason: { kind: "unavailable", cause: "portal-unknown" } },
      { reason: { kind: "unavailable", cause: "capacity-unread" } },
    ]
    for (const state of states) {
      expect(text(state)).not.toMatch(PROMISES)
      expect(text(state)).not.toMatch(/2[,.]?583/)
    }
  })
})

describe("capacityAmount", () => {
  it("counts capacity in the token, not dollars", () => {
    expect(capacityAmount(1_234_567n * 10n ** 15n, 18, "DAI")).toBe("1,234.57 DAI")
    expect(capacityAmount(0n, 18, "TEST")).toBe("0 TEST")
  })
})

describe("heldDepositLine", () => {
  const blocker = { kind: "capacity" as const, observedAt: AT }

  it("attributes a remembered blocker to the last reading when the current read cannot confirm it", () => {
    expect(
      heldDepositLine({ reason: { kind: "unavailable", cause: "capacity-unread" }, blocker }),
    ).toBe("Network capacity was insufficient when last checked.")
    expect(heldDepositLine({ reason: { kind: "checking" }, blocker })).toBe(
      "Network capacity was insufficient when last checked.",
    )
  })
})

import { describe, expect, it } from "vitest"
import { requestMeta, requestersSummary } from "../../../src/features/requests/nonContactView"
import { relativeTimeLabel } from "../../../src/ui/format"

const NOW = Date.UTC(2026, 8, 1, 12)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("requestersSummary", () => {
  const from = (...tags: string[]) => tags.map((contactTag) => ({ contactTag }))

  it("names one or two requesters, then counts the rest", () => {
    expect(requestersSummary(from("mina"))).toBe("@mina.zk.money requested funds from you.")
    expect(requestersSummary(from("mina", "paul"))).toBe(
      "@mina.zk.money and @paul.zk.money requested funds from you.",
    )
    expect(requestersSummary(from("mina", "paul", "jj", "kai"))).toBe(
      "@mina.zk.money, @paul.zk.money and 2 more requested funds from you.",
    )
  })

  it("counts people, not requests", () => {
    expect(requestersSummary(from("mina", "mina", "paul"))).toBe(
      "@mina.zk.money and @paul.zk.money requested funds from you.",
    )
  })
})

describe("requestMeta", () => {
  it("shows the note, or says there is none", () => {
    expect(requestMeta({ note: "Dinner split", createdAt: NOW - 2 * HOUR }, NOW)).toBe(
      "Dinner split · 2h ago",
    )
    expect(requestMeta({ note: "  ", createdAt: NOW - 3 * DAY }, NOW)).toBe("No note · 3d ago")
  })
})

describe("relativeTimeLabel", () => {
  it("steps from minutes to days", () => {
    expect(relativeTimeLabel(NOW - 20_000, NOW)).toBe("Just now")
    expect(relativeTimeLabel(NOW - 5 * MINUTE, NOW)).toBe("5m ago")
    expect(relativeTimeLabel(NOW - 23 * HOUR, NOW)).toBe("23h ago")
    expect(relativeTimeLabel(NOW - 30 * HOUR, NOW)).toBe("Yesterday")
    expect(relativeTimeLabel(NOW - 6 * DAY, NOW)).toBe("6d ago")
  })

  it("falls back to a date after a week", () => {
    expect(relativeTimeLabel(NOW - 8 * DAY, NOW)).not.toMatch(/ago$/)
  })
})

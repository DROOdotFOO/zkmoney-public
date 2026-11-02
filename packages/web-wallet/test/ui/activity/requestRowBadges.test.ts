/**
 * A row label the design system styles no badge for renders NOTHING — `ActivityListRow` guards on
 * the style, not the label — so an unmapped label silently deletes the state from the feed instead
 * of failing loudly. Every status a feed row can name is pinned here against the real lookup.
 */
import { describe, expect, it } from "vitest"
import { statusBadgeStyle } from "@obsidion/web-ds"
import copy from "../../../src/ui/activity/ActivityRow.copy"

describe("feed row badges", () => {
  it("styles every status a row can name", () => {
    for (const label of Object.values(copy.status))
      expect(statusBadgeStyle(label), label).toBeDefined()
    // Detected must not wear the settled colour: that is the state it has to be told apart from.
    expect(statusBadgeStyle(copy.status.paymentDetected)).not.toBe(
      statusBadgeStyle(copy.status.paid),
    )
  })
})

import { describe, expect, it } from "vitest"
import type { PaymentRequest } from "@obsidion/front-core"
import { linkExpiryLabel, requestShareStatus } from "../../../src/features/requests/shareView"

const DAY = 86_400_000
const NOW = 1_700_000_000_000

const request = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  id: "r1",
  contactTag: "",
  amount: 10,
  asset: "USDC",
  direction: "outgoing",
  status: "pending",
  createdAt: NOW - DAY,
  kind: "link",
  expiresAt: NOW + 7 * DAY,
  ...overrides,
})

describe("requestShareStatus", () => {
  it("is Unpaid and active while pending and unexpired", () => {
    expect(requestShareStatus(request(), NOW)).toEqual({
      label: "Unpaid",
      badgeStyle: "awaitingClaim",
      active: true,
    })
  })

  it("terminal statuses win over expiry", () => {
    expect(requestShareStatus(request({ status: "fulfilled", expiresAt: NOW - 1 }), NOW)).toEqual({
      label: "Paid",
      badgeStyle: "paid",
      active: false,
    })
    expect(requestShareStatus(request({ status: "cancelled" }), NOW).label).toBe("Cancelled")
    expect(requestShareStatus(request({ status: "declined" }), NOW).label).toBe("Declined")
  })

  it("a pending link past its expiry reads Expired and deactivates", () => {
    expect(requestShareStatus(request({ expiresAt: NOW - 1 }), NOW)).toEqual({
      label: "Expired",
      badgeStyle: "failed",
      active: false,
    })
  })
})

describe("linkExpiryLabel", () => {
  it("rounds days up so a fresh 7-day link reads 7 days", () => {
    expect(linkExpiryLabel(NOW + 7 * DAY, NOW)).toBe("7 days")
    expect(linkExpiryLabel(NOW + 7 * DAY - 1, NOW)).toBe("7 days")
    expect(linkExpiryLabel(NOW + DAY, NOW)).toBe("1 day")
  })

  it("handles the last-day and expired edges", () => {
    expect(linkExpiryLabel(NOW + DAY - 1, NOW)).toBe("1 day")
    expect(linkExpiryLabel(NOW - 1, NOW)).toBe("Expired")
  })

  it("is null without an expiry", () => {
    expect(linkExpiryLabel(undefined, NOW)).toBeNull()
  })
})

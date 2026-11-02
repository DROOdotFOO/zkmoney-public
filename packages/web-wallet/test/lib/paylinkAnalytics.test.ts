/**
 * Paylink lifecycle analytics: on-device amount bucketing, the domain-separated tagging-key join
 * hash, the consent-gated /paylink-events emitter, and the consent disclosure copy.
 *
 * The tagging key crosses the wire inside the link fragment as its 64-byte point encoding; the
 * sdk's paylinkInlineCodec test proves that framing round-trips. Here the claimant side is modeled
 * as `Point.fromBuffer(toBuffer())` — the exact reconstruction call the codec's decode path makes.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { Buffer } from "buffer"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { amountBucket, ANALYTICS_CONSENT_COPY, paylinkPh } from "../../src/lib/analytics"

const atomic = (human: string, decimals: number): bigint => {
  const [int, frac = ""] = human.split(".")
  return BigInt(int + frac.padEnd(decimals, "0"))
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("amountBucket", () => {
  it("buckets on ladder boundaries in atomic units (6 decimals)", () => {
    expect(amountBucket(atomic("0", 6), 6)).toBe("<5")
    expect(amountBucket(atomic("4.99", 6), 6)).toBe("<5")
    expect(amountBucket(atomic("5", 6), 6)).toBe("<10")
    expect(amountBucket(atomic("9.999999", 6), 6)).toBe("<10")
    expect(amountBucket(atomic("49.999999", 6), 6)).toBe("<50")
    expect(amountBucket(atomic("99.999999", 6), 6)).toBe("<100")
    expect(amountBucket(atomic("499.99", 6), 6)).toBe("<500")
    expect(amountBucket(atomic("999.99", 6), 6)).toBe("<1k")
    expect(amountBucket(atomic("1000", 6), 6)).toBe(">=1k")
  })

  it("stays exact with 18 decimals beyond Number.MAX_SAFE_INTEGER", () => {
    // 999.999999999999999999 — float math would round this to 1000.
    expect(amountBucket(10n ** 21n - 1n, 18)).toBe("<1k")
    expect(amountBucket(10n ** 21n, 18)).toBe(">=1k")
    expect(amountBucket(atomic("4.999999999999999999", 18), 18)).toBe("<5")
  })
})

const ROLLUP = "0x" + "ab".repeat(20)
const OTHER_ROLLUP = "0x" + "cd".repeat(20)

// paylinkPh treats the secret as opaque 32 bytes, so fixed canonical field bytes suffice.
const KEY = new Fr(0x11)
const OTHER_KEY = new Fr(0x22)

describe("paylinkPh", () => {
  // Distinct secrets are what separates one link from another, flavors included: flavor is an
  // input to the deterministic derivation, so a direct and an email link never share a secret
  // (pinned by the sdk's paylinkKeys test).
  it("differs across secrets", async () => {
    const a = await paylinkPh({ rollupAddress: ROLLUP, secret: KEY })
    const b = await paylinkPh({ rollupAddress: ROLLUP, secret: OTHER_KEY })
    expect(a).not.toBe(b)
  })

  it("separates networks for one secret", async () => {
    const a = await paylinkPh({ rollupAddress: ROLLUP, secret: KEY })
    const b = await paylinkPh({ rollupAddress: OTHER_ROLLUP, secret: KEY })
    expect(a).not.toBe(b)
    // Address parsing canonicalizes case, so a checksummed and a lowercase spelling still join.
    const mixed = await paylinkPh({ rollupAddress: "0x" + "AB".repeat(20), secret: KEY })
    expect(mixed).toBe(a)
  })

  it("is domain-separated from a bare SHA-256 of the same payload bytes", async () => {
    const bytes = new Uint8Array(20 + 32)
    for (let i = 0; i < 20; i++) bytes[i] = parseInt(ROLLUP.slice(2 + 2 * i, 4 + 2 * i), 16)
    bytes.set(KEY.toBuffer(), 20)
    const bare = await crypto.subtle.digest("SHA-256", bytes)
    const bareHex = [...new Uint8Array(bare)].map((b) => b.toString(16).padStart(2, "0")).join("")
    const domained = await paylinkPh({ rollupAddress: ROLLUP, secret: KEY })
    expect(domained).not.toBe(bareHex)
  })

  it("fails closed on malformed inputs", async () => {
    const good = { rollupAddress: ROLLUP, secret: KEY }
    await expect(paylinkPh({ ...good, rollupAddress: "not-an-address" })).rejects.toThrow()
    await expect(paylinkPh({ ...good, rollupAddress: "0x" + "ab".repeat(19) })).rejects.toThrow()
    await expect(
      paylinkPh({ ...good, secret: { toBuffer: () => new Uint8Array(64) } }),
    ).rejects.toThrow()
  })
})

const PAYLOAD = {
  stage: "created",
  flavor: "direct",
  amount_bucket: "<10",
  paylink_ph: "ab".repeat(32),
} as const

describe("firePaylinkEvent", () => {
  it("does not fetch without consent, or without a URL", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    // URL set, consent denied.
    vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
    vi.resetModules()
    let a = await import("../../src/lib/analytics")
    a.bindAnalyticsConsent(() => false)
    a.firePaylinkEvent(PAYLOAD)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Consent granted, URL unset. Stubbed empty rather than unstubbed: a developer's .env.local
    // may supply the URL, which would make this pass locally for the wrong reason.
    vi.stubEnv("VITE_ZKMONEY_API_URL", "")
    vi.resetModules()
    a = await import("../../src/lib/analytics")
    a.bindAnalyticsConsent(() => true)
    a.firePaylinkEvent(PAYLOAD)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("posts EXACTLY the allowlisted keys to /paylink-events", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
    vi.resetModules()
    const a = await import("../../src/lib/analytics")
    a.bindAnalyticsConsent(() => true)

    a.firePaylinkEvent(PAYLOAD)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://api.test/paylink-events")
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(init.body)
    expect(Object.keys(body).sort()).toEqual([
      "amount_bucket",
      "app_version",
      "flavor",
      "paylink_ph",
      "stage",
    ])
    expect(body.stage).toBe("created")
    expect(body.flavor).toBe("direct")
    expect(body.amount_bucket).toBe("<10")
    expect(body.paylink_ph).toMatch(/^[0-9a-f]{64}$/)
  })

  it("sends only the hash — never the secret or rollup address", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
    vi.resetModules()
    const a = await import("../../src/lib/analytics")
    a.bindAnalyticsConsent(() => true)

    const ph = await a.paylinkPh({ rollupAddress: ROLLUP, secret: KEY })
    a.firePaylinkEvent({ stage: "created", flavor: "direct", amount_bucket: "<10", paylink_ph: ph })

    const [, init] = fetchSpy.mock.calls[0]
    const wire = (init.body as string).toLowerCase()
    expect(wire).not.toContain(Buffer.from(KEY.toBuffer()).toString("hex"))
    expect(wire).not.toContain(ROLLUP.slice(2))
    expect(wire).toContain(ph)
  })

  it("never throws or leaves an unhandled rejection", async () => {
    vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.test")
    vi.resetModules()
    const a = await import("../../src/lib/analytics")
    a.bindAnalyticsConsent(() => true)

    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("sync boom")
      }),
    )
    expect(() => a.firePaylinkEvent(PAYLOAD)).not.toThrow()

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("async boom")))
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    expect(() => a.firePaylinkEvent(PAYLOAD)).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    process.off("unhandledRejection", unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe("consent disclosure copy", () => {
  it("discloses ranged amount buckets instead of claiming amounts are never sent", () => {
    expect(ANALYTICS_CONSENT_COPY).toMatch(/range/i)
    expect(ANALYTICS_CONSENT_COPY).toMatch(/exact amounts/i)
    expect(ANALYTICS_CONSENT_COPY).not.toMatch(/never addresses, tags, amounts/i)
  })

  it("names the signup counts as always on, outside the opt-in", () => {
    expect(ANALYTICS_CONSENT_COPY).toMatch(/signup and login steps are always counted/i)
    expect(ANALYTICS_CONSENT_COPY).not.toMatch(/onboarding progress/i)
  })
})

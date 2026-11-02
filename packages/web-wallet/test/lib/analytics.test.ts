import { describe, expect, it, vi } from "vitest"
import {
  baseMetricsId,
  bindAnalyticsConsent,
  failureCode,
  fireEvent,
  lapTimer,
  reportId,
  requestAmountBucket,
  sessionId,
  viewportBucket,
} from "../../src/lib/analytics"
import { resetDemoFlagForTests } from "../../src/dev/demoFlag"
import { sendErrorReport } from "../../src/errors/shareErrorReport"

/** Latches ?demo=<scenario> for the callback, then restores a clean flag. */
async function inDemoMode(run: () => void | Promise<void>): Promise<void> {
  window.history.replaceState({}, "", "/?demo=activity")
  resetDemoFlagForTests()
  try {
    await run()
  } finally {
    window.history.replaceState({}, "", "/")
    sessionStorage.removeItem("webwallet.demo")
    resetDemoFlagForTests()
  }
}

// The base id (zkm_bid) is the only persisted analytics key; both wire ids derive from it one-way.
// The derivation is a public contract — ULT-741 support tooling recomputes it from a voluntarily
// revealed base id — so the pinned vectors below must never drift.
describe("base metrics identifier", () => {
  const KNOWN_BASE = "00000000-0000-0000-0000-000000000000"
  const KNOWN_SID = "9baf9664-2942-43ed-9000-190ff73c517f"
  const KNOWN_RID = "662de243-a6e5-4208-93ab-573d69965563"

  /** Runs with a fixed base id in localStorage, then restores whatever was there. */
  function withBase(base: string, run: () => void): void {
    const prior = localStorage.getItem("zkm_bid")
    localStorage.setItem("zkm_bid", base)
    try {
      run()
    } finally {
      if (prior === null) localStorage.removeItem("zkm_bid")
      else localStorage.setItem("zkm_bid", prior)
    }
  }

  it("derives both wire ids from the base id (pinned vectors)", () => {
    withBase(KNOWN_BASE, () => {
      expect(sessionId()).toBe(KNOWN_SID)
      expect(reportId()).toBe(KNOWN_RID)
    })
  })

  it("baseMetricsId returns the persisted base itself, minting one when absent", () => {
    withBase(KNOWN_BASE, () => expect(baseMetricsId()).toBe(KNOWN_BASE))
    localStorage.removeItem("zkm_bid")
    try {
      const minted = baseMetricsId()
      expect(minted).toBe(localStorage.getItem("zkm_bid"))
      expect(minted).not.toBe(sessionId())
      expect(minted).not.toBe(reportId())
    } finally {
      localStorage.removeItem("zkm_bid")
    }
  })

  it("minting the base deletes the pre-base zkm_sid/zkm_rid keys and rotates the wire ids", () => {
    localStorage.removeItem("zkm_bid")
    localStorage.setItem("zkm_sid", "legacy-sid")
    localStorage.setItem("zkm_rid", "legacy-rid")
    const sid = sessionId()
    expect(localStorage.getItem("zkm_sid")).toBeNull()
    expect(localStorage.getItem("zkm_rid")).toBeNull()
    expect(localStorage.getItem("zkm_bid")).not.toBeNull()
    expect(sid).not.toBe("legacy-sid")
  })

  it("events and reports send only their own derived id", async () => {
    vi.resetModules()
    vi.stubEnv("VITE_ZKMONEY_API_URL", "/svc/usage")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
    localStorage.setItem("zkm_bid", KNOWN_BASE)
    try {
      const analytics = await import("../../src/lib/analytics")
      analytics.bindAnalyticsConsent(() => true)
      analytics.fireEvent("send_submitted", { flow: "send" })
      const { sendErrorReport: freshSendErrorReport } = await import(
        "../../src/errors/shareErrorReport"
      )
      await expect(freshSendErrorReport({ title: "t", message: "m" })).resolves.toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const bodies = fetchSpy.mock.calls.map(
        ([url, init]) => `${String(url)} ${String((init as RequestInit).body)}`,
      )
      for (const body of bodies) expect(body).not.toContain(KNOWN_BASE)
      expect(bodies[0]).toContain(KNOWN_SID)
      expect(bodies[0]).not.toContain(KNOWN_RID)
      expect(bodies[1]).toContain(KNOWN_RID)
      expect(bodies[1]).not.toContain(KNOWN_SID)
    } finally {
      fetchSpy.mockRestore()
      vi.unstubAllEnvs()
      vi.resetModules()
      localStorage.removeItem("zkm_bid")
    }
  })
})

// Private mode / quota exhaustion / disabled storage: the id helpers must degrade to a stable
// in-memory id instead of throwing into the wallet action that fired the event.
describe("storage-hostile environments", () => {
  it("ids stay stable and distinct when localStorage throws on every access", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      bindAnalyticsConsent(() => true)
      expect(() => fireEvent("send_submitted", { flow: "send" })).not.toThrow()
      expect(sessionId()).toBe(sessionId())
      expect(reportId()).toBe(reportId())
      expect(reportId()).not.toBe(sessionId())
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
      bindAnalyticsConsent(() => false)
    }
  })

  it("read-only storage (writes throw) still yields a stable id", () => {
    localStorage.removeItem("zkm_bid")
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      expect(sessionId()).toBe(sessionId())
    } finally {
      setItem.mockRestore()
    }
  })
})

describe("viewportBucket", () => {
  it("maps widths to sm/md/lg", () => {
    const widths: [number, string][] = [
      [375, "sm"],
      [640, "sm"],
      [800, "md"],
      [1080, "md"],
      [1440, "lg"],
    ]
    for (const [width, bucket] of widths) {
      vi.stubGlobal("innerWidth", width)
      expect(viewportBucket()).toBe(bucket)
    }
    vi.unstubAllGlobals()
  })
})

describe("requestAmountBucket", () => {
  it("reports any-amount links as 'any' and buckets the rest", () => {
    expect(requestAmountBucket(0)).toBe("any")
    expect(requestAmountBucket(Number.NaN)).toBe("any")
    expect(requestAmountBucket(3)).toBe("<5")
    expect(requestAmountBucket(2000)).toBe(">=1k")
  })
})

// Demo mode drives UI reviews and recordings off fixture data; none of it may reach PostHog or
// Postgres, even on an origin whose user granted consent.
describe("demo mode", () => {
  it("sendErrorReport stubs a success without posting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    try {
      await inDemoMode(async () => {
        await expect(sendErrorReport({ title: "Demo", message: "fixture error" })).resolves.toBe(
          true,
        )
        expect(fetchSpy).not.toHaveBeenCalled()
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("failureCode", () => {
  // The dangerous shapes: a tag may contain hyphens, and the verification errors carry a bare wire
  // name beside the account address with no @ anywhere. Both must reduce to a label.
  it("labels a hyphenated tag without echoing the tag", () => {
    expect(failureCode(new Error("@alice-bob is already taken"))).toBe("tag_taken")
  })

  it("degrades an unrecognised message to unknown rather than passing it through", () => {
    expect(failureCode(new Error("@alice-bob.zk.money exploded at 0xbeef"))).toBe("unknown")
  })

  it("accepts non-Error throws", () => {
    expect(failureCode("Google sign-in was cancelled")).toBe("signin_cancelled")
  })

  it("maps a backup passkey whose envelope did not open by the error's name", () => {
    const err = new Error("passkey envelope: decrypt")
    err.name = "PasskeyEnvelopeError"
    expect(failureCode(err)).toBe("backup_envelope_failed")
  })

  it("gives a creation the browser mislabelled and left incomplete its own code", () => {
    // Its own bucket, so the Safari cohort is not folded into the provider refusals.
    const err = new Error("This browser didn't return everything the wallet needs from your phone.")
    err.name = "IncompleteCreationError"
    expect(failureCode(err)).toBe("passkey_incomplete_creation")
  })

  it("has no code for a browser that can't run passkeys, whichever way it says so", () => {
    // Android web views and iOS app browsers; their refusal card must not change these codes.
    const unsupported = new DOMException(
      "Error connecting to Web Authentication service",
      "NotSupportedError",
    )
    const closed = new DOMException(
      "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
      "NotAllowedError",
    )
    expect(failureCode(unsupported)).toBe("unknown")
    expect(failureCode(closed)).toBe("unknown")
  })
})

describe("lapTimer", () => {
  it("measures from creation to the first call, then between calls", () => {
    const now = vi.spyOn(performance, "now")
    now.mockReturnValueOnce(1000) // created
    const lap = lapTimer()
    now.mockReturnValueOnce(1250)
    expect(lap()).toBe(250)
    now.mockReturnValueOnce(1400)
    expect(lap()).toBe(150)
    now.mockRestore()
  })
})

// @vitest-environment jsdom
import { APPLE_ICLOUD_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  BrowserPasskeyCeremony,
  type CeremonyTiming,
  type PasskeyAnswerEvidence,
} from "../../src/ceremony/passkeyCeremony.js"
import type { DevicePosture } from "../../src/browser/devicePosture.js"
import * as policyErrors from "../../src/refusals/passkeyErrors.js"
import {
  type PasskeyClassification,
  type PasskeyErrorContext,
  classifyPasskeyError,
  elapsedBucketFor,
  passkeyEnvironmentPropsFor,
  passkeyErrorNameFor,
  passkeyReportEnvFor,
  passkeyRouteFor,
} from "../../src/telemetry/passkeyTelemetry.js"
import {
  PASSKEY_CANCEL_REASONS,
  PASSKEY_CEREMONY_ENUM_PROPS,
  PASSKEY_FAILURE_REASONS,
  PASSKEY_MAJOR_MAX,
  PASSKEY_MAJOR_MIN,
  PASSKEY_REFUSAL_REASONS,
} from "../../src/telemetry/passkeyTelemetryVocabulary.js"
import { type UserAgentSnapshot, parseUserAgent } from "../../src/browser/userAgentInfo.js"

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
}

const env = (snapshot: UserAgentSnapshot, posture: DevicePosture = "laptop") =>
  passkeyEnvironmentPropsFor({ posture, userAgent: parseUserAgent(snapshot) })

const hinted = (userAgent: string, platform: string, platformVersion?: string) => ({
  userAgent,
  userAgentData: { platform, platformVersion },
})

describe("passkeyEnvironmentPropsFor", () => {
  it("reads macOS from Client Hints only", () => {
    expect(env(hinted(UA.chromeMac, "macOS", "15.1.0")).os_major).toBe(15)
    expect(env({ userAgent: UA.chromeMac })).not.toHaveProperty("os_major")
  })

  it("reads Windows 11 and 10 from Client Hints, and nothing from the user agent", () => {
    expect(env(hinted(UA.chromeWindows, "Windows", "13.0.0")).os_major).toBe(11)
    expect(env(hinted(UA.chromeWindows, "Windows", "10.0.0")).os_major).toBe(10)
    expect(env(hinted(UA.chromeWindows, "Windows", "0.3.0"))).not.toHaveProperty("os_major")
    expect(env({ userAgent: UA.chromeWindows })).not.toHaveProperty("os_major")
  })

  it("reads Android from Client Hints, never from the frozen user agent", () => {
    expect(env({ userAgent: UA.chromeAndroid }, "phone")).toEqual({
      device_class: "phone",
      os: "android",
      browser: "chrome",
      browser_major: 140,
    })
    expect(env(hinted(UA.chromeAndroid, "Android", "14.0.0"), "phone").os_major).toBe(14)
  })

  it("never reads a Linux or ChromeOS version", () => {
    expect(env(hinted(UA.chromeLinux, "Linux", "6.8.0"))).not.toHaveProperty("os_major")
    expect(env(hinted(UA.chromeOs, "Chrome OS", "16.0.0"))).not.toHaveProperty("os_major")
  })

  it("omits a major out of range or unparseable, and falls back on an unlisted family", () => {
    const props = passkeyEnvironmentPropsFor({
      posture: "tablet" as DevicePosture,
      userAgent: {
        osFamily: "beos" as "unknown",
        osVersionReported: "1000.1",
        browserFamily: "netscape" as "unknown",
        browserVersionReported: "0.9",
      },
    })
    expect(props).toEqual({ device_class: "laptop", os: "unknown", browser: "unknown" })
    expect(
      passkeyEnvironmentPropsFor({
        posture: "laptop",
        userAgent: {
          osFamily: "ios",
          osVersionReported: "unknown",
          browserFamily: "firefox",
          browserVersionReported: "1000",
        },
      }),
    ).toEqual({ device_class: "laptop", os: "ios", browser: "firefox" })
  })
})

describe("passkeyRouteFor", () => {
  const evidence = (e: PasskeyAnswerEvidence) => e

  it("reads a creation's route from its attachment and transports", () => {
    expect(passkeyRouteFor("create", evidence({ authenticatorAttachment: "platform" }))).toBe(
      "same_device",
    )
    expect(
      passkeyRouteFor(
        "create",
        evidence({ authenticatorAttachment: "cross-platform", transports: ["usb", "nfc"] }),
      ),
    ).toBe("security_key")
    expect(
      passkeyRouteFor(
        "create",
        evidence({
          authenticatorAttachment: "cross-platform",
          transports: ["hybrid", "internal"],
          backupEligible: false,
        }),
      ),
    ).toBe("phone_qr")
  })

  it("reads a creation listing no transports as a security key only on an all-zero attested id", () => {
    const empty = { authenticatorAttachment: "cross-platform" as const, transports: [] }
    expect(passkeyRouteFor("create", { ...empty, aaguid: ZERO_AAGUID })).toBe("security_key")
    expect(passkeyRouteFor("create", { ...empty, aaguid: APPLE_ICLOUD_AAGUID })).toBe("unknown")
    expect(passkeyRouteFor("create", empty)).toBe("unknown")
  })

  it("reads an assertion's route from its attachment and backup flag", () => {
    expect(passkeyRouteFor("assert", evidence({ authenticatorAttachment: "platform" }))).toBe(
      "same_device",
    )
    expect(
      passkeyRouteFor(
        "assert",
        evidence({ authenticatorAttachment: "cross-platform", backupEligible: true }),
      ),
    ).toBe("phone_qr")
    expect(
      passkeyRouteFor(
        "assert",
        evidence({ authenticatorAttachment: "cross-platform", backupEligible: false }),
      ),
    ).toBe("security_key")
  })

  it("is unknown on missing or conflicting evidence, and hybrid is never a security key", () => {
    expect(passkeyRouteFor("create", undefined)).toBe("unknown")
    expect(passkeyRouteFor("assert", undefined)).toBe("unknown")
    expect(passkeyRouteFor("create", { authenticatorAttachment: "cross-platform" })).toBe("unknown")
    expect(
      passkeyRouteFor("create", {
        authenticatorAttachment: "cross-platform",
        transports: ["usb", "hybrid"],
      }),
    ).toBe("phone_qr")
    expect(passkeyRouteFor("assert", { authenticatorAttachment: "cross-platform" })).toBe("unknown")
    expect(
      passkeyRouteFor("assert", {
        authenticatorAttachment: "cross-platform",
        backupEligible: false,
        transports: ["hybrid"],
      }),
    ).toBe("unknown")
    expect(passkeyRouteFor("assert", { backupEligible: true })).toBe("unknown")
  })
})

const timing: CeremonyTiming = {
  handoffWaitMs: 30,
  teardownWaitMs: 5,
  focusWaitMs: 10,
  pendingRetryDelaysMs: [1],
  requestTimeoutMs: 50,
}

/** The errors the browser ceremony itself throws, taken from a real run. */
async function ceremonyErrors() {
  const get = vi.fn()
  const create = vi.fn()
  Object.defineProperty(navigator, "credentials", { value: { get, create }, configurable: true })
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  const ceremony = new BrowserPasskeyCeremony(timing)
  const request = { rpId: "localhost", challenge: new Uint8Array(32) }
  const caught = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    )

  get.mockRejectedValue(new DOMException("A request is already pending.", "NotAllowedError"))
  const wedged = await caught(ceremony.assert(request))

  get.mockReset()
  get.mockImplementationOnce(
    (options: CredentialRequestOptions) =>
      new Promise((_, reject) =>
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason)),
      ),
  )
  get.mockResolvedValueOnce(null)
  const stuck = caught(ceremony.assert(request))
  const noCredential = await caught(ceremony.assert(request))
  const evicted = await stuck

  create.mockResolvedValue({
    id: "cred-1",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      attestationObject: new ArrayBuffer(0),
      getPublicKeyAlgorithm: () => -257,
      getPublicKey: () => null,
      getAuthenticatorData: () => new Uint8Array(37).buffer,
    },
  })
  const notEs256 = await caught(
    ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    }),
  )
  return { wedged, evicted, noCredential, notEs256 }
}

const none: PasskeyErrorContext = { issued: false, answered: false }
const issued: PasskeyErrorContext = { issued: true, answered: false }
const answered: PasskeyErrorContext = { issued: true, answered: true }

describe("classifyPasskeyError", () => {
  let errors: Awaited<ReturnType<typeof ceremonyErrors>>
  beforeAll(async () => {
    errors = await ceremonyErrors()
  })

  it("refuses every policy error with its own reason", () => {
    const expected: Record<string, string> = {
      SecurityKeyRequiredError: "security_key_required",
      PhoneRequiredError: "phone_required",
      LocalPasskeyRequiredError: "local_passkey_required",
      DeviceBoundPasskeyError: "not_synced",
      SecurityKeyNoPrfError: "security_key_no_prf",
      IncompleteCreationError: "incomplete_creation",
      NoPrfError: "no_prf",
      SingleSaltProviderError: "single_salt_provider",
      UnsupportedProviderError: "provider_not_supported",
      NoWalletForPasskeyError: "no_wallet_for_passkey",
      PhoneUnreachableError: "phone_unreachable",
      RotatedCredentialError: "rotated_credential",
      AmbiguousPasskeyError: "ambiguous_passkey",
      RelatedOriginPasskeyError: "related_origin",
      // Built with an unknown kind here; its own kinds are checked below.
      LaptopPasskeyRefusedError: "provider_unnamed",
    }
    // Every refusal class the policy exports, so a new one without a reason fails here. A backup
    // passkey's refusal is reported by the backup events, never through this classifier.
    const refusals = (Object.values(policyErrors) as unknown[]).filter(
      (value) =>
        typeof value === "function" &&
        value.prototype instanceof policyErrors.PasskeyPolicyError &&
        value !== policyErrors.BackupPasskeyRefusedError,
    ) as (new (arg: string) => policyErrors.PasskeyPolicyError)[]
    expect(refusals.map((Refusal) => new Refusal("manager").name).sort()).toEqual(
      Object.keys(expected).sort(),
    )
    for (const Refusal of refusals) {
      const error = new Refusal("manager")
      expect(classifyPasskeyError(error, none)).toEqual({
        outcome: "refused",
        reason: expected[error.name],
      })
    }
  })

  it("reads a laptop refusal's reason from its kind", () => {
    const reasons = {
      "apple": "apple_below_floor",
      "unnamed": "provider_unnamed",
      "not-local": "local_route_mismatch",
    } as const
    for (const [kind, reason] of Object.entries(reasons)) {
      const error = new policyErrors.LaptopPasskeyRefusedError(kind as keyof typeof reasons, [
        "gpm",
      ])
      expect(classifyPasskeyError(error, answered)).toEqual({ outcome: "refused", reason })
    }
    // A kind the vocabulary does not know still counts as a refusal.
    const odd = new policyErrors.LaptopPasskeyRefusedError("apple", ["gpm"])
    Object.assign(odd, { kind: "something-new" })
    expect(classifyPasskeyError(odd, answered)).toEqual({
      outcome: "refused",
      reason: "provider_unnamed",
    })
  })

  it("takes the front's own names and tests", () => {
    class StoredAddressMismatchError extends Error {
      override name = "StoredAddressMismatchError"
    }
    const mismatch: PasskeyClassification = { outcome: "refused", reason: "passkey_mismatch" }
    const context: PasskeyErrorContext = {
      ...answered,
      extraNames: {
        StoredAddressMismatchError: mismatch,
        SessionChangedError: { outcome: "failed", reason: "session_lost" },
      },
      extraPredicates: [
        { test: (e) => (e as Error).message === "wrong credential", classification: mismatch },
      ],
    }
    expect(classifyPasskeyError(new StoredAddressMismatchError("x"), context)).toEqual(mismatch)
    expect(classifyPasskeyError(new Error("wrong credential"), context)).toEqual(mismatch)
    expect(classifyPasskeyError(new StoredAddressMismatchError("x"), answered)).toEqual({
      outcome: "failed",
      reason: "after_prompt",
    })
  })

  it("keeps the policy's names ahead of the front's, and the front's ahead of the browser's", () => {
    const context: PasskeyErrorContext = {
      ...answered,
      extraNames: { NoPrfError: { outcome: "failed", reason: "session_lost" } },
      extraPredicates: [
        {
          test: (e) => (e as Error).name === "NotAllowedError",
          classification: { outcome: "cancelled", reason: "in_app_cancel" },
        },
      ],
    }
    expect(classifyPasskeyError(new policyErrors.NoPrfError(), context)).toEqual({
      outcome: "refused",
      reason: "no_prf",
    })
    expect(classifyPasskeyError(new DOMException("x", "NotAllowedError"), context)).toEqual({
      outcome: "cancelled",
      reason: "in_app_cancel",
    })
  })

  it("skips a front's test that throws, and a classification off the list", () => {
    const context = {
      ...issued,
      extraNames: { TypeError: { outcome: "refused", reason: "prompt_closed" } },
      extraPredicates: [
        {
          test: () => {
            throw new Error("bad test")
          },
          classification: { outcome: "failed", reason: "signer_mismatch" },
        },
        { test: () => true, classification: { outcome: "abandoned", reason: "after_prompt" } },
      ],
    } as unknown as PasskeyErrorContext
    expect(classifyPasskeyError(new TypeError("x"), context)).toEqual({
      outcome: "failed",
      reason: "request_failed",
    })
  })

  it("names the ceremony's own failures ahead of the browser's exception names", () => {
    expect(classifyPasskeyError(errors.wedged, issued)).toEqual({
      outcome: "failed",
      reason: "request_stuck",
    })
    expect(classifyPasskeyError(errors.evicted, issued)).toEqual({
      outcome: "failed",
      reason: "request_stuck",
    })
    expect(classifyPasskeyError(errors.noCredential, issued)).toEqual({
      outcome: "failed",
      reason: "no_credential_returned",
    })
    expect(classifyPasskeyError(errors.notEs256, answered)).toEqual({
      outcome: "failed",
      reason: "unsupported_algorithm",
    })
  })

  it("copies nothing of a message into the classification", () => {
    const serialized = JSON.stringify(classifyPasskeyError(errors.notEs256, answered))
    expect(serialized).not.toMatch(/created|ES256|P-256|contract|unknown provider|-257/)
    expect(Object.keys(classifyPasskeyError(errors.notEs256, answered)!).sort()).toEqual([
      "outcome",
      "reason",
    ])
  })

  it("maps the browser's exception names", () => {
    const cases: [string, PasskeyClassification][] = [
      ["NotAllowedError", { outcome: "cancelled", reason: "prompt_closed" }],
      ["AbortError", { outcome: "cancelled", reason: "prompt_aborted" }],
      ["InvalidStateError", { outcome: "failed", reason: "invalid_state" }],
      ["SecurityError", { outcome: "failed", reason: "security_error" }],
      ["NotSupportedError", { outcome: "failed", reason: "not_supported" }],
      ["ConstraintError", { outcome: "failed", reason: "constraint" }],
    ]
    for (const [name, classification] of cases) {
      expect(classifyPasskeyError(new DOMException("x", name), issued)).toEqual(classification)
    }
  })

  it("falls back on how far the action got", () => {
    const error = new TypeError("Cannot read properties of undefined")
    expect(classifyPasskeyError(error, answered)).toEqual({
      outcome: "failed",
      reason: "after_prompt",
    })
    expect(classifyPasskeyError(error, issued)).toEqual({
      outcome: "failed",
      reason: "request_failed",
    })
    expect(classifyPasskeyError(error, none)).toBeUndefined()
  })

  it("handles thrown values that are not errors", () => {
    const hostile = {
      get name(): never {
        throw new Error("no")
      },
    }
    for (const value of [null, { name: 5 }, hostile]) {
      expect(classifyPasskeyError(value, answered)).toEqual({
        outcome: "failed",
        reason: "after_prompt",
      })
      expect(classifyPasskeyError(value, none)).toBeUndefined()
    }
    expect(classifyPasskeyError({ name: "constructor" }, none)).toBeUndefined()
    expect(classifyPasskeyError({ name: "NotAllowedError" }, none)).toEqual({
      outcome: "cancelled",
      reason: "prompt_closed",
    })
  })
})

describe("passkeyErrorNameFor", () => {
  it("names a thrown object by its listed name, and everything else other", () => {
    expect(passkeyErrorNameFor(new DOMException("some text", "NotAllowedError"))).toBe(
      "NotAllowedError",
    )
    expect(passkeyErrorNameFor(new TypeError("x"))).toBe("TypeError")
    for (const value of [
      { name: "0x1234abcd@alice" },
      { name: 7 },
      "NotAllowedError",
      TypeError,
      null,
    ]) {
      expect(passkeyErrorNameFor(value)).toBe("other")
    }
    expect(
      passkeyErrorNameFor({
        get name() {
          throw new Error("no")
        },
      }),
    ).toBe("other")
  })
})

describe("buckets", () => {
  it("buckets the last request's duration", () => {
    expect(elapsedBucketFor(0)).toBe("under_1s")
    expect(elapsedBucketFor(999)).toBe("under_1s")
    expect(elapsedBucketFor(1_000)).toBe("1_10s")
    expect(elapsedBucketFor(9_999)).toBe("1_10s")
    expect(elapsedBucketFor(10_000)).toBe("10_60s")
    expect(elapsedBucketFor(59_999)).toBe("10_60s")
    expect(elapsedBucketFor(60_000)).toBe("over_60s")
  })
})

describe("report env", () => {
  it("describes the device and the provider", () => {
    const reportEnv = passkeyReportEnvFor({
      posture: "laptop",
      userAgent: parseUserAgent(hinted(UA.chromeMac, "macOS", "15.1.0")),
      provider: "icloud_keychain",
    })
    expect(reportEnv).toEqual({
      device_class: "laptop",
      os: "macos",
      os_major: 15,
      browser: "chrome",
      browser_major: 140,
      provider: "icloud_keychain",
    })
  })

  it("names an unlisted provider unknown", () => {
    expect(
      passkeyReportEnvFor({
        posture: "phone",
        userAgent: parseUserAgent({ userAgent: UA.safariIphone }),
        provider: "lastpass" as "unknown",
      }).provider,
    ).toBe("unknown")
  })

  const UNNAMED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
  const envWith = (provider: string, aaguid?: string) =>
    passkeyReportEnvFor({
      posture: "phone",
      userAgent: parseUserAgent({ userAgent: UA.safariIphone }),
      provider: provider as "other",
      ...(aaguid === undefined ? {} : { aaguid }),
    })

  it("carries the AAGUID of an other provider, lowercased", () => {
    expect(envWith("other", UNNAMED)).toMatchObject({ provider: "other", aaguid: UNNAMED })
    expect(envWith("other", UNNAMED.toUpperCase()).aaguid).toBe(UNNAMED)
  })

  it.each([
    ["an other provider with no AAGUID", "other", undefined],
    ["an other provider whose AAGUID is named", "other", APPLE_ICLOUD_AAGUID],
    ["an other provider whose AAGUID is not UUID-shaped", "other", "0f0f0f0f"],
    ["an unnamed AAGUID under a named provider", "icloud_keychain", UNNAMED],
  ])("carries no AAGUID for %s", (_case, provider, aaguid) => {
    expect(envWith(provider, aaguid)).not.toHaveProperty("aaguid")
  })
})

describe("every mapped value is in the vocabulary", () => {
  const listed = (key: keyof typeof PASSKEY_CEREMONY_ENUM_PROPS, value: unknown) =>
    expect(PASSKEY_CEREMONY_ENUM_PROPS[key] as readonly unknown[]).toContain(value)
  const major = (value: unknown) => {
    if (value === undefined) return
    expect(Number.isInteger(value)).toBe(true)
    expect(value as number).toBeGreaterThanOrEqual(PASSKEY_MAJOR_MIN)
    expect(value as number).toBeLessThanOrEqual(PASSKEY_MAJOR_MAX)
  }

  it("keeps every major in range", () => {
    const snapshots: UserAgentSnapshot[] = [
      ...Object.values(UA).map((userAgent) => ({ userAgent })),
      hinted(UA.chromeMac, "macOS", "15.1.0"),
      hinted(UA.chromeWindows, "Windows", "12.0.0"),
      hinted(UA.chromeWindows, "Windows", "99999.0.0"),
      { userAgent: "curl/8.4.0" },
      { userAgent: "" },
    ]
    for (const snapshot of snapshots) {
      for (const posture of ["phone", "laptop"] as const) {
        const props = passkeyEnvironmentPropsFor({ posture, userAgent: parseUserAgent(snapshot) })
        major(props.os_major)
        major(props.browser_major)
      }
    }
  })

  it("classification", () => {
    const reasons: Record<string, readonly string[]> = {
      cancelled: PASSKEY_CANCEL_REASONS,
      refused: PASSKEY_REFUSAL_REASONS,
      failed: PASSKEY_FAILURE_REASONS,
    }
    const names = [
      ...Object.keys(policyErrors),
      "NotAllowedError",
      "AbortError",
      "InvalidStateError",
      "SecurityError",
      "NotSupportedError",
      "ConstraintError",
      "UnknownError",
      "TypeError",
      "toString",
    ]
    for (const name of names) {
      for (const context of [none, issued, answered]) {
        const result = classifyPasskeyError({ name }, context)
        if (!result) continue
        listed("outcome", result.outcome)
        expect(reasons[result.outcome]).toContain(result.reason)
      }
    }
  })
})

describe("the vocabulary file", () => {
  it("imports nothing, so the API can read it by path", () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/telemetry/passkeyTelemetryVocabulary.ts",
      ),
      "utf8",
    )
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/\bfrom\s+["']/)
    expect(source).not.toMatch(/\brequire\s*\(|\bimport\s*\(/)
  })
})

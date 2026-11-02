/** Refusal rows per policy error, and the functions that pick copy for a device. */
import { describe, expect, it } from "vitest"
import * as errors from "../../src/refusals/passkeyErrors.js"
import {
  PHONE_STEPS_COPY,
  REFUSAL_FALLBACK,
  REFUSAL_ROWS,
  macUpdateAdviceFor,
  refusalFor,
  stepsCopyFor,
} from "../../src/refusals/refusalCopy.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"

describe("refusalFor", () => {
  it("has a row for every policy error name and nothing else", () => {
    const names = [
      new errors.PhoneRequiredError(),
      new errors.LocalPasskeyRequiredError(),
      new errors.DeviceBoundPasskeyError(),
      new errors.IncompleteCreationError(),
      new errors.NoPrfError(),
      new errors.SingleSaltProviderError(),
      new errors.NoWalletForPasskeyError(),
      new errors.PhoneUnreachableError(),
      new errors.RotatedCredentialError(),
      new errors.AmbiguousPasskeyError(),
      new errors.UnsupportedProviderError("manager"),
      new errors.LaptopPasskeyRefusedError("apple"),
      new errors.SecurityKeyNoPrfError(),
      new errors.SecurityKeyRequiredError(),
      new errors.RelatedOriginPasskeyError(),
    ].map((err) => err.name)
    expect(Object.keys(REFUSAL_ROWS).sort()).toEqual(names.sort())
  })

  it("takes a consumer's rows for its own errors and lets them override shared ones", () => {
    const mismatch = { title: "This passkey opens a different account", retry: true }
    const noAccount = {
      title: "No campaign account for this passkey",
      retry: true,
      message: "Create an account first.",
    }
    const extra = { PasskeyMismatchError: mismatch, NoWalletForPasskeyError: noAccount }
    expect(refusalFor({ name: "PasskeyMismatchError" }, extra)).toBe(mismatch)
    expect(refusalFor(new errors.NoWalletForPasskeyError(), extra)).toBe(noAccount)
    expect(refusalFor(new errors.PhoneRequiredError(), extra)).toBe(REFUSAL_ROWS.PhoneRequiredError)
    expect(refusalFor({ name: "PasskeyMismatchError" })).toBe(REFUSAL_FALLBACK)
  })
})

describe("copy selection", () => {
  it("picks the steps from what the browser said about reaching a phone", () => {
    expect(stepsCopyFor("no-hybrid")).toBe(PHONE_STEPS_COPY.noPhone)
    for (const reach of ["ok", "unknown", "below-floor"] as const) {
      expect(stepsCopyFor(reach)).toBe(PHONE_STEPS_COPY)
    }
  })
})

describe("macUpdateAdviceFor", () => {
  const hinted = (platform: string, platformVersion: string) =>
    parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform, platformVersion },
    })

  it("words the line by what the browser reports, and gives none past the floors", () => {
    const safari = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
        "Version/26.4 Safari/605.1.15",
    })
    expect(macUpdateAdviceFor(safari)).toBe("unknown")
    expect(macUpdateAdviceFor(hinted("macOS", "26.2.0"))).toBe("below")
    expect(macUpdateAdviceFor(hinted("macOS", "14.6"))).toBe("below")
    expect(macUpdateAdviceFor(hinted("macOS", "26.4.1"))).toBeUndefined()
    expect(macUpdateAdviceFor(hinted("macOS", "15.7.5"))).toBeUndefined()
    const windows = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Safari/537.36",
    })
    expect(macUpdateAdviceFor(windows)).toBeUndefined()
  })
})

describe("the phone refusal's wording", () => {
  it("gives an unnamed sign-up its own advice, and a named provider the same on either ceremony", () => {
    expect(new errors.PhoneRequiredError({ ceremony: "create" }).message).not.toBe(
      new errors.PhoneRequiredError().message,
    )
    expect(
      new errors.PhoneRequiredError({ ceremony: "create", providerName: "Bitwarden" }).message,
    ).toBe(new errors.PhoneRequiredError({ providerName: "Bitwarden" }).message)
  })
})

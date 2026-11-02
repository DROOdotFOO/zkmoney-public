// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import {
  BrowserPasskeyCeremony,
  DEFAULT_CEREMONY_TIMING,
} from "../../src/ceremony/passkeyCeremony.js"
import {
  DeviceBoundPasskeyError,
  IncompleteCreationError,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PhoneRequiredError,
  RelatedOriginPasskeyError,
  SingleSaltProviderError,
  UnsupportedProviderError,
  isExtensionPasskeyError,
  markPasskeyWritten,
  passkeyWritten,
} from "../../src/refusals/passkeyErrors.js"
import { bitwardenLineFor } from "../../src/refusals/refusalCopy.js"
import { WINDOWS_HELLO, localManagersClause } from "../../src/rules/passkeyProviders.js"
import { MACOS_APPLE_PRF_FLOOR } from "../../src/browser/userAgentInfo.js"

const BITWARDEN_FRAME =
  "CredentialsContainer.<anonymous> (chrome-extension://nngceckbapebfimnlniiiahkandclblb/content/fido2-page-script.js:1259:27)"
const PAGE_FRAME = "select (https://launch.zk.money/app.js:1:1)"

const thrownAt = (error: Error, frame: string) => {
  error.stack = `${error.name}: ${error.message}\n    at ${frame}`
  return error
}

describe("the laptop's own route refusals", () => {
  const managers = ["apple", "gpm"] as const

  it("names the macOS floor only where Apple Passwords was refused on this computer", () => {
    const apple = new LaptopPasskeyRefusedError("apple", ["gpm", "1password"])
    expect(apple.message).toContain(MACOS_APPLE_PRF_FLOOR)
    expect(apple.message).not.toMatch(/15\.7\.5|26\.4\.1/)
    expect(apple.appleRefusedHere).toBe(true)
    expect(apple.message).toContain(localManagersClause(["gpm", "1password"]))
    const withdrawn = new LaptopPasskeyRefusedError("apple", ["gpm"], { appleWithdrawn: true })
    expect(withdrawn.message).not.toContain(MACOS_APPLE_PRF_FLOOR)
    expect(withdrawn.appleRefusedHere).toBe(false)
    expect(new LaptopPasskeyRefusedError("unnamed", ["gpm"]).appleRefusedHere).toBe(false)
  })

  it("words an unnamed answer apart from an off-route one", () => {
    const unnamed = new LaptopPasskeyRefusedError("unnamed", managers)
    expect(new LaptopPasskeyRefusedError("not-local", managers).message).not.toBe(unnamed.message)
  })

  it("gives the existing refusals a local-route message built from the managers", () => {
    const local = { localManagers: managers }
    const localRoute = new UnsupportedProviderError("manager", {
      providerName: WINDOWS_HELLO,
      ...local,
    })
    expect(localRoute.message).toContain(localManagersClause(managers))
    const phoneRoute = new UnsupportedProviderError("manager", { providerName: WINDOWS_HELLO })
    expect(phoneRoute.message).not.toContain(localManagersClause(managers))
    for (const Refusal of [DeviceBoundPasskeyError, NoPrfError, SingleSaltProviderError]) {
      expect(new Refusal(local).message).toContain(localManagersClause(managers))
      expect(new Refusal().message).not.toContain("use your phone instead")
    }
    expect(new PhoneRequiredError(local).message).toContain(localManagersClause(managers))
  })

  it("words each incomplete creation by its kind", () => {
    expect(new IncompleteCreationError().kind).toBe("mislabelled")
    expect(new IncompleteCreationError("other-credential").message).not.toContain("Safari")
    const unverified = new IncompleteCreationError("unverified")
    expect(unverified.message).not.toMatch(/Safari|Chrome|Firefox/)
    expect(unverified.message).not.toMatch(/try again/i)
  })
})

describe("the line a refusal adds after its message", () => {
  const advice = bitwardenLineFor("wallet.test.zk.money")

  it("follows the phone refusal", () => {
    const options = { ceremony: "create" as const }
    expect(new PhoneRequiredError({ ...options, advice }).message).toBe(
      [new PhoneRequiredError(options).message, advice].join(" "),
    )
  })

  it("follows the unsupported-provider refusal", () => {
    const bitwarden = { providerName: "Bitwarden", keyOfferable: true }
    expect(new UnsupportedProviderError("manager", { ...bitwarden, advice }).message).toBe(
      [new UnsupportedProviderError("manager", bitwarden).message, advice].join(" "),
    )
  })

  it("offers a security key only where the sheet can offer one", () => {
    expect(new UnsupportedProviderError("manager", { providerName: "Bitwarden" }).message).not.toBe(
      new UnsupportedProviderError("manager", { providerName: "Bitwarden", keyOfferable: true })
        .message,
    )
  })
})

describe("isExtensionPasskeyError", () => {
  it.each([
    ["Something went wrong.", BITWARDEN_FRAME],
    ["Unexpected failure", "get@moz-extension://0b6d2f3c/content/fido2-page-script.js:12:3"],
    ["", "get@safari-web-extension://0B6D2F3C/content/fido2-page-script.js:12:3"],
  ])("matches a plain Error %j thrown by an extension script", (message, frame) => {
    expect(isExtensionPasskeyError(thrownAt(new Error(message), frame))).toBe(true)
  })

  it.each([
    ["a page error", thrownAt(new Error("x"), PAGE_FRAME)],
    ["a page error naming an extension", thrownAt(new Error("chrome-extension://x"), PAGE_FRAME)],
    ["a DOMException", thrownAt(new DOMException("x", "NotAllowedError"), BITWARDEN_FRAME)],
    ["a policy refusal", thrownAt(new RelatedOriginPasskeyError(), BITWARDEN_FRAME)],
    ["a value with no stack", { name: "Error", message: "x" }],
  ])("rejects %s", (_, error) => {
    expect(isExtensionPasskeyError(error)).toBe(false)
  })

  it("sees the extension's error unchanged after the ceremony rejects", async () => {
    const thrown = thrownAt(new Error("Something went wrong."), BITWARDEN_FRAME)
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { get: vi.fn().mockRejectedValue(thrown) },
    })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const ceremony = new BrowserPasskeyCeremony(DEFAULT_CEREMONY_TIMING)
    const error = await ceremony
      .assert({ rpId: "localhost", challenge: new Uint8Array(32) })
      .catch((e) => e)
    expect(error).toBe(thrown)
  })
})

describe("the written mark", () => {
  it("marks an error and gives it back, and reads it on the error or its cause", () => {
    const refusal = new RelatedOriginPasskeyError()
    expect(markPasskeyWritten(refusal)).toBe(refusal)
    expect(passkeyWritten(refusal)).toBe(true)
    expect(passkeyWritten(new Error("wrapped", { cause: refusal }))).toBe(true)
    const browser = new DOMException("Dismissed", "NotAllowedError")
    expect(passkeyWritten(markPasskeyWritten(browser))).toBe(true)
  })

  it("marks nothing by default, and never a value that is not an object", () => {
    expect(passkeyWritten(new RelatedOriginPasskeyError())).toBe(false)
    expect(passkeyWritten(new Error("plain", { cause: new Error("plain too") }))).toBe(false)
    expect(passkeyWritten(undefined)).toBe(false)
    expect(passkeyWritten("NotAllowedError")).toBe(false)
    expect(markPasskeyWritten("x")).toBe("x")
  })
})

import { describe, expect, it } from "vitest"
import { type CreationContext, UNKNOWN_PROVENANCE } from "../../src/ceremony/userHandle.js"
import {
  type CreationProvenanceInput,
  creationProvenanceFor,
  handleOsVersionFor,
  madeOnFor,
} from "../../src/rules/provenance.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"

const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const SAFARI_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
const CHROME_WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CHROME_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const SAFARI_IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36"

const hinted = (
  userAgent: string,
  platform: string,
  platformVersion: string,
  architecture: string,
) =>
  parseUserAgent({
    userAgent,
    userAgentData: { platform, platformVersion, architecture, brands: [] },
  })

const MAC_CHROME = hinted(CHROME_MAC_UA, "macOS", "26.4.1", "arm")
const WINDOWS_CHROME = hinted(CHROME_WINDOWS_UA, "Windows", "15.0.0", "x86")
const LINUX_CHROME = hinted(CHROME_LINUX_UA, "Linux", "6.1.0", "x86")
const ANDROID_CHROME = hinted(CHROME_ANDROID_UA, "Android", "15.0.0", "arm")
const MAC_SAFARI = parseUserAgent({ userAgent: SAFARI_MAC_UA })
const IPHONE_SAFARI = parseUserAgent({ userAgent: SAFARI_IPHONE_UA })

const laptop = (over: Partial<CreationProvenanceInput>): CreationProvenanceInput => ({
  posture: "laptop",
  requested: "cross-platform",
  ...over,
})

const NO_CLAIMS = { osVersion: {}, chip: "unknown" } as const

describe("creationProvenanceFor", () => {
  it("writes a phone's own request with its OS, and its version and chip only from hints", () => {
    expect(creationProvenanceFor({ posture: "phone", userAgent: IPHONE_SAFARI })).toEqual({
      context: "ios_browser",
      ...NO_CLAIMS,
    })
    expect(creationProvenanceFor({ posture: "phone", userAgent: ANDROID_CHROME })).toEqual({
      context: "android_browser",
      osVersion: { major: 15, minor: 0, patch: 0 },
      chip: "arm",
    })
    expect(creationProvenanceFor({ posture: "phone" })).toEqual({
      context: "phone_other",
      ...NO_CLAIMS,
    })
    // Only arm and x86 are chips the handle can carry.
    const arm64 = hinted(CHROME_ANDROID_UA, "Android", "15.0.0", "arm64")
    expect(creationProvenanceFor({ posture: "phone", userAgent: arm64 }).chip).toBe("unknown")
  })

  it.each<[string, Partial<CreationProvenanceInput>, CreationContext]>([
    ["the default steer", { userAgent: MAC_CHROME }, "mac_qr"],
    ["a phone steer", { userAgent: MAC_CHROME, laptopHints: ["hybrid"] }, "mac_qr"],
    ["an empty steer", { userAgent: MAC_CHROME, laptopHints: [] }, "mac_qr"],
    ["a key steer", { userAgent: MAC_CHROME, laptopHints: ["security-key"] }, "mac_key"],
    ["a Windows page", { userAgent: WINDOWS_CHROME }, "windows_qr"],
    [
      "a Windows key steer",
      { userAgent: WINDOWS_CHROME, laptopHints: ["security-key"] },
      "windows_key",
    ],
    ["a Linux page", { userAgent: LINUX_CHROME }, "laptop_other_qr"],
    ["no user agent", {}, "laptop_other_qr"],
  ])("writes a laptop asking for another device as the route only: %s", (_case, over, context) => {
    expect(creationProvenanceFor(laptop(over))).toEqual({ context, ...NO_CLAIMS })
  })

  it("writes a laptop asking for its own class as the local route, with its claims", () => {
    expect(creationProvenanceFor(laptop({ userAgent: MAC_CHROME, requested: "platform" }))).toEqual(
      {
        context: "mac_local",
        osVersion: { major: 26, minor: 4, patch: 1 },
        chip: "arm",
      },
    )
    // The steer does not matter once the class is this device, suppressed or not.
    for (const laptopHints of [undefined, null, ["client-device"] as const]) {
      expect(
        creationProvenanceFor(
          laptop({ userAgent: WINDOWS_CHROME, requested: "platform", laptopHints }),
        ),
      ).toEqual({
        context: "windows_local",
        osVersion: { major: 15, minor: 0, patch: 0 },
        chip: "x86",
      })
    }
    expect(creationProvenanceFor(laptop({ userAgent: MAC_SAFARI, requested: "platform" }))).toEqual(
      {
        context: "mac_local",
        ...NO_CLAIMS,
      },
    )
  })

  it("writes nothing for a laptop whose steer was suppressed", () => {
    expect(creationProvenanceFor(laptop({ userAgent: MAC_CHROME, laptopHints: null }))).toEqual(
      UNKNOWN_PROVENANCE,
    )
  })
})

describe("handleOsVersionFor", () => {
  it.each([
    ["26.4.1", { major: 26, minor: 4, patch: 1 }],
    ["15.0.0", { major: 15, minor: 0, patch: 0 }],
    ["26.4", { major: 26, minor: 4 }],
    ["10", { major: 10 }],
    ["unknown", {}],
    ["", {}],
    ["300.1.1", {}],
    ["26.4.1-beta", {}],
    ["26.4.1.2", {}],
  ])("reads %j as %j", (reported, expected) => {
    expect(handleOsVersionFor(reported)).toEqual(expected)
  })
})

describe("madeOnFor", () => {
  it("names the context, and unknown where a handle carries none", () => {
    expect(madeOnFor(undefined)).toBe("unknown")
    expect(madeOnFor({ context: "windows_qr", osVersion: {}, chip: "unknown" })).toBe("windows_qr")
  })
})

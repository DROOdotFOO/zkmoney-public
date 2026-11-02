// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  currentMisreportsCrossDevice,
  currentPhoneReach,
  currentPlatformAuthenticator,
  currentTrustsAttachmentLabel,
  macCopyMayBeWrong,
  mayStartLaptopCeremony,
  safariMislabelsCrossDevice,
  probePhoneReach,
  trustsAttachmentLabel,
} from "../../src/browser/passkeyCapabilities.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"

describe("macCopyMayBeWrong", () => {
  const mac = { posture: "laptop" as const, osFamily: "macos" as const, labelTrusted: true }

  it("holds on a Mac laptop for this computer's answer, or one with no class", () => {
    expect(macCopyMayBeWrong({ attachment: "platform" }, mac)).toBe(true)
    expect(macCopyMayBeWrong(undefined, mac)).toBe(true)
  })

  it("never off a Mac laptop", () => {
    expect(macCopyMayBeWrong({ attachment: "platform" }, { ...mac, osFamily: "windows" })).toBe(
      false,
    )
    expect(macCopyMayBeWrong({ attachment: "platform" }, { ...mac, posture: "phone" })).toBe(false)
  })

  it("another device's answer rules it out only where the label is trusted", () => {
    expect(macCopyMayBeWrong({ attachment: "cross-platform" }, mac)).toBe(false)
    expect(
      macCopyMayBeWrong({ attachment: "cross-platform" }, { ...mac, labelTrusted: false }),
    ).toBe(true)
  })

  it("a record from another manager rules it out; Apple, zero or no id does not", () => {
    const answer = (recordAaguid: string) => ({ attachment: "platform" as const, recordAaguid })
    expect(macCopyMayBeWrong(answer(GPM_AAGUID), mac)).toBe(false)
    expect(macCopyMayBeWrong(answer(APPLE_ICLOUD_AAGUID.toUpperCase()), mac)).toBe(true)
    expect(macCopyMayBeWrong(answer(ZERO_AAGUID), mac)).toBe(true)
  })
})

const chromeMac = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
})
const safari = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`,
  })
const firefoxMac = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })

describe("probePhoneReach", () => {
  it("proceeds when hybrid transport is reported or unknown", () => {
    expect(
      probePhoneReach({
        posture: "laptop",
        userAgent: chromeMac,
        capabilities: { hybridTransport: true },
      }),
    ).toBe("ok")
    expect(probePhoneReach({ posture: "laptop", userAgent: chromeMac, capabilities: {} })).toBe(
      "unknown",
    )
  })

  it("applies the desktop floors", () => {
    for (const version of ["25.9"]) {
      expect(probePhoneReach({ posture: "laptop", userAgent: safari(version) })).toBe("below-floor")
    }
    for (const version of ["26"]) {
      expect(probePhoneReach({ posture: "laptop", userAgent: safari(version) })).toBe("unknown")
    }
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("138.0") })).toBe(
      "below-floor",
    )
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("139.0") })).toBe("unknown")
  })

  it("keeps the floors above whatever the browser says about hybrid", () => {
    for (const hybridTransport of [false, true]) {
      expect(
        probePhoneReach({
          posture: "laptop",
          userAgent: safari("18.6"),
          capabilities: { hybridTransport },
        }),
      ).toBe("below-floor")
    }
  })

  it("never probes a phone", () => {
    expect(
      probePhoneReach({
        posture: "phone",
        userAgent: safari("17.6"),
        capabilities: { hybridTransport: false },
      }),
    ).toBe("ok")
  })
})

describe("mayStartLaptopCeremony", () => {
  it("refuses only a browser below the floor; no phone route is not no authenticator", () => {
    expect(mayStartLaptopCeremony("below-floor")).toBe(false)
    for (const reach of ["ok", "unknown", "no-hybrid"] as const) {
      expect(mayStartLaptopCeremony(reach)).toBe(true)
    }
  })
})

describe("currentPhoneReach", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the static through a cast and treats a missing or failing API as unknown", async () => {
    vi.stubGlobal("navigator", { userAgent: chromeMacUa() })
    vi.stubGlobal("PublicKeyCredential", {})
    expect(await currentPhoneReach("laptop")).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: () => Promise.reject(new Error("x")),
    })
    expect(await currentPhoneReach("laptop")).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: () => Promise.resolve({ hybridTransport: false }),
    })
    expect(await currentPhoneReach("laptop")).toBe("no-hybrid")
    expect(await currentPhoneReach("phone")).toBe("ok")
  })
})

describe("currentPlatformAuthenticator", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the static through a cast, and is unknown when it is missing, odd or failing", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined)
    expect(await currentPlatformAuthenticator()).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {})
    expect(await currentPlatformAuthenticator()).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      get isUserVerifyingPlatformAuthenticatorAvailable() {
        throw new Error("blocked")
      },
    })
    expect(await currentPlatformAuthenticator()).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error("x")),
    })
    expect(await currentPlatformAuthenticator()).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve("yes"),
    })
    expect(await currentPlatformAuthenticator()).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    })
    expect(await currentPlatformAuthenticator()).toBe("yes")
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
    })
    expect(await currentPlatformAuthenticator()).toBe("no")
  })
})

function chromeMacUa() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
}

const safariMacUa = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`

describe("safariMislabelsCrossDevice", () => {
  it("is the macOS Safari window from 18.6 up to 26", () => {
    for (const version of ["18.6", "25.0"]) {
      expect(safariMislabelsCrossDevice(safari(version))).toBe(true)
    }
    for (const version of ["18.5", "26"]) {
      expect(safariMislabelsCrossDevice(safari(version))).toBe(false)
    }
  })

  it("is never another browser or a phone", () => {
    expect(safariMislabelsCrossDevice(chromeMac)).toBe(false)
    const iphone = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    })
    expect(safariMislabelsCrossDevice(iphone)).toBe(false)
  })
})

describe("currentMisreportsCrossDevice", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the live user agent, and is false without one", () => {
    vi.stubGlobal("navigator", { userAgent: safariMacUa("18.6") })
    expect(currentMisreportsCrossDevice()).toBe(true)
    vi.stubGlobal("navigator", { userAgent: chromeMacUa() })
    expect(currentMisreportsCrossDevice()).toBe(false)
    vi.stubGlobal("navigator", undefined)
    expect(currentMisreportsCrossDevice()).toBe(false)
  })
})

describe("trustsAttachmentLabel", () => {
  const ua = (userAgent: string) => parseUserAgent({ userAgent })

  it("trusts the browsers that label the answering device correctly", () => {
    expect(trustsAttachmentLabel(chromeMac)).toBe(true)
    expect(
      trustsAttachmentLabel(
        ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"),
      ),
    ).toBe(true)
    expect(trustsAttachmentLabel(safari("26.4"))).toBe(true)
  })

  it("does not trust a Safari below 26.4, whether it mislabels or was never observed", () => {
    for (const version of ["18.6", "26.3"]) {
      expect(trustsAttachmentLabel(safari(version))).toBe(false)
    }
  })

  it("does not trust a browser it cannot identify", () => {
    // A Mac Safari string without Version/ parses as an unknown browser, not as Safari.
    const noVersion = ua(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15",
    )
    expect(trustsAttachmentLabel(noVersion)).toBe(false)
  })

  it("does not trust a Chromium browser nobody has measured", () => {
    // Samsung Internet in DeX or desktop mode counts as a laptop.
    const samsungDesktop = ua(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36",
    )
    expect(trustsAttachmentLabel(samsungDesktop)).toBe(false)
  })

  it("does not trust a browser built on Apple's passkey stack apart from a measured Safari", () => {
    // Firefox on a Mac makes passkeys through Apple's framework; every iOS browser is WebKit.
    expect(trustsAttachmentLabel(firefoxMac("139.0"))).toBe(false)
    const iPadChrome = ua(
      "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
    )
    expect(trustsAttachmentLabel(iPadChrome)).toBe(false)
  })
})

describe("currentTrustsAttachmentLabel", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the live user agent, and is false without one", () => {
    vi.stubGlobal("navigator", { userAgent: chromeMacUa() })
    expect(currentTrustsAttachmentLabel()).toBe(true)
    vi.stubGlobal("navigator", undefined)
    expect(currentTrustsAttachmentLabel()).toBe(false)
  })
})

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  MACOS_APPLE_PRF_FLOOR,
  MACOS_SYNCED_COPY_FLOORS,
  atLeast,
  currentUserAgentInfo,
  currentUserAgentInfoSoon,
  iosBelowFloor,
  macosGivesApplePrf,
  macosSyncedCopyReadsRight,
  parseUserAgent,
  versionBelow,
  windowsReleaseFromHints,
} from "../../src/browser/userAgentInfo.js"

const cases: [string, string, ReturnType<typeof parseUserAgent>][] = [
  [
    "Safari on macOS reports the frozen 10.15.7",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    {
      osFamily: "macos",
      osVersionReported: "10.15.7",
      browserFamily: "safari",
      browserVersionReported: "26.0",
    },
  ],
  [
    "Safari 26 on iOS reports 18.6",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "18.6",
      browserFamily: "safari",
      browserVersionReported: "26.0",
    },
  ],
  [
    "Firefox on macOS",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0",
    {
      osFamily: "macos",
      osVersionReported: "10.15",
      browserFamily: "firefox",
      browserVersionReported: "139.0",
    },
  ],
  [
    "Chrome on Android",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
    {
      osFamily: "android",
      osVersionReported: "14",
      browserFamily: "chrome",
      browserVersionReported: "126.0.6478.71",
    },
  ],
  [
    "Chrome on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "17.5",
      browserFamily: "chrome",
      browserVersionReported: "126.0.6478.54",
    },
  ],
  [
    "Firefox on iOS reports the frozen 18.7",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
    {
      osFamily: "ios",
      osVersionReported: "18.7",
      browserFamily: "firefox",
      browserVersionReported: "127.0",
    },
  ],
  [
    "Edge on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.2592.56 Version/18.0 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "edge",
      browserVersionReported: "126.0.2592.56",
    },
  ],
  [
    "Edge on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.56",
    {
      osFamily: "windows",
      osVersionReported: "10.0",
      browserFamily: "edge",
      browserVersionReported: "126.0.2592.56",
    },
  ],
  [
    "Firefox on Linux",
    "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    {
      osFamily: "linux",
      osVersionReported: "unknown",
      browserFamily: "firefox",
      browserVersionReported: "138.0",
    },
  ],
  [
    "nothing recognisable",
    "curl/8.4.0",
    {
      osFamily: "unknown",
      osVersionReported: "unknown",
      browserFamily: "unknown",
      browserVersionReported: "unknown",
    },
  ],
]

describe("parseUserAgent", () => {
  for (const [name, userAgent, expected] of cases) {
    it(name, () => {
      expect(parseUserAgent({ userAgent })).toEqual(expected)
    })
  }

  it("prefers Client Hints for the platform version and the brand for the browser", () => {
    expect(
      parseUserAgent({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        userAgentData: {
          platform: "macOS",
          platformVersion: "14.5.0",
          brands: [
            { brand: "Not/A)Brand", version: "8" },
            { brand: "Chromium", version: "126" },
            { brand: "Google Chrome", version: "126" },
          ],
        },
      }),
    ).toEqual({
      osFamily: "macos",
      osVersionReported: "14.5.0",
      osVersionFromHints: true,
      platformFromHints: true,
      browserFamily: "chrome",
      browserVersionReported: "126",
      browserFromHints: true,
    })
  })

  it("says the browser's name came from a Client Hints brand only when it did", () => {
    const chromiumUa =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    // A Chromium with no brand of its own is Chrome only by its user-agent token.
    const unnamed = parseUserAgent({
      userAgent: chromiumUa,
      userAgentData: { brands: [{ brand: "Chromium", version: "140" }] },
    })
    expect(unnamed.browserFamily).toBe("chrome")
    expect(unnamed.browserFromHints).toBeUndefined()
    // A brand that only contains Chrome's name is not Chrome's.
    for (const brand of ["Not Google Chrome", "Google Chrome Helper"]) {
      const near = parseUserAgent({
        userAgent: chromiumUa,
        userAgentData: { brands: [{ brand, version: "140" }] },
      })
      expect(near.browserFamily).toBe("chrome")
      expect(near.browserFromHints).toBeUndefined()
    }
  })

  it("keeps an iPhone's own version over a hinted one", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
    const info = parseUserAgent({ userAgent: iphone, userAgentData: { platformVersion: "18.6.0" } })
    expect(info.osVersionReported).toBe("18.6")
    expect(info.osVersionFromHints).toBeUndefined()
  })
})

describe("parseUserAgent brands", () => {
  const chromiumUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  const brave = { brand: "Brave", version: "140" }
  const chromium = { brand: "Chromium", version: "140" }
  const filler = { brand: "Not-A.Brand", version: "24" }

  it("reads Brave from its brand, in any order and ahead of Chrome's, with its Chromium version", () => {
    const googleChrome = { brand: "Google Chrome", version: "140" }
    for (const brands of [
      [chromium, brave, filler],
      [brave, filler, chromium],
      [googleChrome, brave],
    ]) {
      expect(parseUserAgent({ userAgent: chromiumUa, userAgentData: { brands } })).toMatchObject({
        browserFamily: "brave",
        browserVersionReported: "140",
      })
    }
  })
})

describe("parseUserAgent with empty Client Hints", () => {
  it("treats an empty platformVersion as no version", () => {
    const info = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
      userAgentData: { platform: "Linux", platformVersion: "" },
    })
    expect(info.osFamily).toBe("linux")
    expect(info.osVersionReported).toBe("unknown")
    // The platform's name is all Linux hints carry.
    expect(info.osVersionFromHints).toBeUndefined()
    expect(info.platformFromHints).toBe(true)
  })
})

describe("versionBelow", () => {
  it("compares dotted versions numerically", () => {
    expect(versionBelow("18.3", "18.4")).toBe(true)
    expect(versionBelow("18.3.1", "18.4")).toBe(true)
    expect(versionBelow("18.4", "18.4")).toBe(false)
    expect(versionBelow("18.6", "18.4")).toBe(false)
    expect(versionBelow("18", "18.4")).toBe(true)
  })

  it("never calls an unknown or malformed version below the floor", () => {
    expect(versionBelow("unknown", "18.4")).toBe(false)
    expect(versionBelow("abc", "18.4")).toBe(false)
  })
})

describe("parseUserAgent architecture", () => {
  const chromeMac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

  it("carries the Client Hints architecture as a claim, and nothing without it", () => {
    expect(
      parseUserAgent({
        userAgent: chromeMac,
        userAgentData: { platform: "macOS", platformVersion: "26.4.1", architecture: "arm" },
      }).architectureReported,
    ).toBe("arm")
    expect(
      parseUserAgent({ userAgent: chromeMac, userAgentData: { architecture: "" } })
        .architectureReported,
    ).toBeUndefined()
    expect(parseUserAgent({ userAgent: chromeMac }).architectureReported).toBeUndefined()
  })
})

describe("atLeast", () => {
  it("passes only a plain dotted version at or above the floor", () => {
    expect(atLeast("26.4.1", "26.4.1")).toBe(true)
    expect(atLeast("27.0.1", "26.4.1")).toBe(true)
    expect(atLeast("26.4", "26.4.1")).toBe(false)
    expect(atLeast("26.4.0", "26.4.1")).toBe(false)
  })

  it("fails closed on anything that is not a plain version", () => {
    for (const version of ["26.4.0-beta", "26.x", "", "unknown", "26.4.1.2", " 26.4.1"]) {
      expect(atLeast(version, "26.4.1")).toBe(false)
    }
  })
})

describe("macosSyncedCopyReadsRight", () => {
  it("admits the Sequoia range from its floor to the end of macOS 15", () => {
    for (const version of [MACOS_SYNCED_COPY_FLOORS.sequoia, "15.8", "15.10.0"]) {
      expect(macosSyncedCopyReadsRight(version)).toBe(true)
    }
  })

  it("admits Tahoe from its floor on, with no ceiling", () => {
    for (const version of [MACOS_SYNCED_COPY_FLOORS.tahoe, "27.0.1"]) {
      expect(macosSyncedCopyReadsRight(version)).toBe(true)
    }
  })

  it("refuses everything outside the two ranges, and fails closed", () => {
    for (const version of ["15.7.4", "16.0.0", "25.9.9", "26.4.0", "15.7.5-beta"]) {
      expect(macosSyncedCopyReadsRight(version)).toBe(false)
    }
  })
})

describe("macosGivesApplePrf", () => {
  it("holds from macOS 15", () => {
    for (const version of [MACOS_APPLE_PRF_FLOOR, "27.0.1"]) {
      expect(macosGivesApplePrf(version)).toBe(true)
    }
  })

  it("fails before it, and on anything that is not a plain version", () => {
    for (const version of ["14.9.9", "15.0-beta"]) {
      expect(macosGivesApplePrf(version)).toBe(false)
    }
  })
})

describe("currentUserAgentInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the platform version and the architecture from Client Hints", async () => {
    const getHighEntropyValues = async () => ({ platformVersion: "26.4.1", architecture: "arm" })
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform: "macOS", brands: [], getHighEntropyValues },
    })
    const info = await currentUserAgentInfo()
    expect(info).toMatchObject({
      osVersionReported: "26.4.1",
      osVersionFromHints: true,
      architectureReported: "arm",
    })
  })

  it("keeps the user agent's claims when the hints call rejects", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      userAgentData: {
        platform: "macOS",
        brands: [],
        getHighEntropyValues: vi.fn().mockRejectedValue(new Error("refused")),
      },
    })
    const info = await currentUserAgentInfo()
    expect(info.osVersionReported).toBe("10.15.7")
    expect(info.osVersionFromHints).toBeUndefined()
    expect(info.architectureReported).toBeUndefined()
  })
})

describe("currentUserAgentInfoSoon", () => {
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("takes the hints when they settle, and leaves no timer behind", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("navigator", {
      userAgent: CHROME_MAC,
      userAgentData: {
        platform: "macOS",
        brands: [],
        getHighEntropyValues: vi.fn().mockResolvedValue({ platformVersion: "26.4.1" }),
      },
    })
    const info = await currentUserAgentInfoSoon()
    expect(info).toMatchObject({ osVersionReported: "26.4.1", osVersionFromHints: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("falls back to the user-agent string when the hints never settle", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("navigator", {
      userAgent: CHROME_MAC,
      userAgentData: {
        platform: "macOS",
        brands: [],
        getHighEntropyValues: () => new Promise(() => {}),
      },
    })
    const reading = currentUserAgentInfoSoon()
    await vi.advanceTimersByTimeAsync(1000)
    const info = await reading
    expect(info).toMatchObject({ osFamily: "macos", osVersionReported: "10.15.7" })
    expect(info.osVersionFromHints).toBeUndefined()
  })

  it("keeps the fallback when the hints settle late, however they settle", async () => {
    for (const late of ["resolve", "reject"] as const) {
      vi.useFakeTimers()
      let settle!: () => void
      vi.stubGlobal("navigator", {
        userAgent: CHROME_MAC,
        userAgentData: {
          platform: "macOS",
          brands: [],
          getHighEntropyValues: () =>
            new Promise((resolve, reject) => {
              settle =
                late === "resolve"
                  ? () => resolve({ platformVersion: "26.4.1" })
                  : () => reject(new Error("late"))
            }),
        },
      })
      const reading = currentUserAgentInfoSoon()
      await vi.advanceTimersByTimeAsync(1000)
      settle()
      await vi.advanceTimersByTimeAsync(0)
      const info = await reading
      expect(info.osVersionReported).toBe("10.15.7")
      expect(info.osVersionFromHints).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it("falls back to the user-agent string when the hints read throws, and leaves no timer behind", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("navigator", {
      userAgent: CHROME_MAC,
      get userAgentData() {
        throw new Error("no hints")
      },
    })
    const info = await currentUserAgentInfoSoon()
    expect(info).toMatchObject({ osFamily: "macos", osVersionReported: "10.15.7" })
    expect(info.osVersionFromHints).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("iosBelowFloor", () => {
  const ios = (v: string) => ({ osFamily: "ios" as const, osVersionReported: v })
  it("flags only an iOS claim below 18.4", () => {
    expect(iosBelowFloor(ios("18.3"))).toBe(true)
    expect(iosBelowFloor(ios("18.4"))).toBe(false)
    expect(iosBelowFloor(ios("26.0"))).toBe(false)
    expect(iosBelowFloor(ios("unknown"))).toBe(false)
    expect(iosBelowFloor({ osFamily: "macos", osVersionReported: "10.15.7" })).toBe(false)
  })
})

describe("windowsReleaseFromHints", () => {
  const chrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/155.0.0.0 Safari/537.36"
  const hinted = (platformVersion: string) =>
    parseUserAgent({ userAgent: chrome, userAgentData: { platform: "Windows", platformVersion } })

  it("reads Windows 11 from 13 up and Windows 10 below it", () => {
    expect(windowsReleaseFromHints(hinted("13.0.0"))).toBe("11")
    expect(windowsReleaseFromHints(hinted("1.0.0"))).toBe("10")
  })

  it("says nothing for an older Windows, a user-agent string alone, or another OS", () => {
    expect(windowsReleaseFromHints(hinted("0.3.0"))).toBeUndefined()
    expect(windowsReleaseFromHints(parseUserAgent({ userAgent: chrome }))).toBeUndefined()
    expect(
      windowsReleaseFromHints({
        osFamily: "macos",
        osVersionReported: "15.0.0",
        osVersionFromHints: true,
      }),
    ).toBeUndefined()
  })

  it("reads the hinted platform over a user-agent string that names another", () => {
    const linux = parseUserAgent({
      userAgent: chrome,
      userAgentData: { platform: "Linux", platformVersion: "6.1.0" },
    })
    expect(linux).toMatchObject({
      osFamily: "linux",
      osVersionReported: "6.1.0",
      osVersionFromHints: true,
    })
    expect(
      parseUserAgent({
        userAgent: chrome,
        userAgentData: { platform: "Chrome OS", platformVersion: "16181.0.0" },
      }).osFamily,
    ).toBe("chromeos")
    expect(
      parseUserAgent({ userAgent: chrome, userAgentData: { platform: "Unknown" } }).osFamily,
    ).toBe("windows")
  })
})

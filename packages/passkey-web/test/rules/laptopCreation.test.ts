// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type LaptopCreation,
  type LocalManager,
  type Withdrawn,
  WITHDRAWN,
  currentLaptopCreation,
  laptopCreationFor,
  withoutManager,
} from "../../src/rules/laptopCreation.js"
import { MACOS_APPLE_PRF_FLOOR, parseUserAgent } from "../../src/browser/userAgentInfo.js"

/** The Firefox rows as they read once a gate admits them. */
const FIREFOX_ADMITTED: Withdrawn = { ...WITHDRAWN, windowsFirefox: [], linuxFirefox: [] }

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
/** A Chrome whose user-agent string alone would admit Apple: real Chrome freezes it at 10_15_7. */
const MAC_CHROME_UA_UNFROZEN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_8_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_FIREFOX_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0; rv:139.0) Gecko/20100101 Firefox/139.0"
const macSafariUa = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`
const MAC_SAFARI_UA = macSafariUa("26.4")
const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0"
/** Firefox on Linux, and Firefox on an Android phone asking for the desktop site: the same claim. */
const LINUX_FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0"
const ANDROID_FIREFOX_UA = "Mozilla/5.0 (Android 15; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0"
/** A Firefox fork that appends its own token reads as Firefox. */
const WATERFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0 Waterfox/6.5.0"
const IPAD_CHROME_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.55 Safari/604.1"

const chrome = { brand: "Google Chrome", version: "155" }
const edge = { brand: "Microsoft Edge", version: "155" }
const brave = { brand: "Brave", version: "155" }
/** A Chromium that carries no brand of its own: Chrome only by its user-agent token. */
const chromium = { brand: "Chromium", version: "155" }

/** A Chromium on a Mac answering Client Hints with the given version. */
const mac = (version: string, brand: { brand: string; version: string } = chrome) =>
  parseUserAgent({
    userAgent: MAC_CHROME_UA,
    userAgentData: {
      platform: "macOS",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** A Chromium on Windows; the hinted version is 13 or more on Windows 11, 10 or less before it. */
const windows = (brand = chrome, version = "15.0.0") =>
  parseUserAgent({
    userAgent: WINDOWS_CHROME_UA,
    userAgentData: {
      platform: "Windows",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** Chrome on Linux as it answers Client Hints: the platform's name and an empty version. */
const linux = (brand = chrome) =>
  parseUserAgent({
    userAgent: LINUX_CHROME_UA,
    userAgentData: {
      platform: "Linux",
      platformVersion: "",
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

const safari = (version = "26.4") => parseUserAgent({ userAgent: macSafariUa(version) })

const phone: LaptopCreation = { local: false, chromeTip: false }
/** Phone creation, with the line saying Chrome can create here in Google Password Manager. */
const tipsChrome: LaptopCreation = { local: false, chromeTip: "gpm" }
const macChrome = (managers: LocalManager[], withdrawn: LocalManager[] = []): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macChrome",
  managers,
  withdrawn,
})
const macEdgeBrave = (
  managers: LocalManager[],
  withdrawn: LocalManager[] = [],
  chromeTip?: "gpm",
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macEdgeBrave",
  managers,
  withdrawn,
  ...(chromeTip ? { chromeTip } : {}),
})
const macSafari = (
  managers: LocalManager[] = ["apple", "1password"],
  withdrawn: LocalManager[] = [],
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macSafari",
  managers,
  withdrawn,
})
const macFirefox = (
  managers: LocalManager[] = ["apple", "1password"],
  withdrawn: LocalManager[] = [],
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macFirefox",
  managers,
  withdrawn,
  ...(managers.includes("1password") ? { extensionWithdrawn: true as const } : {}),
})
const firefox = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })
/** The other-Chromium row of Windows or Linux: 1Password alone, Chrome tipped while it has GPM. */
const onePasswordOn = (
  os: "windows" | "linux",
  withdrawn: LocalManager[] = [],
  chromeTip: "gpm" | false = "gpm",
): LaptopCreation => ({
  local: true,
  os,
  row: os === "windows" ? "windowsEdgeBrave" : "linuxEdgeBrave",
  managers: ["1password"],
  withdrawn,
  ...(chromeTip ? { chromeTip } : {}),
})
/** Firefox's row of Windows or Linux: 1Password alone, Chrome tipped while it has GPM. */
const firefoxOn = (os: "windows" | "linux", chromeTip: "gpm" | false = "gpm"): LaptopCreation => ({
  local: true,
  os,
  row: os === "windows" ? "windowsFirefox" : "linuxFirefox",
  managers: ["1password"],
  withdrawn: [],
  ...(chromeTip ? { chromeTip } : {}),
})

describe("laptopCreationFor", () => {
  /** macOS 15 and later, the synced-copy floors' inside and outside alike. */
  const admitted = [MACOS_APPLE_PRF_FLOOR, "15.7.4", "26.3.9", "27.0.1"]

  it("admits Apple on Mac Chrome from macOS 15, beside Google Password Manager and 1Password", () => {
    const expected = macChrome(["apple", "gpm", "1password"])
    for (const version of admitted) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  /** Versions before macOS 15, and hinted versions the floor check cannot read. */
  const refused = ["14.9.9", "15.0-beta"]

  it("offers Mac Chrome without Apple before macOS 15", () => {
    const expected = macChrome(["gpm", "1password"])
    for (const version of refused) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  it("offers Mac Edge and Brave Apple and 1Password from macOS 15, 1Password alone before it", () => {
    for (const brand of [edge, brave, chromium]) {
      expect(laptopCreationFor(mac("15.0", brand))).toEqual(macEdgeBrave(["apple", "1password"]))
      for (const version of refused) {
        expect(laptopCreationFor(mac(version, brand))).toEqual(
          macEdgeBrave(["1password"], [], "gpm"),
        )
      }
    }
  })

  it("offers Safari 26.4 and later Apple Passwords and 1Password", () => {
    for (const version of ["26.4", "27.0"]) {
      expect(laptopCreationFor(safari(version))).toEqual(macSafari())
    }
  })

  it("offers Firefox 153 and later on a Mac Apple Passwords and 1Password", () => {
    expect(laptopCreationFor(firefox("153.0"))).toEqual(macFirefox())
  })

  it("keeps Safari below 26.4 and Firefox below 153 on a Mac on phone creation", () => {
    expect(laptopCreationFor(safari("26.3"))).toEqual(phone)
    expect(laptopCreationFor(firefox("152.0"))).toEqual(phone)
  })

  it("offers Windows Chrome Google Password Manager and 1Password on any Windows", () => {
    const expected: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm", "1password"],
      withdrawn: [],
    }
    for (const ua of [windows(), windows(chrome, "10.0.0")]) {
      expect(laptopCreationFor(ua)).toEqual(expected)
    }
  })

  it("offers another Chromium on Windows 1Password alone, with the Chrome tip", () => {
    for (const brand of [edge, chromium]) {
      expect(laptopCreationFor(windows(brand))).toEqual(onePasswordOn("windows"))
    }
  })

  it("offers Firefox on Windows and Linux 1Password alone from its user-agent string, with the Chrome tip", () => {
    const hinted = parseUserAgent({
      userAgent: WINDOWS_FIREFOX_UA,
      userAgentData: { platform: "Windows", platformVersion: "15.0.0" },
    })
    for (const ua of [hinted, parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA })]) {
      expect(laptopCreationFor(ua, FIREFOX_ADMITTED)).toEqual(firefoxOn("windows"))
    }
    expect(
      laptopCreationFor(parseUserAgent({ userAgent: LINUX_FIREFOX_UA }), FIREFOX_ADMITTED),
    ).toEqual(firefoxOn("linux"))
  })

  it("puts Firefox forks on Firefox's rows, and neither a phone's Firefox nor ChromeOS on Linux's", () => {
    expect(laptopCreationFor(parseUserAgent({ userAgent: WATERFOX_UA }), FIREFOX_ADMITTED)).toEqual(
      firefoxOn("windows"),
    )
    expect(laptopCreationFor(parseUserAgent({ userAgent: ANDROID_FIREFOX_UA }))).toEqual(phone)
    for (const userAgent of [CROS_UA, CROS_FIREFOX_UA]) {
      expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(phone)
    }
  })

  it("needs Client Hints for every row but Safari's, WebKit in a Mac's clothing included", () => {
    expect(laptopCreationFor(parseUserAgent({ userAgent: MAC_CHROME_UA }))).toEqual(phone)
    expect(laptopCreationFor(parseUserAgent({ userAgent: IPAD_CHROME_DESKTOP_UA }))).toEqual(phone)
    for (const userAgent of [WINDOWS_CHROME_UA, LINUX_CHROME_UA]) {
      expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(tipsChrome)
    }
  })

  it("needs the version from the hints, not from the user-agent string", () => {
    // The string alone would admit; only the hints guard can send this Mac to the phone.
    const hinted = (brand: { brand: string; version: string }, platformVersion?: string) =>
      parseUserAgent({
        userAgent: MAC_CHROME_UA_UNFROZEN,
        userAgentData: {
          platform: "macOS",
          brands: [brand, { brand: "Chromium", version: "155" }],
          ...(platformVersion === undefined ? {} : { platformVersion }),
        },
      })
    expect(laptopCreationFor(hinted(chrome, "15.8.1"))).toEqual(
      macChrome(["apple", "gpm", "1password"]),
    )
    for (const brand of [chrome, edge]) {
      expect(laptopCreationFor(hinted(brand))).toEqual(phone)
    }
  })

  it("offers Linux Chrome Google Password Manager and 1Password on its platform claim, which carries no version", () => {
    expect(laptopCreationFor(linux())).toEqual({
      local: true,
      os: "linux",
      row: "linuxChrome",
      managers: ["gpm", "1password"],
      withdrawn: [],
    })
  })

  it("treats another Chromium on Linux as on Windows", () => {
    expect(laptopCreationFor(linux(brave))).toEqual(onePasswordOn("linux"))
  })

  it("keeps other systems on phone creation", () => {
    const chromeOs = parseUserAgent({
      userAgent: CROS_UA,
      userAgentData: { platformVersion: "6.1.0" },
    })
    const androidDesktop = parseUserAgent({
      userAgent: LINUX_CHROME_UA,
      userAgentData: { platform: "Android", platformVersion: "15.0.0" },
    })
    for (const ua of [chromeOs, androidDesktop]) {
      expect(laptopCreationFor(ua)).toEqual(phone)
    }
  })

  describe("withdrawal", () => {
    const withdrawing = (
      overrides: Partial<Record<keyof Withdrawn, LocalManager[]>>,
    ): Withdrawn => ({
      macChrome: [],
      macEdgeBrave: [],
      macSafari: [],
      macFirefox: [],
      windowsChrome: [],
      windowsEdgeBrave: [],
      windowsFirefox: [],
      linuxChrome: [],
      linuxEdgeBrave: [],
      linuxFirefox: [],
      ...overrides,
    })

    it("removes the manager from its row and names it", () => {
      expect(laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["gpm"] }))).toEqual(
        macChrome(["apple", "1password"], ["gpm"]),
      )
      expect(laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macChrome(["gpm", "1password"], ["apple"]),
      )
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["1password"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["gpm"],
        withdrawn: ["1password"],
      })
    })

    it("falls back to the phone when a row has no manager left", () => {
      expect(
        laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["apple", "gpm", "1password"] })),
      ).toEqual(phone)
    })

    it("offers a row left with 1Password alone, with the Chrome tip", () => {
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["gpm"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["1password"],
        withdrawn: ["gpm"],
      })
      expect(
        laptopCreationFor(mac("26.4.1", edge), withdrawing({ macEdgeBrave: ["apple"] })),
      ).toEqual(macEdgeBrave(["1password"], ["apple"], "gpm"))
    })

    it("reads each row's own entry: Apple withdrawn from Chrome leaves Edge's managers alone", () => {
      expect(laptopCreationFor(mac("26.4.1", edge), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macEdgeBrave(["apple", "1password"]),
      )
    })

    it("names in a Chrome tip only what that system's Chrome row still admits", () => {
      const noGpm = (key: "windowsChrome" | "linuxChrome" | "macChrome") =>
        withdrawing({ [key]: ["gpm"] })
      expect(laptopCreationFor(windows(edge), noGpm("windowsChrome"))).toEqual(
        onePasswordOn("windows", [], false),
      )
      expect(
        laptopCreationFor(
          parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
          noGpm("windowsChrome"),
        ),
      ).toEqual(firefoxOn("windows", false))
      expect(laptopCreationFor(mac("14.6", edge), noGpm("macChrome"))).toEqual(
        macEdgeBrave(["1password"]),
      )
    })

    it("points no other browser at a Chrome that has nothing to create in", () => {
      expect(
        laptopCreationFor(
          windows(edge),
          withdrawing({ windowsChrome: ["gpm"], windowsEdgeBrave: ["1password"] }),
        ),
      ).toEqual(phone)
      expect(
        laptopCreationFor(
          parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
          withdrawing({ windowsChrome: ["gpm"], windowsFirefox: ["1password"] }),
        ),
      ).toEqual(phone)
    })

    it("keeps the Chrome tip on the phone once 1Password is withdrawn from a row it had alone", () => {
      expect(
        laptopCreationFor(windows(edge), withdrawing({ windowsEdgeBrave: ["1password"] })),
      ).toEqual(tipsChrome)
      expect(
        laptopCreationFor(mac("14.6", edge), withdrawing({ macEdgeBrave: ["1password"] })),
      ).toEqual(tipsChrome)
      // Chrome's own row is untouched by it.
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsEdgeBrave: ["1password"] })),
      ).toMatchObject({ managers: ["gpm", "1password"] })
    })

    it("gives Safari and Firefox on a Mac no Chrome tip", () => {
      expect(
        laptopCreationFor(safari(), withdrawing({ macSafari: ["apple", "1password"] })),
      ).toEqual(phone)
      expect(
        laptopCreationFor(firefox("155.0"), withdrawing({ macFirefox: ["apple", "1password"] })),
      ).toEqual(phone)
    })

    it("turns Safari and Firefox on a Mac back to 1Password alone once Apple is withdrawn", () => {
      expect(laptopCreationFor(safari(), withdrawing({ macSafari: ["apple"] }))).toEqual(
        macSafari(["1password"], ["apple"]),
      )
      expect(laptopCreationFor(firefox("155.0"), withdrawing({ macFirefox: ["apple"] }))).toEqual(
        macFirefox(["1password"], ["apple"]),
      )
    })

    it("ships with 1Password withdrawn from Firefox on Windows and Linux", () => {
      for (const userAgent of [WINDOWS_FIREFOX_UA, LINUX_FIREFOX_UA]) {
        expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(tipsChrome)
      }
    })

    it("offers 1Password through the Mac's window alone on Firefox's Mac row", () => {
      expect(laptopCreationFor(firefox("155.0"))).toMatchObject({ extensionWithdrawn: true })
      expect(laptopCreationFor(safari())).not.toHaveProperty("extensionWithdrawn")
      expect(
        laptopCreationFor(firefox("155.0"), withdrawing({ macFirefox: ["1password"] })),
      ).not.toHaveProperty("extensionWithdrawn")
    })
  })
})

describe("currentLaptopCreation", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps a phone on phone creation", async () => {
    // A laptop would get the Chrome tip here.
    vi.stubGlobal("navigator", {
      userAgent: WINDOWS_CHROME_UA,
      userAgentData: { platform: "Windows", getHighEntropyValues: async () => ({}) },
    })
    expect(await currentLaptopCreation("phone")).toEqual(phone)
  })

  it("reads the version from the live browser's hints", async () => {
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues: async () => ({ platformVersion: "26.4.1" }),
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(macChrome(["apple", "gpm", "1password"]))
  })

  it("keeps the phone route when the hints request rejects", async () => {
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA_UNFROZEN,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues: () => Promise.reject(new Error("denied")),
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(phone)
  })

  it("offers Safari its row from the user-agent string alone", async () => {
    vi.stubGlobal("navigator", { userAgent: MAC_SAFARI_UA })
    expect(await currentLaptopCreation("laptop")).toEqual(macSafari())
  })
})

describe("withoutManager", () => {
  it("takes the manager off the row", () => {
    expect(withoutManager(macChrome(["apple", "gpm", "1password"]), "apple")).toEqual(
      macChrome(["gpm", "1password"]),
    )
  })

  it("falls back to the phone when the row has nothing left", () => {
    expect(withoutManager(macFirefox(["1password"]), "1password")).toEqual(phone)
    expect(withoutManager(macEdgeBrave(["1password"], [], "gpm"), "1password")).toEqual(tipsChrome)
  })

  it("leaves a row without the manager, and phone creation, as they are", () => {
    const row = macChrome(["gpm", "1password"])
    expect(withoutManager(row, "apple")).toBe(row)
    expect(withoutManager(phone, "apple")).toBe(phone)
  })
})

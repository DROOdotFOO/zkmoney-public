// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ANDROID_CHROME_WEBVIEW_FLOOR,
  brandEvidence,
  currentIsIosInAppBrowser,
  currentAppDropsOpenLink,
  currentInAppUpFront,
  currentIsInAppBrowser,
  currentOpenInBrowserHref,
  inAppBrowserRefusal,
  isAndroidWebViewBrand,
  isIosInAppBrowser,
  isStaleAndroidChrome,
  openInBrowserHref,
} from "../../src/browser/inAppBrowser.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"

const FLOOR = Number(ANDROID_CHROME_WEBVIEW_FLOOR)
/** A phone's Chrome at `major`, as Chrome's own user agent reports it. */
const androidChromeAt = (major: number) =>
  `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`

/** Shapes of published user agents, not device captures. */
const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iosFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iosEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.2592.56 Version/18.0 Mobile/15E148 Safari/604.1",
  iosDuckDuckGo:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
  iosWebView:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
  iosFacebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/0;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]",
  iosGoogleApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/380.0.0 Mobile/15E148 Safari/604.1",
  // Telegram-iOS's in-app browser builds Safari's user agent, with the device's build number.
  iosTelegram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/22F76 Safari/604.1",
  ipadWebView:
    "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  androidChromeAtFloor: androidChromeAt(FLOOR),
  // An app's web view on the System WebView, with `wv` stripped: only its Chrome major tells.
  androidChromeStale: androidChromeAt(FLOOR - 3),
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36",
  // Tablets send no `Mobile` token and run the laptop ceremony.
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  androidTabletWebView:
    "Mozilla/5.0 (Linux; Android 14; SM-X910 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Safari/537.36",
  // Chromium forks on Android read as Chrome at their Chromium major; Samsung and Firefox name themselves.
  androidEdge:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36 EdgA/154.0.0.0",
  androidEdgeStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 EdgA/138.0.0.0",
  androidOperaStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 OPR/89.0.0.0",
  androidVivaldiStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 Vivaldi/7.0",
  androidMiBrowserStale:
    "Mozilla/5.0 (Linux; Android 14; 2311DRK48G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.5.0",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
}

/** Client Hints brands as Chromium's WebView and as Chrome report them. */
const WEBVIEW_BRANDS = [
  { brand: "Android WebView", version: "154" },
  { brand: "Chromium", version: "154" },
  { brand: "Not A Brand", version: "99" },
]
const CHROME_BRANDS = [
  { brand: "Google Chrome", version: "154" },
  { brand: "Chromium", version: "154" },
  { brand: "Not A Brand", version: "99" },
]
const BRAVE_BRANDS = [
  { brand: "Brave", version: "138" },
  { brand: "Chromium", version: "138" },
  { brand: "Not A Brand", version: "99" },
]
/** A list with nothing in it but the placeholder every Chromium sends. */
const PLACEHOLDER_BRANDS = [{ brand: "Not A Brand", version: "99" }]

const inApp = (userAgent: string) => isIosInAppBrowser(parseUserAgent({ userAgent }))

describe("isIosInAppBrowser", () => {
  it.each([
    ["iOS Safari", UA.iosSafari],
    ["iOS Chrome", UA.iosChrome],
    ["iOS Firefox", UA.iosFirefox],
    ["iOS Edge", UA.iosEdge],
    ["iOS DuckDuckGo", UA.iosDuckDuckGo],
  ])("leaves a named iOS browser alone: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(false)
  })

  it.each([
    ["a bare web view", UA.iosWebView],
    ["X", UA.iosX],
    ["Instagram", UA.iosInstagram],
    ["Facebook", UA.iosFacebook],
    ["an iPad web view", UA.ipadWebView],
    // The rule's answer, not a verified fact about the Google app.
    ["the Google app", UA.iosGoogleApp],
  ])("flags an iOS browser that names no family: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(true)
  })

  it.each([
    ["an Android web view", UA.androidWebView],
    ["macOS Safari", UA.macSafari],
    ["Windows Chrome", UA.windowsChrome],
    ["nothing", ""],
  ])("is iOS-only: %s", (_name, userAgent) => {
    expect(inApp(userAgent)).toBe(false)
  })
})

describe("openInBrowserHref", () => {
  const url = "https://launch.zk.money/?invite=bcd2345"

  const intent = (target: string, scheme = "https") =>
    `intent://${target}#Intent;scheme=${scheme};package=com.android.chrome;end`

  it.each([
    [
      url,
      "x-safari-https://launch.zk.money/?invite=bcd2345",
      intent("launch.zk.money/?invite=bcd2345"),
    ],
    // The fragment is dropped, so the intent's trailer is the only one.
    ["https://h/p?q=1#h=abc.def", "x-safari-https://h/p?q=1", intent("h/p?q=1")],
    [
      "https://h:8443/a;component=foo/%23x?y=%25",
      "x-safari-https://h:8443/a;component=foo/%23x?y=%25",
      intent("h:8443/a;component=foo/%23x?y=%25"),
    ],
    ["https://u:p@h/", "x-safari-https://h/", intent("h/")],
    [
      "http://localhost:5173/x",
      "x-safari-http://localhost:5173/x",
      intent("localhost:5173/x", "http"),
    ],
  ])("opens %s in Safari on iOS and Chrome on Android", (input, ios, android) => {
    expect(openInBrowserHref(input, "ios")).toBe(ios)
    expect(openInBrowserHref(input, "android")).toBe(android)
  })

  it("has nothing for other systems, unparseable URLs or other schemes", () => {
    for (const os of ["macos", "windows", "linux", "chromeos", "unknown"] as const) {
      expect(openInBrowserHref(url, os)).toBeUndefined()
    }
    expect(openInBrowserHref("not a url", "ios")).toBeUndefined()
    expect(openInBrowserHref("data:text/html,hi", "android")).toBeUndefined()
  })
})

describe("the live browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const page = "https://launch.zk.money/"

  it("offers the way out on Android and in an iOS in-app browser only", () => {
    vi.stubGlobal("navigator", { userAgent: UA.androidWebView })
    expect(currentOpenInBrowserHref(page)).toBe(
      "intent://launch.zk.money/#Intent;scheme=https;package=com.android.chrome;end",
    )

    vi.stubGlobal("navigator", { userAgent: UA.iosX })
    expect(currentOpenInBrowserHref(page)).toBe("x-safari-https://launch.zk.money/")

    for (const userAgent of [UA.iosSafari, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentOpenInBrowserHref(page)).toBeUndefined()
    }
  })

  it("answers no without a navigator", () => {
    vi.stubGlobal("navigator", undefined)
    expect(currentIsIosInAppBrowser()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBeUndefined()
    expect(currentInAppUpFront()).toBeUndefined()
    expect(currentAppDropsOpenLink()).toBe(false)
  })

  it("takes a Home Screen web app, which sends a web view's user agent, for Safari", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: true })
    expect(currentIsIosInAppBrowser()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBeUndefined()
    expect(inAppBrowserRefusal({ name: "NotAllowedError", message: "closed" })).toBeUndefined()

    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: false })
    expect(currentIsIosInAppBrowser()).toBe(true)
  })

  it("tells an app's browser to leave on iPhone and on Android, and nothing elsewhere", () => {
    for (const userAgent of [UA.iosX, UA.androidWebView]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentInAppUpFront()).toBe("leave")
    }
    for (const userAgent of [UA.iosSafari, UA.androidChrome, UA.macSafari]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentInAppUpFront()).toBeUndefined()
    }
    vi.stubGlobal("navigator", { userAgent: UA.iosWebView, standalone: true })
    expect(currentInAppUpFront()).toBeUndefined()
  })

  it("reads a phone's Chrome far behind stable as an app's web view", () => {
    vi.stubGlobal("navigator", { userAgent: UA.androidChromeStale })
    // Without brands the page cannot tell a web view from a real Chrome, so it says both.
    expect(currentInAppUpFront()).toBe("leave-or-update")
    vi.stubGlobal("navigator", { userAgent: UA.androidChromeAtFloor })
    expect(currentInAppUpFront()).toBeUndefined()
    // Client Hints decide the posture when present: a tablet by hints is left alone, a phone by
    // hints is carded even when its user agent carries no Mobile token.
    vi.stubGlobal("navigator", {
      userAgent: UA.androidChromeStale,
      userAgentData: { mobile: false },
    })
    expect(currentIsInAppBrowser()).toBe(false)
    vi.stubGlobal("navigator", { userAgent: UA.androidTablet, userAgentData: { mobile: true } })
    expect(currentIsInAppBrowser()).toBe(true)
  })

  it("reads a WebView brand in the Client Hints as an app's web view, on a phone", () => {
    const withBrands = (brands: unknown, mobile?: boolean) =>
      vi.stubGlobal("navigator", {
        userAgent: UA.androidChrome,
        userAgentData: { brands, ...(mobile === undefined ? {} : { mobile }) },
      })
    withBrands(WEBVIEW_BRANDS, true)
    expect(currentInAppUpFront()).toBe("leave")
    withBrands(CHROME_BRANDS, true)
    expect(currentIsInAppBrowser()).toBe(false)
    withBrands(WEBVIEW_BRANDS, false)
    expect(currentIsInAppBrowser()).toBe(false)
    withBrands(undefined)
    expect(currentIsInAppBrowser()).toBe(false)
    withBrands("Android WebView", true)
    expect(currentIsInAppBrowser()).toBe(false)
  })

  it("below the floor, lets a Chrome that names itself through and cards the rest by their brands", () => {
    const stale = (userAgentData?: unknown) =>
      vi.stubGlobal("navigator", {
        userAgent: UA.androidChromeStale,
        ...(userAgentData === undefined ? {} : { userAgentData }),
      })
    const cases: [string, unknown, ReturnType<typeof currentInAppUpFront>][] = [
      ["Google Chrome brands", { brands: CHROME_BRANDS }, undefined],
      ["no Client Hints", undefined, "leave-or-update"],
      ["a WebView brand", { brands: WEBVIEW_BRANDS }, "leave"],
      ["Brave's brands", { brands: BRAVE_BRANDS }, "leave"],
    ]
    for (const [name, userAgentData, mode] of cases) {
      stale(userAgentData)
      expect(currentInAppUpFront(), name).toBe(mode)
    }
    // The marker wins over the brands, on a phone and on a tablet.
    vi.stubGlobal("navigator", {
      userAgent: `${UA.androidWebView} TwitterAndroid`,
      userAgentData: { brands: CHROME_BRANDS },
    })
    expect(currentInAppUpFront()).toBe("leave")
    vi.stubGlobal("navigator", {
      userAgent: UA.androidTabletWebView,
      userAgentData: { brands: CHROME_BRANDS },
    })
    expect(currentInAppUpFront()).toBe("leave")
    // Brands that card a stale phone card nothing above the floor, on a tablet, or in a browser
    // that names itself.
    vi.stubGlobal("navigator", {
      userAgent: UA.androidChromeAtFloor,
      userAgentData: { brands: BRAVE_BRANDS },
    })
    expect(currentInAppUpFront()).toBeUndefined()
    vi.stubGlobal("navigator", {
      userAgent: UA.androidChromeStale,
      userAgentData: { brands: BRAVE_BRANDS, mobile: false },
    })
    expect(currentInAppUpFront()).toBeUndefined()
    for (const userAgent of [UA.androidTablet, UA.androidSamsung, UA.androidFirefox]) {
      vi.stubGlobal("navigator", { userAgent, userAgentData: { brands: BRAVE_BRANDS } })
      expect(currentInAppUpFront(), userAgent).toBeUndefined()
    }
  })

  it("decides by the wv marker alone for tablets, browsers that name themselves and other systems", () => {
    for (const userAgent of [
      UA.androidTablet,
      UA.androidSamsung,
      UA.androidFirefox,
      UA.androidEdge,
    ]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentIsInAppBrowser()).toBe(false)
    }
    // Forks that only carry Chrome's token read as Chrome: far behind stable, they get the card too.
    for (const userAgent of [
      UA.androidEdgeStale,
      UA.androidOperaStale,
      UA.androidVivaldiStale,
      UA.androidMiBrowserStale,
    ]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentIsInAppBrowser()).toBe(true)
    }
  })

  it("knows Telegram's browser, which sends Safari's user agent, by the bridge it injects", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosTelegram })
    expect(currentIsIosInAppBrowser()).toBe(false)

    vi.stubGlobal("TelegramWebviewProxy", {})
    expect(currentIsIosInAppBrowser()).toBe(true)
    expect(currentInAppUpFront()).toBe("leave")
    // Telegram hands an x-safari link to iOS, so the link is offered.
    expect(currentAppDropsOpenLink()).toBe(false)
    expect(currentOpenInBrowserHref(page)).toBe("x-safari-https://launch.zk.money/")
    expect(inAppBrowserRefusal({ name: "NotAllowedError", message: "" })).toEqual({
      name: "InAppBrowser",
      message: "",
    })

    vi.stubGlobal("navigator", { userAgent: UA.iosTelegram, standalone: true })
    expect(currentIsIosInAppBrowser()).toBe(false)
    vi.stubGlobal("navigator", { userAgent: UA.macSafari })
    expect(currentIsIosInAppBrowser()).toBe(false)
  })

  it("knows only X's app drops the link, on iPhone and on Android", () => {
    const androidX = `${UA.androidWebView} TwitterAndroid`
    for (const userAgent of [UA.iosX, androidX]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentAppDropsOpenLink()).toBe(true)
    }
    for (const userAgent of [UA.iosInstagram, UA.androidWebView]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(currentAppDropsOpenLink()).toBe(false)
    }
    vi.stubGlobal("navigator", { userAgent: UA.iosX, standalone: true })
    expect(currentAppDropsOpenLink()).toBe(false)
  })
})

describe("the Android web-view tells", () => {
  const info = (userAgent: string) => parseUserAgent({ userAgent })

  it("reads the floor as a boundary on Android Chrome only", () => {
    expect(isStaleAndroidChrome(info(UA.androidChromeStale))).toBe(true)
    expect(isStaleAndroidChrome(info(UA.androidChromeAtFloor))).toBe(false)
    expect(isStaleAndroidChrome(info(UA.androidTablet))).toBe(true)
    expect(isStaleAndroidChrome(info(UA.androidSamsung))).toBe(false)
    expect(isStaleAndroidChrome(info(UA.androidFirefox))).toBe(false)
    expect(isStaleAndroidChrome(info(UA.windowsChrome))).toBe(false)
    expect(
      isStaleAndroidChrome({
        osFamily: "android",
        browserFamily: "chrome",
        browserVersionReported: "unknown",
      }),
    ).toBe(false)
  })

  it("matches the WebView brand", () => {
    expect(isAndroidWebViewBrand(WEBVIEW_BRANDS)).toBe(true)
    expect(isAndroidWebViewBrand(CHROME_BRANDS)).toBe(false)
  })

  it("reads the brands as reported: the WebView first, then Chrome, then anything named", () => {
    expect(brandEvidence(WEBVIEW_BRANDS)).toBe("webview")
    expect(brandEvidence([...CHROME_BRANDS, ...WEBVIEW_BRANDS])).toBe("webview")
    expect(brandEvidence(CHROME_BRANDS)).toBe("chrome")
    expect(brandEvidence([null, { brand: "Google Chrome" }])).toBe("chrome")
    expect(brandEvidence(BRAVE_BRANDS)).toBe("other")
    expect(brandEvidence(PLACEHOLDER_BRANDS)).toBe("other")
    expect(brandEvidence([{ brand: "google chrome" }])).toBe("other")
    for (const nothing of [
      [],
      [null, { version: "154" }, { brand: 154 }],
      undefined,
      null,
      "Google Chrome",
      { brand: "Google Chrome" },
    ]) {
      expect(brandEvidence(nothing)).toBe("none")
    }
    // An entry whose brand cannot be read is skipped, and the rest still count.
    const throwing = {
      get brand(): string {
        throw new Error("bad brand")
      },
    }
    expect(brandEvidence([{ brand: "Android WebView" }, throwing])).toBe("webview")
    expect(brandEvidence([throwing, { brand: "Google Chrome" }])).toBe("chrome")
    expect(brandEvidence([throwing])).toBe("none")
  })
})

describe("inAppBrowserRefusal", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const closed = { name: "NotAllowedError", message: "The operation was not allowed." }

  it("reads a closed sheet as the in-app browser only in an iOS web view", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosX })
    expect(inAppBrowserRefusal(closed)).toEqual({ name: "InAppBrowser", message: closed.message })
    for (const userAgent of [UA.iosSafari, UA.androidChromeStale]) {
      vi.stubGlobal("navigator", { userAgent })
      expect(inAppBrowserRefusal(closed)).toBeUndefined()
    }
  })

  it("leaves everything else to the caller", () => {
    vi.stubGlobal("navigator", { userAgent: UA.iosX })
    expect(inAppBrowserRefusal({ name: "AbortError", message: "aborted" })).toBeUndefined()
    expect(inAppBrowserRefusal(null)).toBeUndefined()
  })

  it("matches by name, so a DOMException and a plain object both count", () => {
    vi.stubGlobal("navigator", { userAgent: UA.macSafari })
    expect(inAppBrowserRefusal(new DOMException("no", "NotSupportedError"))).toEqual({
      name: "NotSupportedError",
      message: "no",
    })
    expect(inAppBrowserRefusal({ name: "NotSupportedError" })).toEqual({
      name: "NotSupportedError",
      message: "",
    })
  })
})

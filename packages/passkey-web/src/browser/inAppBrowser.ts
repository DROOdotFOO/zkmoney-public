import { currentDevicePosture } from "./devicePosture.js"
import { IN_APP_BROWSER_REFUSAL, type RefusalState } from "../refusals/refusalCopy.js"
import {
  currentUserAgentInfoSync,
  type OsFamily,
  type UserAgentInfo,
  versionBelow,
} from "./userAgentInfo.js"

/**
 * An iOS browser that names no known family: an app's own web view (X, Instagram, ...), where
 * passkeys fail at once. Apps that open Safari's own view send Safari's user agent and pass.
 */
export function isIosInAppBrowser(
  info: Pick<UserAgentInfo, "osFamily" | "browserFamily">,
): boolean {
  return info.osFamily === "ios" && info.browserFamily === "unknown"
}

/**
 * The Chrome major below which a phone's "Chrome" may be an app's web view: the Android System
 * WebView lags stable, and some apps strip its `wv` marker, so a version that far behind is the
 * trace left. A guess, not a passkey floor; raised by hand as stable moves, kept well behind it.
 */
export const ANDROID_CHROME_WEBVIEW_FLOOR = "141"

/**
 * Chrome's Play Store page, the https form: Chrome hands it to the Play Store app, and a web view
 * may drop a `market://` link.
 */
export const PLAY_STORE_CHROME_URL =
  "https://play.google.com/store/apps/details?id=com.android.chrome"

/**
 * A Chrome on Android below the floor. A user-agent tell only; `currentInAppUpFront` decides what
 * a phone makes of it.
 */
export function isStaleAndroidChrome(
  info: Pick<UserAgentInfo, "osFamily" | "browserFamily" | "browserVersionReported">,
): boolean {
  return (
    info.osFamily === "android" &&
    info.browserFamily === "chrome" &&
    versionBelow(info.browserVersionReported, ANDROID_CHROME_WEBVIEW_FLOOR)
  )
}

/** The names in a Client Hints brand list; an entry without a readable string name is skipped. */
function brandNames(brands: unknown): string[] {
  if (!Array.isArray(brands)) return []
  const names: string[] = []
  for (const entry of brands) {
    try {
      const brand = (entry as { brand?: unknown } | null)?.brand
      if (typeof brand === "string") names.push(brand)
    } catch {
      // A brand that cannot be read is no evidence either way.
    }
  }
  return names
}

/**
 * What the Client Hints brands report, as reported: Chromium's WebView names itself, real Chrome
 * names itself, another browser names itself, or the list says nothing (absent, empty, nameless).
 * A host app can override the list, so this is evidence, not proof.
 */
export type BrandEvidence = "webview" | "chrome" | "other" | "none"

export function brandEvidence(brands: unknown): BrandEvidence {
  const names = brandNames(brands)
  if (names.includes("Android WebView")) return "webview"
  if (names.includes("Google Chrome")) return "chrome"
  return names.length > 0 ? "other" : "none"
}

/** Chromium's WebView names itself in the Client Hints brands; no real browser does. */
export function isAndroidWebViewBrand(brands: unknown): boolean {
  return brandEvidence(brands) === "webview"
}

/**
 * A link that opens `url` in the phone's browser: Safari on iOS, Chrome on Android. Whether it
 * works is up to the app hosting the page, so callers keep a manual way out beside it. Built
 * from the parsed URL, without user info or fragment.
 */
export function openInBrowserHref(url: string, osFamily: OsFamily): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== "https" && scheme !== "http") return undefined
  const target = `${parsed.host}${parsed.pathname}${parsed.search}`
  if (osFamily === "ios") return `x-safari-${scheme}://${target}`
  if (osFamily === "android") {
    return `intent://${target}#Intent;scheme=${scheme};package=com.android.chrome;end`
  }
  return undefined
}

/** A Home Screen web app: it sends an app web view's user agent, but runs passkeys as Safari does. */
function isHomeScreenWebApp(): boolean {
  return (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true
}

/** Telegram's own browser sends Safari's user agent; the bridge it injects into every page doesn't. */
function isTelegramWebView(): boolean {
  return (globalThis as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy !== undefined
}

/** The live browser's answer: its user-agent string or Telegram's bridge, less a Home Screen web app. */
export function currentIsIosInAppBrowser(): boolean {
  const info = currentUserAgentInfoSync()
  const inApp = isIosInAppBrowser(info) || (info.osFamily === "ios" && isTelegramWebView())
  return inApp && !isHomeScreenWebApp()
}

type NavigatorWithBrands = Navigator & {
  userAgentData?: { brands?: readonly { brand: string; version: string }[] }
}

/** The low-entropy Client Hints brands, which need no permission and no await. */
function currentBrands(): unknown {
  return (globalThis.navigator as NavigatorWithBrands | undefined)?.userAgentData?.brands
}

/**
 * What the card before any passkey request says. `leave`: an app's own browser, so open the page
 * in the phone's browser. `leave-or-update`: a phone's Chrome below the floor whose brands say
 * nothing, which may be a web view or a Chrome to update. A Chrome below the floor whose brands
 * name Google Chrome gets no card: it is read as a real Chrome and runs the request.
 */
export type InAppUpFront = "leave" | "leave-or-update"

/** The up-front card's mode, or undefined when no rule matches. */
export function currentInAppUpFront(): InAppUpFront | undefined {
  const info = currentUserAgentInfoSync()
  if (info.osFamily !== "android") return currentIsIosInAppBrowser() ? "leave" : undefined
  if (/;\s*wv\)/.test(globalThis.navigator?.userAgent ?? "")) return "leave"
  if (currentDevicePosture() !== "phone") return undefined
  const brands = brandEvidence(currentBrands())
  if (brands === "webview") return "leave"
  if (!isStaleAndroidChrome(info) || brands === "chrome") return undefined
  return brands === "none" ? "leave-or-update" : "leave"
}

/** Whether the live browser gets a card before any passkey request. */
export function currentIsInAppBrowser(): boolean {
  return currentInAppUpFront() !== undefined
}

/** The way out for this device: on Android, or in an iOS in-app browser; nothing elsewhere. */
export function currentOpenInBrowserHref(url: string): string | undefined {
  const info = currentUserAgentInfoSync()
  if (info.osFamily !== "android" && !currentIsIosInAppBrowser()) return undefined
  return openInBrowserHref(url, info.osFamily)
}

/**
 * Whether the app hosting the page drops the Open in browser link: X's app does on iPhone and on
 * Android, so there no link is offered and the way out is the app's own menu or a copied link.
 */
export function currentAppDropsOpenLink(): boolean {
  const userAgent = globalThis.navigator?.userAgent ?? ""
  const xIphone = currentIsIosInAppBrowser() && /\bTwitter for iPhone\b/.test(userAgent)
  const xAndroid =
    currentUserAgentInfoSync().osFamily === "android" && /\bTwitterAndroid\b/.test(userAgent)
  return xIphone || xAndroid
}

/**
 * The in-app refusal a failed passkey request calls for, if any: a browser that cannot run
 * passkeys, or an iOS app's web view, whose rejection looks like a closed sheet. Matched by name,
 * because a `DOMException` is not an `Error` in every realm.
 */
export function inAppBrowserRefusal(err: unknown): RefusalState | undefined {
  const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown }
  const text = typeof message === "string" ? message : ""
  if (name === "NotSupportedError") return { name, message: text }
  if (name === "NotAllowedError" && currentIsIosInAppBrowser()) {
    return { name: IN_APP_BROWSER_REFUSAL, message: text }
  }
  return undefined
}

/** The in-app browser card's counts, through the real sign-up channel with fetch stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

const API = "https://api.test"
const UA = {
  android:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
  androidX:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 TwitterAndroid",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
}
const UP_FRONT = { when: "up_front", screen: "onboarding" } as const

let fetchSpy: MockInstance<typeof fetch>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("VITE_ZKMONEY_API_URL", API)
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
})

afterEach(() => {
  fetchSpy.mockRestore()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
  sessionStorage.clear()
})

const load = () => import("../../../src/features/identity/inAppCardTelemetry")
const as = (userAgent: string) =>
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
const sent = () =>
  fetchSpy.mock.calls.map(([url, init]) => ({
    url,
    credentials: init?.credentials,
    body: JSON.parse(init?.body as string),
  }))

describe("in-app card telemetry", () => {
  it("posts a display through the sign-up channel: no identifier, no cookie, whatever consent says", async () => {
    as(UA.iosX)
    const { bindAnalyticsConsent } = await import("../../../src/lib/analytics")
    const consent = vi.fn(() => false)
    bindAnalyticsConsent(consent)
    const { inAppCardShown } = await load()
    inAppCardShown(UP_FRONT)
    expect(sent()).toEqual([
      {
        url: `${API}/events`,
        credentials: "omit",
        body: {
          event: "onboarding_in_app_shown",
          platform: "web-signup",
          app_version: "dev",
          props: { when: "up_front", screen: "onboarding", in_app: "ios_x" },
        },
      },
    ])
    expect(consent).not.toHaveBeenCalled()
  })

  it.each([
    ["ios_other", UA.iosInstagram],
    ["android_x", UA.androidX],
  ])("names the app %s from the user agent", async (expected, userAgent) => {
    as(userAgent)
    const { inAppCardShown } = await load()
    inAppCardShown(UP_FRONT)
    expect(sent()[0].body.props.in_app).toBe(expected)
  })

  it("counts the first display per page load per moment", async () => {
    as(UA.iosX)
    let telemetry = await load()
    telemetry.inAppCardShown(UP_FRONT)
    telemetry.inAppCardShown({ when: "up_front", screen: "enter" })
    expect(sent()).toHaveLength(1)
    telemetry.inAppCardShown({ when: "after_miss", screen: "onboarding" })
    expect(sent().map((s) => s.body.props.when)).toEqual(["up_front", "after_miss"])

    // A reload is a new page load.
    vi.resetModules()
    telemetry = await load()
    telemetry.inAppCardShown(UP_FRONT)
    expect(sent()).toHaveLength(3)
  })

  it("counts every tap with its control", async () => {
    as(UA.android)
    const { inAppCardTapped } = await load()
    inAppCardTapped(UP_FRONT, "copy_link")
    inAppCardTapped(UP_FRONT, "copy_link")
    inAppCardTapped({ when: "after_miss", screen: "enter" }, "update_link")
    expect(sent().map((s) => [s.body.event, s.body.props])).toEqual([
      [
        "onboarding_in_app_exit",
        { when: "up_front", screen: "onboarding", in_app: "android_other", control: "copy_link" },
      ],
      [
        "onboarding_in_app_exit",
        { when: "up_front", screen: "onboarding", in_app: "android_other", control: "copy_link" },
      ],
      [
        "onboarding_in_app_exit",
        { when: "after_miss", screen: "enter", in_app: "android_other", control: "update_link" },
      ],
    ])
  })

  it("sends nothing in demo mode", async () => {
    as(UA.iosX)
    window.history.replaceState(null, "", "/?demo=activity")
    const { inAppCardShown, inAppCardTapped } = await load()
    inAppCardShown(UP_FRONT)
    inAppCardTapped(UP_FRONT, "copy_link")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("names only the two screens that count the card", async () => {
    const { inAppCardScreen } = await load()
    expect(inAppCardScreen("enter")).toBe("enter")
    expect(inAppCardScreen("onboarding")).toBe("onboarding")
    expect(inAppCardScreen("passkey")).toBeUndefined()
  })
})

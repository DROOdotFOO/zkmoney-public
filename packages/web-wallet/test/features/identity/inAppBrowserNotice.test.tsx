/** The card shown in an app's built-in browser before any passkey request. */
import { act, StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fireOnboarding = vi.fn()
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireOnboardingEvent: fireOnboarding,
}))

const { InAppBrowserNotice } = await import("../../../src/features/identity/InAppBrowserNotice")
const { subscribeErrorModal } = await import("../../../src/errors/errorModal")
const { stashClaimLink } = await import("../../../src/features/paylink/claimStash")
const { resetInAppCardCountsForTests } = await import("../../../src/features/identity/inAppCardTelemetry")

const UA = {
  // A phone's Chrome far behind stable, with no marker: the card's mode decides what it is.
  androidChromeStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  androidXStale:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 TwitterAndroid",
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
}
const startUrl = window.location.href

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  fireOnboarding.mockClear()
  resetInAppCardCountsForTests()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", startUrl)
  sessionStorage.clear()
})

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)
const escape = () => byTestId("open-in-browser")
const link = () => byTestId("open-in-browser-link")

function as(userAgent: string, address: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  window.history.replaceState(null, "", address)
}

async function show(ui: ReactNode) {
  await act(async () =>
    root.render(<MemoryRouter initialEntries={[{ pathname: "/" }]}>{ui}</MemoryRouter>),
  )
}

describe("InAppBrowserNotice", () => {
  const PLAY = "https://play.google.com/store/apps/details?id=com.android.chrome"
  const maybeLink = () => byTestId("update-chrome-maybe")

  it("the update line follows X's menu-first variant, the menu hint and the reopen line too", async () => {
    as(UA.androidXStale, "/enter")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    expect(link()).toBeNull()
    expect(buttonNamed("Copy link")!.className).toContain("ww-invite-pill")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)

    act(() => root.unmount())
    root = createRoot(container)
    as(UA.androidChromeStale, "/link#secret-frag")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="onboarding" />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)
    expect(container.innerHTML).not.toContain("secret")

    act(() => root.unmount())
    root = createRoot(container)
    as(UA.androidChromeStale, "/enter")
    stashClaimLink("frag-2")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(maybeLink()!.getAttribute("href")).toBe(PLAY)
    expect(container.textContent).not.toContain(window.location.origin)
  })

  const shownEvents = () =>
    fireOnboarding.mock.calls.filter(([event]) => event === "onboarding_in_app_shown")
  const taps = () =>
    fireOnboarding.mock.calls
      .filter(([event]) => event === "onboarding_in_app_exit")
      .map(([, props]) => (props as { control: string }).control)

  it("counts its first display per page load, with the screen, under StrictMode and across remounts", async () => {
    as(UA.iosX, "/enter")
    const strict = (ui: ReactNode) => (
      <StrictMode>
        <MemoryRouter initialEntries={[{ pathname: "/" }]}>{ui}</MemoryRouter>
      </StrictMode>
    )
    await act(async () =>
      root.render(strict(<InAppBrowserNotice mode="leave" reportContext="enter" />)),
    )
    expect(shownEvents()).toEqual([
      ["onboarding_in_app_shown", { when: "up_front", screen: "enter", in_app: "ios_x" }],
    ])
    await act(async () =>
      root.render(strict(<InAppBrowserNotice mode="leave" reportContext="enter" exits={<i />} />)),
    )
    act(() => root.unmount())
    root = createRoot(container)
    await show(<InAppBrowserNotice mode="leave" reportContext="onboarding" />)
    expect(shownEvents()).toHaveLength(1)
  })

  it("counts a tap on the Copy link pill as it starts, once, even when the copy fails", async () => {
    as(UA.iosInstagram, "/enter")
    let settle!: (ok: boolean) => void
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = (ok) => (ok ? resolve() : reject(new Error("denied")))
        }),
    )
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
    await show(<InAppBrowserNotice mode="leave" reportContext="onboarding" />)
    act(() => buttonNamed("Copy link")!.click())
    expect(taps()).toEqual(["copy_link"])
    await act(async () => settle(false))
    expect(taps()).toEqual(["copy_link"])
    expect(fireOnboarding.mock.calls.at(-1)?.[1]).toMatchObject({
      when: "up_front",
      screen: "onboarding",
      control: "copy_link",
    })
    await act(async () => buttonNamed("Copy link")!.click())
    expect(taps()).toEqual(["copy_link", "copy_link"])
  })

  it("counts the Open in browser link, the Copy link pill and the Play Store link", async () => {
    container.addEventListener("click", (e) => e.preventDefault())
    as(UA.androidChromeStale, "/enter")
    await show(<InAppBrowserNotice mode="leave-or-update" reportContext="enter" />)
    await act(async () => link()!.click())
    await act(async () => buttonNamed("Copy link")!.click())
    await act(async () => maybeLink()!.click())
    expect(taps()).toEqual(["open_link", "copy_link", "update_link"])
    expect(shownEvents()).toEqual([
      ["onboarding_in_app_shown", { when: "up_front", screen: "enter", in_app: "android_other" }],
    ])
  })

  it("the report carries the user agent, the one thing that can show a wrong match", async () => {
    as(UA.iosInstagram, "/enter")
    const reports: { title: string; message: string; context?: string; showReport?: boolean }[] = []
    const unsubscribe = subscribeErrorModal((payload) => {
      reports.push(payload)
    })
    try {
      await show(<InAppBrowserNotice mode="leave" reportContext="enter" />)
      await act(async () => byTestId("passkey-report")!.click())
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        title: "In-app browser notice",
        message: UA.iosInstagram,
        context: "enter",
        showReport: true,
      })
    } finally {
      unsubscribe()
    }
  })
})

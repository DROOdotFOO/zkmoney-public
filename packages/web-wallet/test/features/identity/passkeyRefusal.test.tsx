/** Refusal rows, the two with no retry, and the way out of an app's built-in browser. */
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

const { PasskeyRefusal, refusalFor } = await import("../../../src/features/identity/PasskeyRefusal")
const { resetInAppCardCountsForTests } = await import("../../../src/features/identity/inAppCardTelemetry")
type RouteRefusal = import("../../../src/features/identity/PasskeyRefusal").RouteRefusal
const errors = await import("@obsidion/passkey-web")
const { subscribeErrorModal } = await import("../../../src/errors/errorModal")
const { stashClaimLink } = await import("../../../src/features/paylink/claimStash")
const { CONNECT_STASH_KEY } = await import("../../../src/features/contacts/connectReceive")

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("refusalFor", () => {
  it("offers no retry where another attempt cannot help", () => {
    expect(refusalFor(new errors.RotatedCredentialError()).retry).toBe(false)
    expect(refusalFor(new errors.AmbiguousPasskeyError()).retry).toBe(false)
    expect(refusalFor(new errors.PhoneRequiredError()).retry).toBe(true)
    expect(refusalFor({ name: "error" }).retry).toBe(true)
  })
})

describe("PasskeyRefusal", () => {
  it("renders the title, the error's own message, the reason and a retry", async () => {
    const onRetry = vi.fn()
    const error = new errors.PhoneRequiredError()
    await act(async () =>
      root.render(<PasskeyRefusal error={error} onRetry={onRetry} exits={<i>exit</i>} />),
    )
    const pane = container.querySelector<HTMLElement>('[data-testid="passkey-refused"]')!
    expect(pane.dataset.reason).toBe("PhoneRequiredError")
    expect(container.textContent).toContain(error.message)
    expect(container.textContent).toContain("exit")
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="passkey-retry"]')!.click(),
    )
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("links the cleanup entry when the error says a passkey was written, and only then", async () => {
    const e = new errors.UnsupportedProviderError("manager")
    const written = { name: e.name, message: e.message, leftover: true }
    await act(async () => root.render(<PasskeyRefusal error={written} onRetry={() => {}} />))
    const lines = container.querySelectorAll('[data-testid="passkey-leftover"]')
    expect(lines).toHaveLength(1)
    const link = lines[0]!.querySelector("a")!
    expect(link.getAttribute("href")).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
    expect(link.target).toBe("_blank")
    expect(link.closest("button")).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(e.message)
    expect(container.querySelector('[data-testid="passkey-retry"]')).not.toBeNull()

    await act(async () =>
      root.render(<PasskeyRefusal error={{ ...written, leftover: false }} onRetry={() => {}} />),
    )
    expect(container.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
  })

  it("adds the extension advice under the message in the wording the screen names, and only then", async () => {
    const e = new errors.NoPrfError()
    const refusal = { name: e.name, message: e.message }
    const line = () => container.querySelector('[data-testid="passkey-extension-advice"]')
    for (const wording of ["use", "install"] as const) {
      const advised = { ...refusal, extensionAdvice: wording }
      await act(async () => root.render(<PasskeyRefusal error={advised} onRetry={() => {}} />))
      expect(line()?.textContent).toBe(errors.EXTENSION_ADVICE_COPY[wording])
      // The refusal's own words stay the alert; the advice follows them.
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(e.message)
      expect(container.querySelector('[data-testid="passkey-retry"]')).not.toBeNull()
    }

    await act(async () => root.render(<PasskeyRefusal error={refusal} onRetry={() => {}} />))
    expect(line()).toBeNull()
  })
})

describe("PasskeyRefusal's macOS update line", () => {
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/155.0.0.0 Safari/537.36"
  const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
  /** The browser's user agent, and Client Hints answering with `platformVersion`. */
  const browser = (ua: string, platformVersion?: () => Promise<{ platformVersion: string }>) => {
    Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true })
    Object.defineProperty(navigator, "userAgentData", {
      value: platformVersion
        ? { platform: "macOS", brands: [], getHighEntropyValues: platformVersion }
        : undefined,
      configurable: true,
    })
  }
  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", userAgent)
    delete (navigator as { userAgentData?: unknown }).userAgentData
    vi.useRealTimers()
  })
  const wrongKey = (macUpdate: boolean): RouteRefusal => ({
    name: "StoredAddressMismatchError",
    message: "",
    verdict: "wrong-key",
    ...(macUpdate ? { macUpdate } : {}),
  })
  const line = () => container.querySelector('[data-testid="passkey-mac-update"]')?.textContent
  const show = (error: RouteRefusal) =>
    act(async () => root.render(<PasskeyRefusal error={error} verdict={error.verdict} />))

  it("a card the screen did not mark shows no line", async () => {
    browser(MAC_CHROME, async () => ({ platformVersion: "26.2.0" }))
    await show(wrongKey(false))
    expect(line()).toBeUndefined()
  })

  it("hints that never answer leave the conditional line; a late answer still counts", async () => {
    vi.useFakeTimers()
    let answer!: (v: { platformVersion: string }) => void
    browser(MAC_CHROME, () => new Promise((resolve) => (answer = resolve)))
    await show(wrongKey(true))
    expect(line()).toBeUndefined()
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(line()).toBe(errors.MAC_UPDATE_COPY.unknown)
    await act(async () => answer({ platformVersion: "15.6.1" }))
    expect(line()).toBe(errors.MAC_UPDATE_COPY.below)
  })

  it("a late answer past the floors takes the line away", async () => {
    vi.useFakeTimers()
    let answer!: (v: { platformVersion: string }) => void
    browser(MAC_CHROME, () => new Promise((resolve) => (answer = resolve)))
    await show(wrongKey(true))
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(line()).toBe(errors.MAC_UPDATE_COPY.unknown)
    await act(async () => answer({ platformVersion: "26.6.2" }))
    expect(line()).toBeUndefined()
  })
})

describe("PasskeyRefusal after a creation on this computer", () => {
  const phoneExit = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="passkey-phone"]')
  const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="passkey-retry"]')
  const isPill = (button: HTMLElement | null) => {
    if (!button) throw new Error("no such button")
    return button.className.includes("ww-invite-pill")
  }
  const buttonOrder = () =>
    Array.from(container.querySelectorAll("button")).map((button) => button.dataset.testid)
  const refused = (over: Partial<RouteRefusal> = {}): RouteRefusal => {
    const e = new errors.LaptopPasskeyRefusedError("apple", ["gpm"])
    return {
      name: e.name,
      message: e.message,
      leftover: true,
      appleRefusedHere: e.appleRefusedHere,
      route: "this-device",
      reach: "ok",
      ...over,
    }
  }
  const whyLink = () =>
    container.querySelector<HTMLAnchorElement>('[data-testid="passkey-apple-floor"] a')

  it("says why Apple Passwords was refused, links the cleanup, and leads with the phone", async () => {
    const onRetry = vi.fn()
    const onPhone = vi.fn()
    await act(async () =>
      root.render(<PasskeyRefusal error={refused()} onRetry={onRetry} onPhone={onPhone} />),
    )
    expect(whyLink()!.getAttribute("href")).toBe(
      "https://docs.zk.money/docs/passkeys#save-somewhere-else",
    )
    expect(container.querySelector('[data-testid="passkey-leftover"]')).not.toBeNull()
    expect(isPill(phoneExit())).toBe(false)
    expect(isPill(retry())).toBe(true)
    await act(async () => phoneExit()!.click())
    expect(onPhone).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    await act(async () => retry()!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onPhone).toHaveBeenCalledTimes(1)
  })

  it("with the phone's reach unknown, draws the phone once, then Try again, then the screen's exits", async () => {
    await act(async () =>
      root.render(
        <PasskeyRefusal
          error={refused({ reach: "unknown" })}
          onRetry={() => {}}
          onPhone={() => {}}
          exits={<button data-testid="exit">Start over</button>}
        />,
      ),
    )
    expect(buttonOrder()).toEqual(["passkey-phone", "passkey-retry", "exit"])
    expect(isPill(phoneExit())).toBe(false)
    expect(isPill(retry())).toBe(true)
  })

  it("leaves a screen's own lead in place, with Try again and the phone as pills", async () => {
    await act(async () =>
      root.render(
        <PasskeyRefusal
          error={refused()}
          onRetry={() => {}}
          onPhone={() => {}}
          primary={{ title: "Show passkeys", onClick: () => {}, testId: "own-lead" }}
        />,
      ),
    )
    expect(buttonOrder()).toEqual(["own-lead", "passkey-retry", "passkey-phone"])
    expect(isPill(retry())).toBe(true)
    expect(isPill(phoneExit())).toBe(true)
  })

  it("presses neither the phone nor Try again while an attempt runs", async () => {
    const onRetry = vi.fn()
    const onPhone = vi.fn()
    await act(async () =>
      root.render(<PasskeyRefusal error={refused()} onRetry={onRetry} onPhone={onPhone} busy />),
    )
    await act(async () => {
      phoneExit()!.click()
      retry()!.click()
    })
    expect(onPhone).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("offers no phone where none can be reached, or where the screen offers none", async () => {
    await act(async () =>
      root.render(
        <PasskeyRefusal
          error={refused({ reach: "no-hybrid" })}
          onRetry={() => {}}
          onPhone={() => {}}
        />,
      ),
    )
    expect(phoneExit()).toBeNull()
    expect(isPill(retry())).toBe(false)
    await act(async () => root.render(<PasskeyRefusal error={refused()} onRetry={() => {}} />))
    expect(phoneExit()).toBeNull()
    expect(isPill(retry())).toBe(false)
  })

  it("offers the phone for any refusal of this computer's route, and not for the phone's own", async () => {
    const unsupported = new errors.UnsupportedProviderError("manager", {
      providerName: "Windows Hello",
      localManagers: ["gpm"],
    })
    await act(async () =>
      root.render(
        <PasskeyRefusal
          error={refused({
            name: unsupported.name,
            message: unsupported.message,
            appleRefusedHere: false,
          })}
          onRetry={() => {}}
          onPhone={() => {}}
        />,
      ),
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(unsupported.message)
    expect(isPill(phoneExit())).toBe(true)
    expect(isPill(retry())).toBe(false)
    await act(async () =>
      root.render(
        <PasskeyRefusal
          error={refused({ route: "phone" })}
          onRetry={() => {}}
          onPhone={() => {}}
        />,
      ),
    )
    expect(phoneExit()).toBeNull()
    expect(isPill(retry())).toBe(false)
  })
})

describe("PasskeyRefusal in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    iosInstagram:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
    iosSafari:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    laptop:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  }
  const unsupported = new DOMException(
    "Error connecting to Web Authentication service",
    "NotSupportedError",
  )
  const notSupported = {
    name: "NotSupportedError",
    message: unsupported.message,
    cause: unsupported,
  }
  const inApp = { name: errors.IN_APP_BROWSER_REFUSAL, message: "" }
  const startUrl = window.location.href
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand")

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const buttonNamed = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)
  const escape = () => byTestId("open-in-browser")
  const link = () => byTestId("open-in-browser-link") as HTMLAnchorElement | null

  function as(userAgent: string, address: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    window.history.replaceState(null, "", address)
  }

  async function show(ui: ReactNode, state?: unknown, strict = false) {
    const tree = <MemoryRouter initialEntries={[{ pathname: "/", state }]}>{ui}</MemoryRouter>
    await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree))
  }

  beforeEach(() => {
    fireOnboarding.mockClear()
    resetInAppCardCountsForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, "", startUrl)
    sessionStorage.clear()
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
    else delete (navigator as { clipboard?: unknown }).clipboard
    if (execCommand) Object.defineProperty(document, "execCommand", execCommand)
    else delete (document as { execCommand?: unknown }).execCommand
  })

  it("counts the way out it renders after a failed request, and its taps", async () => {
    as(UA.iosX, "/enter")
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
    await show(<PasskeyRefusal error={inApp} reportContext="enter" />)
    await act(async () => buttonNamed("Copy link")!.click())
    const props = { when: "after_miss", screen: "enter", in_app: "ios_x" }
    expect(fireOnboarding.mock.calls).toEqual([
      ["onboarding_in_app_shown", props],
      ["onboarding_in_app_exit", { ...props, control: "copy_link" }],
    ])
  })

  it.each([
    ["iPhone Safari", UA.iosSafari, "enter"],
    ["a surface that is not a card screen", UA.android, undefined],
  ])("counts nothing on %s", async (_n, ua, reportContext) => {
    as(ua, "/enter")
    await show(
      <PasskeyRefusal error={notSupported} onRetry={() => {}} reportContext={reportContext} />,
    )
    expect(fireOnboarding).not.toHaveBeenCalled()
  })

  it("offers Chrome on Android with the hint, the link and Copy link, and turns the retry into a pill", async () => {
    as(UA.android, "/enter?handle=alice")
    const onRetry = vi.fn()
    await show(<PasskeyRefusal error={notSupported} onRetry={onRetry} exits={<i>exit</i>} />)
    const host = window.location.host
    expect(byTestId("passkey-refused")!.dataset.reason).toBe("NotSupportedError")
    expect(link()!.getAttribute("href")).toBe(
      `intent://${host}/enter?handle=alice#Intent;scheme=http;package=com.android.chrome;end`,
    )
    expect(escape()!.textContent).toContain(`${window.location.origin}/enter?handle=alice`)
    expect(buttonNamed("Copy link")).toBeDefined()
    const retry = byTestId("passkey-retry")!
    expect(retry.className).toContain("ww-invite-pill")
    await act(async () => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("exit")
    expect(byTestId("passkey-report")).not.toBeNull()
  })

  it("offers Safari in an iPhone app browser, with no retry for the closed-sheet case", async () => {
    as(UA.iosInstagram, "/claim/alice?entry=passkey&choose=1")
    await show(<PasskeyRefusal error={inApp} onRetry={() => {}} />)
    expect(link()!.getAttribute("href")).toBe(
      `x-safari-http://${window.location.host}/claim/alice?entry=passkey&choose=1`,
    )
    expect(byTestId("passkey-retry")).toBeNull()
  })

  it("in X's Android app, which drops the Chrome link too, leads with its menu and keeps the retry", async () => {
    as(`${UA.android} TwitterAndroid`, "/enter?handle=alice")
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(link()).toBeNull()
    const text = escape()!.textContent ?? ""
    const menu = text.indexOf("Tap ⋮ next to the web address at the bottom")
    const copy = text.indexOf("Or copy the link")
    const address = text.indexOf(`${window.location.origin}/enter?handle=alice`)
    expect(menu).toBeGreaterThanOrEqual(0)
    expect(copy).toBeGreaterThan(menu)
    expect(address).toBeGreaterThan(copy)
    expect(buttonNamed("Copy link")!.className).toContain("ww-invite-pill")
    expect(byTestId("passkey-retry")!.className).toContain("ww-invite-pill")
  })

  it("in X's iPhone app, a payment in the fragment gets its menu in place of the generic hint", async () => {
    as(UA.iosX, "/link#secret-frag")
    await show(<PasskeyRefusal error={inApp} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(escape()!.textContent).toContain("Tap ⋮ next to the web address at the bottom")
    expect(escape()!.textContent).not.toContain("Tap ⋯ in this app")
    expect(container.innerHTML).not.toContain("secret")
  })

  it("has no way out on iPhone Safari: the message, a gradient retry and the report link", async () => {
    as(UA.iosSafari, "/enter")
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()).toBeNull()
    expect(byTestId("passkey-retry")!.className).not.toContain("ww-invite-pill")
    expect(byTestId("passkey-report")).not.toBeNull()
  })

  it.each([
    ["the payment-link page", "/link#secret-frag"],
    ["a return path holding a fragment", "/enter?next=%2Frequest%23secret-packet"],
  ])("on %s gives the app's menu and the original link, never a built one", async (_n, address) => {
    as(UA.android, address)
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(link()).toBeNull()
    expect(buttonNamed("Copy link")).toBeUndefined()
    expect(container.innerHTML).not.toContain("secret")
    expect(byTestId("passkey-retry")!.className).not.toContain("ww-invite-pill")
  })

  it.each<[string, () => void, unknown]>([
    ["a payment request in router memory", () => {}, { request: { amount: "12", note: "rent" } }],
    ["a waiting payment link", () => stashClaimLink("secret-frag"), undefined],
    ["a waiting contact link", () => sessionStorage.setItem(CONNECT_STASH_KEY, "{}"), undefined],
  ])("with %s asks for the original link only", async (_n, seed, state) => {
    as(UA.android, "/contacts/alice/send")
    seed()
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />, state)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
    expect(container.innerHTML).not.toContain("secret")
    expect(container.innerHTML).not.toContain("rent")
  })

  const seedGrant = (handle: string) => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", handle)
  }

  it("with a name grant on its claim page asks for the original link only", async () => {
    as(UA.android, "/claim/alice")
    seedGrant("alice")
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
  })

  it("keeps the link on another tag's claim page when another link's grant sits in this tab", async () => {
    as(UA.android, "/claim/bob")
    seedGrant("alice")
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("link")
    expect(link()).not.toBeNull()
  })

  it("opens the page a surface names instead of this one, unless the flow is in the fragment", async () => {
    as(UA.android, "/activity")
    await show(<PasskeyRefusal error={notSupported} escapePath="/enter" />)
    expect(link()!.getAttribute("href")).toBe(
      `intent://${window.location.host}/enter#Intent;scheme=http;package=com.android.chrome;end`,
    )
    expect(escape()!.textContent).toContain(`${window.location.origin}/enter`)
    expect(escape()!.textContent).not.toContain("/activity")

    await act(async () => root.unmount())
    root = createRoot(container)
    as(UA.android, "/link#secret-frag")
    await show(<PasskeyRefusal error={notSupported} escapePath="/enter" />)
    expect(escape()!.dataset.escape).toBe("hint")
  })

  it("copies the link and says so", async () => {
    as(UA.android, "/enter?handle=alice")
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await show(<PasskeyRefusal error={notSupported} />)
    await act(async () => buttonNamed("Copy link")!.click())
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/enter?handle=alice`)
    expect(escape()!.textContent).toContain("Link copied.")
  })

  it.each([
    ["failure", false],
    ["success", true],
  ])("an older copy's %s landing last leaves no stale failure", async (_n, firstOk) => {
    as(UA.android, "/enter")
    let settleFirst!: () => void
    const denied = () => Promise.reject(new Error("denied"))
    const writeText = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settleFirst = () => (firstOk ? resolve() : reject(new Error("denied")))
          }),
      )
      .mockImplementationOnce(firstOk ? denied : async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      await show(<PasskeyRefusal error={notSupported} />)
      await act(async () => buttonNamed("Copy link")!.click())
      await act(async () => buttonNamed("Copy link")!.click())
      await act(async () => settleFirst())
      // One of the two copies landed: the link is on the clipboard.
      expect(escape()!.textContent).toContain("Link copied.")
      await act(async () => vi.advanceTimersByTime(2000))
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(escape()!.textContent).not.toContain("Couldn't copy")
    } finally {
      vi.useRealTimers()
    }
  })

  it.each<[string, unknown]>([
    ["absent", undefined],
    ["rejecting", { writeText: async () => Promise.reject(new Error("denied")) }],
  ])("with the clipboard %s, says to press and hold the link", async (_n, value) => {
    as(UA.android, "/enter")
    Object.defineProperty(navigator, "clipboard", { value, configurable: true })
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
    await show(<PasskeyRefusal error={notSupported} />)
    await act(async () => buttonNamed("Copy link")!.click())
    expect(escape()!.textContent).toContain(
      "Couldn't copy. Press and hold the address above to select and copy it.",
    )
    expect(escape()!.textContent).toContain(`${window.location.origin}/enter`)
  })

  it("reports the browser's own error, not the card", async () => {
    as(UA.laptop, "/enter")
    const reports: { title: string; message: string; detail?: string; context?: string }[] = []
    const stop = subscribeErrorModal((payload) => reports.push(payload))
    try {
      await show(<PasskeyRefusal error={notSupported} reportContext="enter" />)
      await act(async () => byTestId("passkey-report")!.click())
      const plain = {
        ...inApp,
        cause: { name: "NotAllowedError", message: "closed", stack: "at somewhere" },
      }
      await show(<PasskeyRefusal error={plain} reportContext="onboarding" />)
      await act(async () => byTestId("passkey-report")!.click())
      await show(<PasskeyRefusal error={{ name: "NotSupportedError", message: "bare" }} />)
      await act(async () => byTestId("passkey-report")!.click())
    } finally {
      stop()
    }
    expect(reports).toHaveLength(3)
    expect(reports[0]).toMatchObject({
      title: "Passkey refused: NotSupportedError",
      message: unsupported.message,
      context: "enter",
    })
    expect(reports[1]).toMatchObject({
      title: "Passkey refused: InAppBrowser",
      message: "closed",
      detail: "at somewhere",
      context: "onboarding",
    })
    expect(reports[2]).toMatchObject({ message: "bare", context: "passkey" })
    expect(reports.map((r) => r.message)).not.toContain("[object Object]")
  })

  it("links the cleanup entry beside the way out when the error says a passkey was written", async () => {
    as(UA.android, "/enter")
    await show(<PasskeyRefusal error={{ ...notSupported, leftover: true }} onRetry={() => {}} />)
    expect(escape()).not.toBeNull()
    expect(byTestId("passkey-leftover")?.querySelector("a")?.getAttribute("href")).toBe(
      "https://docs.zk.money/docs/passkeys#leftover-passkey",
    )
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(byTestId("passkey-leftover")).toBeNull()
  })

  it("leaves other refusals alone: no way out and no report link", async () => {
    as(UA.android, "/enter")
    await show(<PasskeyRefusal error={new errors.PhoneRequiredError()} onRetry={() => {}} />)
    expect(escape()).toBeNull()
    expect(byTestId("passkey-report")).toBeNull()
  })
})

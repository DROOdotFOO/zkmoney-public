import { act, StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  savings: false,
  unlocked: true,
  handle: "alice" as string | undefined,
  pending: false,
  owed: false,
  blocked: false,
  onboarded: true,
  launcher: false,
  phone: true,
  listeners: new Set<() => void>(),
  markAllRead: vi.fn(),
  logout: vi.fn(),
  /** Actions that must wait for the upgrade, and every action a press asked for. */
  upgrade: new Set<string>(),
  asked: [] as string[],
}))
vi.mock("../../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    state.asked.push(action)
    if (!state.upgrade.has(action)) run()
  },
}))
// Savings reads the booted profile, which this suite never boots.
vi.mock("../../src/features/savings/savingsGateway", () => ({
  useSavingsAvailable: () => state.savings,
}))
vi.mock("../../src/features/operations/operations", async () =>
  (await import("../support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("../../src/features/onboarding/openRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/onboarding/openRegistration")>()),
  openRegistration: () => null,
  useRegistrationTagChangeable: () => false,
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => state.owed,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  nameL1ContactsByEns: () => () => {},
  useCachedRecords: () => ({ records: [] }),
  useConfigValue: () => ({ value: true, setValue: async () => {} }),
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientInitialAvatar: () => null,
  Icon: () => null,
  Toast: ({ message, onDismiss }: { message: string; onDismiss: () => void }) => (
    <div data-testid="toast">
      {message}
      <button onClick={onDismiss}>Dismiss toast</button>
    </div>
  ),
  Spinner: () => null,
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
  ZkMoneyRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../../src/dev/demoFlag", () => ({ isDemoMode: () => false }))
vi.mock("../../src/features/identity/walletIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/identity/walletIdentity")>()),
  loadWalletIdentity: () => ({ handle: state.handle, address: "0x123", pending: state.pending }),
  loadOnboardedIdentity: () =>
    state.onboarded ? { handle: state.handle, address: "0x123", pending: state.pending } : null,
}))
vi.mock("../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => new Uint8Array([1]) }),
}))
vi.mock("../../src/platform/desktopBridge", () => ({
  getDesktopL1Bridge: () => (state.launcher ? { l1SubmitPath: "/bridge" } : null),
}))
vi.mock("../../src/features/scan/ScannerModal", () => ({
  ScannerModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Scan QR code">
      <button onClick={onClose}>Close scanner</button>
    </div>
  ),
}))
vi.mock("../../src/features/scan/scanPayload", () => ({ scanPayload: vi.fn() }))
vi.mock("../../src/features/identity/logout", () => ({ logout: state.logout }))
vi.mock("../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/onboarding/webRegistration")>()),
  isLogoutBlockedByRegistration: () => state.blocked,
}))
vi.mock("../../src/features/contacts/TagSearchBar", () => ({
  TagSearchBar: ({
    autoFocus,
    onDismiss,
    placeholder,
  }: {
    autoFocus?: boolean
    onDismiss?: () => void
    placeholder?: string
  }) => (
    <input
      aria-label="Search @tag"
      autoFocus={autoFocus}
      placeholder={placeholder}
      onKeyDown={(e) => e.key === "Escape" && onDismiss?.()}
    />
  ),
}))
vi.mock("../../src/ui/LogoutModal", () => ({
  LogoutModal: ({ onConfirm }: { onConfirm: () => void }) => (
    <div role="dialog" aria-label="Log out">
      <button onClick={onConfirm}>Confirm logout</button>
    </div>
  ),
}))
vi.mock("../../src/ui/LogoutBlockedModal", () => ({
  LogoutBlockedModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Registration in progress">
      <button onClick={onClose}>OK</button>
    </div>
  ),
}))
import { SidebarLayout, useShellActions } from "../../src/ui/AppShell/AppShell"
import { MobileMenu } from "../../src/ui/MobileMenu"
import { activeNamespace, closeSession, switchSession } from "../../src/platform/session"
import { openTestSession } from "../support/session"

let host: HTMLDivElement
let root: Root
function Page() {
  const navigate = useNavigate()
  const { openMenu, openReceive, openScanner, scannerAvailable } = useShellActions()
  return (
    <>
      <button onClick={() => navigate("/contacts")}>Go to contacts</button>
      <button onClick={openMenu}>Page menu</button>
      <button onClick={openReceive}>Page Receive</button>
      {scannerAvailable && <button onClick={openScanner}>Page Scan</button>}
    </>
  )
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  )!
const click = (label: string) =>
  act(() => {
    button(label).focus()
    button(label).click()
  })
const menu = () => host.querySelector<HTMLDialogElement>("dialog")
const render = (
  path = "/",
  mobilePageHeaderPaths: readonly string[] = [],
  autoFocusContacts = false,
  enablePhoneScan = false,
) =>
  act(() => {
    // The session's account: unlocked, or none.
    openTestSession({ account: state.unlocked ? {} : null })
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            element={
              <SidebarLayout
                mobilePageHeaderPaths={mobilePageHeaderPaths}
                enablePhoneScan={enablePhoneScan}
              />
            }
          >
            <Route
              path="contacts"
              element={
                <>
                  {autoFocusContacts && <input aria-label="Contacts search" autoFocus />}
                  <Page />
                </>
              }
            />
            <Route
              path="activity"
              element={
                <>
                  {autoFocusContacts && <input aria-label="Activity search" autoFocus />}
                  <Page />
                </>
              }
            />
            <Route path="receive" element={<p>Receive page</p>} />
            <Route path="*" element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  })
beforeEach(async () => {
  state.upgrade = new Set()
  state.asked = []
  state.savings = false
  state.phone = true
  state.unlocked = true
  state.handle = "alice"
  state.pending = false
  state.owed = false
  state.blocked = false
  state.onboarded = true
  state.launcher = false
  state.listeners.clear()
  state.markAllRead.mockClear()
  state.logout.mockClear()
  // The bell over this suite's operations, with no records and no notification state.
  const { bell, notifications, milestones } = switchSession(activeNamespace())
  // Booted to the bell's milestones: its list is complete, so new entries toast.
  milestones.mark("firstBalance")
  milestones.mark("depositsReplayed")
  milestones.mark("historyAtHead")
  vi.spyOn(notifications, "markRead").mockImplementation(state.markAllRead)
  await vi.waitFor(() => expect(bell.get().sources.loaded).toBe(true))
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return state.phone
    },
    addEventListener: (_: string, fn: () => void) => state.listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => state.listeners.delete(fn),
  }))
  // Browser checks cover native focus containment, which jsdom does not implement.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  if (button("Notifications")?.getAttribute("aria-expanded") === "true") click("Notifications")
  act(() => root.unmount())
  host.remove()
  document.documentElement.style.overflow = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  closeSession()
})
describe("phone shell", () => {
  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])("keeps the primary action order when phone=%s savings=%s", (phone, savings) => {
    state.phone = phone
    state.savings = savings
    render()
    if (phone) click("Open menu")
    // Savings sits second, right after Home, wherever a deployment offers it.
    expect(
      [...host.querySelectorAll(".ww-sidebar__menu .ww-nav-item")].map((b) => b.textContent),
    ).toEqual([
      "Home",
      ...(savings ? ["Savings"] : []),
      "Deposit",
      ...(phone ? ["Requests", "Send"] : ["Send", "Requests"]),
      "Withdraw",
      "Activity",
      "Settings",
    ])
  })
  it.each([true, false])("highlights Savings, not Home, on /savings with phone=%s", (phone) => {
    state.phone = phone
    state.savings = true
    render("/savings")
    if (phone) click("Open menu")
    const active = [...host.querySelectorAll(".ww-sidebar__menu .ww-nav-item--active")]
    expect(active.map((b) => b.textContent)).toEqual(["Savings"])
    expect(active[0].getAttribute("aria-current")).toBe("page")
    if (phone) expect(host.querySelector('.ww-tabbar [aria-current="page"]')).toBeNull()
  })
  it("scopes the new Home composition to the exact phone Home route", () => {
    render("/send")
    expect(host.querySelector(".ww-shell--home")).toBeNull()
  })
  it("mounts the inline search field in the phone header", () => {
    render()
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search @tag"]')!
    expect(input).not.toBeNull()
    expect(input.placeholder).toBe("tag")
    expect(button("Open search")).toBeUndefined()
  })
  it("shows the tab bar on phone Home and navigates through it", () => {
    render()
    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".ww-tabbar button")]
    expect(tabs.map((b) => b.textContent)).toEqual([
      "Home",
      "Deposit",
      "Requests",
      "Send",
      "Withdraw",
    ])
    expect(tabs[0].getAttribute("aria-current")).toBe("page")
    expect(host.querySelector(".ww-shell--tabbar")).not.toBeNull()
    act(() => tabs[3].click())
    expect(host.querySelector('.ww-tabbar [aria-current="page"]')?.textContent).toBe("Send")
  })
  it("sends a money route to Deposit while the name waits for its deposit", () => {
    state.owed = true
    render()
    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".ww-tabbar button")]
    act(() => tabs[3].click())
    expect(host.querySelector('.ww-tabbar [aria-current="page"]')?.textContent).toBe("Deposit")
  })
  it("asks to upgrade before a money route, Requests or Receive, and opens every other route", () => {
    state.upgrade = new Set(["deposit", "requests", "send", "withdraw", "receive"])
    render()
    const tabs = [...host.querySelectorAll<HTMLButtonElement>(".ww-tabbar button")]
    for (const tab of tabs) act(() => tab.click())
    expect(host.querySelector('.ww-tabbar [aria-current="page"]')?.textContent).toBe("Home")
    click("Open menu")
    click("Receive code")
    expect(host.textContent).not.toContain("Receive page")
    expect(state.asked).toEqual(["deposit", "requests", "send", "withdraw", "receive"])
  })
  it("leaves a locked wallet's money routes to their own gates", () => {
    state.upgrade = new Set(["send", "receive"])
    state.unlocked = false
    state.phone = false
    render()
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Send",
    )!
    act(() => send.click())
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Send")
    expect(state.asked).toEqual([])
  })
  it("keeps the tab bar off desktop", () => {
    state.phone = false
    render()
    expect(host.querySelector(".ww-tabbar")).toBeNull()
  })
  it("enters the menu and restores focus and scrolling on Escape", () => {
    document.documentElement.style.overflow = "clip"
    render()
    click("Open menu")
    expect(menu()?.open).toBe(true)
    expect(document.documentElement.style.overflow).toBe("hidden")
    expect(document.activeElement).toBe(button("Close menu"))
    act(() => menu()!.dispatchEvent(new Event("cancel", { cancelable: true })))
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("clip")
    expect(document.activeElement).toBe(button("Open menu"))
  })
  it("releases the menu before Receive opens", () => {
    render()
    click("Open menu")
    click("Receive code")
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("")
    expect(host.textContent).toContain("Receive page")
  })
  it("keeps working menu navigation until its page header opts in", () => {
    render()
    click("Open menu")
    click("Activity")
    expect(menu()).toBeNull()
    expect(host.querySelector('input[aria-label="Search @tag"]')).not.toBeNull()
    click("Open menu")
    expect(button("Home, @alice.zk.money")).toBeDefined()
    click("Home, @alice.zk.money")
    expect(menu()).toBeNull()
    expect(host.querySelector('.ww-tabbar [aria-current="page"]')?.textContent).toBe("Home")
  })
  it("lets an exact page path own the phone header", () => {
    render("/contacts", ["/contacts"])
    expect(host.querySelector('input[aria-label="Search @tag"]')).toBeNull()
    expect(button("Open menu")).toBeUndefined()
    expect(host.querySelector(".ww-tabbar")).toBeNull()
    click("Page menu")
    expect(menu()?.open).toBe(true)
  })
  it("keeps the shell header on contact detail paths", () => {
    render("/contacts/alice", ["/contacts"])
    expect(button("Open menu")).toBeDefined()
    expect(host.querySelector('input[aria-label="Search @tag"]')).not.toBeNull()
  })
  it("preserves focus requested by the destination page", () => {
    render("/", [], true)
    click("Open menu")
    click("Activity")
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Activity search"]'))
  })
  it("cleans up across the breakpoint and keeps desktop Contacts search", () => {
    render("/contacts", ["/contacts"])
    click("Page menu")
    act(() => {
      state.phone = false
      state.listeners.forEach((fn) => fn())
    })
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("")
    expect(host.querySelector("input")).not.toBeNull()
    expect(document.activeElement).toBe(button("Page menu"))
    act(() => {
      state.phone = true
      state.listeners.forEach((fn) => fn())
    })
    expect(menu()).toBeNull()
    expect(host.querySelector("input")).toBeNull()
  })
  it("does not expose identity, notifications or search above the phone unlock gate", () => {
    state.unlocked = false
    render()
    expect(host.querySelector('input[aria-label="Search @tag"]')).toBeNull()
    expect(button("Notifications")).toBeUndefined()
    expect(host.querySelector(".ww-tabbar")).toBeNull()
    expect(button("Open menu")).toBeDefined()
    click("Open menu")
    expect(button("Home, @alice.zk.money")).toBeUndefined()
    expect(host.querySelector(".ww-sidebar .ww-brand")).not.toBeNull()
  })
  it("keeps the brand lockup and menu on locked Contacts until its page can render", () => {
    state.unlocked = false
    render("/contacts", ["/contacts"])
    expect(host.querySelector(".ww-shell-header .ww-brand")).not.toBeNull()
    expect(host.querySelector('input[aria-label="Search @tag"]')).toBeNull()
    expect(button("Notifications")).toBeUndefined()
    click("Open menu")
    expect(menu()?.open).toBe(true)
    expect(button("Log out")).toBeDefined()
    click("Close menu")
    state.unlocked = true
    render("/contacts", ["/contacts"])
    expect(host.querySelector(".ww-shell-header")).toBeNull()
  })
  it("unmounts the search field when the account locks", () => {
    render()
    expect(host.querySelector('input[aria-label="Search @tag"]')).not.toBeNull()
    state.unlocked = false
    render()
    expect(host.querySelector('input[aria-label="Search @tag"]')).toBeNull()
  })
  it.each(["Open menu", "Page Receive"])(
    "marks notifications read when %s closes the panel",
    (action) => {
      render()
      click("Notifications")
      expect(state.markAllRead).not.toHaveBeenCalled()
      click(action)
      expect(host.querySelector(".ww-notifications")).toBeNull()
      expect(state.markAllRead).toHaveBeenCalledTimes(1)
    },
  )
  it("toasts a new ended operation once", async () => {
    const { getOperationStore } = await import("../../src/features/operations/operations")
    const store = getOperationStore() as unknown as {
      begin(r: object): Promise<void>
      settle(id: string, hash?: string): Promise<void>
      remove(id: string): Promise<void>
      dismiss(id: string): Promise<void>
    }
    render()
    await act(async () => {
      await store.begin({
        operationId: "op-toast",
        flow: "send",
        summary: "$2 to @bo",
        scope: null,
      })
      await store.settle("op-toast", "0x02")
    })
    const toasts = () => host.querySelectorAll('[data-testid="toast"]')
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].textContent).toContain("Sent: $2 to @bo")
    click("Dismiss toast")
    await act(async () => {
      await store.begin({ operationId: "op-other", flow: "send", summary: "$3", scope: null })
      await store.remove("op-other")
    })
    expect(toasts()).toHaveLength(0)
    await act(async () => store.dismiss("op-toast"))
  })
  it("rings the bell for a sent transaction this page no longer runs", async () => {
    const { getOperationStore } = await import("../../src/features/operations/operations")
    const store = getOperationStore() as unknown as {
      begin(r: object): Promise<void>
      markSent(id: string, hash: string): Promise<void>
      release(id: string): void
      remove(id: string): Promise<void>
    }
    await act(async () => {
      await store.begin({ operationId: "op-bell", flow: "send", summary: "$1", scope: null })
      await store.markSent("op-bell", "0x01")
      store.release("op-bell")
    })
    render()
    expect(host.querySelector(".ww-notifications__bell-ring.is-safe")).not.toBeNull()
    expect(button("Notifications, a transaction is finishing")).toBeDefined()
    await act(async () => store.remove("op-bell"))
    expect(host.querySelector(".ww-notifications__bell-ring")).toBeNull()
  })
  it("keeps phone focus order aligned with the visible header", () => {
    render()
    expect(
      [...host.querySelectorAll(".ww-topbar button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Notifications", "Open menu"])
    expect(button("Open menu").hasAttribute("aria-controls")).toBe(false)
    click("Open menu")
    expect(host.querySelector(`#${button("Open menu").getAttribute("aria-controls")}`)).toBe(menu())
  })
  it("restores scrolling and subscriptions when unmounted with the menu open", () => {
    render()
    click("Open menu")
    act(() => root.render(null))
    expect(document.documentElement.style.overflow).toBe("")
    expect(state.listeners.size).toBe(0)
  })
  it("ignores a queued replay close and nested events but reconciles a native menu close", async () => {
    const close = vi.fn()
    HTMLDialogElement.prototype.close = function () {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    }
    await act(async () =>
      root.render(
        <StrictMode>
          <MobileMenu open onClose={close}>
            <button aria-label="Close menu" />
            <dialog aria-label="Nested test" />
          </MobileMenu>
        </StrictMode>,
      ),
    )
    expect(menu()!.open).toBe(true)
    expect(close).not.toHaveBeenCalled()
    act(() =>
      host
        .querySelector('[aria-label="Nested test"]')!
        .dispatchEvent(new Event("close", { bubbles: true })),
    )
    expect(close).not.toHaveBeenCalled()
    await act(async () => menu()!.close())
    expect(close).toHaveBeenCalledOnce()
  })
})

describe("MobileMenu close animation", () => {
  let finish: () => void
  const proto = HTMLDialogElement.prototype as unknown as { getAnimations?: () => unknown[] }
  beforeEach(() => {
    const finished = new Promise<void>((resolve) => (finish = resolve))
    proto.getAnimations = () => [{ finished }]
  })
  afterEach(() => {
    delete proto.getAnimations
    vi.useRealTimers()
  })
  const show = (open: boolean) =>
    act(() =>
      root.render(
        <MobileMenu open={open} onClose={() => {}}>
          <button aria-label="Close menu" />
        </MobileMenu>,
      ),
    )

  it("stays mounted, marked closing, until its slide out ends", async () => {
    show(true)
    show(false)
    expect(menu()?.hasAttribute("data-closing")).toBe(true)
    await act(async () => finish())
    expect(menu()).toBeNull()
  })

  it("stays open when reopened mid-close, even once that slide ends", async () => {
    show(true)
    show(false)
    show(true)
    expect(menu()?.hasAttribute("data-closing")).toBe(false)
    await act(async () => finish())
    expect(menu()?.open).toBe(true)
  })

  it("closes after a second when the slide never reports its end", () => {
    vi.useFakeTimers()
    show(true)
    show(false)
    act(() => vi.advanceTimersByTime(999))
    expect(menu()).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(menu()).toBeNull()
  })
})

describe("phone scanner entry guards", () => {
  it("opens from a page opt-in only, never from the menu, and returns focus to its trigger", () => {
    render("/", [], false, true)
    click("Open menu")
    expect(button("Scan QR code")).toBeUndefined()
    click("Close menu")
    click("Page Scan")
    expect(host.querySelector('[role="dialog"][aria-label="Scan QR code"]')).not.toBeNull()
    click("Close scanner")
    expect(document.activeElement).toBe(button("Page Scan"))
  })
  it.each(["phone", "unlocked", "onboarded", "handle", "pending", "launcher"] as const)(
    "does not expose Scan when %s fails its gate",
    (gate) => {
      if (gate === "handle") state.handle = undefined
      else if (gate === "pending" || gate === "launcher") state[gate] = true
      else state[gate] = false
      render("/", [], false, true)
      if (state.phone) click("Open menu")
      expect(button("Scan QR code")).toBeUndefined()
      expect(button("Page Scan")).toBeUndefined()
      click("Page Receive")
      expect(host.textContent).toContain("Receive page")
    },
  )
  it("closes an active scanner when the wallet locks", () => {
    render("/", [], false, true)
    click("Page Scan")
    expect(host.querySelector('[aria-label="Scan QR code"]')).not.toBeNull()
    state.unlocked = false
    render("/", [], false, true)
    expect(host.querySelector('[aria-label="Scan QR code"]')).toBeNull()
  })
})

describe("logout gate", () => {
  const dialog = (label: string) => host.querySelector(`[role="dialog"][aria-label="${label}"]`)
  const openLogout = () => {
    click("Open menu")
    click("Log out")
  }

  it("confirms and logs out when no claim is in flight", () => {
    render()
    openLogout()
    expect(menu()).toBeNull()
    expect(dialog("Log out")).not.toBeNull()
    expect(dialog("Registration in progress")).toBeNull()
    click("Confirm logout")
    expect(state.logout).toHaveBeenCalledTimes(1)
  })

  it("refuses while a claim is in flight and never reaches logout", () => {
    state.blocked = true
    render()
    openLogout()
    expect(menu()).toBeNull()
    expect(dialog("Registration in progress")).not.toBeNull()
    expect(dialog("Log out")).toBeNull()
    click("OK")
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(state.logout).not.toHaveBeenCalled()
  })

  it("reads the claim at the click, not at the last render", () => {
    render()
    click("Open menu")
    state.blocked = true
    click("Log out")
    expect(dialog("Registration in progress")).not.toBeNull()
    click("OK")
    click("Open menu")
    state.blocked = false
    click("Log out")
    expect(dialog("Log out")).not.toBeNull()
  })

  it("keeps the open popup when the claim settles underneath it", () => {
    state.blocked = true
    render()
    openLogout()
    state.blocked = false
    render()
    expect(dialog("Registration in progress")).not.toBeNull()
    expect(dialog("Log out")).toBeNull()
    click("OK")
    openLogout()
    expect(dialog("Log out")).not.toBeNull()
  })

  it("leaves a locked wallet's Log out alone even with a claim in flight", () => {
    state.unlocked = false
    state.blocked = true
    render()
    openLogout()
    expect(dialog("Log out")).not.toBeNull()
    click("Confirm logout")
    expect(state.logout).toHaveBeenCalledTimes(1)
  })
})

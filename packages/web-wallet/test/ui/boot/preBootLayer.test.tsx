/**
 * A first-time visitor's first screen while the wallet starts. On an origin with nothing stored the
 * landing and a payment link's page show before the PXE, look exactly as the wallet will draw them,
 * and hand any tap that needs the wallet to the screen that follows.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentLink } from "../../../src/features/paylink/types"

const h = vi.hoisted(() => ({
  fresh: true as boolean | undefined,
  shown: false,
  apy: { settled: true, apy: 0.045 } as { settled: boolean; apy?: number },
  prefetchOffer: vi.fn(),
  offer: undefined as
    | { threshold: string; schedule: { fee: string; minDeposit: string } }
    | null
    | undefined,
}))

vi.mock("../../../src/platform/storage/freshOrigin", () => ({ useOriginWasFresh: () => h.fresh }))
vi.mock("../../../src/ui/PxeBoot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/PxeBoot")>()),
  useFirstScreenShown: () => h.shown,
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({
    network: "sandbox",
    rpId: "localhost",
    endpoints: {
      node: { isDefault: true },
      l1Rpc: { isDefault: true },
      enclave: { isDefault: true },
    },
  }),
}))
vi.mock("../../../src/features/savings/savingsGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/savings/savingsGateway")>()),
  useLiveSavingsApy: () => h.apy,
}))
const LINK: PaymentLink = {
  fragment: "frag",
  flavor: "direct",
  status: "unclaimed",
  amount: "",
} as PaymentLink
vi.mock("../../../src/features/paylink/linkStatus", () => ({
  seededLink: (fragment: string) => {
    if (fragment === "bad") throw new Error("malformed")
    return { ...LINK, fragment }
  },
}))
// The page's reads, all still pending: what the wallet's first frame of the page renders.
vi.mock("../../../src/features/paylink/usePaylinkDeps", () => ({
  useLinkVoucher: () => ({ uses: undefined, deps: undefined, error: undefined, retry: vi.fn() }),
  useLinkWithdrawal: () => undefined,
}))
vi.mock("../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: h.offer, failed: false, retry: vi.fn() }),
  usePrefetchedGoldenTicketOffer: () => h.offer,
  prefetchGoldenTicketOffer: h.prefetchOffer,
}))
vi.mock("../../../src/features/paylink/chainTime", () => ({
  usePolledChainSeconds: () => undefined,
}))
vi.mock("../../../src/features/paylink/ticketContinuation", () => ({
  ticketSignupCommitted: () => false,
  ticketSignupResumable: () => false,
}))
vi.mock("../../../src/ui/NotificationsPanel/NotificationsPanel", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/ui/NotificationsPanel/NotificationsPanel")
  >()),
  useNotificationList: () => ({
    entries: [],
    hydrated: true,
    unreadCount: 0,
    opened: vi.fn(),
    markAllRead: vi.fn(async () => {}),
  }),
  useRouteOpener: () => () => null,
}))
vi.mock("../../../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/operations/operations")>()),
  useOperationsInProgress: () => [],
  useTabBoundOperation: () => undefined,
}))
vi.mock("../../../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: () => null,
}))
vi.mock("../../../src/features/paylink/ClaimToL1Modal", () => ({ ClaimToL1Modal: () => null }))
vi.mock("../../../src/features/paylink/paylinkExit", () => ({ cashOutLink: vi.fn() }))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  fireOnboardingEvent: vi.fn(),
  reportLanding: vi.fn(),
}))

import { PreBootLayer } from "../../../src/ui/PreBootLayer"
import { PaylinkVisitorScreen } from "../../../src/features/paylink/PaylinkVisitorScreen"
import { ShellRoot } from "../../../src/ui/AppShell/AppShell"
import { openTestSession } from "../../support/session"
import {
  __resetPreBootTapsForTests,
  applyPreBootNavigation,
  peekPreBootCreate,
  PreBootRouterBridge,
} from "../../../src/ui/preBootTaps"

let host: HTMLDivElement
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement("div")
  host.id = "pre-boot"
  container = document.createElement("div")
  document.body.append(host, container)
  root = createRoot(container)
  h.fresh = true
  h.shown = false
  h.apy = { settled: true, apy: 0.045 }
  h.prefetchOffer.mockClear()
  h.offer = undefined
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  container.remove()
  __resetPreBootTapsForTests()
  window.history.replaceState(null, "", "/")
  sessionStorage.clear()
})

async function mountAt(url: string) {
  window.history.replaceState(null, "", url)
  await act(async () => root.render(<PreBootLayer />))
}

const button = (label: string, within: ParentNode = host) =>
  Array.from(within.querySelectorAll("button")).find((b) => b.textContent?.includes(label))

describe("the landing before the wallet is up", () => {
  it("shows on a fresh origin, ahead of the PXE", async () => {
    await mountAt("/")
    expect(host.textContent).toContain("Money that moves privately")
    expect(host.querySelector('[data-testid="create-wallet"]')).not.toBeNull()
    expect(container.textContent).toBe("")
  })

  it("is the /claim landing too, but not a resumed or recovery visit", async () => {
    await mountAt("/claim")
    expect(host.textContent).toContain("Create Account")
    act(() => root.unmount())
    root = createRoot(container)
    await mountAt("/claim?resume=1")
    expect(host.textContent).toBe("")
  })

  it("waits on the boot screen while the live rate is read, as the landing does", async () => {
    h.apy = { settled: false }
    await mountAt("/")
    expect(host.childNodes.length).toBe(0)
  })

  it("does not wait for the rate on a screen too narrow for the cards", async () => {
    h.apy = { settled: false }
    // Narrower than the cards' 960px, wider than a phone: no query matches.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    try {
      await mountAt("/")
      expect(host.textContent).toContain("Money that moves privately")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("never shows where something is stored, or until that is known", async () => {
    h.fresh = false
    await mountAt("/")
    expect(host.childNodes.length).toBe(0)
    act(() => root.unmount())
    root = createRoot(container)
    h.fresh = undefined
    await mountAt("/")
    expect(host.childNodes.length).toBe(0)
  })

  it("never shows over a signup this tab already began", async () => {
    sessionStorage.setItem("obsidion.drawn-offer", "brisk-otter")
    try {
      await mountAt("/")
      expect(host.childNodes.length).toBe(0)
    } finally {
      sessionStorage.removeItem("obsidion.drawn-offer")
    }
  })

  it("gives way once the wallet draws its first screen", async () => {
    await mountAt("/")
    expect(host.textContent).toContain("Create Account")
    h.shown = true
    await act(async () => root.render(<PreBootLayer key="again" />))
    expect(host.childNodes.length).toBe(0)
  })

  it("holds Create Account busy for the wallet, and Cancel lets it go", async () => {
    await mountAt("/")
    await act(async () => button("Create Account")!.click())
    expect(peekPreBootCreate()).toBe(true)
    expect(button("Cancel")).toBeDefined()
    expect(host.textContent).not.toContain("I already have an account")
    await act(async () => button("Cancel")!.click())
    expect(peekPreBootCreate()).toBe(false)
    expect(host.textContent).toContain("I already have an account")
  })

  it("hands Log in to the wallet's router, which opens on the sign-in", async () => {
    await mountAt("/")
    await act(async () => button("Log in")!.click())
    // The boot screen shows while the wallet starts on the route.
    expect(host.childNodes.length).toBe(0)
    expect(window.location.pathname).toBe("/")
    applyPreBootNavigation()
    expect(window.location.pathname).toBe("/enter")
  })

  it("stays up when its wordmark links to the landing it already is", async () => {
    await mountAt("/claim")
    await act(async () => host.querySelector<HTMLAnchorElement>("a.ww-brand")!.click())
    expect(host.textContent).toContain("Create Account")
    applyPreBootNavigation()
    expect(window.location.pathname).toBe("/")
  })

  it("navigates through the wallet's router once it is up", async () => {
    const app = document.createElement("div")
    document.body.append(app)
    const appRoot = createRoot(app)
    try {
      await act(async () =>
        appRoot.render(
          <MemoryRouter initialEntries={["/claim"]}>
            <PreBootRouterBridge />
            <LocationProbe />
          </MemoryRouter>,
        ),
      )
      await mountAt("/claim")
      await act(async () => button("Log in")!.click())
      expect(app.querySelector("[data-path]")?.getAttribute("data-path")).toBe("/enter")
      expect(host.childNodes.length).toBe(0)
    } finally {
      act(() => appRoot.unmount())
      app.remove()
    }
  })
})

describe("a payment link before the wallet is up", () => {
  // The wallet's own page, drawn beside the early one, runs in a session whose wallet is not up.
  beforeEach(() => void openTestSession())

  it("shows the page with every read pending, and reads the ticket offer now", async () => {
    await mountAt("/link#frag")
    expect(host.textContent).toContain("Someone sent you")
    expect(host.textContent).toContain("Choose how to receive payment")
    expect(host.textContent).toContain("Checking what this link pays for…")
    expect(host.textContent).toContain("Checking availability…")
    expect(button("Receive to zk.money")!.disabled).toBe(true)
    expect(button("Claim to an Ethereum wallet")!.disabled).toBe(true)
    expect(h.prefetchOffer).toHaveBeenCalledTimes(1)
  })

  it("is drawn exactly as the wallet draws the page before its reads", async () => {
    await mountAt("/link#frag")
    const early = host.innerHTML
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/link#frag"]}>
          <ShellRoot>
            <PaylinkVisitorScreen
              link={{ ...LINK, fragment: "frag" }}
              statusSettled={false}
              onRetryStatus={() => {}}
            />
          </ShellRoot>
        </MemoryRouter>,
      ),
    )
    expect(container.innerHTML).toBe(early)
  })

  it("flags the private way in as soon as the ticket offer is read, as the page does", async () => {
    h.offer = { threshold: "1000", schedule: { fee: "1", minDeposit: "2" } }
    await mountAt("/link#frag")
    const early = host.innerHTML
    expect(button("Receive to zk.money")!.textContent).toContain("Private")
    expect(host.textContent).toContain("Checking what this link pays for…")
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/link#frag"]}>
          <ShellRoot>
            <PaylinkVisitorScreen
              link={{ ...LINK, fragment: "frag" }}
              statusSettled={false}
              onRetryStatus={() => {}}
            />
          </ShellRoot>
        </MemoryRouter>,
      ),
    )
    expect(container.innerHTML).toBe(early)
  })

  it("draws a link this tab already saw closed as closed", async () => {
    window.history.replaceState(null, "", "/link#frag")
    LINK.status = "claimed"
    try {
      await mountAt("/link#frag")
      expect(host.textContent).not.toContain("Choose how to receive payment")
      expect(host.textContent).toContain("This link is no longer available")
    } finally {
      LINK.status = "unclaimed"
    }
  })

  it("leaves a link that does not decode to its error card", async () => {
    await mountAt("/link#bad")
    expect(host.childNodes.length).toBe(0)
  })

  it("hands Log in and the wordmark's way home to the wallet's router", async () => {
    await mountAt("/link#frag")
    await act(async () => button("Log in")!.click())
    expect(host.childNodes.length).toBe(0)
    applyPreBootNavigation()
    expect(window.location.pathname).toBe("/enter")
    // The sign-in knows which link it claims.
    expect(sessionStorage.getItem("obsidion.pending-claim")).toBe("frag")

    __resetPreBootTapsForTests()
    act(() => root.unmount())
    root = createRoot(container)
    await mountAt("/link#frag")
    await act(async () => host.querySelector<HTMLAnchorElement>("a.ww-brand")!.click())
    applyPreBootNavigation()
    expect(window.location.pathname).toBe("/")
  })
})

import { useLocation } from "react-router-dom"
function LocationProbe() {
  return <span data-path={useLocation().pathname} />
}

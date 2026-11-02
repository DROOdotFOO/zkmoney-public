/**
 * What a visitor with no account is offered on `/link#…`.
 *
 * The fork is the point: a link that can pay its own way out asks how they want the money, and one
 * that cannot must not offer a cash-out it can't fund. The signup path is unchanged for every link
 * without a voucher, which is every link created before this shipped.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { captureLandingSource, landingAttribution } from "../../../../src/lib/trafficSource"

/** Per-test voucher answer: undefined = the chain read is still in flight. */
const voucher: { uses: number | undefined; deps: unknown; error?: string; retry: () => void } = {
  uses: 0,
  deps: { _id: "deps" },
  retry: vi.fn(),
}
/** A cash-out this browser already made for the link under test. */
const withdrawal: { record: unknown } = { record: undefined }
/** What the bell was handed: how it opens entries, and which it shows. */
const bell: {
  openEntry?: (entry: unknown) => (() => void) | null
  scope?: { entry: (entry: unknown) => boolean; operation: (id: string) => boolean }
} = {}
const stashClaimLink = vi.fn()
const fireEvent = vi.fn()
const fireOnboardingEvent = vi.fn()
const reportLanding = vi.fn()

vi.mock("../../../../src/features/paylink/usePaylinkDeps", () => ({
  useLinkVoucher: () => voucher,
  useLinkWithdrawal: () => withdrawal.record,
  usePaylinkKit: () => undefined,
}))
const stashTicketSignup = vi.fn()
const clearTicketSignup = vi.fn()
/** The ticket signup marker: set by stashTicketSignup, read back by the screen. */
let ticketStashed = false
/** A marker this tab saved before a reload. */
const saved: { value: Record<string, unknown> | null } = { value: null }
/** The network's offer: null = no tickets, undefined = still loading, or failed with a retry. */
const offer: {
  value: { threshold: string; schedule: { fee: string; minDeposit: string } } | null | undefined
  failed: boolean
  retry: () => void
} = {
  value: null,
  failed: false,
  retry: vi.fn(),
}
vi.mock("../../../../src/features/paylink/claimStash", async (importOriginal) => ({
  receivesToAccount: (
    await importOriginal<typeof import("../../../../src/features/paylink/claimStash")>()
  ).receivesToAccount,
  stashClaimLink,
  stashTicketSignup: (...args: unknown[]) => {
    ticketStashed = true
    return stashTicketSignup(...args)
  },
  clearTicketSignup,
  peekTicketSignup: () => saved.value ?? (ticketStashed ? { fragment: "frag" } : null),
}))
vi.mock("../../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: offer.value, failed: offer.failed, retry: offer.retry }),
}))
/** Whether the link's ticket already bought a registration on this tab. */
const committed = { value: false }
/** Whether the link's ticket signup already has a registration or a saved account. */
const resumable = { value: false }
/** This browser already saw the link's ticket refused as spent. */
const spent = { value: false }
vi.mock("../../../../src/features/paylink/ticketSpent", () => ({
  ticketKnownSpent: () => spent.value,
}))
vi.mock("../../../../src/features/paylink/ticketContinuation", () => ({
  ticketSignupCommitted: () => committed.value,
  ticketSignupResumable: () => resumable.value,
}))
/** L2 tip seconds; undefined = the clock has not been read. Links default to an open window. */
const chain: { now: number | undefined } = { now: 1_000 }
vi.mock("../../../../src/features/paylink/chainTime", () => ({
  usePolledChainSeconds: () => chain.now,
}))
await (await import("../../../support/seedBootConfig")).seedBootConfig()
/** The router state the page opened with: a signup elsewhere may have chosen its account. */
const route = vi.hoisted(() => ({ state: null as unknown }))
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: route.state }),
}))
vi.mock("../../../../src/features/paylink/ClaimProgressModal", () => ({
  ClaimProgressModal: ({ record }: { record: { localId: string } }) => (
    <div data-testid="receipt">{record.localId}</div>
  ),
  hasClaimReceipt: (record: { phase: string }) => record.phase === "done",
}))
vi.mock("../../../../src/ui/NotificationsBell/NotificationsBell", () => ({
  NotificationsBell: (props: typeof bell) => {
    Object.assign(bell, props)
    return <div data-testid="bell" />
  },
}))
vi.mock("../../../../src/lib/analytics", () => ({ fireEvent, fireOnboardingEvent, reportLanding }))
vi.mock("../../../../src/features/paylink/paylinkExit", () => ({ cashOutLink: vi.fn() }))
vi.mock("../../../../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum", badge: "pending" }),
}))
vi.mock("../../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({
    actions,
    children,
  }: {
    actions?: React.ReactNode
    children?: React.ReactNode
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}))
vi.mock("../../../../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: ({
    inviteHeader,
    onExit,
    ticketSignup,
  }: {
    inviteHeader?: React.ReactNode
    onExit?: () => void
    ticketSignup?: boolean
  }) => (
    <div data-testid={ticketSignup ? "ticket-signup" : "signup"}>
      {inviteHeader}
      {onExit && <button onClick={onExit}>exit</button>}
    </div>
  ),
}))
vi.mock("../../../../src/features/paylink/ClaimToL1Modal", () => ({
  ClaimToL1Modal: ({
    onClose,
    onClaimInstead,
  }: {
    onClose: () => void
    onClaimInstead?: () => void
  }) => (
    <div data-testid="cash-out">
      <button onClick={onClose}>close</button>
      {onClaimInstead && <button onClick={onClaimInstead}>claim instead</button>}
    </div>
  ),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about which CTA appears.
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Shimmer: ({ children }: { children?: React.ReactNode }) => <div data-skeleton>{children}</div>,
  Spinner: () => <div data-testid="spinner" />,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { PaylinkVisitorScreen } = await import(
  "../../../../src/features/paylink/PaylinkVisitorScreen"
)
const { closeSession } = await import("../../../../src/platform/session")
const { openTestSession } = await import("../../../support/session")

const link = (over: Record<string, unknown> = {}) =>
  ({
    url: "http://test/link#frag",
    fragment: "frag",
    amount: "25",
    status: "unclaimed",
    flavor: "direct",
    claimableFrom: 0,
    ...over,
  } as never)

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  ticketStashed = false
  saved.value = null
  spent.value = false
  committed.value = false
  resumable.value = false
  route.state = null
  offer.value = null
  offer.failed = false
  voucher.error = undefined
  voucher.uses = 0
  voucher.deps = { _id: "deps" }
  withdrawal.record = undefined
  bell.openEntry = undefined
  bell.scope = undefined
  chain.now = 1_000
  // A visitor's session; the wallet is not up unless a test says so.
  closeSession()
  openTestSession()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type Props = Parameters<typeof PaylinkVisitorScreen>[0]
const render = (props: Omit<Props, "onRetryStatus"> & Partial<Props>) =>
  act(() => root.render(<PaylinkVisitorScreen onRetryStatus={vi.fn()} {...props} />))

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))

const testId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe("PaylinkVisitorScreen", () => {
  it("keeps a failed email eligibility check out of signup and offers retry", () => {
    voucher.uses = undefined
    voucher.error = "Could not check withdrawal availability"
    render({ link: link({ flavor: "email" }) })
    expect(testId("signup")).toBeNull()
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    expect(button("Receive to zk.money")).toBeTruthy()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not check")
    act(() => button("Try again")!.click())
    expect(voucher.retry).toHaveBeenCalledOnce()
  })

  it("withholds the Ethereum claim until its window is known to be open", () => {
    voucher.uses = 1
    chain.now = undefined
    render({ link: link() })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)

    chain.now = 1_000
    render({ link: link({ claimableFrom: 1_000 }) })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    expect(button("Claim to an Ethereum wallet")?.textContent).toContain("Ready to claim in 0:30")

    render({ link: link({ claimableFrom: 970 }) })
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(false)
  })

  it("on a network that issues tickets, the link pays for the signup: the three-step modal opens over this page", () => {
    voucher.uses = 1
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link({ memo: "Pizza dinner", senderTag: "river" }) })
    // The link pays fees out of the payment, so the option promises privacy and speed, never "free".
    expect(container.textContent).toContain("Instant. Your balance stays private.")
    expect(container.textContent).not.toContain("Free and instant")

    act(() => button("Receive to zk.money")!.click())

    expect(stashTicketSignup).toHaveBeenCalledWith({
      fragment: "frag",
      threshold: "1",
      schedule: { fee: "5", minDeposit: "0" },
      memo: "Pizza dinner",
      senderTag: "river",
      // The page's own read of the note, in base units, so the signup's split is priced at once.
      amount: (25n * 10n ** 18n).toString(),
      // The claim window as read here, so Home claims without reading the note again.
      claimableFrom: 0,
    })
    expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
      choice: "account",
      ticket: true,
    })
    expect(testId("ticket-signup")).toBeTruthy()
    expect(testId("signup")).toBeNull()
    // The choice stays behind the modal, inert, and closing the first step returns to it.
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    expect(button("Claim to an Ethereum wallet")?.disabled).toBe(true)
    act(() => button("exit")!.click())
    expect(testId("ticket-signup")).toBeNull()
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    // Nothing was committed: the ticket intent goes, the link stays stashed for Home.
    expect(clearTicketSignup).toHaveBeenCalledOnce()
    expect(stashClaimLink).toHaveBeenCalledWith("frag")
  })

  it("with a ticket on offer, the account option waits for the voucher read; a signup then keeps its page", () => {
    voucher.uses = undefined
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    // The ticket's claim is paid by the voucher, so the option promises nothing before the read.
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    expect(container.textContent).toContain("Checking what this link pays for")
    act(() => button("Receive to zk.money")!.click())
    expect(testId("ticket-signup")).toBeNull()

    voucher.uses = 1
    render({ link: link() })
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    expect(container.textContent).toContain("Instant. Your balance stays private.")
    act(() => button("Receive to zk.money")!.click())
    expect(testId("ticket-signup")).toBeTruthy()
    expect(stashTicketSignup).toHaveBeenCalledOnce()

    // A read that later answers none does not swap the wizard under the visitor.
    voucher.uses = 0
    render({ link: link() })
    expect(testId("ticket-signup")).toBeTruthy()
    expect(testId("signup")).toBeNull()
    expect(clearTicketSignup).not.toHaveBeenCalled()
  })

  it("a spent voucher opens the ordinary signup even with a ticket on offer", () => {
    voucher.uses = 0
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    expect(testId("signup")).toBeTruthy()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())
  })

  it("leaving the page before the tag is claimed drops the ticket intent; a bought registration keeps it", () => {
    voucher.uses = 1
    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    act(() => root.render(<div />))
    expect(clearTicketSignup).toHaveBeenCalledOnce()

    clearTicketSignup.mockClear()
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    committed.value = true
    act(() => root.render(<div />))
    expect(clearTicketSignup).not.toHaveBeenCalled()
  })

  it("holds the account choice until the ticket offer is read, then honours a late offer", () => {
    voucher.uses = 1
    offer.value = undefined
    render({ link: link() })
    expect(container.textContent).toContain("Checking what this link pays for")
    expect(container.textContent).not.toContain("Instant. Your balance")
    expect(button("Receive to zk.money")?.disabled).toBe(true)
    act(() => button("Receive to zk.money")!.click())
    expect(testId("signup")).toBeNull()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(clearTicketSignup).not.toHaveBeenCalled()

    offer.value = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    render({ link: link() })
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    act(() => button("Receive to zk.money")!.click())
    expect(stashTicketSignup).toHaveBeenCalledOnce()
    expect(testId("ticket-signup")).toBeTruthy()
  })

  it("a failed offer read offers retry, and never starts the paid signup on a guess", () => {
    voucher.uses = 1
    offer.value = undefined
    offer.failed = true
    render({ link: link() })
    expect(container.textContent).toContain("Couldn't check what this link pays for")
    expect(container.textContent).not.toContain("Instant. Your balance")
    expect(button("Receive to zk.money")?.disabled).toBe(false)
    act(() => button("Receive to zk.money")!.click())
    expect(offer.retry).toHaveBeenCalledOnce()
    expect(testId("signup")).toBeNull()
    expect(testId("ticket-signup")).toBeNull()
    expect(stashTicketSignup).not.toHaveBeenCalled()
    expect(clearTicketSignup).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())

    // The retry settled on a confirmed absence: the ordinary signup is the right answer now.
    offer.failed = false
    offer.value = null
    render({ link: link() })
    act(() => button("Receive to zk.money")!.click())
    expect(clearTicketSignup).toHaveBeenCalledOnce()
    expect(testId("signup")).toBeTruthy()
  })

  describe("the ticket start on the signup stream", () => {
    const TICKET_OFFER = { threshold: "1", schedule: { fee: "5", minDeposit: "0" } }
    const starts = () =>
      fireOnboardingEvent.mock.calls.filter(([event]) => event === "onboarding_started")

    it("reports a redeemable offer once per mount, before any choice", () => {
      voucher.uses = 1
      offer.value = TICKET_OFFER
      render({ link: link() })
      expect(starts()).toEqual([["onboarding_started", { entry: "ticket" }]])
      render({ link: link() })
      act(() => button("Receive to zk.money")!.click())
      expect(starts()).toHaveLength(1)
    })

    it("a reload that resumes a paid signup reports no second start, and stays the ticket's", () => {
      // The reload lands on /link again, which reads as a plain payment link.
      localStorage.clear()
      window.history.replaceState(null, "", "/link#frag")
      captureLandingSource()
      voucher.uses = 1
      offer.value = null
      resumable.value = true
      saved.value = { fragment: "frag", schedule: { fee: "5", minDeposit: "0" }, paid: true }
      render({ link: link() })
      expect(testId("ticket-signup")).toBeTruthy()
      expect(fireOnboardingEvent).not.toHaveBeenCalled()
      expect(landingAttribution().channel).toBe("ticket")
    })
  })

  describe("the ticket's threshold, checked before the signup starts", () => {
    const ONE = 10n ** 18n
    const ticketOffer = (threshold: bigint) => ({
      threshold: threshold.toString(),
      schedule: { fee: "5", minDeposit: "0" },
    })
    /** Nothing a ticket signup starts with happened. */
    const nothingStarted = () => {
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(clearTicketSignup).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("paylink_visitor_chose", expect.anything())
      expect(testId("ticket-signup")).toBeNull()
      expect(testId("signup")).toBeNull()
    }

    it("a note below the threshold keeps the ticket signup shut and names the minimum", () => {
      voucher.uses = 1
      offer.value = ticketOffer(30n * ONE)
      render({ link: link() })
      const account = button("Receive to zk.money")!
      expect(account.disabled).toBe(true)
      expect(account.textContent).toContain(
        "This payment is below the $30 minimum for a new account.",
      )
      expect(account.textContent).not.toContain("Instant. Your balance")
      act(() => account.click())
      nothingStarted()

      // The Ethereum claim is still there, without a way back into the signup.
      expect(button("Claim to an Ethereum wallet")?.disabled).toBe(false)
      act(() => button("Claim to an Ethereum wallet")!.click())
      expect(testId("cash-out")).toBeTruthy()
      expect(button("claim instead")).toBeUndefined()
      // The network does not pay this visitor's registration.
      expect(fireEvent).toHaveBeenCalledWith("paylink_visitor_chose", {
        choice: "ethereum",
        ticket: false,
      })
    })

    it("waits for the note's amount, then retries the status read that stopped without it", () => {
      voucher.uses = 1
      offer.value = ticketOffer(ONE)
      const onRetryStatus = vi.fn()
      const unread = link({ amount: undefined, claimableFrom: undefined })
      render({ link: unread, statusSettled: false, onRetryStatus })
      const account = () => button("Receive to zk.money")!
      expect(account().disabled).toBe(true)
      expect(account().textContent).toContain("Checking what this link pays for")
      expect(account().querySelector('[aria-busy="true"]')).toBeTruthy()
      act(() => account().click())
      nothingStarted()

      render({ link: unread, statusSettled: true, onRetryStatus })
      expect(account().disabled).toBe(false)
      expect(account().textContent).toContain("Couldn't check what this link pays for")
      act(() => account().click())
      expect(onRetryStatus).toHaveBeenCalledOnce()
      nothingStarted()

      render({ link: link(), onRetryStatus })
      act(() => account().click())
      expect(stashTicketSignup).toHaveBeenCalledOnce()
      expect(testId("ticket-signup")).toBeTruthy()
    })

    it.each([
      ["below the threshold", link()],
      ["not read", link({ amount: undefined })],
    ])(
      "a link whose ticket signup already bound an account goes straight back into it with the note %s",
      (_, open) => {
        voucher.uses = 1
        offer.value = ticketOffer(30n * ONE)
        resumable.value = true
        render({ link: open })
        expect(stashTicketSignup).toHaveBeenCalledOnce()
        expect(testId("ticket-signup")).toBeTruthy()
      },
    )

    it.each<[string, { paid?: boolean }, () => void]>([
      ["a paid signup, with a ticket now on offer", { paid: true }, () => {}],
      ["a ticket signup, with the voucher now read as spent", {}, () => (voucher.uses = 0)],
    ])("a reload resumes %s, in the mode it saved", (_, mode, arrange) => {
      voucher.uses = 1
      offer.value = ticketOffer(20n * ONE)
      resumable.value = true
      saved.value = { fragment: "frag", schedule: { fee: "5", minDeposit: "0" }, ...mode }
      arrange()
      render({ link: link() })
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(clearTicketSignup).not.toHaveBeenCalled()
      expect(testId("ticket-signup")).toBeTruthy()
    })

    it("a ticket known spent is no ticket: the account option opens the ordinary signup", () => {
      voucher.uses = 1
      offer.value = ticketOffer(20n * ONE)
      spent.value = true
      render({ link: link() })
      expect(container.textContent).not.toContain("Instant. Your balance")
      act(() => button("Receive to zk.money")!.click())
      expect(stashTicketSignup).not.toHaveBeenCalled()
      expect(testId("signup")).toBeTruthy()
    })

    it("a link sent here with the note below the threshold opens the same modal, at the name's own price", () => {
      voucher.uses = 1
      offer.value = ticketOffer(30n * ONE)
      route.state = { receive: "account" }
      render({ link: link() })
      expect(stashTicketSignup).toHaveBeenCalledWith(
        expect.objectContaining({
          fragment: "frag",
          paid: true,
          amount: (25n * ONE).toString(),
        }),
      )
      expect(stashTicketSignup.mock.calls[0][0]).not.toHaveProperty("threshold")
      expect(testId("ticket-signup")).toBeTruthy()
    })
  })

  it("the bell shows this link's cash-out only: a shared browser's other entries stay out", () => {
    voucher.uses = 0
    withdrawal.record = {
      localId: "w1",
      operationId: "op-mine",
      recipient: `0x${"dd".repeat(20)}`,
      phase: "finalizing_l1",
    }
    render({ link: link({ status: "claimed" }) })
    const withdrawalEntry = (sourceId: string) => ({
      id: `bridge:withdrawal:${sourceId}`,
      target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId },
    })
    const scope = bell.scope!
    expect(scope.entry(withdrawalEntry("w1"))).toBe(true)
    expect(scope.entry({ id: "operation:op-mine", target: { type: "transfer.pending" } })).toBe(
      true,
    )
    // Another visitor's cash-out on this browser, and everything that is not this cash-out.
    expect(scope.entry(withdrawalEntry("w0"))).toBe(false)
    expect(scope.entry({ id: "operation:op-other", target: { type: "transfer.pending" } })).toBe(
      false,
    )
    expect(
      scope.entry({
        id: "bridge:deposit:0xsipa",
        target: { type: "bridge.txDetail", bridgeKind: "deposit", sourceId: "w1" },
      }),
    ).toBe(false)
    expect(
      scope.entry({ id: "transfer:receive:0xabc", target: { type: "transfer.txDetail" } }),
    ).toBe(false)
    expect(scope.operation("op-mine")).toBe(true)
    expect(scope.operation("op-other")).toBe(false)
  })
})

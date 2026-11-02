/**
 * `/link#…` for a visitor with no account and no passkey: the page's status read and its voucher
 * read, run for real against a chain this PXE sees late or slowly. The Ethereum cash-out must be
 * offered once the link is readable, without the visitor tapping Try again.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const FRAGMENT = "frag-visitor"
const NOTE = { amount: "20", claimableFrom: 0, tokenAddress: "0xtoken", memo: "for the tickets" }
/**
 * The chain as this PXE sees it. `noteReadable`: a fresh escrow's note is discoverable a few blocks
 * late. `coldMs`: the escrow's first registration and note read, which every read of it waits on.
 */
const chain = { noteReadable: true, coldMs: 0 }
let escrow: Promise<void> | undefined
const escrowReady = () =>
  (escrow ??= new Promise<void>((resolve) => setTimeout(resolve, chain.coldMs)))

const linkShape = (fragment: string) => ({
  url: `http://test/link#${fragment}`,
  fragment,
  status: "unclaimed",
  flavor: "direct",
})
// viewLink swallows a failed note read and returns the link with no window.
const viewLink = vi.fn(async (_deps: unknown, fragment: string) => {
  await escrowReady()
  return { ...linkShape(fragment), ...(chain.noteReadable ? NOTE : {}) }
})
// Without the token the voucher read finds it in the escrow note, as the status read does.
const linkVoucherUses = vi.fn(async (_deps: unknown, _fragment: string, token?: string) => {
  await escrowReady()
  if (!token && !chain.noteReadable) throw new Error("sync_note: no PaylinkNote yet")
  return 1
})

vi.mock("../../../../src/features/paylink/sponsoredPaylink", () => ({
  decodeLink: (fragment: string) => linkShape(fragment),
  EmailPaylinkUnsupportedError: class extends Error {},
  viewLink: (...args: [unknown, string]) => viewLink(...args),
  emitLinkOpened: vi.fn(),
}))
vi.mock("../../../../src/features/paylink/paylinkExit", () => ({
  linkVoucherUses: (...args: [unknown, string, string?]) => linkVoucherUses(...args),
  linkWithdrawalIdentity: (fragment: string) => ({ id: `hash:${fragment}` }),
  cashOutLink: vi.fn(),
  planCashOutSwap: vi.fn(),
}))
vi.mock("../../../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [] }),
}))
// Stable identities: the screen and the hooks memoize their deps off these.
const CTX = {
  teeSigner: { _id: "signer" },
  wallet: { _id: "wallet", node: {}, networkId: "0xrollup" },
  cs: { contractService: { _id: "cs" } },
}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => CTX.cs,
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../../../src/features/identity/walletIdentity", () => ({
  loadOnboardedIdentity: () => null,
}))
vi.mock("../../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: null, failed: false, retry: vi.fn() }),
}))
vi.mock("../../../../src/features/paylink/ticketContinuation", () => ({
  ticketSignupCommitted: () => false,
  ticketSignupResumable: () => false,
}))
vi.mock("../../../../src/features/paylink/chainTime", () => ({
  usePolledChainSeconds: () => 10_000,
}))
await (await import("../../../support/seedBootConfig")).seedBootConfig()
vi.mock("../../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  fireOnboardingEvent: vi.fn(),
  reportLanding: vi.fn(),
}))
vi.mock("../../../../src/features/paylink/ClaimProgressModal", () => ({
  ClaimProgressModal: () => null,
  hasClaimReceipt: () => false,
}))
vi.mock("../../../../src/ui/NotificationsBell/NotificationsBell", () => ({
  NotificationsBell: () => null,
}))
vi.mock("../../../../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum", badge: "pending" }),
}))
vi.mock("../../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: () => <div data-testid="signup" />,
}))
vi.mock("../../../../src/features/paylink/ClaimToL1Modal", () => ({
  ClaimToL1Modal: ({ link }: { link: { tokenAddress?: string } }) => (
    <div data-testid="cash-out" data-token={link.tokenAddress} />
  ),
}))
// Fake fragments never decode; the tab's read of the link only needs a stable name for one.
vi.mock("../../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about which CTA is live.
vi.mock("@obsidion/web-ds", () => ({
  AuroraBackground: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ScreenNavBar: () => null,
  Icon: () => null,
  Shimmer: ({ children }: { children?: React.ReactNode }) => <div data-skeleton>{children}</div>,
  Spinner: () => <div data-testid="spinner" />,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))

const { LinkViewScreen } = await import("../../../../src/features/paylink/LinkViewScreen")
const { openTestSession } = await import("../../../support/session")

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  localStorage.clear()
  chain.noteReadable = true
  chain.coldMs = 0
  escrow = undefined
  openTestSession({ wallet: CTX.wallet, teeSigner: CTX.teeSigner })
  vi.useFakeTimers()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const open = () =>
  act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/link#${FRAGMENT}`]}>
        <LinkViewScreen />
      </MemoryRouter>,
    )
  })
const expectCashOutOffered = () => {
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.textContent).not.toContain("Couldn't check availability.")
  expect(button("Claim to an Ethereum wallet")?.disabled).toBe(false)
}

describe("the visitor page's reads", () => {
  it("offers the Ethereum cash-out once the status read finds a fresh escrow's note", async () => {
    chain.noteReadable = false
    await open()
    await elapse(0)
    expect(viewLink).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain("$20")

    // The next blocks land; the status read's 5 s re-read finds the note.
    chain.noteReadable = true
    await elapse(5_000)
    expect(viewLink).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("$20")
    expectCashOutOffered()
    expect(linkVoucherUses).toHaveBeenLastCalledWith(expect.anything(), FRAGMENT, NOTE.tokenAddress)
  })

  it("reads a reloaded link again from the cash-out when every read missed the note", async () => {
    await open()
    await elapse(0)
    await act(async () => root.unmount())

    root = createRoot(container)
    chain.noteReadable = false
    vi.clearAllMocks()
    await open()
    await elapse(60_000)
    expect(viewLink).toHaveBeenCalledTimes(13)
    expect(container.textContent).toContain("$20")

    // The voucher read, behind the status reads, misses the note too; its retry finds it.
    chain.noteReadable = true
    await act(async () => button("Try again")!.click())
    await elapse(0)
    // Only this tab's earlier read has the window: the cash-out's fee needs the token.
    expect(container.textContent).toContain("Tap to try again.")
    await act(async () => button("Claim to an Ethereum wallet")!.click())
    await elapse(0)
    expect(container.querySelector("[data-testid=cash-out]")).toBeNull()
    expect(viewLink).toHaveBeenCalledTimes(14)
    expectCashOutOffered()
    await act(async () => button("Claim to an Ethereum wallet")!.click())
    expect(container.querySelector("[data-testid=cash-out]")?.getAttribute("data-token")).toBe(
      NOTE.tokenAddress,
    )
  })
})

import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  actionUpgradeTitle,
  claimUpgradeLead,
} from "../../../../src/features/migration/upgradeCopy"
import { asOperation } from "../../../support/handOff"
import { subscribeErrorModal } from "../../../../src/errors/errorModal"

vi.mock("../../../../src/features/operations/operations", async () =>
  (await import("../../../support/fakeOperations")).fakeOperationsModule(),
)
/** Whether a claim must wait for the upgrade or a balance move, and every action a press asked for. */
const gate = vi.hoisted(() => ({ upgrade: false, moving: false, asked: [] as string[] }))
vi.mock("../../../../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    gate.asked.push(action)
    if (!gate.upgrade && !gate.moving) run()
  },
  useActionVerdict: () => (gate.upgrade ? "upgrade" : gate.moving ? "moving" : "open"),
}))
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
  GradientSpinner: () => <i data-icon="spinner" />,
  Shimmer: ({ children }: { children: React.ReactNode }) => <div data-skeleton>{children}</div>,
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))

const isWindowRevert = vi.fn((_e: unknown) => false)
vi.mock("@obsidion/front-core", async (importOriginal) => {
  // The ticket quote is core's real arithmetic under front-core's tips.
  const { GOLDEN_TICKET_BRIDGE_REMAINDER, goldenTicketQuote, WITHDRAW_RELAYER_TIP } = await import(
    "@obsidion/core/constants"
  )
  const goldenTicketBurn = (
    schedule: { fee: bigint; min: bigint },
    proverTip: bigint,
    withdrawalFee: bigint,
  ) =>
    goldenTicketQuote(schedule, {
      withdrawalFee,
      relayerTip: WITHDRAW_RELAYER_TIP,
      proverTip,
      bridgeRemainder: GOLDEN_TICKET_BRIDGE_REMAINDER,
    })
  return {
    ...(await importOriginal<typeof import("@obsidion/front-core")>()),
    goldenTicketBurn,
    goldenTicketCoverage: (
      noteAmount: bigint,
      schedule: { fee: bigint; min: bigint },
      proverTip: bigint,
      withdrawalFee: bigint,
    ) => {
      const quote = goldenTicketBurn(schedule, proverTip, withdrawalFee)
      const immediate = noteAmount - quote.burn
      return {
        ...quote,
        noteAmount,
        immediate,
        eventual: immediate + quote.returned,
        covers: noteAmount > quote.burn,
      }
    },
    isPaylinkWindowRevert: (e: unknown) => isWindowRevert(e),
    isPaylinkWindowNotOpenRevert: (e: unknown) => isWindowRevert(e),
    INTERRUPTED_ERRORS: {},
    useContractServiceContext: () => contracts,
    formatDateLabel: () => "Today",
    formatTimeLabel: () => "14:32",
    TxInFlightError: class TxInFlightError extends Error {
      constructor(readonly txHash: string, cause?: unknown) {
        super(cause instanceof Error ? cause.message : String(cause))
      }
    },
  }
})

// Status deps: set by the tests that need the note read; no wallet means viewLink never runs.
const aztec = {
  /** The session's wallet; undefined leaves the session's own, not yet up. */
  set obsidionWallet(wallet: unknown) {
    openTestSession({ wallet })
  },
}
const contracts: { contractService?: unknown } = {}
type Stage = (s: string) => void
const decodeLink = vi.fn()
const viewLink = vi.fn()
const claimSponsoredLink = vi.fn(
  async (_deps: unknown, _fragment: string, _setStage: Stage, _proof?: unknown) => "0xclaimtx",
)
const claimLinkToL1 = vi.fn(async (..._a: unknown[]) => ({}))
const planLinkClaimSwap = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock("../../../../src/features/paylink/sponsoredPaylink", () => ({
  claimLinkToL1: (...a: unknown[]) => claimLinkToL1(...a),
  planLinkClaimSwap: (...a: unknown[]) => planLinkClaimSwap(...a),
  decodeLink: (f: string) => decodeLink(f),
  viewLink: (...a: unknown[]) => viewLink(...a),
  claimSponsoredLink: asOperation(
    (...a: Parameters<typeof claimSponsoredLink>) => claimSponsoredLink(...a),
    "paylink-claim",
  ),
  VoucherReadError: class VoucherReadError extends Error {},
}))
const obtainEmailClaimProof = vi.fn(
  async (_account: unknown, _params: unknown, _s: Stage) => "proof",
)
// The withdraw-to-Ethereum modal pulls in the notifications panel and web storage; out of scope here.
type L1ModalProps = {
  node?: unknown
  onConfirm: (choice: Record<string, unknown>, onStage: () => void) => Promise<unknown>
  planSwap: (...a: unknown[]) => Promise<unknown>
}
const l1Modal: { props?: L1ModalProps } = {}
vi.mock("../../../../src/features/paylink/ClaimToL1Modal", () => ({
  ClaimToL1Modal: (props: L1ModalProps) => {
    l1Modal.props = props
    return null
  },
}))

vi.mock("../../../../src/features/paylink/emailClaim", () => ({
  obtainEmailClaimProof: (...a: Parameters<typeof obtainEmailClaimProof>) =>
    obtainEmailClaimProof(...a),
}))
const chainNowRef: { now: number | undefined } = { now: undefined }
vi.mock("../../../../src/features/paylink/chainTime", () => ({
  usePolledChainSeconds: () => chainNowRef.now,
}))
let paylinkDeps: unknown
vi.mock("../../../../src/features/paylink/usePaylinkDeps", () => ({
  usePaylinkDeps: () => paylinkDeps,
  // The link's voucher read, which a registration it funds needs for the claim batch.
  useLinkVoucher: (link: unknown) => ({ uses: voucherPending.value ? undefined : link ? 1 : 0 }),
}))
/** The live sweep fee; undefined while it is read. */
const skim: { value: bigint | undefined } = { value: 5n }
/** This browser's registrations, as Home loads them. */
const registrationsLoad: { value: Promise<void> } = { value: Promise.resolve() }
/** The voucher read has not answered. */
const voucherPending = { value: false }
/** Some speed choice was asked to price its tip. */
const speedActive = { value: false }
const clearClaimStash = vi.fn()
/** The visitor page's read of the link, as the ticket marker carries it to Home. */
const ticketMarker: { value: Record<string, unknown> | null } = { value: null }
vi.mock("../../../../src/features/paylink/claimStash", () => ({
  clearClaimStash: (fragment?: string) => clearClaimStash(fragment),
  peekTicketSignup: () => ticketMarker.value,
}))
/** The ticket signup this account left at its review, or null for an ordinary claim. */
const continuation: { value: unknown } = { value: null }
/** A registration whose terms name the link exists, whatever its phase. */
const committed = { value: false }
const ticketSignupContinuation = vi.fn(
  (_fragment: string, _l2: string | undefined, _withdrawals: unknown) => continuation.value,
)
/** Listeners on the open registrations; a test fires them as the store would. */
const registrationListeners = new Set<() => void>()
const releaseLinkDeposit = vi.fn()
/** This account's registration still waiting for its deposit, or null. */
const unfunded: { value: unknown } = { value: null }
const bindLinkDeposit = vi.fn()
vi.mock("../../../../src/features/paylink/ticketContinuation", () => ({
  releaseLinkDeposit: (record: unknown) => releaseLinkDeposit(record),
  unfundedRegistration: () => unfunded.value,
  loadRegistrations: () => registrationsLoad.value,
  fundingRefusalCopy: (e: Error) =>
    e.name === "RegistrationFundingError" ? "the funding's copy" : undefined,
  bindLinkDeposit: (...a: unknown[]) => bindLinkDeposit(...a),
  ticketSignupContinuation: (f: string, l2: string | undefined, w: unknown) =>
    ticketSignupContinuation(f, l2, w),
  ticketSignupCommitted: () => committed.value,
  onTicketRegistrationsChanged: (listener: () => void) => {
    registrationListeners.add(listener)
    return () => registrationListeners.delete(listener)
  },
  ticketHoldNotice: (state: string, tag: string) =>
    state === "blocked"
      ? "this payment's ticket did not waive the tag price"
      : state === "renew"
      ? `The reservation for @${tag} needs a fresh quote`
      : state === "submitted"
      ? "This payment is already claimed"
      : undefined,
}))
const oweBroadcast = vi.hoisted(() => vi.fn())
vi.mock("../../../../src/features/broadcasts/useOweRegistrationBroadcast", () => ({
  useOweRegistrationBroadcast: oweBroadcast,
}))

const navigate = vi.fn()
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }))
const commitTip = vi.fn((_account: string, _tag: string, _tip: bigint) => {})
vi.mock("../../../../src/features/onboarding/registrationTerms", () => ({
  useDepositSkim: () => skim.value,
  commitRegistrationProverTip: (account: string, tag: string, tip: bigint) =>
    commitTip(account, tag, tip),
  useRegistrationTerms: () => null,
  committedProverTip: () => 0n,
}))
/** The tip the review decides; its quote and decision have a suite of their own. */
const reviewTip: { value: bigint | undefined } = { value: 10n ** 18n }
vi.mock("../../../../src/features/withdraw/speedChoice", () => ({ SpeedRow: () => null }))
// The executor fee is priced in the quote's own suite; here it costs nothing so the figures stay the tips'.
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../../src/features/paylink/registrationProverTip", () => ({
  useRegistrationSpeed: ({
    active,
    onCommit,
  }: {
    active: boolean
    onCommit: (tip: bigint, speed: string) => void
  }) => {
    const tip = active ? reviewTip.value : undefined
    if (active) speedActive.value = true
    React.useEffect(() => {
      if (tip !== undefined) onCommit(tip, "faster")
    }, [tip])
    return {
      choice: {
        loading: false,
        speed: "faster",
        setSpeed: () => {},
        settled: false,
        pricedTip: 0n,
      },
      outcome: { proverTip: 0n },
      proverTip: tip,
      settle: () => {},
    }
  },
}))
vi.mock("../../../../src/features/onboarding/steps/ClaimReviewStep", () => ({
  ClaimReviewStep: ({
    quote,
    memo,
    error,
    notices,
    claimable = true,
    settled = false,
    busy = false,
    status,
    onClaim,
    onClose,
    onHandOff,
  }: {
    quote?: { paylink?: bigint; youReceive?: bigint; provingFee: bigint; tagWaived?: boolean }
    memo?: string
    error?: string
    notices?: React.ReactNode
    claimable?: boolean
    settled?: boolean
    busy?: boolean
    status?: string
    onClaim: () => void
    onClose: () => void
    onHandOff?: () => void
  }) => (
    <div data-testid="claim-review">
      <span>
        {quote
          ? `paylink ${quote.paylink} receive ${quote.youReceive} proving ${quote.provingFee}`
          : "pricing"}
      </span>
      {quote?.tagWaived && <span>Free with ticket</span>}
      {memo && <span>{memo}</span>}
      {status && <span>{status}</span>}
      {error && <span role="alert">{error}</span>}
      {notices}
      {busy && <span>working</span>}
      {/* While the claim runs, Close takes the hand-off's leave, as the step does. */}
      <button onClick={busy ? onHandOff : onClose}>Close</button>
      {!settled && !busy && (
        <button disabled={!claimable} onClick={onClaim}>
          Claim
        </button>
      )}
    </div>
  ),
}))
await (await import("../../../support/seedBootConfig")).seedBootConfig()
vi.mock("../../../../src/lib/explorer", () => ({
  l2TxUrl: (_n: string, _u: string, hash: string) => `https://explorer/${hash}`,
}))
const errorModal = vi.fn()
subscribeErrorModal(errorModal)
const fireEvent = vi.fn()
vi.mock("../../../../src/lib/analytics", () => ({
  fireEvent: (...a: unknown[]) => fireEvent(...a),
  failureCode: () => "x",
}))

const { useClaimLinkFlow, resetRunningClaimsForTests } = await import(
  "../../../../src/features/paylink/useClaimLinkFlow"
)
const { setLinkFunding, takeClaimPromptRequest, useLinkFunding } = await import(
  "../../../../src/features/paylink/claimPrompt"
)
const { VoucherReadError } = (await import(
  "../../../../src/features/paylink/sponsoredPaylink"
)) as unknown as {
  VoucherReadError: new (message: string) => Error
}
const { TxInFlightError } = (await import("@obsidion/front-core")) as unknown as {
  TxInFlightError: new (txHash: string, cause?: unknown) => Error
}
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
)
const { testWalletDbs } = await import("../../../support/fakeWalletDb")
const { openTestSession } = await import("../../../support/session")
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)
const burns = () => session().withdrawals.list.get().records

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const directLink = {
  url: "https://wallet/link#frag",
  fragment: "frag",
  amount: "100",
  status: "unclaimed",
  flavor: "direct",
  txHash: "0x0093c3aabbccddee",
  // Read with the escrow note; an open window unless a test says otherwise.
  claimableFrom: 0,
}
const emailLink = { ...directLink, flavor: "email", email: "satoshi@gmail.com", commitment: "0x2a" }

function Harness({
  fragment,
  onDone,
  requested = false,
}: {
  fragment: string | null
  onDone: () => void
  requested?: boolean
}) {
  return (
    <div>
      {useClaimLinkFlow(fragment, onDone, requested).modal}
      <FundingProbe />
    </div>
  )
}

/** What the hero is told about the link and the open registration. */
function FundingProbe() {
  const funding = useLinkFunding()
  return <i data-testid="funding" data-state={funding ? funding.state : "none"} />
}

/** Home's own wiring: the stashed link, and whether an activation surface asked for its review. */
function HomeHarness({ onDone, asked: askedFirst }: { onDone: () => void; asked: boolean }) {
  const [fragment, setFragment] = React.useState<string | null>("frag")
  const [asked, setAsked] = React.useState(askedFirst)
  const flow = useClaimLinkFlow(
    fragment,
    () => {
      onDone()
      setFragment(null)
      setAsked(false)
    },
    asked,
    () => setAsked(false),
  )
  return <div>{flow.modal}</div>
}

describe("useClaimLinkFlow", () => {
  let container: HTMLDivElement
  let root: Root
  const onDone = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    decodeLink.mockReturnValue(directLink)
    aztec.obsidionWallet = undefined
    delete contracts.contractService
    claimSponsoredLink.mockImplementation(async () => "0xclaimtx")
    paylinkDeps = undefined
    chainNowRef.now = 1_000
    isWindowRevert.mockReturnValue(false)
    continuation.value = null
    unfunded.value = null
    ticketMarker.value = null
    voucherPending.value = false
    registrationsLoad.value = Promise.resolve()
    skim.value = 5n
    speedActive.value = false
    setLinkFunding(null)
    fireEvent.mockClear()
    resetRunningClaimsForTests()
    gate.upgrade = false
    gate.moving = false
    gate.asked = []
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const funding = () =>
    container.querySelector('[data-testid="funding"]')?.getAttribute("data-state")
  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)
  // The value cell of the ConfirmationSheetDetailRow mock.
  const detail = (label: string) =>
    [...container.querySelectorAll("span")].find((s) => s.textContent === label)?.nextElementSibling

  async function render(fragment: string | null = "frag") {
    await act(async () => {
      root.render(<Harness fragment={fragment} onDone={onDone} />)
    })
  }

  // The fragment's amount is unsigned text; only the escrow note's figure is ever shown.
  it("holds the amount, note and Accept until the escrow note is read", async () => {
    decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
    let resolveView: (v: unknown) => void = () => {}
    viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
    aztec.obsidionWallet = {}
    contracts.contractService = {}
    await render()
    expect(container.textContent).not.toContain("$")
    expect(detail("Note")?.querySelector("[data-skeleton]")).not.toBeNull()
    // The note carries the claim window, so nothing is claimable until it is read.
    expect(button("Accept")).toBeUndefined()
    await act(async () => button("Checking…")?.click())
    expect(claimSponsoredLink).not.toHaveBeenCalled()
    await act(async () => resolveView({ ...directLink, amount: "5" }))
    expect(button("Accept")).toBeDefined()
    expect(container.textContent).toContain("$5")
    expect(container.querySelector("[data-skeleton]")).toBeNull()
    expect(detail("Note")?.textContent).toBe("—")
  })

  // This tab's earlier read (here the visitor page's, on the ticket marker) shows the amount and the
  // window at once; the link may be spent since, so only a read of it now offers the claim.
  it.each([
    ["unclaimed", true],
    ["claimed", false],
  ])(
    "offers Accept off this tab's earlier read only once a read finds it %s",
    async (status, offered) => {
      decodeLink.mockReturnValue({ ...directLink, amount: undefined, claimableFrom: undefined })
      ticketMarker.value = {
        fragment: "frag",
        amount: (20n * 10n ** 18n).toString(),
        claimableFrom: 0,
      }
      let resolveView: (v: unknown) => void = () => {}
      viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      await render()
      expect(container.textContent).toContain("$20")
      expect(button("Accept")).toBeUndefined()
      await act(async () => button("Checking…")?.click())
      expect(claimSponsoredLink).not.toHaveBeenCalled()

      await act(async () =>
        resolveView(
          status === "claimed" ? { ...directLink, status } : { ...directLink, amount: "20" },
        ),
      )
      expect(!!button("Accept")).toBe(offered)
      expect(!!button("Go to wallet")).toBe(!offered)
    },
  )

  // Only a read here supplies the token (the Ethereum claim's fee) and an email link's email and
  // commitment; this tab's earlier read keeps the amount and the window, never those.
  it.each([
    ["direct", directLink, "Accept", "Accept"],
    ["email", emailLink, "Reading link…", "Claim with Google"],
  ])(
    "offers a %s link's re-read once every read misses the note this tab read before",
    async (_flavor, read, offered, claim) => {
      const decoded = { ...read, email: undefined, commitment: undefined }
      vi.useFakeTimers()
      try {
        decodeLink.mockReturnValue({ ...decoded, amount: undefined, claimableFrom: undefined })
        ticketMarker.value = {
          fragment: "frag",
          amount: (20n * 10n ** 18n).toString(),
          claimableFrom: 0,
        }
        viewLink.mockResolvedValue({ ...decoded, amount: undefined, claimableFrom: undefined })
        aztec.obsidionWallet = {}
        contracts.contractService = {}
        paylinkDeps = { account: { getAddress: () => "0xme" } }
        await render()
        expect(container.textContent).toContain("$20")
        expect(button(offered)).toBeDefined()

        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(viewLink).toHaveBeenCalledTimes(13)
        expect(button(offered)).toBeUndefined()
        expect(button("Claim to an Ethereum wallet instead")).toBeUndefined()
        expect(container.textContent).toContain("Couldn't check when this link can be claimed.")

        viewLink.mockResolvedValueOnce({ ...read, amount: "20", claimableFrom: 0 })
        await act(async () => button("Try again")!.click())
        expect(button("Try again")).toBeUndefined()
        expect(button(claim)).toBeDefined()
        expect(button("Claim to an Ethereum wallet instead")).toBeDefined()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it("holds Accept until chain time is known on a link with a grace window", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    chainNowRef.now = undefined
    decodeLink.mockReturnValue({ ...directLink, claimableFrom: 1_800_000_100 })
    await render()
    expect(button("Accept")).toBeUndefined()
    expect(button("Checking…")).toBeDefined()
    await act(async () => button("Checking…")?.click())
    expect(claimSponsoredLink).not.toHaveBeenCalled()
  })

  it("asks an account that must upgrade to upgrade to claim", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    l1Modal.props = undefined
    gate.upgrade = true
    await render()
    expect(container.textContent).toContain(claimUpgradeLead)
    await act(async () => button(actionUpgradeTitle.claim)!.click())
    expect(gate.asked).toEqual(["claim"])
    expect(claimSponsoredLink).not.toHaveBeenCalled()
    expect(l1Modal.props).toBeUndefined()
  })

  it("a second Accept in the same batch does not start a second claim", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    claimSponsoredLink.mockImplementation(
      () =>
        new Promise<string>((r) => {
          resolveClaim = r
        }),
    )
    await render()
    await act(async () => {
      button("Accept")?.click()
      button("Accept")?.click()
    })
    expect(claimSponsoredLink).toHaveBeenCalledOnce()
    await act(async () => resolveClaim("0xclaimtx"))
  })

  it("a remount during an in-flight claim shows nothing instead of re-prompting", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    let advance!: Stage
    claimSponsoredLink.mockImplementation(
      (_deps: unknown, _fragment: string, onStage: Stage) =>
        new Promise<string>((r) => {
          advance = onStage
          resolveClaim = r
        }),
    )
    await render()
    await act(async () => button("Accept")?.click())
    await act(async () => advance("building"))
    expect(container.textContent).toContain("Preparing transaction…")

    // Leave Home and come back while the stash still holds the fragment.
    await act(async () => root.unmount())
    root = createRoot(container)
    onDone.mockClear()
    await render()
    expect(button("Accept")).toBeUndefined()
    expect(container.textContent).not.toContain("Claiming payment")
    expect(onDone).toHaveBeenCalledOnce()

    // The original call keeps feeding the row.
    await act(async () => advance("submitting"))
    await act(async () => resolveClaim("0xclaimtx"))
    expect(claimSponsoredLink).toHaveBeenCalledOnce()
  })

  it("a claim that outlives its prompt clears only its own stash entry", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    let resolveClaim!: (hash: string) => void
    claimSponsoredLink.mockImplementation(
      async (_deps: unknown, _fragment: unknown, setStage: unknown) => {
        const hash = await new Promise<string>((r) => {
          resolveClaim = r
        })
        ;(setStage as (s: string) => void)("submitting")
        return hash
      },
    )
    await render("fragA")
    await act(async () => button("Accept")?.click())
    expect(container.textContent).toContain("Preparing transaction…")

    // The user lands on another link while A is still proving.
    decodeLink.mockReturnValue({ ...directLink, fragment: "fragB", amount: "7" })
    await render("fragB")
    expect(container.textContent).toContain("$7")
    expect(container.textContent).toContain("Accept to receive funds")

    await act(async () => resolveClaim("0xclaimtx"))
    expect(clearClaimStash).toHaveBeenCalledWith("fragA")
    expect(clearClaimStash).not.toHaveBeenCalledWith("fragB")
    // B's prompt is untouched by A settling.
    expect(container.textContent).not.toContain("Submitting to the network")
    expect(button("Accept")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
  })

  describe("an account whose registration still waits for its deposit", () => {
    const ONE = 10n ** 18n
    const record = {
      phase: "awaiting_deposit",
      account: "0xacct",
      tag: "brisk-otter",
      sipaAddress: "0xsipa",
    }
    /** A drawn tag's signed deposit: the sweep fee and its minimum. */
    const waiting = { record, schedule: { fee: ONE / 2n, min: ONE } }
    const opened = (link: Record<string, unknown> = directLink) => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      chainNowRef.now = 1_800_000_000
      viewLink.mockResolvedValue(link)
      unfunded.value = waiting
    }
    const settle = () => act(async () => new Promise((r) => setTimeout(r)))

    it("shows the split the link pays before the claim, then funds the registration with its tip", async () => {
      opened()
      await render()
      await settle()
      // The review, not the plain prompt: what the registration takes and what the wallet keeps.
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
      expect(button("Accept")).toBeUndefined()
      expect(container.textContent).toContain(`paylink ${100n * ONE}`)
      expect(container.textContent).toContain(`proving ${ONE}`)
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      await act(async () => button("Claim")!.click())
      expect(bindLinkDeposit).toHaveBeenCalledWith(
        record,
        { fragment: "frag", amount: 100n * ONE, senderTag: undefined },
        ONE,
        "faster",
      )
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("prices a paid tag at its own signed fee: a golden ticket waives nothing for an entered account", async () => {
      opened()
      unfunded.value = {
        record: { ...record, tag: "maple-paid" },
        schedule: { fee: 10n * ONE, min: ONE },
      }
      await render()
      await settle()
      expect(container.textContent).not.toContain("Free with ticket")
      await act(async () => button("Claim")!.click())
      expect(bindLinkDeposit).toHaveBeenCalled()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("tells the hero it is checking until the voucher answers, then that the link pays", async () => {
      opened()
      voucherPending.value = true
      await render()
      await settle()
      expect(funding()).toBe("checking")
      expect(button("Accept")).toBeUndefined()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      // The tip is priced beside the voucher read, not after it.
      expect(speedActive.value).toBe(true)
      expect(bindLinkDeposit).not.toHaveBeenCalled()
      voucherPending.value = false
      await render()
      await settle()
      expect(funding()).toBe("review")
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
    })

    it("chooses nothing before the sweep fee is read", async () => {
      opened()
      skim.value = undefined
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      expect(funding()).toBe("checking")
      skim.value = 5n
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).not.toBeNull()
    })

    it("a decision past its time decides only its own link", async () => {
      vi.useFakeTimers()
      try {
        opened()
        skim.value = undefined
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(15_000))
        expect(button("Accept")).toBeDefined()
        await render("frag-b")
        await act(async () => vi.advanceTimersByTimeAsync(0))
        expect(button("Accept")).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it("claims as an ordinary payment when the note cannot cover the deposit and the tip", async () => {
      opened({ ...directLink, amount: "1" })
      await render()
      await settle()
      expect(container.querySelector('[data-testid="claim-review"]')).toBeNull()
      // The hero asks for the deposit again.
      expect(funding()).toBe("none")
      await act(async () => button("Accept")!.click())
      expect(bindLinkDeposit).not.toHaveBeenCalled()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
      )
    })
  })

  describe("a ticket-funded signup entering Home", () => {
    const ONE = 10n ** 18n
    const ready = {
      stash: {
        fragment: "frag",
        amount: (20n * ONE).toString(),
        memo: "Pizza dinner",
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
      },
      record: { phase: "awaiting_deposit", account: "0xacct", tag: "taga" },
      activation: { state: "ready", schedule: { fee: ONE / 2n, min: 0n } },
    }
    /** The account is open, the chain clock read, and the escrow note read: the window is known. */
    const entered = (link: Record<string, unknown> = { ...directLink, claimableFrom: 0 }) => {
      paylinkDeps = { account: { getAddress: () => "0xme" } }
      aztec.obsidionWallet = {}
      contracts.contractService = {}
      chainNowRef.now = 1_800_000_000
      viewLink.mockResolvedValue(link)
      continuation.value = ready
    }
    const held = (state: string) => {
      entered()
      continuation.value = { ...ready, activation: { state, stash: ready.stash } }
    }
    const settle = () => act(async () => new Promise((r) => setTimeout(r)))
    const cancelled = () => Object.assign(new Error("Cancelled"), { name: "NotAllowedError" })
    /** Home again with the same link: the flow mounts afresh, as when the activation sheet asks. */
    const remount = async () => {
      await render(null)
      await render()
    }
    const review = () => container.querySelector('[data-testid="claim-review"]')
    beforeEach(() => {
      takeClaimPromptRequest()
    })

    it("claims the link by itself, with the registration burn, and hands off to the bell at once", async () => {
      entered()
      await session().withdrawals.create({
        networkId: "0xnet",
        localId: "w1",
        recipient: "0xsipa",
        recipientProvenance: "saved-recipient",
        amount: "1",
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "done",
        startTime: 1,
      })
      await render()
      expect(ticketSignupContinuation).toHaveBeenCalledWith("frag", "0xme", burns())
      expect(review()).toBeNull()
      expect(button("Accept")).toBeUndefined()
      expect(claimSponsoredLink).toHaveBeenCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
      expect(onDone).toHaveBeenCalledOnce()
      await settle()
      // The link stays stashed: its review reports the claim and the registration from here.
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(takeClaimPromptRequest()).toBeNull()
      // No review, no fresh quote: the burn carries the tip the signup committed.
      expect(commitTip).not.toHaveBeenCalled()
    })

    it("holds its own claim while the account must upgrade first", async () => {
      entered()
      gate.upgrade = true
      await render()
      await settle()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      gate.upgrade = false
      await render()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
    })

    it("opens the review on request whatever the claim's state, working while a claim runs", async () => {
      entered()
      claimSponsoredLink.mockReturnValueOnce(new Promise(() => {}))
      await render(null)
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      // Home's own try went out and handed off; the asked-for review reports it at work, priced at
      // the tip that claim burns rather than a fresh quote.
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Claiming")
      expect(container.textContent).toContain("proving 0")
      expect(button("Claim")).toBeUndefined()
    })

    it("hands a deposit the link was to pay back to the user once a fresh read finds the link closed", async () => {
      entered({ ...directLink, status: "claimed", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(releaseLinkDeposit).toHaveBeenCalledWith(ready.record)
    })

    it("hands the deposit back once the link closes, while a renewal holds the signup blocked", async () => {
      held("blocked")
      viewLink.mockResolvedValue({ ...directLink, status: "expired", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(releaseLinkDeposit).toHaveBeenCalledWith(ready.record)
    })

    it("keeps the registration whose burn is already on its way", async () => {
      held("submitted")
      viewLink.mockResolvedValue({ ...directLink, status: "claimed", claimableFrom: 0 })
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      await render()
      await settle()
      expect(releaseLinkDeposit).not.toHaveBeenCalled()
    })

    it("claims nothing after a reload until the burns load, which may show the burn already out", async () => {
      entered()
      closeSession()
      const { walletStorage } = await import("../../../../src/platform/storage/walletStorage")
      await walletStorage.batch(() =>
        walletStorage.removeItem(`${activeNamespace().prefix}acct/meta/withdrawals`),
      )
      let land!: () => void
      const landed = new Promise<void>((resolve) => (land = resolve))
      testWalletDbs().onApply = async (_version, ops) => {
        if (ops.some(([key]) => key.endsWith("acct/meta/withdrawals"))) await landed
      }
      switchSession(activeNamespace())
      await render()
      await settle()
      expect(ticketSignupContinuation).not.toHaveBeenCalled()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      await act(async () => land())
      await settle()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
    })

    it("waits for the escrow read and the claim window before its one try", async () => {
      let resolveView: (v: unknown) => void = () => {}
      entered()
      // `decodeLink` knows no window: nothing is tried on that alone.
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      viewLink.mockReturnValue(new Promise((r) => (resolveView = r)))
      chainNowRef.now = 1_800_000_000
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(review()).toBeNull()

      await act(async () => resolveView({ ...directLink, claimableFrom: 1_800_000_100 }))
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(onDone).not.toHaveBeenCalled()

      chainNowRef.now = 1_800_000_130
      await render()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("tries once per page: a cancelled passkey keeps the link stashed, and Home then shows the review with its Claim", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(clearClaimStash).not.toHaveBeenCalled()
      expect(errorModal).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
      // Home is asked to show the link again: the review, with its Claim.
      expect(takeClaimPromptRequest()).toBe("frag")

      await remount()
      expect(review()).not.toBeNull()
      expect(container.textContent).toContain("Pizza dinner")
      // 20 - (0.5 fee + 0.01 remainder + 0.1 relayer + 1 prover)
      expect(container.textContent).toContain(`receive ${18_390_000_000_000_000_000n}`)
      expect(container.textContent).toContain(`proving ${10n ** 18n}`)
      // The tip on screen is the one the claim burns.
      expect(commitTip).toHaveBeenCalledWith("0xacct", "taga", 10n ** 18n)
      expect(container.textContent).not.toContain("Accept to receive funds")
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
      expect(claimSponsoredLink).toHaveBeenLastCalledWith(
        paylinkDeps,
        "frag",
        expect.any(Function),
        undefined,
        { fundRegistration: true },
      )
    })

    it("tries twice more after a voucher read that timed out, then hands the review back", async () => {
      vi.useFakeTimers()
      const info = vi.spyOn(console, "info").mockImplementation(() => {})
      try {
        entered()
        claimSponsoredLink
          .mockRejectedValueOnce(new VoucherReadError("slow"))
          .mockRejectedValueOnce(new VoucherReadError("slow"))
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(0))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(1)
        // Still Home's claim while it waits: nothing reopens the review, nothing starts it again.
        expect(takeClaimPromptRequest()).toBeNull()
        await act(async () => vi.advanceTimersByTimeAsync(5_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(2)
        await act(async () => vi.advanceTimersByTimeAsync(10_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(3)
        expect(takeClaimPromptRequest()).toBeNull()
        expect(errorModal).not.toHaveBeenCalled()

        // A read that keeps timing out is reported once the tries are spent.
        resetRunningClaimsForTests()
        claimSponsoredLink.mockClear()
        claimSponsoredLink.mockRejectedValue(new VoucherReadError("slow"))
        await render(null)
        await render()
        await act(async () => vi.advanceTimersByTimeAsync(20_000))
        expect(claimSponsoredLink).toHaveBeenCalledTimes(3)
        expect(takeClaimPromptRequest()).toBe("frag")
        expect(errorModal).toHaveBeenCalledOnce()
      } finally {
        claimSponsoredLink.mockReset()
        info.mockRestore()
        vi.useRealTimers()
      }
    })

    it("shows the review with a re-read while the claim window is unread, then claims by itself once read", async () => {
      entered()
      decodeLink.mockReturnValue({ ...directLink, claimableFrom: undefined })
      viewLink.mockRejectedValueOnce(new Error("node down"))
      await render()
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expect(button("Claim")!.disabled).toBe(true)
      expect(container.textContent).toContain("Couldn't check when this link can be claimed.")
      viewLink.mockResolvedValueOnce(directLink)
      await act(async () => button("Try again")!.click())
      expect(viewLink).toHaveBeenCalledTimes(2)
      // The window read open, Home's own claim starts with no tap.
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(onDone).toHaveBeenCalledOnce()
    })

    it("a blocked, lapsed or already-burning signup claims nothing and shows nothing: the hero says why", async () => {
      for (const state of ["blocked", "renew", "submitted"]) {
        held(state)
        await render()
        expect(review()).toBeNull()
        expect(button("Accept")).toBeUndefined()
        expect(claimSponsoredLink).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
      }
    })

    it("the review re-reads the signup at the click: terms that lapsed after the render claim nothing", async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      await remount()
      expect(button("Claim")?.disabled).toBe(false)
      continuation.value = { ...ready, activation: { state: "renew", stash: ready.stash } }
      await act(async () => button("Claim")!.click())
      expect(claimSponsoredLink).toHaveBeenCalledOnce()
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/fresh quote/)
      expect(button("Claim")?.disabled).toBe(true)
      await act(async () => button("Check registration")!.click())
      expect(navigate).toHaveBeenCalledWith("/claim/taga")
      expect(clearClaimStash).not.toHaveBeenCalled()
    })

    /** Home's own try was cancelled: Home shows the review again, unasked, with its Claim. */
    const reviewAfterHomeTry = async () => {
      entered()
      claimSponsoredLink.mockRejectedValueOnce(cancelled())
      await render()
      await settle()
      takeClaimPromptRequest()
      await remount()
      expect(button("Claim")?.disabled).toBe(false)
    }

    it("a review's claim the node already has hands off with no failure, and is not offered again", async () => {
      await reviewAfterHomeTry()
      await act(async () => root.render(<HomeHarness onDone={onDone} asked />))
      onDone.mockClear()
      claimSponsoredLink.mockRejectedValueOnce(new TxInFlightError("0xclaim", new Error("offline")))
      await act(async () => button("Claim")!.click())
      expect(onDone).toHaveBeenCalledOnce()
      expect(review()).toBeNull()
      expect(errorModal).not.toHaveBeenCalled()

      // The burn's record, left at its hash, makes the signup submitted.
      continuation.value = { ...ready, activation: { state: "submitted" } }
      await act(async () => root.render(<Harness fragment="frag" onDone={onDone} requested />))
      await settle()
      expect(review()).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(button("Claim")).toBeUndefined()
    })
  })

  // The stash exists to re-offer Accept after a reload. A claim the node already has must leave
  // it, or the reload offers to spend a note this wallet has spent.
  it("a claim left in flight clears its stash and hands off", async () => {
    paylinkDeps = { account: { getAddress: () => "0xme" } }
    claimSponsoredLink.mockRejectedValueOnce(new TxInFlightError("0xclaim", new Error("offline")))
    await render()
    await act(async () => button("Accept")?.click())
    expect(clearClaimStash).toHaveBeenCalled()
    expect(errorModal).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })
})

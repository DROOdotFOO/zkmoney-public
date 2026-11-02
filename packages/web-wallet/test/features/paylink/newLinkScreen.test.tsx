import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { balancesOf } from "../../support/balances"
import { fireEvent } from "../../../src/lib/analytics"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation } from "../../support/handOff"
import { subscribeErrorModal } from "../../../src/errors/errorModal"

let location: ReturnType<typeof useLocation>
function LocationProbe() {
  location = useLocation()
  return null
}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  parseEscrowAmount: (s: string, d: number) => ({
    atomic: BigInt(Math.round(Number(s))) * 10n ** BigInt(d),
    human: Number(s),
  }),
}))
const allowanceGate = vi.hoisted(() => ({ reason: undefined as string | undefined }))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: (enabled: boolean) => (enabled ? allowanceGate.reason : undefined),
  SponsoredActionNotice: ({ reason }: { reason?: string }) =>
    reason ? <p data-testid="sponsored-action-blocked">{reason}</p> : null,
}))
vi.mock("../../../src/features/contacts/SendScreen/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../../../src/ui/PayModalChrome", () => ({
  PayModalChrome: ({ onBack }: { onBack?: () => void }) =>
    onBack ? <button onClick={onBack}>Back</button> : null,
}))
const deps = {}
vi.mock("../../../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => deps }))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))
const errorModal = vi.fn()
subscribeErrorModal(errorModal)

const identity = vi.hoisted(() => ({ handle: undefined as string | undefined }))
vi.mock("../../../src/features/identity/walletIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/identity/walletIdentity")>()),
  loadWalletIdentity: () => ({ address: "0xabc", claimedAt: 1, handle: identity.handle }),
}))

type Stage = (s: string) => void
type Opts = {
  onLink?: (l: unknown) => void
  voucher?: boolean
  email?: string
  senderTag?: string
}
const link = {
  url: "https://wallet/link#frag",
  fragment: "frag",
  amount: "25",
  status: "unclaimed",
}
const createSponsoredLink = vi.fn(
  async (_deps: unknown, _amount: string, _onStage: Stage, _opts: Opts) => ({
    ...link,
    txHash: "0xcreate",
  }),
)
const voucherAvailable = vi.fn(async () => true)
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  voucherAvailable: () => voucherAvailable(),
  DEFAULT_CLAIM_WINDOW_DAYS: 30,
  hasPendingDeposits: () => false,
  createSponsoredLink: asOperation(
    (...a: Parameters<typeof createSponsoredLink>) => createSponsoredLink(...a),
    "paylink-create",
  ),
}))

const ticket = vi.hoisted(() => ({
  offer: null as { threshold: string; schedule: { fee: string; minDeposit: string } } | null,
}))
vi.mock("../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: ticket.offer, failed: false, retry: () => {} }),
}))

const { NewLinkScreen } = await import("../../../src/features/paylink/NewLinkScreen/NewLinkScreen")
const { openTestSession } = await import("../../support/session")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("NewLinkScreen", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    voucherAvailable.mockResolvedValue(true)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    openTestSession({
      token: { metadata: { decimals: 18 } },
      balances: balancesOf({ main: 100n * 10n ** 18n, live: true, known: true }),
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    createSponsoredLink.mockImplementation(
      async (_d: unknown, _a: string, _s: Stage, opts: Opts) => {
        opts.onLink?.(link)
        return { ...link, txHash: "0xcreate" }
      },
    )
    await mount()
  })

  afterEach(() => {
    allowanceGate.reason = undefined
    identity.handle = undefined
    ticket.offer = null
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const mount = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/create"]}>
          <LocationProbe />
          <Routes>
            <Route path="/create" element={<NewLinkScreen />} />
            <Route path="/activity" element={<div>Activity</div>} />
          </Routes>
        </MemoryRouter>,
      )
    })
  /** The ticket offer is read on mount, so a test that sets one opens the screen afresh. */
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
  }
  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)
  const setInput = (value: string) => {
    const input = container.querySelector("input")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  async function reachCreate() {
    await act(async () => setInput("25"))
    await act(async () => button("Next")?.click())
    await act(async () => button("Confirm")?.click())
    expect(button("Create paylink")).toBeDefined()
  }

  describe("the creator's tag on the link", () => {
    const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')
    const sentTag = () => createSponsoredLink.mock.lastCall?.[3].senderTag

    it("leaves the tag off a link the creator turns it off for", async () => {
      identity.handle = "river"
      await remount()
      await act(async () => setInput("25"))
      await act(async () => button("Next")?.click())
      await act(async () => toggle()?.click())
      expect(toggle()?.getAttribute("aria-checked")).toBe("false")
      await act(async () => button("Confirm")?.click())
      await act(async () => button("Create paylink")?.click())
      expect(createSponsoredLink).toHaveBeenCalledOnce()
      expect(sentTag()).toBeUndefined()
    })
  })

  it("a cancelled passkey keeps the review, even with the link already prepared", async () => {
    let rejectCreate!: (e: Error) => void
    createSponsoredLink.mockImplementation(
      (_deps: unknown, _amount: string, _onStage: Stage, opts: Opts) => {
        opts.onLink?.(link)
        return new Promise((_, reject) => {
          rejectCreate = reject
        }) as never
      },
    )
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    await act(async () => provingProgress.emitSigningStart())
    await act(async () => provingProgress.emitSigningEnd(undefined, true))
    expect(location.pathname).toBe("/create")

    await act(async () => rejectCreate(new Error("NotAllowedError")))
    expect(errorModal).toHaveBeenCalled()
    expect(button("Create paylink")).toBeDefined()
  })

  it("a failure before the hand-off fails the row and reopens the review", async () => {
    createSponsoredLink.mockRejectedValueOnce(new Error("boom"))
    await reachCreate()
    await act(async () => button("Create paylink")?.click())
    expect(errorModal).toHaveBeenCalled()
    expect(location.pathname).toBe("/create")
    expect(button("Create paylink")).toBeDefined()
  })

  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: Stage
    let rejectCreate!: (error: Error) => void
    createSponsoredLink.mockImplementation((_deps, _amount, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectCreate = reject
      }) as never
    })
    await reachCreate()
    await act(async () => button("Create paylink")!.click())
    const cancel = button("Cancel")!
    expect(cancel.disabled).toBe(false)
    const error = new Error("Create failed")
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectCreate(error)
    })
    expect(errorModal).toHaveBeenCalledWith(
      expect.objectContaining({ message: error.message, context: "paylink:create" }),
    )
    await act(async () => root.render(null))
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
})

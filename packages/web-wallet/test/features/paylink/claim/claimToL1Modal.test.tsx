import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentLink } from "../../../../src/features/paylink/types"

import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"

vi.mock("../../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: vi.fn() }))

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  caller: vi.fn(async (_executor: string, payee: string) => ({ bound: payee })),
  executor: "0xe8ec000000000000000000000000000000000e8c",
  confirm: vi.fn(),
  close: vi.fn(),
  handOff: vi.fn(),
  config: { network: "sandbox" },
  screening: { cleared: true, screener: {} },
}))
vi.mock("../../../../src/features/paylink/emailClaim", () => ({
  obtainEmailL1Proof: m.verify,
  emailL1Caller: m.caller,
}))
vi.mock("../../../../src/features/paylink/paylinkSource", () => ({
  paylinkTuple: async () => ({ plainWithdrawalExecutor: m.executor }),
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => m.config }))
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => m.screening,
  ScreeningNotice: () => <p>Screening</p>,
}))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => ({}) }))
vi.mock("../../../../src/features/withdraw/WithdrawScreen", () => ({ useSavedL1Wallets: () => [] }))
// A priced direct route with no swap. `route` switches it to the two states where the fee is
// missing — still being read, and reported as unreadable.
const DIRECT_FEE = vi.hoisted(() => 350_000_000_000_000_000n)
const route = vi.hoisted(() => ({ state: "ready" as "ready" | "pending" | "unavailable" }))
const FEE_COPY = "The fee can't be read right now. Check your connection and try again."
vi.mock("../../../../src/features/withdraw/withdrawQuote", async () => {
  const { formatUnits } = await import("viem")
  return {
    FEE_UNAVAILABLE_COPY: "The fee can't be read right now. Check your connection and try again.",
    SWAP_QUOTE_REFRESH_MS: 30_000,
    withdrawalFeeDisplay: (state: { fee?: { floorAtomic: bigint } }) =>
      state.fee ? formatUnits(state.fee.floorAtomic, 18) : undefined,
    useSwapSimulation: ({ proverTip = 0n }: { proverTip?: bigint }) =>
      route.state === "ready"
        ? {
            status: "ready",
            fee: {
              withdrawalRelayerTip: DIRECT_FEE,
              swapRelayerTip: 0n,
              proverTip,
              floorAtomic: DIRECT_FEE + proverTip,
            },
          }
        : { status: route.state === "unavailable" ? "unavailable" : "ready" },
    swapFloorAtomic: (state: { fee?: { floorAtomic: bigint } }) => state.fee?.floorAtomic ?? 0n,
    WithdrawalEstimate: () => null,
  }
})
// The faster option the review offers; undefined offers no speed choice.
const faster = vi.hoisted(() => ({
  offer: undefined as
    | {
        proverTip: bigint
        standardEtaSeconds: number
        tippedEtaSeconds: number
        worstSpeedupSeconds: number
        measured: boolean
      }
    | undefined,
  loading: false,
}))
vi.mock("../../../../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: ({ active }: { active: boolean }) =>
    active ? { offer: faster.offer, loading: faster.loading } : { loading: false },
}))
vi.mock("../../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => true }))
vi.mock("../../../../src/ui/format", () => ({
  shortAddr: (v: string) => v,
  shortL1Addr: (v: string) => v,
  usdFigure: (v: string) => v,
  tokenAmount: (v: string) => v,
}))
const { ClaimToL1Modal } = await import("../../../../src/features/paylink/ClaimToL1Modal")
const proof = { vkey: ["key"], proof: ["proof"], public_inputs: ["caller"] }
const address = "0x2222222222222222222222222222222222222222"
let container: HTMLDivElement
let root: Root
let link: PaymentLink
function render() {
  act(() =>
    root.render(
      <ClaimToL1Modal
        link={link}
        ready
        onClose={m.close}
        onHandOff={m.handOff}
        onConfirm={m.confirm}
        planSwap={async () => undefined}
      />,
    ),
  )
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!
}
async function review() {
  render()
  const input = container.querySelector('input[placeholder="Paste an address"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, address)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Claim")
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  m.close.mockReset()
  m.handOff.mockReset()
  m.screening.cleared = true
  m.config.network = "sandbox"
  route.state = "ready"
  faster.offer = undefined
  faster.loading = false
  m.verify.mockResolvedValue(proof)
  m.confirm.mockReturnValue(new Promise(() => {}))
  link = {
    fragment: "fragment",
    url: "",
    amount: "25",
    status: "unclaimed",
    flavor: "email",
    tokenAddress: `0x${"5c".repeat(32)}`,
  }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("email external-wallet claim modal", () => {
  it("verifies before confirmation and submits only once with the proof", async () => {
    await review()
    expect(button("Confirm and claim")).toBeUndefined()
    await click("Verify email with Google")
    // The proof binds the source deployment's executor and the payload paying the recipient.
    expect(m.caller).toHaveBeenCalledWith(m.executor, address)
    expect(m.verify.mock.calls[0]![0]).toEqual({ bound: address })
    expect(m.confirm).not.toHaveBeenCalled()
    const confirm = button("Confirm and claim")
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: address, zkProof: proof }),
      expect.any(Function),
    )
  })

  it("holds verification until the proof's caller is hashed", async () => {
    let finish!: (caller: { bound: string }) => void
    m.caller.mockReturnValueOnce(new Promise((r) => (finish = r)))
    await review()
    expect(button("Verify email with Google").disabled).toBe(true)
    await act(async () => finish({ bound: address }))
    expect(button("Verify email with Google").disabled).toBe(false)
  })

  it("discards verification when returning to edit the address", async () => {
    await review()
    await click("Verify email with Google")
    await click("Cancel")
    expect((m.verify.mock.calls[0]![4] as AbortSignal).aborted).toBe(true)
    await click("Claim")
    expect(button("Verify email with Google")).toBeTruthy()
    expect(button("Confirm and claim")).toBeUndefined()
  })

  it("ignores a late proof after close and prevents duplicate verification", async () => {
    let finish!: (value: typeof proof) => void
    m.verify.mockReturnValue(
      new Promise((r) => {
        finish = r
      }),
    )
    await review()
    await click("Verify email with Google")
    await click("Verify email with Google")
    expect(m.verify).toHaveBeenCalledTimes(1)
    await click("Close")
    const isActive = m.verify.mock.calls[0]![3] as () => boolean
    expect(isActive()).toBe(false)
    expect((m.verify.mock.calls[0]![4] as AbortSignal).aborted).toBe(true)
    await act(async () => finish(proof))
    expect(m.confirm).not.toHaveBeenCalled()
    expect(button("Confirm and claim")).toBeUndefined()
  })

  it("does not submit when screening changes after review", async () => {
    await review()
    await click("Verify email with Google")
    m.screening.cleared = false
    render()
    expect(button("Confirm and claim").disabled).toBe(true)
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it.each(["email", "direct"] as const)(
    "waits for the escrow amount before a %s withdrawal",
    async (flavor) => {
      link.flavor = flavor
      link.amount = undefined
      await review()
      expect(button("Connecting…").disabled).toBe(true)
      expect(container.textContent).not.toContain("too little")
      await click("Connecting…")
      expect(m.verify).not.toHaveBeenCalled()
      expect(m.confirm).not.toHaveBeenCalled()

      link.amount = "25"
      render()
      const title = flavor === "email" ? "Verify email with Google" : "Confirm and claim"
      expect(button(title).disabled).toBe(false)
      await click(title)
      if (flavor === "email") await click("Confirm and claim")
      expect(m.confirm).toHaveBeenCalledTimes(1)
    },
  )

  it("refuses a link the fee would consume", async () => {
    link.flavor = "direct"
    link.amount = "0.3"
    await review()
    expect(container.textContent).toContain("too little")
    expect(button("Confirm and claim").disabled).toBe(true)
  })
})

describe("external-wallet claim — the per-withdrawal limit", () => {
  // The burn spends the whole escrow, so the link's amount is the withdrawal the limit counts.
  const REFUSAL = `This link holds more than the ${LIMIT_USD} withdrawal limit, so it cannot be claimed to an Ethereum wallet.`
  const ONE_UNIT_OVER = `${LIMIT}.000000000000000001`
  const notice = () => container.querySelector('[data-testid="limit-notice"]')?.textContent

  it(`claims a direct link of exactly ${LIMIT_USD}`, async () => {
    link.flavor = "direct"
    link.amount = String(LIMIT)
    await review()
    expect(notice()).toBeUndefined()
    await click("Confirm and claim")
    expect(m.confirm).toHaveBeenCalledTimes(1)
  })

  it("refuses a direct link one atomic unit over before review, email proof or burn", async () => {
    link.flavor = "direct"
    link.amount = ONE_UNIT_OVER
    await review()
    expect(notice()).toBe(REFUSAL)
    expect(button("Claim").disabled).toBe(true)
    expect(button("Confirm and claim")).toBeUndefined()
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it("holds a direct claim whose amount is read as over the limit after review", async () => {
    link.flavor = "direct"
    link.amount = undefined
    await review()
    link.amount = ONE_UNIT_OVER
    render()
    expect(notice()).toBe(REFUSAL)
    expect(button("Confirm and claim").disabled).toBe(true)
    await click("Confirm and claim")
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it("still screens the address of a link within the limit", async () => {
    m.screening.cleared = false
    link.amount = String(LIMIT)
    await review()
    expect(container.textContent).toContain("Screening")
    expect(button("Claim").disabled).toBe(true)
  })
})

describe("external-wallet claim — the direct route's fee", () => {
  it("waits on the fee rather than naming a figure it does not have", async () => {
    route.state = "pending"
    await review()

    expect(button("Connecting…")).toBeTruthy()
    expect(button("Connecting…").disabled).toBe(true)
    expect(container.textContent).not.toContain(FEE_COPY)
  })

  it("says why there is no figure once the fee is reported unreadable", async () => {
    route.state = "unavailable"
    await review()

    expect(container.textContent).toContain(FEE_COPY)
    // Not a wait any more, and nothing the sheet can price: the CTA stays shut.
    expect(button("Connecting…")).toBeUndefined()
    expect(button("Verify email with Google").disabled).toBe(true)
  })
})

describe("external-wallet claim — speed", () => {
  const TIP = 500_000_000_000_000_000n
  const offer = {
    proverTip: TIP,
    standardEtaSeconds: 44 * 60,
    tippedEtaSeconds: 12 * 60,
    worstSpeedupSeconds: 30 * 60,
    measured: true,
  }
  const factRow = (label: string) =>
    Array.from(container.querySelectorAll(".ww-deposit__fact")).find(
      (f) => f.querySelector("span")?.textContent === label,
    )
  const trigger = () => factRow("Speed")?.querySelector("button") ?? null
  const fact = (label: string) => factRow(label)?.querySelector("b")?.textContent
  const openSpeeds = async () => {
    await act(async () => trigger()!.click())
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
  }
  const chooseFaster = async () => {
    const [, fasterOption] = await openSpeeds()
    await act(async () => fasterOption!.click())
  }
  const chooseStandard = async () => {
    const [standardOption] = await openSpeeds()
    await act(async () => standardOption!.click())
  }
  const submittedTip = () => m.confirm.mock.calls[0]![0].proverTip

  beforeEach(() => {
    link.flavor = "direct"
  })

  it("drops the tip from the fee and the burn when Standard is chosen", async () => {
    faster.offer = offer
    await review()
    await chooseStandard()
    expect(trigger()!.textContent).toBe("Standard")
    expect(fact("Network fee")).toBe("0.35")
    expect(fact("You receive")).toBe("24.65")
    await click("Confirm and claim")
    expect(submittedTip()).toBe(0n)
  })

  it("charges the tip in the fee and submits it when Faster is chosen", async () => {
    faster.offer = offer
    await review()
    await chooseFaster()
    expect(trigger()!.textContent).toBe("Faster")
    expect(fact("Network fee")).toBe("0.85")
    expect(fact("You receive")).toBe("24.15")
    await click("Confirm and claim")
    expect(submittedTip()).toBe(TIP)
  })

  it("shows Faster settled, with no tip, when a tip would not save a minute for certain", async () => {
    faster.offer = { ...offer, worstSpeedupSeconds: 59 }
    await review()
    expect(trigger()!.textContent).toBe("Faster")
    expect(trigger()!.disabled).toBe(true)
    expect(fact("Network fee")).toBe("0.35")
    await click("Confirm and claim")
    expect(submittedTip()).toBe(0n)
  })
})

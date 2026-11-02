import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveBalances } from "../../support/balances"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n
const state = vi.hoisted(() => ({
  position: {
    shares: 100n * 10n ** 18n,
    value: 105n * 10n ** 18n,
    sharePrice: 105n * 10n ** 16n,
    apy: 0.055,
    readAt: 1,
  } as {
    shares: bigint
    value: bigint
    sharePrice: bigint
    apy?: number
    readAt: number
  } | null,
  quote: vi.fn(),
  move: vi.fn(),
  balance: 50n * 10n ** 18n,
  timing: undefined as { releaseSeconds: (at: number) => number } | undefined,
  savingsMoveEta: vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  SavingsFeeError: class SavingsFeeError extends Error {
    constructor(readonly fee: bigint) {
      super("fee")
    }
  },
  useSavings: () => ({ position: state.position, quote: state.quote, move: state.move }),
  SHARE: 10n ** 18n,
  savingsPaybackYears: (net: bigint, fee: bigint, apy: number) =>
    fee <= 0n
      ? 0
      : net <= 0n || !(apy > 0)
      ? Infinity
      : Math.log1p(Number(fee) / Number(net)) / Math.log1p(apy),
  savingsMoveEta: state.savingsMoveEta,
  normalizeAmountInput: (v: string) => v,
  tokenAmount: (v: string) => v,
  AMOUNT_MAX_DECIMALS: 2,
  decimalPlaces: (v: string) => (v.split(".")[1] ?? "").length,
  formatDateLabel: () => "Today",
  formatTimeLabel: () => "14:32",
  isDecimalAmount: (v: string) => /^\d+(\.\d+)?$/.test(v),
  isSafeAmountNumber: () => true,
}))
vi.mock("@obsidion/passkey-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/passkey-web")>()),
  isPasskeyCancelled: () => false,
}))
// A small per-burn maximum and Main's dollar limit, so both are reachable in a test.
const limits = vi.hoisted(() => ({ cap: 10n ** 30n, dollars: 10n ** 30n }))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({ useTxAmountCap: () => limits.cap }))
vi.mock("../../../src/features/savings/savingsGateway", () => ({
  getSavingsTuple: async () => undefined,
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/features/limits/withdrawalLimit", () => ({
  withdrawalLimitProblem: (debit: bigint) => (debit > limits.dollars ? "public" : undefined),
  sharesBurnLimitProblem: (shares: bigint, cap?: bigint) =>
    cap !== undefined && shares > cap ? "protocol" : undefined,
  sharesBurnMax: (shares: bigint, cap?: bigint) =>
    cap !== undefined && shares > cap ? cap : shares,
  withdrawalMaxAtomic: (balance: bigint) => (balance > limits.dollars ? limits.dollars : balance),
}))
vi.mock("../../../src/features/limits/publicLimit", () => ({
  usdFigureGrouped: (display: string) => `$${Number(display).toFixed(2)}`,
  LimitNotice: ({
    problem,
    maximum,
    onUseMaximum,
  }: {
    problem: string
    maximum?: string
    onUseMaximum?: () => void
  }) => (
    <div data-testid="limit-notice">
      {problem === "protocol" ? "Over the network's maximum per withdrawal" : "Over the limit"}
      {onUseMaximum && <button onClick={onUseMaximum}>{`Use maximum (${maximum})`}</button>}
    </div>
  ),
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => <span data-testid="spinner" />,
  GradientText: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))
vi.mock("../../../src/ui/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}))
vi.mock("../../../src/ui/hooks", () => ({
  useProvingOutcome: () => ({
    start: vi.fn(),
    updateStage: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn(),
  }),
}))
vi.mock("../../../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/operations/operations")>()),
  useBusyLabel: () => "Busy",
}))
const handOff = vi.hoisted(() => vi.fn())
vi.mock("../../../src/features/operations/OperationHandOff", () => ({
  OperationHandOff: (props: { until?: string }) => {
    handOff(props)
    return <div>Working</div>
  },
}))
vi.mock("../../../src/features/provingGate", () => ({ useUserFlowActive: () => false }))
vi.mock("../../../src/features/savings/savingsMoveTiming", () => ({
  useSavingsMoveTiming: () => state.timing,
  savingsEtaCopy: (eta: { seconds: number; remaining: boolean }) =>
    `${eta.remaining ? "About" : "Usually about"} ${Math.round(eta.seconds / 60)} min${
      eta.remaining ? " left" : ""
    }`,
}))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  SponsoredActionNotice: () => null,
  useSponsoredActionBlock: () => undefined,
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))
import {
  MoveFundsSheet,
  sharesFor,
} from "../../../src/features/savings/MoveFundsSheet/MoveFundsSheet"

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  openTestSession({ balances: liveBalances(() => ({ main: state.balance, live: true })) })
  state.position = {
    shares: 100n * 10n ** 18n,
    value: 105n * 10n ** 18n,
    sharePrice: 105n * 10n ** 16n,
    apy: 0.055,
    readAt: 1,
  }
  state.balance = 50n * 10n ** 18n
  limits.cap = 10n ** 30n
  limits.dollars = 10n ** 30n
  state.timing = undefined
  state.savingsMoveEta.mockReset()
  handOff.mockReset()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  vi.useFakeTimers()
  state.quote.mockReset()
  state.move.mockReset()
  state.quote.mockImplementation(async (direction: string, amount: bigint) => ({
    direction,
    amount,
    value: direction === "in" ? amount : (amount * 105n) / 100n,
    net: (direction === "in" ? amount : (amount * 105n) / 100n) - 2n * ONE,
    fee: 2n * ONE,
  }))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Amount to move"]')!
const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!
const termsBox = () =>
  host.querySelector<HTMLInputElement>('.ww-savings__terms input[type="checkbox"]')
const accept = () => act(() => termsBox()!.click())
// The debounce, then the quote and the quote of the way back, each a tick of microtasks.
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  })

describe("MoveFundsSheet", () => {
  it("puts a move in's fee on top: Savings lands the typed DAI, Main burns that plus the fee", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.textContent).toContain("Add to Savings")
    expect(host.textContent).toContain("Available: $50.00")
    expect(button("Review").disabled).toBe(true)
    type("10")
    await settle()
    // The typed amount is priced for its fee, then the burn is that much more.
    expect(state.quote).toHaveBeenCalledWith("in", 10n * ONE)
    expect(state.quote).toHaveBeenCalledWith("in", 12n * ONE)
    expect(host.textContent).toContain("L1 fee$2.00")
    expect(host.textContent).toContain("Main Account pays$12.00")
    expect(host.textContent).not.toContain("receives")
    act(() => button("Review").click())
    expect(host.textContent).toContain("Confirm move")
    expect(host.textContent).toContain("Amount$10.00")
    expect(host.textContent).toContain("Main Account pays$12.00")
    accept()
    await act(async () => button("Confirm move").click())
    expect(state.move).toHaveBeenCalledWith("in", 12n * ONE, expect.any(Function))
  })

  it("stops a move in whose fee on top would overspend, and says so with the total", async () => {
    state.balance = 11n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.textContent).toContain("Balance not enough for the amount plus the fee ($12.00)")
    expect(button("Review").disabled).toBe(true)
  })

  it("puts the fee on top of a move in too small to cover it alone", async () => {
    const { SavingsFeeError } = await import("@obsidion/front-core")
    const base = state.quote.getMockImplementation()!
    state.quote.mockImplementation(async (direction: string, amount: bigint) => {
      if (amount <= 2n * ONE) throw new SavingsFeeError(2n * ONE)
      return base(direction, amount)
    })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("1")
    await settle()
    expect(host.textContent).toContain("Main Account pays$3.00")
    expect(button("Review").disabled).toBe(false)
  })

  it("stops a move in whose fee keeps rising past the typed amount", async () => {
    let fee = 2n * ONE
    state.quote.mockImplementation(async (direction: string, amount: bigint) => {
      fee += ONE
      return { direction, amount, value: amount, net: amount - fee, fee }
    })
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(button("Review").disabled).toBe(true)
  })

  it("applies Main's withdrawal limit to the amount plus the fee", async () => {
    limits.dollars = 11n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.querySelector('[data-testid="limit-notice"]')?.textContent).toContain(
      "Over the limit",
    )
    expect(button("Review").disabled).toBe(true)
  })

  it("takes the fee off a MAX move in, since nothing is left to put it on top", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    act(() => button("MAX").click())
    await settle()
    expect(state.quote).toHaveBeenCalledWith("in", 50n * ONE)
    expect(state.quote).not.toHaveBeenCalledWith("in", 52n * ONE)
    expect(host.textContent).toContain("Savings receives≈ $48.00")
    expect(host.textContent).not.toContain("pays")
  })

  it("moves out in shares worth the typed dollars, and every share for MAX", async () => {
    // A position worth $714.287899…: MAX shows the cents, rounded down, and takes every share.
    state.position = {
      shares: 700n * ONE,
      value: 714287899390558444472n,
      sharePrice: 714287899390558444472n / 700n,
      apy: 0.055,
      readAt: 1,
    }
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    expect(host.textContent).toContain("Move to Main Account")
    expect(host.textContent).toContain("Available: $714.28")
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("714.28")
    expect(host.textContent).toContain("$714.28")
    expect(host.textContent).not.toContain("Use up to 2 decimal places")
    expect(state.quote).toHaveBeenLastCalledWith("out", 700n * ONE)
    expect(button("Review").disabled).toBe(false)
    // An edited amount takes the shares its dollars are worth.
    type("21")
    await settle()
    expect(state.quote).toHaveBeenLastCalledWith(
      "out",
      (21n * ONE * 700n * ONE) / 714287899390558444472n,
    )
  })

  it("keeps the review on screen when a position refresh re-quotes it and the quote fails", async () => {
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    type("21")
    await settle()
    act(() => button("Review").click())
    expect(host.textContent).toContain("Confirm move")
    state.position = { ...state.position!, value: 106n * ONE }
    state.quote.mockRejectedValue(new Error("rpc down"))
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    await settle()
    expect(button("Confirm move").disabled).toBe(true)
    expect(host.querySelector(".ww-pay__error")).not.toBeNull()
    expect(host.textContent).toContain("From")
  })

  it("shows the new figures to confirm again when fees rose after the review", async () => {
    const { SavingsQuoteChangedError } = await import("../../../src/features/savings/quoteChanged")
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    act(() => button("Review").click())
    const higher = {
      direction: "in",
      amount: 10n * ONE,
      value: 10n * ONE,
      net: 7n * ONE,
      fee: 3n * ONE,
    }
    state.move.mockRejectedValueOnce(new SavingsQuoteChangedError(higher as never))
    accept()
    await act(async () => button("Confirm move").click())
    expect(host.textContent).toContain(
      "Fees went up since your review: $3.00 now. Nothing was sent.",
    )
    expect(host.textContent).toContain("L1 fee$3.00")
    expect(button("Confirm move").disabled).toBe(false)
  })

  it("stops a move out at the network's maximum per burn, and MAX takes no more shares than that", async () => {
    limits.cap = 50n * ONE
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    // $105 is 100 shares: over the 50-share maximum.
    type("105")
    await settle()
    expect(host.querySelector('[data-testid="limit-notice"]')?.textContent).toContain(
      "Over the network's maximum per withdrawal",
    )
    expect(button("Review").disabled).toBe(true)
    // MAX: the 50 shares' worth, $52.50.
    act(() => button("Use maximum ($52.50)").click())
    await settle()
    expect(input().value).toBe("52.5")
    expect(state.quote).toHaveBeenLastCalledWith("out", 50n * ONE)
    expect(host.querySelector('[data-testid="limit-notice"]')).toBeNull()
    expect(button("Review").disabled).toBe(false)
  })

  it("stops a move in's MAX at Main's withdrawal limit, so the move can go ahead", async () => {
    limits.dollars = 20n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("20")
    expect(state.quote).toHaveBeenCalledWith("in", 20n * ONE)
    expect(host.querySelector('[data-testid="limit-notice"]')).toBeNull()
    expect(button("Review").disabled).toBe(false)
  })

  it("applies Main's withdrawal limit to a move in, not to a move out", async () => {
    limits.dollars = 20n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("30")
    await settle()
    expect(host.querySelector('[data-testid="limit-notice"]')?.textContent).toContain(
      "Over the limit",
    )
    expect(button("Review").disabled).toBe(true)
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!.click())
    await settle()
    expect(host.querySelector('[data-testid="limit-notice"]')).toBeNull()
    expect(button("Review").disabled).toBe(false)
  })

  it("moves in the whole DAI balance for MAX, past the cent the field shows", async () => {
    state.balance = 50n * ONE + (129999n * ONE) / 1_000_000n
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    act(() => button("MAX").click())
    await settle()
    expect(input().value).toBe("50.12")
    // The way back is quoted after it, so this is not the last call.
    expect(state.quote).toHaveBeenCalledWith("in", state.balance)
    act(() => button("Review").click())
    accept()
    await act(async () => button("Confirm move").click())
    expect(state.move).toHaveBeenCalledWith("in", state.balance, expect.any(Function))
  })

  it("refuses more than the balance and swaps direction in place", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("60")
    await settle()
    expect(host.textContent).toContain("Balance not enough")
    expect(state.quote).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!.click())
    await settle()
    expect(host.textContent).toContain("Available: $105.00")
    expect(state.quote).toHaveBeenCalledWith("out", expect.any(BigInt))
  })

  it("says what fee an amount cannot cover", async () => {
    const { SavingsFeeError } = await import("@obsidion/front-core")
    state.quote.mockRejectedValue(new SavingsFeeError(3n * ONE))
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    type("2")
    await settle()
    expect(host.textContent).toContain("does not cover the L1 fee ($3.00)")
    expect(button("Review").disabled).toBe(true)
  })
})

describe("sharesFor", () => {
  it("prices dollars in shares at the position's rate, capping at every share", () => {
    const position = { shares: 100n, value: 105n }
    expect(sharesFor(position, 21n)).toBe(20n)
    expect(sharesFor(position, 105n)).toBe(100n)
    expect(sharesFor(position, 200n)).toBe(100n)
    expect(sharesFor({ shares: 0n, value: 0n }, 5n)).toBe(0n)
  })
})

describe("MoveFundsSheet, the fee to move in", () => {
  const PAYBACK =
    /At 5\.5% APY it takes about (\d+ \w+) to earn back the \$2\.00 fee to move to savings\./
  it("warns when a move in takes over a year to earn back its fee", async () => {
    // A $2 fee on top: $10 in lands $10, which earns $2 back in about three years at 5.5%.
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(state.quote).not.toHaveBeenCalledWith("out", expect.anything())
    const warning = host.querySelector(".ww-withdraw__warning")
    expect(warning?.textContent).toContain(
      "At 5.5% APY it takes about 3 years to earn back the $2.00 fee to move to savings.",
    )
    expect(host.textContent).toContain("Current APY 5.5%.")
    expect(host.textContent).not.toContain("variable")
    expect(button("Review").disabled).toBe(false)
  })

  it("notes the payback plainly for a move that earns its fees back within a year", async () => {
    state.balance = 10_000n * ONE
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("5000")
    await settle()
    expect(host.textContent).toContain("Main Account pays$5,002.00")
    expect(host.querySelector(".ww-withdraw__warning")).toBeNull()
    const notes = [...host.querySelectorAll(".ww-sheet__note")].map((n) => n.textContent)
    const line = notes.find((text) => PAYBACK.test(text ?? ""))
    expect(line).toMatch(/about \d+ days/)
  })

  it("says nothing without a rate, and nothing on a move to Main", async () => {
    state.position = { ...state.position!, apy: undefined }
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.textContent).not.toContain("to earn back")
    state.position = { ...state.position!, apy: 0.055 }
    // The sheet owns its direction once mounted: a fresh mount for the move out.
    act(() => root.render(<div />))
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    type("10")
    await settle()
    expect(host.textContent).not.toContain("to earn back")
  })
})

describe("MoveFundsSheet, notes", () => {
  it("shows the current rate on a move in, and only there", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.textContent).toContain("Current APY 5.5%.")
    expect(host.textContent).not.toContain("variable")
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Swap direction"]')!.click())
    expect(host.textContent).not.toContain("Current APY")
    state.position = { ...state.position!, apy: undefined }
    act(() => root.render(<div />))
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.textContent).toContain("Rate unavailable")
  })

  it("shows the fee loading while a quote is in flight, and holds Review until it lands", async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    expect(host.textContent).toContain("L1 fee$--")
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull()
    type("10")
    expect(host.textContent).toContain("Getting fee…")
    expect(host.querySelector('[data-testid="spinner"]')).not.toBeNull()
    expect(host.textContent).not.toContain("$--")
    expect(button("Review").disabled).toBe(true)
    await settle()
    expect(host.textContent).not.toContain("Getting fee…")
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull()
    expect(host.textContent).toContain("L1 fee$2.00")
    expect(button("Review").disabled).toBe(false)
  })
})

describe("MoveFundsSheet, confirm step", () => {
  const review = async () => {
    act(() => root.render(<MoveFundsSheet direction="in" onClose={() => {}} />))
    type("10")
    await settle()
    act(() => button("Review").click())
  }

  it("estimates the time from the live timing as a move submitted now", async () => {
    state.timing = { releaseSeconds: () => 600 }
    state.savingsMoveEta.mockReturnValue({ seconds: 25 * 60, remaining: false })
    await review()
    expect(host.textContent).toContain("Estimated timeUsually about 25 min")
    expect(state.savingsMoveEta).toHaveBeenCalledWith(
      { startTime: expect.any(Number) },
      { phase: "submitting", startTime: expect.any(Number) },
      state.timing,
      expect.any(Number),
    )
    expect(host.textContent).toContain("Keep this tab open until the move is sent.")
  })

  it("falls back to the usual estimate while the timing has not loaded", async () => {
    await review()
    expect(host.textContent).toContain("Estimated timeUsually about 40 min")
    expect(state.savingsMoveEta).not.toHaveBeenCalled()
  })

  it("holds Confirm on a move in until the terms are accepted, and links all three", async () => {
    await review()
    expect(host.textContent).toContain("Confirm you have read and accept the terms")
    const links = [...host.querySelectorAll<HTMLAnchorElement>(".ww-savings__terms a")]
    expect(links.map((a) => a.href)).toEqual([
      "https://docs.zk.money/terms",
      "https://docs.sky.money/legal/skybase-international/terms-of-use",
      "https://docs.sky.money/legal/skybase-international/user-risks",
    ])
    expect(links.every((a) => a.target === "_blank")).toBe(true)
    expect(button("Confirm move").disabled).toBe(true)
    await act(async () => button("Confirm move").click())
    expect(state.move).not.toHaveBeenCalled()
    accept()
    expect(button("Confirm move").disabled).toBe(false)
    act(() => termsBox()!.click())
    expect(button("Confirm move").disabled).toBe(true)
  })

  it("forgets the acceptance when the sheet is closed and opened again", async () => {
    await review()
    accept()
    expect(button("Confirm move").disabled).toBe(false)
    act(() => root.unmount())
    root = createRoot(host)
    await review()
    expect(termsBox()!.checked).toBe(false)
    expect(button("Confirm move").disabled).toBe(true)
  })

  it("asks nothing of a move out: the funds are the user's own, coming back", async () => {
    act(() => root.render(<MoveFundsSheet direction="out" onClose={() => {}} />))
    type("21")
    await settle()
    act(() => button("Review").click())
    expect(host.textContent).toContain("Confirm move")
    expect(termsBox()).toBeNull()
    expect(host.textContent).not.toContain("accept the terms")
    expect(button("Confirm move").disabled).toBe(false)
  })

  it("hands the sheet off once confirmed; the proof carries on under the bell", async () => {
    state.move.mockReturnValue(new Promise(() => {}))
    await review()
    accept()
    await act(async () => button("Confirm move").click())
    expect(host.textContent).toContain("Working")
    // The sheet hands off once the ceremony is done; the proof and the send carry on under the bell.
    expect(handOff).toHaveBeenCalled()
    expect(handOff.mock.lastCall?.[0]).not.toHaveProperty("until")
  })
})

/**
 * The wallet-funding sheet's gates: the charged total (amount + fee) against the wallet's balance,
 * the fee having loaded, the published limit on the gross send, the protocol ceiling on the credit,
 * shared deposit capacity (a real 1146 store behind the capacity module), screening, and the confirm
 * step with its last capacity check.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearWalletPrompt } from "../../../src/features/deposit/walletPrompt"

// The wallet-request slot is page-wide; forget what a case left open.
afterEach(clearWalletPrompt)
import { formatUnits, parseUnits, type Hex } from "viem"
import {
  createPortalCapacityStore,
  NOMINAL_USD_VALUATION,
  type PortalCapacityStore,
  type UsdValuation,
} from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import type { L1TokenBalance } from "../../../src/features/deposit/l1DepositTokenBalance"
import type { DepositTokenOption } from "../../../src/features/deposit/loadDepositFacts"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  mockLoadDepositFacts,
  ROW_USDC,
  tokenOption,
  twoRowTokens,
} from "../../support/depositTokens"
import * as copy from "../../../src/features/limits/limitsCopy"
import { LIMIT, LIMIT_USD, grouped, typed } from "../../support/publicLimit"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Hex
const balance: { current: L1TokenBalance | undefined } = { current: undefined }
const screening = { cleared: true }
type DepositParams = {
  amountDisplay: string
  tokenSymbol: string
  token?: { address: Hex; decimals: number }
  onSubmitted?: (h: Hex) => void
  onStage?: (stage: string) => void
  preflight: (fresh: { feeDisplay: string }) => Promise<void>
  beforeApprove?: (submission: string) => Promise<void>
  record?: boolean
}
const deposit = vi.fn(async (_params: DepositParams) => ({
  txHash: "0x01",
  address: "0xdeadbeef",
  name: "alice",
}))

const useL1TokenBalance = vi.hoisted(() => vi.fn())
const TX_AMOUNT_CAP = vi.hoisted(() => 5166n * 10n ** 18n)
const rowCap = vi.hoisted(() => ({ asked: [] as (string | undefined)[], twoRows: false }))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => TX_AMOUNT_CAP,
  useRowTxAmountCap: (rowToken?: string) => {
    rowCap.asked.push(rowToken)
    return TX_AMOUNT_CAP
  },
}))
vi.mock("../../../src/features/deposit/useL1TokenBalance", () => ({ useL1TokenBalance }))
vi.mock("../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ verdict: undefined, cleared: screening.cleared, rescreen: vi.fn() }),
  ScreeningNotice: () => <span>screening-notice</span>,
}))
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ deposit }),
}))

const DAI = 10n ** 18n
const KEY = {
  chainId: 11155111,
  portal: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
} as const
/** What the fake portal reports; each read takes the current values. */
const capacity = vi.hoisted(() => ({
  availableAtomic: 0n,
  fail: false,
  /** Reads never answer. */
  hang: false,
  /** How old each read's block is, by this device's clock. */
  blockAgeS: 0,
  keyFails: false,
  /** Answered reads. */
  reads: 0,
  /** Reads asked for, answered or not. */
  attempts: 0,
  store: undefined as unknown,
  rowTokens: [] as (string | undefined)[],
}))
vi.mock("../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: async (rowToken?: string) => {
    capacity.rowTokens.push(rowToken)
    if (capacity.keyFails) throw new Error("manifest unavailable")
    return {
      chainId: 11155111,
      portal: "0x1111111111111111111111111111111111111111",
      token: "0x2222222222222222222222222222222222222222",
    }
  },
  depositCapacityStore: () => capacity.store,
}))
const snapshot = (): PortalCapacitySnapshot => ({
  ...KEY,
  decimals: 18,
  blockNumber: BigInt(++capacity.reads),
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000) - capacity.blockAgeS),
  rateAtomicPerSecond: DAI,
  globalLimitAtomic: 50_000n * DAI,
  availableAtomic: capacity.availableAtomic,
  txAmountCapAtomic: TX_AMOUNT_CAP,
})
// Not sandbox: the balance ceiling only applies where nothing is minted on the way.
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1Chain: { name: "Sepolia" } }),
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// About limits reads these for its policy and allowance sections; this suite covers its capacity.
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: () => Promise.reject(new Error("no manifest in this suite")),
}))
vi.mock("../../../src/features/deposit/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(importOriginal, () => (rowCap.twoRows ? twoRowTokens() : mainnetTokens())),
)
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "signed-out" }, refresh: () => {} }),
}))
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))

const { DepositFromWalletModal } = await import("../../../src/features/deposit/DepositFromWalletModal")

const l1 = {
  account: ACCOUNT,
  accounts: [ACCOUNT],
  chainId: 1,
  walletName: "Rainbow",
  connecting: false,
  wrongChain: false,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => {},
  selectAccount: () => {},
  switchAccount: async () => {},
} as never

const token: DepositTokenOption = mainnetTokens().settlement
const holds = (display: string): L1TokenBalance => ({
  raw: BigInt(Math.round(Number(display) * 1e6)) * 10n ** 12n,
  value: Number(display),
  display: `${display} DAI`,
  symbol: "DAI",
  decimals: 18,
})

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSent = vi.fn()
const onSendFailed = vi.fn()
const onSendUnresolved = vi.fn()
const onFeeChanged = vi.fn()
const onApproving = vi.fn()
const onNotApproved = vi.fn()

async function render(
  fee?: string,
  pick = token,
  /** `null`: no valuation for this token. */
  valuation: UsdValuation | null = NOMINAL_USD_VALUATION,
  paying: { payee?: string; fixedAmount?: string } = {},
) {
  await act(async () => {
    root.render(
      <DepositFromWalletModal
        l1={l1}
        deposit={{ address: "0xdeadbeef" as Hex, name: "alice" }}
        token={pick}
        fee={fee}
        valuation={valuation ?? undefined}
        onClose={onClose}
        onSent={onSent}
        onSendFailed={onSendFailed}
        onSendUnresolved={onSendUnresolved}
        onFeeChanged={onFeeChanged}
        onApproving={onApproving}
        onNotApproved={onNotApproved}
        {...paying}
      />,
    )
  })
  await settleReads()
}
/** Lets the key lookup and capacity reads land. */
async function settleReads() {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
async function type(value: string) {
  const input = container.querySelector("input")!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const button = (title: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)!
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
/** Why the last send stopped before any transfer, shown next to the funding action. */
const reason = () => byTestId("funding-action-reason")?.textContent
/** The capacity line's reason; empty while capacity is healthy. */
const capacityReason = () => byTestId("funding-capacity-status")?.textContent

const transfer = vi.fn()
/** A gateway that runs the caller's last check, then "transfers". */
const checkedDeposit = (feeDisplay = "0.5", approval = false) =>
  deposit.mockImplementationOnce(async (params) => {
    await params.preflight({ feeDisplay })
    // The desktop bridge records the approval only once the recheck passed in time.
    if (approval) await params.beforeApprove?.("submission-1")
    transfer(params.amountDisplay)
    params.onSubmitted?.("0xabc")
    return { txHash: "0xabc", address: "0xdeadbeef", name: "alice" }
  })

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  balance.current = holds("10")
  useL1TokenBalance.mockReset().mockImplementation(() => balance.current)
  screening.cleared = true
  deposit.mockClear()
  transfer.mockClear()
  fireEvent.mockClear()
  onClose.mockClear()
  onSent.mockClear()
  onSendFailed.mockClear()
  onSendUnresolved.mockClear()
  onFeeChanged.mockClear()
  onApproving.mockReset()
  onNotApproved.mockClear()
  capacity.availableAtomic = 50_000n * DAI
  capacity.fail = false
  capacity.hang = false
  capacity.blockAgeS = 0
  capacity.keyFails = false
  capacity.reads = 0
  capacity.attempts = 0
  capacity.rowTokens = []
  rowCap.asked = []
  rowCap.twoRows = false
  capacity.store = createPortalCapacityStore(KEY, {
    read: () => {
      capacity.attempts++
      if (capacity.hang) return new Promise<never>(() => {})
      if (capacity.fail) return Promise.reject(new Error("rpc down"))
      return Promise.resolve(snapshot())
    },
    visibility: { isVisible: () => true, onResume: () => () => {} },
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("DepositFromWalletModal paying someone else", () => {
  const confirm = async () => {
    await act(async () => button("Continue").click())
    await act(async () => button("Confirm payment").click())
    await settleReads()
  }

  it("sends exactly a fixed request's amount plus the fee, which the payer cannot change", async () => {
    checkedDeposit()
    await render("0.5", token, NOMINAL_USD_VALUATION, { payee: "river", fixedAmount: "2.25" })
    const input = container.querySelector("input")!
    expect(input.value).toBe("2.25")
    expect(input.readOnly).toBe(true)
    await confirm()
    expect(transfer).toHaveBeenCalledWith("2.75")
    expect(deposit.mock.calls[0][0].record).toBe(false)
  })

  it("records the wallet's own deposit", async () => {
    checkedDeposit()
    await render("0.5")
    await type("3")
    await act(async () => button("Deposit funds").click())
    await act(async () => button("Confirm deposit").click())
    await settleReads()
    expect(deposit.mock.calls[0][0].record).toBe(true)
  })
})

describe("DepositFromWalletModal", () => {
  it("keeps healthy capacity out of the form, and its details on the same active bucket", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await render("0.5")
    await type("2")
    expect(byTestId("funding-capacity-panel")!.className).toContain("ww-capacity--quiet")
    expect(capacityReason()).toBe("")
    expect(container.textContent).not.toContain("50,000 DAI")
    const info = byTestId("operation-limits")!.querySelector<HTMLButtonElement>(
      '[data-testid="about-limits-link"]',
    )!
    expect(info.getAttribute("aria-label")).toBe("About the deposit limit")
    info.focus()
    await act(async () => info.click())
    await settleReads()
    const sheet = container.querySelector<HTMLDialogElement>(
      `dialog[aria-label="${copy.SHEET_TITLE}"]`,
    )!
    expect(sheet.open).toBe(true)
    expect(byTestId("about-limits-operation-toggle")!.getAttribute("aria-expanded")).toBe("true")
    expect(byTestId("about-limits-operation")!.textContent).toContain(copy.LIMIT_NOTE)
    const section = byTestId("about-limits-capacity")!
    expect(section.dataset.state).toBe("fresh")
    await act(async () => byTestId("about-limits-capacity-toggle")!.click())
    const available = [...section.querySelectorAll("dl > div")].find(
      (row) => row.querySelector("dt")?.textContent === "Available",
    )
    expect(available?.querySelector("dd")?.textContent).toBe("50,000 DAI")
    await act(async () => {
      sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(container.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)).toBeNull()
    expect(document.activeElement).toBe(info)
    vi.restoreAllMocks()
  })

  it("opens a capacity reason's details on capacity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    capacity.availableAtomic = 500n * DAI
    balance.current = holds(String(2 * LIMIT))
    await render("0.5")
    await type("2000")
    const panel = byTestId("funding-capacity-panel")!
    const info = panel.querySelector<HTMLButtonElement>('[data-testid="about-limits-link"]')!
    expect(info.getAttribute("aria-label")).toBe("About network capacity")
    await act(async () => info.click())
    await settleReads()
    const order = [
      ...container.querySelectorAll(`dialog[aria-label="${copy.SHEET_TITLE}"] section`),
    ].map((section) => (section as HTMLElement).dataset.testid)
    expect(order[0]).toBe("about-limits-capacity")
    expect(byTestId("about-limits-capacity-toggle")!.getAttribute("aria-expanded")).toBe("true")
    expect(byTestId("about-limits-capacity")!.textContent).toContain("500 DAI")
    vi.restoreAllMocks()
  })

  it("charges amount + fee and blocks when that total exceeds the balance", async () => {
    await render("0.5")
    await type("9.6")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("Not enough funds")
    await type("9.5")
    expect(button("Deposit funds").disabled).toBe(false)
    expect(container.textContent).toContain("You send10 DAI")
  })

  it("shows the wallet balance, and MAX enters it less the fee", async () => {
    await render("0.5")
    expect(container.textContent).toContain("Balance: $10")
    await act(async () => button("MAX").click())
    expect(container.querySelector("input")!.value).toBe("9.5")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("caps MAX at the published limit", async () => {
    balance.current = holds(String(2 * LIMIT))
    await render("0.5")
    await act(async () => button("MAX").click())
    expect(container.querySelector("input")!.value).toBe(typed(LIMIT - 0.5))
  })

  it("offers no MAX when the balance does not cover the fee", async () => {
    balance.current = holds("0")
    await render("0.5")
    expect(container.textContent).toContain("Balance: $0")
    expect(button("MAX")).toBeUndefined()
  })

  it("unblocks once a later read finds the funds", async () => {
    balance.current = holds("0")
    await render("0.5")
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
    balance.current = holds("1000")
    await render("0.5")
    expect(container.textContent).toContain("Balance: $1,000")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("clears a rejected transfer's balance on the next read, even one that reads the same", async () => {
    const { InsufficientL1BalanceError } = await import(
      "../../../src/features/deposit/l1DepositTokenBalance"
    )
    deposit.mockRejectedValueOnce(new InsufficientL1BalanceError(holds("2")))
    await render("0.5")
    await type("5")
    await act(async () => button("Deposit funds").click())
    await act(async () => button("Confirm deposit").click())
    await settleReads()
    expect(container.textContent).toContain("Not enough funds")
    expect(button("Deposit funds").disabled).toBe(true)
    balance.current = holds("10")
    await render("0.5")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("stays enabled when the balance could not be read", async () => {
    balance.current = undefined
    await render("0.5")
    await type("5")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("cannot submit until the fee is known", async () => {
    await render(undefined)
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
  })

  it(`counts the gross send, fee included, against the ${LIMIT_USD} limit and offers the largest amount that fits`, async () => {
    balance.current = holds(String(2 * LIMIT))
    await render("0.5")
    await type(typed(LIMIT - 0.5))
    expect(button("Deposit funds").disabled).toBe(false)
    expect(container.textContent).toContain(`You send${grouped(LIMIT)} DAI`)
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()

    await type(typed(LIMIT - 0.49))
    expect(button("Deposit funds").disabled).toBe(true)
    const notice = container.querySelector('[data-testid="limit-notice"]')!
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.textContent).toContain(`Over the ${LIMIT_USD} limit`)
    // Said once: the field keeps its figure instead of repeating the reason.
    expect(container.querySelector(".ww-fund__amount small")!.textContent).not.toMatch(
      /limit|maximum/i,
    )
    // Nothing lands, so nothing is quoted as sent or received either.
    expect(container.textContent).toContain("You send--")
    expect(container.textContent).toContain("You receive--")

    // The correction is the user's choice, never applied on its own.
    expect(container.querySelector("input")!.value).toBe(typed(LIMIT - 0.49))
    await act(async () => button(`Use maximum ($${grouped(LIMIT - 0.5, true)})`).click())
    expect(container.querySelector("input")!.value).toBe(typed(LIMIT - 0.5))
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("checks the credit against the protocol ceiling separately from the published limit", async () => {
    // A valuation under a dollar puts the published limit above the ceiling, so only the ceiling
    // stops 5,166.01; the correction names no figure for it.
    const cheap: UsdValuation = { source: "test", usdPerToken: { numerator: 4n, denominator: 10n } }
    balance.current = holds(String(2 * LIMIT))
    await render("0.5", token, cheap)
    await type(formatUnits(TX_AMOUNT_CAP, 18))
    expect(button("Deposit funds").disabled).toBe(false)
    await type(`${formatUnits(TX_AMOUNT_CAP, 18)}.01`)
    expect(button("Deposit funds").disabled).toBe(true)
    const notice = container.querySelector('[data-testid="limit-notice"]')!
    expect(notice.textContent).toContain("Over the network's maximum per deposit")
    expect(notice.textContent).not.toMatch(/5,?166/)
    await act(async () => button("Use maximum").click())
    expect(container.querySelector("input")!.value).toBe(formatUnits(TX_AMOUNT_CAP, 18))
  })

  it("refuses to send a token it cannot value against the limit", async () => {
    await render("0.5", token, null)
    expect(container.querySelector('[data-testid="limit-notice"]')!.textContent).toContain(
      `can't be checked against the ${LIMIT_USD} limit`,
    )
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
  })

  it("counts a 6-decimal token's send in its own units and does not promise a 1:1 swap", async () => {
    const usdcToken = tokenOption("USDC", MAINNET_USDC, 6, MAINNET_DAI)
    balance.current = undefined
    await render("0.5", usdcToken)
    await type(typed(LIMIT - 0.5))
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()
    expect(container.textContent).toContain("USDC is swapped to DAI at the market rate")
    // The row takes its fee in DAI, as the deposit screen states it.
    expect(byTestId("fund-fee")?.textContent).toBe("0.50 DAI")
    await type(typed(LIMIT - 0.49))
    expect(container.querySelector('[data-testid="limit-notice"]')).not.toBeNull()
  })

  it("says a USDC row credits USDC, in USDC, on its own row's cap and bucket", async () => {
    rowCap.twoRows = true
    const usdcRow = twoRowTokens().options[1]!
    balance.current = undefined
    await render("0.1", usdcRow)
    await type("10")
    await act(async () => button("Deposit funds").click())
    expect(byTestId("fund-fee")?.textContent).toBe("0.10 USDC")
    expect(byTestId("fund-credit-note")?.textContent).toBe(
      "Each USDC you send is credited as 1 USDC, less the fee.",
    )
    expect(container.textContent).toContain("10.10 USDC")
    expect(container.textContent).not.toContain("DAI")
    expect(new Set(rowCap.asked)).toEqual(new Set([ROW_USDC]))
    expect(new Set(capacity.rowTokens)).toEqual(new Set([ROW_USDC]))
  })

  it("is gated on the sender clearing screening", async () => {
    screening.cleared = false
    await render("0.5")
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("screening-notice")
  })

  it("confirms before transferring the charged total, and cannot be dismissed mid-transfer", async () => {
    let resolveDeposit!: () => void
    deposit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeposit = () => resolve({ txHash: "0x01", address: "0xdeadbeef", name: "alice" })
        }),
    )
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    expect(deposit).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Confirm deposit")
    await act(async () => button("Confirm deposit").click())
    expect(deposit.mock.calls[0][0]).toMatchObject({ amountDisplay: "2.5", tokenSymbol: "DAI" })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveDeposit())
    // The connected-wallet leg of the deposit funnel: funded is stamped with its funding source.
    expect(fireEvent).toHaveBeenCalledWith(
      "deposit_funded",
      expect.objectContaining({ funding: "wallet" }),
    )
  })

  it("hands off once broadcast and reports a later confirmation failure to the caller", async () => {
    deposit.mockImplementationOnce(async (params) => {
      await params.preflight({ feeDisplay: "0.5" })
      params.onSubmitted?.("0xabc")
      throw new Error("reverted")
    })
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    await act(async () => button("Confirm deposit").click())
    // The charged amount is the whole figure the caller needs; the fee is already inside it.
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc", amount: "2.5" }))
    expect(onSendFailed).toHaveBeenCalled()
    // A reverted confirmation is a failure, never a funded funnel step.
    expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())
    expect(fireEvent).toHaveBeenCalledWith(
      "action_failed",
      expect.objectContaining({ action: "deposit:send" }),
    )
  })
})

describe("DepositFromWalletModal shared capacity", () => {
  beforeEach(() => {
    balance.current = holds(String(2 * LIMIT))
  })

  it("blocks 2,000 against 500 of capacity: the reason sits by the action and nothing is requested", async () => {
    capacity.availableAtomic = 500n * DAI
    await render("0.5")
    await type("2000")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(capacityReason()).toBe("This deposit needs 2,000 DAI; 500 DAI is available now.")
    // Said once, by the capacity line.
    expect(reason()).toBeUndefined()
    await act(async () => button("Deposit funds").click())
    expect(deposit).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()

    // A smaller amount only when the user asks for it.
    expect(container.querySelector("input")!.value).toBe("2000")
    await act(async () => byTestId("funding-capacity-use-available")!.click())
    expect(container.querySelector("input")!.value).toBe("500")
    expect(button("Deposit funds").disabled).toBe(false)
    // A fit is not a promise: the whole of a low bucket says only that it is low.
    expect(capacityReason()).toBe("Network capacity is low.")
  })

  it("returns to the form, with no transfer, when capacity drops between entry and confirmation", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    // The review keeps to the transfer itself; capacity rules are in the details.
    expect(container.textContent).not.toContain("doesn't reserve capacity")
    capacity.availableAtomic = DAI
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    await settleReads()
    expect(transfer).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    expect(button("Deposit funds").disabled).toBe(true)
    expect(capacityReason()).toBe("This deposit needs 2 DAI; 1 DAI is available now.")
    expect(reason()).toBeUndefined()
  })

  it("does not call a later capacity drop a failed transfer", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    expect(transfer).toHaveBeenCalledWith("2.5")
    capacity.availableAtomic = 0n
    await act(async () => void (capacity.store as PortalCapacityStore).retry())
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc" }))
    expect(onSendFailed).not.toHaveBeenCalled()
  })

  it("stops before the transfer when the fee read for the send differs from the one shown", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    checkedDeposit("0.6")
    await act(async () => button("Confirm deposit").click())
    expect(transfer).not.toHaveBeenCalled()
    expect(reason()).toBe("The deposit fee changed. Review the new amount before sending.")
    expect(onFeeChanged).toHaveBeenCalledOnce()
  })

  it.each([
    [
      "cannot be saved",
      "UnresolvedSendStorageError",
      "This browser couldn't save the deposit's progress.",
    ],
    [
      "would replace another send's",
      "UnresolvedSendHeldError",
      "Another deposit from your browser wallet may still be sent.",
    ],
  ] as const)(
    "approves nothing when the hold %s, and returns to the form",
    async (_case, name, note) => {
      const errors = await import("../../../src/features/deposit/unresolvedSend")
      onApproving.mockImplementation(async () => {
        throw new errors[name]()
      })
      await render("0.5")
      await type("2")
      await act(async () => button("Deposit funds").click())
      checkedDeposit("0.5", true)
      await act(async () => button("Confirm deposit").click())
      expect(onApproving).toHaveBeenCalledOnce()
      expect(onApproving).toHaveBeenCalledWith("submission-1")
      expect(transfer).not.toHaveBeenCalled()
      expect(reason()).toBe(note)
    },
  )

  it.each([
    ["the recheck budget ran out", true, "DesktopRecheckTimeoutError"],
    ["the send was approved without a hash", false, "DesktopSendUnresolvedError"],
  ] as const)(
    "when %s, reports the submission as never approved: %s",
    async (_case, notApproved, name) => {
      const desktop = await import("../../../src/platform/desktopBridge")
      onApproving.mockResolvedValue(undefined)
      await render("0.5")
      await type("2")
      await act(async () => button("Deposit funds").click())
      deposit.mockImplementationOnce(async (params) => {
        await params.beforeApprove?.("submission-1")
        throw name === "DesktopSendUnresolvedError"
          ? new desktop.DesktopSendUnresolvedError(new Error("no hash"))
          : new desktop.DesktopRecheckTimeoutError()
      })
      await act(async () => button("Confirm deposit").click())
      if (notApproved) expect(onNotApproved).toHaveBeenCalledWith("submission-1")
      else expect(onNotApproved).not.toHaveBeenCalled()
    },
  )

  it("does not save a hold when capacity refuses the approval", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    capacity.availableAtomic = DAI
    checkedDeposit("0.5", true)
    await act(async () => button("Confirm deposit").click())
    expect(onApproving).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()
  })

  it.each([
    [
      "an outdated desktop launcher",
      "DesktopBridgeUpdateRequiredError",
      "Update zk.money Desktop to send this transfer from your browser wallet.",
    ],
    [
      "a transfer still open in the browser wallet",
      "DesktopSendOpenError",
      "zk.money Desktop is still waiting on an earlier transfer from your browser wallet. Finish or cancel it there. If your wallet no longer shows it, restart zk.money Desktop.",
    ],
  ] as const)(
    "explains %s next to the action instead of filing an error report",
    async (_case, name, note) => {
      const desktop = await import("../../../src/platform/desktopBridge")
      const { showReportableError } = await import("../../../src/errors/errorModal")
      vi.mocked(showReportableError).mockClear()
      await render("0.5")
      await type("2")
      await act(async () => button("Deposit funds").click())
      deposit.mockImplementationOnce(async () => {
        throw new desktop[name]()
      })
      await act(async () => button("Confirm deposit").click())
      expect(reason()).toBe(note)
      expect(showReportableError).not.toHaveBeenCalled()
    },
  )

  it("sends while capacity cannot be read, and says nothing about it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    capacity.fail = true
    await render("0.5")
    await type("2")
    expect(capacityReason()).toBe("")
    expect(byTestId("funding-capacity-retry")).toBeNull()
    expect(button("Deposit funds").disabled).toBe(false)
    await act(async () => button("Deposit funds").click())
    expect(capacityReason()).toBe("")
    const before = capacity.attempts
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    // The last check still reads again; a failed read is not a reason to stop.
    expect(capacity.attempts).toBeGreaterThan(before)
    expect(transfer).toHaveBeenCalledWith("2.5")
    vi.restoreAllMocks()
  })

  it("sends when the deployment's bucket cannot be found, and says nothing about it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    capacity.keyFails = true
    await render("0.5")
    await type("2")
    expect(capacityReason()).toBe("")
    expect(byTestId("funding-capacity-retry")).toBeNull()
    await act(async () => button("Deposit funds").click())
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    expect(capacity.attempts).toBe(0)
    expect(transfer).toHaveBeenCalledWith("2.5")
    vi.restoreAllMocks()
  })

  it("sends when the read before the transfer finds the bucket out of date", async () => {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    // An hour-old block: the empty bucket it reports proves nothing.
    capacity.availableAtomic = 0n
    capacity.blockAgeS = 3_600
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    expect(transfer).toHaveBeenCalledWith("2.5")
  })

  it("hands a possibly funded address back to the caller instead of the form", async () => {
    const { DesktopSendUnresolvedError } = await import("../../../src/platform/desktopBridge")
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    deposit.mockImplementationOnce(async () => {
      throw new DesktopSendUnresolvedError(new Error("Network capacity changed."))
    })
    await act(async () => button("Confirm deposit").click())
    expect(onSendUnresolved).toHaveBeenCalledOnce()
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Deposit funds")
  })

  it("returns to the form when the desktop recheck ran out of time before any approval", async () => {
    const { DesktopRecheckTimeoutError } = await import("../../../src/platform/desktopBridge")
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    deposit.mockImplementationOnce(async () => {
      throw new DesktopRecheckTimeoutError()
    })
    await act(async () => button("Confirm deposit").click())
    expect(button("Deposit funds")).toBeDefined()
    expect(reason()).toBe("Checking this transfer took too long.")
  })
})

describe("DepositFromWalletModal from mainnet USDC", () => {
  const symbol = "USDC"
  const address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  // Swapped to DAI by the sweep, so the credit capacity meters is not known before the send.
  const pick = tokenOption(symbol, address, 6, MAINNET_DAI)
  const holdsStable = (display: string): L1TokenBalance => ({
    raw: parseUnits(display, 6),
    value: Number(display),
    display: `${display} ${symbol}`,
    symbol,
    decimals: 6,
  })
  const UNCERTAIN =
    /can't be checked|could not be checked|Checking capacity|Fits the current capacity/

  beforeEach(() => {
    balance.current = holdsStable(String(2 * LIMIT))
  })

  async function reviewAndConfirm(feeDisplay = "0.5") {
    await act(async () => button("Deposit funds").click())
    checkedDeposit(feeDisplay)
    await act(async () => button("Confirm deposit").click())
  }

  it("says nothing about capacity, and sends past the last check", async () => {
    await render("0.5", pick)
    expect(useL1TokenBalance).toHaveBeenCalledWith(expect.objectContaining({ token: address }))
    await type("2")
    expect(capacityReason()).toBe("")
    expect(byTestId("funding-capacity-retry")).toBeNull()
    expect(container.textContent).not.toMatch(UNCERTAIN)
    expect(button("Deposit funds").disabled).toBe(false)
    await act(async () => button("Deposit funds").click())
    expect(capacityReason()).toBe("")
    expect(container.textContent).not.toMatch(UNCERTAIN)
    expect(button("Confirm deposit").disabled).toBe(false)
    const before = capacity.reads
    checkedDeposit()
    await act(async () => button("Confirm deposit").click())
    expect(capacity.reads).toBeGreaterThan(before)
    expect(transfer).toHaveBeenCalledWith("2.5")
    expect(deposit.mock.calls[0][0]).toMatchObject({
      tokenSymbol: symbol,
      token: { address, decimals: 6 },
    })
    expect(onSent).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xabc", amount: "2.5", tokenSymbol: symbol }),
    )
  })

  it("says nothing and holds nothing for an amount above a low, nonzero bucket", async () => {
    capacity.availableAtomic = 500n * DAI
    await render("0.5", pick)
    await type("2000")
    expect(capacityReason()).toBe("")
    expect(container.textContent).not.toContain("Network capacity is low")
    expect(byTestId("funding-capacity-use-available")).toBeNull()
    expect(byTestId("funding-capacity-retry")).toBeNull()
    expect(button("Deposit funds").disabled).toBe(false)
    await reviewAndConfirm()
    expect(transfer).toHaveBeenCalledWith("2000.5")
  })

  it("sends when the deployment's bucket cannot be found, and says nothing about it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    capacity.keyFails = true
    await render("0.5", pick)
    await type("2")
    expect(capacityReason()).toBe("")
    expect(button("Deposit funds").disabled).toBe(false)
    await reviewAndConfirm()
    expect(transfer).toHaveBeenCalledWith("2.5")
    vi.restoreAllMocks()
  })

  it("keeps holding an empty bucket when the next read fails", async () => {
    capacity.availableAtomic = 0n
    await render("0.5", pick)
    await type("2")
    expect(capacityReason()).toBe("No network capacity is available right now.")
    capacity.fail = true
    const before = capacity.attempts
    await act(async () => void (capacity.store as PortalCapacityStore).retry())
    expect(capacity.attempts).toBeGreaterThan(before)
    expect((capacity.store as PortalCapacityStore).getState().status).toBe("unavailable")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(capacityReason()).toBe("No network capacity is available right now.")
    await act(async () => button("Deposit funds").click())
    expect(deposit).not.toHaveBeenCalled()
  })

  it(`keeps the ${LIMIT_USD} limit, the balance and screening`, async () => {
    await render("0.5", pick)
    await type(typed(LIMIT - 0.49))
    expect(button("Deposit funds").disabled).toBe(true)
    expect(byTestId("limit-notice")!.textContent).toContain(`Over the ${LIMIT_USD} limit`)
    await type(typed(LIMIT - 0.5))
    expect(button("Deposit funds").disabled).toBe(false)

    balance.current = holdsStable("2")
    await render("0.5", pick)
    await type("2")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("Not enough funds")

    balance.current = holdsStable(String(2 * LIMIT))
    screening.cleared = false
    await render("0.5", pick)
    await type("2")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("screening-notice")
  })
})

describe("DepositFromWalletModal waiting on the wallet", () => {
  const OPEN = "Your wallet still has the previous request open. Approve or reject it there first."
  const note = () => byTestId("wallet-prompt-stall")
  const stall = () => act(async () => vi.advanceTimersByTime(30_000))
  const cancel = () => act(async () => note()!.querySelector("button")!.click())
  /** Reaches the confirm step, then a transfer the wallet holds until the test answers for it. */
  async function toPrompt() {
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const held = {} as { resolve: (hash: Hex) => void; reject: (e: unknown) => void }
    deposit.mockImplementationOnce(async (params) => {
      params.onStage?.("sending")
      const txHash = await new Promise<Hex>((resolve, reject) =>
        Object.assign(held, { resolve, reject }),
      )
      params.onSubmitted?.(txHash)
      return { txHash, address: "0xdeadbeef", name: "alice" }
    })
    await act(async () => button("Confirm deposit").click())
    expect(container.textContent).toContain("Approve the transfer in your wallet")
    return held
  }

  afterEach(() => vi.useRealTimers())

  it("offers a way back once the wallet has shown nothing for 30 seconds", async () => {
    await toPrompt()
    await act(async () => vi.advanceTimersByTime(29_999))
    expect(note()).toBeNull()
    await act(async () => vi.advanceTimersByTime(1))
    expect(note()!.textContent).toContain("Still waiting for Rainbow.")
    await cancel()
    expect(note()).toBeNull()
    expect(button("Confirm deposit").disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("still hands off a hash that arrives after Cancel", async () => {
    const held = await toPrompt()
    await stall()
    await cancel()
    await act(async () => held.resolve("0xabc" as Hex))
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc" }))
    expect(fireEvent).toHaveBeenCalledWith(
      "deposit_funded",
      expect.objectContaining({ funding: "wallet" }),
    )
  })

  it("swallows a rejection that arrives after Cancel", async () => {
    const { showReportableError } = await import("../../../src/errors/errorModal")
    vi.mocked(showReportableError).mockClear()
    const held = await toPrompt()
    await stall()
    await cancel()
    await act(async () => held.reject(new Error("wallet closed")))
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
    expect(onSendFailed).not.toHaveBeenCalled()
    expect(button("Confirm deposit").disabled).toBe(false)
  })

  it("refuses a second confirm while the wallet still holds the first request", async () => {
    await toPrompt()
    await stall()
    await cancel()
    await act(async () => button("Confirm deposit").click())
    expect(deposit).toHaveBeenCalledTimes(1)
    expect(reason()).toBe(OPEN)
    expect(button("Confirm deposit").disabled).toBe(false)
  })
})

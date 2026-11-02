/**
 * The registration pay row while the connected wallet holds the transfer: the row shows it is busy,
 * the confirm sheet offers a way back once the prompt has stalled, and a late answer from the
 * wallet is still tracked or swallowed.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { clearWalletPrompt } from "../../../../src/features/deposit/walletPrompt"

// The wallet-request slot is page-wide; forget what a case left open.
afterEach(clearWalletPrompt)
import { createPortalCapacityStore, type RequiredCredit } from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  writeContract: vi.fn(),
  receipt: vi.fn(),
  report: vi.fn(),
  account: null as string | null,
  connecting: false,
  /** Which table the registration reads: one row, a USDC fee token, or none yet. */
  tokens: "single" as "single" | "usdc" | "unread",
  failed: false,
  retry: vi.fn(),
}))
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({
  isWalletRejection: (e: { code?: number }) => e?.code === 4001,
  isWalletDisconnect: () => false,
  isWrongNetwork: () => false,
  useL1Wallet: () => ({
    account: h.account,
    walletName: "Rainbow",
    connecting: h.connecting,
    disconnect: vi.fn(),
    connect: vi.fn(),
  }),
  getL1Clients: async () => ({
    walletClient: { writeContract: h.writeContract },
    account: ACCOUNT,
    chain: { id: 11155111 },
  }),
}))
vi.mock("../../../../src/features/deposit/l1DepositTokenBalance", () => ({
  readL1DepositTokenBalance: async () => ({
    raw: 1_000n * 10n ** 18n,
    display: "1000 DAI",
    symbol: "DAI",
  }),
}))
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: true, verdict: null, rescreen: vi.fn() }),
  ScreeningNotice: () => null,
}))
vi.mock("../../../../src/errors/errorModal", () => ({
  showReportableError: h.report,
  showErrorModal: vi.fn(),
}))
vi.mock("../../../../src/ui/hooks", () => ({ useCopy: () => ({ copied: false, copy: vi.fn() }) }))
vi.mock("../../../../src/features/onboarding/registrationFunnel", () => ({
  reportRegistrationDepositShown: vi.fn(),
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  Spinner: () => <span data-testid="spinner" />,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    isLoading,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
    isLoading?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={isDisabled || isLoading}>
      {title}
    </button>
  ),
  TopNavIconButton: () => null,
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet" }),
  l1ChainFor: () => ({ name: "Sepolia" }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ waitForTransactionReceipt: h.receipt }),
}))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken, usdcFeeTokens } = await import(
    "../../../support/depositTokens"
  )
  const single = singleToken("0x00000000000000000000000000000000000000dd")
  const usdc = usdcFeeTokens()
  return mockLoadDepositFacts(
    importOriginal,
    () => (h.tokens === "single" ? single : h.tokens === "usdc" ? usdc : undefined),
    undefined,
    () => ({ failed: h.failed, retry: h.retry }),
  )
})
import { DepositPayBlock } from "../../../../src/features/onboarding/steps/DepositAddress"

const OPEN = "Your wallet still has the previous request open. Approve or reject it there first."
const HOLDING = "Your wallet still holds this payment. Approve or reject it there."
const HASH = `0x${"11".repeat(32)}`
const DAI = 10n ** 18n
const BUCKET = {
  chainId: 11155111,
  portal: "0x9999999999999999999999999999999999999999",
  token: "0x00000000000000000000000000000000000000dd",
} as const
const REQUIRED: RequiredCredit = { status: "known", atomic: 1n, token: BUCKET.token, decimals: 18 }
function fundingStore() {
  let reads = 0
  return createPortalCapacityStore(BUCKET, {
    read: async () => ({
      ...BUCKET,
      decimals: 18,
      blockNumber: BigInt(++reads),
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      rateAtomicPerSecond: DAI,
      globalLimitAtomic: 50_000n * DAI,
      availableAtomic: 1_000n * DAI,
      txAmountCapAtomic: 10_000n * DAI,
    }),
    policy: { maxHeadAgeMs: Infinity },
    visibility: { isVisible: () => true, onResume: () => () => {} },
  })
}

let root: Root
let el: HTMLDivElement
let sequence = 0
let props: Parameters<typeof DepositPayBlock>[0]

const row = () => el.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
const note = () => el.querySelector<HTMLElement>('[data-testid="wallet-prompt-stall"]')
const reason = () => el.querySelector<HTMLElement>('[data-testid="registration-pay-reason"]')
const render = () => act(() => root.render(<DepositPayBlock {...props} />))
/** A sheet opened later for the same target. */
const reopen = () => {
  act(() => root.render(null))
  return render()
}
/** The wallet holds the transfer until the test answers for it. */
const atPrompt = () => {
  const held = {} as { resolve: (hash: string) => void; reject: (e: unknown) => void }
  h.writeContract.mockImplementationOnce(
    () => new Promise((resolve, reject) => Object.assign(held, { resolve, reject })),
  )
  return held
}
const confirm = async () => {
  await act(async () => row().click())
  const button = [...el.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (b) => b.textContent === "Confirm payment",
  )!
  await act(async () => button.click())
}
const stall = () => act(async () => vi.advanceTimersByTime(30_000))
const cancel = () => act(async () => note()!.querySelector("button")!.click())

beforeEach(() => {
  h.writeContract.mockReset()
  h.receipt.mockReset().mockResolvedValue({ status: "success" })
  h.report.mockReset()
  h.account = ACCOUNT
  h.connecting = false
  h.tokens = "single"
  h.failed = false
  h.retry.mockReset()
  // The payment lock is keyed by the target; each test pays its own address.
  props = {
    address: `0x${(++sequence).toString(16).padStart(40, "0")}`,
    token: BUCKET.token,
    chainId: 11155111,
    total: 11n,
    funding: { store: fundingStore(), required: REQUIRED, canFund: true },
  }
  el = document.createElement("div")
  document.body.appendChild(el)
  root = createRoot(el)
  void render()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  el.remove()
})

it("says it is connecting while the picker is up and nothing is connected", async () => {
  h.account = null
  h.connecting = true
  await render()
  expect(row().textContent).toContain("Connecting…")
  expect(row().getAttribute("aria-busy")).toBe("true")
  expect(row().querySelector('[data-testid="spinner"]')).not.toBeNull()
})

it("offers a way back after 30 seconds; Cancel closes the sheet and holds the row until the wallet answers", async () => {
  const held = atPrompt()
  await confirm()
  await act(async () => vi.advanceTimersByTime(29_999))
  expect(note()).toBeNull()
  await act(async () => vi.advanceTimersByTime(1))
  expect(el.querySelector("dialog")).not.toBeNull()
  expect(note()!.textContent).toContain("Still waiting for Rainbow.")
  await cancel()
  expect(el.querySelector("dialog")).toBeNull()
  expect(note()).toBeNull()
  expect(row().textContent).toContain("from Rainbow")
  expect(row().disabled).toBe(true)
  expect(reason()?.textContent).toBe(HOLDING)
  // A sheet opened later for the same target sees the same hold.
  await reopen()
  expect(row().disabled).toBe(true)
  expect(reason()?.textContent).toBe(HOLDING)
  await act(async () => row().click())
  expect(el.querySelector("dialog")).toBeNull()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  // The wallet's late rejection reports nothing and frees the row.
  await act(async () => held.reject(new Error("wallet closed")))
  expect(h.report).not.toHaveBeenCalled()
  expect(row().disabled).toBe(false)
  expect(reason()).toBeNull()
  await confirm()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
})

it("still tracks a transfer the wallet signs after Cancel", async () => {
  const held = atPrompt()
  let settle!: (receipt: unknown) => void
  h.receipt.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)))
  await confirm()
  await stall()
  await cancel()
  expect(reason()?.textContent).toBe(HOLDING)
  await act(async () => held.resolve(HASH))
  expect(h.receipt).toHaveBeenCalledWith(expect.objectContaining({ hash: HASH }))
  expect(row().textContent).toContain("Confirming payment")
  expect(reason()).toBeNull()
  await act(async () => settle({ status: "success" }))
  expect(el.textContent).toContain("Payment sent")
})

it("refuses a payment to another target while the wallet still holds the previous transfer", async () => {
  atPrompt()
  await confirm()
  await stall()
  await cancel()
  props = { ...props, address: `0x${"ab".repeat(20)}` }
  await render()
  expect(row().disabled).toBe(false)
  await confirm()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  expect(el.querySelector('[data-testid="registration-pay-confirm-reason"]')?.textContent).toBe(
    OPEN,
  )
})

it("pays a USDC fee token in USDC and names no DAI", async () => {
  h.tokens = "usdc"
  await render()
  await act(async () => row().click())
  const dialog = el.querySelector("dialog")!
  expect(dialog.querySelector('[data-testid="registration-pay-amount"]')?.textContent).toBe(
    "0.000011 USDC",
  )
  expect(dialog.textContent).not.toContain("DAI")
})

it("holds the payment and says so until the accepted tokens are read", async () => {
  h.tokens = "unread"
  await render()
  expect(row().disabled).toBe(true)
  expect(el.querySelector('[data-testid="deposit-tokens-loading"]')).not.toBeNull()
  expect(el.textContent).not.toContain("DAI")
  h.failed = true
  await render()
  expect(el.querySelector('[data-testid="deposit-tokens-failed"]')).not.toBeNull()
  await act(async () =>
    el.querySelector<HTMLButtonElement>('[data-testid="deposit-tokens-retry"]')!.click(),
  )
  expect(h.retry).toHaveBeenCalledOnce()
})

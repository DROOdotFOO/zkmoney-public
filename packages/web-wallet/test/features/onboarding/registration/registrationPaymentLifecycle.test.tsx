import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({
  writeContract: vi.fn(),
  receipt: vi.fn(),
  cleared: true,
  report: vi.fn(),
  modal: vi.fn(),
  account: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  balance: vi.fn(),
}))
const ACCOUNT = "0x00000000000000000000000000000000000000aa"
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({
  isWalletRejection: (e: { code?: number }) => e?.code === 4001,
  isWalletDisconnect: (e: { code?: number }) => e?.code === 6000,
  isWrongNetwork: (e: { name?: string }) => e?.name === "ChainMismatchError",
  useL1Wallet: () => ({
    account: h.account,
    walletName: "Rainbow",
    disconnect: h.disconnect,
    connect: h.connect,
  }),
  getL1Clients: async () => ({
    walletClient: { writeContract: h.writeContract },
    account: "0x00000000000000000000000000000000000000aa",
    chain: { id: 11155111 },
  }),
}))
vi.mock("../../../../src/features/deposit/l1DepositTokenBalance", () => ({
  readL1DepositTokenBalance: h.balance,
}))
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: h.cleared, verdict: null, rescreen: vi.fn() }),
  ScreeningNotice: () => null,
}))
vi.mock("../../../../src/errors/errorModal", () => ({
  showReportableError: h.report,
  showErrorModal: h.modal,
}))
vi.mock("../../../../src/ui/hooks", () => ({ useCopy: () => ({ copied: false, copy: vi.fn() }) }))
vi.mock("../../../../src/features/onboarding/registrationFunnel", () => ({
  reportRegistrationDepositShown: vi.fn(),
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => null,
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
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1ChainFor: () => ({ name: "Sepolia" }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ waitForTransactionReceipt: h.receipt }),
}))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../../support/depositTokens")
  const tokens = singleToken("0x00000000000000000000000000000000000000dd")
  return mockLoadDepositFacts(importOriginal, () => tokens)
})
import { DepositPayBlock } from "../../../../src/features/onboarding/steps/DepositAddress"
import { clearWalletPrompt } from "../../../../src/features/deposit/walletPrompt"
import { createPortalCapacityStore, type RequiredCredit } from "@obsidion/front-core"
import { CAPACITY_UNAVAILABLE } from "../../../../src/features/limits/limitsCopy"

const DAI = 10n ** 18n
const BUCKET = {
  chainId: 11155111,
  portal: "0x9999999999999999999999999999999999999999",
  token: "0x00000000000000000000000000000000000000dd",
} as const
/** The address's own bucket: what each read reports, and how many reads were made. */
const bucket = { availableAtomic: 1_000n * DAI, reads: 0 }
const REQUIRED: RequiredCredit = { status: "known", atomic: 1n, token: BUCKET.token, decimals: 18 }
function fundingStore() {
  return createPortalCapacityStore(BUCKET, {
    read: async () => {
      bucket.reads += 1
      return {
        ...BUCKET,
        decimals: 18,
        blockNumber: BigInt(bucket.reads),
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        rateAtomicPerSecond: DAI,
        globalLimitAtomic: 50_000n * DAI,
        availableAtomic: bucket.availableAtomic,
        txAmountCapAtomic: 10_000n * DAI,
      }
    },
    policy: { maxHeadAgeMs: Infinity },
    visibility: { isVisible: () => true, onResume: () => () => {} },
  })
}
let root: Root
let el: HTMLDivElement
let sequence = 0
const target: Parameters<typeof DepositPayBlock>[0] = {
  address: "0x00000000000000000000000000000000000000cc",
  token: "0x00000000000000000000000000000000000000dd",
  chainId: 11155111,
  total: 11n,
  funding: { required: REQUIRED, canFund: true },
}
beforeEach(() => {
  h.writeContract.mockReset().mockResolvedValue(`0x${"11".repeat(32)}`)
  h.receipt.mockReset().mockResolvedValue({ status: "success" })
  h.report.mockReset()
  h.modal.mockReset()
  h.account = ACCOUNT
  h.connect.mockReset()
  h.disconnect.mockReset()
  h.balance.mockReset().mockResolvedValue({ raw: 1_000n * DAI, display: "1000 DAI", symbol: "DAI" })
  target.address = `0x${(++sequence).toString(16).padStart(40, "0")}`
  bucket.availableAtomic = 1_000n * DAI
  bucket.reads = 0
  target.funding = { store: fundingStore(), required: REQUIRED, canFund: true }
  h.cleared = true
  el = document.createElement("div")
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => root.render(<DepositPayBlock {...target} />))
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
  // The wallet-request slot is page-wide; forget what a case left open.
  clearWalletPrompt()
})
/** The row opens the confirmation for a new payment; a recheck runs from the row itself. */
const pay = async () => {
  await act(async () => {
    el.querySelector<HTMLButtonElement>(".ww-deposit__connect")!.click()
  })
  const confirm = [...el.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (b) => b.textContent === "Confirm payment",
  )
  if (confirm) {
    await act(async () => {
      confirm.click()
    })
  }
}
const button = () => el.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
const reason = () => el.querySelector("[data-testid='registration-pay-reason']")?.textContent
const reopen = () => {
  act(() => root.render(null))
  act(() => root.render(<DepositPayBlock {...target} />))
}
const HOLDING = "Your wallet still holds this payment. Approve or reject it there."
/** Pays, waits out the stall window, and takes the note's Cancel while the wallet holds the transfer. */
const payThenCancel = async () => {
  const held = {} as { resolve: (hash: string) => void; reject: (e: unknown) => void }
  h.writeContract.mockImplementationOnce(
    () => new Promise((resolve, reject) => Object.assign(held, { resolve, reject })),
  )
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  await pay()
  await act(async () => vi.advanceTimersByTime(30_000))
  await act(async () => {
    el.querySelector<HTMLButtonElement>("[data-testid='wallet-prompt-stall'] button")!.click()
  })
  return held
}
it("holds the target after Cancel until the wallet rejects, then allows a new payment", async () => {
  const held = await payThenCancel()
  expect(button().disabled).toBe(true)
  expect(reason()).toBe(HOLDING)
  reopen()
  expect(button().disabled).toBe(true)
  expect(reason()).toBe(HOLDING)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  await act(async () => held.reject(Object.assign(new Error("Rejected"), { code: 4001 })))
  expect(h.report).not.toHaveBeenCalled()
  expect(button().disabled).toBe(false)
  expect(reason()).toBeUndefined()
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
  expect(el.textContent).toContain("Payment sent")
})
it("moves a held target to confirming when the wallet signs after Cancel", async () => {
  let confirm!: (receipt: unknown) => void
  h.receipt.mockImplementationOnce(() => new Promise((resolve) => (confirm = resolve)))
  const held = await payThenCancel()
  await act(async () => held.resolve(`0x${"11".repeat(32)}`))
  expect(el.textContent).toContain("Confirming payment")
  expect(button().disabled).toBe(true)
  expect(reason()).toBeUndefined()
  await act(async () => confirm({ status: "success" }))
  expect(el.textContent).toContain("Payment sent")
})
it("keeps the signing lock when the sheet is reopened", async () => {
  let broadcast!: (hash: string) => void
  h.writeContract.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        broadcast = resolve
      }),
  )
  await pay()
  reopen()
  expect(button().disabled).toBe(true)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  await act(async () => {
    broadcast(`0x${"11".repeat(32)}`)
  })
  expect(el.textContent).toContain("Payment sent")
})
it("keeps the broadcast lock until confirmation, including after reopening", async () => {
  let confirm!: (receipt: unknown) => void
  h.receipt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve
      }),
  )
  await pay()
  expect(el.textContent).toContain("Confirming payment")
  expect(el.textContent).not.toContain("Payment sent")
  reopen()
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  await act(async () => {
    confirm({ status: "success" })
  })
  expect(el.textContent).toContain("Payment sent")
})
it("allows retry after a reverted receipt", async () => {
  h.receipt.mockResolvedValueOnce({ status: "reverted" })
  await pay()
  expect(h.report).toHaveBeenCalledTimes(1)
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
  expect(el.textContent).toContain("Payment sent")
})
it.each(["replaced"])("allows retry after a %s transaction", async (reason) => {
  h.receipt.mockImplementationOnce(async ({ onReplaced }) => {
    onReplaced({ reason, transaction: { hash: `0x${"22".repeat(32)}` } })
    return { status: "success" }
  })
  await pay()
  expect(h.report).toHaveBeenCalledTimes(1)
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
})
it("accepts a successful repriced transaction", async () => {
  h.receipt.mockImplementationOnce(async ({ onReplaced }) => {
    onReplaced({ reason: "repriced", transaction: { hash: `0x${"22".repeat(32)}` } })
    return { status: "success" }
  })
  await pay()
  expect(h.report).not.toHaveBeenCalled()
  expect(el.textContent).toContain("Payment sent")
})
it("rechecks the same hash after an RPC failure instead of resending", async () => {
  h.receipt.mockRejectedValueOnce(new Error("RPC timeout"))
  await pay()
  reopen()
  expect(el.textContent).toContain("Check payment status")
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  expect(h.balance).toHaveBeenCalledTimes(1)
  expect(h.receipt.mock.calls[1][0].hash).toBe(h.receipt.mock.calls[0][0].hash)
  expect(el.textContent).toContain("Payment sent")
})
it("asks to connect again when the wallet disconnects during the payment, and reports nothing", async () => {
  h.writeContract.mockImplementationOnce(async () => {
    h.account = null
    throw Object.assign(new Error("User disconnected."), { code: 6000 })
  })
  await pay()
  expect(h.report).not.toHaveBeenCalled()
  expect(h.modal).toHaveBeenCalledWith({
    title: "Wallet disconnected",
    message: "Your wallet disconnected during the payment. Connect it again to pay.",
  })
  expect(h.disconnect).not.toHaveBeenCalled()
  expect(el.textContent).toContain("Connect your wallet")
  await pay()
  expect(h.connect).toHaveBeenCalledTimes(1)
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  h.account = ACCOUNT
  act(() => root.render(<DepositPayBlock {...target} />))
  await pay()
  expect(el.textContent).toContain("Payment sent")
})
it("says to switch networks when the wallet is on another chain, and reports nothing", async () => {
  h.writeContract.mockRejectedValueOnce(
    Object.assign(new Error("chain mismatch"), { name: "ChainMismatchError" }),
  )
  await pay()
  expect(h.report).not.toHaveBeenCalled()
  expect(el.querySelector("[data-testid='registration-pay-reason']")?.textContent).toBe(
    "Your wallet is on another network. Switch it to Sepolia and try again.",
  )
  expect(button().disabled).toBe(false)
  await pay()
  expect(el.textContent).toContain("Payment sent")
})
it("blocks payment until the sending account is cleared", async () => {
  h.cleared = false
  act(() => root.render(<DepositPayBlock {...target} />))
  await pay()
  expect(h.writeContract).not.toHaveBeenCalled()
})
it("still rechecks a payment already sent once the ask reads as over a limit", async () => {
  h.receipt.mockRejectedValueOnce(new Error("RPC timeout"))
  await pay()
  act(() => root.render(<DepositPayBlock {...target} overLimit="public" />))
  expect(el.textContent).toContain("Check payment status")
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  expect(el.textContent).toContain("Payment sent")
})
it("sends nothing when that last read no longer fits, and says why", async () => {
  bucket.availableAtomic = 0n
  await pay()
  expect(h.writeContract).not.toHaveBeenCalled()
  expect(h.report).not.toHaveBeenCalled()
  expect(el.querySelector("[data-testid='registration-pay-reason']")?.textContent).toBe(
    "Network capacity changed. Review your deposit.",
  )
  expect(button().disabled).toBe(false)
})
it("rechecks a sent payment without a capacity read, even once capacity is unconfirmed", async () => {
  h.receipt.mockRejectedValueOnce(new Error("RPC timeout"))
  await pay()
  const reads = bucket.reads
  target.funding = { required: REQUIRED, canFund: false, reason: CAPACITY_UNAVAILABLE }
  act(() => root.render(<DepositPayBlock {...target} />))
  expect(button().disabled).toBe(false)
  await pay()
  expect(bucket.reads).toBe(reads)
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  expect(el.textContent).toContain("Payment sent")
})
it("sends nothing to a wallet short of the amount, says what it holds, and reports nothing", async () => {
  h.balance.mockResolvedValueOnce({
    raw: 10n,
    display: "0.00000000000000001 DAI",
    symbol: "DAI",
    decimals: 18,
  })
  await pay()
  expect(h.balance).toHaveBeenCalledWith(ACCOUNT, target.token)
  expect(h.writeContract).not.toHaveBeenCalled()
  expect(h.report).not.toHaveBeenCalled()
  expect(el.querySelector("[data-testid='registration-pay-reason']")?.textContent).toBe(
    "This wallet holds 0.00000000000000001 DAI, and this payment needs 0.000000000000000011 DAI. Add DAI to it, or send from another wallet to the address above.",
  )
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
})
it("reports a failed balance read, sends nothing, and allows retry", async () => {
  h.balance.mockRejectedValueOnce(new Error("RPC down"))
  await pay()
  expect(h.writeContract).not.toHaveBeenCalled()
  expect(h.report).toHaveBeenCalledTimes(1)
  expect(button().disabled).toBe(false)
})

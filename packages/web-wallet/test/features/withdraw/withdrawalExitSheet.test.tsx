/**
 * The withdrawal exit sheet's confirm copy. The three claims it makes are the ones a user acts on,
 * and each is a property of the portal route rather than of the wording: the submitter pays gas,
 * the burn's relayer tip settles to the submitting wallet, and a relayer that wins the race makes
 * the portal revert this transaction without moving anything.
 */
import React, { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Hex } from "viem"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { clearWalletPrompt, useWalletPrompt } from "../../../src/features/deposit/walletPrompt"
import { openTestSession } from "../../support/session"

const h = vi.hoisted(() => ({ selfFinalize: vi.fn(), showReportableError: vi.fn() }))
const CONNECTED = `0x${"cc".repeat(20)}`
const l1 = vi.hoisted(() => ({
  account: null as string | null,
  walletName: "MetaMask",
  connecting: false,
  wrongChain: false,
  connect: vi.fn(),
  switchNetwork: vi.fn(),
}))

vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, l1Chain: { name: "Sepolia" } }),
}))
vi.mock("../../../src/features/withdraw/selfFinalize", () => ({ selfFinalize: h.selfFinalize }))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  isWalletRejection: (e: { code?: number }) => e?.code === 4001,
  useL1Wallet: () => l1,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      <span>{value}</span>
    </div>
  ),
  DoubleCheckIcon: () => null,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { WithdrawalExitModal } = await import("../../../src/features/withdraw/WithdrawalExitModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const L1_TX = `0x${"ab".repeat(32)}` as Hex

const record = {
  localId: "wdraw_1",
  recipient: `0x${"dd".repeat(20)}`,
  recipientProvenance: "saved-recipient",
  amount: "210",
  tokenSymbol: "DAI",
  phase: "finalizing_l1",
  startTime: Date.now() - 60_000,
  l2TxHash: `0x${"0a".repeat(32)}`,
} as WithdrawalRecord

/** The page-wide wallet slot, read as the sheets read it. */
function SlotProbe() {
  return <span data-testid="wallet-slot" data-open={String(useWalletPrompt().open)} />
}

beforeEach(() => {
  openTestSession({
    wallet: { node: {} },
    account: { getAddress: () => ({}) },
    teeSigner: {},
  })
})

describe("WithdrawalExitModal", () => {
  let container: HTMLDivElement
  let root: Root

  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)
  const walletRow = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.className.includes("ww-deposit__connect"),
    )!

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    h.selfFinalize.mockResolvedValue(L1_TX)
    l1.account = CONNECTED
    l1.wrongChain = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <>
          <WithdrawalExitModal record={record} onClose={vi.fn()} />
          <SlotProbe />
        </>,
      )
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it("asks for a wallet before it can finalize", async () => {
    l1.account = null
    await act(async () => root.render(<WithdrawalExitModal record={record} onClose={vi.fn()} />))
    expect(container.textContent).toContain("Connect your wallet")
    expect(button("Finalize this withdrawal")!.disabled).toBe(true)
  })

  it("offers a network switch on the wrong chain, and finalizes only once it lands", async () => {
    l1.wrongChain = true
    await act(async () => root.render(<WithdrawalExitModal record={record} onClose={vi.fn()} />))
    expect(walletRow().textContent).toContain("Switch to Sepolia")
    expect(button("Finalize this withdrawal")!.disabled).toBe(true)
    await act(async () => walletRow().click())
    expect(l1.switchNetwork).toHaveBeenCalledOnce()
    l1.wrongChain = false
    await act(async () => root.render(<WithdrawalExitModal record={record} onClose={vi.fn()} />))
    expect(button("Finalize this withdrawal")!.disabled).toBe(false)
  })

  describe("waiting on the wallet", () => {
    const note = () => container.querySelector<HTMLElement>('[data-testid="wallet-prompt-stall"]')
    const finalize = () => act(async () => button("Finalize this withdrawal")!.click())
    const cancel = () => act(async () => note()!.querySelector("button")!.click())
    const slotOpen = () =>
      container.querySelector<HTMLElement>('[data-testid="wallet-slot"]')!.dataset.open
    /** A release the wallet holds at its prompt until the test answers for it. */
    const atPrompt = () => {
      const held = {} as {
        resolve: (hash: Hex) => void
        reject: (e: unknown) => void
        stage: (stage: string) => void
      }
      h.selfFinalize.mockImplementationOnce(
        (_record: unknown, _wallet: unknown, opts: { onStage: (stage: string) => void }) => {
          held.stage = opts.onStage
          opts.onStage("signing")
          return new Promise<Hex>((resolve, reject) => Object.assign(held, { resolve, reject }))
        },
      )
      return held
    }

    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
    afterEach(() => {
      vi.useRealTimers()
      clearWalletPrompt()
    })

    it("offers a way back after 30 seconds, and a late rejection reports nothing", async () => {
      const held = atPrompt()
      await finalize()
      expect(container.textContent).toContain("Approve the transaction in your wallet")
      await act(async () => vi.advanceTimersByTime(29_999))
      expect(note()).toBeNull()
      await act(async () => vi.advanceTimersByTime(1))
      expect(note()!.textContent).toContain("Still waiting for MetaMask.")
      await cancel()
      expect(note()).toBeNull()
      expect(button("Finalize this withdrawal")!.disabled).toBe(false)
      await act(async () => held.reject(new Error("wallet closed")))
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(button("Finalize this withdrawal")!.disabled).toBe(false)
    })

    it("refuses a second release while the wallet holds the first, then lands its late hash", async () => {
      const held = atPrompt()
      await finalize()
      await act(async () => vi.advanceTimersByTime(30_000))
      await cancel()
      await finalize()
      expect(h.selfFinalize).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[data-testid="withdrawal-exit-refused"]')?.textContent).toBe(
        "Your wallet still has the previous request open. Approve or reject it there first.",
      )
      await act(async () => held.resolve(L1_TX))
      expect(container.textContent).toContain("Withdrawal released")
    })

    it("frees the slot once the transaction is confirming, before the receipt lands", async () => {
      const held = atPrompt()
      await finalize()
      expect(slotOpen()).toBe("true")
      await act(async () => held.stage("confirming"))
      expect(slotOpen()).toBe("false")
      expect(button("Finalize this withdrawal")).toBeUndefined()
    })
  })

  // A swap burn paid a counterfactual escrow, so this transaction releases DAI there and the
  // recipient is paid in their chosen asset only after a relayer runs the swap. The direct copy
  // claimed the funds reached the named recipient, which is false in both amount and asset — and
  // most misleading exactly here, where the user is self-finalizing because no relayer ran.
  describe("a swap withdrawal", () => {
    const swapRecord = {
      ...record,
      swapOutput: "USDC",
      swapEscrow: `0x${"ee".repeat(20)}`,
    } as WithdrawalRecord

    beforeEach(async () => {
      await act(async () => {
        root.render(<WithdrawalExitModal record={swapRecord} onClose={vi.fn()} />)
      })
    })

    it("does not claim the recipient received the funds on success", async () => {
      await act(async () => button("Finalize this withdrawal")!.click())
      const text = container.textContent!
      expect(text).toContain("released to the swap escrow")
      expect(text).toMatch(/paid in USDC once a relayer runs the swap/)
      expect(text).not.toMatch(/210 DAI released to 0x/)
    })
  })

  it("finalizes a Savings move out's burn on the Savings deployment, with its co-signer", async () => {
    const tuple = { portal: `0x${"71".repeat(20)}` }
    const signer = { id: "sky" }
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WithdrawalExitModal
          record={record}
          deployment={async () => ({ tuple, signer } as never)}
          onClose={vi.fn()}
        />,
      )
    })
    await act(async () => button("Finalize this withdrawal")!.click())
    expect(h.selfFinalize).toHaveBeenCalledWith(
      record,
      expect.objectContaining({ node: {}, signer }),
      expect.objectContaining({ tuple }),
    )
  })
})

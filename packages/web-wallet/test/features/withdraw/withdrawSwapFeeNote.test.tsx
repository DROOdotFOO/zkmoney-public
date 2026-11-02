/**
 * What the amount step says about the relayer tip: a warning where the tip would eat more than a
 * fifth of the amount, and a closed route — no committable tip, no CTA — where the simulation fails.
 * There is deliberately no fallback figure: a tip nobody simulated is a tip the relayer may never act
 * on.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { balancesOf } from "../../support/balances"
import { parseUnits } from "viem"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  SWAP_QUOTE_REFRESH_MS,
  SWAP_UNAVAILABLE_COPY,
} from "../../../src/features/withdraw/withdrawQuote"
import type { FakeSwapControl } from "../../fixtures/fakeSwapSimulator"
import { openTestSession } from "../../support/session"

const control = vi.hoisted<FakeSwapControl>(() => ({ relayerTip: 3n * 10n ** 18n, calls: [] }))
const submit = vi.hoisted(() => vi.fn())

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@obsidion/sdk")>()
  const { fakeSwapSimulator } = await import("../../fixtures/fakeSwapSimulator")
  return { ...sdk, SwapOnWithdrawSimulator: fakeSwapSimulator(sdk, control) }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
}))
vi.mock("../../../src/features/withdraw/withdrawGateway", () => ({
  submitSponsoredWithdrawal: submit,
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox" }),
  l1Transport: () => ({}),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({
    portal: `0x${"70".repeat(20)}`,
    token: `0x${"da".repeat(20)}`,
    swapEscrowFactoryV2: `0x${"fa".repeat(20)}`,
    operationExecutor: `0x${"e0".repeat(20)}`,
  }),
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 5166n * 10n ** 18n,
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: () => undefined,
  SponsoredActionNotice: () => null,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientSpinner: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  TopNavIconButton: () => null,
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
}))

const { WithdrawToWalletModal } = await import(
  "../../../src/features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal"
)

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const RECIPIENT = `0x${"dd".repeat(20)}` as const
const HIGH_TIP_WARNING = /over 20% of this amount/

beforeEach(() => {
  openTestSession({
    wallet: {},
    account: {},
    token: { metadata: { decimals: 18 } },
    balances: balancesOf({ main: 500n * 10n ** 18n, live: true, known: true }),
  })
})

describe("WithdrawToWalletModal — swap fee note", () => {
  let container: HTMLDivElement
  let root: Root

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title) as
      | HTMLButtonElement
      | undefined

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
  }

  const type = async (value: string) => {
    await act(async () => {
      const el = input()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await settle()
  }

  const row = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((f) => f.querySelector("span")?.textContent === label)
      ?.querySelector("b")?.textContent

  const mount = async (
    props: { receiveAsset?: "USDC" | "ETH"; recipientIsContract?: boolean } = {},
  ) => {
    await act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawToWalletModal
            recipient={RECIPIENT}
            receiveAsset="USDC"
            {...props}
            onClose={vi.fn()}
            onDone={vi.fn()}
          />
        </ScreeningProvider>,
      )
    })
    await settle()
  }

  beforeEach(() => {
    control.relayerTip = 3n * 10n ** 18n
    control.failure = undefined
    control.calls.length = 0
    submit.mockReset()
    submit.mockImplementation(() => new Promise(() => {}))
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("warns when the relayer tip is over a fifth of the amount, and stops once it is not", async () => {
    await mount()
    // 3 DAI tip on a 12 DAI burn: 25%.
    await type("12")
    expect(container.textContent).toMatch(HIGH_TIP_WARNING)
    expect(button("Review")?.disabled).toBe(false)

    await type("50")
    expect(container.textContent).not.toMatch(HIGH_TIP_WARNING)
  })

  it("closes the route when the simulation fails: no fee, no tip to commit, no CTA", async () => {
    control.failure = new Error("eth_estimateGas: execution reverted")
    await mount()
    await type("50")
    expect(container.textContent).toContain(SWAP_UNAVAILABLE_COPY)
    expect(container.textContent).toContain("Estimate unavailable")
    expect(row("Withdrawal fee")).toBe("$--")
    expect(button("Review")?.disabled).toBe(true)
  })

  it("commits the simulated tip and estimate the confirm step showed", async () => {
    await mount()
    await type("50")
    // The floor is learned from the first pass; the second prices the burn that carries it.
    await settle()
    expect(container.textContent).toContain("Includes $3 for L1 gas at 1 gwei.")
    await act(async () => button("Review")!.click())
    // The typed 50 reaches the escrow whole, and the fake pays 99% of it.
    expect(row("Send")).toBe("$50 ≈ 49.5 USDC")
    expect(row("Token")).toBe("USDC")
    expect(row("Sending total")).toBe("$53.10")
    await act(async () => button("Confirm withdrawal")!.click())

    expect(submit).toHaveBeenCalledTimes(1)
    const [, recipient, charged, , , receiveAsset, swapCommit] = submit.mock.calls[0]!
    expect(recipient).toBe(RECIPIENT)
    // The burn is what was typed plus the 3.10 floor on top.
    expect(charged).toBe("53.1")
    expect(receiveAsset).toBe("USDC")
    // The fake pays (burn - withdrawal tip - swap tip) * 0.99 in 6-dp USDC.
    const swapInput = parseUnits("53.1", 18) - WITHDRAW_RELAYER_TIP - 3n * 10n ** 18n
    expect(swapCommit).toEqual({
      relayerTip: 3n * 10n ** 18n,
      amountOut: (swapInput * 99n) / 100n / 10n ** 12n,
      decimals: 6,
    })
  })

  it("confirms on a swap tip that moves by an atomic unit between quotes: the burn does not chase it", async () => {
    vi.useFakeTimers()
    try {
      const tick = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      await act(async () => {
        root.render(
          <ScreeningProvider screener={passThroughScreener}>
            <WithdrawToWalletModal
              recipient={RECIPIENT}
              receiveAsset="USDC"
              onClose={vi.fn()}
              onDone={vi.fn()}
            />
          </ScreeningProvider>,
        )
      })
      await tick(400)
      await act(async () => {
        const el = input()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "50")
        el.dispatchEvent(new Event("input", { bubbles: true }))
      })
      // The first quote learns the floor, the second prices the burn that carries it.
      await tick(400)
      await tick(400)
      const priced = control.calls.length
      await act(async () => button("Review")!.click())
      expect(button("Confirm withdrawal")!.disabled).toBe(false)

      // Every refresh answers a tip one atomic unit away from the last.
      for (let i = 0; i < 4; i++) {
        control.relayerTip = 3n * 10n ** 18n + (i % 2 === 0 ? 1n : 0n)
        await tick(SWAP_QUOTE_REFRESH_MS)
        expect(button("Confirm withdrawal")!.disabled).toBe(false)
      }
      const burns = new Set(control.calls.slice(priced).map((c) => c.amount.toString()))
      expect(burns.size).toBe(1)
      expect(row("Sending total")).toBe("$53.10")
    } finally {
      vi.useRealTimers()
    }
  })

  it("burns to the asset picked in the amount box", async () => {
    await mount()
    const press = (selector: string) =>
      act(async () => container.querySelector<HTMLElement>(selector)!.click())
    await press('button[aria-label="Receive as"]')
    await press('[role="option"]:last-child')
    await type("50")
    await settle()
    await act(async () => button("Review")!.click())
    await act(async () => button("Confirm withdrawal")!.click())
    expect(submit.mock.calls[0]![5]).toBe("ETH")
  })

  it.each([
    { receiveAsset: "ETH" as const, recipientIsContract: true, warnings: 1 },
    { receiveAsset: "USDC" as const, recipientIsContract: true, warnings: 0 },
    { receiveAsset: "ETH" as const, recipientIsContract: false, warnings: 0 },
  ])("warns of a contract recipient on the ETH route only: %o", async ({ warnings, ...props }) => {
    await mount(props)
    await type("50")
    expect(container.querySelectorAll(".ww-withdraw__warning")).toHaveLength(warnings)
    expect(button("Review")?.disabled).toBe(false)
  })
})

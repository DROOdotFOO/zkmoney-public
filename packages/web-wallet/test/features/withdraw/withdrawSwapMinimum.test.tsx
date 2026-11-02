/**
 * A swap route has to leave the escrow something to swap after the executor's fee, the withdrawal
 * relayer tip and the escrow's relayer tip. That floor rides on top of the typed amount, so the escrow
 * always has the typed amount to swap. The relayer tip comes from a live simulation, so the floor
 * is whatever the simulator answers — here a fake with the sdk's contract — and the burn derives
 * from it.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { balancesOf } from "../../support/balances"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { FakeSwapControl } from "../../fixtures/fakeSwapSimulator"
import { openTestSession } from "../../support/session"

const RELAYER_TIP = 3n * 10n ** 18n
/** The source executor's withdrawal fee. */
const FEE = 10n ** 17n
const FLOOR = FEE + WITHDRAW_RELAYER_TIP + RELAYER_TIP

const control = vi.hoisted<FakeSwapControl>(() => ({ relayerTip: 3n * 10n ** 18n, calls: [] }))

vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => FEE,
  activeWithdrawalFee: async () => FEE,
  activeWithdrawalExecutor: async () => ({ fee: FEE }),
  withdrawalExecutor: async () => ({ fee: FEE }),
  withdrawalExecutorAt: async () => ({ fee: FEE }),
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

beforeEach(() => {
  openTestSession({
    wallet: {},
    account: {},
    token: { metadata: { decimals: 18 } },
    balances: balancesOf({ main: 500n * 10n ** 18n, live: true, known: true }),
  })
})

describe("WithdrawToWalletModal — swap floor", () => {
  let container: HTMLDivElement
  let root: Root

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title) as
      | HTMLButtonElement
      | undefined

  // The screening verdict and the simulated floor both settle asynchronously, the latter behind
  // the quote debounce.
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

  beforeEach(async () => {
    control.relayerTip = RELAYER_TIP
    control.failure = undefined
    control.calls.length = 0
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
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
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("accepts the $1 minimum: the floor rides on top, so the escrow has the typed amount to swap", async () => {
    await type("1")
    expect(button("Review")?.disabled).toBe(false)
  })

  it("simulates the typed amount plus the floor, for the typed recipient", async () => {
    await type("1")
    // The floor is learned from the first pass over the typed amount alone; the second prices
    // the burn that carries it.
    await settle()
    const last = control.calls.at(-1)!
    expect(last.recipient).toBe(RECIPIENT)
    expect(last.amount).toBe(10n ** 18n + FLOOR)
    expect(last.deductions).toEqual({
      withdrawalFee: FEE,
      withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
      proverTip: 0n,
    })
  })
})

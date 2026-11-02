/**
 * The withdraw modal's money path: the typed amount is what the recipient receives and the whole
 * fee (the relayer tip) is burned on top of it, MAX is the balance less the
 * fee in exact token units, and only amounts the decimal-safe parse accepts can reach the gateway.
 * Plus the hand-off: the modal holds the user through the prepare and sign beats, then closes and
 * lets the burn finish without it.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveBalances } from "../../support/balances"
import { parseUnits } from "viem"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { fireEvent } from "../../../src/lib/analytics"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "../../support/handOff"
import { LIMIT, LIMIT_USD, grouped, typed } from "../../support/publicLimit"
import { openTestSession } from "../../support/session"

const submit = vi.hoisted(() => vi.fn())
// The direct route's fee: the withdrawal relayer tip.
const FEE = "0.10"
const balance = { walletAsset: null as { balanceAtomic: bigint } | null }

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
  upsertSavedL1WalletContact: vi.fn(),
}))
vi.mock("../../../src/features/withdraw/withdrawGateway", () => ({
  submitSponsoredWithdrawal: submit,
}))
// Config resolves only after boot; the sandbox network is what the quote path below expects.
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
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
const allowanceGate = vi.hoisted(() => ({ reason: undefined as string | undefined }))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: (enabled: boolean) => (enabled ? allowanceGate.reason : undefined),
  SponsoredActionNotice: ({ reason }: { reason?: string }) =>
    reason ? <p data-testid="sponsored-action-blocked">{reason}</p> : null,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientSpinner: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  TopNavIconButton: () => null,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

// The faster option the confirm step offers; undefined offers Standard alone.
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
vi.mock("../../../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: ({ active }: { active: boolean }) =>
    active ? { offer: faster.offer, loading: faster.loading } : { loading: false },
}))

const { WithdrawToWalletModal } = await import(
  "../../../src/features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal"
)

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  openTestSession({
    wallet: {},
    account: {},
    token: { metadata: { decimals: 18 } },
    balances: liveBalances(() => ({
      main: balance.walletAsset?.balanceAtomic,
      live: true,
      known: true,
    })),
  })
})

describe("WithdrawToWalletModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onDone = vi.fn()

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)!
  const type = (value: string) => act(async () => typeInto(input(), value))
  const click = (text: string) => act(async () => button(text).click())
  const row = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((f) => f.querySelector("span")?.textContent === label)
      ?.querySelector("b")?.textContent
  /** The confirm CTA whatever case its label carries: reaching it is setup here, and the copy
   *  itself is asserted by the tests that are about the copy. */
  const clickConfirm = () =>
    act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => /^confirm withdrawal$/i.test(b.textContent ?? ""))!
        .click(),
    )
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(fireEvent).mockClear()
    submit.mockReset()
    submit.mockImplementation(() => new Promise(() => {}))
    onClose.mockReset()
    onDone.mockReset()
    balance.walletAsset = { balanceAtomic: parseUnits("4.11", 18) }
    faster.offer = undefined
    faster.loading = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawToWalletModal
            recipient={RECIPIENT}
            walletName="Rainbow"
            receiveAsset="DAI"
            onClose={onClose}
            onDone={onDone}
          />
        </ScreeningProvider>,
      )
    })
    // The modal screens the recipient before its CTA can enable.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
  })

  afterEach(async () => {
    allowanceGate.reason = undefined
    await act(async () => root.unmount())
    container.remove()
  })

  it("holds the withdrawal, with the reason beside it, when the allowance proves it cannot be paid for", async () => {
    allowanceGate.reason = "No sponsored transactions left. This allowance does not renew."
    await type("2")
    expect(container.querySelector('[data-testid="sponsored-action-blocked"]')).toBeNull()
    await click("Review")
    expect(button("Confirm withdrawal").disabled).toBe(true)
    expect(container.querySelector('[data-testid="sponsored-action-blocked"]')?.textContent).toBe(
      allowanceGate.reason,
    )
    await click("Confirm withdrawal")
    expect(submit).not.toHaveBeenCalled()
  })

  describe("speed", () => {
    const TIP = parseUnits("0.5", 18)
    const offer = {
      proverTip: TIP,
      standardEtaSeconds: 44 * 60,
      tippedEtaSeconds: 12 * 60,
      worstSpeedupSeconds: 30 * 60,
      measured: true,
    }
    const speed = () => container.querySelector('[aria-haspopup="listbox"]')?.textContent
    const settle = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })
    const chooseFaster = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click()
      })
      const option = Array.from(container.querySelectorAll('[role="option"]')).find((o) =>
        o.textContent?.startsWith("Faster"),
      ) as HTMLButtonElement
      await act(async () => option.click())
      await settle()
    }
    const toConfirm = async (amount: string) => {
      await type(amount)
      await click("Review")
      await settle()
    }

    it("charges the tip in the fee and burns it when Faster is chosen", async () => {
      faster.offer = offer
      await toConfirm("2")
      await chooseFaster()
      expect(speed()).toBe("Faster")
      expect(row("Withdrawal fee")).toBe("$0.60")
      expect(row("Send")).toBe("$2")
      expect(row("Sending total")).toBe("$2.60")
      await clickConfirm()
      expect(submit.mock.calls[0]![7]).toBe(TIP)
    })

    it("falls back to Standard when the faster option goes away", async () => {
      faster.offer = offer
      await toConfirm("2")
      await chooseFaster()
      expect(row("Withdrawal fee")).toBe("$0.60")
      faster.offer = undefined
      // The tree the sheet was opened with, so it re-renders in place instead of remounting.
      await act(async () => {
        root.render(
          <ScreeningProvider screener={passThroughScreener}>
            <WithdrawToWalletModal
              recipient={RECIPIENT}
              walletName="Rainbow"
              receiveAsset="DAI"
              onClose={onClose}
              onDone={onDone}
            />
          </ScreeningProvider>,
        )
      })
      await settle()
      expect(speed()).toBeUndefined()
      expect(row("Withdrawal fee")).toBe(`$${FEE}`)
      await clickConfirm()
      expect(submit.mock.calls[0]![7]).toBe(0n)
    })

    const openSpeeds = async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click()
      })
      return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    }

    it("keeps a MAX amount and greys Faster out: no tip fits on top of MAX", async () => {
      faster.offer = offer
      await click("MAX")
      expect(input().value).toBe("4.01")
      await click("Review")
      await settle()
      expect(speed()).toBe("Standard")
      const [, fasterOption] = await openSpeeds()
      expect(fasterOption!.disabled).toBe(true)
      expect(fasterOption!.textContent).toBe("FasterYour balance can't cover the tip")
      expect(row("Send")).toBe("$4.01")
      expect(row("Sending total")).toBe("$4.11")
    })
  })

  it("keeps the $1 minimum on the amount sent, with the fee on top", async () => {
    await type("1")
    expect(input().placeholder).toBe("Minimum $1")
    expect(row("Withdrawal fee")).toBe(`$${FEE}`)
    expect(button("Review").disabled).toBe(false)
    await click("Review")
    expect(row("Send")).toBe("$1")
    expect(row("Sending total")).toBe("$1.10")
  })

  it("says when the fee leaves less than the minimum of the balance", async () => {
    balance.walletAsset = { balanceAtomic: parseUnits("1.05", 18) }
    await click("MAX")
    expect(container.textContent).toContain(
      "Your balance can't cover the withdrawal fee ($0.10) plus the $1 minimum.",
    )
    expect(button("Review").disabled).toBe(true)
  })

  it(`refuses a burn one cent over ${LIMIT_USD} and offers the maximum, without changing the amount itself`, async () => {
    balance.walletAsset = { balanceAtomic: parseUnits(String(2 * LIMIT), 18) }
    // The fee is burned on top, so the typed amount can reach the limit less the fee.
    await type(typed(LIMIT - 0.1))
    expect(button("Review").disabled).toBe(false)
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()

    await type(typed(LIMIT - 0.09))
    expect(button("Review").disabled).toBe(true)
    const notice = container.querySelector('[data-testid="limit-notice"]')!.textContent
    expect(notice).toContain(`Over the ${LIMIT_USD} limit`)
    // Said once: the field keeps its figure instead of repeating the reason.
    expect(container.querySelector(".ww-fund__amount small")!.textContent).not.toMatch(
      /limit|maximum/i,
    )
    expect(input().value).toBe(typed(LIMIT - 0.09))

    await click(`Use maximum ($${grouped(LIMIT - 0.1, true)})`)
    expect(input().value).toBe(typed(LIMIT - 0.1))
    expect(button("Review").disabled).toBe(false)
  })

  it("names the balance, not the limit, when an amount is over both", async () => {
    balance.walletAsset = { balanceAtomic: parseUnits("2400", 18) }
    await type("2600")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain("Balance not enough")
    expect(container.querySelector('[data-testid="limit-notice"]')).toBeNull()
    await click("MAX")
    expect(input().value).toBe("2399.9")
    expect(container.textContent).not.toContain("Balance not enough")
  })

  it("blocks a burn above the balance by one atomic unit", async () => {
    balance.walletAsset = { balanceAtomic: parseUnits("4.11", 18) - 1n }
    // 4.01 plus the 0.10 fee is the 4.11 the balance is one unit short of.
    await type("4.01")
    expect(button("Review").disabled).toBe(true)
  })

  it("hands off to the bell after the passkey and resets the form only then", async () => {
    onDone.mockImplementation(() => root.render(null))
    let settle: (record: unknown) => void = () => {}
    submit.mockImplementation(
      asOperation(() => new Promise((resolve) => (settle = resolve)), "withdraw"),
    )
    await type("2")
    await click("Review")
    await click("Confirm withdrawal")

    // The prepare beat holds the user until the ceremony starts, then names what it is waiting on.
    expect(container.textContent).toContain("Preparing transaction…")
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey…")
    expect(onDone).not.toHaveBeenCalled()

    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()
    expect(container.textContent).toBe("")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())

    // The burn landing later must not reset a form the user has moved on to.
    await act(async () => settle({ localId: "w1" }))
    expect(onDone).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("refuses amounts the decimal-safe parse rejects even when parseFloat accepts them", async () => {
    await type("10,5")
    expect(button("Review").disabled).toBe(true)
    await type("1e2")
    expect(button("Review").disabled).toBe(true)
  })

  it("does not report cancellation when completion closes the modal without signing", async () => {
    let settle!: (record: unknown) => void
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    onDone.mockImplementation(() => root.render(null))
    await type("2")
    await click("Review")
    await click("Confirm withdrawal")
    await act(async () => settle({ localId: "w1" }))
    expect(container.textContent).toBe("")
    expect(fireEvent).toHaveBeenCalledWith("withdraw_submitted", expect.anything())
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
  it("reports an accepted pre-prove cancellation exactly once", async () => {
    let continueWithdrawal!: () => void
    submit.mockImplementation(async (_deps, _recipient, _amount, onStage) => {
      await new Promise<void>((resolve) => {
        continueWithdrawal = resolve
      })
      onStage("proving")
      return { localId: "w1" }
    })
    await type("2")
    await click("Review")
    await click("Confirm withdrawal")
    await click("Cancel")
    await act(async () => continueWithdrawal())
    expect(button("Confirm withdrawal")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(
      vi.mocked(fireEvent).mock.calls.filter(([name]) => name === "proving_cancelled"),
    ).toEqual([["proving_cancelled", { flow: "withdraw", stage: "building" }]])
  })

  it("never cancels once the burn has mined, so the record survives", async () => {
    // `submitting` lands after `exitToL1PrivateSponsored` has mined. A cancel thrown there makes
    // the gateway drop the record for a withdrawal that is already irreversible on chain.
    let advance!: (stage: string) => void
    let settle!: (record: unknown) => void
    submit.mockImplementation((_deps, _recipient, _amount, onStage) => {
      advance = onStage
      return new Promise((resolve) => {
        settle = resolve
      })
    })
    await type("2")
    await click("Review")
    await clickConfirm()

    // Cancelled while the button still offers it, but the burn got away before any stage landed.
    await act(async () => button("Cancel").click())
    await act(async () => advance("submitting"))
    await act(async () => settle({ localId: "w1" }))

    expect(onDone).toHaveBeenCalledOnce()
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
    expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })

  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: (stage: string) => void
    let rejectWithdrawal!: (error: Error) => void
    submit.mockImplementation((_deps, _recipient, _amount, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectWithdrawal = reject
      })
    })
    await type("2")
    await click("Review")
    await click("Confirm withdrawal")
    const cancel = button("Cancel")
    expect(cancel.disabled).toBe(false)
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectWithdrawal(new Error("Withdrawal failed"))
    })
    expect(fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "withdraw:submit",
      code: "x",
    })
    await act(async () => root.render(null))
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
})

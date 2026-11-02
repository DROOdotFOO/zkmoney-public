/**
 * What the registration sheet asks for, and when it stops asking: the quoted deposit while the
 * address is short, the schedule's fee and balance rows beneath it once each figure is read, and a
 * row left out where no read will bring one.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrationKind } from "@obsidion/core/types"
import { MAINNET_DAI, mainnetTokens, singleToken } from "../../../support/depositTokens"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}:{value}
    </div>
  ),
}))
vi.mock("../../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../../src/features/onboarding/steps/DepositAddress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/onboarding/steps/DepositAddress")>()),
  DepositAddressRow: ({ overLimit }: { overLimit?: string }) => (
    <div data-testid="address-row" data-over-limit={overLimit ?? ""} />
  ),
  DepositPayBlock: ({
    total,
    note,
    overLimit,
  }: {
    total: bigint
    note?: React.ReactNode
    overLimit?: string
  }) => (
    <div data-testid="pay-block" data-total={String(total)} data-over-limit={overLimit ?? ""}>
      {note}
    </div>
  ),
}))

// The mainnet table: DAI settles, USDC and USDT are swapped into it. `usdcFee`: a table whose fee token is USDC.
const table = vi.hoisted(() => ({ usdcFee: false }))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mainnetTokens, mockLoadDepositFacts, usdcFeeTokens } = await import(
    "../../../support/depositTokens"
  )
  return mockLoadDepositFacts(importOriginal, () =>
    table.usdcFee ? usdcFeeTokens() : mainnetTokens(),
  )
})

vi.mock("../../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 10_000n * 10n ** 18n,
  useRowTxAmountCap: () => 10_000n * 10n ** 18n,
}))

// The sheet's own content is covered elsewhere; this suite checks which context the terms open it in.
vi.mock("../../../../src/features/limits/AboutLimitsSheet", () => ({
  WalletAboutLimitsSheet: ({
    topic,
    account = true,
    capacity,
  }: {
    topic?: string
    account?: boolean
    capacity?: { kind: string }
  }) => (
    <div
      data-testid="about-limits-sheet"
      data-topic={topic}
      data-account={String(account)}
      data-capacity={capacity?.kind}
    />
  ),
}))

const { RegistrationSheet } = await import("../../../../src/features/onboarding/RegistrationSheet")
const {
  DEPOSIT_TERMS_PENDING,
  formatDepositAmount,
  formatDepositDue,
  formatDepositSeen,
  swapAssetsLabel,
} = await import("../../../../src/features/onboarding/steps/DepositTermsRows")

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** Figures are built from the formatters the sheet prices with, never from its sentences. */
const usd = (amount: bigint) => formatDepositAmount(amount, 18)
const due = (amount: bigint) => formatDepositDue(amount, 18)
const seen = (amount: bigint) => formatDepositSeen(amount, 18)
/** A standard schedule under the asked deposit: a 14.5 floor, a 15 total. */
const address = `0x${"ab".repeat(20)}` as const
const payment = {
  chainLabel: "Sepolia",
  address,
  token: `0x${"cd".repeat(20)}` as `0x${string}`,
  chainId: 11155111,
  total: dai(15) as bigint | undefined,
  fee: dai(5) as bigint | undefined,
  sweepFee: dai(0.5) as bigint | undefined,
  floor: dai(14.5) as bigint | undefined,
  kind: "standard" as RegistrationKind,
  tokenSymbol: "DAI",
  tokenDecimals: 18,
}

let container: HTMLDivElement
let root: Root

const termsValue = (id: string) =>
  container.querySelector(`[data-testid="deposit-terms-${id}"]`)?.textContent ?? undefined
const payBlock = () => container.querySelector('[data-testid="pay-block"]')
const summary = () =>
  container.querySelector('[data-testid="registration-sheet-summary"]')?.textContent ?? ""

const render = (
  over: Partial<typeof payment> & {
    received?: bigint
    scheduleUnavailable?: boolean
    swapAssets?: string
  },
) =>
  act(() => {
    root.render(
      <RegistrationSheet tag="taga" title="Get instant access" payment={{ ...payment, ...over }} />,
    )
  })

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  table.usdcFee = false
})

describe("the sheet asks the quoted deposit and settles on the floor", () => {

  it("takes a deposit that clears the floor without reaching the ask", async () => {
    await render({ received: dai(14.7) })
    expect(container.textContent).toContain(seen(dai(14.7)))
    expect(container.textContent).not.toContain("Send at least")
  })

  it("asks the full total before any chain read lands", async () => {
    await render({ fee: undefined, sweepFee: undefined, floor: undefined })
    expect(termsValue("total")).toBe(due(dai(15)))
    // Every figure derived from the reads waits for them rather than guessing.
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
  })

  it("asks the total alone when no schedule is being read for it", async () => {
    await render({ fee: undefined, floor: undefined, scheduleUnavailable: true })
    expect(termsValue("total")).toBe(due(dai(15)))
    // A row nothing will fill is left out, not held open on a placeholder.
    for (const row of ["tag-price", "network-fee", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
    expect(container.textContent).not.toContain(DEPOSIT_TERMS_PENDING)
    expect(container.textContent).not.toContain("opening balance")
  })

  it("keeps the waiver visible with no schedule to price the rest", async () => {
    await render({
      fee: undefined,
      floor: undefined,
      kind: "earned_tag",
      scheduleUnavailable: true,
    })
    expect(termsValue("tag-price")).toBe("Waived")
    expect(termsValue("network-fee")).toBeUndefined()
    expect(termsValue("opening-balance")).toBeUndefined()
    expect(container.textContent).toContain("The tag is free.")
  })

  describe("what a free schedule waives, from the figures", () => {
    // A free schedule's fee is the relayer's sweep fee alone.
    const earned = {
      kind: "earned_tag" as RegistrationKind,
      fee: dai(0.5),
      sweepFee: dai(0.5),
      total: dai(5),
    }

    it("waives the tag and folds the sweep fee into network funding", async () => {
      await render({ ...earned })
      expect(termsValue("tag-price")).toBe("Waived")
      expect(termsValue("network-fee")).toBeUndefined()
      expect(termsValue("network-funding")).toBe(usd(dai(0.5)))
      expect(termsValue("opening-balance")).toBe(usd(dai(4.5)))
    })

    it("holds each figure open until its own read lands, the waiver already certain", async () => {
      await render({ ...earned, fee: undefined })
      expect(termsValue("tag-price")).toBe("Waived")
      expect(termsValue("network-funding")).toBe(usd(dai(0.5)))
      expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
      await render({ ...earned, sweepFee: undefined })
      expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    })
  })

  it("prices the tag above the sweep fee on a standard schedule, the network's share in one row", async () => {
    await render({ fee: dai(5.5), sweepFee: dai(0.5), total: dai(10) })
    expect(termsValue("tag-price")).toBe(usd(dai(5)))
    expect(termsValue("network-fee")).toBeUndefined()
    expect(termsValue("network-funding")).toBe(usd(dai(0.5)))
    expect(termsValue("opening-balance")).toBe(usd(dai(4.5)))
  })

  it("encodes the quoted total in the pay block, and the shortfall once part has arrived", async () => {
    await render({})
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(15)))
    await render({ received: dai(5) })
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(10)))
  })

  it("asks for nothing while the total is unsettled: no figure shown, none to pay", async () => {
    await render({ total: undefined, floor: undefined })
    expect(termsValue("total")).toBe(DEPOSIT_TERMS_PENDING)
    expect(payBlock()).toBeNull()
  })

  it("names a part-paid deposit while the total is still unsettled", async () => {
    // What is already at the address is named while the total waits, so a short deposit is not met
    // with silence.
    await render({
      kind: "earned_tag",
      total: undefined,
      fee: undefined,
      floor: undefined,
      received: dai(4),
    })
    expect(summary()).toContain(`The tag is free. ${seen(dai(4))} received.`)
    expect(payBlock()).toBeNull()
  })

  it("keeps asking rather than reporting a deposit against an unknown floor", async () => {
    await render({ floor: undefined, received: dai(14.7) })
    expect(container.textContent).not.toContain("Deposit received")
    expect(container.textContent).toContain(`${seen(dai(14.7))} of ${due(dai(15))} received`)
  })

  it("acknowledges the whole ask while the floor is still unread", async () => {
    // The ask is priced above any floor it could be weighed against, so a deposit at it is covered
    // whatever the read says. Nothing is left to pay.
    await render({ floor: undefined, received: dai(15) })
    expect(container.textContent).toContain(`Deposit received: ${seen(dai(15))}`)
    expect(container.textContent).not.toContain("Send")
    expect(payBlock()).toBeNull()
  })

  it("adds a line about the arrival for a deposit sent in another stablecoin", async () => {
    const notes = () => container.querySelectorAll(".ww-reg-sheet__warn").length
    await render({})
    expect(notes()).toBe(0)
    await render({ tokenSymbol: "USDC" })
    expect(notes()).toBe(1)
    expect(container.textContent).toContain("USDC")
  })
})

describe("a table whose fee token is USDC", () => {
  it("asks for USDC, with no swap line and no DAI", async () => {
    table.usdcFee = true
    await render({ tokenSymbol: "USDC" })
    const funding = container.querySelector('[data-testid="registration-sheet-funding"]')
    expect(funding?.textContent).toContain("USDC")
    expect(container.querySelectorAll(".ww-reg-sheet__warn").length).toBe(0)
    expect(container.textContent).not.toContain("DAI")
  })
})

describe("the sheet's per-deposit limit", () => {
  const overLimit = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-over-limit")

  const openLimit = () =>
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="deposit-terms-maximum"] [data-testid="about-limits-link"]',
        )!
        .click(),
    )
  const sheet = () => container.querySelector<HTMLElement>('[data-testid="about-limits-sheet"]')

  it("states the limit before the address exists, and explains it without an account", async () => {
    await render({ address: undefined, token: undefined, chainId: undefined })
    expect(container.querySelector('[data-testid="deposit-terms-maximum"]')?.textContent).toBe(
      `Deposit limit: ${LIMIT_USD} incl. fees`,
    )
    await openLimit()
    // No claim yet: no account to read an allowance for, and the address will come from the active
    // deployment.
    expect(sheet()?.dataset).toMatchObject({ topic: "limit", account: "false", capacity: "active" })
  })

  it("explains the limit on the address's own bucket once the address exists", async () => {
    await render({})
    await openLimit()
    expect(sheet()?.dataset.account).toBe("true")
    expect(sheet()?.dataset.capacity).not.toBe("active")
  })

  it(`offers an ask of exactly ${LIMIT_USD}`, async () => {
    await render({ total: dai(LIMIT) })
    expect(overLimit("address-row")).toBe("")
    expect(overLimit("pay-block")).toBe("")
  })

  it(`holds copy and payment for an ask over ${LIMIT_USD}, the whole ask counted`, async () => {
    // Part has arrived, so the pay block asks only the rest; the limit still counts the whole ask.
    await render({ total: dai(LIMIT) + 1n, floor: dai(LIMIT), received: dai(1000) })
    expect(overLimit("address-row")).toBe("public")
    expect(overLimit("pay-block")).toBe("public")
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(LIMIT - 1000) + 1n))
  })
})

describe("an opening balance for a deposit that may be swapped", () => {
  const note = () =>
    container.querySelector('[data-testid="deposit-terms-swap-note"]')?.textContent ?? undefined

  it("names the swapped tokens on mainnet and none elsewhere", () => {
    expect(swapAssetsLabel(mainnetTokens())).toBe("USDC or USDT")
    expect(swapAssetsLabel(singleToken(MAINNET_DAI))).toBeUndefined()
  })

  it("states the balance only for the settlement token, never 1:1 for a swapped one", async () => {
    await render({ swapAssets: "USDC or USDT" })
    expect(note()).toBe(
      "The opening balance assumes you send DAI. USDC or USDT is swapped to DAI at the market rate, so the balance can differ.",
    )
    expect(termsValue("opening-balance")).toBe(usd(dai(10)))
  })
})

describe("deposit amount formatters", () => {
  it("what is due rounds up to the cent, what was seen rounds down, in the token's own units", () => {
    const dai = (v: string) => BigInt(v.replace(".", "").padEnd(v.indexOf(".") + 18, "0"))
    expect(formatDepositDue(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositDue(dai("0.001"), 18)).toBe("$0.01")
    expect(formatDepositDue(1n, 18)).toBe("$0.01")
    expect(formatDepositDue(dai("15.005"), 18)).toBe("$15.01")
    expect(formatDepositDue(dai("1234.5"), 18)).toBe("$1,234.50")
    expect(formatDepositDue(0n, 18)).toBe("$0.00")
    expect(formatDepositSeen(dai("14.999"), 18)).toBe("$14.99")
    expect(formatDepositSeen(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositSeen(1n, 18)).toBe("$0.00")
    // A six-decimal token and a cent-precision one round the same way.
    expect(formatDepositDue(14_999_001n, 6)).toBe("$15.00")
    expect(formatDepositSeen(14_999_999n, 6)).toBe("$14.99")
    expect(formatDepositDue(1501n, 2)).toBe("$15.01")
    expect(formatDepositDue(15n, 0)).toBe("$15.00")
    // The informational split keeps nearest rounding.
    expect(formatDepositAmount(dai("15.005"), 18)).toBe("$15.01")
    expect(formatDepositAmount(dai("15.004"), 18)).toBe("$15.00")
  })
})

/**
 * The deposit sheet's own view of a transfer it just broadcast: the figures the wallet charged,
 * kept until the store has something better, and the sheet that renders them.
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Address, Hash, Hex } from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"

vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet", nodeUrl: "http://node.invalid" }),
}))
vi.mock("../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 5166n * 10n ** 18n,
  useRowTxAmountCap: () => 5166n * 10n ** 18n,
}))
// A two-row table: DAI and USDC each settle on their own row.
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, twoRowTokens } = await import("../../support/depositTokens")
  return mockLoadDepositFacts(importOriginal, () => twoRowTokens())
})

const { sentDepositRecord } = await import("../../../src/features/deposit/sentDepositRecord")
const { DepositDetailModal } = await import("../../../src/ui/screens/DepositDetailModal")
const { usdFigure } = await import("../../../src/ui/format")
const { ROW_DAI, ROW_USDC } = await import("../../support/depositTokens")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const L1_CHAIN_ID = 11155111
const SIPA = `0x${"11".repeat(20)}` as Address
const FUNDING_TX = `0x${"e6".repeat(32)}` as Hash
const SWEEP_TX = `0x${"5e".repeat(32)}` as Hash
const WALLET = `0x${"a1".repeat(20)}` as Hex

/** The 0.25 relayer sweep fee. */
const FACTS = {
  fee: "0.25",
  token: `0x${"bb".repeat(20)}` as Address,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  txAmountCap: 5166n * 10n ** 18n,
}

const SENT = {
  address: SIPA,
  txHash: FUNDING_TX,
  amount: "100.25",
  tokenSymbol: "DAI",
  tokenAddress: ROW_DAI,
  tokenDecimals: 18,
  walletName: "Rainbow",
  walletAddress: WALLET,
}

/** What discovery writes for a pooled address before anything is sent to it. */
const placeholder = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: SIPA,
    phase: "broadcast",
    amount: "0",
    tokenSymbol: "DAI",
    l1ChainId: L1_CHAIN_ID,
    startTime: 1_700_000_000_000,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: "0x01",
    recipientHash: "0x02",
    recoveryAddress: `0x${"bb".repeat(20)}`,
    ...patch,
  } as SIPADepositRecord)

describe("sentDepositRecord", () => {
  it("keeps the charged figures over a freshly resolved address", () => {
    // Resolution seeds the record the moment it derives the address, before any transfer exists:
    // a zero amount there is "nothing sent yet", never "this deposit was for nothing".
    const merged = sentDepositRecord(SENT, placeholder({ phase: "resolved" }), L1_CHAIN_ID, FACTS)!

    expect(merged.amount).toBe(SENT.amount)
    expect(merged.phase).toBe("funding")
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("keeps the sent token over a pooled placeholder's manifest token", () => {
    const pooled = placeholder({
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      tokenAddress: `0x${"da".repeat(20)}` as Address,
    })

    const usdc = { ...SENT, tokenSymbol: "USDC", tokenAddress: ROW_USDC, tokenDecimals: 6 }
    const merged = sentDepositRecord(usdc, pooled, L1_CHAIN_ID, FACTS)!

    expect(merged.tokenSymbol).toBe("USDC")
    expect(merged.tokenDecimals).toBe(6)
    expect(merged.tokenAddress).toBe(ROW_USDC)
    // The row's fee, in the row token's base units.
    expect(merged.fee).toBe(FACTS.sweepFeeAtomic.toString())
    expect(merged.phase).toBe("funding")
  })

  it("upgrades to the store's own amount, fee and hashes once the sweep lands", () => {
    const swept = placeholder({
      phase: "sweeping",
      amount: "100",
      fee: "400000000000000000",
      netAmount: "100000000000000000000",
      sweepTxHash: SWEEP_TX,
    })

    const merged = sentDepositRecord(SENT, swept, L1_CHAIN_ID, FACTS)!

    expect(merged).toMatchObject({
      phase: "sweeping",
      amount: "100",
      fee: "400000000000000000",
      sweepTxHash: SWEEP_TX,
    })
    // The charged view still owns what only it knows.
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("keeps a recovered record's own phase and token, zero amount and all", () => {
    // A recovery empties the address, so the record reads zero — a settled fact, not a placeholder.
    const recovered = placeholder({
      phase: "recovered",
      amount: "0",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
      recoveryTxHash: SWEEP_TX,
    })

    const merged = sentDepositRecord(SENT, recovered, L1_CHAIN_ID, FACTS)!

    expect(merged).toMatchObject({ phase: "recovered", amount: "0", tokenSymbol: "USDT" })
    expect(merged.fundingTxHash).toBe(FUNDING_TX)
  })

  it("falls back to the store while the quote is unknown", () => {
    const stored = placeholder()
    expect(sentDepositRecord(SENT, stored, L1_CHAIN_ID, undefined)).toBe(stored)
  })
})

describe("DepositDetailModal on a just-sent deposit", () => {
  let container: HTMLDivElement
  let root: Root

  const valueOf = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((row) => row.querySelector("span")?.textContent === label)
      ?.querySelector("b, a")
      ?.textContent?.replace(/\s+/g, " ")
      .trim()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("shows the gross, the fee, the net and the funding tx straight away", async () => {
    const merged = sentDepositRecord(SENT, placeholder(), L1_CHAIN_ID, FACTS)!
    await act(async () => {
      root.render(<DepositDetailModal record={merged} onClose={vi.fn()} />)
    })

    expect(valueOf("Sent")).toBe(usdFigure("100.25"))
    expect(valueOf("Fee")).toBe("0.25 DAI")
    expect(valueOf("Received")).toBe("100 DAI")
    expect(valueOf("Tx hash")).not.toBe("--")
  })

  it("reads a swept USDC record's amounts in USDC's own decimals", async () => {
    const swept = placeholder({
      phase: "claimed",
      amount: "99.9",
      netAmount: "99900000",
      fee: "100000",
      tokenSymbol: "USDC",
      tokenAddress: ROW_USDC,
      tokenDecimals: 6,
    })
    await act(async () => {
      root.render(<DepositDetailModal record={swept} onClose={vi.fn()} />)
    })

    expect(valueOf("Fee")).toBe("0.10 USDC")
    expect(valueOf("Received")).toBe("99.90 USDC")
    expect(valueOf("Sent")).toBe(usdFigure("100"))
  })

  it("prices a USDC row's deposit in USDC, its own units, and names no DAI", async () => {
    const sent = {
      ...SENT,
      amount: "10.1",
      tokenSymbol: "USDC",
      tokenAddress: ROW_USDC,
      tokenDecimals: 6,
    }
    const facts = {
      fee: "0.1",
      token: ROW_USDC,
      sweepFeeAtomic: 100_000n,
      txAmountCap: 2_583n * 10n ** 6n,
    }
    const merged = sentDepositRecord(sent, undefined, L1_CHAIN_ID, facts)!
    await act(async () => {
      root.render(<DepositDetailModal record={merged} onClose={vi.fn()} />)
    })

    expect(valueOf("Fee")).toBe("0.10 USDC")
    expect(valueOf("Received")).toBe("10 USDC")
    expect(container.textContent).not.toContain("DAI")
  })
})

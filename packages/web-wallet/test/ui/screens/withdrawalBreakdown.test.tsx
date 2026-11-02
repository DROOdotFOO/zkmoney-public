/**
 * The amount breakdown in the withdrawal detail sheet. The hero already states the burn amount, so
 * what is pinned is the two rows that account for where it goes — the fee the portal takes out of it
 * and what reaches the recipient — and the records that get no breakdown at all: one written before
 * the fee was recorded, and one that released nothing.
 */
import { act } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import type { Hex } from "viem"
import { parseUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { seedBootConfig } from "../../support/seedBootConfig"

const { WithdrawalDetailModal, withdrawalHeroAmount } = await import(
  "../../../src/ui/screens/WithdrawalDetailModal"
)

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const TIP = WITHDRAW_RELAYER_TIP.toString()

const record = (patch: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  localId: "wdraw_1",
  recipient: `0x${"dd".repeat(20)}`,
  recipientProvenance: "saved-recipient",
  amount: "120",
  rawAmount: parseUnits("120", 18).toString(),
  relayerTip: TIP,
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "done",
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_600_000,
  l2TxHash: `0x${"0a".repeat(32)}` as Hex,
  ...patch,
})

describe("WithdrawalDetailModal amount breakdown", () => {
  beforeAll(seedBootConfig)
  let container: HTMLDivElement
  let root: Root

  const rows = () =>
    Array.from(container.querySelectorAll(".ww-sheet__fact")).map((row) => [
      row.querySelector("span")?.textContent,
      row.querySelector("b, a")?.textContent?.replace(/\s+/g, " ").trim(),
    ])
  const labels = () => rows().map(([label]) => label)

  const show = async (r: WithdrawalRecord) => {
    await act(async () => {
      root.render(<WithdrawalDetailModal record={r} amount="-$120" onClose={vi.fn()} />)
    })
  }

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

  it("accounts for where the burn amount goes: fee off the sent figure, net at the foot", async () => {
    await show(record())

    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Sent", "$120"],
        ["Fee", "-$0.10"],
        ["Recipient receives", "119.9 DAI"],
      ]),
    )
    expect(labels().indexOf("Fee")).toBeLessThan(labels().indexOf("Recipient receives"))
    expect(labels().indexOf("Recipient receives")).toBe(labels().length - 1)
  })

  it("renders a 6-decimal token's amounts in its own decimals and symbol", async () => {
    await show(
      record({
        amount: "120",
        rawAmount: parseUnits("120", 6).toString(),
        relayerTip: parseUnits("0.1", 6).toString(),
        tokenSymbol: "USDC",
        tokenDecimals: 6,
      }),
    )
    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Sent", "$120"],
        ["Fee", "-$0.10"],
        ["Recipient receives", "119.9 USDC"],
      ]),
    )
  })

  // A migration's recipient is the new balance, which also pays the arrival's fee on the way in.
  it("prices a migration down to what the new balance receives", async () => {
    await show(
      record({
        intent: "migration",
        recipientAlias: "Your balance on the new version",
        arrivalFee: parseUnits("0.3", 18).toString(),
      }),
    )
    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Sent", "$120"],
        ["Old version fee", "-$0.10"],
        ["New version fee", "-$0.30"],
        ["You'll receive", "~$119.60"],
      ]),
    )
    expect(labels()).not.toContain("Recipient receives")
    expect(labels()).not.toContain("Fee")
  })

  it("gives a migration with an unknown arrival fee no breakdown", async () => {
    await show(record({ intent: "migration" }))
    expect(labels()).not.toContain("You'll receive")
    expect(labels()).not.toContain("Recipient receives")
  })

  it("shows the breakdown while the burn is still being confirmed: the fee is fixed at the seed", async () => {
    await show(record({ phase: "submitting", l2TxHash: undefined, blockNumber: undefined }))

    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Fee", "-$0.10"],
        ["Recipient receives", "119.9 DAI"],
      ]),
    )
  })

  it("shows no breakdown for a record written without the fee", async () => {
    await show(record({ relayerTip: undefined }))

    expect(labels()).not.toContain("Fee")
    expect(labels()).not.toContain("Recipient receives")
    expect(labels()).toContain("To")
  })

  it("shows no breakdown for a failed withdrawal, which released nothing", async () => {
    await show(record({ phase: "failed", failure: { code: "withdrawal.reorged" } }))

    expect(labels()).not.toContain("Recipient receives")
  })

  it("shows no breakdown when the fee takes the whole amount", async () => {
    await show(record({ amount: "0.1", rawAmount: TIP }))

    expect(labels()).not.toContain("Recipient receives")
  })

  // 100.25 gross − (0.1 tip + 0.15 relayer tip) = 100 swapped at the quoted 0.5 ETH → rate 0.005.
  const swapPatch: Partial<WithdrawalRecord> = {
    amount: "100.25",
    rawAmount: parseUnits("100.25", 18).toString(),
    swapOutput: "ETH",
    swapEscrow: `0x${"ee".repeat(20)}`,
    swapRelayerTip: parseUnits("0.15", 18).toString(),
    swapEstimatedOut: parseUnits("0.5", 18).toString(),
    swapOutputDecimals: 18,
  }

  it("renders a swap withdrawal in the output asset: estimate, rate, all-in fee, dual-figure foot", async () => {
    await show(record(swapPatch))

    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Token", "ETH"],
        ["Sent", "0.5"],
        ["Exchange rate", "$1 = 0.005"],
        ["Fee", "-$0.25"],
        ["Sent", "$100.25 = 0.50125 ETH"],
      ]),
    )
    expect(labels()).not.toContain("Recipient receives")
    expect(labels().lastIndexOf("Sent")).toBe(labels().length - 1)
  })

  it("claims no output figure for a swap record without a quote", async () => {
    await show(record({ ...swapPatch, swapEstimatedOut: undefined, swapOutputDecimals: undefined }))

    expect(rows()).toEqual(
      expect.arrayContaining([
        ["Token", "ETH"],
        ["Sent", "$100.25"],
        ["Fee", "-$0.25"],
      ]),
    )
    expect(labels()).not.toContain("Exchange rate")
    expect(labels()).not.toContain("Recipient receives")
    expect(labels().lastIndexOf("Sent")).toBe(labels().indexOf("Sent"))
  })

  it("leads swap, migration, and direct withdrawal heroes with dollars", () => {
    expect(withdrawalHeroAmount(record(swapPatch))).toBe("-$100.25")
    expect(withdrawalHeroAmount(record({ intent: "migration" }))).toBe("-$120")
    expect(withdrawalHeroAmount(record())).toBe("-$120")
  })
})

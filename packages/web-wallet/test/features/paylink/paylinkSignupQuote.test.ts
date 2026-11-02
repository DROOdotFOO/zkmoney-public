import { describe, expect, it } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { paylinkSignupQuote } from "../../../src/features/paylink/paylinkSignupQuote"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const TICKET = { fee: dai(0.5), min: 0n }
/** The source executor's withdrawal fee. */
const FEE = dai(0.1)

describe("paylinkSignupQuote", () => {
  it("burns the executor's fee and the relayer tip, keeps the rest now and the return later", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: TICKET,
      sweepFee: dai(0.5),
      proverTip: 0n,
      withdrawalFee: FEE,
    })
    expect(quote.burn).toBe(dai(0.71))
    // The burn's dust slice comes back with the sweep, but at a cent it is folded into the network
    // fee rather than shown as funds owed back.
    expect(quote.returned).toBe(0n)
    expect(quote.youReceive).toBe(dai(2.29))
    expect(quote.eventual).toBe(dai(2.3))
    expect(quote.covers).toBe(true)
    expect(quote.tagWaived).toBe(true)
    expect(quote.tagFee).toBe(0n)
    // Sweep fee, the executor's fee, the relayer tip and the dust.
    expect(quote.networkFee).toBe(dai(0.5) + FEE + WITHDRAW_RELAYER_TIP + dai(0.01))
    expect(quote.provingFee).toBe(0n)
    // Every row accounts for the note: what is kept and what leaves.
    expect(
      quote.youReceive! + quote.returned + quote.tagFee! + quote.networkFee + quote.provingFee,
    ).toBe(dai(3))
  })

  it("takes a committed prover tip from what the note leaves, on its own line", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: TICKET,
      sweepFee: dai(0.5),
      proverTip: dai(0.4),
      withdrawalFee: FEE,
    })
    expect(quote.burn).toBe(dai(1.11))
    expect(quote.youReceive).toBe(dai(1.89))
    expect(quote.eventual).toBe(dai(1.9))
    expect(quote.networkFee).toBe(dai(0.5) + FEE + WITHDRAW_RELAYER_TIP + dai(0.01))
    expect(quote.provingFee).toBe(dai(0.4))
    expect(
      quote.youReceive! + quote.returned + quote.tagFee! + quote.networkFee + quote.provingFee,
    ).toBe(dai(3))
    expect(
      paylinkSignupQuote({
        paylink: dai(1.11),
        schedule: TICKET,
        proverTip: dai(0.4),
        withdrawalFee: FEE,
      }).covers,
    ).toBe(false)
  })

  it("does not cover a note at or below the burn, and prices no coverage without an amount", () => {
    const at = (paylink: bigint) =>
      paylinkSignupQuote({ paylink, schedule: TICKET, proverTip: 0n, withdrawalFee: FEE }).covers
    expect(at(dai(0.71))).toBe(false)
    expect(at(dai(0.71) + 1n)).toBe(true)
    const unknown = paylinkSignupQuote({ schedule: TICKET, proverTip: 0n, withdrawalFee: FEE })
    expect(unknown.covers).toBeUndefined()
    expect(unknown.youReceive).toBeUndefined()
    expect(unknown.burn).toBe(dai(0.71))
  })

  it("names a fee above the live sweep fee as the tag's price, and withholds the verdict until that fee is read", () => {
    const dearer = paylinkSignupQuote({
      schedule: { fee: dai(0.7), min: 0n },
      sweepFee: dai(0.5),
      proverTip: 0n,
      withdrawalFee: FEE,
    })
    expect(dearer.tagWaived).toBe(false)
    expect(dearer.tagFee).toBe(dai(0.2))
    expect(dearer.networkFee).toBe(dai(0.5) + FEE + WITHDRAW_RELAYER_TIP + dai(0.01))
    const unread = paylinkSignupQuote({ schedule: TICKET, proverTip: 0n, withdrawalFee: FEE })
    expect(unread.tagWaived).toBeUndefined()
    expect(unread.tagFee).toBeUndefined()
    expect(unread.networkFee).toBe(dai(0.5) + FEE + WITHDRAW_RELAYER_TIP + dai(0.01))
  })

  it("frees a ticket's tag whatever the live sweep fee, its whole fee the network's", () => {
    const ticket = paylinkSignupQuote({
      schedule: { fee: dai(0.7), min: 0n },
      sweepFee: dai(0.5),
      proverTip: 0n,
      withdrawalFee: FEE,
      ticket: true,
    })
    expect(ticket.tagWaived).toBe(true)
    expect(ticket.tagFee).toBe(0n)
    expect(ticket.networkFee).toBe(dai(0.7) + FEE + WITHDRAW_RELAYER_TIP + dai(0.01))
    const unread = paylinkSignupQuote({
      schedule: TICKET,
      proverTip: 0n,
      withdrawalFee: FEE,
      ticket: true,
    })
    expect(unread.tagWaived).toBeUndefined()
  })

  it("funds a signed minimum once, and names it as returned", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: { fee: dai(0.5), min: dai(1) },
      proverTip: 0n,
      withdrawalFee: FEE,
    })
    expect(quote.burn).toBe(dai(1.7))
    // Real funds held until the sweep, not dust: it is a row of its own, off the network fee.
    expect(quote.returned).toBe(dai(1))
    expect(quote.networkFee).toBe(dai(0.5) + FEE + WITHDRAW_RELAYER_TIP)
    expect(quote.eventual).toBe(dai(2.3))
    expect(quote.youReceive! + quote.returned + quote.networkFee + quote.provingFee).toBe(dai(3))
  })
})

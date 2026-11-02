/**
 * `resolveFeePaymentMethod` takes the first payment method from the caller's
 * `sendOptions.fee.paymentMethod`, the submit context, then the sender's wallet default.
 */
import { describe, it, expect, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { resolveFeePaymentMethod } from "../../../src/services/helpers/feeResolution.js"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"

const explicitPm = { __tag: "explicit" } as unknown as FeePaymentMethod
const ctxPm = { __tag: "ctx" } as unknown as FeePaymentMethod
const walletPm = { __tag: "wallet" } as unknown as FeePaymentMethod

function makeWallet(defaultPm: FeePaymentMethod | undefined): ObsidionWallet {
  return {
    getDefaultSendOptions: vi
      .fn()
      .mockResolvedValue(defaultPm ? { fee: { paymentMethod: defaultPm } } : {}),
  } as unknown as ObsidionWallet
}

const sender = AztecAddress.fromBigIntUnsafe(1n)

describe("resolveFeePaymentMethod", () => {
  it("prefers the caller's explicit payment method", async () => {
    const result = await resolveFeePaymentMethod(
      { sendOptions: { fee: { paymentMethod: explicitPm } } },
      ctxPm,
      makeWallet(walletPm),
      sender,
    )
    expect(result).toBe(explicitPm)
  })

  it("returns undefined when all three sources are absent", async () => {
    const wallet = makeWallet(undefined)
    const result = await resolveFeePaymentMethod(undefined, undefined, wallet, sender)
    expect(result).toBeUndefined()
  })

  it("falls through to the sender's wallet default when sendOptions carries no fee", async () => {
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod({ sendOptions: {} }, undefined, wallet, sender)
    expect(result).toBe(walletPm)
    expect(wallet.getDefaultSendOptions).toHaveBeenCalledWith(sender)
  })

  it("prefers the submit context over the wallet default when sendOptions carries no fee", async () => {
    const result = await resolveFeePaymentMethod(
      { sendOptions: {} },
      ctxPm,
      makeWallet(walletPm),
      sender,
    )
    expect(result).toBe(ctxPm)
  })
})

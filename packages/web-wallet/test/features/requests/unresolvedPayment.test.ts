import { beforeEach, describe, expect, it } from "vitest"
import { clearPayment, holdPayment, paymentHeld } from "../../../src/features/requests/unresolvedPayment"

const A = "0x00000000000000000000000000000000000000aA"
const B = "0x00000000000000000000000000000000000000bB"

describe("unresolved request payments", () => {
  beforeEach(() => localStorage.clear())

  it("holds a payee's address until the payer clears it", () => {
    holdPayment("mainnet", A, "s1")
    expect(paymentHeld("mainnet", A.toLowerCase() as typeof A)).toBe(true)
    expect(paymentHeld("mainnet", B)).toBe(false)
    expect(paymentHeld("testnet", A)).toBe(false)
    clearPayment("mainnet", A)
    expect(paymentHeld("mainnet", A)).toBe(false)
  })

  it("lets a refused approval drop only its own marker", () => {
    holdPayment("mainnet", A, "s1")
    clearPayment("mainnet", A, "s2")
    expect(paymentHeld("mainnet", A)).toBe(true)
    clearPayment("mainnet", A, "s1")
    expect(paymentHeld("mainnet", A)).toBe(false)
  })
})

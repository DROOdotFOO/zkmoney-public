/** The account secret derivation, pinned so a change to it (which moves every account) is loud. No sandbox. */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { ACCOUNT_SECRET_KEY_LABEL } from "@obsidion/core/constants"
import { deriveAccountSecretKey } from "../../../../src/obsidion/alpha/account/accountSecretKey.js"

const MSK = new Fr(0x1234567890abcdefn)
const EXPECTED = "0x00e7a184569469c36335a1465147f8bcbde0ef2cd95a560661551df1f020c9c5"

describe("deriveAccountSecretKey", () => {
  it("pins the generation label", () => {
    expect(ACCOUNT_SECRET_KEY_LABEL).toBe("obsidion.wallet.account.secret.v1")
  })

  it("is deterministic and differs from the master secret", () => {
    const a = deriveAccountSecretKey(MSK)
    expect(a.equals(deriveAccountSecretKey(new Fr(MSK.toBigInt())))).toBe(true)
    expect(a.equals(MSK)).toBe(false)
  })

  it("separates master secrets", () => {
    expect(
      deriveAccountSecretKey(MSK).equals(deriveAccountSecretKey(new Fr(MSK.toBigInt() + 1n))),
    ).toBe(false)
  })

  it("matches the pinned vector", () => {
    expect(deriveAccountSecretKey(MSK).toString()).toBe(EXPECTED)
  })
})

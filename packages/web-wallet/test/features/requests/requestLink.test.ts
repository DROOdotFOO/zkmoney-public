import { describe, expect, it } from "vitest"
import type { RequestInlinePacket } from "@obsidion/front-core"
import { requestAmountDisplay, validateRequestPacket } from "../../../src/features/requests/requestLink"

const ROLLUP = "0xrollup"
const L2_TOKEN = `0x${"1b".repeat(32)}`
const NOW = 1_800_000_000_000

function packet(overrides: Partial<RequestInlinePacket> = {}): RequestInlinePacket {
  return {
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    amountAtomic: 1_000_000n,
    networkId: ROLLUP,
    tokenAddress: L2_TOKEN,
    tokenDecimals: 6,
    ...overrides,
  }
}

const env = { rollupAddress: ROLLUP, l2Token: L2_TOKEN, requireTokenAddress: false }

describe("validateRequestPacket", () => {
  it("passes a valid v3 packet", () => {
    expect(validateRequestPacket(packet(), env, NOW)).toBeNull()
  })

  it("flags expiry, wrong network, and wrong token", () => {
    expect(validateRequestPacket(packet({ expiresAt: NOW - 1 }), env, NOW)).toBe("expired")
    expect(validateRequestPacket(packet({ networkId: "0xother" }), env, NOW)).toBe("wrongNetwork")
    expect(validateRequestPacket(packet({ tokenAddress: `0x${"2c".repeat(32)}` }), env, NOW)).toBe(
      "wrongToken",
    )
  })

  it("token compare is case-insensitive", () => {
    const upper = { ...env, l2Token: L2_TOKEN.toUpperCase().replace("0X", "0x") }
    expect(validateRequestPacket(packet(), upper, NOW)).toBeNull()
  })

  it("legacy packet (no tokenAddress): tolerated with-account, rejected accountless", () => {
    const legacy = packet({ tokenAddress: undefined })
    expect(validateRequestPacket(legacy, env, NOW)).toBeNull()
    expect(validateRequestPacket(legacy, { ...env, requireTokenAddress: true }, NOW)).toBe(
      "legacyUnverifiable",
    )
  })

  it("a Receive code is for the payer's own network and token, and still expires", () => {
    const code = packet({ compact: true, networkId: "", tokenAddress: undefined })
    expect(validateRequestPacket(code, { ...env, requireTokenAddress: true }, NOW)).toBeNull()
    expect(validateRequestPacket({ ...code, expiresAt: NOW - 1 }, env, NOW)).toBe("expired")
  })
})

describe("requestAmountDisplay", () => {
  it("scales by the packet decimals, defaulting to 6", () => {
    expect(requestAmountDisplay(packet({ amountAtomic: 12_500_000n }))).toBe("12.5")
    expect(
      requestAmountDisplay(packet({ amountAtomic: 5_000_000n, tokenDecimals: undefined })),
    ).toBe("5")
  })

  it("returns empty for an any-amount link", () => {
    expect(requestAmountDisplay(packet({ amountAtomic: 0n }))).toBe("")
  })
})

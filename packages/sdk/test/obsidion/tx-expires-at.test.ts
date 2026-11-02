import { describe, expect, it } from "vitest"
import { txExpiresAtMs } from "../../src/obsidion/ObsidionWallet.js"
import { MAX_TX_LIFETIME_MS } from "../../src/obsidion/pending/index.js"

const NOW = 1_700_000_000_000
const CEILING = NOW + MAX_TX_LIFETIME_MS

describe("txExpiresAtMs", () => {
  it("is the pending-tx lifetime when the kernel sets no expiry", () => {
    expect(txExpiresAtMs(undefined, NOW)).toBe(CEILING)
    expect(txExpiresAtMs(0n, NOW)).toBe(CEILING)
  })

  it("is the kernel's expiry when that comes first", () => {
    expect(txExpiresAtMs(1_700_000_100n, NOW)).toBe(1_700_000_100_000)
  })

  it("never outlives the pending-tx lifetime", () => {
    const later = BigInt(Math.floor(CEILING / 1000) + 3600)
    expect(txExpiresAtMs(later, NOW)).toBe(CEILING)
  })
})

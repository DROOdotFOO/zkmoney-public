/**
 * The PRF → MSK reduction with the real `Fr`, against the vectors @obsidion/passkey-web's
 * Aztec-free derivation is pinned to. mskPrf.test.ts mocks `Fr` and cannot host this.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { deriveMskFromPrfOutput } from "../../../../src/obsidion/alpha/auth/mskPrf.js"

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../../test/fixtures/mskPrfParity.json"), "utf8"),
) as { mskReductionVectors: { label: string; prfHex: string; mskHex: string }[] }

describe("deriveMskFromPrfOutput against the shared reduction vectors", () => {
  it("covers the arithmetic boundary", () => {
    expect(fixture.mskReductionVectors.length).toBeGreaterThanOrEqual(6)
  })

  for (const { label, prfHex, mskHex } of fixture.mskReductionVectors) {
    it(label, () => {
      expect(deriveMskFromPrfOutput(new Uint8Array(Buffer.from(prfHex, "hex"))).toString()).toBe(
        mskHex,
      )
    })
  }
})

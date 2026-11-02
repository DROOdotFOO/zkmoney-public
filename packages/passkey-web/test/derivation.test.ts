/** The Aztec-free derivation against the vectors the sdk's `Fr` derivation is pinned to. */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bytesToHex, hexToBytes } from "../src/ceremony/bytes.js"
import { deriveMskFromPrf, deriveMskHexFromPrf, prfSalts } from "../src/derivation.js"

const fixture = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/mskPrfParity.json"),
    "utf8",
  ),
) as {
  saltHex: string
  contextualizedSaltHex: string
  mskReductionVectors: { label: string; prfHex: string; mskHex: string }[]
}

describe("deriveMskFromPrf", () => {
  it("reproduces every shared reduction vector", () => {
    expect(fixture.mskReductionVectors.length).toBeGreaterThanOrEqual(6)
    for (const { label, prfHex, mskHex } of fixture.mskReductionVectors) {
      const prf = hexToBytes(prfHex)
      expect(`0x${bytesToHex(deriveMskFromPrf(prf))}`, label).toBe(mskHex)
      expect(deriveMskHexFromPrf(prf), label).toBe(mskHex)
    }
  })

  it("rejects anything but 32 bytes", () => {
    expect(() => deriveMskFromPrf(new Uint8Array(31))).toThrow()
    expect(() => deriveMskFromPrf(new Uint8Array(33))).toThrow()
  })
})

describe("contextualize", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("hands the fixture's salt and its K(C) to every ceremony", async () => {
    expect(bytesToHex(MSK_PRF_SALT)).toBe(fixture.saltHex)
    const salts = await prfSalts()
    expect(salts.prfFirstSalt).toBe(MSK_PRF_SALT)
    expect(bytesToHex(salts.prfSecondSalt)).toBe(fixture.contextualizedSaltHex)
  })

  it("rejects with a clear error where WebCrypto is missing, then recovers", async () => {
    // A fresh module: the memoised second salt of the suite above would otherwise answer.
    vi.resetModules()
    const fresh = await import("../src/derivation.js")
    vi.stubGlobal("crypto", {})
    await expect(fresh.contextualize(MSK_PRF_SALT)).rejects.toThrow(/crypto\.subtle/)
    await expect(fresh.prfSalts()).rejects.toThrow(/crypto\.subtle/)
    vi.unstubAllGlobals()
    expect(bytesToHex((await fresh.prfSalts()).prfSecondSalt)).toBe(fixture.contextualizedSaltHex)
  })
})

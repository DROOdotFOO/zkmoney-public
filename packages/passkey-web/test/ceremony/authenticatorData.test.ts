import { ZERO_AAGUID } from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import {
  parseAaguid,
  parseAttestedAaguid,
  parseAuthenticatorDataFlags,
} from "../../src/ceremony/authenticatorData.js"

function authData(flags: number, length = 37): Uint8Array {
  const buf = new Uint8Array(length)
  buf[32] = flags
  return buf
}

const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"

function registration(aaguidHex: string, flags = 0x5d): Uint8Array {
  const buf = authData(flags, 37 + 16 + 2)
  for (let i = 0; i < 16; i++) buf[37 + i] = parseInt(aaguidHex.slice(i * 2, i * 2 + 2), 16)
  return buf
}

describe("parseAaguid", () => {
  it("reads the attested credential block as a hyphenated lowercase uuid", () => {
    expect(parseAaguid(registration(ICLOUD.replace(/-/g, "")))).toBe(ICLOUD)
  })

  it("is unknown without attested data, on an all-zero id, or on a short buffer", () => {
    expect(parseAaguid(registration(ICLOUD.replace(/-/g, ""), 0x1d))).toBeUndefined()
    expect(parseAaguid(registration("0".repeat(32)))).toBeUndefined()
    expect(parseAaguid(authData(0x5d, 37))).toBeUndefined()
  })
})

describe("parseAttestedAaguid", () => {
  it("keeps an all-zero id, which a response with no attested data never has", () => {
    expect(parseAttestedAaguid(registration("0".repeat(32)))).toBe(ZERO_AAGUID)
  })
})

describe("parseAuthenticatorDataFlags", () => {
  // Bits: UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40.
  it.each([
    [0x1d, true, true, true, false],
    [0x05, true, false, false, false],
    [0x09, false, true, false, false],
    [0x0d, true, true, false, false],
    [0x5d, true, true, true, true],
  ])("reads flags byte %i", (flags, userVerified, backupEligible, backupState, attested) => {
    expect(parseAuthenticatorDataFlags(authData(flags))).toEqual({
      userVerified,
      backupEligible,
      backupState,
      attestedCredentialData: attested,
    })
  })

  it("throws on a buffer that cannot carry the flags", () => {
    expect(() => parseAuthenticatorDataFlags(new Uint8Array(36))).toThrow()
  })
})

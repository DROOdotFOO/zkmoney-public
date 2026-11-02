import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  GPM_AAGUID,
  MSK_PRF_SALT,
  MSK_PRF_SALT_LABEL,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  contextualize,
  decodePrfOutput,
  deriveMskFromPrfOutput,
  normalizeAaguid,
  pickPrfSlot,
} from "../../../../src/obsidion/alpha/auth/mskPrf.js"

describe("MSK_PRF_SALT", () => {
  it("is the canonical 32-byte input: SHA-256 of the frozen v1 label", () => {
    // Canonicalization per prf-compat's canonicalPrfInput — WebAuthn-L3 PRF
    // inputs SHOULD be exactly 32 bytes. Changing either the label or the
    // precomputed bytes derives different wallets for every passkey.
    expect(MSK_PRF_SALT_LABEL).toBe("obsidion.wallet.msk.prf.salt.v1")
    const expected = createHash("sha256").update(MSK_PRF_SALT_LABEL, "utf8").digest()
    expect(Buffer.from(MSK_PRF_SALT).equals(expected)).toBe(true)
    expect(MSK_PRF_SALT.length).toBe(32)
  })
})

describe("contextualize (K(x))", () => {
  it("computes SHA-256('WebAuthn PRF' || 0x00 || x), pinned against K(C)", async () => {
    const C = MSK_PRF_SALT
    const expected = createHash("sha256")
      .update(
        Buffer.concat([Buffer.from("WebAuthn PRF", "utf8"), Buffer.from([0x00]), Buffer.from(C)]),
      )
      .digest()
    const got = await contextualize(C)
    expect(got.length).toBe(32)
    expect(Buffer.from(got).equals(expected)).toBe(true)
  })

  it("differs from the raw input (it is actually applied)", async () => {
    const got = await contextualize(MSK_PRF_SALT)
    expect(Buffer.from(got).equals(Buffer.from(MSK_PRF_SALT))).toBe(false)
  })
})

describe("normalizeAaguid", () => {
  it("produces canonical lowercase 8-4-4-4-12 from hyphenless / mixed-case input", () => {
    expect(normalizeAaguid("EA9B8D664D011D213CE4B6B48CB575D4")).toBe(
      "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
    )
    expect(normalizeAaguid("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toBe(
      "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
    )
  })

  it("throws on input that is not exactly 32 hex digits", () => {
    expect(() => normalizeAaguid("abc")).toThrow(/Malformed AAGUID/)
    expect(() => normalizeAaguid("")).toThrow(/Malformed AAGUID/)
  })
})

describe("pickPrfSlot", () => {
  it("iCloud, Apple iCloud AAGUID, recognized security keys, and 1Password → first", () => {
    expect(pickPrfSlot("00000000-0000-0000-0000-000000000000")).toBe("first")
    expect(pickPrfSlot("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")).toBe("first")
    expect(pickPrfSlot("cb69481e-8ff7-4039-93ec-0a2729a154a8")).toBe("first") // YubiKey 5 USB-A
    expect(pickPrfSlot("fa2b99dc-9e39-4257-8f92-4a30d23c4118")).toBe("first") // YubiKey 5 series
    expect(pickPrfSlot("d7781e5d-e353-46aa-afe2-3ca49f13332a")).toBe("first") // YubiKey 5 NFC (empirically proven)
    expect(pickPrfSlot("bada5566-a7aa-401f-bd96-45619a55120d")).toBe("first") // 1Password
  })

  it("Google Password Manager → second", () => {
    expect(pickPrfSlot("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe("second")
  })

  // The most important test: fail-closed on anything unverified — including the
  // Apple-managed AAGUID, which is deliberately NOT trusted.
  it("FAILS CLOSED (throws) on unrecognized providers and the unverified Apple-managed AAGUID", () => {
    expect(() => pickPrfSlot("dd4ec289-e01d-41c9-bb89-70fa845d4bf2")).toThrow(
      /unrecognized passkey provider/i,
    )
    expect(() => pickPrfSlot("ffffffff-ffff-ffff-ffff-ffffffffffff")).toThrow(
      /unrecognized passkey provider/i,
    )
    // Bitwarden / Dashlane / etc. — any unmeasured provider must throw.
    expect(() => pickPrfSlot("01020304-0506-0708-090a-0b0c0d0e0f10")).toThrow()
    // Every Yubico key is admitted (core's SECURITY_KEY_AAGUIDS); a key from anyone else is not.
    expect(pickPrfSlot("f8a011f3-8c0a-4d15-8006-17111f9edc7d")).toBe("first") // Security Key by Yubico
  })

  it("normalizes case/hyphens before deciding", () => {
    expect(pickPrfSlot("EA9B8D664D011D213CE4B6B48CB575D4")).toBe("second")
    expect(pickPrfSlot("BADA5566A7AA401FBD9645619A55120D")).toBe("first") // 1Password
  })
})

describe("decodePrfOutput", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252])

  it("returns undefined for absent, empty, or garbage values", () => {
    expect(decodePrfOutput(undefined)).toBeUndefined()
    expect(decodePrfOutput(null)).toBeUndefined()
    expect(decodePrfOutput("")).toBeUndefined()
    expect(decodePrfOutput(new Uint8Array(0))).toBeUndefined()
    expect(decodePrfOutput([])).toBeUndefined()
    expect(decodePrfOutput({})).toBeUndefined()
  })

  it("passes a Uint8Array through", () => {
    expect(decodePrfOutput(bytes)).toEqual(bytes)
  })

  it("decodes an ArrayBuffer", () => {
    expect(decodePrfOutput(bytes.buffer.slice(0))).toEqual(bytes)
  })

  it("decodes a number[]", () => {
    expect(decodePrfOutput(Array.from(bytes))).toEqual(bytes)
  })

  it("decodes a standard-base64 string (Swift Data JSON encoding)", () => {
    expect(decodePrfOutput(Buffer.from(bytes).toString("base64"))).toEqual(bytes)
  })

  it("decodes an unpadded base64url string", () => {
    const base64url = Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(decodePrfOutput(base64url)).toEqual(bytes)
  })

  it('decodes a JSON-serialized Uint8Array ({"0":n,...}), in index order', () => {
    const indexed = JSON.parse(JSON.stringify(Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11])))
    expect(decodePrfOutput(indexed)).toEqual(Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11]))
  })
})

describe("deriveMskFromPrfOutput", () => {
  it("rejects outputs that aren't exactly 32 bytes (too short OR too long)", () => {
    expect(() => deriveMskFromPrfOutput(new Uint8Array(31))).toThrow("exactly 32 bytes")
    expect(() => deriveMskFromPrfOutput(new Uint8Array(33))).toThrow("exactly 32 bytes")
  })
})

// Core owns the salt constants; this fixture pins the contextualization and provider-slot behavior.
describe("golden-fixture parity", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, "../../../../../../test/fixtures/mskPrfParity.json"), "utf8"),
  ) as {
    saltLabel: string
    saltHex: string
    contextualizedSaltHex: string
    slotByAaguid: Record<string, "first" | "second">
    failClosedAaguids: string[]
  }

  it("salt label + bytes match the fixture", () => {
    expect(MSK_PRF_SALT_LABEL).toBe(fixture.saltLabel)
    expect(Buffer.from(MSK_PRF_SALT).toString("hex")).toBe(fixture.saltHex)
  })

  it("contextualized salt K(C) matches the fixture", async () => {
    expect(Buffer.from(await contextualize(MSK_PRF_SALT)).toString("hex")).toBe(
      fixture.contextualizedSaltHex,
    )
  })

  it("the AAGUID slot table matches the fixture exactly (no extras, no omissions)", () => {
    for (const [aaguid, slot] of Object.entries(fixture.slotByAaguid)) {
      expect(pickPrfSlot(aaguid), aaguid).toBe(slot)
    }
    for (const aaguid of fixture.failClosedAaguids) {
      expect(() => pickPrfSlot(aaguid), aaguid).toThrow()
    }
    // Completeness: every accepted AAGUID in code appears in the fixture.
    const accepted = [
      "00000000-0000-0000-0000-000000000000",
      "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
      ONEPASSWORD_AAGUID,
      GPM_AAGUID,
      ...SECURITY_KEY_AAGUIDS,
    ]
    for (const aaguid of accepted) {
      expect(fixture.slotByAaguid[aaguid], `fixture missing ${aaguid}`).toBeDefined()
    }
  })
})

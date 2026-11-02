import { describe, expect, it } from "vitest"
import {
  type Evidence,
  candidatesFrom,
  evidenceOf,
  isComplete,
  preferredSlot,
  prfOutputFor,
  prfOutputsOf,
} from "../../src/rules/evidence.js"

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const first = bytes(32, 1)
const second = bytes(32, 2)

describe("evidence", () => {
  it("keeps only the flags, the two slots and the reported class of a result", () => {
    const result = {
      backupEligible: true,
      prfFirst: first,
      authenticatorAttachment: "cross-platform" as const,
      credentialId: "x",
    }
    expect(evidenceOf(result as Evidence & { credentialId: string })).toEqual({
      backupEligible: true,
      prfFirst: first,
      prfSecond: undefined,
      authenticatorAttachment: "cross-platform",
    })
  })

  it("is complete only with readable flags and the bound slot", () => {
    expect(isComplete({ backupEligible: true, prfFirst: first }, "first")).toBe(true)
    expect(isComplete({ backupEligible: false, prfFirst: first }, "first")).toBe(true)
    expect(isComplete({ backupEligible: true, prfFirst: first }, "second")).toBe(false)
    expect(isComplete({ prfFirst: first, prfSecond: second }, "first")).toBe(false)
  })
})

describe("prfOutputFor", () => {
  it("returns the bound slot behind the backup gate", () => {
    expect(
      prfOutputFor({ backupEligible: true, prfFirst: first, prfSecond: second }, "first"),
    ).toBe(first)
    expect(prfOutputFor({ backupEligible: true, prfSecond: second }, "second")).toBe(second)
  })

  it("refuses a device-bound or unreadable passkey before looking at the slots", () => {
    expect(() => prfOutputFor({ backupEligible: false, prfFirst: first }, "first")).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
    expect(() => prfOutputFor({ prfFirst: first }, "first")).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
  })

  it("lets a security key past the backup gate, but never an unreadable flag", () => {
    expect(prfOutputFor({ backupEligible: false, prfFirst: first }, "first", true)).toBe(first)
    expect(() => prfOutputFor({ prfFirst: first }, "first", true)).toThrow(
      expect.objectContaining({ name: "DeviceBoundPasskeyError" }),
    )
  })

  it("still refuses a security key that returned no usable slot", () => {
    expect(() => prfOutputFor({ backupEligible: false }, "first", true)).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
  })

  it("tells a one-salt provider from no PRF at all", () => {
    expect(() => prfOutputFor({ backupEligible: true, prfFirst: first }, "second")).toThrow(
      expect.objectContaining({ name: "SingleSaltProviderError" }),
    )
    expect(() => prfOutputFor({ backupEligible: true, prfSecond: second }, "first")).toThrow(
      expect.objectContaining({ name: "SingleSaltProviderError" }),
    )
    expect(() => prfOutputFor({ backupEligible: true }, "first")).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
  })
})

describe("candidatesFrom", () => {
  it("returns every slot the assertion answered", () => {
    expect(candidatesFrom({ backupEligible: true, prfFirst: first, prfSecond: second })).toEqual({
      first,
      second,
    })
  })

  it("refuses an answer with no valid slot", () => {
    expect(() => candidatesFrom({ backupEligible: true })).toThrow(
      expect.objectContaining({ name: "NoPrfError" }),
    )
    expect(() =>
      candidatesFrom({ backupEligible: true, prfFirst: bytes(31), prfSecond: bytes(0) }),
    ).toThrow(expect.objectContaining({ name: "NoPrfError" }))
  })

  it("accepts another device's answer that cannot be backed up, and only that", () => {
    expect(
      candidatesFrom({
        backupEligible: false,
        authenticatorAttachment: "cross-platform",
        prfFirst: first,
      }),
    ).toEqual({ first })
    expect(() =>
      candidatesFrom({
        backupEligible: false,
        authenticatorAttachment: "platform",
        prfFirst: first,
      }),
    ).toThrow(expect.objectContaining({ name: "DeviceBoundPasskeyError" }))
    // Unreadable flags stay a refusal whatever answered.
    expect(() =>
      candidatesFrom({ authenticatorAttachment: "cross-platform", prfFirst: first }),
    ).toThrow(expect.objectContaining({ name: "DeviceBoundPasskeyError" }))
  })
})

describe("prfOutputsOf", () => {
  it("returns both slots, one, or none, with no gate", () => {
    expect(prfOutputsOf({ prfFirst: first, prfSecond: second })).toEqual({ first, second })
    expect(prfOutputsOf({ backupEligible: false, prfSecond: second })).toEqual({ second })
    expect(prfOutputsOf({ backupEligible: false, authenticatorAttachment: "platform" })).toEqual({})
  })

  it("drops a malformed slot and keeps a valid sibling", () => {
    expect(prfOutputsOf({ prfFirst: bytes(31), prfSecond: second })).toEqual({ second })
    expect(prfOutputsOf({ prfFirst: first, prfSecond: bytes(33) })).toEqual({ first })
    expect(prfOutputsOf({ prfFirst: bytes(0) })).toEqual({})
  })
})

describe("preferredSlot", () => {
  it("prefers the record's slot, then the attachment's, then first", () => {
    expect(preferredSlot("platform", "first")).toBe("first")
    expect(preferredSlot("platform")).toBe("second")
    expect(preferredSlot("cross-platform")).toBe("first")
    expect(preferredSlot(undefined)).toBe("first")
  })
})

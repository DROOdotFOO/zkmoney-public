import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type Chip,
  type CreationContext,
  UNKNOWN_PROVENANCE,
  type UserHandleProvenance,
  decodeUserHandle,
  decodeUserHandleProvenance,
  encodeUserHandle,
} from "../../src/ceremony/userHandle.js"

/** The context byte each name writes, as the layout fixes it. */
const CONTEXT_BYTES: Record<CreationContext, number> = {
  unknown: 0x00,
  ios_app: 0x01,
  ios_browser: 0x02,
  android_browser: 0x03,
  phone_other: 0x04,
  mac_local: 0x10,
  mac_qr: 0x11,
  mac_key: 0x12,
  windows_local: 0x20,
  windows_qr: 0x21,
  windows_key: 0x22,
  laptop_other_local: 0x30,
  laptop_other_qr: 0x31,
  laptop_other_key: 0x32,
}
const CONTEXTS = Object.keys(CONTEXT_BYTES) as CreationContext[]

const MAC_LOCAL: UserHandleProvenance = {
  context: "mac_local",
  osVersion: { major: 26, minor: 4, patch: 1 },
  chip: "arm",
}

const ascii = (text: string) => [...new TextEncoder().encode(text)]
const bytes = (...parts: (number | number[])[]) => new Uint8Array(parts.flat())

/** Sixteen fixed tail bytes with zeros inside them, so the first separator rule is pinned. */
const RANDOM_TAIL = [
  0x00, 0x11, 0x22, 0x00, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x00,
]

function fixRandom(pattern: number[]) {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(array: T) => {
      const view = array as unknown as Uint8Array
      for (let i = 0; i < view.length; i++) view[i] = pattern[i % pattern.length]!
      return array
    },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the passkey user handle", () => {
  it("writes the name, the separator, then the 22-byte tail at fixed offsets", () => {
    fixRandom(RANDOM_TAIL)
    expect([...encodeUserHandle("alice", MAC_LOCAL)]).toEqual([
      ...ascii("alice"),
      0x00, // separator
      0x01, // format version
      0x10, // Mac browser, local route
      26,
      4,
      1, // macOS 26.4.1
      0x01, // arm
      ...RANDOM_TAIL,
    ])
  })

  it("round-trips the name and every context, with and without a version and chip", () => {
    for (const context of CONTEXTS) {
      const full: UserHandleProvenance = {
        context,
        osVersion: { major: 15, minor: 0, patch: 0 },
        chip: "x86",
      }
      const bare: UserHandleProvenance = { context, osVersion: {}, chip: "unknown" }
      for (const provenance of [full, bare]) {
        const handle = encodeUserHandle("alice", provenance)
        expect(decodeUserHandle(handle)).toBe("alice")
        expect(decodeUserHandleProvenance(handle)).toEqual(provenance)
      }
    }
  })

  it("writes each context and chip as its fixed byte", () => {
    for (const [context, byte] of Object.entries(CONTEXT_BYTES) as [CreationContext, number][]) {
      expect(encodeUserHandle("a", { context, osVersion: {}, chip: "unknown" })[3], context).toBe(
        byte,
      )
    }
    const chips: Record<Chip, number> = { unknown: 0x00, arm: 0x01, x86: 0x02 }
    for (const [chip, byte] of Object.entries(chips) as [Chip, number][]) {
      expect(encodeUserHandle("a", { context: "unknown", osVersion: {}, chip })[7], chip).toBe(byte)
    }
  })

  it("writes an explicitly unknown provenance when given none", () => {
    expect(decodeUserHandleProvenance(encodeUserHandle("alice"))).toEqual(UNKNOWN_PROVENANCE)
  })

  it("fits a 41-byte name in 64 bytes and refuses one over the budget", () => {
    expect(() => encodeUserHandle("")).toThrow()
    expect(() => encodeUserHandle("a".repeat(42))).toThrow()
    expect(() => encodeUserHandle("é".repeat(21))).toThrow()
    // The longest handles, 64 bytes, still read their name and their tail.
    for (const name of ["a".repeat(41), "é".repeat(20) + "a", "😀".repeat(10) + "a"]) {
      const handle = encodeUserHandle(name, MAC_LOCAL)
      expect(handle).toHaveLength(64)
      expect(decodeUserHandle(handle)).toBe(name)
      expect(decodeUserHandleProvenance(handle)).toEqual(MAC_LOCAL)
    }
  })

  it("makes each creation its own user: two encodes differ in the random bytes only", () => {
    const first = encodeUserHandle("alice", MAC_LOCAL)
    const second = encodeUserHandle("alice", MAC_LOCAL)
    expect([...first.subarray(0, 12)]).toEqual([...second.subarray(0, 12)])
    expect(Buffer.from(first.subarray(12)).equals(Buffer.from(second.subarray(12)))).toBe(false)
  })

  it("writes a version component only as a whole number in 0 to 254", () => {
    const encode = (major: number) =>
      encodeUserHandle("a", { context: "mac_local", osVersion: { major }, chip: "arm" })[4]
    expect(encode(0)).toBe(0)
    expect(encode(254)).toBe(254)
    for (const bad of [255, 300, -1, 1.5, NaN, Infinity]) expect(encode(bad)).toBe(0xff)
  })

  it("writes only arm and x86 as a chip, and reads each version byte of 0xff as unknown", () => {
    for (const chip of ["arm64", "", undefined] as unknown as Chip[]) {
      const handle = encodeUserHandle("a", { context: "mac_local", osVersion: {}, chip })
      expect(decodeUserHandleProvenance(handle)?.chip).toBe("unknown")
    }
    const handle = encodeUserHandle("a", MAC_LOCAL)
    handle[5] = 0xff
    expect(decodeUserHandleProvenance(handle)?.osVersion).toEqual({ major: 26, patch: 1 })
  })
})

describe("older and malformed handles", () => {
  const legacyWeb = (name: string) => bytes(ascii(name), 0x00, RANDOM_TAIL)

  it("reads a name and 16 random bytes as the name and no provenance", () => {
    for (const name of ["alice", "@alice", "a".repeat(47)]) {
      expect(decodeUserHandle(legacyWeb(name))).toBe(name)
      expect(decodeUserHandleProvenance(legacyWeb(name))).toBeUndefined()
    }
  })

  it("reads 32 random bytes as no name and no provenance", () => {
    const noSeparator = bytes(Array.from({ length: 32 }, (_, i) => 0x61 + (i % 26)))
    expect(decodeUserHandle(noSeparator)).toBeUndefined()
    expect(decodeUserHandleProvenance(noSeparator)).toBeUndefined()
    // A separator at offset 9 and a version byte, but a context no page writes.
    const nearMiss = bytes(
      ascii("abcdefghi"),
      0x00,
      0x01,
      0x7f,
      0x1a,
      0x04,
      0x01,
      0x01,
      Array(16).fill(0x7a),
    )
    expect(decodeUserHandle(nearMiss)).toBe("abcdefghi")
    expect(decodeUserHandleProvenance(nearMiss)).toBeUndefined()
  })

  it("cannot tell a random handle that takes the new shape from a real one", () => {
    // The accepted collision: 32 bytes whose first separator sits at offset 9 before a valid tail.
    const collision = bytes(
      ascii("abcdefghi"),
      0x00,
      0x01,
      0x10,
      0x1a,
      0x04,
      0x01,
      0x01,
      Array(16).fill(0x7a),
    )
    expect(decodeUserHandle(collision)).toBe("abcdefghi")
    expect(decodeUserHandleProvenance(collision)).toEqual(MAC_LOCAL)
  })

  it("reads nothing from a handle that carries no name", () => {
    for (const handle of [
      undefined,
      new Uint8Array(0),
      new Uint8Array([0x00, 0x01, 0x02]),
      new Uint8Array([0x61, 0x62, 0x63]),
      new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    ]) {
      expect(decodeUserHandle(handle)).toBeUndefined()
      expect(decodeUserHandleProvenance(handle)).toBeUndefined()
    }
  })

  it("reads no provenance from a tail of the wrong length, version, context or chip", () => {
    const good = encodeUserHandle("alice", MAC_LOCAL)
    const tail = [...good.subarray(6)]
    const withTail = (t: number[]) => bytes(ascii("alice"), 0x00, t)
    for (const bad of [
      withTail(tail.slice(0, 21)),
      withTail([...tail, 0x00]),
      withTail([0x02, ...tail.slice(1)]),
      withTail([tail[0]!, 0x05, ...tail.slice(2)]),
      withTail([...tail.slice(0, 5), 0x03, ...tail.slice(6)]),
    ]) {
      expect(decodeUserHandle(bad)).toBe("alice")
      expect(decodeUserHandleProvenance(bad)).toBeUndefined()
    }
  })

  it("reads no provenance behind a name the encoder would not have written", () => {
    const tail = [...encodeUserHandle("alice", MAC_LOCAL).subarray(6)]
    expect(decodeUserHandleProvenance(bytes(0x00, tail))).toBeUndefined()
    expect(decodeUserHandleProvenance(bytes(0xff, 0xfe, 0x00, tail))).toBeUndefined()
    const overBudget = bytes(ascii("a".repeat(42)), 0x00, tail)
    expect(decodeUserHandle(overBudget)).toBe("a".repeat(42))
    expect(decodeUserHandleProvenance(overBudget)).toBeUndefined()
  })
})

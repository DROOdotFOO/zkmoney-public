import { describe, it, expect } from "vitest"
import { encode as cborEncode } from "cbor-x"
import { Buffer } from "buffer"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import {
  assertLinkChain,
  assertLinkClass,
  encodePaylinkInline,
  decodePaylinkInline,
  decodePaylinkLocatorPayload,
  encodePaylinkLocatorPayload,
} from "../../../../src/services/paylink/link/paylinkInlineCodec.js"
import type { PaylinkParams } from "../../../../src/services/paylink/PaylinkService.js"

const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const fromBase64Url = (u: string) => {
  let s = u.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4) s += "="
  return s
}
const encMap = (m: Map<number, unknown>) =>
  toBase64Url(Buffer.from(cborEncode(m)).toString("base64"))

function makeParams(overrides: Partial<PaylinkParams> = {}): PaylinkParams {
  return {
    secret: Fr.random(),
    paylinkType: "paylinkDirect",
    classId: Fr.random(),
    chainId: 11155111,
    fallbackKeyHash: Fr.random(),
    rollupVersion: 4127419662,
    escrowTagSecret: Grumpkin.generator,
    ...overrides,
  }
}

function expectRoundTrip(params: PaylinkParams) {
  const decoded = decodePaylinkInline(encodePaylinkInline(params))
  expect(decoded.secret.toString()).toBe(params.secret.toString())
  expect(decoded.paylinkType).toBe(params.paylinkType)
  expect(decoded.classId.toString()).toBe(params.classId.toString())
  expect(decoded.chainId).toBe(params.chainId)
  expect(decoded.fallbackKeyHash.toString()).toBe(params.fallbackKeyHash.toString())
  expect(decoded.rollupVersion).toBe(params.rollupVersion)
  expect(decoded.escrowTagSecret?.toString()).toBe(params.escrowTagSecret?.toString())
  return decoded
}

describe("paylinkInlineCodec", () => {
  it("round-trips each flavor", () => {
    expectRoundTrip(makeParams({ paylinkType: "paylinkDirect" }))
    expectRoundTrip(makeParams({ paylinkType: "paylinkEmail" }))
  })

  it("carries nothing but the secret, the fallback hash, the class, the rollup and the tag point", () => {
    const fragment = encodePaylinkInline(makeParams())
    expect(fragment).not.toMatch(/[+/=]/) // base64url, no padding
    // three fields + one point + chain id + rollup version + map overhead
    expect(Buffer.from(fromBase64Url(fragment), "base64").length).toBeLessThan(208)
    expect(fragment.length).toBeLessThan(280)
  })

  it("omits the escrow tag point when absent", () => {
    expect(
      expectRoundTrip(makeParams({ escrowTagSecret: undefined })).escrowTagSecret,
    ).toBeUndefined()
  })

  it("carries a short link's seed when it has one", () => {
    const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
    expect(expectRoundTrip(makeParams({ seed })).seed).toEqual(seed)
    expect(expectRoundTrip(makeParams()).seed).toBeUndefined()
  })

  it("carries the note's terms, and fits every field under the fragment cap", () => {
    const terms = Fr.random()
    expect(expectRoundTrip(makeParams({ terms })).terms).toEqual(terms)
    expect(expectRoundTrip(makeParams()).terms).toBeUndefined()
    const full = encodePaylinkInline(
      makeParams({ terms, seed: Uint8Array.from({ length: 16 }, (_, i) => i) }),
    )
    expect(Buffer.from(fromBase64Url(full), "base64").length).toBeLessThanOrEqual(256)
  })

  it("round-trips a locator payload, which never holds the secret", () => {
    const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
    const params = makeParams({ seed, terms: Fr.random() })
    const bytes = encodePaylinkLocatorPayload(params)
    expect(Buffer.from(bytes).includes(params.secret.toBuffer())).toBe(false)
    const decoded = decodePaylinkLocatorPayload(bytes, params.secret, seed)
    expect(encodePaylinkInline(decoded)).toBe(encodePaylinkInline(params))
  })

  it("refuses a locator payload without terms", () => {
    const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
    const params = makeParams({ seed })
    expect(() =>
      decodePaylinkLocatorPayload(encodePaylinkLocatorPayload(params), params.secret, seed),
    ).toThrow(/Invalid paylink link/)
  })

  it("refuses a locator payload that holds a secret", () => {
    const params = makeParams()
    const raw = Buffer.from(fromBase64Url(encodePaylinkInline(params)), "base64")
    expect(() =>
      decodePaylinkLocatorPayload(new Uint8Array(raw), params.secret, new Uint8Array(16)),
    ).toThrow(/Invalid paylink link/)
  })

  it("rejects a chain id or rollup version that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodePaylinkInline(makeParams({ chainId: bad }))).toThrow()
      expect(() => encodePaylinkInline(makeParams({ rollupVersion: bad }))).toThrow()
    }
  })

  it("rejects an unknown paylink type", () => {
    expect(() => encodePaylinkInline(makeParams({ paylinkType: "nope" }))).toThrow()
  })

  it("fails closed on malformed input", () => {
    const secret = Fr.random().toBuffer()
    const classId = Fr.random().toBuffer()
    const good = new Map<number, unknown>([
      [1, 2],
      [2, 0],
      [3, secret],
      [4, classId],
      [5, 31337],
      [7, Fr.random().toBuffer()],
      [8, 1],
    ])
    expect(() => decodePaylinkInline(encMap(good))).not.toThrow()
    const bad: Array<[string, Map<number, unknown>]> = [
      ["old format", new Map([...good, [1, 1]])],
      ["unknown type", new Map([...good, [2, 7]])],
      ["short secret", new Map([...good, [3, secret.subarray(1)]])],
      ["missing class", new Map([...good].filter(([k]) => k !== 4))],
      ["string chain", new Map([...good, [5, "1"]])],
      ["missing version", new Map([...good].filter(([k]) => k !== 8))],
      ["string version", new Map([...good, [8, "1"]])],
      ["short point", new Map([...good, [6, new Uint8Array(63)]])],
      ["missing fallback hash", new Map([...good].filter(([k]) => k !== 7))],
      ["short fallback hash", new Map([...good, [7, secret.subarray(1)]])],
    ]
    for (const [label, m] of bad) {
      expect(() => decodePaylinkInline(encMap(m)), label).toThrow("Invalid paylink link")
    }
    expect(() => decodePaylinkInline("")).toThrow("Invalid paylink link")
    expect(() => decodePaylinkInline("not base64!")).toThrow("Invalid paylink link")
    expect(() => decodePaylinkInline(toBase64Url(Buffer.alloc(300).toString("base64")))).toThrow(
      "Invalid paylink link",
    )
    expect(() =>
      decodePaylinkInline(toBase64Url(Buffer.from(cborEncode([1, 2])).toString("base64"))),
    ).toThrow("Invalid paylink link")
  })

  it("refuses a link derived against another class, chain or rollup deployment", () => {
    const params = makeParams()
    expect(() => assertLinkClass(params, { currentContractClassId: params.classId })).not.toThrow()
    expect(() => assertLinkClass(params, { currentContractClassId: Fr.random() })).toThrow(
      /another version/,
    )
    expect(() => assertLinkChain(params, params)).not.toThrow()
    expect(() => assertLinkChain(params, { ...params, chainId: 1 })).toThrow(/different network/)
    expect(() => assertLinkChain(params, { ...params, rollupVersion: 9 })).toThrow(
      /another deployment/,
    )
  })
})

import { describe, expect, it } from "vitest"
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
} from "../../src/ceremony/bytes.js"

describe("bytes", () => {
  it("round-trips base64url and hex, empty input included", () => {
    for (const bytes of [new Uint8Array(0), Uint8Array.from([0, 1, 254, 255, 62, 63])]) {
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes)
      expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
    }
    expect(bytesToBase64Url(Uint8Array.from([251, 255, 191]))).toBe("-_-_")
    expect(bytesToHex(Uint8Array.from([0, 171, 255]))).toBe("00abff")
  })

  it("reads hex with a prefix and in either case", () => {
    expect(hexToBytes("0x00AbFf")).toEqual(Uint8Array.from([0, 171, 255]))
  })

  it("rejects odd lengths and non-hex characters", () => {
    expect(() => hexToBytes("abc")).toThrow()
    expect(() => hexToBytes("zz")).toThrow()
  })
})

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import jsQR from "jsqr"
import { decodeQrImage } from "../../../src/features/scan/decodeQrImage"
import { MAX_QR_FRAME_SIDE } from "../../../src/features/scan/qrFrame"

vi.mock("jsqr", () => ({ default: vi.fn(() => null) }))
const decoder = vi.mocked(jsQR)
beforeEach(() => decoder.mockReset().mockReturnValue(null))

function coloredFrame() {
  return new Uint8ClampedArray([100, 200, 200, 255, 200, 200, 200, 255])
}

describe("bounded contrast fallback", () => {
  it("attempts the original and at most three contrast frames without changing input", () => {
    const frame = coloredFrame()
    const original = frame.slice()
    expect(decodeQrImage(frame, 2, 1)).toBeNull()
    expect(decoder).toHaveBeenCalledTimes(4)
    expect(decoder.mock.calls[0][0]).toBe(frame)
    expect(frame).toEqual(original)
    for (const call of decoder.mock.calls) {
      expect(call[1]).toBe(2)
      expect(call[2]).toBe(1)
      expect(call[3]).toEqual({ inversionAttempts: "attemptBoth" })
    }
  })
  it("skips contrast work for an image with one intensity", () => {
    expect(decodeQrImage(new Uint8ClampedArray(16), 2, 2)).toBeNull()
    expect(decoder).toHaveBeenCalledOnce()
  })
  it.each([1, 2, 3, 4])("stops after a payload on decode attempt %s", (attempt) => {
    for (let count = 1; count < attempt; count++) decoder.mockReturnValueOnce(null)
    decoder.mockReturnValueOnce({ data: "complete#payload" } as NonNullable<ReturnType<typeof jsQR>>)
    expect(decodeQrImage(coloredFrame(), 2, 1)).toBe("complete#payload")
    expect(decoder).toHaveBeenCalledTimes(attempt)
  })
  it.each([
    [0, 2], [-1, 2], [2.5, 2], [NaN, 2], [Infinity, 2],
    [MAX_QR_FRAME_SIDE + 1, 1], [1, MAX_QR_FRAME_SIDE + 1], [2, 0],
  ])("rejects invalid dimensions %s x %s before decoding", (width, height) => {
    expect(() => decodeQrImage(new Uint8ClampedArray(16), width, height)).toThrow("Invalid camera frame")
    expect(decoder).not.toHaveBeenCalled()
  })
  it("rejects truncated, oversized and non-RGBA buffers before decoding", () => {
    for (const frame of [new Uint8ClampedArray(15), new Uint8ClampedArray(17), new Uint8Array(16)]) {
      expect(() => decodeQrImage(frame as Uint8ClampedArray, 2, 2)).toThrow("Invalid camera frame")
    }
    expect(decoder).not.toHaveBeenCalled()
  })
  it("accepts the capture size ceiling", () => {
    const frame = new Uint8ClampedArray(MAX_QR_FRAME_SIDE ** 2 * 4)
    expect(decodeQrImage(frame, MAX_QR_FRAME_SIDE, MAX_QR_FRAME_SIDE)).toBeNull()
    expect(decoder).toHaveBeenCalledOnce()
  })
})

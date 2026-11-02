// @vitest-environment node
import { describe, expect, it } from "vitest"
import { encode } from "uqr"
import { decodeQrImage } from "../../../src/features/scan/decodeQrImage"
import { walletQrCorpus } from "../../fixtures/scanPayloads"

const corpus = await walletQrCorpus()

describe("bundled decoder with wallet QR payloads", () => {
  for (const [name, payload] of Object.entries(corpus)) {
    it.each([false, true])(`decodes ${name} with inverted=%s`, (inverted) => {
      const qr = encode(payload)
      const scale = 5
      const size = qr.size * scale
      const pixels = new Uint8ClampedArray(size * size * 4)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const filled = qr.data[Math.floor(y / scale)][Math.floor(x / scale)]
          const value = filled !== inverted ? 0 : 255
          pixels.set([value, value, value, 255], (y * size + x) * 4)
        }
      }
      expect(decodeQrImage(pixels, size, size)).toBe(payload)
    })
  }
  it.each(["gradient", "stripes", "noise"])("returns no payload for a %s image", (kind) => {
    const size = 160
    const pixels = new Uint8ClampedArray(size * size * 4)
    let random = 12345
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0
        const value = kind === "gradient" ? Math.round(x / size * 255)
          : kind === "stripes" ? (x % 16 < 8 ? 255 : 0) : random >>> 24
        pixels.set([value, kind === "gradient" ? 200 : value, value, 255], (y * size + x) * 4)
      }
    }
    expect(decodeQrImage(pixels, size, size)).toBeNull()
  })
  it("returns no payload for an empty frame", () => {
    expect(decodeQrImage(new Uint8ClampedArray(200 * 200 * 4), 200, 200)).toBeNull()
  })
})

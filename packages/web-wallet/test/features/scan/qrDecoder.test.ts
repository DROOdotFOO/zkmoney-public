import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createQrDecoder } from "../../../src/features/scan/qrDecoder"

class FakeWorker {
  static last: FakeWorker
  onmessage?: (event: { data: { text: string | null; error?: boolean } }) => void
  onerror?: (event: { preventDefault: () => void }) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    FakeWorker.last = this
  }
}
const frame = () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 } as ImageData)
beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("QR worker client", () => {
  it("transfers one frame buffer and permits another job only after the reply", async () => {
    const decoder = createQrDecoder()
    const image = frame()
    const job = decoder.decode(image)
    expect(FakeWorker.last.postMessage).toHaveBeenCalledWith(
      { data: image.data, width: 2, height: 2 },
      [image.data.buffer],
    )
    await expect(decoder.decode(frame())).rejects.toThrow("busy")
    FakeWorker.last.onmessage?.({ data: { text: "@alice" } })
    await expect(job).resolves.toBe("@alice")
    const next = decoder.decode(frame())
    FakeWorker.last.onmessage?.({ data: { text: null } })
    await expect(next).resolves.toBeNull()
    decoder.destroy()
  })
  it("rejects outstanding work on disposal and ignores a late reply", async () => {
    const decoder = createQrDecoder()
    const job = decoder.decode(frame())
    const rejected = expect(job).rejects.toThrow("stopped")
    decoder.destroy()
    FakeWorker.last.onmessage?.({ data: { text: "@alice" } })
    await rejected
    await expect(decoder.decode(frame())).rejects.toThrow("stopped")
    expect(FakeWorker.last.terminate).toHaveBeenCalled()
  })
  it("terminates a worker which never answers", async () => {
    const decoder = createQrDecoder()
    const rejected = expect(decoder.decode(frame())).rejects.toThrow("stopped")
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce()
  })
  it("handles failed worker loading without a global error", async () => {
    const decoder = createQrDecoder()
    const rejected = expect(decoder.decode(frame())).rejects.toThrow("stopped")
    const event = { preventDefault: vi.fn() }
    FakeWorker.last.onerror?.(event)
    await rejected
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce()
  })
})

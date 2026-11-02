import { describe, expect, it, vi } from "vitest"
import { createScanHandoff } from "../../../src/features/scan/scanHandoff"
import type { ScanResult } from "../../../src/features/scan/scanPayload"

function fixture() {
  let complete!: (result: ScanResult) => void
  const resolve = vi.fn(
    () =>
      new Promise<ScanResult>((yes) => {
        complete = yes
      }),
  )
  const options = {
    resolve,
    stopCamera: vi.fn(),
    onDestination: vi.fn(),
    onError: vi.fn(),
    onBusy: vi.fn(),
  }
  return {
    options,
    handoff: createScanHandoff(options),
    complete: (result: ScanResult) => complete(result),
  }
}
const valid: ScanResult = { kind: "destination", destination: { to: "/contacts/alice" } }

describe("scanner handoff", () => {
  it("latches camera and paste synchronously and routes only once", async () => {
    const f = fixture()
    const first = f.handoff.submit("@alice")
    await f.handoff.submit("@bob")
    expect(f.options.resolve).toHaveBeenCalledOnce()
    expect(f.options.stopCamera).toHaveBeenCalledOnce()
    f.complete(valid)
    await first
    await f.handoff.submit("@alice")
    expect(f.options.onDestination).toHaveBeenCalledOnce()
    expect(f.options.onDestination).toHaveBeenCalledWith({ to: "/contacts/alice" })
    expect(f.options.resolve).toHaveBeenCalledOnce()
  })
  it("latches before notifying callbacks that may submit again", async () => {
    const f = fixture()
    f.options.onBusy.mockImplementation((busy) => {
      if (!busy) void f.handoff.submit("@bob")
    })
    const first = f.handoff.submit("@alice")
    f.complete(valid)
    await first
    expect(f.options.resolve).toHaveBeenCalledOnce()
    expect(f.options.onDestination).toHaveBeenCalledOnce()
  })
  it("allows retry after invalid input", async () => {
    const f = fixture()
    const first = f.handoff.submit("invalid")
    f.complete({ kind: "error", message: "Invalid code" })
    await first
    expect(f.options.onError).toHaveBeenCalledWith("Invalid code")
    const retry = f.handoff.submit("@alice")
    f.complete(valid)
    await retry
    expect(f.options.onDestination).toHaveBeenCalledOnce()
  })
  it("ignores a pending result after close or Scan/Share switching", async () => {
    const f = fixture()
    const pending = f.handoff.submit("@alice")
    f.handoff.dispose()
    f.complete(valid)
    await pending
    await f.handoff.submit("@alice")
    expect(f.options.onDestination).not.toHaveBeenCalled()
    expect(f.options.onError).not.toHaveBeenCalled()
    expect(f.options.onBusy).not.toHaveBeenCalledWith(false)
    expect(f.options.resolve).toHaveBeenCalledOnce()
  })
})

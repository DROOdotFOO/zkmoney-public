import { afterEach, describe, expect, it, vi } from "vitest"
import { watchForFeature, watchForFreeze } from "../../../src/features/migration/freezeWatch"

const tuple = (portal: string) => ({ portal } as never)

describe("watchForFreeze", () => {
  afterEach(() => vi.useRealTimers())

  it("reports the first freeze once, then stops polling", async () => {
    vi.useFakeTimers()
    const isFrozen = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue(true)
    const onFrozen = vi.fn()
    watchForFreeze([tuple("0xa")], onFrozen, 1_000, isFrozen)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onFrozen).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onFrozen).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(isFrozen).toHaveBeenCalledTimes(3)
  })

  it("reports nothing after it is stopped", async () => {
    vi.useFakeTimers()
    const onFrozen = vi.fn()
    const stop = watchForFreeze([tuple("0xa")], onFrozen, 1_000, async () => true)
    stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onFrozen).not.toHaveBeenCalled()
  })
})

describe("watchForFeature", () => {
  afterEach(() => vi.useRealTimers())

  it("reads only the manifest on each poll, and probes again once a route appears", async () => {
    vi.useFakeTimers()
    const routed = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue(true)
    const onRoute = vi.fn()
    const stop = watchForFeature(routed, onRoute, 1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(routed).toHaveBeenCalledTimes(2)
    expect(onRoute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onRoute).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(routed).toHaveBeenCalledTimes(3)
    expect(onRoute).toHaveBeenCalledTimes(1)
  })

  it("skips a poll while the last read is in flight", async () => {
    vi.useFakeTimers()
    let finish!: (found: boolean) => void
    const routed = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)))
    const onRoute = vi.fn()
    const stop = watchForFeature(routed, onRoute, 1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(routed).toHaveBeenCalledTimes(1)
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onRoute).toHaveBeenCalledTimes(1)
    stop()
  })
})

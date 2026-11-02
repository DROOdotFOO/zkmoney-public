import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startResolverPaymentLoop } from "../../../src/features/deposit/useSipaDeposits"

/** A page whose visibility the test flips. */
function page(initiallyShown: boolean) {
  let handlers: { onShow?: () => void; onHide?: () => void } = {}
  const visibility = vi.fn((h: typeof handlers) => {
    handlers = h
    ;(initiallyShown ? h.onShow : h.onHide)?.()
    return () => {
      handlers = {}
    }
  })
  return {
    visibility,
    show: () => handlers.onShow?.(),
    hide: () => handlers.onHide?.(),
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("startResolverPaymentLoop", () => {
  it("ticks at once, then on the delay each tick returns", async () => {
    const tick = vi.fn(async () => 12_000)
    const { visibility } = page(true)
    const stop = startResolverPaymentLoop({ tick }, visibility)
    await flush()
    expect(tick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(11_999)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it("reads nothing while the page is hidden and ticks as soon as it is shown", async () => {
    const tick = vi.fn(async () => 12_000)
    const { visibility, show, hide } = page(false)
    const stop = startResolverPaymentLoop({ tick }, visibility)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).not.toHaveBeenCalled()

    show()
    await flush()
    expect(tick).toHaveBeenCalledTimes(1)

    hide()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it("runs one tick at a time when the page is shown mid-tick", async () => {
    let finish: (delay: number) => void = () => {}
    const tick = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)))
    const { visibility, show } = page(true)
    const stop = startResolverPaymentLoop({ tick }, visibility)
    show()
    show()
    expect(tick).toHaveBeenCalledTimes(1)
    finish(12_000)
    await flush()
    stop()
  })

  it("schedules nothing after a tick that finishes once the page is hidden", async () => {
    let finish: (delay: number) => void = () => {}
    const tick = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)))
    const { visibility, hide } = page(true)
    const stop = startResolverPaymentLoop({ tick }, visibility)
    hide()
    finish(12_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it("stops for good", async () => {
    const tick = vi.fn(async () => 12_000)
    const { visibility, show } = page(true)
    const stop = startResolverPaymentLoop({ tick }, visibility)
    await flush()
    stop()
    show()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})

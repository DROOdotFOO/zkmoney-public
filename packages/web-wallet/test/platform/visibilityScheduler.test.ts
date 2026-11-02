import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pauseWhenHidden, whenVisibilityChanges } from "../../src/platform/visibilityScheduler"

let visibility: DocumentVisibilityState = "visible"

function show(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("pauseWhenHidden", () => {
  it("stops ticking while hidden and catches up on return", () => {
    const tick = vi.fn()
    const handle = pauseWhenHidden.setInterval(tick, 1000)

    vi.advanceTimersByTime(3000)
    expect(tick).toHaveBeenCalledTimes(3)

    show("hidden")
    vi.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(3)

    // Returning reads once immediately, before the cadence resumes.
    show("visible")
    expect(tick).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(1000)
    expect(tick).toHaveBeenCalledTimes(5)

    pauseWhenHidden.clearInterval(handle)
    vi.advanceTimersByTime(5000)
    expect(tick).toHaveBeenCalledTimes(5)
  })
})

describe("whenVisibilityChanges", () => {
  it("reports the current state up front, then every change", () => {
    const onShow = vi.fn()
    const onHide = vi.fn()
    const stop = whenVisibilityChanges({ onShow, onHide })

    expect(onShow).toHaveBeenCalledTimes(1)
    expect(onHide).not.toHaveBeenCalled()

    show("hidden")
    expect(onHide).toHaveBeenCalledTimes(1)
    show("visible")
    expect(onShow).toHaveBeenCalledTimes(2)

    stop()
    show("hidden")
    expect(onHide).toHaveBeenCalledTimes(1)
  })
})

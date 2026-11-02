import { afterEach, describe, expect, it, vi } from "vitest"
import { createClock } from "../../src/engine/clock"
import type { SipaProcessingSource } from "../../src/core/services/bridge/BridgeActivityFeed"
import { processingStates, legacyRecords } from "../../src/engine/recordSource"
import { memoryStore } from "../../src/engine/store"

afterEach(() => vi.useRealTimers())

describe("createClock", () => {
  it("ticks on the period while read, and stops once nothing reads it", () => {
    vi.useFakeTimers({ now: 1_000 })
    const clock = createClock(1_000)
    const seen: number[] = []
    const off = clock.subscribe(() => seen.push(clock.get()))
    vi.advanceTimersByTime(2_500)
    expect(seen).toEqual([2_000, 3_000])
    off()
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([2_000, 3_000])
    expect(clock.get()).toBe(8_000)
  })
})

describe("legacyRecords", () => {
  it("mirrors the source and hydrates once its load settles, failed or not", async () => {
    let listener: (records: number[]) => void = () => {}
    const store = legacyRecords({
      list: () => [1],
      load: () => Promise.reject(new Error("locked")),
      onListChanged: (l) => ((listener = l), () => {}),
    })
    expect(store.get()).toEqual({ records: [1], hydrated: false })
    listener([1, 2])
    expect(store.get().records).toEqual([1, 2])
    await Promise.resolve()
    await Promise.resolve()
    expect(store.get()).toEqual({ records: [1], hydrated: true })
  })
})

describe("processingStates", () => {
  const waiting = { reason: { kind: "checking" } }
  const deposits = () =>
    memoryStore({ records: [{ sipaAddress: "0xAA" }] as never[], hydrated: true })

  it("lists nothing without an observer", () => {
    expect(processingStates(deposits().readonly, undefined).get().size).toBe(0)
  })

  it("reads the source again on each change it signals, and stops listening once unwatched", () => {
    let state: unknown
    const listeners = new Set<() => void>()
    const observer: SipaProcessingSource = {
      stateFor: () => state as never,
      subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    }
    const states = processingStates(deposits().readonly, observer)
    state = waiting
    const off = states.subscribe(() => {})
    expect(states.get().get("0xaa")).toBe(waiting)
    state = undefined
    listeners.forEach((l) => l())
    expect(states.get().size).toBe(0)
    off()
    expect(listeners.size).toBe(0)
  })
})

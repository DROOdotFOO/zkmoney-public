import { memoryStore, type ReadonlyStore } from "./store"

/**
 * Wall time in ms, floored to `periodMs` and ticking only while something reads it, so selectors
 * take `now` as an input instead of running timers of their own. A reading lags by at most one
 * period.
 */
export function createClock(periodMs: number, now: () => number = Date.now): ReadonlyStore<number> {
  const at = () => Math.floor(now() / periodMs) * periodMs
  const store = memoryStore(at())
  let readers = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    store.set(at())
    timer = setTimeout(tick, periodMs - (now() % periodMs))
  }
  return {
    get() {
      if (readers === 0) store.set(at())
      return store.get()
    },
    subscribe(listener) {
      const off = store.subscribe(listener)
      if (readers++ === 0) tick()
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--readers === 0) clearTimeout(timer)
      }
    },
  }
}

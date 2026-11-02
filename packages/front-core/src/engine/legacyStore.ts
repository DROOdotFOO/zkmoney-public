import { memoryStore, type ReadonlyStore } from "./store"

/** A source that is not a store: a read, and a signal that the next read would differ. */
export interface StoreSource<T> {
  read(): T | Promise<T>
  subscribe(onChange: () => void): () => void
}

/** A source's last read; `loaded` once a read landed. */
export interface Sourced<T> {
  loaded: boolean
  value: T
}

/** A failed read keeps the last value and still surfaces. */
const surface = (err: unknown) =>
  queueMicrotask(() => {
    throw err
  })

/**
 * A source as a store. While watched it subscribes, then reads, and reads again on every change; the
 * latest read wins. Each first subscriber reads afresh, so nothing written while unwatched is missed.
 */
export function legacyStore<T>(source: StoreSource<T>, initial: T): ReadonlyStore<Sourced<T>> {
  const state = memoryStore<Sourced<T>>({ loaded: false, value: initial })
  let watchers = 0
  let reads = 0
  let unwatch = () => {}
  const read = () => {
    const seq = ++reads
    const land = (value: T) => {
      if (seq === reads) state.set({ loaded: true, value })
    }
    try {
      const result = source.read()
      if (result instanceof Promise) result.then(land, surface)
      else land(result)
    } catch (err) {
      surface(err)
    }
  }
  return {
    get: state.get,
    subscribe(listener) {
      const off = state.subscribe(listener)
      if (watchers++ === 0) {
        unwatch = source.subscribe(read)
        read()
      }
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--watchers === 0) unwatch()
      }
    },
  }
}

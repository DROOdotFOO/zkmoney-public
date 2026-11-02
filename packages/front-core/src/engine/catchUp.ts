import { memoryStore, type ReadonlyStore } from "./store"

export interface CatchUp {
  /** True while any chain scan rebuilds history: a fresh device, a PXE rebuild, or a cursor far behind head. */
  readonly status: ReadonlyStore<boolean>
  /** Holds the flag for one pass; the returned `end` is idempotent. */
  begin(): () => void
}

export function createCatchUp(): CatchUp {
  const store = memoryStore(false)
  let holders = 0
  return {
    status: store.readonly,
    begin() {
      holders++
      store.set(true)
      let ended = false
      return () => {
        if (ended) return
        ended = true
        if (--holders === 0) store.set(false)
      }
    },
  }
}

export const syncCatchUp = createCatchUp()

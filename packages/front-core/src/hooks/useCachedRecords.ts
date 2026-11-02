import { useEffect, useState } from "react"

/**
 * The read surface every `RecordStorage`-backed domain store already exposes
 * (`SIPADepositStore`, `SavingsMoveStorage`, ...). `load()` must be memoized by
 * the store so repeat calls are free.
 */
export interface CachedRecordSource<T> {
  load(): Promise<void>
  list(): T[]
  onListChanged(listener: (records: T[]) => void): () => void
}

/**
 * Cache-first read over a persisted record store: renders whatever the store
 * holds right now (the last known good state), kicks hydration from storage,
 * and re-renders as live writers (sync loops, chain trackers) overwrite
 * records. `hydrated` separates "still reading the cache" from "genuinely
 * empty", so screens can show a loading placeholder instead of a wrong empty
 * state. A failed load still flips `hydrated` — an empty list beats a
 * placeholder that never resolves.
 */
export function useCachedRecords<T>(source: CachedRecordSource<T>): {
  records: T[]
  hydrated: boolean
} {
  const [records, setRecords] = useState<T[]>(() => source.list())
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = source.onListChanged(setRecords)
    setRecords(source.list())
    void source
      .load()
      .catch(() => {})
      .then(() => {
        if (cancelled) return
        setRecords(source.list())
        setHydrated(true)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [source])

  return { records, hydrated }
}

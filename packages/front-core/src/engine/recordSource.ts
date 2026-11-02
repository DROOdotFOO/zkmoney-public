import type { SipaProcessingSource } from "../core/services/bridge/BridgeActivityFeed"
import type { SipaProcessingState } from "../core/services/deposits/sipaProcessing"
import type { SIPADepositRecord } from "../core/services/deposits/SIPADepositStore"
import { memoryStore, derived, type ReadonlyStore } from "./store"
import { legacyStore, type Sourced } from "./legacyStore"

/** The read surface of a `RecordStorage`-backed store not yet moved onto a persistent store. */
export interface RecordSource<T> {
  load(): Promise<void>
  list(): T[]
  onListChanged(listener: (records: T[]) => void): () => void
}

export interface Loaded<T> {
  records: readonly T[]
  /** The first load settled, so an empty list is known to be empty. A failed load counts. */
  hydrated: boolean
}

/** A record source as a store: it mirrors the list from now on and starts the source's load. */
export function legacyRecords<T>(source: RecordSource<T>): ReadonlyStore<Loaded<T>> {
  const store = memoryStore<Loaded<T>>({ records: source.list(), hydrated: false })
  source.onListChanged((records) => store.update((s) => ({ ...s, records })))
  const hydrate = () => store.set({ records: source.list(), hydrated: true })
  void source.load().then(hydrate, hydrate)
  return store.readonly
}

const IDLE: ReadonlyStore<Sourced<SipaProcessingSource | undefined>> = memoryStore({
  loaded: false,
  value: undefined,
}).readonly

/** Why each deposit waiting for its sweep waits, by lowercase address, read again on each change. */
export function processingStates(
  deposits: ReadonlyStore<Loaded<SIPADepositRecord>>,
  observer: SipaProcessingSource | undefined,
): ReadonlyStore<ReadonlyMap<string, SipaProcessingState>> {
  const live = observer
    ? legacyStore({ read: () => observer, subscribe: (l) => observer.subscribe(l) }, observer)
    : IDLE
  return derived([deposits, live] as const, ({ records }, { value: observer }) => {
    const states = new Map<string, SipaProcessingState>()
    for (const { sipaAddress } of records) {
      const state = observer?.stateFor(sipaAddress)
      if (state) states.set(sipaAddress.toLowerCase(), state)
    }
    return states
  })
}

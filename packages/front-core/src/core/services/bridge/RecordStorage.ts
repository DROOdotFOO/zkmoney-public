/**
 * RecordStorage — Generic persistence + subscription kernel for domain stores.
 *
 * Extracted from the (since-removed) legacy bridge stores so every domain
 * store — today `SIPADepositStore` — shares one implementation of:
 *   - lazy load-from-storage with shared promise to prevent double-load
 *   - single-key persistence as a JSON object keyed by the record's
 *     caller-chosen string key
 *   - per-record `onUpdated` listeners and full-list `onListChanged` listeners
 *     with error isolation so one bad listener can't kill the loop
 *   - atomic rekey for domains whose canonical key changes over a record's
 *     lifecycle
 *
 * Domain-specific concerns (terminal-phase `endTime` stamping, merge-with-fallback
 * semantics, key normalization like `toLowerCase()`, TTL/revival logic) stay on
 * the domain store; this kernel knows nothing about phases or records beyond
 * the `keyOf` function caller supplies.
 */

import type { IStorageAdapter } from "../../storages/adapter"
import { logger } from "../../../utils/logger"

export interface RecordStorageOptions<TRecord> {
  storage: IStorageAdapter
  storageKey: string
  /** Derive the persistence key from a record. Caller normalizes (e.g. lowercase). */
  keyOf: (record: TRecord) => string
  /** Optional: compute a sort value (higher first) for `list()`. Default: insertion order. */
  sortBy?: (record: TRecord) => number
  /** Label used in console warnings. Defaults to "RecordStorage". */
  label?: string
  /**
   * Optional: rewrite each record as it comes off storage, given its key — e.g. drop keys the schema
   * no longer has. A throw drops the record; a store that retries its loads rejects the load.
   */
  normalize?: (record: TRecord, key: string) => TRecord
  /**
   * When true, a failed storage write rejects the mutation instead of warn-and-swallow.
   * For stores whose callers must know a record durably exists before acting on it.
   */
  strict?: boolean
  /**
   * When true, a storage read that throws, saved text that does not parse, or a record `normalize`
   * rejects does not count as loaded: the next `load()` retries and merges what it reads under
   * records written meanwhile. For stores behind a key that can be locked, where an empty load
   * followed by a write would replace the saved records. A successful write over a blob that still
   * cannot be read counts as loaded, so an unreadable blob is replaced once.
   */
  retryLoadOnReadError?: boolean
}

/** An error by name only: a message may quote a record. */
const describe = (err: unknown) => (err instanceof Error ? err.name : typeof err)

type UpdatedListener<TRecord> = (record: TRecord) => void
type ListChangedListener<TRecord> = (records: TRecord[]) => void

export class RecordStorage<TRecord> {
  private storage: IStorageAdapter
  private storageKey: string
  private keyOf: (record: TRecord) => string
  private sortBy?: (record: TRecord) => number
  private label: string
  private strict: boolean
  private normalize?: (record: TRecord, key: string) => TRecord
  private retryLoadOnReadError: boolean

  private records = new Map<string, TRecord>()
  /** What storage holds, as of the last read or successful write; a rejected strict write returns its key to this. */
  private committed = new Map<string, TRecord>()
  private loaded = false
  private loadPromise: Promise<void> | null = null

  /**
   * Serializes `persist()` calls so concurrent writers (resumeAll fan-out,
   * tick's applyJobStatus) can't interleave their
   * JSON.stringify → setItem round trips. Each mutation chains onto the
   * previous one via this promise; failures are caught inside `persist()`
   * so one bad write doesn't poison the chain.
   */
  private persistChain: Promise<void> = Promise.resolve()

  private updatedListeners = new Set<UpdatedListener<TRecord>>()
  private listChangedListeners = new Set<ListChangedListener<TRecord>>()

  constructor(options: RecordStorageOptions<TRecord>) {
    this.storage = options.storage
    this.storageKey = options.storageKey
    this.keyOf = options.keyOf
    this.sortBy = options.sortBy
    this.label = options.label ?? "RecordStorage"
    this.strict = options.strict ?? false
    this.normalize = options.normalize
    this.retryLoadOnReadError = options.retryLoadOnReadError ?? false
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      // Only a store with retryable loads can hold records here: ones written while it could not load.
      let rewritten = this.records.size > 0
      let raw: string | null
      try {
        raw = await this.storage.getItem(this.storageKey)
      } catch (err) {
        logger.warn(`[${this.label}] Failed to read from storage: ${describe(err)}`)
        if (this.retryLoadOnReadError) {
          this.loadPromise = null
          return
        }
        raw = null
      }
      try {
        // Empty text is a damaged blob, not an absent one.
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("not a record map")
          // Every saved row is checked before any reaches memory: a rejected load leaves nothing
          // behind for the retry to mistake for a newer write.
          const loaded = new Map<string, TRecord>()
          for (const [k, record] of Object.entries(parsed as Record<string, TRecord>)) {
            let next: TRecord
            try {
              next = this.normalize ? this.normalize(record, k) : record
            } catch (err) {
              if (this.retryLoadOnReadError) throw err
              logger.warn(`[${this.label}] Dropped record ${k}: ${describe(err)}`)
              rewritten = true
              continue
            }
            if (JSON.stringify(next) !== JSON.stringify(record)) rewritten = true
            loaded.set(k, next)
          }
          for (const [k, next] of loaded) {
            // A record written while the store could not load is newer than the persisted copy.
            if (!this.records.has(k)) this.records.set(k, next)
          }
        }
      } catch {
        // The error is not logged: a parse error quotes the saved text.
        logger.warn(`[${this.label}] Saved records do not parse`)
        if (this.retryLoadOnReadError) {
          this.loadPromise = null
          return
        }
      }
      this.loaded = true
      this.committed = new Map(this.records)
      // `normalize` rewrites memory only. Without this write-back the stale at-rest copy — the keys
      // a normalizer exists to drop — survives until some unrelated mutation happens to rewrite it.
      // Best-effort: a store that cannot persist here still serves the normalized records.
      if (rewritten) await this.persist().catch(() => {})
    })()

    await this.loadPromise
    if (!this.loaded) return
    // Emit listChanged once after the initial load so subscribers that ran
    // `store.list()` before load completed can pick up the real state
    // without waiting for the next write.
    this.emitListChanged()
  }

  /** Whether a read of storage has landed; false while a store that retries its loads cannot read. */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Replaces the in-memory records with what storage holds now, e.g. after another tab wrote. */
  async reload(): Promise<void> {
    if (this.loadPromise && !this.loaded) return this.loadPromise
    this.loaded = false
    this.loadPromise = null
    this.records.clear()
    return this.load()
  }

  /**
   * Serialize the JSON write via persistChain so concurrent callers can't
   * interleave setItem calls (which would last-write-win against each other).
   */
  private persist(strict: boolean = this.strict): Promise<void> {
    const next = this.persistChain.catch(() => {}).then(() => this.doPersist(strict))
    this.persistChain = next
    return next
  }

  private async doPersist(strict: boolean): Promise<void> {
    // What this write serializes is what storage holds once it lands, whatever lands in memory
    // while the write is in flight.
    const snapshot = new Map(this.records)
    const obj: Record<string, TRecord> = {}
    for (const [k, record] of snapshot.entries()) {
      obj[k] = record
    }
    try {
      await this.storage.setItem(this.storageKey, JSON.stringify(obj))
      this.committed = snapshot
      // The write replaced a blob that could not be read, so there is nothing left to load.
      if (!this.loaded && this.retryLoadOnReadError) this.loaded = true
    } catch (err) {
      logger.warn(`[${this.label}] Failed to persist: ${describe(err)}`)
      if (strict) throw err
    }
  }

  // ============================================================================
  // Reads
  // ============================================================================

  getByKey(key: string): TRecord | null {
    return this.records.get(key) ?? null
  }

  /** Stored key-record pairs, for dropping an entry whose key cannot be derived from its contents. */
  entries(): [string, TRecord][] {
    return Array.from(this.records.entries())
  }

  list(): TRecord[] {
    const arr = Array.from(this.records.values())
    if (this.sortBy) {
      const sortBy = this.sortBy
      arr.sort((a, b) => sortBy(b) - sortBy(a))
    }
    return arr
  }

  // ============================================================================
  // Writes
  // ============================================================================

  /**
   * Insert or replace the record at `key`. The caller owns any merge / fallback
   * semantics and any terminal-phase stamping; this kernel just stores what it
   * is given. `strict` makes this one write reject on a storage failure in a store that is not.
   */
  async setRecord(key: string, record: TRecord, opts?: { strict?: boolean }): Promise<TRecord> {
    await this.load()
    this.records.set(key, record)
    try {
      await this.persist(opts?.strict || this.strict)
    } catch (err) {
      this.rollback(key, record)
      throw err
    }
    this.emitUpdated(record)
    this.emitListChanged()
    return record
  }

  /**
   * Read-modify-write the record at `key` with no await between the read and the write, so two
   * concurrent updates both land. `update` returns `null` to leave the record as it is. A loaded
   * store applies it before the call returns, so a caller's read just before calling is still
   * current.
   */
  async updateRecord(
    key: string,
    update: (current: TRecord | null) => TRecord | null,
    opts?: { strict?: boolean },
  ): Promise<TRecord | null> {
    if (!this.loaded) await this.load()
    const current = this.records.get(key) ?? null
    const next = update(current)
    if (!next) return current
    this.records.set(key, next)
    try {
      await this.persist(opts?.strict || this.strict)
    } catch (err) {
      this.rollback(key, next)
      throw err
    }
    this.emitUpdated(next)
    this.emitListChanged()
    return next
  }

  /**
   * A rejected strict write leaves no trace of its own: the key returns to what storage holds. A
   * newer write that landed in memory meanwhile stands, and its own persist decides its fate.
   */
  private rollback(key: string, written: TRecord): void {
    if (this.records.get(key) !== written) return
    const committed = this.committed.get(key)
    if (committed === undefined) this.records.delete(key)
    else this.records.set(key, committed)
  }

  /**
   * Move a record from `oldKey` to `newKey` and replace its contents with
   * `record`. Used when the canonical key of a record changes over its
   * lifecycle. If `oldKey === newKey` this behaves like `setRecord`.
   */
  async rekey(oldKey: string, newKey: string, record: TRecord): Promise<TRecord> {
    await this.load()
    if (oldKey !== newKey) {
      this.records.delete(oldKey)
    }
    this.records.set(newKey, record)
    await this.persist()
    this.emitUpdated(record)
    this.emitListChanged()
    return record
  }

  async removeByKey(key: string): Promise<void> {
    await this.removeByKeyIf(key, () => true)
  }

  /**
   * Drops the record at `key` only while the stored record still passes `when`, checked with no
   * await before the delete. Resolves to whether a record was removed.
   */
  async removeByKeyIf(key: string, when: (current: TRecord) => boolean): Promise<boolean> {
    await this.load()
    const current = this.records.get(key)
    if (current === undefined || !when(current)) return false
    this.records.delete(key)
    try {
      await this.persist()
    } catch (err) {
      // A rejected strict removal leaves no trace: the key returns to what storage holds, unless a
      // newer write took it meanwhile.
      const committed = this.committed.get(key)
      if (committed !== undefined && !this.records.has(key)) this.records.set(key, committed)
      throw err
    }
    this.emitListChanged()
    return true
  }

  async clearAll(): Promise<void> {
    this.records.clear()
    await this.storage.removeItem(this.storageKey)
    this.emitListChanged()
  }

  async replaceAll(records: TRecord[]): Promise<TRecord[]> {
    await this.load()
    this.records.clear()
    for (const record of records) {
      this.records.set(this.keyOf(record), record)
    }
    await this.persist()
    for (const record of records) {
      this.emitUpdated(record)
    }
    this.emitListChanged()
    return records
  }

  async normalizeKeys(
    mergeRecords?: (existing: TRecord, incoming: TRecord) => TRecord,
  ): Promise<TRecord[]> {
    await this.load()

    let changed = false
    const nextRecords = new Map<string, TRecord>()

    for (const [currentKey, record] of this.records.entries()) {
      const derivedKey = this.keyOf(record)
      if (currentKey !== derivedKey) {
        changed = true
      }

      const existing = nextRecords.get(derivedKey)
      if (existing) {
        changed = true
        nextRecords.set(derivedKey, mergeRecords ? mergeRecords(existing, record) : record)
      } else {
        nextRecords.set(derivedKey, record)
      }
    }

    if (!changed) {
      return this.list()
    }

    this.records = nextRecords
    await this.persist()
    this.emitListChanged()
    return this.list()
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  onUpdated(listener: UpdatedListener<TRecord>): () => void {
    this.updatedListeners.add(listener)
    return () => {
      this.updatedListeners.delete(listener)
    }
  }

  onListChanged(listener: ListChangedListener<TRecord>): () => void {
    this.listChangedListeners.add(listener)
    return () => {
      this.listChangedListeners.delete(listener)
    }
  }

  private emitUpdated(record: TRecord): void {
    for (const listener of this.updatedListeners) {
      try {
        listener(record)
      } catch (err) {
        logger.warn(`[${this.label}] updated listener error:`, err)
      }
    }
  }

  private emitListChanged(): void {
    const snapshot = this.list()
    for (const listener of this.listChangedListeners) {
      try {
        listener(snapshot)
      } catch (err) {
        logger.warn(`[${this.label}] listChanged listener error:`, err)
      }
    }
  }

  /**
   * Suppress `keyOf` lint warnings for kernels that never invoke it
   * (subclasses that always pass the key explicitly via setRecord/rekey).
   * Exposed for the niche case where a caller wants to re-derive the key
   * from a record.
   */
  protected deriveKey(record: TRecord): string {
    return this.keyOf(record)
  }
}

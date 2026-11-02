/**
 * Default `IPendingTxStore` implementation backed by a `Map`.
 *
 * Used when no persistent store is injected — tests, web/Node consumers,
 * admin paths. Same passive-eviction semantics and same `isExpired` formula
 * as the encrypted persistent variant (`PendingTxStore` in front-core):
 * records past the TTL ceiling are marked-not-deleted; `list()` and `get()`
 * filter them out; `listExpired()` exposes them.
 */

import type {
  IPendingTxStore,
  PendingTxListListener,
  PendingTxStoreListener,
} from "./IPendingTxStore.js"
import type { PendingTxRecord } from "./types.js"
import { CLOCK_SKEW_MARGIN_MS, MAX_TX_LIFETIME_MS } from "./types.js"

export class InMemoryPendingTxStore implements IPendingTxStore {
  private readonly records = new Map<string, PendingTxRecord>()
  private readonly listeners = new Set<PendingTxStoreListener>()
  private readonly listListeners = new Set<PendingTxListListener>()

  async load(): Promise<void> {
    // No-op — fresh state per instance, data lost on restart by design.
  }

  async create(record: PendingTxRecord): Promise<void> {
    this.records.set(record.txHash, record)
    this.notify(record.txHash)
  }

  async get(txHash: string): Promise<PendingTxRecord | undefined> {
    const record = this.records.get(txHash)
    if (record === undefined) return undefined
    if (this.isExpired(record)) return undefined
    return record
  }

  async list(): Promise<readonly PendingTxRecord[]> {
    const out: PendingTxRecord[] = []
    for (const record of this.records.values()) {
      if (!this.isExpired(record)) out.push(record)
    }
    return out
  }

  async listExpired(): Promise<readonly PendingTxRecord[]> {
    const out: PendingTxRecord[] = []
    for (const record of this.records.values()) {
      if (this.isExpired(record)) out.push(record)
    }
    return out
  }

  async patch(
    txHash: string,
    fields: Partial<Omit<PendingTxRecord, "txHash">>,
  ): Promise<boolean> {
    const existing = this.records.get(txHash)
    if (existing === undefined) return false
    this.records.set(txHash, { ...existing, ...fields })
    this.notify(txHash)
    return true
  }

  async remove(txHash: string): Promise<void> {
    if (this.records.delete(txHash)) {
      this.notify(txHash)
    }
  }

  async removeExpired(txHash: string): Promise<void> {
    const record = this.records.get(txHash)
    if (record === undefined) return
    if (!this.isExpired(record)) {
      throw new Error(
        `InMemoryPendingTxStore.removeExpired: record ${txHash} is not expired (defense-in-depth)`,
      )
    }
    this.records.delete(txHash)
    this.notify(txHash)
  }

  async clearAll(): Promise<void> {
    if (this.records.size === 0) return
    this.records.clear()
    this.notifyList()
  }

  onUpdated(listener: PendingTxStoreListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onListChanged(listener: PendingTxListListener): () => void {
    this.listListeners.add(listener)
    return () => this.listListeners.delete(listener)
  }

  private notify(txHash: string): void {
    for (const listener of this.listeners) {
      try {
        listener(txHash)
      } catch (err) {
        // Swallow listener errors — one bad subscriber must not break the
        // service. Log at warn level.
        // eslint-disable-next-line no-console
        console.warn("[InMemoryPendingTxStore] listener threw:", err)
      }
    }
    this.notifyList()
  }

  private notifyList(): void {
    if (this.listListeners.size === 0) return
    const live: PendingTxRecord[] = []
    for (const record of this.records.values()) {
      if (!this.isExpired(record)) live.push(record)
    }
    for (const listener of this.listListeners) {
      try {
        listener(live)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[InMemoryPendingTxStore] list listener threw:", err)
      }
    }
  }

  /**
   * TTL formula — must match `PendingTxStore` in front-core:
   *   ttl_anchor = min(record.expiresAtMs, record.submittedAt + MAX_TX_LIFETIME_MS)
   *   expired-at-now <=> Date.now() > ttl_anchor + CLOCK_SKEW_MARGIN_MS
   */
  private isExpired(record: PendingTxRecord): boolean {
    const ttlAnchor = Math.min(
      record.expiresAtMs,
      record.submittedAt + MAX_TX_LIFETIME_MS,
    )
    return Date.now() > ttlAnchor + CLOCK_SKEW_MARGIN_MS
  }
}

/**
 * SDK-side `IPendingTxStore` interface — the contract the wallet sees.
 *
 * Implementations:
 *   - `InMemoryPendingTxStore` (default, in this package) — Map-backed, no
 *     encryption, no persistence. Used by tests, web/Node, and any callsite
 *     that doesn't inject a persistent store.
 *   - `PendingTxStore` (in `@obsidion/front-core`) — encrypted on-disk
 *     persistent variant, injected at construction.
 *
 * Design note: the wallet imports only this interface (and `PendingTxRecord`
 * from `./types`); it never imports front-core. SDK→front-core layering is
 * preserved through interface symmetry.
 */

import type { PendingTxRecord } from "./types.js"

/**
 * Listener fired on every successful write to the store (`create`, `patch`,
 * `remove`, `removeExpired`). The argument is the txHash that changed; the
 * subscriber re-reads via `get(txHash)` if it needs the current record.
 */
export type PendingTxStoreListener = (txHash: string) => void

/**
 * Listener fired with a fresh non-expired list snapshot on every change.
 * Convenience for UI hooks that want a list view without re-querying via
 * `list()` on every per-record event.
 */
export type PendingTxListListener = (records: readonly PendingTxRecord[]) => void

export interface IPendingTxStore {
  /**
   * Lifecycle: load persisted state. In-memory implementations are no-ops;
   * persistent implementations rehydrate from disk and silently drop records
   * that fail to decode (key rotation, fresh install, format drift).
   */
  load(): Promise<void>

  /** Persist a fresh record. Called from inside `wallet.sendTx` adjacent to `node.sendTx`. */
  create(record: PendingTxRecord): Promise<void>

  /** Read a single record by tx hash; returns `undefined` if absent OR expired. */
  get(txHash: string): Promise<PendingTxRecord | undefined>

  /** List all non-expired records. */
  list(): Promise<readonly PendingTxRecord[]>

  /** List records past `expiresAtMs`. */
  listExpired(): Promise<readonly PendingTxRecord[]>

  /** Patch a subset of fields on an existing record. Returns true if patched. */
  patch(
    txHash: string,
    fields: Partial<Omit<PendingTxRecord, "txHash">>,
  ): Promise<boolean>

  /** Remove a record on terminal evidence, or undo one the wallet's `sendTx` catch path wrote. */
  remove(txHash: string): Promise<void>

  /**
   * Atomic counterpart to `remove` for the expiry sweep — separates the
   * "actively expired" delete from the "terminal evidence observed" delete
   * for instrumentation clarity.
   */
  removeExpired(txHash: string): Promise<void>

  /** Wipe every record. Test/admin convenience; not part of the lifecycle. */
  clearAll(): Promise<void>

  /** Subscribe to per-record updates. Returns the unsubscribe function. */
  onUpdated(listener: PendingTxStoreListener): () => void

  /** Subscribe to non-expired list changes. Returns the unsubscribe function. */
  onListChanged(listener: PendingTxListListener): () => void
}

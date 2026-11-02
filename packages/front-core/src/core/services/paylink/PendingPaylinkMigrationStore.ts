/**
 * PendingPaylinkMigrationStore — creator paylinks left behind on a retired oxide deployment because
 * the migration ran while their claim window was open. The contract only refunds outside the
 * window, so these wait here until chain time passes `untilClaimable`. The create row in
 * The activity store stays the source of truth; every field here re-derives from it on reconcile.
 */

import type { IStorageAdapter } from "../../storages/adapter"
import type { PaylinkTransaction } from "../../../types/transactions"
import { RecordStorage } from "../bridge/RecordStorage"

export type PendingPaylinkMigrationStatus = "waiting" | "claimable" | "resolved"

export interface PendingPaylinkMigrationRecord {
  /** Create-row txHash; the key and the join back to the activity row. */
  txHash: string
  /** Unix seconds the claim window closes — refund is possible after this. */
  untilClaimable: number
  /** Historic l2Token the escrow sits on, when the row carries it. */
  tokenAddress?: string
  /** Network the escrow lives on (rollup L1 address); reconcile only judges records of the active one. */
  networkId?: string
  flavor: PaylinkTransaction["flavor"]
  status: PendingPaylinkMigrationStatus
  /** Why the record settled without a reclaim: the escrow was spent, or the row lost its refund material. */
  resolvedReason?: "claimed" | "refunded" | "migrated" | "unavailable"
  detectedAtMs: number
  updatedAtMs: number
}

export const PENDING_PAYLINK_MIGRATION_STORAGE_KEY = "@obsidion/paylink-migration/pending"

export class PendingPaylinkMigrationStore {
  private static instance: PendingPaylinkMigrationStore | null = null
  private store: RecordStorage<PendingPaylinkMigrationRecord>

  constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<PendingPaylinkMigrationRecord>({
      storage,
      storageKey: PENDING_PAYLINK_MIGRATION_STORAGE_KEY,
      keyOf: (r) => r.txHash.toLowerCase(),
      sortBy: (r) => r.untilClaimable,
      label: "PendingPaylinkMigrationStore",
    })
  }

  static get(storage?: IStorageAdapter): PendingPaylinkMigrationStore {
    if (!PendingPaylinkMigrationStore.instance) {
      if (!storage) {
        throw new Error(
          "First call to PendingPaylinkMigrationStore.get() requires a storage adapter",
        )
      }
      PendingPaylinkMigrationStore.instance = new PendingPaylinkMigrationStore(storage)
    }
    return PendingPaylinkMigrationStore.instance
  }

  static resetForTests(): void {
    PendingPaylinkMigrationStore.instance = null
  }

  async load(): Promise<void> {
    return this.store.load()
  }

  get(txHash: string): PendingPaylinkMigrationRecord | null {
    return this.store.getByKey(txHash.toLowerCase())
  }

  list(): PendingPaylinkMigrationRecord[] {
    return this.store.list()
  }

  async set(record: PendingPaylinkMigrationRecord): Promise<PendingPaylinkMigrationRecord> {
    await this.store.load()
    return this.store.setRecord(record.txHash.toLowerCase(), record)
  }

  async remove(txHash: string): Promise<void> {
    await this.store.removeByKey(txHash.toLowerCase())
  }

  async clearAll(): Promise<void> {
    await this.store.clearAll()
  }

  onListChanged(listener: (records: PendingPaylinkMigrationRecord[]) => void): () => void {
    return this.store.onListChanged(listener)
  }
}

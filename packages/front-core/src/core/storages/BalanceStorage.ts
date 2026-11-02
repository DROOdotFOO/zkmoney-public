import type { IStorageAdapter } from "./adapter"
import { RecordStorage } from "../services/bridge/RecordStorage"
import { BALANCE_STORAGE_KEY } from "./constants"
import { logger } from "../../utils/logger"

/**
 * One cached balance. `scope` is `balanceScope(network, accountCompleteAddress)`, so a cached
 * value can never surface for a different network or account than the one that fetched it — the
 * reset flow that clears stale contract state is user-confirmation-gated, so cold-start hydration
 * cannot rely on it having run.
 */
export interface BalanceRecord {
  scope: string
  tokenAddress: string
  /** Raw token units, JSON-safe bigint. */
  balance: string
  /** PXE anchor the balance was read at; unset on rows written before the field existed. */
  anchorBlock?: number
  /** Wall-clock ms of the write; lets a session tell a live read from a cache-hydrated row. */
  updatedAt?: number
  /** Wall-clock ms the read resolved; a Savings claim stored after it is missing from `balance`. */
  readAt?: number
}

export const balanceScope = (network: string | undefined, accountCompleteAddress: string) =>
  `${network}:${accountCompleteAddress}`

const KEY_BALANCE_RECORDS = "@obsidion/balances/records"

const recordKey = (scope: string, tokenAddress: string) => `${scope}:${tokenAddress}`

/**
 * Last-known on-chain balances on the RecordStorage kernel: the persistence the balances store
 * (`engine/balances`) mirrors, so it shows them cache-first. Legacy installs persisted a flat
 * `{ "scope:token": "raw" }` blob under BALANCE_STORAGE_KEY; `load()` migrates
 * it once and removes the old key.
 */
export class BalanceStorage {
  private static instance: BalanceStorage | null = null
  private storage: IStorageAdapter
  private store: RecordStorage<BalanceRecord>
  private loadPromise: Promise<void> | null = null

  constructor(storage: IStorageAdapter) {
    this.storage = storage
    this.store = new RecordStorage<BalanceRecord>({
      storage,
      storageKey: KEY_BALANCE_RECORDS,
      keyOf: (r) => recordKey(r.scope, r.tokenAddress),
      label: "BalanceStorage",
    })
  }

  static get(storage?: IStorageAdapter): BalanceStorage {
    if (!BalanceStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }

      BalanceStorage.instance = new BalanceStorage(storage)
    }
    return BalanceStorage.instance
  }

  load(): Promise<void> {
    this.loadPromise ??= this.loadAndMigrate()
    return this.loadPromise
  }

  private async loadAndMigrate(): Promise<void> {
    await this.store.load()
    try {
      const raw = await this.storage.getItem(BALANCE_STORAGE_KEY)
      if (raw === null) return
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value !== "string") continue
            try {
              BigInt(value)
            } catch {
              continue
            }
            // Addresses carry no ":", so the token is the last segment.
            const sep = key.lastIndexOf(":")
            if (sep <= 0 || sep === key.length - 1) continue
            const scope = key.slice(0, sep)
            const tokenAddress = key.slice(sep + 1)
            if (!this.store.getByKey(key)) {
              await this.store.setRecord(key, { scope, tokenAddress, balance: value })
            }
          }
        }
      } catch (err) {
        logger.warn("[BalanceStorage] legacy blob unreadable — dropping it:", err)
      }
      // Consume the legacy key even when unreadable, so migration runs once.
      await this.storage.removeItem(BALANCE_STORAGE_KEY)
    } catch (err) {
      logger.warn("[BalanceStorage] legacy migration failed:", err)
    }
  }

  list(): BalanceRecord[] {
    return this.store.list()
  }

  onListChanged(listener: (records: BalanceRecord[]) => void): () => void {
    return this.store.onListChanged(listener)
  }

  public async getBalance(scope: string, token: string): Promise<bigint | undefined> {
    await this.load()
    const record = this.store.getByKey(recordKey(scope, token))
    if (!record) return undefined
    try {
      return BigInt(record.balance)
    } catch {
      return undefined
    }
  }

  /** False when a newer read is already stored. `strict` rejects when storage refuses the write. */
  public async updateBalance(
    scope: string,
    token: string,
    balance: bigint,
    anchorBlock?: number,
    opts?: { strict?: boolean; readAt?: number },
  ): Promise<boolean> {
    await this.load()
    const key = recordKey(scope, token)
    const current = this.store.getByKey(key)
    // A read at an older anchor (one pinned behind an in-flight send) never regresses a newer value.
    if (
      anchorBlock !== undefined &&
      current?.anchorBlock !== undefined &&
      anchorBlock < current.anchorBlock
    ) {
      return false
    }
    const now = Date.now()
    await this.store.setRecord(
      key,
      {
        scope,
        tokenAddress: token,
        balance: balance.toString(),
        anchorBlock,
        updatedAt: now,
        readAt: opts?.readAt ?? now,
      },
      { strict: opts?.strict },
    )
    return true
  }

  public async clear(): Promise<void> {
    await this.store.clearAll()
    await this.storage.removeItem(BALANCE_STORAGE_KEY)
  }
}

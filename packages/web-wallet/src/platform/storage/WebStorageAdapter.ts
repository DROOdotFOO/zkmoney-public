import type { IStorageAdapter } from "@obsidion/front-core"
import {
  BROADCASTS_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  OPERATIONS_STORAGE_KEY,
} from "@obsidion/front-core"
import { CONFIG_STORAGE_KEY_PREFIX } from "@obsidion/core/constants"
import { getActiveStorageId } from "./activeStorage"
import { PASSKEY_IDENTITY_MAP_KEY, WEB_STORAGE_PREFIX } from "./storageKeys"
import { loadFromOtherDatabases, walletStorage } from "./walletStorage"

export { PASSKEY_IDENTITY_MAP_KEY, WEB_STORAGE_PREFIX }

/**
 * Per-device keys: written before any account exists (the consent prompt answers on the claim
 * page), shared by every account on this browser. Operations and broadcasts carry their own scope,
 * so a visitor's and an account's survive a sign-in between them.
 */
const GLOBAL_KEYS = new Set([
  PASSKEY_IDENTITY_MAP_KEY,
  NETWORK_STORAGE_KEY,
  OPERATIONS_STORAGE_KEY,
  BROADCASTS_STORAGE_KEY,
])
const isGlobal = (key: string) => GLOBAL_KEYS.has(key) || key.startsWith(CONFIG_STORAGE_KEY_PREFIX)

/**
 * `IStorageAdapter` over the rollup's wallet database (`walletStorage.ts`). A returned promise
 * resolves once the write is saved and rejects when it fails, which front-core's rollback and
 * "safe to leave" checks rely on. Account-scoped keys live under `obsidion.<storageId>.`, so
 * several accounts on one browser keep separate contacts, history and stores; {@link GLOBAL_KEYS}
 * stay under `obsidion.`. The namespace is the active storage id (`activeStorage.ts`), read per
 * call so a commit or a sign-out moves every instance at once. No cross-tab notifications: one
 * document holds the database.
 */
export class WebStorageAdapter implements IStorageAdapter {
  private scoped(key: string): string {
    const id = isGlobal(key) ? null : getActiveStorageId()
    return WEB_STORAGE_PREFIX + (id ? `${id}.` : "") + key
  }

  async getItem(key: string): Promise<string | null> {
    return walletStorage.getItem(this.scoped(key))
  }

  async setItem(key: string, value: string): Promise<void> {
    await walletStorage.commitItem(this.scoped(key), value)
  }

  async removeItem(key: string): Promise<void> {
    await walletStorage.commitRemove(this.scoped(key))
  }

  /**
   * This account's part of every other rollup's database, each read whole under one open and handed
   * to `read`: `get` is one of the account's keys there, `keys` lists them under a prefix. A database
   * it cannot read fails the read.
   */
  readOtherDatabases<T>(
    read: (db: {
      version: string
      get(key: string): string | undefined
      keys(prefix: string): string[]
    }) => T,
  ): Promise<T[]> {
    return loadFromOtherDatabases(
      ({ version, state }) =>
        read({
          version,
          get: (key) => state.get(this.scoped(key)),
          keys: (prefix) => {
            const scoped = this.scoped(prefix)
            const base = scoped.length - prefix.length
            return [...state.keys()].filter((k) => k.startsWith(scoped)).map((k) => k.slice(base))
          },
        }),
      { strict: true },
    )
  }

  /** Wipes the active account's namespace, not other accounts' or the global keys. No-op without an account. */
  async clear(): Promise<void> {
    const id = getActiveStorageId()
    if (!id) return
    await walletStorage.commitRemoveUnder(`${WEB_STORAGE_PREFIX}${id}.`)
  }
}

/** Whether this browser holds any account-scoped key for `storageId` on this rollup. */
export async function holdsAccountRecords(storageId: string): Promise<boolean> {
  const prefix = `${WEB_STORAGE_PREFIX}${storageId}.`
  if (walletStorage.keys().some((key) => key.startsWith(prefix))) return true
  return (await walletStorage.rangeQueued(`${prefix}acct/`, { limit: 1 })).length > 0
}

/** The app-wide adapter instance. */
export const webStorage = new WebStorageAdapter()

import { assert } from "ts-essentials"
import type { Token } from "@obsidion/sdk"
import { TOKENS_LOCAL_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter } from "./adapter.js"
import { memoryStore } from "../../engine/store"
import { legacyStore } from "../../engine/legacyStore"

type StoredEntries = [string, Token][]

export class TokenStorage {
  private static instance: TokenStorage | null = null
  private storage: IStorageAdapter
  private writes = memoryStore(0)
  /** The stored rows, read again after every write. */
  readonly rows = legacyStore<readonly Token[]>(
    { read: () => this.getTokens(), subscribe: (onChange) => this.writes.subscribe(onChange) },
    [],
  )

  constructor(storage: IStorageAdapter) {
    this.storage = storage
  }

  static get(storage?: IStorageAdapter): TokenStorage {
    if (!TokenStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }
      TokenStorage.instance = new TokenStorage(storage)
    }
    return TokenStorage.instance
  }

  public async loadTokensFromLocalStorage(): Promise<Map<string, Token>> {
    const entries = await this.loadEntries()
    return new Map(entries)
  }

  private async loadEntries(): Promise<StoredEntries> {
    const raw = await this.storage.getItem(TOKENS_LOCAL_STORAGE_KEY)
    if (raw === null) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
      return []
    }

    if (!Array.isArray(parsed)) {
      await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
      return []
    }

    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) {
        await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
        return []
      }
      const [tupleKey, token] = item as [unknown, unknown]
      if (typeof tupleKey !== "string") {
        await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
        return []
      }
      if (token === null || typeof token !== "object") {
        await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
        return []
      }
      const t = token as Record<string, unknown>
      if (
        typeof t.address !== "string" ||
        typeof t.name !== "string" ||
        typeof t.symbol !== "string" ||
        !Number.isInteger(t.decimals) ||
        (t.decimals as number) < 0 ||
        (t.logo !== undefined && typeof t.logo !== "string") ||
        tupleKey !== t.address
      ) {
        await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
        return []
      }
    }

    return parsed as StoredEntries
  }

  private async saveEntries(entries: StoredEntries): Promise<void> {
    await this.storage.setItem(TOKENS_LOCAL_STORAGE_KEY, JSON.stringify(entries))
    this.writes.update((n) => n + 1)
  }

  public async addToken(token: Token) {
    assert(token.name, "Token name is required")
    assert(token.symbol, "Token symbol is required")
    assert(
      Number.isInteger(token.decimals) && token.decimals >= 0,
      "Token decimals must be a non-negative integer",
    )
    assert(token.address, "Token address is required")

    const entries = await this.loadEntries()
    // Strip every existing tuple for this address before pushing the new one,
    // so that any duplicate-key persisted state can't shadow the update on a
    // subsequent getTokens() (which dedups via Map and would otherwise return
    // a later stale duplicate).
    const filtered = entries.filter(([key]) => key !== token.address)
    filtered.push([token.address, token])
    await this.saveEntries(filtered)
  }

  public async removeToken(tokenAddress: string) {
    const entries = await this.loadEntries()
    const filtered = entries.filter(([key]) => key !== tokenAddress)
    if (filtered.length === entries.length) return
    await this.saveEntries(filtered)
  }

  public async getTokens(): Promise<Token[]> {
    const entries = await this.loadEntries()
    // Dedup by tuple key in case persisted data has duplicate keys; the
    // tuple-key === token.address invariant is enforced at load time, so
    // dedup-by-key implies dedup-by-address.
    return Array.from(new Map(entries).values())
  }

  public async clear() {
    await this.storage.removeItem(TOKENS_LOCAL_STORAGE_KEY)
    this.writes.update((n) => n + 1)
  }
}

import {
  CONFIG_STORAGE_KEY_PREFIX,
  LOCAL_CONFIG_DEFAULTS,
  type LocalConfig,
} from "@obsidion/core/constants"
import type { IStorageAdapter } from "../storages/adapter"
import { logger } from "../../utils/logger"

const CONFIG_KEYS = Object.keys(LOCAL_CONFIG_DEFAULTS) as (keyof LocalConfig)[]

const storageKeyFor = (key: keyof LocalConfig) => CONFIG_STORAGE_KEY_PREFIX + key

/**
 * Observable persisted app settings. One JSON-encoded storage entry per
 * setting; a missing, malformed, or type-mismatched entry resolves to the
 * default for that key only. The snapshot is replaced immutably on every
 * change, so reference identity is the change signal: `getSnapshot` +
 * `subscribe` plug straight into React's useSyncExternalStore but carry no
 * React dependency. The composition root constructs the one instance and
 * awaits init() before first render.
 */
export class LocalConfigStore {
  private snapshot: LocalConfig = { ...LOCAL_CONFIG_DEFAULTS }
  private listeners = new Set<() => void>()
  private initPromise?: Promise<void>
  private unwatch?: () => void

  constructor(private storage: IStorageAdapter) {}

  /**
   * Hydrate the snapshot from storage and wire external-change invalidation.
   * Idempotent, and never rejects: boot paths block on init(), and a dead
   * storage backend must cost the persisted overrides, not the wallet (every
   * key has a safe default).
   */
  init(): Promise<void> {
    return (this.initPromise ??= this.doInit())
  }

  private async doInit(): Promise<void> {
    await Promise.all(
      CONFIG_KEYS.map((key) =>
        this.hydrateKey(key).catch((err) => {
          logger.warn(`[LocalConfigStore] Hydration failed for "${key}", using default:`, err)
        }),
      ),
    )
    try {
      this.unwatch = this.storage.watch?.(CONFIG_STORAGE_KEY_PREFIX, (storageKey) => {
        void this.applyExternalChange(storageKey).catch((err) => {
          logger.warn("[LocalConfigStore] External-change refresh failed:", err)
        })
      })
    } catch (err) {
      logger.warn("[LocalConfigStore] watch wiring failed:", err)
    }
  }

  /** Stop reacting to external storage changes. */
  dispose(): void {
    this.unwatch?.()
    this.unwatch = undefined
  }

  /** Synchronous, immutable; reference changes exactly when a value changes. */
  getSnapshot = (): LocalConfig => this.snapshot

  /** Fires on local set/reset and on external-change invalidation. Returns unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Sync read off the snapshot. Before init() resolves, returns the default. */
  get<K extends keyof LocalConfig>(key: K): LocalConfig[K] {
    return this.snapshot[key]
  }

  async set<K extends keyof LocalConfig>(key: K, value: LocalConfig[K]): Promise<void> {
    await this.storage.setItem(storageKeyFor(key), JSON.stringify(value))
    this.patch(key, value)
  }

  /**
   * Remove the override(s); values fall back to defaults. Enumerates known
   * keys, never adapter.clear(), which on web wipes storage shared with the
   * rest of the app.
   */
  async reset(key?: keyof LocalConfig): Promise<void> {
    const keys = key ? [key] : CONFIG_KEYS
    await Promise.all(keys.map((k) => this.storage.removeItem(storageKeyFor(k))))
    for (const k of keys) this.patch(k, LOCAL_CONFIG_DEFAULTS[k])
  }

  private async hydrateKey(key: keyof LocalConfig): Promise<void> {
    const raw = await this.storage.getItem(storageKeyFor(key))
    this.patch(key, this.decode(key, raw))
  }

  private async applyExternalChange(storageKey: string): Promise<void> {
    if (!storageKey.startsWith(CONFIG_STORAGE_KEY_PREFIX)) return
    const key = storageKey.slice(CONFIG_STORAGE_KEY_PREFIX.length) as keyof LocalConfig
    if (!CONFIG_KEYS.includes(key)) return
    await this.hydrateKey(key)
  }

  private decode<K extends keyof LocalConfig>(key: K, raw: string | null): LocalConfig[K] {
    if (raw === null) return LOCAL_CONFIG_DEFAULTS[key]
    try {
      const parsed: unknown = JSON.parse(raw)
      // The defaults object doubles as the runtime type witness.
      if (typeof parsed !== typeof LOCAL_CONFIG_DEFAULTS[key]) throw new Error("type mismatch")
      return parsed as LocalConfig[K]
    } catch (err) {
      logger.warn(`[LocalConfigStore] Discarding malformed value for "${key}":`, err)
      return LOCAL_CONFIG_DEFAULTS[key]
    }
  }

  private patch<K extends keyof LocalConfig>(key: K, value: LocalConfig[K]): void {
    if (Object.is(this.snapshot[key], value)) return
    this.snapshot = { ...this.snapshot, [key]: value }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        logger.warn("[LocalConfigStore] listener error:", err)
      }
    }
  }
}

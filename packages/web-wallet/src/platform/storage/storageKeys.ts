/**
 * Key names with no imports, so a sync probe can read the wallet store without loading the adapter.
 *
 * Every adapter key lives under this prefix so `clear()` can wipe front-core's
 * state without touching keys other modules own directly (the claimed
 * identity, the passkey breadcrumbs, the active storage id).
 */
export const WEB_STORAGE_PREFIX = "obsidion."

/** A key an account's persistent stores keep (`obsidion.[<id>.]acct/…`), read only through the database. */
export const isStoreKey = (key: string): boolean => /^obsidion\.(?:[0-9a-f]+\.)?acct\//.test(key)
export const PASSKEY_IDENTITY_MAP_KEY = "obsidion_web_passkey_identity_map"

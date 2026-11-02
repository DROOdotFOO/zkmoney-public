/**
 * `CryptoProvider` — interface boundary between `EncryptedStorageAdapter`
 * (which lives in front-core) and the platform-specific key holder (e.g.
 * web's `MskWebCryptoProvider`).
 *
 * front-core cannot import platform key stores or the SDK's MSK plumbing, so
 * this 4-method shape lets the platform layer own everything key-related —
 * derivation, caching, invalidation — and front-core is just a consumer of
 * `encrypt(plaintext) → ciphertext` / `decrypt(ciphertext) → plaintext`.
 *
 * Key-rotation contract: when a fresh install or biometric re-auth produces
 * a new derived key, `keyAvailable()` may return false momentarily; consumers
 * of the adapter should treat decryption errors during `load()` as "drop the
 * record" rather than "crash the app" (see `EncryptedStorageAdapter.getItem`).
 *
 * Listeners registered via `onKeyChanged` fire when the underlying key
 * material changes. Subscribers can use this to invalidate caches and re-load.
 */
export interface CryptoProvider {
  /** Encrypt arbitrary string plaintext. Returns a self-contained ciphertext envelope. */
  encrypt(plaintext: string): Promise<string>

  /**
   * Decrypt a ciphertext produced by `encrypt`. Throws on auth failure, key
   * mismatch, or malformed envelope — callers must distinguish "decrypt
   * failed" (drop or warn) from "no value" (return null).
   */
  decrypt(ciphertext: string): Promise<string>

  /**
   * Returns true if the provider currently has a working key. False during
   * MSK lock / pre-onboarding / cold-start before the user authenticates.
   */
  keyAvailable(): boolean

  /**
   * Subscribe to key-rotation events. Returns the unsubscribe function.
   * Listeners fire whenever the underlying key material changes — concrete
   * triggers depend on the platform (MSK eviction on AppState.background,
   * biometric re-auth, fresh install).
   */
  onKeyChanged(listener: () => void): () => void
}

import type { IStorageAdapter } from "../../storages/adapter"
import { EncryptedStorageAdapter } from "../../storages/EncryptedStorageAdapter"

const KEY_STATE = "@obsidion/zkjwt/state"
const KEY_PROOF_CACHE = "@obsidion/zkjwt/proof-cache"

const MAX_CACHED_PROOFS = 10
export const ZKJWT_EMAIL_HASH_VERSION = 2

export type ZkJwtState = "idle" | "proving" | "cached" | "error"

export interface ZkJwtCacheMetadata {
  hashVersion: number // email/JWT commitment hash version
  iat: number // unix timestamp
  jwkId: string // identifier for the keys used to sign the jwt
  issHash: string // issuer hash from public_inputs[6]
  audHash: string // registry-allowlisted aud_hash that the proof was bound to
  commitment: string // hash of the commitment to the identity
  callerAddress: string // address of the caller
  cachedAt: number // unix timestamp
  provider: "google" | "apple" // provider of the jwt
  email: string // email of the user
}

export interface ProofBundle {
  proof: string[]
  vkey: string[]
  publicInputs: string[]
  metadata: ZkJwtCacheMetadata
}

type ProofCacheMap = Record<string, ProofBundle>

export class ZkJwtStorage {
  private static instance: ZkJwtStorage | null = null

  constructor(private readonly adapter: IStorageAdapter) {
    // Brand check — refuse a plain adapter. The proof cache persists the
    // user's email + Aztec address (see ZkJwtCacheMetadata), so it must be
    // encrypted at rest.
    if (!EncryptedStorageAdapter.isEncrypted(adapter)) {
      throw new Error(
        "ZkJwtStorage requires an EncryptedStorageAdapter — passing a plain " +
          "IStorageAdapter is rejected because the persisted proof cache " +
          "contains the user's email and Aztec address.",
      )
    }
  }

  /**
   * Process-wide accessor.
   * Boot (app/_layout.tsx) primes it with the MSK-derived
   * `EncryptedStorageAdapter`; lazily-constructed consumers (e.g.
   * `createZkJwtService` inside a claim screen) call `get()` with no arg.
   * First call must supply an adapter; the brand check runs in the constructor.
   */
  static get(adapter?: IStorageAdapter): ZkJwtStorage {
    if (!ZkJwtStorage.instance) {
      if (!adapter) {
        throw new Error(
          "First call to ZkJwtStorage.get() requires a storage adapter",
        )
      }
      ZkJwtStorage.instance = new ZkJwtStorage(adapter)
    }
    return ZkJwtStorage.instance
  }

  /**
   * Read a key tolerating a decrypt failure. Once the adapter is encrypted,
   * `getItem` runs `crypto.decrypt`, which throws on a value it can't
   * decrypt — a pre-encryption plaintext blob, a rotated MSK, or tampering.
   * On failure we scrub the unreadable key (so a stale/plaintext bundle
   * doesn't linger — this self-heals residual cleartext) and return null so
   * the caller falls back to its default → a fresh OAuth proof.
   */
  private async safeRead(key: string): Promise<string | null> {
    try {
      return await this.adapter.getItem(key)
    } catch {
      try {
        await this.adapter.removeItem(key)
      } catch {
        // best-effort scrub; ignore
      }
      return null
    }
  }

  async getState(): Promise<ZkJwtState> {
    const val = await this.safeRead(KEY_STATE)
    if (val === "proving" || val === "cached" || val === "error") return val
    return "idle"
  }

  async setState(state: ZkJwtState): Promise<void> {
    await this.adapter.setItem(KEY_STATE, state)
  }

  private async loadCache(): Promise<ProofCacheMap> {
    const stored = await this.safeRead(KEY_PROOF_CACHE)
    if (!stored) return {}
    try {
      return JSON.parse(stored) as ProofCacheMap
    } catch {
      return {}
    }
  }

  private async saveCache(cache: ProofCacheMap): Promise<void> {
    await this.adapter.setItem(KEY_PROOF_CACHE, JSON.stringify(cache))
  }

  async getProof(commitment: string): Promise<ProofBundle | null> {
    const cache = await this.loadCache()
    return cache[commitment] ?? null
  }

  async listProofs(): Promise<ProofBundle[]> {
    const cache = await this.loadCache()
    return Object.values(cache)
  }

  async saveProofCache(
    proofFields: string[],
    vkeyFields: string[],
    publicInputs: string[],
    metadata: ZkJwtCacheMetadata,
  ): Promise<void> {
    const cache = await this.loadCache()

    const keys = Object.keys(cache)
    if (keys.length >= MAX_CACHED_PROOFS) {
      let oldestKey = keys[0]!
      let oldestTime = cache[oldestKey]!.metadata.cachedAt
      for (const key of keys) {
        if (cache[key]!.metadata.cachedAt < oldestTime) {
          oldestKey = key
          oldestTime = cache[key]!.metadata.cachedAt
        }
      }
      delete cache[oldestKey]
    }

    cache[metadata.commitment] = {
      proof: proofFields,
      vkey: vkeyFields,
      publicInputs,
      metadata,
    }

    await this.saveCache(cache)
  }

  async removeProof(commitment: string): Promise<void> {
    const cache = await this.loadCache()
    delete cache[commitment]
    await this.saveCache(cache)
  }

  async hasAnyProof(): Promise<boolean> {
    const cache = await this.loadCache()
    return Object.keys(cache).length > 0
  }

  async clearCache(): Promise<void> {
    await this.adapter.removeItem(KEY_PROOF_CACHE)
    await this.adapter.removeItem(KEY_STATE)
  }
}

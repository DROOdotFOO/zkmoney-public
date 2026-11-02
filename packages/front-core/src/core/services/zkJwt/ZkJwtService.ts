import { generateZkJwtProof } from "./generateZkJwtProof"
import { ZKJWT_PUBLIC_INPUT_COUNT } from "@obsidion/core/constants"
import type { JwtProvider } from "@obsidion/sdk"

import type { IZkJwtProver } from "./IZkJwtProver"
import type { IZkJwtRegistryCheck } from "./IZkJwtRegistryCheck"
import {
  type ZkJwtStorage,
  ZKJWT_EMAIL_HASH_VERSION,
  type ZkJwtState,
  type ZkJwtCacheMetadata,
  type ProofBundle,
} from "./ZkJwtStorage"
import { logger } from "../../../utils/logger"

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 1 week

export interface ZkJwtProgress {
  stage: "preparing-inputs" | "proving" | "caching" | "complete"
  detail?: string
}

export interface ZkJwtCallbacks {
  onProgress?: (progress: ZkJwtProgress) => void
  onError?: (error: Error) => void
  onComplete?: () => void
}

export interface CachedZkProof {
  vkey: string[]
  proof: string[]
  public_inputs: string[]
  email: string
  provider: "google" | "apple"
}

export interface ZkJwtServiceDeps {
  prover: IZkJwtProver
  storage: ZkJwtStorage
  registry?: IZkJwtRegistryCheck
}

export class ZkJwtService {
  private readonly prover: IZkJwtProver
  private readonly storage: ZkJwtStorage
  private readonly registry: IZkJwtRegistryCheck | undefined

  private _state: ZkJwtState = "idle"
  private _currentProgress: ZkJwtProgress | null = null
  private provingPromise: Promise<void> | null = null

  constructor(deps: ZkJwtServiceDeps) {
    this.prover = deps.prover
    this.storage = deps.storage
    this.registry = deps.registry
    this.checkState()
  }

  get state(): ZkJwtState {
    return this._state
  }

  get currentProgress(): ZkJwtProgress | null {
    return this._currentProgress
  }

  get isProving(): boolean {
    return this._state === "proving"
  }

  get isCached(): boolean {
    return this._state === "cached"
  }

  private async checkState(): Promise<void> {
    const state = await this.storage.getState()
    if (state === "cached") {
      this._state = "cached"
    }
  }

  /**
   * Start proof generation in the background. Returns immediately.
   * Safe to call multiple times — will not restart if already proving or cached.
   */
  proveInBackground(
    jwt: string,
    provider: JwtProvider,
    noncePreimage: bigint,
    callerAddress: string,
    callbacks?: ZkJwtCallbacks,
  ): void {
    if (this._state === "proving") {
      logger.log("[ZkJwtService] Already proving, skipping")
      return
    }

    this._state = "proving"
    this.provingPromise = this.runProving(jwt, provider, noncePreimage, callerAddress, callbacks)
  }

  async waitForProof(): Promise<void> {
    if (this.provingPromise) {
      await this.provingPromise
    }
  }

  private async runProving(
    jwt: string,
    provider: JwtProvider,
    noncePreimage: bigint,
    callerAddress: string,
    callbacks?: ZkJwtCallbacks,
  ): Promise<void> {
    const emit = (stage: ZkJwtProgress["stage"], detail?: string) => {
      this._currentProgress = { stage, detail }
      callbacks?.onProgress?.({ stage, detail })
    }

    try {
      await this.storage.setState("proving")

      emit("preparing-inputs")
      const result = await generateZkJwtProof(
        this.prover,
        jwt,
        provider,
        noncePreimage,
        callerAddress,
        () => emit("proving"),
      )
      emit("caching")
      await this.storage.saveProofCache(
        result.proof,
        result.vkey,
        result.publicInputs,
        result.metadata,
      )
      await this.storage.setState("cached")

      emit("complete")
      this._state = "cached"
      callbacks?.onComplete?.()
    } catch (error) {
      this._state = "error"
      this._currentProgress = null
      await this.storage.setState("error")

      const err = error instanceof Error ? error : new Error(String(error))
      callbacks?.onError?.(err)
      logger.error("[ZkJwtService] Proving failed:", err.message)
    } finally {
      this.provingPromise = null
    }
  }

  /**
   * Load the cached proof for a specific commitment, if still valid for this
   * caller. Returns null when the bundle is missing, belongs to another
   * caller, invalid (in which case it is evicted), or temporarily
   * unverifiable due to a transient registry RPC error (retained; retry later).
   */
  async getCachedZkProof(callerAddress: string, commitment: string): Promise<CachedZkProof | null> {
    const bundle = await this.storage.getProof(commitment)
    if (!bundle) return null
    if (bundle.metadata.callerAddress !== callerAddress) return null
    const status = await this.classifyBundle(bundle)
    if (status === false) {
      await this.evictProof(bundle.metadata.commitment)
      return null
    }
    if (status === "error") return null
    return this.toCachedZkProof(bundle)
  }

  /**
   * Walk every cached proof and evict any that are durably invalid (missing
   * audHash, iat/TTL expired, or rejected by the OidcKeyRegistry pre-check).
   * Does not consider caller — other callers' bundles remain valid for them.
   * Transient registry failures leave the bundle in place so a flaky RPC
   * does not wipe the cache.
   */
  async pruneExpiredProofs(): Promise<void> {
    const allProofs = await this.storage.listProofs()
    for (const bundle of allProofs) {
      if ((await this.classifyBundle(bundle)) === false) {
        await this.evictProof(bundle.metadata.commitment)
      }
    }
  }

  /**
   * `true`  — passes every check, safe to hand to the claim path.
   * `false` — stale JWK/AUD, expired TTL, or missing required fields; evict.
   * `"error"` — registry RPC failed; retain and retry next time.
   */
  private async classifyBundle(bundle: ProofBundle): Promise<boolean | "error"> {
    if (bundle.metadata.hashVersion !== ZKJWT_EMAIL_HASH_VERSION) {
      logger.log("[ZkJwtService] Cache invalid: stale email/JWT hash version")
      return false
    }
    if (bundle.publicInputs.length !== ZKJWT_PUBLIC_INPUT_COUNT) {
      logger.log("[ZkJwtService] Cache invalid: stale public input layout")
      return false
    }
    if (!bundle.metadata.issHash) {
      logger.log("[ZkJwtService] Cache invalid: legacy entry missing issuer hash")
      return false
    }
    if (!bundle.metadata.audHash) {
      logger.log("[ZkJwtService] Cache invalid: legacy entry missing audHash")
      return false
    }
    const now = Date.now()
    if (now - bundle.metadata.iat * 1000 > CACHE_TTL_MS) {
      logger.log("[ZkJwtService] Cache invalid: IAT expired")
      return false
    }
    if (now - bundle.metadata.cachedAt > CACHE_TTL_MS) {
      logger.log("[ZkJwtService] Cache invalid: cache TTL exceeded")
      return false
    }

    // Registry pre-check — the two lookups are independent, so run them
    // concurrently to halve tail latency on the happy path. `allSettled`
    // keeps a definitive `false` authoritative even if the other side
    // rejects — so we never mark a durably-invalid bundle as retryable.
    if (this.registry) {
      const [jwkResult, audResult] = await Promise.allSettled([
        this.registry.isValidJwk(bundle.metadata.jwkId, bundle.metadata.issHash),
        this.registry.isAudAllowed(bundle.metadata.audHash),
      ])

      if (jwkResult.status === "fulfilled" && !jwkResult.value) {
        logger.log("[ZkJwtService] Cache invalid: jwk_id no longer allowlisted")
        return false
      }
      if (audResult.status === "fulfilled" && !audResult.value) {
        logger.log("[ZkJwtService] Cache invalid: aud_hash no longer allowlisted")
        return false
      }
      if (jwkResult.status === "rejected" || audResult.status === "rejected") {
        const err =
          jwkResult.status === "rejected"
            ? jwkResult.reason
            : (audResult as PromiseRejectedResult).reason
        logger.warn("[ZkJwtService] Registry pre-check failed (transient); retaining cache:", err)
        return "error"
      }
    }

    return true
  }

  private async evictProof(commitment: string): Promise<void> {
    await this.storage.removeProof(commitment)
    // If the cache is now empty, flip the service state so the UI's
    // "cached-claim" shortcut button doesn't linger.
    if (!(await this.storage.hasAnyProof())) {
      await this.storage.setState("idle")
      this._state = "idle"
    }
  }

  private toCachedZkProof(bundle: {
    vkey: string[]
    proof: string[]
    publicInputs: string[]
    metadata: ZkJwtCacheMetadata
  }): CachedZkProof {
    return {
      vkey: bundle.vkey,
      proof: bundle.proof,
      public_inputs: bundle.publicInputs,
      email: bundle.metadata.email ?? "",
      provider: bundle.metadata.provider,
    }
  }

  /**
   * Check if cached proof passes all invalidation conditions.
   */
  isCacheValid(metadata: ZkJwtCacheMetadata, callerAddress: string, commitment?: string): boolean {
    if (metadata.callerAddress !== callerAddress) {
      logger.log("[ZkJwtService] Cache invalid: caller address changed")
      return false
    }

    if (commitment && metadata.commitment !== commitment) {
      logger.log("[ZkJwtService] Cache invalid: commitment mismatch")
      return false
    }

    if (metadata.hashVersion !== ZKJWT_EMAIL_HASH_VERSION) {
      logger.log("[ZkJwtService] Cache invalid: stale email/JWT hash version")
      return false
    }

    if (!metadata.issHash) {
      logger.log("[ZkJwtService] Cache invalid: legacy entry missing issuer hash")
      return false
    }

    if (!metadata.audHash) {
      logger.log("[ZkJwtService] Cache invalid: legacy entry missing audHash")
      return false
    }

    const iatMs = metadata.iat * 1000
    if (Date.now() - iatMs > CACHE_TTL_MS) {
      logger.log("[ZkJwtService] Cache invalid: IAT expired")
      return false
    }

    if (Date.now() - metadata.cachedAt > CACHE_TTL_MS) {
      logger.log("[ZkJwtService] Cache invalid: cache TTL exceeded")
      return false
    }

    return true
  }

  /**
   * Check for interrupted proving on app startup (crash recovery).
   */
  async checkAndRecoverProving(): Promise<boolean> {
    const state = await this.storage.getState()
    if (state === "proving") {
      logger.warn("[ZkJwtService] Detected interrupted proving, clearing state")
      await this.storage.setState("idle")
      this._state = "idle"
      return true
    }
    if (state === "cached") {
      this._state = "cached"
    }
    return false
  }

  /**
   * Match a cached proof for a parsed paylink. Returns the proof only when
   * the paylink is a paylinkEmail *and* carries a target commitment.
   * Older paylinks without a commitmentHash fall through to null so the UI
   * takes the OAuth + fresh-proof path.
   */
  async matchProofForPaylink(
    callerAddress: string,
    paylinkType: string,
    commitment?: string,
  ): Promise<CachedZkProof | null> {
    if (paylinkType !== "paylinkEmail") return null
    if (!commitment) return null
    return this.getCachedZkProof(callerAddress, commitment)
  }

  async reset(): Promise<void> {
    this._state = "idle"
    this._currentProgress = null
    this.provingPromise = null
    await this.storage.clearCache()
  }
}

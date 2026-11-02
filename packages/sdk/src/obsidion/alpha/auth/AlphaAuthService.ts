import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { PrfSlot, SignInRoute } from "@obsidion/core/types"
import type { AlphaAuthProvider } from "./AlphaAuthProvider.js"

/** Both candidate MSKs from a dual-salt recovery, one per PRF slot. */
export type RecoverCandidates = { first?: Fr; second?: Fr }

/**
 * Result of `recoverPasskey`. The service produces BOTH slot candidates (an
 * assertion carries no AAGUID, so the slot cannot be re-derived here) plus the
 * persisted slot/address; it deliberately does NOT reseed the Keychain or seed
 * any cache. The caller derives each candidate's account address and lets an
 * anchor pick — the stored `expectedAddress` when the device holds one, else a
 * record the caller looks up for each candidate — and only then calls
 * `commitSecret`.
 */
export type RecoverPasskeyResult = {
  authProvider: AlphaAuthProvider
  credentialId: string
  pubkey: string
  candidates: RecoverCandidates
  /** Slot the persisted record prefers; `"first"` when no slot was stored. */
  preferredSlot: PrfSlot
  /** Whether a slot was actually persisted (vs the `"first"` default). Diagnostic/ordering only. */
  hasPersistedSlot: boolean
  /**
   * `"webauthn"` (all production recovery) NEVER commits an unanchored candidate:
   * an `expectedAddress` match, or a per-candidate record lookup, has to name it
   * first, even when only one slot came back. `"test"` may commit a single
   * minted candidate without an address.
   */
  candidateSource: "webauthn" | "test"
  /** Canonical L2 address recorded at create, for verify-before-commit. */
  expectedAddress?: string
  /**
   * Which authenticator roots this credential. A `"security-key"` has a single
   * deterministic PRF slot, so the caller may commit without an `expectedAddress`
   * (guarded by "no current wallet"); `"platform"` ALWAYS requires the match.
   */
  authenticatorType?: "platform" | "security-key"
  /**
   * The transports the credential's creation reported, when the source carried them (a campaign
   * hand-off); absent after a ceremony, which reports none.
   */
  transports?: readonly string[]
  /**
   * The name the passkey's user handle carries, when it was created carrying one and the source
   * was an assertion. Only a hash on chain names an account, so a caller trusts this name where it
   * hashes to the claim or reservation it found.
   */
  userHandle?: string
  /**
   * Every key of the account the signer belongs to, as `pubkey` is encoded, in the account's
   * order; the address is derived from all of them. Absent means the signer alone.
   */
  passkeys?: readonly string[]
}

/**
 * Recovery breadcrumb persisted at create. `isMskRoot:false` marks a credential whose PRF never
 * derived the account MSK; one carrying `backup` still opens the wallet, through its envelope.
 */
export type RecoveryMetadata = {
  credentialId: string
  l2Address: string
  pubkey: string
  prfSlot?: PrfSlot
  prfAaguid?: string
  /** Only the root onboarding credential's PRF reproduces the account MSK. */
  isMskRoot: boolean
  /**
   * Set on a backup credential: the Ethereum account its envelope is bound to and the envelope
   * itself, `0x`-prefixed hex. Present exactly when the record opens the wallet without deriving
   * the MSK.
   */
  backup?: { account: string; envelope: string }
  /**
   * Every key of the account, as `pubkey` is encoded, in the account's order; `l2Address` derives
   * from all of them. Absent means `pubkey` alone.
   */
  passkeySet?: readonly string[]
  /** Which authenticator class roots the credential (default `"platform"` when absent). */
  authenticatorType?: "platform" | "security-key"
  /**
   * Transports the creation response named for the authenticator. A later sign-in sends them with
   * the credential so the browser offers the devices the passkey actually lives on.
   */
  transports?: readonly string[]
  /**
   * Transports this browser's own assertions implied for the authenticator (a hardware key's
   * physical set), kept apart from what creation reported. A reader prefers `transports` when
   * both are present.
   */
  inferredTransports?: readonly string[]
  /**
   * Per ClaimFPC instance, keyed by its address: the account whose subscription note pays for this
   * account's sponsored batches, and the one key that account derives from. Written only with
   * evidence that the account holds the note on that instance. No entry means the account pays
   * with its own note.
   */
  feePayer?: Record<string, FeePayerEntry>
}

/** An account that holds a ClaimFPC subscription note, with the key it derives from (x‖y hex). */
export type FeePayerEntry = { address: string; passkey: string }

/** Input to the commit step — reseeds the Keychain and seeds the caches. */
export type CommitSecretInput = {
  secretKey: Fr
  authProvider: AlphaAuthProvider
}

/**
 * Platform-agnostic service interface for alpha account auth.
 *
 * Encapsulates passkey creation/recovery, secret-key management,
 * and construction of an AlphaAuthProvider ready for signing.
 *
 * The browser implements this with viem's toWebAuthnAccount + localStorage.
 */
export interface AlphaAuthService {
  /** Build an AlphaAuthProvider from the stored credential for the current account. */
  getAuthProvider(): Promise<AlphaAuthProvider | undefined>

  /**
   * The Aztec secret key (MSK) the implementation holds or can restore from its own store (e.g.
   * the web wallet's local-storage cache); `undefined` means locked.
   */
  getSecretKey(): Promise<Fr | undefined>

  /**
   * Derive a 32-byte symmetric key bound to the MSK and a domain string.
   * Implementations MUST use poseidon2 with a domain-separator selector
   * (see `DOMAIN_SEPARATORS` in front-core's `derived-key-domains.ts`).
   * The derived key is used by the platform `CryptoProvider` to encrypt
   * persistent stores.
   *
   * Throws if the MSK is not available or the domain is unknown.
   */
  getDerivedKey(domain: string): Promise<Uint8Array>

  /**
   * Create a new signing credential and return the MSK bound to it.
   *
   * The implementation OWNS the MSK's origin — callers never supply one:
   * - Web derives it from the credential's WebAuthn PRF output, picking the
   *   slot from the ceremony's reported authenticator attachment, and refuses a
   *   credential that is not backup-eligible or returns no PRF.
   *
   * Does NOT persist the MSK or seed any cache — the caller MUST persist the
   * recovery metadata (`recordRecoveryMetadata`, REQUIRED) and then commit the
   * secret (`commitSecret`) once the account address is known. This ordering
   * guarantees a recovery record exists before the MSK is committed.
   */
  createPasskey(
    accountName: string,
    updateStatus?: (status: string) => void,
    opts?: {
      mode?: "combined" | "platform" | "security-key"
      route?: SignInRoute
      /** Ends the passkey prompt when the caller abandons the attempt. */
      signal?: AbortSignal
    },
  ): Promise<{
    authProvider: AlphaAuthProvider
    credentialId: string
    pubkey: string // hex-encoded x||y (64 bytes = 128 hex chars)
    /** The MSK the implementation derived (NOT yet persisted — see `commitSecret`). */
    secretKey: Fr
    /** PRF slot the MSK was derived from (web picks it by the reported attachment). */
    prfSlot?: PrfSlot
    /** Provider AAGUID the creation response reported, when readable. */
    prfAaguid?: string
    /** Which authenticator class roots the credential (default `"platform"`). */
    authenticatorType?: "platform" | "security-key"
    /** Transports the creation response named, for the record a later sign-in reads. */
    transports?: readonly string[]
  }>

  /**
   * Persist the recovery breadcrumb (slot/AAGUID/address) for a credential.
   * REQUIRED at create (the caller aborts onboarding on failure) so the record
   * is never simply absent on the original device.
   */
  recordRecoveryMetadata(meta: RecoveryMetadata): Promise<void>

  /**
   * Commit a verified MSK: reseed the implementation's store (web: the plain-text local-storage
   * cache) and seed the MSK + provider caches. The ONLY place the secret is persisted and
   * caches are mutated — recover never reseeds until the caller has verified the candidate's
   * derived address against the stored one. The provider is the session's signer, root or
   * backup, with its key inside the set the address was derived from.
   */
  commitSecret(input: CommitSecretInput): Promise<void>

  /**
   * Recover an existing passkey and produce BOTH MSK candidates WITHOUT
   * committing. Fails closed when the looked-up record is `isMskRoot:false`
   * with no `backup` (a rotated signing credential that neither derives the
   * account MSK nor opens an envelope).
   *
   * The MSK MUST be regenerated from the credential itself — a root's WebAuthn
   * PRF with the fixed salt, or a backup's PRF opening its envelope — never
   * from local state alone — so login works wherever the credential is
   * available. The caller commits a candidate only once an anchor names it:
   * the stored `expectedAddress`, or a record it looks up for each candidate.
   *
   * When `credentialId` is provided (account-picker), implementations MUST
   * pre-resolve the authenticator type + pubkey from the synced record and
   * constrain the assertion to that credential (WebAuthn `allowCredentials`) so
   * the OS sheet doesn't offer unrelated passkeys. With no `credentialId`
   * (fresh-discovery), the implementation may present a combined sheet and read
   * the type back from the resolved credential's class.
   */
  recoverPasskey(credentialId?: string): Promise<RecoverPasskeyResult>

  /** Clear any cached auth provider (e.g. when switching accounts). */
  clear(): void
}

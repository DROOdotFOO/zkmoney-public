import { legacyStore, type ReadonlyStore, type Sourced } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getActiveCredentialId } from "../../platform/storage/activeStorage"
import { walletStorage } from "../../platform/storage/walletStorage"
import { hasOpeningBreadcrumb, rememberUsertag } from "../../platform/auth/WebPasskeyIdentityMap"
import { clearAdmission } from "./admission"
import { clearNameGrant } from "../onboarding/nameGrant"

export type WalletIdentity = {
  /** Absent until a name is registered: the wallet runs nameless and tag surfaces prompt for one. */
  handle?: string
  address: string
  claimedAt: number
  /** The L1 registration is not yet confirmed — tag surfaces render claiming-in-progress. */
  pending?: boolean
}

const STORAGE_KEY = "webwallet.identity"

/**
 * Device-local record of the entered account — its L2 address plus the claimed
 * @tag once one exists. Its presence is what gates the wallet routes; absence
 * sends the visitor to /claim. Clearing it means re-onboarding (or, later,
 * returning-user entry via /enter).
 */
export function loadWalletIdentity({ saved = false } = {}): WalletIdentity | null {
  return decodeIdentity(
    saved ? walletStorage.getCommitted(STORAGE_KEY) : walletStorage.getItem(STORAGE_KEY),
  )
}

function decodeIdentity(raw: string | null): WalletIdentity | null {
  try {
    if (!raw) return null
    const parsed = JSON.parse(raw) as WalletIdentity
    if (typeof parsed.address !== "string") return null
    if (parsed.handle !== undefined && typeof parsed.handle !== "string") return null
    return parsed
  } catch {
    return null
  }
}

/** The identity, read again on every write. */
export function walletIdentity(): ReadonlyStore<Sourced<WalletIdentity | null>> {
  return legacyStore(
    {
      read: () => loadWalletIdentity(),
      subscribe: (onChange) =>
        walletStorage.onCommit((ops) => {
          if (ops.some(([key]) => key === STORAGE_KEY)) onChange()
        }),
    },
    null,
  )
}

/**
 * Resolves once the identity is saved and the passkey hint is saved too, and rejects when the
 * identity could not be saved; a caller about to enter the wallet or leave the page awaits it.
 * Settled tags only: a pending claim can still lose the name race, and a nameless save must not
 * disturb a hint from an earlier claim. The session's passkey carries the tag through logout
 * and account switching, which clear this record. `stillOwns` reaches the hint's write: a sign-in
 * that ended while the map lock was held leaves it unwritten.
 */
export function saveWalletIdentity(
  identity: WalletIdentity,
  stillOwns?: () => boolean,
): Promise<void> {
  const saved = walletStorage.commitItem(STORAGE_KEY, JSON.stringify(identity))
  const credentialId = getActiveCredentialId()
  const handle = identity.handle
  if (identity.pending || !handle || !credentialId) return saved
  return saved.then(() =>
    rememberUsertag(getConfig().rpId, credentialId, handle, stillOwns).catch(() => {}),
  )
}

export function clearWalletIdentity(): void {
  walletStorage.removeItem(STORAGE_KEY)
  clearAdmission()
}

/** L1 confirmed: drop the pending marker so tag surfaces render settled ownership. */
export function confirmWalletIdentity(): void {
  const identity = loadWalletIdentity()
  if (!identity?.pending) return
  const { pending: _pending, ...settled } = identity
  saveWalletIdentity(settled).catch((e) => console.error("[walletIdentity] confirm not saved:", e))
  if (settled.handle) clearNameGrant(settled.handle)
}

/** The name race was lost: a pending identity must never be presented as owned. */
export function retractPendingWalletIdentity(): void {
  if (loadWalletIdentity()?.pending) clearWalletIdentity()
}

/**
 * The wallet-route gate: entering the wallet needs BOTH the passkey breadcrumb
 * (created before entry) and the identity record — nameless is fine, the
 * record marks a completed entry while a missing one means onboarding died
 * before completion. An identity without the passkey breadcrumb is a stale
 * record (the account key is gone): treated as not onboarded. A passkey
 * deleted at the AUTHENTICATOR leaves both records intact and is locally
 * undetectable — that case surfaces as an assertion failure and belongs to the
 * /enter recovery slice.
 */
/** `saved` reads only a record already persisted, for a caller about to enter on it. */
export function loadOnboardedIdentity({ saved = false } = {}): WalletIdentity | null {
  if (!hasOpeningBreadcrumb(getConfig().rpId)) return null
  return loadWalletIdentity({ saved })
}

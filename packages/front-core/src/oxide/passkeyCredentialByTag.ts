/**
 * The passkeys a tag's account installed, read back from L1 so a browser that cannot enumerate the
 * passkey can ask for it by credential id, and so a sign-in derives the address with the account's
 * full key set. Registration writes the sign-up key with the credential id's raw bytes as
 * `metadata` (`credentialIdToMetadata`); a backup key carries oxide's prefixed layout
 * (`passkeyEnvelope.ts`). Nothing here is trusted: the caller pins the credential and the anchors
 * still decide which account the passkey opens.
 */

import type { Address, Hex } from "viem"
import type { AuthKeyEntry } from "@oxide/l1-contracts"

import {
  TagValidationError,
  type RegistryTagResolution,
} from "../core/services/RegistryTagResolver"
import type { BoundedAuthKeys } from "./oxideRegistration"
import { metadataToCredentialId } from "./oxideWebAuthn"
import { matchKind, parseKeyMetadata, type ParsedKeyMetadata } from "./passkeyEnvelope"

/** Output cap, and the bound the caller's key read should honour. */
export const MAX_PASSKEY_CANDIDATES = 8

/** One installed key with its metadata as read and as classified. */
export interface InstalledPasskey {
  /** Raw 64-byte `x‖y` as lowercase hex without `0x`. */
  pubkeyHex: string
  metadata: Hex
  parsed: ParsedKeyMetadata
}

export type PasskeyCredentialsByTag =
  | {
      kind: "resolved"
      account: Address
      l2Address: string
      /** Every 64-byte key read, in on-chain order, at most {@link MAX_PASSKEY_CANDIDATES}. */
      keys: InstalledPasskey[]
      /** Whether the read covered every installed key: false when the account has more than were read. */
      complete: boolean
      /** The account's total installed key count, eligible or not. */
      authKeyCount: number
    }
  /** Unregistered or invalid tag. */
  | { kind: "notFound" }
  /** Registered on an earlier rollup version. */
  | { kind: "staleRollup" }
  /** The account holds no auth key. */
  | { kind: "noKeyInstalled"; account: Address }
  /** Keys exist, none read is a 64-byte key with a known metadata kind; `complete` says whether more went unread. */
  | { kind: "unreadable"; account: Address; complete: boolean }

export interface PasskeyCredentialsByTagDeps {
  resolveTag: (tag: string) => Promise<RegistryTagResolution>
  /** The counted key read, expected to return at most {@link MAX_PASSKEY_CANDIDATES} entries. */
  readAuthKeys: (account: Address) => Promise<BoundedAuthKeys>
}

/** The entry's key as raw 64-byte `x‖y` lowercase hex without `0x`, or undefined when it is not 64 bytes. */
export function authKeyPubkeyHex(entry: AuthKeyEntry): string | undefined {
  const pubkeyHex = `${entry.key.qx.slice(2)}${entry.key.qy.slice(2)}`.toLowerCase()
  return pubkeyHex.length === 128 ? pubkeyHex : undefined
}

/**
 * The entry the assertion's credential answers for, and how it names it: `raw` when the metadata
 * is the id's own bytes (a root key), `hash` when oxide's prefix carries its hash (a backup key).
 * Every entry is tried for a raw match before any for a hash match.
 */
export function answeringKey(
  keys: readonly InstalledPasskey[],
  credentialId: string,
): { key: InstalledPasskey; by: "raw" | "hash" } | undefined {
  for (const by of ["raw", "hash"] as const) {
    const key = keys.find((k) => matchKind(k.metadata, credentialId) === by)
    if (key) return { key, by }
  }
  return undefined
}

/**
 * The credential ids a sign-in prompt is held to, one per key: a root key's raw id, a backup key's
 * appended id. A prefixed-looking entry with no appended id is a root whose raw id begins with
 * `0x01`, named by its whole metadata: every backup the wallet installs carries its id. `unknown`
 * entries cannot answer and are skipped.
 */
export function candidateCredentialIds(keys: readonly InstalledPasskey[]): string[] {
  return installedCredentials(keys).map((c) => c.credentialId)
}

/** An installed key's credential id, and whether it is a backup: an id behind an envelope. */
export type InstalledCredential = { credentialId: string; backup: boolean; key: InstalledPasskey }

/** {@link candidateCredentialIds} with each key. */
export function installedCredentials(keys: readonly InstalledPasskey[]): InstalledCredential[] {
  const out: InstalledCredential[] = []
  for (const key of keys) {
    const { parsed } = key
    if (parsed.kind === "unknown") continue
    if (parsed.kind === "credential-id") {
      out.push({ credentialId: parsed.credentialId, backup: false, key })
    } else {
      const backup = parsed.credentialId !== undefined
      out.push({
        credentialId: parsed.credentialId ?? metadataToCredentialId(key.metadata),
        backup,
        key,
      })
    }
  }
  return out
}

/**
 * Tag → the account's installed keys. A `TagValidationError` is `notFound`; transport failures
 * from either read propagate. Lists the first {@link MAX_PASSKEY_CANDIDATES} entries that carry a
 * 64-byte key; `unreadable` when none of them has a metadata kind a sign-in can answer for.
 */
export async function readPasskeyCredentialsByTag(
  tag: string,
  deps: PasskeyCredentialsByTagDeps,
): Promise<PasskeyCredentialsByTag> {
  let resolution: RegistryTagResolution
  try {
    resolution = await deps.resolveTag(tag)
  } catch (err) {
    if (err instanceof TagValidationError) return { kind: "notFound" }
    throw err
  }
  if (resolution.status === "notFound") return { kind: "notFound" }
  if (resolution.status === "staleRollup") return { kind: "staleRollup" }

  const account = resolution.account as Address
  const { entries, authKeyCount } = await deps.readAuthKeys(account)
  if (authKeyCount === 0) return { kind: "noKeyInstalled", account }
  // The read covered every key only when the account holds no more than are listed below.
  const complete = authKeyCount <= Math.min(entries.length, MAX_PASSKEY_CANDIDATES)

  const keys: InstalledPasskey[] = []
  for (const entry of entries.slice(0, MAX_PASSKEY_CANDIDATES)) {
    const pubkeyHex = authKeyPubkeyHex(entry)
    if (pubkeyHex)
      keys.push({ pubkeyHex, metadata: entry.metadata, parsed: parseKeyMetadata(entry.metadata) })
  }
  if (!keys.some((k) => k.parsed.kind !== "unknown")) {
    return { kind: "unreadable", account, complete }
  }
  return {
    kind: "resolved",
    account,
    l2Address: resolution.l2Address,
    keys,
    // A key that is not 64 bytes cannot be a set member, so the set read is not whole.
    complete: complete && keys.length === Math.min(entries.length, MAX_PASSKEY_CANDIDATES),
    authKeyCount,
  }
}

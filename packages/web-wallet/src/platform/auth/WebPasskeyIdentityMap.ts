import { withFeePayer, type IStorageAdapter } from "@obsidion/front-core"
import type { AccountKey } from "@obsidion/passkey-web"
import type { FeePayerEntry, RecoveryMetadata } from "@obsidion/sdk"
import { PASSKEY_IDENTITY_MAP_KEY as STORAGE_KEY, WEB_STORAGE_PREFIX } from "../storage/storageKeys"
import { readFromOtherDatabases, walletStorage } from "../storage/walletStorage"
import { withWebLock } from "../storage/webLock"
const MAP_VERSION = 1
const LOCK_NAME = "webwallet.passkey-identity-map"

/** Every mutation of the map runs under one lock, so two tabs cannot erase each other's writes. */
const withMapLock = <T>(fn: () => Promise<T>) => withWebLock(LOCK_NAME, fn)

/**
 * The record as a reader sees it. `userHandle` is the passkey's `user.id`, base64url, from its
 * creation. `securityKey` is the creation driver's verdict, kept apart from `authenticatorType`,
 * which every sign-up record writes as platform.
 */
export type StoredRecoveryMetadata = RecoveryMetadata & { userHandle?: string; securityKey?: true }

/** Where a synced passkey answered a laptop's prompt from: a phone over QR, or this computer. */
export type PasskeyAnswer = "remote" | "local"

/** `usertag` is the claimed tag in the exact form that hashes to the on-chain nameHash. */
type StoredEntry = StoredRecoveryMetadata & {
  rpId: string
  createdAt: number
  usertag?: string
  answered?: PasskeyAnswer
  /** When a session last committed with this passkey here. */
  usedAt?: number
}
type StoredMap = { version: number; entries: Record<string, StoredEntry> }

function parseMap(raw: string | null): StoredMap | undefined {
  try {
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as StoredMap
    return parsed?.entries && typeof parsed.entries === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

function readMap(): StoredMap | undefined {
  return parseMap(walletStorage.getItem(WEB_STORAGE_PREFIX + STORAGE_KEY))
}

/** Raw 64-byte `x‖y` as lowercase hex without `0x`, the form every key comparison uses. */
const normalKey = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()

/**
 * Whether a record opens the wallet: its PRF derives the master key (a root), or opens an
 * envelope holding it (a backup). A rotated signing credential does neither.
 */
export function opensWallet(record: Pick<RecoveryMetadata, "isMskRoot" | "backup">): boolean {
  return record.isMskRoot || record.backup !== undefined
}

/**
 * Sync probe for route gating: does this device hold a breadcrumb for a passkey that opens a
 * wallet under `rpId`? Reads the partition directly (the adapter is async but backed by the same
 * store) so the router can gate without a loading frame. A breadcrumb only proves a passkey WAS
 * recorded here — deletion at the authenticator is invisible until an assertion fails.
 */
export function hasOpeningBreadcrumb(rpId: string): boolean {
  return Object.values(readMap()?.entries ?? {}).some((e) => e?.rpId === rpId && opensWallet(e))
}

/** Sync probe: does this device hold a record with an address for `credentialId` under `rpId`? */
export function hasRecordFor(rpId: string, credentialId: string): boolean {
  const entry = readMap()?.entries[credentialId]
  return entry?.rpId === rpId && Boolean(entry.l2Address)
}

/** What the payment screen's passkey advice reads from a record. */
export type AnswerRecord = Pick<
  StoredEntry,
  "answered" | "prfAaguid" | "transports" | "inferredTransports"
>

/**
 * Sync probe: where this credential's passkey answered from, and what is known of its
 * authenticator. Takes no RP: it is asked about the session's own credential, and `answered` is
 * only ever written under the entry's RP.
 */
export function answerRecordFor(credentialId: string): AnswerRecord | undefined {
  return readMap()?.entries[credentialId]
}

/**
 * The tag this credential claimed, so /enter can name a recovered claim without
 * asking for it. Only ever a HINT: the caller re-hashes it against the on-chain
 * nameHash, so a stale or absent one costs a manual confirm, never a wrong
 * identity. Absent on a browser that has never held this account (the tag lives
 * on-chain as a hash and nowhere else), which is why /enter keeps the prompt.
 */
export function usertagFor(rpId: string, credentialId: string): string | undefined {
  const entry = readMap()?.entries[credentialId]
  return entry?.rpId === rpId ? entry.usertag : undefined
}

/** The handle this credential was created under on this browser; the key a rename needs. */
export function userHandleFor(rpId: string, credentialId: string): string | undefined {
  const entry = readMap()?.entries[credentialId]
  return entry?.rpId === rpId ? entry.userHandle : undefined
}

/** What this browser recorded of the authenticator holding the passkey for a pubkey. */
export type AuthenticatorRecord = Pick<
  StoredEntry,
  "prfAaguid" | "authenticatorType" | "securityKey" | "transports" | "inferredTransports" | "usedAt"
>

/** The authenticator this browser recorded for the passkey holding `pubkeyHex`, if it ever held one. */
export function authenticatorFor(pubkeyHex: string): AuthenticatorRecord | undefined {
  const key = normalKey(pubkeyHex)
  return Object.values(readMap()?.entries ?? {}).find(
    (e) => typeof e?.pubkey === "string" && normalKey(e.pubkey) === key,
  )
}

/** A remembered account for the sign-in screen: a record that opens a wallet and names the tag it claimed. */
export type RememberedAccount = {
  credentialId: string
  /** Raw 64-byte `x‖y` as lowercase hex without `0x`, the candidate form a pinned sign-in takes. */
  pubkeyHex: string
  l2Address: string
  usertag: string
  /** The row's passkey opens the wallet through its envelope, so the screen can label it. */
  backup: boolean
}

/**
 * A key of a wallet's set, with this browser's record that opens the wallet with it, when it holds
 * one, as a sign-in names the key.
 */
export type WalletKey = { pubkeyHex: string; record?: AccountKey }

/**
 * The keys of the set `credentialId`'s record names, in its order. Undefined unless that record
 * opens a wallet under `rpId`. Sync, for the screens that offer a choice among them.
 */
export function walletKeysFor(rpId: string, credentialId: string): WalletKey[] | undefined {
  const map = readMap()?.entries ?? {}
  const own = map[credentialId]
  if (!wellFormedUnder(own, rpId) || !opensWallet(own)) return undefined
  const address = own.l2Address.toLowerCase()
  const opening = Object.values(map).filter(
    (e): e is WellFormedEntry =>
      wellFormedUnder(e, rpId) && opensWallet(e) && e.l2Address.toLowerCase() === address,
  )
  const set = [...new Set((own.passkeySet ?? [own.pubkey]).map(normalKey))]
  return set.map((pubkeyHex) => {
    const e =
      normalKey(own.pubkey) === pubkeyHex
        ? own
        : opening.find((r) => normalKey(r.pubkey) === pubkeyHex)
    return e ? { pubkeyHex, record: accountKeyOf(e) } : { pubkeyHex }
  })
}

/** An entry with the fields a sign-in reads: its credential, its signing key and its address. */
type WellFormedEntry = StoredEntry & { credentialId: string; pubkey: string; l2Address: string }

const wellFormedUnder = (e: StoredEntry | undefined, rpId: string): e is WellFormedEntry =>
  e?.rpId === rpId &&
  typeof e.credentialId === "string" &&
  typeof e.pubkey === "string" &&
  typeof e.l2Address === "string" &&
  Boolean(e.l2Address)

const accountKeyOf = (e: WellFormedEntry): AccountKey => ({
  credentialId: e.credentialId,
  backup: e.backup !== undefined,
  ...(e.prfAaguid ? { aaguid: e.prfAaguid } : {}),
  ...(typeof e.usedAt === "number" ? { usedAt: e.usedAt } : {}),
})

/**
 * Every record under `rpId` that opens a wallet and carries a claimed tag, newest first: the
 * sign-in screen's remembered-account rows. Sync, like the probes above, so the screen renders
 * without a loading frame. No cap — the screen shows five rows and scrolls the rest.
 */
export function listUsertagCandidates(rpId: string): RememberedAccount[] {
  return candidatesIn(readMap(), rpId, opensWallet)
}

/**
 * The same rows from this browser's other rollups' databases, roots only: a retired backup's
 * envelope is not in the current map, and a row naming only its credential would send it down the
 * discovery path, where its way in is the tag. A move to a new rollup starts an empty database
 * there, so its accounts are found in the ones before it. Hints only, as on the active rollup:
 * nothing is copied over, and a malformed map lists nothing.
 */
export async function listRetiredUsertagCandidates(rpId: string): Promise<RememberedAccount[]> {
  const maps = await readFromOtherDatabases(WEB_STORAGE_PREFIX + STORAGE_KEY)
  return maps.flatMap((raw) => candidatesIn(parseMap(raw), rpId, (e) => Boolean(e.isMskRoot)))
}

/** A record from another rollup's identity map, with the tag it names as a hint. */
export type RetiredRecord = StoredRecoveryMetadata & { usertag?: string }

/**
 * `credentialId`'s record in a raw identity map from another rollup's database, when it opens a
 * wallet under `rpId` and its key is in its own set.
 */
export function openingRecordIn(
  raw: string | undefined,
  rpId: string,
  credentialId: string,
): RetiredRecord | undefined {
  const entry = parseMap(raw ?? null)?.entries[credentialId]
  if (entry?.rpId !== rpId || !opensWallet(entry) || typeof entry.pubkey !== "string") return
  const set: unknown = entry.passkeySet ?? [entry.pubkey]
  if (!Array.isArray(set) || !set.every((key) => typeof key === "string")) return
  return set.map(normalKey).includes(normalKey(entry.pubkey)) ? entry : undefined
}

const createdAt = (e: StoredEntry) => (typeof e.createdAt === "number" ? e.createdAt : 0)

function candidatesIn(
  map: StoredMap | undefined,
  rpId: string,
  admits: (e: StoredEntry) => boolean,
): RememberedAccount[] {
  return Object.values(map?.entries ?? {})
    .filter(
      (e): e is WellFormedEntry & { usertag: string } =>
        wellFormedUnder(e, rpId) &&
        admits(e) &&
        typeof e.usertag === "string" &&
        Boolean(e.usertag),
    )
    .sort((a, b) => createdAt(b) - createdAt(a))
    .map((e) => ({
      credentialId: e.credentialId,
      pubkeyHex: normalKey(e.pubkey),
      l2Address: e.l2Address,
      usertag: e.usertag,
      backup: e.backup !== undefined,
    }))
}

/** `stillOwns` is asked under the lock: a hint whose sign-in ended while waiting is not written. */
export function rememberUsertag(
  rpId: string,
  credentialId: string,
  usertag: string,
  stillOwns?: () => boolean,
): Promise<void> {
  return withMapLock(async () => {
    if (stillOwns && !stillOwns()) return
    const map = readMap()
    const entry = map?.entries[credentialId]
    if (!map || entry?.rpId !== rpId || entry.usertag === usertag) return
    map.entries[credentialId] = { ...entry, usertag }
    await walletStorage.commitItem(WEB_STORAGE_PREFIX + STORAGE_KEY, JSON.stringify(map))
  })
}

/**
 * Recovery-breadcrumb store (`credentialId → RecoveryMetadata`). Browser
 * storage is device-local, so a fresh browser legitimately has no record —
 * callers must handle map-less recovery (pubkey recovery + verify-before-
 * commit) rather than treat absence as an error. Entries are tagged with the
 * RP they were registered under and ignored when read under a different RP.
 */
export class WebPasskeyIdentityMap {
  constructor(private readonly storage: IStorageAdapter, private readonly rpId: string) {}

  private async load(): Promise<StoredMap> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY)
      if (!raw) return { version: MAP_VERSION, entries: {} }
      const parsed = JSON.parse(raw) as StoredMap
      if (
        parsed.version !== MAP_VERSION ||
        !parsed.entries ||
        typeof parsed.entries !== "object" ||
        Array.isArray(parsed.entries)
      ) {
        return { version: MAP_VERSION, entries: {} }
      }
      return parsed
    } catch {
      return { version: MAP_VERSION, entries: {} }
    }
  }

  /**
   * `stillOwns` is asked under the lock, before the write: a caller whose operation ended writes
   * nothing. A set that lacks the record's own key is a programming error and is refused before
   * the lock. A write without a `backup` drops a stored one; a `backup` write is stored as a non-root.
   */
  async upsert(meta: StoredRecoveryMetadata, stillOwns?: () => boolean): Promise<void> {
    if (meta.passkeySet && !meta.passkeySet.some((k) => normalKey(k) === normalKey(meta.pubkey))) {
      throw new Error("the passkey set does not contain the record's own key")
    }
    await withMapLock(async () => {
      if (stillOwns && !stillOwns()) return
      const map = await this.load()
      if (stillOwns && !stillOwns()) return
      // Spread the existing entry first: re-recording a credential (every /enter) must not drop
      // the usertag hint written after the claim.
      const stored = map.entries[meta.credentialId]
      const previous = stored?.rpId === this.rpId ? stored : undefined
      // An inference is only ever written by `setInferredTransports`; a stored one survives here.
      // A creation list is written once: a stored one stays, whatever this write carries.
      const { inferredTransports: _, transports: incoming, backup: _backup, ...record } = meta
      const transports = previous?.transports ?? incoming
      const { backup: _stored, ...kept } = previous ?? {}
      map.entries[meta.credentialId] = {
        ...kept,
        ...record,
        ...(transports ? { transports } : {}),
        ...(meta.backup ? { backup: meta.backup, isMskRoot: false } : {}),
        rpId: this.rpId,
        createdAt: Date.now(),
      }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  /**
   * Set the transports this browser's assertions implied, on an entry that exists for this RP and
   * carries neither a creation list nor an inference yet; `undefined` removes the inference. Judged
   * under the lock, so a racing creation-list write wins and a queued clear lands before a later
   * set. `stillOwns` is asked under the lock too: an attempt that ended while waiting writes nothing.
   * Nothing else on the entry changes.
   */
  async setInferredTransports(
    credentialId: string,
    transports: readonly string[] | undefined,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await withMapLock(async () => {
      if (stillOwns && !stillOwns()) return
      const map = await this.load()
      if (stillOwns && !stillOwns()) return
      const entry = map.entries[credentialId]
      if (entry?.rpId !== this.rpId) return
      if (transports) {
        if (entry.transports || entry.inferredTransports) return
        map.entries[credentialId] = { ...entry, inferredTransports: transports }
      } else {
        if (!entry.inferredTransports) return
        const { inferredTransports: _, ...rest } = entry
        map.entries[credentialId] = rest
      }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  /**
   * Record where the passkey last answered from, on an entry that exists for this RP. `stillOwns`
   * is asked under the lock, as in `setInferredTransports`.
   */
  async setAnswered(
    credentialId: string,
    where: PasskeyAnswer,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await withMapLock(async () => {
      if (stillOwns && !stillOwns()) return
      const map = await this.load()
      if (stillOwns && !stillOwns()) return
      const entry = map.entries[credentialId]
      if (entry?.rpId !== this.rpId) return
      if (entry.answered === where) return
      map.entries[credentialId] = { ...entry, answered: where }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  /** Stamp the passkey as the one a session just committed with, on an entry that exists for this RP. */
  async setUsed(credentialId: string): Promise<void> {
    await withMapLock(async () => {
      const map = await this.load()
      const entry = map.entries[credentialId]
      if (entry?.rpId !== this.rpId) return
      map.entries[credentialId] = { ...entry, usedAt: Date.now() }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  /**
   * Write the fee payer for one ClaimFPC instance on an entry that exists for this RP. Nothing else
   * on the entry changes, so the record keeps its place among the opening records.
   */
  async setFeePayer(credentialId: string, fpc: string, payer: FeePayerEntry): Promise<void> {
    await withMapLock(async () => {
      const map = await this.load()
      const entry = map.entries[credentialId]
      if (entry?.rpId !== this.rpId) return
      map.entries[credentialId] = {
        ...entry,
        feePayer: withFeePayer(entry, fpc, payer),
      }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  async get(credentialId: string): Promise<StoredRecoveryMetadata | undefined> {
    const entry = (await this.load()).entries[credentialId]
    return entry?.rpId === this.rpId ? entry : undefined
  }

  /** The root record of `l2Address` for this RP: the credential whose PRF derives its master key. */
  async getRootRecord(l2Address: string): Promise<StoredRecoveryMetadata | undefined> {
    const wanted = l2Address.toLowerCase()
    return Object.values((await this.load()).entries)
      .filter(
        (entry) =>
          entry?.rpId === this.rpId && entry.isMskRoot && entry.l2Address.toLowerCase() === wanted,
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /**
   * A record for this RP that opens a wallet: the one that opened `l2Address` when given (none
   * when this browser holds no such record for that account), else the most recently created.
   */
  async getOpeningRecord(l2Address?: string): Promise<RecoveryMetadata | undefined> {
    const wanted = l2Address?.toLowerCase()
    const entries = Object.values((await this.load()).entries)
      .filter((entry) => entry?.rpId === this.rpId && opensWallet(entry))
      .filter((entry) => wanted === undefined || entry.l2Address.toLowerCase() === wanted)
      .sort((a, b) => b.createdAt - a.createdAt)
    return entries[0]
  }

  async discardOtherRps(): Promise<void> {
    await withMapLock(async () => {
      const map = await this.load()
      const entries = Object.fromEntries(
        Object.entries(map.entries).filter(([, entry]) => entry?.rpId === this.rpId),
      )
      if (Object.keys(entries).length !== Object.keys(map.entries).length) {
        await this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...map, entries }))
      }
    })
  }

  async clear(): Promise<void> {
    await withMapLock(() => this.storage.removeItem(STORAGE_KEY))
  }
}

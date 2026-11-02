import { CONTACT_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter, StorageLock } from "./adapter.js"
import { logger } from "../../utils/logger"
import type { ReadonlyStore } from "../../engine/store"
import { legacyStore, type Sourced } from "../../engine/legacyStore"

/**
 * Address format a `Contact.address` is stored in:
 *   - `"aztec-l2"`            — a 32-byte Aztec L2 address (the real recipient).
 *   - `"ethereum-l1"`         — a 20-byte Ethereum L1 wallet address (deposit/recall).
 *   - `"pending-handshake"`   — a 20-byte XMTP/Ethereum-format handle from a QR
 *                               handshake before we know the peer's L2 address.
 *                               This is handshake state, not a payment route.
 */
export type AddressKind = "aztec-l2" | "ethereum-l1" | "pending-handshake"

export type L1WalletContactProvenance = "deposit-attested" | "saved-recipient"

/**
 * Root-level provenance for an L2 contact — distinct from the L1-only
 * `ContactL1Wallet.provenance`. Records *how* the L2 contact entered the book;
 * `"qr-scan"` marks a contact added via the QR/link handshake.
 */
export type ContactProvenance = "qr-scan"

export interface ContactAvatar {
  type: "image" | "gradient" | "initials"
  url?: string
  colorHex?: [string, string]
}

export interface ContactL1Wallet {
  provider: string
  walletId?: string
  walletName?: string
  imageUrl?: string
  provenance: L1WalletContactProvenance
  /**
   * The display name is a user-chosen label. Outranks auto-derived wallet names
   * in merges regardless of provenance — without it a label survives exactly
   * one deposit merge (`strongerProvenance` upgrades the row to
   * `deposit-attested`, after which the next deposit's wallet name wins).
   */
  userLabeled?: boolean
  /**
   * Lowercased prior addresses this row was edited away from. Deposit history
   * is immutable and independently feeds the withdraw "Recent" list, so
   * without this an address edit would resurrect the old address as a ghost
   * row (see `deriveRecentWithdrawWallets`).
   */
  replacedAddresses?: string[]
  /**
   * Set when the user removed this wallet from the withdraw picker. The row is
   * kept as a tombstone rather than hard-deleted — deposit history is immutable
   * and independently feeds the withdraw "Recent" list, so a hard delete would
   * let old deposit records resurrect the row. Consumers hide tombstoned rows
   * at read time; activity newer than this timestamp (a fresh deposit or a
   * manual re-save) revives the row (`mergeL1Contacts`).
   */
  deletedAt?: number
  lastUsedAt?: number
}

export interface Contact {
  name: string
  address: string
  /** Missing means legacy Aztec L2 contact. */
  addressKind?: AddressKind
  // L2-only / pending-handshake metadata
  tag?: string
  email?: string
  verified?: boolean
  /** How this L2 contact was added (e.g. `"qr-scan"`). Absent for legacy/manual adds. */
  provenance?: ContactProvenance
  /**
   * Added by the wallet, not the user: from an incoming transfer, or while a send that pays this
   * person's request is in flight. Its requests count as from a non-contact until the user adds or
   * pays it, or it pays one of the user's own requests.
   */
  autoAdded?: boolean
  /** Addresses this L2 contact held on retired rollups; its history there still matches them. */
  retiredAddresses?: string[]
  // L1-only (present iff addressKind === "ethereum-l1")
  avatar?: ContactAvatar
  l1Wallet?: ContactL1Wallet
}

/**
 * Identity descriptor for `removeEntry`, `modifyEntry`, and
 * `modifyEntryFromRegistry`. Replaced the bare-string-address parameter once
 * `Contact` started carrying L1 rows: the same Ethereum address string can
 * legally exist as both an L2 row and one or more L1 rows under different
 * providers.
 *
 * - Omit `addressKind` (or pass `"aztec-l2"`) to target an L2 row by address.
 * - For an L1 row, pass `addressKind: "ethereum-l1"` plus the `provider` slug
 *   that identifies the wallet (e.g. `"rainbow"`, `"metamask"`).
 *
 * Examples:
 *   removeEntry({ address })                                          // L2 default
 *   removeEntry({ address, addressKind: "ethereum-l1", provider })    // L1 row
 */
export interface ContactIdentity {
  address: string
  addressKind?: AddressKind
  provider?: string
}

export interface UpsertL1WalletContactInput {
  name: string
  address: string
  provider: string
  walletId?: string
  walletName?: string
  imageUrl?: string
  provenance: L1WalletContactProvenance
  userLabeled?: boolean
  avatar?: ContactAvatar
  lastUsedAt?: number
}

export interface UpdateL1WalletContactInput {
  /** Identity of the row being edited. */
  originalAddress: string
  provider: string
  /** New values. An empty/placeholder name falls back to "External Wallet". */
  name: string
  address: string
}

export interface DeleteL1WalletContactInput {
  /** Identity of the row being removed. */
  address: string
  provider: string
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, "").toLowerCase()
const normalizeAddress = (address: string): string => address.toLowerCase()
const addressKindOf = (entry: Contact): AddressKind => entry.addressKind ?? "aztec-l2"

/**
 * Provider slugs that don't pin a specific wallet app: the deposit path uses
 * `"unknown"` for unresolved senders and the withdraw-save path uses `"manual"`
 * for user-typed recipients. An L1 contact carrying one of these is treated as
 * "the same wallet" as any other row for the same address, so a user-saved
 * recipient and a later deposit-attested row collapse into
 * one contact instead of forking a duplicate. Two genuinely-different real
 * providers for one address stay distinct.
 */
/** Unresolved provider. */
const UNKNOWN_PROVIDER_SLUG = "unknown"
const GENERIC_L1_PROVIDERS: ReadonlySet<string> = new Set(["", UNKNOWN_PROVIDER_SLUG, "manual"])
const isGenericProvider = (provider: string | undefined): boolean =>
  !provider || GENERIC_L1_PROVIDERS.has(provider)

/** Display-name placeholder written for an L1 wallet with no user label / known wallet name. */
export const L1_PLACEHOLDER_NAME = "External Wallet"
/**
 * Whether an L1 wallet name is a real user label — non-empty (after trimming) and
 * not the "External Wallet" placeholder. The source of truth for the "show
 * the label, else the address" rule; the DS `ContactRow` mirrors this exact
 * rule (kept in lockstep by hand — it can't import front-core).
 */
export const isUserLabel = (name: string | null | undefined): boolean =>
  !!name && name.trim().length > 0 && name.trim() !== L1_PLACEHOLDER_NAME

/**
 * Whether two L1 provider slugs identify the same wallet for the same address.
 * A generic/unresolved provider (`unknown`/`manual`/empty) on either side
 * matches anything (a user-saved "manual"/"unknown" row and a deposit-attested
 * real-slug row are the same wallet); two genuinely-different real slugs stay
 * distinct. Shared by `sameL1WalletIdentity` (dedup-on-write) and
 * `matchesIdentity` (delete/modify targeting) so the two never drift — a delete
 * whose target provider came from the source record still hits the collapsed
 * row even after its provider upgraded to a real slug.
 */
export const l1WalletProvidersMatch = (a: string | undefined, b: string | undefined): boolean =>
  isGenericProvider(a) || isGenericProvider(b) || a === b

const sameL1WalletIdentity = (a: Contact, b: Contact): boolean => {
  if (addressKindOf(a) !== "ethereum-l1" || addressKindOf(b) !== "ethereum-l1") return false
  if (normalizeAddress(a.address) !== normalizeAddress(b.address)) return false
  return l1WalletProvidersMatch(a.l1Wallet?.provider, b.l1Wallet?.provider)
}

/**
 * Whether a contact's display name is a user-given label. The explicit
 * `userLabeled` flag is authoritative (it survives provenance upgrades on
 * merge); the saved-recipient-provenance check covers rows written before the
 * flag existed.
 */
const hasUserLabel = (contact: Contact): boolean => {
  if (!isUserLabel(contact.name)) return false
  return (
    contact.l1Wallet?.userLabeled === true || contact.l1Wallet?.provenance === "saved-recipient"
  )
}

/** Tombstoned by a user removal (see `ContactL1Wallet.deletedAt`). */
const isDeletedL1 = (contact: Contact): boolean => contact.l1Wallet?.deletedAt !== undefined

/**
 * Merge rule for the display name of two same-address L1 contacts. A user-given
 * label outranks an auto-derived deposit/provider name; among the same rank a
 * real label beats the "External Wallet" placeholder; the incoming (newer) side
 * wins ties so a rename takes effect.
 */
const mergeL1Name = (existing: Contact, incoming: Contact): string => {
  const exUserLabel = hasUserLabel(existing)
  const inUserLabel = hasUserLabel(incoming)
  if (inUserLabel) return incoming.name
  if (exUserLabel) return existing.name
  if (isUserLabel(incoming.name)) return incoming.name
  if (isUserLabel(existing.name)) return existing.name
  return incoming.name || existing.name
}

/**
 * Merge rule for the provider slug of two same-address L1 contacts. A real
 * wallet slug always wins over a generic (`unknown`/`manual`) one so the merged
 * row keeps a stable, real-provider identity (and a stable row id); the incoming
 * side wins when both are real.
 */
const mergeProvider = (existing: string | undefined, incoming: string | undefined): string => {
  if (!isGenericProvider(incoming)) return incoming as string
  if (!isGenericProvider(existing)) return existing as string
  // Both generic: canonicalize to `"unknown"` so the derived
  // row id (`l1:<provider>:<address>`) is stable regardless of
  // write/load order ("manual" vs "unknown" would otherwise flip the id).
  return UNKNOWN_PROVIDER_SLUG
}

/**
 * Field-merge two same-address L1 contacts into one. Prefers a user label over
 * an auto name (`mergeL1Name`), a real provider over a generic one
 * (`mergeProvider`), the strongest provenance (`strongerProvenance`), and the
 * most-recent `lastUsedAt`. Used by both the live upsert and the load-time
 * duplicate reconciliation.
 */
const mergeL1Contacts = (existing: Contact, incoming: Contact): Contact => {
  const ew = existing.l1Wallet
  const iw = incoming.l1Wallet
  const replacedAddresses = [
    ...new Set([...(ew?.replacedAddresses ?? []), ...(iw?.replacedAddresses ?? [])]),
  ]
  const lastUsedAt = Math.max(ew?.lastUsedAt ?? 0, iw?.lastUsedAt ?? 0)
  const deletedAt = Math.max(ew?.deletedAt ?? 0, iw?.deletedAt ?? 0)
  return {
    ...existing,
    name: mergeL1Name(existing, incoming),
    address: incoming.address,
    addressKind: "ethereum-l1",
    avatar: incoming.avatar ?? existing.avatar,
    l1Wallet: {
      provider: mergeProvider(ew?.provider, iw?.provider),
      walletId: iw?.walletId ?? ew?.walletId,
      walletName: iw?.walletName ?? ew?.walletName,
      imageUrl: iw?.imageUrl ?? ew?.imageUrl,
      provenance: strongerProvenance(ew?.provenance, iw?.provenance ?? "saved-recipient"),
      userLabeled: ew?.userLabeled || iw?.userLabeled || undefined,
      replacedAddresses: replacedAddresses.length > 0 ? replacedAddresses : undefined,
      // Activity newer than the removal revives a tombstone; deletion wins ties.
      deletedAt: deletedAt > 0 && deletedAt >= lastUsedAt ? deletedAt : undefined,
      lastUsedAt,
    },
  }
}

/**
 * Collapse pre-existing duplicate L1 rows that the relaxed `sameL1WalletIdentity`
 * now considers the same wallet (e.g. a `"manual"` saved-recipient row + a
 * real-slug deposit-attested row for one address). Order-preserving; merges into
 * the first surviving row. Runs once on load so existing users' duplicates clear
 * without waiting for the next deposit/save.
 */
const reconcileL1Duplicates = (entries: Contact[]): Contact[] => {
  const result: Contact[] = []
  for (const entry of entries) {
    if (addressKindOf(entry) !== "ethereum-l1") {
      result.push(entry)
      continue
    }
    const existingIndex = result.findIndex((e) => sameL1WalletIdentity(e, entry))
    if (existingIndex === -1) {
      result.push(entry)
    } else {
      result[existingIndex] = mergeL1Contacts(result[existingIndex], entry)
    }
  }
  return result
}

const sameAddressIdentity = (a: Contact, b: Contact): boolean => {
  const kindA = addressKindOf(a)
  const kindB = addressKindOf(b)
  if (kindA !== kindB) return false
  if (kindA === "ethereum-l1") return sameL1WalletIdentity(a, b)
  return normalizeAddress(a.address) === normalizeAddress(b.address)
}

const sameTag = (a: Contact, b: Contact): boolean =>
  !!a.tag && !!b.tag && a.tag.toLowerCase() === b.tag.toLowerCase()

const withoutAutoAdded = (entry: Contact): Contact => {
  const approved = { ...entry }
  delete approved.autoAdded
  return approved
}

/**
 * Loose collision check for the idempotent `addOrMergeContact` path: two
 * entries "are the same contact" if they match by address-identity OR share a
 * `tag` OR share a normalized display name. Unlike `sameAddressIdentity` (which
 * keys strictly on the address), this also folds tag/name collisions into a
 * no-op so the qr-scan add never trips the throwing duplicate validators.
 */
const collidesIdentity = (a: Contact, b: Contact): boolean => {
  if (sameAddressIdentity(a, b)) return true
  if (a.tag && b.tag && a.tag === b.tag) return true
  return normalizeName(a.name) === normalizeName(b.name)
}

const matchesIdentity = (entry: Contact, target: ContactIdentity): boolean => {
  const targetKind = target.addressKind ?? "aztec-l2"
  if (addressKindOf(entry) !== targetKind) return false
  if (targetKind === "ethereum-l1") {
    if (!l1WalletProvidersMatch(entry.l1Wallet?.provider, target.provider)) return false
  }
  return normalizeAddress(entry.address) === normalizeAddress(target.address)
}

const strongerProvenance = (
  current: L1WalletContactProvenance | undefined,
  incoming: L1WalletContactProvenance,
): L1WalletContactProvenance => {
  if (current === "deposit-attested" || incoming === "deposit-attested") return "deposit-attested"
  return incoming
}

export class ContactStorage {
  private static instance: ContactStorage | null = null
  private storage: IStorageAdapter
  private entries: Contact[] = []
  private loadPromise: Promise<void> | null = null
  /** Cross-context write mutex (web: navigator.locks). Absent = writes run directly. */
  private lock?: StorageLock
  private listeners = new Set<() => void>()
  /** The entries, read again after every change. */
  readonly rows: ReadonlyStore<Sourced<readonly Contact[]>> = legacyStore<readonly Contact[]>(
    { read: () => this.getEntries(), subscribe: (listener) => this.onChange(listener) },
    [],
  )

  private constructor(storage: IStorageAdapter, lock?: StorageLock) {
    this.storage = storage
    this.lock = lock
    // Another context wrote the book — drop the cache so the next read reloads.
    storage.subscribe?.(CONTACT_STORAGE_KEY, () => {
      this.loadPromise = null
      this.notify()
    })
  }

  /**
   * Fires after every write, this context's or another's. Background writers (the XMTP receive
   * pipeline auto-adding a verified sender) are why long-lived views can't just read once on mount.
   * Returns the unsubscribe.
   */
  public onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  static get(storage?: IStorageAdapter, lock?: StorageLock): ContactStorage {
    if (!ContactStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }

      ContactStorage.instance = new ContactStorage(storage, lock)
    }
    return ContactStorage.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    ContactStorage.instance = null
  }

  /**
   * Single-flight load. Subsequent callers share the in-flight promise.
   * Rejected loads clear the cached promise so a transient adapter failure
   * doesn't permanently lock the singleton — the next public call retries.
   */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.doLoad().catch((error) => {
        this.loadPromise = null
        throw error
      })
    }
    return this.loadPromise
  }

  /** Public initializer: loads persisted entries. */
  public async initialize(): Promise<void> {
    await this.ensureLoaded()
  }

  private async doLoad(): Promise<void> {
    const raw = await this.storage.getItem(CONTACT_STORAGE_KEY)
    if (raw === null) {
      this.entries = []
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(CONTACT_STORAGE_KEY)
      this.entries = []
      return
    }

    if (!Array.isArray(parsed)) {
      // Old per-network or per-network+per-wallet shape. Wipe and treat as empty.
      await this.storage.removeItem(CONTACT_STORAGE_KEY)
      this.entries = []
      return
    }

    const cleaned: Contact[] = []
    let droppedAny = false
    for (const candidate of parsed) {
      if (this.isValidEntry(candidate)) {
        cleaned.push(candidate)
      } else {
        droppedAny = true
      }
    }

    // One-time reconciliation: collapse any pre-existing duplicate L1 rows for
    // the same address that the relaxed identity now treats as one wallet
    // (a "manual" saved-recipient row + a real-slug deposit-attested row).
    const reconciled = reconcileL1Duplicates(cleaned)

    this.entries = reconciled
    if (droppedAny || reconciled.length !== cleaned.length) {
      // Persist the cleaned/reconciled array so the same dirty data isn't
      // re-filtered or re-merged next launch.
      await this.saveToStorage()
    }
  }

  /**
   * Shape validation only. Address-format value validation runs at write time
   * via `validate.ts > addContactSchema`; storage validation only needs to keep
   * on-disk corruption from poisoning the in-memory list.
   *
   * Rules (aligned with `addContactSchema` shape semantics):
   *   - L1 row (`addressKind === "ethereum-l1"`): require `l1Wallet` shape with
   *     non-empty `provider` and known `provenance`.
   *   - L2 row with stray `l1Wallet`: still validate `l1Wallet` shape (drop on
   *     malformed) — `addContactSchema` validates the field whenever present.
   *   - Legacy L2 row without `l1Wallet`: no L1 validation.
   */
  private isValidEntry(value: unknown): value is Contact {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    if (typeof v.name !== "string" || typeof v.address !== "string") return false
    // Match `validate.ts > addContactSchema` — `name: z.string().min(1)`. An
    // empty name on disk surfaces as a blank contact row in the UI; drop it.
    if (v.name.length === 0) return false
    if (v.tag !== undefined && typeof v.tag !== "string") return false
    if (v.email !== undefined && typeof v.email !== "string") return false
    if (v.verified !== undefined && typeof v.verified !== "boolean") return false
    if (v.provenance !== undefined && v.provenance !== "qr-scan") return false
    if (v.autoAdded !== undefined && typeof v.autoAdded !== "boolean") return false
    if (
      v.retiredAddresses !== undefined &&
      (!Array.isArray(v.retiredAddresses) || v.retiredAddresses.some((a) => typeof a !== "string"))
    ) {
      return false
    }

    const addressKind = v.addressKind
    if (
      addressKind !== undefined &&
      addressKind !== "aztec-l2" &&
      addressKind !== "ethereum-l1" &&
      addressKind !== "pending-handshake"
    ) {
      return false
    }
    if (addressKind === "pending-handshake" && v.provenance !== "qr-scan") return false

    if (v.avatar !== undefined && !this.isValidAvatar(v.avatar)) return false

    const l1Wallet = v.l1Wallet
    if (l1Wallet !== undefined) {
      if (!this.isValidL1Wallet(l1Wallet)) return false
    } else if (addressKind === "ethereum-l1") {
      // L1 rows require l1Wallet metadata; otherwise dedup can't disambiguate.
      return false
    }

    return true
  }

  private isValidAvatar(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    if (v.type !== "image" && v.type !== "gradient" && v.type !== "initials") return false
    if (v.url !== undefined && typeof v.url !== "string") return false
    if (v.colorHex !== undefined) {
      if (!Array.isArray(v.colorHex) || v.colorHex.length !== 2) return false
      if (typeof v.colorHex[0] !== "string" || typeof v.colorHex[1] !== "string") return false
    }
    return true
  }

  private isValidL1Wallet(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    if (typeof v.provider !== "string" || v.provider.length === 0) return false
    if (v.provenance !== "deposit-attested" && v.provenance !== "saved-recipient") return false
    if (v.walletId !== undefined && typeof v.walletId !== "string") return false
    if (v.walletName !== undefined && typeof v.walletName !== "string") return false
    if (v.imageUrl !== undefined && typeof v.imageUrl !== "string") return false
    if (v.userLabeled !== undefined && typeof v.userLabeled !== "boolean") return false
    if (v.replacedAddresses !== undefined) {
      if (!Array.isArray(v.replacedAddresses)) return false
      if (v.replacedAddresses.some((address) => typeof address !== "string")) return false
    }
    if (v.deletedAt !== undefined && typeof v.deletedAt !== "number") return false
    if (v.lastUsedAt !== undefined && typeof v.lastUsedAt !== "number") return false
    return true
  }

  private async saveToStorage(): Promise<void> {
    await this.storage.setItem(CONTACT_STORAGE_KEY, JSON.stringify(this.entries))
    this.notify()
  }

  /**
   * Every read-modify-write runs through here. With a lock, the persisted book is re-read inside
   * the critical section so this write layers on top of any other context's — two tabs' adds can
   * never clobber each other. Without a lock the write runs directly on the cached book.
   */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.lock) {
      return (async () => {
        await this.ensureLoaded()
        return fn()
      })()
    }
    return this.lock(async () => {
      this.loadPromise = null
      await this.ensureLoaded()
      return fn()
    })
  }

  public async getEntries(): Promise<Contact[]> {
    await this.ensureLoaded()
    return this.entries
  }

  public async findByTag(tag: string): Promise<Contact | undefined> {
    await this.ensureLoaded()
    return this.entries.find((entry) => entry.tag === tag)
  }

  /**
   * Adding a person the wallet added (`autoAdded`) approves the existing row instead. When that row
   * has another tag at the same address (e.g. the tag changed since the wallet added it), the user's
   * entry replaces it.
   */
  public async addEntry(entry: Contact): Promise<void> {
    await this.mutate(async () => {
      const index = this.autoAddedIndex(entry)
      if (index === -1) {
        this.validateDuplicateEntry(entry)
        this.entries.push(entry)
      } else if (sameTag(this.entries[index], entry)) {
        this.entries[index] = withoutAutoAdded(this.entries[index])
      } else {
        this.validateDuplicateEntryExcluding(entry, this.entries[index])
        this.entries[index] = entry
      }
      await this.saveToStorage()
    })
  }

  public async addEntries(entries: Contact[]): Promise<void> {
    await this.mutate(async () => {
      for (const entry of entries) {
        this.validateDuplicateEntry(entry)
      }
      this.entries.push(...entries)
      await this.saveToStorage()
    })
  }

  /**
   * Adds another book's contacts, skipping each one this book already holds by address or tag. A
   * skipped L2 contact's addresses join the held contact's `retiredAddresses`, so its history still
   * shows. An L2 contact whose name another contact holds falls back to its tag; wallet names may
   * repeat. Returns how many were added.
   */
  public importContacts(entries: readonly unknown[]): Promise<number> {
    return this.mutate(async () => {
      let added = 0
      let merged = false
      for (const candidate of entries) {
        if (!this.isValidEntry(candidate)) continue
        const heldIndex = this.entries.findIndex((e) => sameTag(e, candidate))
        if (heldIndex !== -1) {
          merged = this.mergeRetiredAddresses(heldIndex, candidate) || merged
          continue
        }
        if (this.entries.some((e) => sameAddressIdentity(e, candidate))) continue
        const taken = (name: string) =>
          this.entries.some((e) => normalizeName(e.name) === normalizeName(name))
        let entry = candidate
        if (addressKindOf(entry) !== "ethereum-l1" && taken(entry.name)) {
          if (!entry.tag || taken(entry.tag)) continue
          entry = { ...entry, name: entry.tag }
        }
        this.entries.push(entry)
        added++
      }
      if (added > 0 || merged) await this.saveToStorage()
      return added
    })
  }

  /** Adds `from`'s L2 addresses to the retired ones of the L2 row at `index`; true when any was new. */
  private mergeRetiredAddresses(index: number, from: Contact): boolean {
    const held = this.entries[index]
    if (addressKindOf(held) !== "aztec-l2" || addressKindOf(from) !== "aztec-l2") return false
    const known = new Set([held.address, ...(held.retiredAddresses ?? [])].map(normalizeAddress))
    const fresh: string[] = []
    for (const address of [from.address, ...(from.retiredAddresses ?? [])]) {
      if (known.has(normalizeAddress(address))) continue
      known.add(normalizeAddress(address))
      fresh.push(address)
    }
    if (fresh.length === 0) return false
    this.entries[index] = {
      ...held,
      retiredAddresses: [...(held.retiredAddresses ?? []), ...fresh],
    }
    return true
  }

  /**
   * Points the L2 contact with `tag` at `l2Address`, unless another contact holds that address. The
   * old address joins `retiredAddresses`.
   */
  public updateL2Address(tag: string, l2Address: string): Promise<void> {
    return this.mutate(async () => {
      const needle = tag.toLowerCase()
      const index = this.entries.findIndex(
        (e) => addressKindOf(e) === "aztec-l2" && e.tag?.toLowerCase() === needle,
      )
      if (index === -1) return
      const address = normalizeAddress(l2Address)
      if (normalizeAddress(this.entries[index].address) === address) return
      if (
        this.entries.some(
          (e) => addressKindOf(e) === "aztec-l2" && normalizeAddress(e.address) === address,
        )
      ) {
        return
      }
      const { address: retired, retiredAddresses = [] } = this.entries[index]
      this.entries[index] = {
        ...this.entries[index],
        address: l2Address,
        retiredAddresses: [...retiredAddresses, retired],
      }
      await this.saveToStorage()
    })
  }

  /**
   * Auto-attestation upsert. Identity-merges by `(provider, addressLower)`
   * (`sameL1WalletIdentity`). This path **does not** run cross-kind
   * name uniqueness — blocking a deposit-attest because the user happens to
   * have an L2 contact with the same name would silently break the
   * deposit→withdraw recall product principle. User-initiated paths
   * (`addEntry`, `modifyEntry`) still validate names.
   */
  public upsertL1WalletContact(input: UpsertL1WalletContactInput): Promise<Contact> {
    return this.mutate(() => this.doUpsertL1WalletContact(input))
  }

  private async doUpsertL1WalletContact(input: UpsertL1WalletContactInput): Promise<Contact> {
    const now = Date.now()
    const incomingWallet: ContactL1Wallet = {
      provider: input.provider,
      walletId: input.walletId,
      walletName: input.walletName,
      imageUrl: input.imageUrl,
      provenance: input.provenance,
      userLabeled: input.userLabeled,
      lastUsedAt: input.lastUsedAt ?? now,
    }
    const incoming: Contact = {
      name: input.name,
      address: input.address,
      addressKind: "ethereum-l1",
      avatar:
        input.avatar ??
        (input.imageUrl
          ? {
              type: "image",
              url: input.imageUrl,
            }
          : undefined),
      l1Wallet: incomingWallet,
    }

    // `sameL1WalletIdentity` now collapses a generic-provider row (a "manual"
    // saved recipient / "unknown" deposit) into any same-address row, so a
    // user-saved label and a later deposit attestation for one address merge
    // into a single contact (`mergeL1Contacts` preserves the user label and
    // upgrades to the real provider) instead of forking a duplicate.
    const existingIndex = this.entries.findIndex((entry) => sameL1WalletIdentity(entry, incoming))
    if (existingIndex === -1) {
      this.entries.push(incoming)
      await this.saveToStorage()
      return incoming
    }

    const next = mergeL1Contacts(this.entries[existingIndex], incoming)
    this.entries[existingIndex] = next
    await this.saveToStorage()
    return next
  }

  /**
   * Names an L1 contact only if, inside the write lock, it is still live and unlabeled: a contact
   * renamed or removed since the caller read it is left as the user left it.
   */
  public nameUnlabeledL1Contact(
    identity: { address: string; provider: string },
    name: string,
  ): Promise<boolean> {
    return this.mutate(async () => {
      const probe: Contact = {
        name,
        address: identity.address,
        addressKind: "ethereum-l1",
        l1Wallet: { provider: identity.provider, provenance: "saved-recipient" },
      }
      const index = this.entries.findIndex((entry) => sameL1WalletIdentity(entry, probe))
      const entry = this.entries[index]
      if (!entry || isDeletedL1(entry) || isUserLabel(entry.name)) return false
      this.entries[index] = { ...entry, name }
      await this.saveToStorage()
      return true
    })
  }

  /**
   * User edit of an L1 wallet row (label and/or address), keyed by L1 identity
   * `(provider, originalAddress)`. Rewrites the row in place; when the address
   * changed, the prior address is recorded in `replacedAddresses` so
   * deposit-history echoes of it stop surfacing. A row backed only by deposit
   * history (no contact) is created as a fresh `saved-recipient` entry. Like
   * `upsertL1WalletContact`, this path skips name uniqueness — L1 rows
   * key on `(provider, address)` only. Throws when the new address collides
   * with a different existing L1 row.
   */
  public updateL1WalletContact(input: UpdateL1WalletContactInput): Promise<Contact> {
    return this.mutate(() => this.doUpdateL1WalletContact(input))
  }

  private async doUpdateL1WalletContact(input: UpdateL1WalletContactInput): Promise<Contact> {
    const trimmedName = input.name.trim()
    const name = isUserLabel(trimmedName) ? trimmedName : L1_PLACEHOLDER_NAME
    const userLabeled = isUserLabel(trimmedName) ? true : undefined
    const addressChanged =
      normalizeAddress(input.originalAddress) !== normalizeAddress(input.address)

    const identity: ContactIdentity = {
      address: input.originalAddress,
      addressKind: "ethereum-l1",
      provider: input.provider,
    }
    // Prefer a live row — the picker only offers live rows for editing, so a
    // tombstone match is a fallback (and an edit revives it, see below).
    const liveIndex = this.entries.findIndex(
      (entry) => matchesIdentity(entry, identity) && !isDeletedL1(entry),
    )
    const index =
      liveIndex !== -1
        ? liveIndex
        : this.entries.findIndex((entry) => matchesIdentity(entry, identity))

    if (index === -1) {
      const created: Contact = {
        name,
        address: input.address,
        addressKind: "ethereum-l1",
        l1Wallet: {
          provider: input.provider,
          provenance: "saved-recipient",
          userLabeled,
          lastUsedAt: Date.now(),
        },
      }
      const replaced = new Set(this.absorbDeletedL1Collisions(created))
      if (addressChanged) replaced.add(normalizeAddress(input.originalAddress))
      replaced.delete(normalizeAddress(input.address))
      created.l1Wallet!.replacedAddresses = replaced.size > 0 ? [...replaced] : undefined
      this.entries.push(created)
      await this.saveToStorage()
      return created
    }

    const original = this.entries[index]
    const wallet = original.l1Wallet as ContactL1Wallet
    const replaced = new Set(wallet.replacedAddresses ?? [])
    if (addressChanged) {
      replaced.add(normalizeAddress(original.address))
      for (const address of this.absorbDeletedL1Collisions(
        { ...original, address: input.address },
        original,
      )) {
        replaced.add(address)
      }
      // The new address is live again (A→B→A round-trip) — stop suppressing it.
      replaced.delete(normalizeAddress(input.address))
    }
    const updated: Contact = {
      ...original,
      name,
      address: input.address,
      l1Wallet: {
        ...wallet,
        userLabeled,
        replacedAddresses: replaced.size > 0 ? [...replaced] : undefined,
        // A user edit is a use — it revives a tombstoned row.
        deletedAt: undefined,
      },
    }
    const updatedIndex = this.entries.indexOf(original)
    this.entries[updatedIndex] = updated
    await this.saveToStorage()
    return updated
  }

  /**
   * Collision handling for a rewritten/created L1 row: a LIVE row with the
   * same identity is a real conflict (throws); tombstoned rows are absorbed —
   * their address is live again under the new row, which inherits their
   * `replacedAddresses` (returned for the caller to union in).
   */
  private absorbDeletedL1Collisions(candidate: Contact, exclude?: Contact): string[] {
    const colliders = this.entries.filter(
      (entry) => entry !== exclude && sameL1WalletIdentity(entry, candidate),
    )
    if (colliders.some((entry) => !isDeletedL1(entry))) {
      throw new Error("A saved wallet with this address already exists")
    }
    if (colliders.length === 0) return []
    this.entries = this.entries.filter((entry) => !colliders.includes(entry))
    return colliders.flatMap((entry) => entry.l1Wallet?.replacedAddresses ?? [])
  }

  /**
   * User removal of an L1 wallet row from the withdraw picker, keyed by L1
   * identity `(provider, address)`. Soft delete: the row is kept (or, for a
   * deposit-history-only row, created) as a tombstone via
   * `ContactL1Wallet.deletedAt` — see that field for why a hard delete won't
   * do. All fields (label, `replacedAddresses`, …) are preserved so a revival
   * gets them back.
   */
  public async deleteL1WalletContact(input: DeleteL1WalletContactInput): Promise<void> {
    await this.mutate(async () => {
      const identity: ContactIdentity = {
        address: input.address,
        addressKind: "ethereum-l1",
        provider: input.provider,
      }
      const index = this.entries.findIndex((entry) => matchesIdentity(entry, identity))
      if (index === -1) {
        this.entries.push({
          name: L1_PLACEHOLDER_NAME,
          address: input.address,
          addressKind: "ethereum-l1",
          l1Wallet: {
            provider: input.provider,
            provenance: "saved-recipient",
            deletedAt: Date.now(),
          },
        })
      } else {
        const entry = this.entries[index]
        this.entries[index] = {
          ...entry,
          l1Wallet: { ...(entry.l1Wallet as ContactL1Wallet), deletedAt: Date.now() },
        }
      }
      await this.saveToStorage()
    })
  }

  /**
   * No-op-on-duplicate contact add. The centralized add path for callers (e.g. the
   * QR handshake scanner/receiver) that must not throw when the contact already
   * exists. Unlike `addEntry` — which throws on any address/tag/name collision —
   * this is **idempotent and non-throwing on ANY duplicate identity**:
   *   - returns the existing entry unchanged when an existing row collides by
   *     address OR tag OR normalized name (idempotent re-add / merge), and
   *   - otherwise pushes the genuinely-new entry and persists.
   *
   * Rationale (qr-scan): a QR/link handshake hands us an externally-scanned
   * identity that is authoritative for THIS add — the scanner deliberately
   * scanned this code. A new L2 address whose tag or display name happens to
   * collide with an existing book entry must NOT throw: a throw here would (a)
   * surface to the scanner as a bogus "Invalid QR code" with no add, and (b)
   * on the receiver side bubble to the outer catch → `deferred` → the driver
   * re-presents the same connect-back every poll forever (burns the budget,
   * blob never deleted). Treating any identity collision as a no-op keeps the
   * operation idempotent and the handshake loop terminating.
   *
   * Returns the resulting (existing, upgraded, or newly-added) contact. Pending
   * handshake rows are allowed to upgrade to real L2 rows when a later scan or
   * connect-back brings the missing address. An entry without `autoAdded` approves an `autoAdded`
   * row with the same address and tag; a row with another tag stays as it is. The throwing
   * `addEntry` path is unchanged for its other (user-initiated) callers.
   */
  public addOrMergeContact(entry: Contact): Promise<Contact> {
    return this.mutate(async () => {
      const existingIndex = this.entries.findIndex((e) => collidesIdentity(e, entry))
      const existing = existingIndex === -1 ? undefined : this.entries[existingIndex]
      if (existing) {
        if (
          addressKindOf(existing) === "pending-handshake" &&
          addressKindOf(entry) === "aztec-l2"
        ) {
          this.entries[existingIndex] = entry
          await this.saveToStorage()
          return entry
        }
        const index = this.autoAddedIndex(entry)
        if (index !== -1 && sameTag(this.entries[index], entry)) {
          const approved = withoutAutoAdded(this.entries[index])
          this.entries[index] = approved
          await this.saveToStorage()
          return approved
        }
        return existing
      }

      this.entries.push(entry)
      await this.saveToStorage()
      return entry
    })
  }

  /** Makes the wallet-added L2 row at `l2Address` a full contact. Undefined when there is none. */
  public approveAutoAdded(l2Address: string): Promise<Contact | undefined> {
    return this.mutate(async () => {
      const needle = normalizeAddress(l2Address)
      const index = this.entries.findIndex(
        (e) =>
          e.autoAdded && addressKindOf(e) === "aztec-l2" && normalizeAddress(e.address) === needle,
      )
      if (index === -1) return undefined
      const approved = withoutAutoAdded(this.entries[index])
      this.entries[index] = approved
      await this.saveToStorage()
      return approved
    })
  }

  public async modifyEntry(entry: Contact, original: ContactIdentity): Promise<void> {
    await this.mutate(async () => {
      const originalEntry = this.entries.find((e) => matchesIdentity(e, original))
      if (!originalEntry) {
        throw new Error("Original entry not found")
      }

      if (!sameAddressIdentity(originalEntry, entry)) {
        this.validateDuplicateEntryExcluding(entry, originalEntry)
      } else {
        this.validateDuplicateNameExcluding(entry.name, originalEntry)
      }

      const index = this.entries.indexOf(originalEntry)
      if (index !== -1) {
        this.entries[index] = entry
        await this.saveToStorage()
      }
    })
  }

  public async modifyEntryFromRegistry(entry: Contact, original: ContactIdentity): Promise<void> {
    await this.mutate(() => this.doModifyEntryFromRegistry(entry, original))
  }

  private async doModifyEntryFromRegistry(
    entry: Contact,
    original: ContactIdentity,
  ): Promise<void> {
    const entryIndex = this.entries.findIndex((e) => matchesIdentity(e, original))
    if (entryIndex === -1) {
      const targetIndex = this.entries.findIndex((e) => sameAddressIdentity(e, entry))
      if (targetIndex !== -1) {
        this.entries[targetIndex] = entry
        await this.saveToStorage()
        return
      }

      this.entries.push(entry)
      await this.saveToStorage()
      return
    }

    const originalEntry = this.entries[entryIndex]
    if (!sameAddressIdentity(originalEntry, entry)) {
      const conflictingEntry = this.entries.find(
        (e) => sameAddressIdentity(e, entry) && e !== originalEntry,
      )

      if (conflictingEntry) {
        this.entries = this.entries.filter((e) => e !== conflictingEntry)
        const newEntryIndex = this.entries.indexOf(originalEntry)
        if (newEntryIndex !== -1) {
          this.entries[newEntryIndex] = entry
          await this.saveToStorage()
        } else {
          logger.error(`Original entry lost after removing conflict`)
        }
      } else {
        this.entries[entryIndex] = entry
        await this.saveToStorage()
      }
    } else {
      this.entries[entryIndex] = entry
      await this.saveToStorage()
    }
  }

  /** The `autoAdded` row at the address of an entry the user adds, or -1. */
  private autoAddedIndex(entry: Contact): number {
    if (entry.autoAdded) return -1
    return this.entries.findIndex((e) => e.autoAdded && sameAddressIdentity(e, entry))
  }

  private validateDuplicateEntry(entry: Contact): void {
    if (this.entries.some((e) => sameAddressIdentity(e, entry))) {
      throw new Error("Duplicate entry - address")
    }
    if (entry.tag && this.entries.some((e) => e.tag === entry.tag)) {
      throw new Error("Duplicate entry - tag")
    }
    if (entry.email && this.entries.some((e) => e.email === entry.email)) {
      throw new Error("Duplicate entry - email")
    }
    this.validateDuplicateName(entry.name)
  }

  private validateDuplicateName(name: string): void {
    const normalized = normalizeName(name)
    if (this.entries.some((e) => normalizeName(e.name) === normalized)) {
      throw new Error("Duplicate entry - name")
    }
  }

  private validateDuplicateEntryExcluding(entry: Contact, excludeEntry: Contact): void {
    if (this.entries.some((e) => sameAddressIdentity(e, entry) && e !== excludeEntry)) {
      throw new Error("Duplicate entry - address")
    }
    if (entry.tag && this.entries.some((e) => e.tag === entry.tag && e !== excludeEntry)) {
      throw new Error("Duplicate entry - tag")
    }
    if (entry.email && this.entries.some((e) => e.email === entry.email && e !== excludeEntry)) {
      throw new Error("Duplicate entry - email")
    }
    this.validateDuplicateNameExcluding(entry.name, excludeEntry)
  }

  private validateDuplicateNameExcluding(name: string, excludeEntry: Contact): void {
    const normalized = normalizeName(name)
    if (this.entries.some((e) => normalizeName(e.name) === normalized && e !== excludeEntry)) {
      throw new Error("Duplicate entry - name")
    }
  }

  public async removeEntry(target: ContactIdentity): Promise<void> {
    await this.mutate(async () => {
      this.entries = this.entries.filter((entry) => !matchesIdentity(entry, target))
      await this.saveToStorage()
    })
  }

  public async removeAllEntries(): Promise<void> {
    await this.mutate(async () => {
      this.entries = []
      await this.saveToStorage()
    })
  }

  public async clear(): Promise<void> {
    // mutate drains any in-flight load before tearing down state, otherwise a pending
    // doLoad could resume after the clear and re-persist stale data.
    await this.mutate(async () => {
      await this.storage.removeItem(CONTACT_STORAGE_KEY)
      this.entries = []
      this.loadPromise = null
    })
  }
}

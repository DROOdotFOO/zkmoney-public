import {
  ContactStorage,
  loadRecords,
  normalizeTag,
  TagValidationError,
  type Contact,
  type Transaction,
} from "@obsidion/front-core"
import { session } from "../../platform/session"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { addContact } from "./useInlineContactSearch"
import { resolveTagForCommit, resolveTagViaRegistry } from "./registryResolution"

/**
 * A registered tag opened from search but not saved. The contact page and its Send and Request
 * rails run on it; nothing is written until the user taps Add contact.
 */
export function unsavedContact(tag: string, l2Address: string): Contact {
  return { name: tag, tag, address: l2Address, addressKind: "aztec-l2" }
}

/** The L2 address the user's own transfers with this tag recorded, if any. */
export function pastAddressOf(
  tag: string,
  transactions: readonly Transaction[],
): string | undefined {
  const sameTag = (raw?: string) => !!raw && normalizeTag(raw) === tag
  for (const tx of transactions) {
    if (!("token" in tx) || !tx.token) continue
    if (tx.action === "send" && "toTag" in tx && sameTag(tx.toTag) && tx.to) return tx.to
    if (tx.action === "receive" && "from" in tx && sameTag(tx.from) && tx.senderL2Address)
      return tx.senderL2Address
  }
  return undefined
}

/**
 * The unsaved contact a route names, or null when it is not someone else's registered tag. A tag
 * still on an older zk.money opens at the address its past transfers used, so its history shows.
 */
export async function lookUpUnsavedContact(idOrTag: string): Promise<Contact | null> {
  const tag = normalizeTag(idOrTag)
  const own = loadWalletIdentity()?.handle
  if (!tag || (own && normalizeTag(own) === tag)) return null
  try {
    const resolution = await resolveTagViaRegistry(tag)
    if (resolution.status === "resolved") return unsavedContact(tag, resolution.l2Address)
    if (resolution.status === "notFound") return null
    const rows = await loadRecords(session().activity.query("peer", tag))
    const oldestFirst = [...rows].sort((a, b) => a.timestamp - b.timestamp)
    return unsavedContact(tag, pastAddressOf(tag, oldestFirst) ?? "")
  } catch (e) {
    if (e instanceof TagValidationError) return null
    throw e
  }
}

/**
 * Save an unsaved contact, but only the address the page showed and a fresh manifest still
 * confirms. "changed" means the registry moved on since the page resolved it.
 */
export async function saveUnsavedContact(contact: Contact): Promise<"added" | "changed"> {
  const tag = contact.tag
  if (!tag) return "changed"
  const fresh = await resolveTagForCommit(tag)
  if (fresh.status !== "resolved" || fresh.l2Address !== contact.address) return "changed"
  const entries = await ContactStorage.get().getEntries()
  // A row the wallet added is approved by the add below.
  if (entries.some((e) => e.tag === tag && !e.autoAdded)) return "added"
  const saved = await addContact(tag, contact.address, undefined, undefined, tag)
  if (!saved.success) throw new Error(saved.errors ?? "Could not add contact")
  return "added"
}

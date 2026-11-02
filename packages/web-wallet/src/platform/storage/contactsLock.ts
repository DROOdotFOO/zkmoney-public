/**
 * Cross-tab mutexes for storage read-modify-write cycles, backed by the Web Locks API so two tabs'
 * cycles serialize. Injected into the front-core stores at app construction.
 */
import type { StorageLock } from "@obsidion/front-core"

// Degrades to a direct call where Web Locks is unavailable.
const webLock =
  (name: string): StorageLock =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    navigator.locks?.request ? (navigator.locks.request(name, () => fn()) as Promise<T>) : fn()

/** Guards ContactStorage plus the connect handshake stores (distinct keys, one mutex). */
const CONTACTS_WRITE_LOCK = "contacts-write"
export const contactsWriteLock: StorageLock = webLock(CONTACTS_WRITE_LOCK)

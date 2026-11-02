import { useEffect, useSyncExternalStore } from "react"
import {
  BackupRotationStore,
  movesBalance,
  rerootAhead,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

/** The saved records; `loading` until the first read lands, `unreadable` while storage refuses to be read. */
export type BackupRotations = readonly BackupRotationRecord[] | "loading" | "unreadable"

/** A record, none, or why none can be told yet. */
export type BackupRotationState = BackupRotationRecord | null | "loading" | "unreadable"

let store: BackupRotationStore | undefined
const records = createExternalState<BackupRotations>("loading")

function read(from: BackupRotationStore): void {
  from.list().then(
    (next) => records.set(next),
    () => records.set("unreadable"),
  )
}

/** The signed-in account's pending rotation, one store per page load. */
export function getBackupRotationStore(): BackupRotationStore {
  if (!store) {
    store = new BackupRotationStore(webStorage)
    store.onChanged((next) => records.set(next))
    read(store)
  }
  return store
}

/** Reads the saved records again after a read failed. */
export function rereadBackupRotation(): void {
  if (store) read(store)
}

/**
 * Whether a backup passkey add on this device has yet to switch the account at `address` onto its
 * two-key account. A record not yet signed names no account, so it counts for any. Records not read
 * yet, or unreadable, hold nothing.
 */
export function rerootPending(records: BackupRotations, address: string | undefined): boolean {
  if (!address || typeof records === "string") return false
  const key = address.toLowerCase()
  return records.some(
    (record) =>
      rerootAhead(record) &&
      (!record.rotation || record.rotation.builtOver.l2Address.toLowerCase() === key),
  )
}

/** {@link rerootPending} over the saved records, kept current. */
export function useRerootPending(address: string | undefined): boolean {
  useEffect(() => {
    getBackupRotationStore()
  }, [])
  return rerootPending(useSyncExternalStore(records.subscribe, records.get, records.get), address)
}

/**
 * The pending rotation, if any: null once a read found none, `loading` before the first read lands
 * and `unreadable` while the saved records cannot be read; no add may start in either. With `owner`
 * only that L1 account's record counts; without it any account's does, for a surface that has not
 * read the account yet.
 */
export function useBackupRotation(owner?: string): BackupRotationState {
  useEffect(() => {
    getBackupRotationStore()
  }, [])
  const current = useSyncExternalStore(records.subscribe, records.get, records.get)
  if (typeof current === "string") return current
  if (owner === undefined) return current[0] ?? null
  const key = owner.toLowerCase()
  return current.find((record) => record.owner.toLowerCase() === key) ?? null
}

/**
 * Every rotation record on this device, kept current, whatever the settings flag says. A mount
 * reads again a store that could not be read.
 */
export function useBackupRotations(): BackupRotations {
  useEffect(() => {
    getBackupRotationStore()
    if (records.get() === "unreadable") rereadBackupRotation()
  }, [])
  return useSyncExternalStore(records.subscribe, records.get, records.get)
}

/**
 * Whether a rotation on this device moves the balance of the account at `address`, the one-key
 * account it leaves or the two-key one it lands on. Records not read yet, or unreadable, pause
 * nothing: sends are never blocked on storage the wallet cannot read.
 */
export function balanceMoving(records: BackupRotations, address: string | undefined): boolean {
  if (!address || typeof records === "string") return false
  const key = address.toLowerCase()
  return records.some(
    (record) =>
      movesBalance(record) &&
      (record.plan?.address.toLowerCase() === key ||
        record.rotation?.builtOver.l2Address.toLowerCase() === key),
  )
}

/** {@link balanceMoving} over the saved records, kept current. */
export function useBalanceMoving(address: string | undefined): boolean {
  useEffect(() => {
    getBackupRotationStore()
  }, [])
  return balanceMoving(useSyncExternalStore(records.subscribe, records.get, records.get), address)
}

/** {@link balanceMoving} once the store has loaded, for callers outside React; an unreadable store pauses nothing. */
export async function balanceMovingNow(address: string): Promise<boolean> {
  try {
    return balanceMoving(await getBackupRotationStore().list(), address)
  } catch {
    return false
  }
}

/** Test seam: drops the page's store so the next read builds one over the current storage. */
export function resetBackupRotationStoreForTests(): void {
  store = undefined
  records.set("loading")
}

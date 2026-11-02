/** What the account's payment requests read beside its own namespace. */
import {
  SIPADepositStore,
  legacyRecords,
  type Loaded,
  type ReadonlyStore,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { webStorage } from "./WebStorageAdapter"
import { walletStorage } from "./walletStorage"

/** Ids of the Receive codes minted without an amount, kept apart from the requests. Read only. */
const LEGACY_UNLISTED_KEY = "webwallet.receiveCode.unlisted"

export function legacyUnlisted(): string[] {
  try {
    const parsed: unknown = JSON.parse(walletStorage.getItem(LEGACY_UNLISTED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.map((id) => String(id).toLowerCase()) : []
  } catch {
    return []
  }
}

let deposits: ReadonlyStore<Loaded<SIPADepositRecord>> | undefined

/** The SIPA deposit records, hydrating from the first read on. */
export function depositRecords(): ReadonlyStore<Loaded<SIPADepositRecord>> {
  return (deposits ??= legacyRecords(SIPADepositStore.get(webStorage)))
}

import { QueueStatus } from "@obsidion/core/constants"
import type { ContactRow } from "../hooks/useContactsDirectory"
import type { Transaction } from "../types/transactions"
import type { PaymentRequest } from "../engine/requests"
import { l1WalletProvidersMatch } from "../core/storages/ContactStorage"
import {
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
} from "../core/services/deposits/SIPADepositStore"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { normalizeTag } from "./normalizeTag"

export interface ContactActivitySources {
  transactions?: readonly Transaction[]
  requests?: readonly PaymentRequest[]
  sipaDeposits?: readonly SIPADepositRecord[]
  withdrawals?: readonly WithdrawalRecord[]
}

/** Latest initiated interaction, using the same persisted clocks as contact history. */
export function recentContacts(
  contacts: readonly ContactRow[],
  sources: ContactActivitySources,
  limit = 3,
): ContactRow[] {
  const rows = [...new Map(contacts.map((contact) => [contact.id, contact])).values()]
  const addresses = new Map<string, ContactRow[]>()
  const tags = new Map<string, ContactRow[]>()
  const wallets = new Map<string, ContactRow[]>()
  const index = (map: Map<string, ContactRow[]>, key: string, row: ContactRow) => {
    const bucket = map.get(key)
    if (bucket) bucket.push(row)
    else map.set(key, [row])
  }
  for (const row of rows) {
    if (row.addressKind === "ethereum-l1") index(wallets, row.address.toLowerCase(), row)
    else {
      index(addresses, row.address.toLowerCase(), row)
      const tag = normalizeTag(row.tag)
      if (tag) index(tags, tag, row)
    }
  }
  const times = new Map<string, number>()
  const record = (matches: readonly ContactRow[] | undefined, timestamp: number) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return
    for (const contact of matches ?? [])
      times.set(contact.id, Math.max(times.get(contact.id) ?? 0, timestamp))
  }
  const recordL2 = (identity: string | undefined, timestamp: number) => {
    if (!identity) return
    const matches = /^0x/i.test(identity)
      ? addresses.get(identity.toLowerCase())
      : tags.get(normalizeTag(identity) ?? "")
    record(matches, timestamp)
  }
  const recordL1 = (
    address: string | undefined,
    provider: string | undefined,
    timestamp: number,
  ) => {
    if (!address) return
    record(
      wallets
        .get(address.toLowerCase())
        ?.filter((contact) => l1WalletProvidersMatch(contact.provider, provider)),
      timestamp,
    )
  }
  for (const tx of sources.transactions ?? []) {
    if (!("token" in tx) || !tx.token || (tx.action !== "send" && tx.action !== "receive")) continue
    if (tx.detailedStatus === QueueStatus.CANCELLED && !tx.txHash) continue
    recordL2(
      tx.action === "send" ? tx.to : ("senderL2Address" in tx && tx.senderL2Address) || tx.from,
      tx.timestamp,
    )
  }
  for (const request of sources.requests ?? []) {
    if (request.kind !== "link" && request.status !== "cancelled")
      recordL2(request.contactTag, request.createdAt)
  }
  for (const deposit of sources.sipaDeposits ?? []) {
    if (!isUnfundedSipaDeposit(deposit))
      recordL1(deposit.walletAddress, deposit.walletProvider, deposit.startTime)
  }
  for (const withdrawal of sources.withdrawals ?? []) {
    if (withdrawal.phase === "failed" && withdrawal.cancelReason !== undefined) continue
    recordL1(withdrawal.recipient, withdrawal.walletProvider, withdrawal.startTime)
  }
  return rows
    .filter((contact) => times.has(contact.id))
    .sort((a, b) => times.get(b.id)! - times.get(a.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, Math.floor(limit)))
}

/**
 * A contact's payments chat: the feed's items between the user and this contact, plus the requests
 * exchanged with them, oldest first. It reads the feed, so its rows follow the feed's rules.
 */
import { DEFAULT_DECIMALS, QueueStatus } from "@obsidion/core/constants"
import { plainText } from "@obsidion/core/text"
import { parseUnits } from "viem"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import {
  withdrawalGroupAmount,
  worstWithdrawalPhase,
} from "../core/services/bridge/withdrawalGroups"
import { depositAmounts } from "../core/services/deposits/depositAmounts"
import type { SIPADepositRecord } from "../core/services/deposits/SIPADepositStore"
import type { Transaction } from "../types/transactions"
import { decimalPlaces } from "../utils/validate"
import type { Feed, FeedItem, Money } from "./activityFeed"
import { requestMoney } from "./activityFeed"
import { neverCreditsL2 } from "./feedRules"
import type { PaymentRequest } from "./requests"

type TransferStatus = "proving" | "pending" | "confirmed" | "failed" | "cancelled"

export type ChatRole =
  | `${"received" | "sent"}-${TransferStatus}`
  | "request-out"
  | "request-in"
  | "request-paid"
  | "request-declined"

export interface ChatContact {
  tag: string
  address?: string
  /** See `Contact.retiredAddresses`. */
  retiredAddresses?: readonly string[]
  addressKind: "aztec-l2" | "ethereum-l1"
}

export interface ChatItem {
  id: string
  ts: number
  role: ChatRole
  /** `detecting`: a deposit whose L1 amount is not read yet. */
  amount: { money: Money; sign: "+" | "-" | "" } | "detecting"
  /** What the bubble's time slot says instead of the time. */
  status?: "proving" | "pending" | "failed" | "cancelled" | "needsRecovery" | "recovered"
  memo?: string
  /** The feed item or request the bubble opens. */
  source: FeedItem | { kind: "chatRequest"; request: PaymentRequest }
}

const lower = (value: string | undefined) => value?.toLowerCase()

/** A decimal display string as base units at its own precision. */
function displayMoney(display: string): Money {
  try {
    const decimals = decimalPlaces(display)
    return { atomic: parseUnits(display, decimals), decimals }
  } catch {
    return { atomic: 0n, decimals: 0 }
  }
}

function transferStatus(tx: Transaction): TransferStatus {
  if (tx.detailedStatus === QueueStatus.CANCELLED) return "cancelled"
  if (tx.status === "failed" || tx.detailedStatus === QueueStatus.FAILED) return "failed"
  // The hash is minted just before submission: without one the tx is not in a mempool yet.
  if (tx.status === "pending" || tx.detailedStatus === QueueStatus.PENDING)
    return tx.txHash ? "pending" : "proving"
  return "confirmed"
}

const shown = (status: TransferStatus) => (status === "confirmed" ? undefined : status)

function withdrawalStatus(phase: WithdrawalRecord["phase"]): {
  role: TransferStatus
  status?: ChatItem["status"]
} {
  if (phase === "failed") return { role: "failed", status: "failed" }
  // Recovered: the swap never ran and the DAI went to an L1 address of the user's choosing.
  if (phase === "recovered") return { role: "cancelled", status: "recovered" }
  if (phase === "recoverable") return { role: "pending", status: "needsRecovery" }
  return phase === "done" ? { role: "confirmed" } : { role: "pending", status: "pending" }
}

function depositBubble(record: SIPADepositRecord): Pick<ChatItem, "role" | "status" | "amount"> {
  const role: TransferStatus =
    record.phase === "failed"
      ? "failed"
      : record.phase === "claimed"
      ? "confirmed"
      : record.phase === "recovered"
      ? "cancelled"
      : "pending"
  // A recoverable deposit is stuck for the sweep path: "Pending" would promise progress.
  const status: ChatItem["status"] =
    record.phase === "recoverable"
      ? "needsRecovery"
      : record.phase === "recovered"
      ? "recovered"
      : shown(role)
  // A record that swaps into its row token holds that token's amounts; a credit split out by
  // `sipaCredits` holds its own token's.
  const decimals = record.rowToken ? DEFAULT_DECIMALS : record.tokenDecimals ?? DEFAULT_DECIMALS
  const amounts = depositAmounts(record, decimals)
  const gross = { atomic: amounts.grossAtomic, decimals }
  // The "+" marks a credit: only a net on its way into the L2 balance gets one.
  const amount: ChatItem["amount"] = neverCreditsL2(record.phase)
    ? { money: gross, sign: "" }
    : (amounts.feeKnown || record.netAmount != null) && amounts.netAtomic > 0n
    ? { money: { atomic: amounts.netAtomic, decimals }, sign: "+" }
    : amounts.grossAtomic > 0n
    ? { money: gross, sign: "" }
    : "detecting"
  return { role: `received-${role}`, status, amount }
}

function l1Items(feed: Feed, address: string): ChatItem[] {
  return feed.items.flatMap((item): ChatItem[] => {
    if (item.kind === "deposit") {
      const { record } = item
      // A minted address nothing has funded yet.
      if (lower(record.walletAddress) !== address || record.phase === "resolved") return []
      return [
        { id: record.sipaAddress, ts: record.startTime, source: item, ...depositBubble(record) },
      ]
    }
    if (item.kind === "withdrawal") {
      const { record } = item
      if (lower(record.recipient) !== address) return []
      const { role, status } = withdrawalStatus(record.phase)
      return [
        {
          id: record.l2TxHash ?? record.localId,
          ts: record.startTime,
          role: `sent-${role}`,
          status,
          amount: { money: displayMoney(record.amount), sign: "-" },
          source: item,
        },
      ]
    }
    if (item.kind === "withdrawalGroup") {
      if (lower(item.head.recipient) !== address) return []
      const { role, status } = withdrawalStatus(worstWithdrawalPhase(item.group))
      return [
        {
          id: item.group.groupId,
          ts: Math.min(...item.group.records.map((r) => r.startTime)),
          role: `sent-${role}`,
          status,
          amount: { money: displayMoney(withdrawalGroupAmount(item.group)), sign: "-" },
          source: item,
        },
      ]
    }
    return []
  })
}

/** Rows naming one of `addresses`, or the contact's `tag`: a retired rollup's row may carry only the tag. */
function l2Items(feed: Feed, addresses: ReadonlySet<string | undefined>, tag: string): ChatItem[] {
  return feed.items.flatMap((item): ChatItem[] => {
    if (item.kind !== "tx") return []
    const { tx } = item
    // A cancel aborted during proving never reached the chain.
    if (tx.detailedStatus === QueueStatus.CANCELLED && !tx.txHash) return []
    const send = tx.action === "send"
    const { to, toTag, from, senderL2Address } = tx as {
      to?: string
      toTag?: string
      from?: string
      senderL2Address?: string
    }
    const matches = send
      ? addresses.has(to) || lower(toTag) === tag
      : addresses.has(from) || addresses.has(senderL2Address) || lower(from) === tag
    if (!matches) return []
    const status = transferStatus(tx)
    const memo = (tx as { memo?: string }).memo
    return [
      {
        id: tx.txHash || tx.id,
        ts: tx.timestamp,
        role: `${send ? "sent" : "received"}-${status}`,
        status: shown(status),
        amount: { money: item.amount, sign: send ? "-" : "+" },
        memo: (memo && plainText(memo)) || undefined,
        source: item,
      },
    ]
  })
}

/**
 * Requests exchanged with the contact: open ones until they expire, a paid incoming one as paid, a
 * declined outgoing one as declined. A paid outgoing one stands in for its receive only where the
 * chat does not show that receive.
 */
function requestItems(
  requests: readonly PaymentRequest[],
  tag: string,
  shownHashes: ReadonlySet<string>,
  now: number,
): ChatItem[] {
  return requests.flatMap((request): ChatItem[] => {
    if (lower(request.contactTag) !== tag) return []
    const out = request.direction === "outgoing"
    const money = requestMoney(request)
    const bubble = (role: ChatRole, sign: "+" | "-" | ""): ChatItem[] => [
      {
        id: request.id,
        ts: request.createdAt,
        role,
        amount: { money, sign },
        memo: (request.note && plainText(request.note)) || undefined,
        source: { kind: "chatRequest", request },
      },
    ]
    if (request.status === "pending") {
      if (request.expiresAt != null && now > request.expiresAt) return []
      return bubble(out ? "request-out" : "request-in", out ? "-" : "+")
    }
    if (request.status === "fulfilled") {
      if (!out) return bubble("request-paid", "")
      const hash = lower(request.fulfillmentTxHash)
      return hash && shownHashes.has(hash) ? [] : bubble("received-confirmed", "+")
    }
    return out && request.status === "declined" ? bubble("request-declined", "") : []
  })
}

export function selectContactChat(
  feed: Feed,
  requests: readonly PaymentRequest[],
  contact: ChatContact,
  now: number,
): ChatItem[] {
  if (contact.addressKind === "ethereum-l1") {
    if (!contact.address) return []
    return l1Items(feed, contact.address.toLowerCase()).sort((a, b) => a.ts - b.ts)
  }
  const transfers = contact.address
    ? l2Items(
        feed,
        new Set([contact.address, ...(contact.retiredAddresses ?? [])]),
        contact.tag.toLowerCase(),
      )
    : []
  const hashes = new Set(
    transfers.flatMap((item) =>
      item.source.kind === "tx" && item.source.tx.txHash
        ? [item.source.tx.txHash.toLowerCase()]
        : [],
    ),
  )
  return [...transfers, ...requestItems(requests, contact.tag.toLowerCase(), hashes, now)].sort(
    (a, b) => a.ts - b.ts,
  )
}

/** The records a bubble shows: a bubble over the same records says the same thing. */
function recordsOf(source: ChatItem["source"]): readonly unknown[] {
  switch (source.kind) {
    case "chatRequest":
      return [source.request]
    case "tx":
      return [source.tx]
    case "deposit":
    case "withdrawal":
      return [source.record]
    case "withdrawalGroup":
      return source.group.records
    default:
      return [source]
  }
}

const sameAmount = (a: ChatItem["amount"], b: ChatItem["amount"]) =>
  a === "detecting" || b === "detecting"
    ? a === b
    : a.sign === b.sign &&
      a.money.atomic === b.money.atomic &&
      a.money.decimals === b.money.decimals

/** The contact a bubble's detail names, so a rename reaches it. */
const contactOf = (source: ChatItem["source"]) =>
  source.kind === "tx" ? source.contact : undefined

const sameItem = (a: ChatItem, b: ChatItem) => {
  const records = recordsOf(a.source)
  const others = recordsOf(b.source)
  return (
    a.id === b.id &&
    a.ts === b.ts &&
    a.role === b.role &&
    a.status === b.status &&
    a.memo === b.memo &&
    sameAmount(a.amount, b.amount) &&
    contactOf(a.source) === contactOf(b.source) &&
    records.length === others.length &&
    records.every((record, i) => record === others[i])
  )
}

/** Whether two chats show the same bubbles over the same records, so the older one can be kept. */
export function sameChat(a: readonly ChatItem[], b: readonly ChatItem[]): boolean {
  return a.length === b.length && a.every((item, i) => sameItem(item, b[i]))
}

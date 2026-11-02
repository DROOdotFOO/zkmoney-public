/**
 * The contact detail chat's view: who the chat is with, each chat item as a bubble's words, and a
 * role's bubble presentation.
 */
import {
  contactRowFromEntry,
  formatDateLabel,
  formatTimeLabel,
  isPaymentContactEntry,
  type ChatContact,
  type ChatItem,
  type ChatRole,
  type Contact,
} from "@obsidion/front-core"
import { usdCents } from "../../ui/screens/activityView"
import copy from "./contactChat.copy"

/** One chat bubble. */
export interface ChatMessage {
  id: string
  /** The section separator, e.g. "03 February". */
  dateLabel: string
  /** "11:15", or the transfer's state. */
  timeLabel: string
  /** Signed dollars, e.g. "+$25.23". */
  amount: string
  role: ChatRole
  memo?: string
  item: ChatItem
}

/** Chat identity for a stored contact. A pending handshake has no payable address yet. */
export function chatContactOf(entry: Contact): ChatContact {
  if (isPaymentContactEntry(entry)) {
    const row = contactRowFromEntry(entry)
    return {
      tag: row.tag,
      address: row.address,
      retiredAddresses: entry.retiredAddresses,
      addressKind: row.addressKind,
    }
  }
  return { tag: entry.tag ?? entry.name, addressKind: "aztec-l2" }
}

export function chatMessageOf(item: ChatItem): ChatMessage {
  return {
    id: item.id,
    dateLabel: formatDateLabel(item.ts),
    timeLabel: item.status ? copy.time[item.status] : formatTimeLabel(item.ts),
    amount:
      item.amount === "detecting"
        ? copy.detecting
        : `${item.amount.sign}${usdCents(item.amount.money)}`,
    role: item.role,
    memo: item.memo,
    item,
  }
}

/** Bubble presentation for a chat role. */
export interface BubbleView {
  side: "left" | "right"
  label: string
  /** Status-pill icon (web-ds Icon name). */
  icon: "reply" | "forward" | "clock" | "clock-outline" | "reply-slash" | "check"
  /** Red tint (declined / failed). */
  error: boolean
  /** Strikethrough amount (rejected request, failed/cancelled transfer). */
  struck: boolean
  /**
   * Delivery mark beside the time, mirroring the tx's own lifecycle: a spinner while the proof
   * runs, one tick once it is in the mempool, two once mined.
   */
  tick: "none" | "proving" | "sent" | "mined"
  /** Open request: gold pill, unsigned amount, action buttons instead of a time. */
  request: boolean
  /** Request the user has paid: green pill, unsigned amount, no arrow — distinct from a transfer. */
  settled: boolean
}

export function bubbleViewOf(role: ChatRole): BubbleView {
  const base = {
    error: false,
    struck: false,
    tick: "none",
    request: false,
    settled: false,
  } as const
  const { label } = copy
  if (role === "request-out")
    return { ...base, side: "right", label: label.owesYou, icon: "clock", request: true }
  if (role === "request-in")
    return { ...base, side: "left", label: label.youOwe, icon: "clock", request: true }
  if (role === "request-paid")
    return { ...base, side: "left", label: label.youPaid, icon: "check", settled: true }
  if (role === "request-declined")
    return {
      ...base,
      side: "left",
      label: label.declined,
      icon: "reply-slash",
      error: true,
      struck: true,
    }
  const side = role.startsWith("sent-") ? "right" : "left"
  const icon = side === "right" ? "forward" : "reply"
  const verb = side === "right" ? label.sent : label.received
  if (role.endsWith("-proving"))
    return { ...base, side, label: label.pending, icon: "clock-outline", tick: "proving" }
  if (role.endsWith("-pending"))
    return { ...base, side, label: label.pending, icon: "clock-outline", tick: "sent" }
  if (role.endsWith("-failed") || role.endsWith("-cancelled"))
    return {
      ...base,
      side,
      label: role.endsWith("-cancelled") ? label.cancelled : label.failed,
      icon: "reply-slash",
      error: true,
      struck: true,
    }
  return { ...base, side, label: verb, icon, tick: "mined" }
}

/**
 * What the activity rows and their detail sheets say about a feed item: words from the row copy,
 * dollars from base units.
 */
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { StatusLabel } from "@obsidion/web-ds"
import {
  depositAmounts,
  depositPhaseCopy,
  failureReason,
  isNativeEth,
  isZeroAddress,
  neverCreditsL2,
  truncateMiddle,
  upgradeRunStatus,
  validateAddress,
  type ContactRow,
  type CreatorLinkAction,
  type FeedItem,
  type Money,
  type PaylinkStatusKind,
  type PaylinkTransaction,
  type PaymentRequest,
  type SIPADepositRecord,
  type TokenTransaction,
  type TransactionStatus,
  type UpgradeRun,
} from "@obsidion/front-core"
import { fmt } from "../../lib/fmt"
import copy from "../activity/ActivityRow.copy"
import { fixedCents, rowTimestamp, tokenAmount, usdFigure } from "../format"
import { contactDisplayName } from "../../features/contacts/contactsView"

export const DETECTING_AMOUNT = copy.amount.detecting

/** `$12.34`, rounded half up to cents. */
export const usdCents = (money: Money): string => `$${fixedCents(money)}`

export interface ActivityRowView {
  id: string
  /** Saved-contact name when the counterparty resolves; fallback label otherwise. */
  counterparty: string
  /** Attached when the counterparty resolves — drives the gradient-initial avatar. */
  contact?: ContactRow
  /** The counterparty's @tag when the row knows it, saved or not: its conversation opens by it. */
  counterpartyTag?: string
  /** Chain-link glyph for paylink rows. */
  avatarIcon?: string
  timestamp: string
  /** Epoch ms — sort key for interleaving with the bridge feed. */
  timestampMs: number
  /** Signed fiat, e.g. "+$25.00" / "-$25.00". */
  amount: string
  /** "Pending" / "Failed", or a settled creator paylink row's link status (`paylinkRowView`). */
  statusLabel?: StatusLabel
  /**
   * The transaction's own state. Carried so the detail modal can re-derive the badge off a
   * refreshed link status instead of parsing the row's wording.
   */
  status: TransactionStatus
  /** What the detail sheet says about a failed row, in words (`failureReason`); never a raw throw. */
  error?: string
  /** On-chain hash — drives the detail modal's explorer link. Unset for pre-submit synth rows. */
  txHash?: string
  /** The rollup the row was made on; picks the explorer its hashes link to. */
  networkId?: string
  /** Sender-attached memo, when the stored row carries one. */
  note?: string
  /** Stored claim URL — creator paylink rows only; drives the detail modal's share section. */
  paylink?: string
  /** Row-derived claim-lifecycle state for creator paylink rows (the status pill). */
  paylinkStatus?: PaylinkStatusKind
  /** The refund that returned this link's escrow, on a refunded creator row. */
  refundTxHash?: string
  /** The state of the refund behind `refundTxHash`, as its own stored row has it. */
  refundStatus?: TransactionStatus
  /** The creator's link can still be handed out: Share / Copy. */
  canShare?: boolean
  /**
   * The recovery this creator paylink row offers, off its own stored flags and the clock — the row
   * reads no chain. Present means the escrow is the user's to take back, and the row carries the
   * button for it; the detail sheet re-derives the same verdict against a live status.
   */
  creatorAction?: CreatorLinkAction
  /**
   * The stored row behind a creator paylink row. The detail modal's reclaim/cancel gate reads
   * fields no view row carries (flavor, claim window, creator, refund material).
   */
  paylinkRow?: PaylinkTransaction
}

/** Reconstruction fragment of a stored claim URL; null when the URL carries none. */
export function linkFragmentOf(paylink: string): string | null {
  const i = paylink.indexOf("#")
  return i >= 0 && i < paylink.length - 1 ? paylink.slice(i + 1) : null
}

/** On-chain funder + funding tx for the deposit detail sheet. Prefers the Transfer sender. */
export function depositAttribution(record: SIPADepositRecord): {
  funder?: string
  fundingTxHash?: string
} {
  return {
    funder: record.fundingFromAddress ?? record.walletAddress,
    // A direct migration deposit has no funding transfer: its portal deposit is the one L1 tx.
    fundingTxHash: record.fundingTxHash ?? (record.direct ? record.sweepTxHash : undefined),
  }
}

/** Source-wallet name and funder address the deposit detail sheet puts over the facts. */
export function depositHeadline(record: SIPADepositRecord): { title?: string; address?: string } {
  return {
    title: record.walletName?.trim() || undefined,
    address: depositAttribution(record).funder,
  }
}

/**
 * A deposit's gross: ETH sent by mistake in ETH, the stables in dollars. The detail sheet shows
 * every ETH digit; a row trims them, or a long figure squeezes out the row's label.
 */
export function depositGrossFigure(
  record: SIPADepositRecord,
  precision: "full" | "row" = "full",
  /** The row token's, which the record's amounts are in. */
  decimals?: number,
): string {
  const { grossDisplay } = depositAmounts(record, decimals)
  if (!isNativeEth(record.tokenAddress)) return usdFigure(grossDisplay)
  return `${precision === "row" ? tokenAmount(grossDisplay) : grossDisplay} ETH`
}

/**
 * The figure a deposit shows in the feed. The leading "+" is what renders an amount as a credit, so
 * only a deposit whose net is on its way into the L2 balance carries one — the rest show the whole
 * sum that sits at (or left) the deposit address, unsigned. `exitable` records show that gross for
 * want of a net.
 */
export function depositRowAmount(
  record: SIPADepositRecord,
  exitable: boolean,
  /** The row token's, which the record's amounts are in. */
  decimals?: number,
): string {
  const amounts = depositAmounts(record, decimals)
  const gross = depositGrossFigure(record, "row", decimals)
  if (neverCreditsL2(record.phase)) return gross
  // An exact net needs a stored fee or a stored net; crediting a record with neither hands the user the fee.
  if ((amounts.feeKnown || record.netAmount != null) && amounts.netAtomic > 0n)
    return `+${usdFigure(amounts.netDisplay)}`
  // A gross of zero on a phase still headed for L2 means the L1 amount is not read yet, never a real zero.
  return exitable || amounts.grossAtomic > 0n ? gross : DETECTING_AMOUNT
}

/**
 * The badge under a deposit row's amount, from front-core's `DEPOSIT_PHASE_COPY` so the row, the
 * detail sheet and the bell read the same word. A claimed deposit carries no badge.
 */
export function depositRowStatusLabel(record: SIPADepositRecord): StatusLabel | undefined {
  return depositPhaseCopy(record).pill as StatusLabel | undefined
}

/** An upgrade's row status (`upgradeRunStatus`), which the row draws a badge for. */
export function upgradeRowStatusLabel(run: UpgradeRun): StatusLabel | undefined {
  return upgradeRunStatus(run) as StatusLabel | undefined
}

/** The note a transaction's detail shows: the transfer's own memo, else the note of the request it paid. */
export function txNoteFor(row: ActivityRowView, requests: PaymentRequest[]): string | undefined {
  if (row.note) return row.note
  const hash = row.txHash?.toLowerCase()
  if (!hash) return undefined
  return requests.find((r) => r.fulfillmentTxHash?.toLowerCase() === hash)?.note || undefined
}

type TxItem = Extract<FeedItem, { kind: "tx" }>

function sendLabel(tx: TokenTransaction, contact: ContactRow | undefined): string {
  if (contact) return contactDisplayName(contact)
  if (tx.toTag) return fmt(copy.counterparty.tag, { tag: tx.toTag })
  if (!tx.to) return copy.counterparty.unknown
  return validateAddress(tx.to) ? truncateMiddle(tx.to, 15) : tx.to
}

function receiveLabel(from: string | undefined, contact: ContactRow | undefined): string {
  if (contact) return contactDisplayName(contact)
  if (isZeroAddress(from)) return copy.counterparty.faucet
  if (!from || validateAddress(from)) return copy.counterparty.unknownSender
  return from
}

/** A transaction item as its row and detail sheet show it. */
export function txRowView(item: TxItem): ActivityRowView {
  const { tx, link } = item
  const create = tx.action === PaylinkActionEnum.PAY
  const paylinkRow = create ? (tx as PaylinkTransaction) : undefined
  const counterparty = link
    ? link.title
    : tx.action === "faucet"
    ? copy.counterparty.faucetDrip
    : tx.action === "send"
    ? sendLabel(tx as TokenTransaction, item.contact)
    : receiveLabel((tx as TokenTransaction).from, item.contact)
  const statusLabel: StatusLabel | undefined = link
    ? link.statusLabel
    : tx.status === "pending"
    ? copy.status.pending
    : tx.status === "failed"
    ? copy.status.failed
    : undefined
  const memo = (tx as TokenTransaction).memo
  return {
    id: item.id,
    counterparty,
    contact: item.contact,
    counterpartyTag: item.counterpartyTag,
    avatarIcon: link ? "link" : tx.status === "pending" ? "clock-outline" : undefined,
    timestamp: rowTimestamp(tx.timestamp),
    timestampMs: tx.timestamp,
    amount: `${item.direction === "out" ? "-" : "+"}${usdCents(item.amount)}`,
    statusLabel,
    status: tx.status,
    error: failureReason(tx),
    txHash: tx.txHash || undefined,
    networkId: tx.networkId,
    note: memo || undefined,
    paylink: paylinkRow && typeof paylinkRow.paylink === "string" ? paylinkRow.paylink : undefined,
    paylinkStatus: item.paylinkStatus,
    refundTxHash: paylinkRow?.refundTxHash,
    refundStatus: item.refundStatus,
    canShare: link?.canShare,
    creatorAction: item.creatorAction,
    paylinkRow,
  }
}

/** A request's figure: signed dollars, or "Any amount" for a link with none. */
export function requestAmountText(money: Money, sign: "+" | "-", anyWhenZero: boolean): string {
  return anyWhenZero && money.atomic === 0n ? copy.amount.any : `${sign}${usdCents(money)}`
}

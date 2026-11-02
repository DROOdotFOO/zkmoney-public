/**
 * Accounting export of the activity feed in Koinly's universal CSV format: one row per settled
 * movement of funds, oldest first. Received only is a deposit, sent only a withdrawal; no row is
 * both, so nothing reads as a trade. An outgoing fee is on top of the amount sent, an incoming one
 * comes out of the amount received.
 *
 * Every kind of stored record is mapped through an exhaustive table, so a new transaction action,
 * phase, intent or feed item kind fails the build until someone decides how it is reported.
 */
import { formatUnits } from "viem"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { SIPADepositPhase, WithdrawalPhase } from "@obsidion/core/types"
import type { Transaction, TransactionStatus } from "../../../types/transactions"
import { requestLinkedSipaAddresses } from "../../paymentRequest/sipaRequestFulfillment"
import type { PaymentRequest } from "../../../engine/requests"
import type { ActivityItem } from "../bridge/BridgeActivityFeed"
import type { WithdrawalRecord } from "../bridge/types"
import { withdrawalAmounts } from "../bridge/withdrawalAmounts"
import type { SIPADepositRecord, SIPASweep } from "../deposits/SIPADepositStore"
import { savingsMoveBasis } from "../savings/savingsBasis"
import type { SavingsMoveRecord } from "../savings/types"
import type { UpgradeBatchItem } from "../../migration/upgradeActivity"

export const ACTIVITY_CSV_COLUMNS = [
  "Date",
  "Sent Amount",
  "Sent Currency",
  "Received Amount",
  "Received Currency",
  "Fee Amount",
  "Fee Currency",
  "Net Worth Amount",
  "Net Worth Currency",
  "Label",
  "Description",
  "TxHash",
] as const

export type ActivityCsvType =
  | "Payment sent"
  | "Payment received"
  | "Payment link created"
  | "Payment link claimed"
  | "Payment link refunded"
  | "Payment link paid to Ethereum"
  | "Payment request paid"
  | "Deposit"
  | "Withdrawal"
  | "Name registration"
  | "Backup passkey added"
  | "Upgrade out"
  | "Upgrade in"
  | "Savings deposit"
  | "Savings withdrawal"

/** `name` is a zk.money name without its "@", an email, or the user's own label for an address. */
interface Counterparty {
  name?: string
  address?: string
  network?: "Aztec" | "Ethereum"
}

interface Money {
  amount: string
  currency: string
}

export interface ActivityCsvRow {
  timestampMs: number
  type: ActivityCsvType
  sent?: Money
  received?: Money
  fee?: Money
  counterparty?: Counterparty
  note?: string
  aztecTxHash?: string
  ethereumTxHash?: string
}

/** The Main account's token: what transfers, deposits, Savings moves and upgrades are reported in. */
export interface ActivityCsvToken {
  symbol: string
  decimals: number
}

export interface ActivityCsvSources {
  walletToken: ActivityCsvToken
  transactions: readonly Transaction[]
  items: readonly ActivityItem[]
  requests: readonly PaymentRequest[]
}

export interface SavingsCsvSources {
  walletToken: ActivityCsvToken
  moves: readonly SavingsMoveRecord[]
  /** The moves' burns by local id. */
  burns: ReadonlyMap<string, WithdrawalRecord>
}

/** Only settled transactions moved funds; pending ones may still fail. */
const TRANSACTION_SETTLED: Record<TransactionStatus, boolean> = {
  success: true,
  pending: false,
  failed: false,
}

/** A withdrawal counts once funds left the escrow on Ethereum: paid out, or recovered after a failed swap. */
const WITHDRAWAL_SETTLED: Record<WithdrawalPhase, boolean> = {
  done: true,
  recovered: true,
  submitting: false,
  l2_mined: false,
  awaiting_proven: false,
  finalizing_l1: false,
  swapping: false,
  recoverable: false,
  failed: false,
}

/** A deposit counts once credited. A recovered one went back out on Ethereum and never reached the balance. */
const DEPOSIT_SETTLED: Record<SIPADepositPhase, boolean> = {
  claimed: true,
  resolved: false,
  funding: false,
  funded: false,
  broadcast: false,
  sweeping: false,
  pendingClaim: false,
  failed: false,
  recoverable: false,
  recovered: false,
}

/** An upgrade's batch has left the old version once its refund executed on L1. */
const UPGRADE_SETTLED: Record<UpgradeBatchItem["state"], boolean> = {
  planned: false,
  sent: false,
  refunded: true,
  received: true,
}

type TxRow = (tx: Transaction, token: ActivityCsvToken) => ActivityCsvRow

/** null: the action moves no funds, or its movement is reported by another row. */
const TRANSACTION_ACTION: Record<Transaction["action"], TxRow | null> = {
  send: (tx, token) => ({
    ...txBase(tx),
    type: "Payment sent",
    sent: txMoney(tx, token),
    counterparty: aztecCounterparty(
      "toTag" in tx ? tx.toTag : undefined,
      "to" in tx ? tx.to : undefined,
    ),
  }),
  receive: (tx, token) => ({
    ...txBase(tx),
    type: "Payment received",
    received: txMoney(tx, token),
    counterparty: aztecCounterparty(
      "from" in tx ? tx.from : undefined,
      "senderL2Address" in tx ? tx.senderL2Address : undefined,
    ),
  }),
  // Test-network funds with no value.
  faucet: null,
  [PaylinkActionEnum.PAY]: (tx, token) => ({
    ...txBase(tx),
    type: "Payment link created",
    sent: txMoney(tx, token),
    counterparty: "to" in tx && tx.to?.includes("@") ? { name: tx.to } : undefined,
  }),
  [PaylinkActionEnum.CLAIM]: (tx, token) => ({
    ...txBase(tx),
    type: "Payment link claimed",
    received: txMoney(tx, token),
  }),
  [PaylinkActionEnum.CLAIM_BACK]: (tx, token) => ({
    ...txBase(tx),
    type: "Payment link refunded",
    received: txMoney(tx, token),
  }),
  // Status words, not movements: the funds move on the CLAIM and CLAIM_BACK rows.
  [PaylinkActionEnum.REFUNDED]: null,
  [PaylinkActionEnum.CLAIMED]: null,
  contract_call: null,
  create_account: null,
  import_account: null,
}

type WithdrawalKind =
  | NonNullable<WithdrawalRecord["intent"]>
  | NonNullable<WithdrawalRecord["source"]>
  | `savings-${NonNullable<WithdrawalRecord["skyMove"]>["direction"]}`
  | "balance"

const WITHDRAWAL_TYPE: Record<WithdrawalKind, ActivityCsvType> = {
  "balance": "Withdrawal",
  "paylink": "Payment link paid to Ethereum",
  "registration": "Name registration",
  "migration": "Upgrade out",
  "backup": "Backup passkey added",
  "savings-in": "Savings deposit",
  "savings-out": "Savings withdrawal",
}

function withdrawalKind(record: WithdrawalRecord): WithdrawalKind {
  if (record.intent) return record.intent
  if (record.skyMove) return `savings-${record.skyMove.direction}`
  return record.source ?? "balance"
}

type DepositKind = NonNullable<SIPADepositRecord["intent"]> | "migration" | "request" | "deposit"

const DEPOSIT_TYPE: Record<DepositKind, ActivityCsvType> = {
  "deposit": "Deposit",
  "request": "Payment request paid",
  "registration": "Name registration",
  "migration": "Upgrade in",
  "user-op": "Backup passkey added",
}

type ItemRows = (item: ActivityItem, ctx: ItemContext) => ActivityCsvRow[]

interface ItemContext {
  walletToken: ActivityCsvToken
  migrationArrivals: ReadonlySet<string>
  requestAddresses: ReadonlySet<string>
}

/** Feed items by kind. Transfer kinds are reported from the stored transactions instead. */
const ITEM_KIND: Record<ActivityItem["kind"], ItemRows> = {
  "bridge.withdrawal": (item) =>
    item.kind === "bridge.withdrawal" && WITHDRAWAL_SETTLED[item.record.phase]
      ? [withdrawalRow(item.record)]
      : [],
  // A token split out of its address's record is reported among that record's sweeps.
  "bridge.sipaDeposit": (item, ctx) =>
    item.kind === "bridge.sipaDeposit" && !item.credit ? depositRows(item.record, ctx) : [],
  "upgrade.batch": (item, ctx) =>
    item.kind === "upgrade.batch" && UPGRADE_SETTLED[item.batch.state]
      ? [upgradeRow(item.batch, ctx.walletToken)]
      : [],
}

/** Every stored kind the export has a rule for; the tests pin each one. */
export const ACTIVITY_CSV_COVERAGE = {
  transactionActions: Object.keys(TRANSACTION_ACTION),
  transactionStatuses: Object.keys(TRANSACTION_SETTLED),
  withdrawalPhases: Object.keys(WITHDRAWAL_SETTLED),
  withdrawalKinds: Object.keys(WITHDRAWAL_TYPE),
  depositPhases: Object.keys(DEPOSIT_SETTLED),
  depositKinds: Object.keys(DEPOSIT_TYPE),
  itemKinds: Object.keys(ITEM_KIND),
  upgradeStates: Object.keys(UPGRADE_SETTLED),
}

export function buildActivityCsvRows(sources: ActivityCsvSources): ActivityCsvRow[] {
  const withdrawals = sources.items.flatMap((i) =>
    i.kind === "bridge.withdrawal" ? [i.record] : [],
  )
  const ctx: ItemContext = {
    walletToken: sources.walletToken,
    migrationArrivals: new Set([
      ...withdrawals.filter((r) => r.intent === "migration").map((r) => r.recipient.toLowerCase()),
      ...sources.items.flatMap((i) =>
        i.kind === "upgrade.batch" ? [i.batch.recipient.toLowerCase()] : [],
      ),
    ]),
    requestAddresses: requestLinkedSipaAddresses(sources.requests),
  }
  const txRows = sources.transactions.flatMap((tx) => {
    const row = TRANSACTION_ACTION[tx.action]
    return row && TRANSACTION_SETTLED[tx.status] ? [row(tx, sources.walletToken)] : []
  })
  const itemRows = sources.items.flatMap((item) => ITEM_KIND[item.kind](item, ctx))
  return [...txRows, ...itemRows].sort((a, b) => a.timestampMs - b.timestampMs)
}

/**
 * The Savings account's rows: each move as that side sees it, in the wallet token, once its deposit
 * is claimed where the funds land. In: what the vault took, the figure the earnings basis counts,
 * or the burn's gross when nothing was read. Out: what landed on Main, with the rest of what the
 * vault paid as the fee.
 */
export function buildSavingsCsvRows({
  walletToken: { symbol, decimals },
  moves,
  burns,
}: SavingsCsvSources): ActivityCsvRow[] {
  return moves
    .flatMap((move): ActivityCsvRow[] => {
      if (!move.deposit?.claimed) return []
      const burn = burns.get(move.withdrawalLocalId)
      const landed = BigInt(move.deposit.amount)
      const paid = move.vault ? BigInt(move.vault.assets) : undefined
      const hashes = {
        aztecTxHash: burn?.l2TxHash,
        ethereumTxHash: move.vault?.txHash ?? move.deposit.txHash,
      }
      if (move.direction === "in") {
        const took = savingsMoveBasis(move, burn) ?? BigInt(move.amount)
        return [
          {
            timestampMs: move.deposit.at ?? move.endTime ?? move.startTime,
            type: "Savings deposit",
            received: money(took, decimals, symbol),
            ...hashes,
          },
        ]
      }
      return [
        {
          timestampMs: burn?.minedAt ?? move.startTime,
          type: "Savings withdrawal",
          sent: money(landed, decimals, symbol),
          fee: paid === undefined ? undefined : money(paid - landed, decimals, symbol),
          ...hashes,
        },
      ]
    })
    .sort((a, b) => a.timestampMs - b.timestampMs)
}

export function activityCsv(sources: ActivityCsvSources): string {
  return csvFile(buildActivityCsvRows(sources))
}

export function savingsCsv(sources: SavingsCsvSources): string {
  return csvFile(buildSavingsCsvRows(sources))
}

function csvFile(rows: readonly ActivityCsvRow[]): string {
  const lines = [
    ACTIVITY_CSV_COLUMNS.map(cell),
    ...rows.map((row) =>
      [
        `${new Date(row.timestampMs).toISOString().replace("T", " ").slice(0, 19)} UTC`,
        row.sent?.amount,
        row.sent?.currency,
        row.received?.amount,
        row.received?.currency,
        row.fee?.amount,
        row.fee?.currency,
        undefined,
        undefined,
        undefined,
        [row.type, row.counterparty?.name, row.counterparty?.address, row.note]
          .filter(Boolean)
          .join(" · "),
        // The Ethereum side is what an imported Ethereum wallet shares, so it matches the transfer.
        row.ethereumTxHash ?? row.aztecTxHash,
      ].map(cell),
    ),
  ]
  return lines.map((line) => line.join(",")).join("\r\n") + "\r\n"
}

export function activityCsvFileName(
  now: Date = new Date(),
  account: "main" | "savings" = "main",
): string {
  const feed = account === "savings" ? "savings-activity" : "activity"
  return `zkmoney-${feed}-${now.toISOString().slice(0, 10)}.csv`
}

/** Quotes as RFC 4180 needs, and stops a spreadsheet reading text as a formula. */
function cell(value: string | undefined): string {
  if (!value) return ""
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function txBase(tx: Transaction): Pick<ActivityCsvRow, "timestampMs" | "aztecTxHash" | "note"> {
  return {
    timestampMs: tx.timestamp,
    aztecTxHash: tx.txHash || undefined,
    note: "memo" in tx && tx.memo ? tx.memo : undefined,
  }
}

function txMoney(tx: Transaction, walletToken: ActivityCsvToken): Money | undefined {
  if (!("token" in tx) || !tx.token) return undefined
  const atomic = "amountAtomic" in tx ? tx.amountAtomic : undefined
  return {
    amount: atomic
      ? formatUnits(BigInt(atomic), tx.token.decimals)
      : tx.token.amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }),
    currency: tx.token.symbol || walletToken.symbol,
  }
}

/** `nameOrAddress` is a stored party: a zk.money name, or an address where none was known. */
function aztecCounterparty(nameOrAddress?: string, address?: string): Counterparty | undefined {
  const isAddress = !!nameOrAddress?.startsWith("0x")
  const name = isAddress ? undefined : nameOrAddress?.replace(/^@/, "")
  const resolved = address ?? (isAddress ? nameOrAddress : undefined)
  if (!name && !resolved) return undefined
  if (resolved && /^0x0+$/i.test(resolved)) return { name: "Faucet", network: "Aztec" }
  return { name, address: resolved, network: "Aztec" }
}

function rescale(amount: bigint, from: number, to: number): bigint {
  return to >= from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to)
}

/** Undefined for a non-positive amount: a fee the chain shows as none is left blank, not 0. */
function money(atomic: bigint, decimals: number, currency: string): Money | undefined {
  return atomic > 0n ? { amount: formatUnits(atomic, decimals), currency } : undefined
}

function withdrawalRow(record: WithdrawalRecord): ActivityCsvRow {
  const gross = withdrawalAmounts(record).grossAtomic
  const { tokenSymbol: currency, tokenDecimals: decimals } = record
  const paidTo = (record.phase === "recovered" && record.recoveryTarget) || record.recipient
  // Only a direct withdrawal arrives in the burned token, so only its difference is a fee.
  const received =
    record.receivedAmount != null && !record.swapOutput ? BigInt(record.receivedAmount) : undefined
  return {
    timestampMs: record.endTime ?? record.startTime,
    type: WITHDRAWAL_TYPE[withdrawalKind(record)],
    sent: money(received ?? gross, decimals, currency),
    fee: received === undefined ? undefined : money(gross - received, decimals, currency),
    counterparty: { name: record.recipientAlias, address: paidTo, network: "Ethereum" },
    aztecTxHash: record.l2TxHash,
    ethereumTxHash: record.swapExecuteTxHash ?? record.recoveryTxHash ?? record.l1TxHash,
  }
}

/** What a batch's refund took off the old version. The migration executor takes no fee. */
function upgradeRow(batch: UpgradeBatchItem, token: ActivityCsvToken): ActivityCsvRow {
  return {
    timestampMs: batch.startTime,
    type: "Upgrade out",
    sent: money(BigInt(batch.amount), token.decimals, token.symbol),
    counterparty: { address: batch.recipient, network: "Ethereum" },
    aztecTxHash: batch.tx,
  }
}

/**
 * The sweeps a deposit is reported from: every ledger entry, whatever the address's current phase,
 * since a re-used address is mid-sweep again while its earlier credits stand. A record claimed
 * before the ledger existed has its latest, with no gross, once it is settled.
 */
function settledSweeps(record: SIPADepositRecord): readonly Partial<SIPASweep>[] {
  if (record.sweeps?.length) return record.sweeps
  if (!DEPOSIT_SETTLED[record.phase]) return []
  return [
    { inboxIndex: record.inboxIndex, sweepTxHash: record.sweepTxHash, netAmount: record.netAmount },
  ]
}

/** One row per claimed sweep: a re-used address is credited once per sweep. */
function depositRows(record: SIPADepositRecord, ctx: ItemContext): ActivityCsvRow[] {
  const address = record.sipaAddress.toLowerCase()
  const type =
    DEPOSIT_TYPE[
      record.intent ??
        (ctx.migrationArrivals.has(address)
          ? "migration"
          : ctx.requestAddresses.has(address)
          ? "request"
          : "deposit")
    ]
  const counterparty: Counterparty | undefined = record.fundingFromAddress
    ? { address: record.fundingFromAddress, network: "Ethereum" }
    : undefined
  return settledSweeps(record).map((sweep, i) => {
    // A sweep is credited in its row's token; one recorded before rows carries the record's.
    const currency = sweep.tokenSymbol || record.tokenSymbol || ctx.walletToken.symbol
    const decimals = sweep.tokenDecimals ?? record.tokenDecimals ?? ctx.walletToken.decimals
    const sentCurrency = sweep.fundingTokenSymbol ?? currency
    const sentDecimals = sweep.fundingTokenDecimals ?? decimals
    const sent = sweep.grossAmount != null ? BigInt(sweep.grossAmount) : undefined
    const net = sweep.netAmount != null ? BigInt(sweep.netAmount) : undefined
    // A sweep swapped into another token has no fee in one currency: it reports the net alone.
    const gross =
      sent !== undefined && net !== undefined && sentCurrency === currency
        ? rescale(sent, sentDecimals, decimals)
        : undefined
    return {
      // Dated at the sweep, when the funds it settled left the address and were credited.
      timestampMs: sweep.settledAt ?? record.startTime,
      type,
      received: money(gross ?? net ?? 0n, decimals, currency),
      fee: gross === undefined ? undefined : money(gross - net!, decimals, currency),
      counterparty,
      aztecTxHash: sweep.inboxIndex === record.inboxIndex ? record.claimTxHash : undefined,
      // The funding transfer is the user's own transaction, and it belongs to the first sweep.
      ethereumTxHash: (i === 0 ? record.fundingTxHash : undefined) ?? sweep.sweepTxHash,
    }
  })
}

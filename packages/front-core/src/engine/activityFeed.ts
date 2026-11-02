/**
 * The activity feed as typed items: every source merged once, every exclusion applied here, keyed,
 * newest first. Views render from `selectFeed` and the selectors over it, never from the records.
 */
import { DEFAULT_DECIMALS, PaylinkActionEnum } from "@obsidion/core/constants"
import {
  hiddenBehindOwnWithdrawal,
  itemStartTime,
  type ActivityItem,
} from "../core/services/bridge/BridgeActivityFeed"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { WITHDRAWAL_TERMINAL_PHASES } from "../core/services/bridge/types"
import {
  isFundsLegUnsent,
  isWithdrawalGroupTerminal,
  withdrawalGroupsOf,
  withdrawalGroupTime,
  type WithdrawalGroup,
} from "../core/services/bridge/withdrawalGroups"
import { isWithdrawalDelayed } from "../core/services/bridge/withdrawalPhases"
import type { ActivityCsvSources, SavingsCsvSources } from "../core/services/activity/activityCsv"
import { depositAmounts } from "../core/services/deposits/depositAmounts"
import { sipaReasonShown, type SipaProcessingState } from "../core/services/deposits/sipaProcessing"
import { sipaCredits } from "../core/services/deposits/sipaCredits"
import {
  isAccountMoveSipa,
  isSettledSipaPhase,
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
} from "../core/services/deposits/SIPADepositStore"
import { requestLinkedSipaAddresses } from "../core/paymentRequest/sipaRequestFulfillment"
import { upgradeRecipients, upgradeRunsOf, type UpgradeRun } from "../core/migration/upgradeRuns"
import { chainUpgradeBatches } from "../core/migration/chainUpgradeBatches"
import type { UpgradeBatchItem } from "../core/migration/upgradeActivity"
import type { OldVersionWithdrawal } from "../core/migration/OldVersionWithdrawalStorage"
import {
  creatorLinkAction,
  isOtherRollupLink,
  type CreatorLinkAction,
} from "../core/services/paylink/creatorLinkAction"
import { paylinkRowView, type PaylinkRowView } from "../core/services/paylink/paylinkRowView"
import { paylinkStatusFor, type PaylinkStatusKind } from "../core/services/paylink/paylinkStatus"
import { savingsLedger, type SavingsLedger } from "../core/services/savings/savingsBasis"
import type { SavingsMoveRecord } from "../core/services/savings/types"
import { savingsValue } from "../core/services/savings/savingsMath"
import { savingsMoveOfWithdrawal } from "../oxide/savingsMoves"
import {
  resolveContactByCounterparty,
  resolveContactForTx,
  type TxContactDirectory,
} from "../core/txContactResolution"
import type { ContactRow } from "../hooks/useContactsDirectory"
import type {
  FaucetTransaction,
  PaylinkTransaction,
  TokenTransaction,
  Transaction,
} from "../types/transactions"
import { normalizeTag } from "../utils/normalizeTag"
import { isZeroAddress, validateAddress } from "../utils/validate"
import {
  bridgeItemTime,
  depositExitOffer,
  isSavingsMoveSettled,
  migrationAmounts,
  neverCreditsL2,
  registrationFor,
  registrationTagForDeposit,
  registrationTagForSipa,
  tagPriceOf,
  withdrawalExit,
  type DepositOffer,
  type Registrations,
  type WithdrawalExit,
} from "./feedRules"
import type { Loaded } from "./recordSource"
import type { RecordSet } from "./persistentStore"
import { fulfillingReceive, type PaymentRequest } from "./requests"

/** An amount in base units at its decimals. */
export interface Money {
  atomic: bigint
  decimals: number
}

/** The stored records the feed reads, and wall time. */
export interface FeedSources {
  /**
   * The activity rows the feed lists, with every pending row, paylink row and request payment, so
   * lookups by hash, link or request find theirs. `loaded` once every read landed.
   */
  rows: RecordSet<Transaction>
  /** The time of the oldest row listed while older rows are not read: older items wait for them. */
  cutoff?: number
  requests: readonly PaymentRequest[]
  /** False until the saved requests load. */
  requestsLoaded?: boolean
  deposits: Loaded<SIPADepositRecord>
  withdrawals: Loaded<WithdrawalRecord>
  /** `recipients`: every deposit address a run pays, a live source's included. */
  upgrades: {
    items: readonly UpgradeBatchItem[]
    recipients: ReadonlySet<string>
    loaded: boolean
  }
  moves: Loaded<SavingsMoveRecord>
  /** "Withdraw to Ethereum" runs from old versions. */
  oldVersionWithdrawals: readonly OldVersionWithdrawal[]
  /** Why a deposit waits for its sweep, by lowercase address. */
  processing: ReadonlyMap<string, SipaProcessingState>
  /** Paylink secrets whose refund this page runs. */
  refunding: ReadonlySet<string>
  catchingUp: boolean
  now: number
}

/** What the feed reads beside the stores. */
export interface FeedContext {
  contacts: { rows: readonly ContactRow[]; hydrated: boolean; failed: boolean }
  registrations: Registrations
  /** The pending registration's own row, while it has one. */
  registration?: { sipaAddress: string; ts: number }
  /** Chain time; no creator recovery is offered until it is read. */
  chainNowSec?: number
  /** The active rollup's network: a link made on another is retired here. */
  activeNetworkId?: string
  /** The session's account: a link another account made offers no creator recovery. */
  account?: string
  /** When each stored balance's read resolved, ms. */
  balanceReadAt?: { main?: number; savings?: number }
  sharePrice?: bigint
  /** What the account holds on old versions. */
  oldVersions?: ArrivingFunds
  /** A rotated wallet's previous account; deposits to it show on its own Home line. */
  previousAccount?: string
}

interface Base {
  id: string
  ts: number
  /** Where funds move: out of the balance, or into it. */
  direction: "in" | "out"
  pending: boolean
}

export type RequestRole = "incoming" | "outgoingContact" | "outgoingLink"

export type FeedItem = Base &
  (
    | {
        kind: "request"
        request: PaymentRequest
        role: RequestRole
        amount: Money
        /** A link whose deposit shows funds before the claim pays it. */
        detected: boolean
        contact?: ContactRow
      }
    | { kind: "paidLink"; request: PaymentRequest; amount: Money }
    | {
        kind: "tx"
        tx: TokenTransaction | FaucetTransaction | PaylinkTransaction
        amount: Money
        contact?: ContactRow
        /** The counterparty's tag, saved or not: its conversation opens by it. */
        counterpartyTag?: string
        link?: PaylinkRowView
        paylinkStatus?: PaylinkStatusKind
        refundStatus?: Transaction["status"]
        creatorAction?: CreatorLinkAction
      }
    | { kind: "upgrade"; run: UpgradeRun }
    | {
        kind: "withdrawalGroup"
        group: WithdrawalGroup
        head: WithdrawalRecord
        /** The leg whose release waits longer than usual. */
        delayed?: WithdrawalRecord
        exit?: { record: WithdrawalRecord; exit: WithdrawalExit }
        unsent: boolean
      }
    | { kind: "savingsMove"; move: SavingsMoveRecord; burn: WithdrawalRecord }
    | {
        kind: "withdrawal"
        record: WithdrawalRecord
        delayed: boolean
        exit?: WithdrawalExit
        /** A burn to this wallet's registration SIPA paid for its tag. */
        registrationTag?: string
      }
    | {
        kind: "deposit"
        record: SIPADepositRecord
        /** Another token the address credited, split out of its record. */
        credit?: string
        processing?: SipaProcessingState
        intent: "deposit" | "registration" | "migration"
        tag?: string
        offer: DepositOffer | null
        /** What the timestamp slot says instead of the time. */
        subline?: { reason: SipaProcessingState["reason"]["kind"] } | "stuck"
        /** A migration's arrival before its funds land; no figure while a fee is unknown. */
        arriving?: { net?: bigint }
      }
    | { kind: "tagPurchase"; record: SIPADepositRecord; tag: string; price: bigint }
    | { kind: "registration" }
    | { kind: "oldVersionWithdrawal"; record: OldVersionWithdrawal }
  )

export interface SavingsItem extends Base {
  move: SavingsMoveRecord
  burn?: WithdrawalRecord
}

export interface ArrivingFunds {
  main: bigint
  savings: bigint
}

export interface Feed {
  items: FeedItem[]
  /** The bridge records the feed shows, newest first: what deep links and details resolve. */
  bridge: ActivityItem[]
  groups: WithdrawalGroup[]
  upgradeRuns: UpgradeRun[]
  /** Every source served its last-known state and no chain scan is rebuilding history. */
  hydrated: boolean
  /** The contacts could not be read, so incoming requests are hidden. */
  requestsUnavailable: boolean
  arriving: ArrivingFunds
  /** The upgrade's deposit addresses are read, so `arriving` counts none of them. */
  upgradesLoaded: boolean
  savings: { items: SavingsItem[]; hydrated: boolean; ledger?: SavingsLedger }
  /** The exports' records; the view adds the Main token's metadata once it is read. */
  csv: Omit<ActivityCsvSources, "walletToken">
  savingsCsv: Omit<SavingsCsvSources, "walletToken">
}

const lower = (value: string) => value.toLowerCase()

/** A request's amount. Rows from before `amountAtomic` carry only the dollar figure. */
export function requestMoney(request: PaymentRequest): Money {
  if (request.amountAtomic !== undefined && request.tokenDecimals !== undefined)
    return { atomic: BigInt(request.amountAtomic), decimals: request.tokenDecimals }
  return { atomic: BigInt(Math.round(request.amount * 100)), decimals: 2 }
}

const isExpired = (request: PaymentRequest, now: number) =>
  request.expiresAt != null && now > request.expiresAt

/** Lowercased tags of the L2 contacts the user added, not of senders added from a transfer. */
export function approvedContactTags(contacts: readonly ContactRow[]): Set<string> {
  return new Set(
    contacts.flatMap((c) =>
      c.addressKind === "aztec-l2" && !c.autoAdded ? [c.tag.toLowerCase()] : [],
    ),
  )
}

/** An incoming request from someone outside the contact book: kept out of Activity and Home. */
export function isFromNonContact(
  request: Pick<PaymentRequest, "direction" | "contactTag">,
  contactTags: ReadonlySet<string>,
): boolean {
  return request.direction === "incoming" && !contactTags.has(request.contactTag.toLowerCase())
}

/** The inbox for requests from non-contacts: pending, unexpired, unpaid, newest first. */
export function nonContactInbox(
  requests: readonly PaymentRequest[],
  contacts: readonly ContactRow[],
  now: number,
): PaymentRequest[] {
  const tags = approvedContactTags(contacts)
  return requests
    .filter((r) => r.status === "pending" && !isExpired(r, now) && isFromNonContact(r, tags))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export interface PaidLinkPayer {
  displayName: string
  contact?: ContactRow
}

/** Who paid a request link, from the receive that paid it. */
export function payerForPaidLink(
  request: Pick<PaymentRequest, "fulfillmentTxHash">,
  rows: readonly Transaction[],
  contacts: readonly ContactRow[],
): PaidLinkPayer | undefined {
  const tx = fulfillingReceive(request, rows)
  if (!tx) return undefined
  const contact = resolveContactForTx(tx.from ?? "", tx.senderL2Address, directoryOf(contacts))
  if (contact) return { displayName: contact.name, contact }
  const from = tx.from
  if (!from || isZeroAddress(from) || validateAddress(from)) return undefined
  return { displayName: from.startsWith("@") ? from : `@${from}` }
}

/** The paid screen's "Added to your contacts": the payer is now a full contact. */
export function payerAddedToContacts(contact: ContactRow | undefined): boolean {
  return !!contact && contact.addressKind === "aztec-l2" && !contact.autoAdded
}

const directoryOf = (contacts: readonly ContactRow[]): TxContactDirectory => ({
  contacts: [...contacts],
  lookup: (idOrTag) => contacts.find((c) => c.id === idOrTag || c.tag === idOrTag),
})

const isPaidLink = (r: PaymentRequest) =>
  r.direction === "outgoing" && r.kind === "link" && r.status === "fulfilled"

// A refund is not a movement of its own: the creator's PAY row carries the round trip.
const VISIBLE_ACTIONS = new Set<string>([
  "send",
  "receive",
  "faucet",
  PaylinkActionEnum.PAY,
  PaylinkActionEnum.CLAIM,
])

type VisibleTx = TokenTransaction | FaucetTransaction | PaylinkTransaction

const isVisible = (tx: Transaction): tx is VisibleTx =>
  "token" in tx && tx.token != null && VISIBLE_ACTIONS.has(tx.action)

function txItems(
  rows: readonly Transaction[],
  requests: readonly PaymentRequest[],
  directory: TxContactDirectory,
  sources: Pick<FeedSources, "refunding" | "now">,
  ctx: Pick<FeedContext, "chainNowSec" | "activeNetworkId" | "account">,
): FeedItem[] {
  const { chainNowSec } = ctx
  // A receive that paid a request link shows as the paid link.
  const paidByLink = new Set(
    requests.flatMap((r) =>
      isPaidLink(r) && r.fulfillmentTxHash ? [lower(r.fulfillmentTxHash)] : [],
    ),
  )
  const statusByHash = new Map(
    rows.flatMap((tx) => (tx.txHash ? [[tx.txHash, tx.status] as const] : [])),
  )
  const clockSec = chainNowSec ?? Math.floor(sources.now / 1000)
  return rows
    .filter(isVisible)
    .filter((tx) => tx.action !== "receive" || !tx.txHash || !paidByLink.has(lower(tx.txHash)))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((tx): FeedItem => {
      const create = tx.action === PaylinkActionEnum.PAY
      const isLink = create || tx.action === PaylinkActionEnum.CLAIM
      const link = isLink ? (tx as PaylinkTransaction) : undefined
      const linkStatus = create ? paylinkStatusFor(link!, clockSec) : undefined
      const refundStatus = link?.refundTxHash ? statusByHash.get(link.refundTxHash) : undefined
      const view = link
        ? paylinkRowView(link, {
            linkStatus,
            offer:
              linkStatus && chainNowSec != null
                ? creatorLinkAction(link, {
                    nowSec: chainNowSec,
                    liveStatus: linkStatus,
                    account: ctx.account,
                  })
                : null,
            refundStatus,
            refundStarting: sources.refunding.has(link.payToEmailSecret ?? ""),
            retired: isOtherRollupLink(link, ctx.activeNetworkId),
            nowSec: clockSec,
          })
        : undefined
      let contact: ContactRow | undefined
      let counterpartyTag: string | undefined
      if (!view && tx.action === "send") {
        const { to, toTag } = tx as TokenTransaction
        contact =
          (to ? resolveContactByCounterparty(to, directory) : undefined) ??
          (toTag ? directory.lookup(toTag) : undefined)
        counterpartyTag = toTag
      } else if (!view && tx.action !== "faucet") {
        const { from, senderL2Address } = tx as TokenTransaction
        contact =
          from || senderL2Address
            ? resolveContactForTx(from ?? "", senderL2Address, directory)
            : undefined
        counterpartyTag =
          from && !validateAddress(from) ? normalizeTag(from) ?? undefined : undefined
      }
      const paylinkStatus = view?.refunded ? "refunded" : linkStatus
      const out = tx.action === "send" || create
      return {
        kind: "tx",
        id: tx.txHash || tx.id,
        ts: tx.timestamp,
        direction: out ? "out" : "in",
        pending:
          tx.status === "pending" || (tx.status === "success" && paylinkStatus === "awaitingClaim"),
        tx,
        amount: { atomic: tx.amountAtomic, decimals: tx.token?.decimals ?? DEFAULT_DECIMALS },
        contact,
        counterpartyTag: contact?.addressKind === "aztec-l2" ? contact.tag : counterpartyTag,
        link: view,
        paylinkStatus,
        refundStatus,
        creatorAction: view?.recovery ?? undefined,
      }
    })
}

function requestItems(
  requests: readonly PaymentRequest[],
  rows: readonly Transaction[],
  deposits: readonly SIPADepositRecord[],
  directory: TxContactDirectory,
  ctx: FeedContext,
  now: number,
): FeedItem[] {
  const contactsCurrent = ctx.contacts.hydrated && !ctx.contacts.failed
  const tags = approvedContactTags(ctx.contacts.rows)
  const bySipa = new Map(deposits.map((d) => [lower(d.sipaAddress), d]))
  const open = requests
    .filter(
      (r) =>
        r.status === "pending" &&
        !isExpired(r, now) &&
        !r.unlisted &&
        (contactsCurrent ? !isFromNonContact(r, tags) : r.direction !== "incoming"),
    )
    .map((request): FeedItem => {
      const role: RequestRole =
        request.direction === "incoming"
          ? "incoming"
          : request.kind === "link"
          ? "outgoingLink"
          : "outgoingContact"
      const deposit = request.sipaAddress ? bySipa.get(lower(request.sipaAddress)) : undefined
      // Any evidence of funds counts; paid waits for the claim.
      const detected =
        role === "outgoingLink" &&
        !!deposit &&
        (depositAmounts(deposit).grossAtomic > 0n ||
          (deposit.phase !== "broadcast" && deposit.phase !== "resolved"))
      return {
        kind: "request",
        id: request.id,
        ts: request.createdAt,
        direction: role === "incoming" ? "out" : "in",
        pending: true,
        request,
        role,
        amount: requestMoney(request),
        detected,
        contact: request.contactTag ? directory.lookup(request.contactTag) : undefined,
      }
    })
  const paid = requests.filter(isPaidLink).map((request): FeedItem => {
    const deposit = request.sipaAddress ? bySipa.get(lower(request.sipaAddress)) : undefined
    const receive = fulfillingReceive(request, rows)
    const net = deposit ? depositAmounts(deposit).netAtomic : 0n
    const amount: Money = receive
      ? { atomic: receive.amountAtomic, decimals: receive.token.decimals }
      : net > 0n
      ? { atomic: net, decimals: DEFAULT_DECIMALS }
      : requestMoney(request)
    return {
      kind: "paidLink",
      id: request.id,
      // When it was paid: the row stands in for the payment, which can land long after the ask.
      ts: deposit ? deposit.endTime ?? deposit.startTime : receive?.timestamp ?? request.createdAt,
      direction: "in",
      pending: false,
      request,
      amount,
    }
  })
  return [...open, ...paid]
}

/** What the feed shows of the bridge, as the bell's feed lists it: newest first. */
function bridgeOf(sources: FeedSources): ActivityItem[] {
  const withdrawals = sources.withdrawals.records
  const { upgrades } = sources
  // Deposits no run of this device covers, once its runs are read, so none is listed twice.
  const chainBatches = upgrades.loaded
    ? chainUpgradeBatches(sources.deposits.records, upgrades.recipients)
    : []
  const items: ActivityItem[] = [
    ...sources.deposits.records
      .filter((record) => !hiddenBehindOwnWithdrawal(record, withdrawals, sources.now))
      .flatMap((stored) =>
        sipaCredits(stored).map(({ record, token }): ActivityItem => {
          if (token) return { kind: "bridge.sipaDeposit", record, credit: token }
          const processing = sources.processing.get(lower(record.sipaAddress))
          return processing
            ? { kind: "bridge.sipaDeposit", record, processing }
            : { kind: "bridge.sipaDeposit", record }
        }),
      ),
    ...withdrawals.map((record): ActivityItem => ({ kind: "bridge.withdrawal", record })),
    ...[...upgrades.items, ...chainBatches].map(
      (batch): ActivityItem => ({ kind: "upgrade.batch", batch }),
    ),
  ]
  return items.sort((a, b) => itemStartTime(b) - itemStartTime(a))
}

function withdrawalItem(
  record: WithdrawalRecord,
  sources: FeedSources,
  ctx: FeedContext,
  moves: readonly SavingsMoveRecord[],
): FeedItem {
  const base = { id: record.localId, ts: bridgeItemTime({ kind: "bridge.withdrawal", record }) }
  if (record.skyMove) {
    const move = moves.find((m) => m.withdrawalLocalId === record.localId) ?? {
      ...savingsMoveOfWithdrawal(record)!,
      startTime: record.startTime,
    }
    return {
      ...base,
      kind: "savingsMove",
      direction: move.direction === "in" ? "out" : "in",
      pending: !isSavingsMoveSettled(move, record),
      move,
      burn: record,
    }
  }
  const exit = withdrawalExit(record, sources.now)
  const recipient = sources.deposits.records.find(
    (d) => lower(d.sipaAddress) === lower(record.recipient),
  )
  return {
    ...base,
    kind: "withdrawal",
    direction: "out",
    pending: !WITHDRAWAL_TERMINAL_PHASES.has(record.phase),
    record,
    delayed:
      isWithdrawalDelayed(record, sources.now) ||
      (exit?.kind === "swap" && exit.reason === "stuck"),
    exit,
    registrationTag: registrationTagForSipa(ctx.registrations, record.recipient, recipient),
  }
}

function depositItems(
  item: Extract<ActivityItem, { kind: "bridge.sipaDeposit" }>,
  sources: FeedSources,
  ctx: FeedContext,
  hide: { linked: ReadonlySet<string>; upgradeArrivals: ReadonlySet<string> },
): FeedItem[] {
  const { record, processing, credit } = item
  const address = lower(record.sipaAddress)
  if (hide.upgradeArrivals.has(address)) return []
  const burn = sources.withdrawals.records.find(
    (r) => r.intent === "migration" && lower(r.recipient) === address,
  )
  const unfunded = isUnfundedSipaDeposit(record)
  // A migration's arrival shows from its exit on; unfunded behind a failed burn it never fills.
  if (((!burn || burn.phase === "failed") && unfunded) || hide.linked.has(address)) return []
  const arriving = !!burn && unfunded
  const exitTime = burn ? burn.endTime ?? burn.startTime : undefined
  // A migration's arrival sits directly above its exit.
  const ts =
    exitTime !== undefined
      ? Math.max(arriving ? 0 : bridgeItemTime(item), exitTime + 1)
      : bridgeItemTime(item)
  const tag = registrationTagForDeposit(ctx.registrations, record)
  const offer = depositExitOffer(record, {
    processing,
    registration: registrationFor(ctx.registrations, record.sipaAddress),
    now: sources.now,
  })
  const subline = sipaReasonShown(processing, record, sources.now)
    ? { reason: processing.reason.kind }
    : offer?.waiting
    ? ("stuck" as const)
    : undefined
  // The tag's price came out of the deposit before it reached L2; its own row says where it went.
  const price = tagPriceOf(record)
  const purchase: FeedItem[] =
    tag && price && record.phase === "claimed" && !credit
      ? [
          {
            kind: "tagPurchase",
            id: `${record.sipaAddress}:tag`,
            ts: ts - 1,
            direction: "out",
            pending: false,
            record,
            tag,
            price,
          },
        ]
      : []
  return [
    ...purchase,
    {
      kind: "deposit",
      // A token the address credited beside its own is a row of its own.
      id: credit ? `${record.sipaAddress}:${credit.toLowerCase()}` : record.sipaAddress,
      ts,
      direction: "in",
      pending: !isSettledSipaPhase(record.phase),
      record,
      ...(credit ? { credit } : {}),
      processing,
      intent: tag ? "registration" : burn || isAccountMoveSipa(record) ? "migration" : "deposit",
      tag,
      offer,
      subline,
      arriving: arriving ? { net: burn && migrationAmounts(burn)?.netAtomic } : undefined,
    },
  ]
}

function groupItems(groups: readonly WithdrawalGroup[], now: number): FeedItem[] {
  return groups.map((group): FeedItem => {
    const named = [group.legs.gas, group.legs.funds].flatMap((r) => r ?? [])
    const legs = named.length ? named : group.records
    const delayed = legs.find((r) => {
      const exit = withdrawalExit(r, now)
      return isWithdrawalDelayed(r, now) || (exit?.kind === "swap" && exit.reason === "stuck")
    })
    const exit = legs.flatMap((record) => {
      const offer = withdrawalExit(record, now)
      return offer ? [{ record, exit: offer }] : []
    })[0]
    return {
      kind: "withdrawalGroup",
      id: group.groupId,
      ts: withdrawalGroupTime(group),
      direction: "out",
      pending: !isWithdrawalGroupTerminal(group),
      group,
      head: group.legs.gas ?? group.records[0],
      delayed,
      exit,
      unsent: isFundsLegUnsent(group),
    }
  })
}

/**
 * Funds each balance is owed but does not hold yet, at what will land, so a balance never drops
 * when funds arrive. A deposit counts once its sweep fixes the net; a migration or a Savings move
 * once its burn has left the source, at its quote, then at its deposit once the escrow has run,
 * until its destination's balance is read after this device stored the claim. A move rebuilt from
 * a rescan has no quote and counts only from its deposit. An upgrade's own deposits never count:
 * the upgrade lock holds Home's figure until the balance holds them.
 */
export function arrivingFunds(input: {
  deposits: readonly SIPADepositRecord[]
  burns: readonly WithdrawalRecord[]
  moves: readonly SavingsMoveRecord[]
  sharePrice?: bigint
  rows: readonly Transaction[]
  balanceReadAt?: { main?: number; savings?: number }
  upgradeRecipients?: ReadonlySet<string>
  oldVersions?: ArrivingFunds
  previousAccount?: string
}): ArrivingFunds {
  const { deposits, burns, moves, sharePrice, balanceReadAt = {} } = input
  const upgrades = input.upgradeRecipients ?? new Set<string>()
  let main = input.oldVersions?.main ?? 0n
  let savings = input.oldVersions?.savings ?? 0n
  const swept = (record: SIPADepositRecord) =>
    record.phase === "pendingClaim" && record.netAmount != null
  const depositBySipa = new Map(deposits.map((d) => [lower(d.sipaAddress), d] as const))
  // A burn still proving has not left its source yet.
  const left = (burn?: WithdrawalRecord) =>
    !!burn && burn.phase !== "submitting" && burn.phase !== "failed"
  // A read resolved after a claim landed holds it, though the record still awaits `claimed`.
  const held = ({ claimLanded, inboxIndex }: SIPADepositRecord) =>
    !!claimLanded &&
    claimLanded.inboxIndex === inboxIndex &&
    (balanceReadAt.main ?? 0) >= claimLanded.at
  const previous = input.previousAccount && lower(input.previousAccount)
  for (const record of deposits) {
    // A SIPA the account pays itself is not a deposit the user waits on.
    const upgrade = isAccountMoveSipa(record) || upgrades.has(lower(record.sipaAddress))
    const toPrevious = !!previous && lower(record.recipientL2Address ?? "") === previous
    if (swept(record) && !held(record) && !upgrade && !toPrevious) main += BigInt(record.netAmount!)
  }
  for (const burn of burns) {
    if (burn.intent !== "migration" || !left(burn)) continue
    const arrival = depositBySipa.get(lower(burn.recipient))
    if (
      arrival &&
      (swept(arrival) || isSettledSipaPhase(arrival.phase) || neverCreditsL2(arrival.phase))
    )
      continue
    main += migrationAmounts(burn)?.netAtomic ?? 0n
  }
  const burnById = new Map(burns.map((burn) => [burn.localId, burn] as const))
  for (const move of moves) {
    const burn = burnById.get(move.withdrawalLocalId)
    const into = move.direction === "in"
    const storedAt = move.deposit?.claimed ? move.deposit.storedAt : undefined
    const unread =
      storedAt !== undefined && (balanceReadAt[into ? "savings" : "main"] ?? 0) < storedAt
    if (!left(burn) || (isSavingsMoveSettled(move, burn) && !unread)) continue
    const landed = move.deposit && BigInt(move.deposit.amount)
    const figure =
      landed !== undefined && (!into || sharePrice !== undefined)
        ? into
          ? savingsValue(landed, sharePrice!)
          : landed
        : move.net === undefined
        ? 0n
        : BigInt(move.net)
    if (into) savings += figure
    else main += figure
  }
  for (const tx of input.rows) {
    const inbound = tx.action === PaylinkActionEnum.CLAIM || tx.action === "faucet"
    if (tx.status !== "pending" || !inbound || !("token" in tx) || !tx.token) continue
    if (tx.token.hasUnknownAmount) continue
    const { decimals } = tx.token
    const scale = DEFAULT_DECIMALS - decimals
    main += scale >= 0 ? tx.amountAtomic * 10n ** BigInt(scale) : tx.amountAtomic
  }
  return { main, savings }
}

/** Every source merged into the feed. */
export function selectFeed(sources: FeedSources, ctx: FeedContext): Feed {
  const { now } = sources
  const rows = sources.rows.records
  const directory = directoryOf(ctx.contacts.rows)
  const bridge = bridgeOf(sources)
  const deposits = sources.deposits.records
  const withdrawals = sources.withdrawals.records
  const moves = sources.moves.records
  const groups = withdrawalGroupsOf(withdrawals)
  const upgradeRuns = upgradeRunsOf(bridge)
  const hide = {
    // Request-link SIPAs show as the request.
    linked: requestLinkedSipaAddresses(sources.requests),
    // An upgrade is one row over its batches; their deposits are its legs.
    upgradeArrivals: upgradeRecipients(bridge),
  }
  // A registration a burn from this wallet paid: the burn's row is the registration's.
  const burnFunded = new Set(
    withdrawals.filter((r) => r.intent === "registration").map((r) => lower(r.recipient)),
  )
  const { registration } = ctx
  const items: FeedItem[] = [
    ...requestItems(sources.requests, rows, deposits, directory, ctx, now),
    ...txItems(rows, sources.requests, directory, sources, ctx),
    ...upgradeRuns.map(
      (run): FeedItem => ({
        kind: "upgrade",
        id: `upgrade-run:${run.run}`,
        ts: run.time,
        direction: "in",
        pending: !run.settled,
        run,
      }),
    ),
    ...sources.oldVersionWithdrawals.map(
      (record): FeedItem => ({
        kind: "oldVersionWithdrawal",
        id: `old-version-withdrawal:${record.id}`,
        ts: record.startTime,
        direction: "out",
        pending: record.phase === "sending",
        record,
      }),
    ),
    ...groupItems(groups, now),
    ...bridge.flatMap((item): FeedItem[] => {
      if (item.kind === "bridge.withdrawal")
        return item.record.groupId ? [] : [withdrawalItem(item.record, sources, ctx, moves)]
      if (item.kind === "bridge.sipaDeposit") return depositItems(item, sources, ctx, hide)
      return []
    }),
    ...(registration && !burnFunded.has(lower(registration.sipaAddress))
      ? [
          {
            kind: "registration" as const,
            id: "registration-deposit",
            ts: registration.ts,
            direction: "in" as const,
            pending: true,
          },
        ]
      : []),
  ]
    .filter((item) => sources.cutoff === undefined || item.ts >= sources.cutoff)
    .sort((a, b) => b.ts - a.ts)

  const burns = new Map(withdrawals.map((record) => [record.localId, record] as const))
  const savingsItems = moves.map(
    (move): SavingsItem => ({
      id: move.withdrawalLocalId,
      ts: move.startTime,
      direction: move.direction,
      pending: !isSavingsMoveSettled(move, burns.get(move.withdrawalLocalId)),
      move,
      burn: burns.get(move.withdrawalLocalId),
    }),
  )
  return {
    items,
    bridge,
    groups,
    upgradeRuns,
    hydrated:
      sources.rows.loaded &&
      !sources.rows.failed &&
      sources.requestsLoaded !== false &&
      sources.deposits.hydrated &&
      sources.upgrades.loaded &&
      sources.withdrawals.hydrated &&
      (ctx.contacts.hydrated || ctx.contacts.failed) &&
      !sources.catchingUp,
    requestsUnavailable: ctx.contacts.failed,
    // The store, not the feed: the feed hides a deposit behind the burn that paid it.
    arriving: arrivingFunds({
      deposits,
      burns: withdrawals,
      moves,
      sharePrice: ctx.sharePrice,
      rows,
      balanceReadAt: ctx.balanceReadAt,
      upgradeRecipients: sources.upgrades.recipients,
      oldVersions: ctx.oldVersions,
      previousAccount: ctx.previousAccount,
    }),
    upgradesLoaded: sources.upgrades.loaded,
    savings: {
      items: savingsItems,
      hydrated: sources.moves.hydrated,
      ledger: sources.moves.hydrated ? savingsLedger([...moves], burns) : undefined,
    },
    csv: { transactions: rows, items: bridge, requests: sources.requests },
    savingsCsv: { moves, burns },
  }
}

/** A request nobody has paid: it files under Pending, never Sent or Received. */
export const isUnpaidRequest = (item: FeedItem) => item.kind === "request"

export const isIncomingRequest = (item: FeedItem) =>
  item.kind === "request" && item.role === "incoming"

/** Home: incoming requests in their own slot above the feed. */
export function selectHome(feed: Feed): { requests: FeedItem[]; feed: FeedItem[] } {
  return {
    requests: feed.items.filter(isIncomingRequest),
    feed: feed.items.filter((item) => !isIncomingRequest(item)),
  }
}

export type ActivityFilter = "All" | "Sent" | "Received" | "Pending"

export function matchesFilter(item: Base & { kind?: string }, filter: ActivityFilter): boolean {
  const unpaid = item.kind === "request"
  if (filter === "Sent") return item.direction === "out" && !unpaid
  if (filter === "Received") return item.direction === "in" && !unpaid
  if (filter === "Pending") return item.pending
  return true
}

/** The Activity list for a filter, Main's feed or the Savings account's. */
export function selectActivity<T extends Base & { kind?: string }>(
  items: readonly T[],
  filter: ActivityFilter,
): T[] {
  return items.filter((item) => matchesFilter(item, filter))
}

/** Requests' boxes: the unpaid ones made by the user, those made to them, and the inbox count. */
export function selectRequests(
  feed: Feed,
  nonContacts: number,
): { sent: FeedItem[]; received: FeedItem[]; receivedCount: number } {
  const unpaid = feed.items.filter(isUnpaidRequest)
  const received = unpaid.filter(isIncomingRequest)
  return {
    sent: unpaid.filter((item) => !isIncomingRequest(item)),
    received,
    receivedCount: received.length + nonContacts,
  }
}

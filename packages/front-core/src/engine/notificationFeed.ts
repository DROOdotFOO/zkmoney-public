/**
 * The bell as a selector: entries read off the records and the events, joined with what the user
 * did with each. Nothing here is stored; the view words each entry from its `about`.
 */
import type { ConfirmationOutcome } from "../core/services/coordination/ReorgMonitor"
import type { OldVersionWithdrawal } from "../core/migration/OldVersionWithdrawalStorage"
import type { OperationRecord } from "../core/services/operations/OperationStore"
import type { PendingRegistrationRecord } from "../core/services/registration/PendingRegistrationStore"
import {
  depositOwed,
  registrationStage,
  type RegistrationStage,
} from "../core/services/registration/registrationStage"
import { sipaReasonShown, type SipaProcessingKind } from "../core/services/deposits/sipaProcessing"
import type { PaylinkTransaction, TokenTransaction, Transaction } from "../types/transactions"
import {
  bridgeEntries,
  recoveredWithdrawalIds,
  type BridgeAbout,
  type BridgeEntry,
  type BridgeSources,
  type BridgeTarget,
} from "./notificationBridge"
import {
  isOld,
  type NotificationEvent,
  type Notifications,
  type NotificationState,
  type Stampable,
} from "./notifications"
import { bestEffort } from "./errors"
import { derived, type ReadonlyStore } from "./store"

export type NotificationSeverity = "info" | "success" | "error"

export type NotificationTarget =
  | BridgeTarget
  | { type: "upgrade.run"; run: string }
  | { type: "transfer.txDetail"; txHash: string }
  | { type: "transfer.pending" }
  | { type: "paylink.claimed"; txHash: string }
  | { type: "paylink.reclaimable"; txHash: string }
  | { type: "reorg.txDetail"; txHash: string }
  | { type: "contact.added"; contactId: string }
  | { type: "migration.residuals" }
  | { type: "migration.run" }
  | { type: "registration.pending"; tag: string }
  | { type: "withdraw.oldVersion"; id: string }
  | { type: "request.share"; requestId: string }

export type RegistrationLiveStage = Exclude<RegistrationStage, "reserved" | "registered" | "failed">

/** What an entry reports; the view words it. */
export type NotificationAbout =
  | BridgeAbout
  | {
      kind: "registrationLive"
      tag: string
      stage: RegistrationLiveStage
      reason?: SipaProcessingKind
    }
  | { kind: "registrationEnded"; tag: string; registered: boolean }
  | { kind: "receive"; tx: TokenTransaction }
  | { kind: "paylinkClaimed"; tx: PaylinkTransaction }
  | { kind: "operation"; record: OperationRecord }
  /** A "Withdraw to Ethereum" run from old versions. */
  | { kind: "oldVersionWithdrawal"; record: OldVersionWithdrawal }
  /** `tx`: the paylink row a reclaim notice names. */
  | { kind: "event"; event: NotificationEvent; tx?: PaylinkTransaction }

export interface NotificationEntry {
  id: string
  about: NotificationAbout
  timestampMs: number
  severity: NotificationSeverity
  icon: string
  /** Work still in flight: the row spins, and it cannot be dismissed. */
  pending: boolean
  read: boolean
  /** When the entry was first listed; an operation's is its ending. */
  firstSeenAt: number
  target: NotificationTarget
}

export interface NotificationSources extends BridgeSources {
  rows: readonly Transaction[]
  oldVersionWithdrawals: readonly OldVersionWithdrawal[]
  registrations: readonly PendingRegistrationRecord[]
  /** The active wallet's L2 address: its registration is the one reported. */
  account?: string
  /**
   * Ended operations, dismissed ones included, and the ones still running. An entry another one
   * covers stays hidden whatever the user did with the cover.
   */
  operations: { ended: readonly OperationRecord[]; running: readonly OperationRecord[] }
  /**
   * Every source above has loaded, so an entry missing from the list is gone, and the history replay
   * is in, so an entry listed later is new.
   */
  loaded: boolean
}

/** An entry before the join; `timestampMs` unset takes its first sighting. */
export interface DerivedNotification extends Stampable {
  about: NotificationAbout
  timestampMs?: number
  severity: NotificationSeverity
  icon: string
  pending: boolean
  target: NotificationTarget
}

const lower = (hash: string) => hash.toLowerCase()

export const claimedNotificationId = (txHash: string) => `paylink:claimed:${lower(txHash)}`

const claimReversedId = (txHash: string) => `paylink:claim-reversed:${lower(txHash)}`

export const reorgFailedId = (txHash: string, epoch = 0) => `reorg:failed:${lower(txHash)}:${epoch}`

const isPaylinkRow = (tx: Transaction): tx is PaylinkTransaction =>
  (tx as PaylinkTransaction).emailPaymentAction !== undefined

function registrationEntries(sources: NotificationSources, now: number): DerivedNotification[] {
  const account = sources.account?.toLowerCase()
  const record = account
    ? sources.registrations.find((r) => r.l2Address.toLowerCase() === account)
    : undefined
  if (!record) return []
  const address = record.sipaAddress.toLowerCase()
  const deposit = sources.deposits.records.find((d) => d.sipaAddress.toLowerCase() === address)
  const stage = registrationStage(record, { deposit, burns: sources.withdrawals.records })
  if (depositOwed(stage)) return []
  // Keyed by the name: a second name the account registers gets rows of its own.
  const id = `registration:${record.account.toLowerCase()}:${record.nameHash.toLowerCase()}`
  const claim = { type: "registration.pending", tag: record.tag } as const
  if (stage === "registered" || stage === "failed") {
    const registered = stage === "registered"
    return [
      {
        id,
        about: { kind: "registrationEnded", tag: record.tag, registered },
        timestampMs: record.endTime,
        severity: registered ? "success" : "error",
        icon: registered ? "checkmark.circle" : "exclamationmark.triangle",
        pending: false,
        // Registered, there is nothing left to claim: the row opens the deposit's detail.
        target: registered
          ? { type: "bridge.txDetail", bridgeKind: "deposit", sourceId: address }
          : claim,
        settledAt: record.endTime,
      },
    ]
  }
  const processing = sources.processing.get(address)
  const waiting =
    (stage === "received" || stage === "sweeping") &&
    !!deposit &&
    sipaReasonShown(processing, deposit, now)
  return [
    {
      id: `${id}:live`,
      about: {
        kind: "registrationLive",
        tag: record.tag,
        stage,
        ...(waiting && processing ? { reason: processing.reason.kind } : {}),
      },
      timestampMs: record.fundedAt ?? record.startTime,
      severity: "info",
      icon: "arrow.down.left",
      pending: true,
      target: claim,
    },
  ]
}

/** One entry per withdrawal of old-version funds: pending while it sends, then its outcome. */
function oldVersionWithdrawalEntries(sources: NotificationSources): DerivedNotification[] {
  return sources.oldVersionWithdrawals.map((record) => {
    const sending = record.phase === "sending"
    const done = record.phase === "done"
    return {
      id: `old-version-withdrawal:${record.id}`,
      about: { kind: "oldVersionWithdrawal", record },
      timestampMs: record.startTime,
      severity: sending ? "info" : done ? "success" : "error",
      icon: sending ? "arrow.up.right" : done ? "checkmark.circle.fill" : "xmark.circle.fill",
      pending: sending,
      target: { type: "withdraw.oldVersion", id: record.id },
    }
  })
}

function rowEntries(
  sources: NotificationSources,
  reversed: ReadonlySet<string>,
): DerivedNotification[] {
  const out: DerivedNotification[] = []
  for (const tx of sources.rows) {
    if (!tx.txHash) continue
    if ((tx as TokenTransaction).action === "receive") {
      out.push({
        id: `transfer:receive:${lower(tx.txHash)}`,
        about: { kind: "receive", tx: tx as TokenTransaction },
        timestampMs: tx.timestamp,
        severity: "success",
        icon: "arrow.down.left",
        pending: false,
        target: { type: "transfer.txDetail", txHash: tx.txHash },
        settledAt: tx.timestamp,
      })
    }
    // A claim a reorg reverted keeps its entry beside the reversal. The creator's own claim is not
    // news to them.
    if (
      isPaylinkRow(tx) &&
      tx.claimedBy !== "self" &&
      (tx.isClaimed || reversed.has(lower(tx.txHash)))
    ) {
      out.push({
        id: claimedNotificationId(tx.txHash),
        about: { kind: "paylinkClaimed", tx },
        timestampMs: tx.claimedAt,
        severity: "success",
        icon: "checkmark.circle",
        pending: false,
        target: { type: "paylink.claimed", txHash: tx.txHash },
        settledAt: tx.claimedAt ?? tx.timestamp,
      })
    }
  }
  return out
}

function eventEntry(event: NotificationEvent, rows: readonly Transaction[]): DerivedNotification {
  const entry = (
    severity: NotificationSeverity,
    icon: string,
    target: NotificationTarget,
    tx?: PaylinkTransaction,
  ): DerivedNotification => ({
    id: event.id,
    about: { kind: "event", event, ...(tx && { tx }) },
    timestampMs: event.at,
    pending: false,
    severity,
    icon,
    target,
  })
  switch (event.kind) {
    case "reorg": {
      const target = { type: "reorg.txDetail", txHash: event.data.txHash } as const
      const { outcome } = event.data
      if (outcome === "failed") return entry("error", "exclamationmark.triangle", target)
      return entry("success", "checkmark.circle", target)
    }
    case "contactAdded": {
      const target = { type: "contact.added", contactId: event.data.contactId } as const
      return entry("success", "person.crop.circle.badge.plus", target)
    }
    case "claimReversed":
      return entry("info", "arrow.uturn.backward", {
        type: "paylink.claimed",
        txHash: event.data.txHash,
      })
    case "reclaimable": {
      const { txHash } = event.data
      const tx = rows.find(
        (r): r is PaylinkTransaction => isPaylinkRow(r) && lower(r.txHash) === lower(txHash),
      )
      return entry("info", "clock.arrow.circlepath", { type: "paylink.reclaimable", txHash }, tx)
    }
    case "migrationResiduals":
      return entry("info", "clock.arrow.circlepath", { type: "migration.residuals" })
    case "migrationRun": {
      const { stop } = event.data
      const severity = stop === "needsAttention" || stop === "failed" ? "error" : "info"
      return entry(severity, "exclamationmark.circle", { type: "migration.run" })
    }
  }
}

/** Every entry the records and events make, before the join: what the `firstSeenAt` writer stamps. */
export function deriveNotifications(
  sources: NotificationSources,
  events: ReadonlyMap<string, NotificationEvent>,
  now: number,
): DerivedNotification[] {
  const reversed = new Set(
    [...events.values()].flatMap((e) => (e.kind === "claimReversed" ? [lower(e.data.txHash)] : [])),
  )
  const all: (DerivedNotification | BridgeEntry)[] = [
    ...bridgeEntries(sources, now),
    ...registrationEntries(sources, now),
    ...oldVersionWithdrawalEntries(sources),
    ...rowEntries(sources, reversed),
    ...[...events.values()].map((event) => eventEntry(event, sources.rows)),
  ]
  const seen = new Set<string>()
  return all.filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id)) as DerivedNotification[]
}

/**
 * Every source has loaded and every entry the writer stamps has its state row saved, so the bell
 * lists all it will for these records; an entry that shows after this is new.
 */
export function notificationsStamped(
  sources: NotificationSources,
  state: ReadonlyMap<string, NotificationState>,
  events: ReadonlyMap<string, NotificationEvent>,
  now: number,
  /** Ids the writer found or gave a state row, loaded or not. */
  stamped: ReadonlySet<string> = new Set(),
): boolean {
  const known = (id: string) => state.has(id) || stamped.has(id)
  return (
    sources.loaded &&
    deriveNotifications(sources, events, now).every((e) => known(e.id) || isOld(e, known, now))
  )
}

/** State rows the writer forgets: a recovered withdrawal's failure, so a later one rings anew. */
export function retiredNotifications(sources: NotificationSources): string[] {
  return recoveredWithdrawalIds(sources.withdrawals)
}

/** A request link's publish carries its request in its id, so its rows can open that request. */
export function requestLinkOperationId(requestId: string): string {
  return `request-link_${requestId}_${crypto.randomUUID()}`
}

function requestOfLinkOperation(operationId: string): string | undefined {
  return /^request-link_(0x[0-9a-f]+)_/.exec(operationId)?.[1]
}

function operationTarget(record: OperationRecord): NotificationTarget {
  // A request link's publish is no payment, so it has no activity row: its rows open the request.
  const requestId =
    record.flow === "request-link" ? requestOfLinkOperation(record.operationId) : undefined
  if (requestId) return { type: "request.share", requestId }
  return record.state === "settled" && record.txHash
    ? { type: "transfer.txDetail", txHash: record.txHash }
    : { type: "transfer.pending" }
}

function operationEntry(record: OperationRecord): NotificationEntry | null {
  if (record.endedAt === undefined || record.dismissedAt !== undefined) return null
  const settled = record.state === "settled"
  return {
    id: `operation:${record.operationId}`,
    about: { kind: "operation", record },
    timestampMs: record.endedAt,
    severity: settled ? "success" : "error",
    icon: settled ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
    pending: false,
    read: record.readAt !== undefined,
    firstSeenAt: record.endedAt,
    target: operationTarget(record),
  }
}

/**
 * The bell's entries, newest first. An entry shows once it has a state row, until dismissed; a
 * pending one shows while its work runs. A running leg of a fresh-address withdrawal stands for its
 * group's live row. A reorg failure is left out where an ended operation already reports the
 * failed send, or where its withdrawal burn is live again.
 */
export function selectNotifications(
  sources: NotificationSources,
  state: ReadonlyMap<string, NotificationState>,
  events: ReadonlyMap<string, NotificationEvent>,
  now: number,
): NotificationEntry[] {
  const { ended, running } = sources.operations
  const stoodFor = new Set(
    running.flatMap(({ operationId }) => {
      const group = sources.withdrawals.records.find((w) => w.operationId === operationId)?.groupId
      return group ? [`bridge:withdrawal-group:${group.toLowerCase()}:inflight`] : []
    }),
  )
  const covered = new Set([
    ...ended.flatMap((op) => (op.state === "failed" && op.txHash ? [lower(op.txHash)] : [])),
    ...sources.withdrawals.records.flatMap((w) =>
      w.phase !== "failed" && w.intent !== "registration" && w.l2TxHash ? [lower(w.l2TxHash)] : [],
    ),
  ])
  const hidden = (entry: DerivedNotification) =>
    stoodFor.has(entry.id) ||
    (entry.about.kind === "event" &&
      entry.about.event.kind === "reorg" &&
      entry.about.event.data.outcome === "failed" &&
      covered.has(lower(entry.about.event.data.txHash)))

  const entries: NotificationEntry[] = []
  for (const entry of deriveNotifications(sources, events, now)) {
    const row = state.get(entry.id)
    if (!row || (row.dismissedAt !== undefined && !entry.pending) || hidden(entry)) continue
    entries.push({
      id: entry.id,
      about: entry.about,
      timestampMs: entry.timestampMs ?? row.firstSeenAt,
      severity: entry.severity,
      icon: entry.icon,
      pending: entry.pending,
      read: row.readAt !== undefined,
      firstSeenAt: row.firstSeenAt,
      target: entry.target,
    })
  }
  for (const record of ended) {
    const entry = operationEntry(record)
    if (entry) entries.push(entry)
  }
  return entries.sort((a, b) => b.timestampMs - a.timestampMs)
}

/**
 * The event a reorg outcome reports, keyed per episode; null where the bell stays quiet. `known`:
 * the bell holds this id, so a re-inclusion answers the failure it reported, even from a page
 * load before.
 */
export function reorgEvent(
  outcome: ConfirmationOutcome,
  at: number,
  known: (id: string) => boolean,
): NotificationEvent | null {
  const hash = lower(outcome.txHash)
  const { txHash } = outcome
  switch (outcome.type) {
    case "failed":
    case "grace-expired":
      // A withdrawal's failure is its record's to report.
      if (outcome.type === "failed" && outcome.source === "withdrawal") return null
      return {
        id: reorgFailedId(hash, outcome.reorgEpoch),
        at,
        kind: "reorg",
        data: { outcome: "failed", txHash, incoming: !!outcome.incoming },
      }
    case "re-confirmed":
      if (!outcome.hadAlerted && !known(reorgFailedId(hash, outcome.reorgEpoch))) return null
      return {
        id: `reorg:reconfirmed:${hash}:${outcome.reorgEpoch ?? 0}`,
        at,
        kind: "reorg",
        data: { outcome: "reconfirmed", txHash, withdrawal: outcome.source === "withdrawal" },
      }
    default:
      return null
  }
}

/**
 * The one writer of `firstSeenAt`: whenever the records or the events change, every new entry is
 * stamped (or left out for good when it settled before the window) and recovered failures are
 * forgotten. It also records each claim reversal. Every input holds saved records only, so a write
 * whose save failed causes nothing. Returns the unsubscribe.
 */
export function watchNotifications(
  sources: ReadonlyStore<NotificationSources>,
  clock: ReadonlyStore<number>,
  notifications: Notifications,
): () => void {
  const inputs = derived([sources, clock, notifications.events] as const, (s, now, events) => ({
    listed: deriveNotifications(s, events, now),
    retired: retiredNotifications(s),
    complete: s.loaded,
  }))
  const write = () => {
    const { listed, retired, complete } = inputs.get()
    void bestEffort("unknown", notifications.observe(listed, retired, Date.now(), complete))
  }
  const reversed = derived(
    [sources, notifications.state, notifications.events] as const,
    (s, state, events) => claimReversals(s.rows, state, events),
    (a, b) => a.join() === b.join(),
  )
  const reverse = () => {
    for (const txHash of reversed.get()) {
      const event = { id: claimReversedId(txHash), at: Date.now(), kind: "claimReversed" as const }
      void bestEffort("unknown", notifications.record({ ...event, data: { txHash } }))
    }
  }
  const offs = [inputs.subscribe(write), reversed.subscribe(reverse)]
  write()
  reverse()
  return () => offs.forEach((off) => off())
}

/**
 * The claims a reorg undid that the bell listed and has not yet reported reversed. A demote bumps
 * the link's epoch and clears `isClaimed`; a refund clears it too, so a refunded link is no reversal.
 */
export function claimReversals(
  rows: readonly Transaction[],
  state: ReadonlyMap<string, NotificationState>,
  events: ReadonlyMap<string, NotificationEvent>,
): string[] {
  return rows.flatMap((tx) =>
    isPaylinkRow(tx) &&
    !!tx.txHash &&
    !tx.isClaimed &&
    !tx.isRefunded &&
    !tx.isMigrated &&
    (tx.reorgEpoch ?? 0) > 0 &&
    state.has(claimedNotificationId(tx.txHash)) &&
    !events.has(claimReversedId(tx.txHash))
      ? [tx.txHash]
      : [],
  )
}

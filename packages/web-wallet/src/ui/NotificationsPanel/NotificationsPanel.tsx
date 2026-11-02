import { Icon, Spinner, TopNavIconButton } from "@obsidion/web-ds"
import { useCallback, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import {
  bestEffort,
  notificationsStamped,
  selectNotifications,
  useStore,
  type NotificationEntry,
  type OperationRecord,
} from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import { fmt } from "../../lib/fmt"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { rowTimestamp } from "../format"
import { Modal } from "../Modal"
import { usePhoneLayout } from "../usePhoneLayout"
import copy from "../notifications.copy"
import { notificationText } from "../notificationText"
import { flowCopy } from "../../features/operations/operationCopy"
import { openMigrationDialog } from "../../features/migration/migrationDialog"
import type { Bell } from "../../features/notifications/notifications"
import { useSession } from "../../platform/session"
import { operationIdOf } from "../../features/operations/operationEntries"
import { openTicketClaimReview } from "../../features/paylink/claimPrompt"
import { pendingTicketRegistration } from "../../features/paylink/ticketContinuation"
import { TabLine, type TabPlace } from "../../features/operations/TabLine"
import { getOperationStore, operationsLoaded } from "../../features/operations/operations"
import styles from "./NotificationsPanel.module.css"

const panelOpen = createExternalState(false)

/** Panel visibility, shared so any flow can open what the bell owns. */
export function useNotificationsPanelOpen(): [boolean, (open: boolean) => void] {
  return [useSyncExternalStore(panelOpen.subscribe, panelOpen.get), panelOpen.set]
}

/** SF Symbol names the entries carry → web-ds glyphs. */
const ICON: Record<string, string> = {
  "arrow.down.left": "receive",
  "arrow.up.right": "send",
  "link": "link",
  "checkmark.circle": "check-circle",
  "checkmark.circle.fill": "check-circle",
  "exclamationmark.triangle": "alert-triangle",
  "exclamationmark.triangle.fill": "alert-triangle",
  "arrow.uturn.backward": "reply",
  "person.crop.circle.badge.plus": "user-follow",
  "clock.arrow.circlepath": "history-clock",
}

export interface NotificationRoute {
  /** Where the tap lands; unset when it opens something over the current screen. */
  to?: string
  /** Router state the activity feed opens a detail modal from. */
  state?: Record<string, string>
  /** Open the pending name's claim review on Home. */
  activate?: boolean
  /** Open the migration dialog, at the residuals' list for their row. */
  migration?: "residuals" | "run"
}

/**
 * Where a row tap lands: a mutual add opens the contact, funds on an old version the migration
 * dialog, a request link's publish its sheet, everything else the matching activity detail.
 */
export function notificationRoute(entry: NotificationEntry): NotificationRoute | null {
  const t = entry.target as {
    type: string
    run?: string
    txHash?: string
    bridgeKind?: string
    sourceId?: string
    contactId?: string
  }
  if (t.type === "contact.added") {
    return t.contactId ? { to: `/contacts/${encodeURIComponent(t.contactId)}` } : null
  }
  if (t.type === "request.share") {
    const requestId = (entry.target as { requestId?: string }).requestId
    return requestId ? { to: "/activity", state: { openRequestId: requestId } } : null
  }
  if (t.type === "migration.residuals") return { migration: "residuals" }
  if (t.type === "migration.run") return { migration: "run" }
  if (t.type === "withdraw.oldVersion") return { to: "/activity" }
  if (t.type === "registration.pending") {
    // A payment link's registration is Home's: its claim runs there and its review reports it, so
    // the wizard's deposit ask is never the place to land.
    if (pendingTicketRegistration()) return { to: "/", activate: true }
    const tag = (entry.target as { tag?: string }).tag
    return tag ? { to: `/claim/${encodeURIComponent(tag)}` } : null
  }
  const notice = fmt(copy.panel.toast, notificationText(entry))
  // A failure alert is stale once a re-inclusion confirms its row or revives its withdrawal. A
  // withdrawal's failed entry is one; "Funds not sent", an error on the same target, is not.
  const failure =
    t.type === "reorg.txDetail" || (t.bridgeKind === "withdrawal" && /:failed(:|$)/.test(entry.id))
  const noticeStale: Record<string, string> =
    failure && entry.severity === "error" ? { noticeStaleOn: "success" } : {}
  if (t.type === "upgrade.run" && t.run) {
    return { to: "/activity", state: { openUpgradeRun: t.run, notice } }
  }
  if (t.type === "bridge.txDetail" && t.sourceId) {
    return {
      to: "/activity",
      state:
        t.bridgeKind === "withdrawal"
          ? { openWithdrawalId: t.sourceId, notice, ...noticeStale }
          : { openDepositAddress: t.sourceId, notice },
    }
  }
  return t.txHash
    ? { to: "/activity", state: { openTxHash: t.txHash, notice, ...noticeStale } }
    : null
}

/** What opening an entry does; null when it has nothing to open here. */
export type EntryOpener = (entry: NotificationEntry) => (() => void) | null

/** The wallet's opener: every entry's detail is a route. */
export function useRouteOpener(): EntryOpener {
  const navigate = useNavigate()
  return useCallback(
    (entry: NotificationEntry) => {
      const route = notificationRoute(entry)
      return route
        ? () => {
            if (route.migration)
              openMigrationDialog(route.migration === "residuals" ? "residuals" : undefined)
            if (route.activate) openTicketClaimReview()
            if (route.to) navigate(route.to, route.state ? { state: route.state } : undefined)
          }
        : null
    },
    [navigate],
  )
}

/**
 * Toast identity. A live row and its settled outcome are the same entry id, so the key carries the
 * state too — otherwise a row seen in flight would count as already toasted once it settles.
 */
export function toastKey(entry: NotificationEntry): string {
  return entry.pending ? `${entry.id}:pending` : entry.id
}

/**
 * Entries the bell should toast: unread, not yet shown, settled, and either first seen since
 * `since` or seen live by this bell. A live row is status; an entry first seen settled before is
 * the backlog behind the bell.
 */
export function freshToasts(
  entries: NotificationEntry[],
  seen: Set<string>,
  since: number,
): NotificationEntry[] {
  return entries.filter(
    (e) =>
      !e.read &&
      !e.pending &&
      !seen.has(toastKey(e)) &&
      (e.firstSeenAt >= since || seen.has(toastKey({ ...e, pending: true }))),
  )
}

/**
 * What one bell shows, for a page that is not the wallet: the entries and running operations it may
 * list, count and toast. Everything else in the store is left untouched by that bell.
 */
export interface NotificationScope {
  entry: (entry: NotificationEntry) => boolean
  operation: (operationId: string) => boolean
}

/**
 * What the bell lists: this scope's running operations, and the entries read off the records and
 * events, newest first. Actions route an operation's entry to its record.
 */
export function useNotificationList(scope?: NotificationScope) {
  const select = useCallback(
    ({ sources, state, events, stamped, now }: Bell) => {
      const running = sources.operations.running.filter(
        (op) => !scope || scope.operation(op.operationId),
      )
      const entries = selectNotifications(
        { ...sources, operations: { ...sources.operations, running } },
        state,
        events,
        now,
      ).filter((e) => !scope || scope.entry(e))
      return {
        running,
        entries,
        state,
        stamped: notificationsStamped(sources, state, events, now, stamped),
      }
    },
    [scope],
  )
  const { bell, notifications } = useSession()
  const { running, entries, state, stamped } = useStore(bell, select)
  const loaded = useStore(operationsLoaded)
  const dismiss = useCallback(
    (id: string) => {
      const operationId = operationIdOf(id)
      if (!operationId) return void bestEffort("unknown", notifications.dismiss([id]))
      void getOperationStore().dismiss(operationId).catch(console.warn)
    },
    [notifications],
  )
  /**
   * Opening an entry: an operation's is marked read, and so are the old-version funds row and a
   * waiting upgrade's, which stay while those do. Any other is cleared.
   */
  const opened = useCallback(
    (entry: NotificationEntry) => {
      const operationId = operationIdOf(entry.id)
      if (operationId) void getOperationStore().markRead([operationId]).catch(console.warn)
      else if (entry.target.type === "migration.residuals" || entry.target.type === "migration.run")
        void bestEffort("unknown", notifications.markRead([entry.id]))
      else if (!entry.pending) void bestEffort("unknown", notifications.dismiss([entry.id]))
    },
    [notifications],
  )
  const markAllRead = useCallback(() => {
    const unread = scope
      ? entries.filter((e) => !e.read).map((e) => e.id)
      : [...entries.filter((e) => !e.read).map((e) => e.id), ...state.keys()]
    void bestEffort("unknown", notifications.markRead(unread.filter((id) => !operationIdOf(id))))
    const ops = unread.map(operationIdOf).filter((id) => id !== undefined)
    if (ops.length) void getOperationStore().markRead(ops).catch(console.warn)
  }, [scope, entries, state, notifications])
  // Running operations and live rows stay: their work has not ended.
  const clearAll = useCallback(() => {
    for (const e of entries) if (!e.pending) dismiss(e.id)
    if (!scope) void getOperationStore().dismissEnded(getActiveStorageId()).catch(console.warn)
  }, [scope, entries, dismiss])
  return {
    entries,
    running,
    hydrated: loaded && stamped,
    unreadCount: entries.filter((e) => !e.read).length,
    dismiss,
    opened,
    markAllRead,
    clearAll,
  }
}

export function NotificationsPanel({
  onClose,
  openEntry,
  place,
  scope,
}: {
  onClose: () => void
  openEntry?: EntryOpener
  place?: TabPlace
  scope?: NotificationScope
}) {
  const byRoute = useRouteOpener()
  const opener = openEntry ?? byRoute
  const phone = usePhoneLayout()
  const { entries, running, unreadCount, dismiss, opened, clearAll } = useNotificationList(scope)
  const rows = [
    ...running.map((op) => ({ key: op.operationId, time: op.startedAt, op, entry: undefined })),
    ...entries.map((entry) => ({ key: entry.id, time: entry.timestampMs, op: undefined, entry })),
  ].sort((a, b) => b.time - a.time)

  const open = (entry: NotificationEntry) => {
    opened(entry)
    onClose()
    opener(entry)?.()
  }

  const content = (
    <>
      <div className={styles.notificationsHead}>
        <span>{copy.panel.title}</span>
        <span className={styles.notificationsHeadActions}>
          {unreadCount > 0 && (
            <span className={styles.notificationsNew}>
              {fmt(copy.panel.new, { count: unreadCount })}
            </span>
          )}
          {entries.some((e) => !e.pending) && (
            <button
              type="button"
              className="zkm-btn-reset ww-notifications__clear"
              onClick={clearAll}
            >
              {copy.panel.clearAll}
            </button>
          )}
          {phone && <TopNavIconButton icon="x" ariaLabel={copy.panel.close} onClick={onClose} />}
        </span>
      </div>
      <div className={styles.notificationsList}>
        {rows.length === 0 && <p className={styles.notificationsEmpty}>{copy.panel.empty}</p>}
        {rows.map(({ key, op, entry }) =>
          op ? (
            <OperationRow key={key} operation={op} place={place} />
          ) : (
            <EntryRow key={key} entry={entry!} onOpen={open} onDismiss={dismiss} />
          ),
        )}
      </div>
    </>
  )
  return phone ? (
    <Modal variant="bare" label={copy.panel.title} className="ww-notifications" onClose={onClose}>
      {content}
    </Modal>
  ) : (
    <div className="ww-notifications" role="dialog" aria-label={copy.panel.title}>
      {content}
    </div>
  )
}

function EntryRow({
  entry,
  onOpen,
  onDismiss,
}: {
  entry: NotificationEntry
  onOpen: (entry: NotificationEntry) => void
  onDismiss: (id: string) => void
}) {
  const { title, description } = notificationText(entry)
  return (
    <div className="ww-notifications__item">
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-notifications__row"
        onClick={() => onOpen(entry)}
      >
        <div className="zkm-avatar__disc zkm-activity-row__glyph">
          <Icon name={ICON[entry.icon] ?? "bell"} size={20} color="#fff" />
        </div>
        <span className={styles.notificationsBody}>
          <span className="ww-notifications__title">{title}</span>
          <span className="ww-notifications__desc">{description}</span>
        </span>
        <span className="ww-notifications__time">
          {entry.pending ? <Spinner size={14} /> : rowTimestamp(entry.timestampMs)}
        </span>
        {!entry.read && <span className="ww-notifications__dot" aria-label={copy.panel.unread} />}
      </button>
      {/* Live rows have no dismiss: they leave when the work settles. */}
      {!entry.pending && (
        <button
          type="button"
          aria-label={copy.panel.dismiss}
          className="zkm-btn-reset ww-notifications__dismiss"
          onClick={() => onDismiss(entry.id)}
        >
          <Icon name="x" size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

/** Where a running operation is, off its record: the tab line says once it is sent. */
function stageOf(operation: OperationRecord): string | undefined {
  if (operation.state !== "local") return undefined
  return operation.provingStartedAt === undefined ? copy.panel.preparing : copy.panel.proving
}

/** A transaction still in progress, read off its operation. */
function OperationRow({ operation, place }: { operation: OperationRecord; place?: TabPlace }) {
  const flow = flowCopy(operation.flow)
  const stage = stageOf(operation)
  return (
    <div className="ww-notifications__item" role="status">
      <div className="ww-notifications__row">
        <div className="zkm-avatar__disc zkm-activity-row__glyph">
          <Icon name={ICON[flow.icon] ?? "bell"} size={20} color="#fff" />
        </div>
        <span className={styles.notificationsBody}>
          <span className="ww-notifications__title">{flow.live}</span>
          <span className="ww-notifications__desc">
            {stage && stage !== flow.live
              ? fmt(copy.panel.operation, { summary: operation.summary, stage })
              : operation.summary}
          </span>
          <TabLine operationId={operation.operationId} place={place} />
        </span>
        <span className="ww-notifications__time">
          <Spinner size={14} />
        </span>
      </div>
    </div>
  )
}

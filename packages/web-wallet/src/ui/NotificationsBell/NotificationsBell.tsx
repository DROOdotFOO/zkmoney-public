import { Icon, Toast } from "@obsidion/web-ds"
import { useCallback, useEffect, useRef, useState } from "react"
import type { NotificationEntry } from "@obsidion/front-core"
import { fmt } from "../../lib/fmt"
import { useOperationsInProgress, useTabBoundOperation } from "../../features/operations/operations"
import type { TabPlace } from "../../features/operations/TabLine"
import {
  NotificationsPanel,
  freshToasts,
  toastKey,
  useNotificationList,
  useNotificationsPanelOpen,
  useRouteOpener,
  type EntryOpener,
  type NotificationScope,
} from "../NotificationsPanel/NotificationsPanel"
import copy from "../notifications.copy"
import { notificationText } from "../notificationText"
import { PhoneIcon } from "../PhoneIcon"
import { usePhoneLayout } from "../usePhoneLayout"
import styles from "./NotificationsBell.module.css"

/**
 * The bell while the wallet starts: nothing is listed yet. A tap opens the panel, which shows once
 * the wallet is up.
 */
export function IdleBell() {
  const [open, setOpen] = useNotificationsPanelOpen()
  return (
    <div className={styles.notificationsAnchor}>
      <BellButton
        label={copy.bell.label}
        expanded={open}
        unread={false}
        onClick={() => setOpen(!open)}
      />
    </div>
  )
}

function BellButton({
  label,
  expanded,
  ring,
  unread,
  onClick,
}: {
  label: string
  expanded: boolean
  ring?: "is-tab-bound" | "is-safe"
  unread: boolean
  onClick: () => void
}) {
  const phone = usePhoneLayout()
  return (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {ring && <span className={`ww-notifications__bell-ring ${ring}`} />}
      {phone ? <PhoneIcon name="bell" color="#fff" /> : <Icon name="bell" size={24} />}
      {unread && <span className={styles.notificationsBellDot} />}
    </button>
  )
}

export function NotificationsBell({
  openEntry,
  place = "tab",
  scope,
}: {
  openEntry?: EntryOpener
  place?: TabPlace
  scope?: NotificationScope
}) {
  const byRoute = useRouteOpener()
  const opener = openEntry ?? byRoute
  const [open, setOpen] = useNotificationsPanelOpen()
  const anchorRef = useRef<HTMLDivElement>(null)
  const { entries, hydrated, unreadCount, opened, markAllRead } = useNotificationList(scope)
  const inScope = (op: { operationId: string } | undefined) =>
    !!op && (!scope || scope.operation(op.operationId))
  // Every unfinished operation, including a sent one this page no longer runs.
  const running = useOperationsInProgress().some(inScope)
  const tabBound = inScope(useTabBoundOperation())
  // A live notification (a registration sweeping, a deposit in flight) spins the bell too, so its
  // progress reads off the icon the same way a running operation does.
  const hasPending = entries.some((e) => e.pending)
  const spinning = running || hasPending
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) markAllRead()
    wasOpen.current = open
  }, [open, markAllRead])
  const close = useCallback(() => setOpen(false), [setOpen])

  // Entries first seen after this bell mounted pop a toast, one at a time; the backlog, all the list
  // holds once it is first complete (`hydrated`), stays behind the bell. An id leaves the queue once
  // its toast has shown. `seen` holds the listed entries' keys only, so an entry forgotten and
  // listed again under its id toasts again.
  const seen = useRef<Set<string> | null>(null)
  const [since] = useState(Date.now)
  const [queue, setQueue] = useState<NotificationEntry[]>([])
  const toast = queue[0] ?? null
  useEffect(() => {
    if (!hydrated) return
    const fresh = seen.current ? freshToasts(entries, seen.current, since) : []
    seen.current = new Set(entries.map(toastKey))
    if (fresh.length) setQueue((q) => [...q, ...fresh])
  }, [entries, hydrated, since])
  const dropToast = useCallback(() => setQueue((q) => q.slice(1)), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dropToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dropToast])
  // Opening the panel shows the same entries; a toast for a dismissed entry has nothing to open.
  useEffect(() => {
    if (open) setQueue([])
  }, [open])
  useEffect(() => {
    if (toast && !entries.some((e) => e.id === toast.id)) dropToast()
  }, [entries, toast, dropToast])
  const openToast = () => {
    if (!toast) return
    opened(toast)
    dropToast()
    opener(toast)?.()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  return (
    <div className={styles.notificationsAnchor} ref={anchorRef}>
      <BellButton
        label={
          spinning
            ? running
              ? tabBound
                ? fmt(copy.bell.keepOpen, { place })
                : copy.bell.finishing
              : copy.bell.inProgress
            : copy.bell.label
        }
        expanded={open}
        ring={spinning ? (tabBound ? "is-tab-bound" : "is-safe") : undefined}
        unread={unreadCount > 0}
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open && (
        <NotificationsPanel onClose={close} openEntry={opener} place={place} scope={scope} />
      )}
      {toast && !open && (
        <Toast
          className="ww-notifications__toast"
          kind={toast.severity === "error" ? "error" : "success"}
          message={fmt(copy.panel.toast, notificationText(toast))}
          actionLabel={opener(toast) ? copy.panel.open : undefined}
          onAction={openToast}
          onDismiss={dropToast}
        />
      )}
    </div>
  )
}

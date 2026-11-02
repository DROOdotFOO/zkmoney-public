/** What the account's bell reads, and where the reorg monitor's outcomes go. */
import {
  NOTIFICATION_WINDOW_MS,
  reorgFailedId,
  timeKey,
  type Activity,
  derived,
  memoryStore,
  reorgEvent,
  type After,
  type ConfirmationOutcome,
  type Milestones,
  type NotificationEvent,
  type Notifications,
  type NotificationSources,
  type NotificationState,
  type ReadonlyStore,
  type RecordSet,
  type Sourced,
  type Transaction,
} from "@obsidion/front-core"
import { mergedRows } from "../../ui/activity/feedSources"
import { wallClock } from "../../lib/clock"
import { pendingRegistrations, type FeedBase } from "../../ui/activity/feedSources"
import type { WalletIdentity } from "../identity/walletIdentity"
import { flowCopy } from "../operations/operationCopy"
import { listsEnding } from "../operations/operationEntries"
import { endedOperations, runningOperations } from "../operations/operations"

export async function recordReorgOutcome(
  notifications: Notifications,
  outcome: ConfirmationOutcome,
): Promise<void> {
  // A re-confirmation answers the failure the bell reported.
  const failed =
    outcome.type === "re-confirmed" ? reorgFailedId(outcome.txHash, outcome.reorgEpoch) : undefined
  const reported = failed !== undefined && (await notifications.has(failed))
  const event = reorgEvent(outcome, Date.now(), (id) => reported && id === failed)
  if (event) await notifications.record(event)
}

/** The bell's starting point: an entry the replayed history lists before it never toasts. */
const BELL_AFTER: After = {
  firstBalance: true,
  depositsReplayed: true,
  movesReplayed: true,
  historyAtHead: true,
}

function waitsOver(milestones: Pick<Milestones, "after">, after: After): ReadonlyStore<boolean> {
  const over = memoryStore(false)
  void milestones.after(after).then((ended) => ended && over.set(true))
  return over.readonly
}

/** The bell's entries read off an activity row: a receive by its time, a claim by its claim time. */
const ROW_ENTRIES = ["transfer:receive:", "paylink:claimed:"]

const UNREAD_ROWS: RecordSet<Transaction> = { records: [], loaded: false, failed: false }

/**
 * The activity rows the bell reads: receives and claims from 24 hours before its oldest unread one,
 * which settled within the window of when it first showed, and the escrowed links. The range is set
 * once the unread notifications load.
 */
export function bellRows(
  activity: Pick<Activity, "query">,
  notifications: Pick<Notifications, "unread">,
  open: ReadonlyStore<RecordSet<Transaction>>,
): ReadonlyStore<RecordSet<Transaction>> {
  const shown = memoryStore(UNREAD_ROWS)
  let rows: ReadonlyStore<RecordSet<Transaction>> | undefined
  let offs: (() => void)[] = []
  let watchers = 0
  const settle = () => {
    if (rows) return shown.set(rows.get())
    const unread = notifications.unread.get()
    if (unread.failed) return shown.set({ ...UNREAD_ROWS, failed: true })
    if (!unread.loaded) return
    let since = Date.now()
    for (const { id, state } of unread.records) {
      if (state && ROW_ENTRIES.some((prefix) => id.startsWith(prefix)))
        since = Math.min(since, state.firstSeenAt)
    }
    const after = timeKey(since - NOTIFICATION_WINDOW_MS)
    rows = mergedRows([
      activity.query("time", { after }),
      activity.query("claimed", { after }),
      open,
    ])
    offs.push(rows.subscribe(settle))
    settle()
  }
  return {
    get: shown.get,
    subscribe(listener) {
      const off = shown.subscribe(listener)
      if (watchers++ === 0) {
        offs.push(notifications.unread.subscribe(settle))
        settle()
      }
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--watchers > 0) return
        offs.forEach((stop) => stop())
        offs = []
        rows = undefined
        shown.set(UNREAD_ROWS)
      }
    },
  }
}

/** The records the bell's entries are read from: `rows` are the activity rows it reads. */
export function notificationSources(
  feed: ReadonlyStore<FeedBase>,
  rows: ReadonlyStore<RecordSet<Transaction>>,
  identity: ReadonlyStore<Sourced<WalletIdentity | null>>,
  milestones: Pick<Milestones, "after">,
): ReadonlyStore<NotificationSources> {
  return derived(
    [
      feed,
      rows,
      pendingRegistrations(),
      identity,
      endedOperations,
      runningOperations,
      waitsOver(milestones, BELL_AFTER),
    ] as const,
    (feed, rows, registrations, identity, ended, running, started) => ({
      rows: rows.records,
      oldVersionWithdrawals: feed.oldVersionWithdrawals,
      deposits: feed.deposits,
      withdrawals: feed.withdrawals,
      upgrades: feed.upgrades,
      processing: feed.processing,
      registrations: registrations.records,
      account: identity.value?.address,
      operations: {
        ended: ended.filter(listsEnding),
        // A sent withdrawal is already its own record's live row.
        running: running.filter(
          (op) => op.state !== "sent" || flowCopy(op.flow).outcome !== "record",
        ),
      },
      loaded:
        rows.loaded &&
        !rows.failed &&
        feed.deposits.hydrated &&
        feed.withdrawals.hydrated &&
        feed.upgrades.loaded &&
        registrations.hydrated &&
        identity.loaded &&
        started,
    }),
  )
}

/** What one bell renders from: the entries' records, their stamps and events, and the clock. */
export interface Bell {
  sources: NotificationSources
  state: ReadonlyMap<string, NotificationState>
  events: ReadonlyMap<string, NotificationEvent>
  /** Ids the writer found or gave a state row, loaded or not. */
  stamped: ReadonlySet<string>
  now: number
}

export function bell(
  sources: ReadonlyStore<NotificationSources>,
  notifications: Notifications,
): ReadonlyStore<Bell> {
  return derived(
    [sources, notifications.state, notifications.events, notifications.stamped, wallClock] as const,
    (sources, state, events, stamped, now) => ({ sources, state, events, stamped, now }),
  )
}

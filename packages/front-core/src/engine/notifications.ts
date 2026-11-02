import type { Database, Write } from "./database"
import {
  APP_NOTIFICATION_STORAGE_KEY,
  legacyNotificationEvents,
  legacyNotificationState,
} from "./notificationsLegacy"
import {
  decodeRecord,
  encodeRecord,
  loadRecords,
  persistentStore,
  timeKey,
  type RecordSet,
} from "./persistentStore"
import { WalletError } from "./errors"
import { derived, memoryStore, type ReadonlyStore } from "./store"

/** How long after its record settles an entry still rings when first seen; older ones never show. */
export const NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000

/** State rows past which the oldest read rows that nothing lists any more are dropped. */
export const NOTIFICATION_LIMIT = 200

/** What the user did with a bell entry. An entry is listed only once it has a row here. */
export interface NotificationState {
  id: string
  firstSeenAt: number
  readAt?: number
  dismissedAt?: number
}

/** One kind of funds left on a retired version. Amounts in base units at the default decimals. */
export type ResidualItem =
  | { kind: "balance"; amount: bigint; stranded: "small" | "frozen" }
  | { kind: "other"; amount: bigint }
  /** A waiting source's balance, when it has one, and its unclaimed deposits, which wait with it. */
  | { kind: "awaiting" | "awaitingFeature"; amount?: bigint; deposits: number }
  | {
      kind: "unclaimed" | "transit" | "waiting" | "link" | "unverified"
      count: number
      amount?: bigint
    }
  /** `until`: the latest claim window's end, unix seconds. */
  | { kind: "locked"; count: number; amount?: bigint; until: number }

/** Why a stopped upgrade waits for the user. */
export type UpgradeStop = "failed" | "needsApproval" | "needsAttention" | "paused"

/** A fact the bell reports that no record holds. */
export type NotificationEvent = { id: string; at: number } & (
  | {
      kind: "reorg"
      data: {
        outcome: "failed" | "reconfirmed"
        txHash: string
        incoming?: boolean
        withdrawal?: boolean
      }
    }
  | { kind: "contactAdded"; data: { address: string; contactId: string; tag?: string } }
  | { kind: "claimReversed"; data: { txHash: string } }
  | { kind: "reclaimable"; data: { txHash: string } }
  | { kind: "migrationResiduals"; data: { items: ResidualItem[] } }
  | { kind: "migrationRun"; data: { stop: UpgradeStop } }
)

/** An entry the writer sees, as `deriveNotifications` lists it. */
export interface Stampable {
  id: string
  pending?: boolean
  /** When its record settled. Unset: it rings whenever first seen. */
  settledAt?: number
  /** It rings whatever its age once this id has been seen. */
  seenWith?: string
}

/** Whether the writer never stamps `entry`: it settled before the window, and was not seen live. */
export const isOld = (entry: Stampable, known: (id: string) => boolean, now: number) =>
  entry.settledAt !== undefined &&
  entry.settledAt < now - NOTIFICATION_WINDOW_MS &&
  !(entry.seenWith && known(entry.seenWith))

/** Everything stored under one bell id. Neither part: the id is unknown, and rings when listed. */
export interface NotificationRecord {
  id: string
  state?: NotificationState
  event?: NotificationEvent
}

/** What happens to a bell id. `listed`: the records list it now. */
export type NotificationChange =
  /** The records list it. `old`: it settled before the window, so it never rings. */
  | { type: "listed"; at: number; old: boolean }
  | { type: "read"; at: number }
  | { type: "dismissed"; at: number }
  /** A fact reported once. */
  | { type: "recorded"; event: NotificationEvent }
  /** The latest word on a fact. */
  | { type: "reported"; event: NotificationEvent }
  /** The fact no longer holds. */
  | { type: "retracted" }
  /** A failure its record recovered from. */
  | { type: "retired"; listed: boolean }
  /** Past the limit. */
  | { type: "capped"; listed: boolean }

/** Equal for equal event data, bigints included. */
export const dataKey = (data: unknown) =>
  JSON.stringify(data, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
const sameData = (a: unknown, b: unknown) => dataKey(a) === dataKey(b)

/**
 * A new fact and its first state row are one write. A fact reaching a row carried over without one
 * keeps the row's time.
 */
const arrived = (id: string, event: NotificationEvent, state?: NotificationState) =>
  state
    ? { id, state, event: { ...event, at: state.firstSeenAt } }
    : { id, state: { id, firstSeenAt: event.at }, event }

/**
 * The one place a bell id changes; `undefined` leaves it as it is.
 * - An id rings only by gaining a state row, and gains one only when listed with none, unless old.
 * - A known id is forgotten only when retracted, or when nothing lists it and it is retired or,
 *   read, capped. So an id that is still listed or still reported never rings twice.
 * - A fact rings as it arrives: its event and its first state row save together.
 * - A recorded fact keeps its first word. A reported one takes a changed word, which brings a
 *   dismissed entry back, still read. A row carried over without a word has none to compare, so
 *   any word is a changed one.
 */
export function notificationTransition(
  record: NotificationRecord,
  change: NotificationChange,
): NotificationRecord | undefined {
  const { id, state, event } = record
  switch (change.type) {
    case "listed":
      if (state || change.old) return undefined
      return { ...record, state: { id, firstSeenAt: change.at } }
    case "read":
      if (!state || state.readAt !== undefined) return undefined
      return { ...record, state: { ...state, readAt: change.at } }
    case "dismissed":
      if (!state || state.dismissedAt !== undefined) return undefined
      return {
        ...record,
        state: { ...state, readAt: state.readAt ?? change.at, dismissedAt: change.at },
      }
    case "recorded":
      if (event) return undefined
      return arrived(id, change.event, state)
    case "reported": {
      if (event && sameData(event.data, change.event.data)) return undefined
      if (state?.dismissedAt === undefined) {
        return event ? { ...record, event: change.event } : arrived(id, change.event, state)
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { dismissedAt, ...shown } = state
      return event ? { id, state: shown, event: change.event } : arrived(id, change.event, shown)
    }
    case "retracted":
      return state || event ? { id } : undefined
    case "retired":
      return state && !change.listed ? { id } : undefined
    case "capped":
      return state?.readAt !== undefined && !change.listed ? { id } : undefined
  }
}

/**
 * The bell's stored state, one record per id. Every write goes through `notificationTransition` and
 * commits in one transaction, which resolves once saved. The records loaded are the unread ones and
 * those first seen since 24 hours before the store opened; `state` and `events` hold them.
 */
export interface Notifications {
  readonly state: ReadonlyStore<ReadonlyMap<string, NotificationState>>
  readonly events: ReadonlyStore<ReadonlyMap<string, NotificationEvent>>
  /** The unread records. */
  readonly unread: ReadonlyStore<RecordSet<NotificationRecord>>
  /** Ids the writer found or gave a state row this page, loaded or not. */
  readonly stamped: ReadonlyStore<ReadonlySet<string>>
  readonly ready: Promise<void>
  /** The fact under this id is saved. */
  has(id: string): Promise<boolean>
  markRead(ids: readonly string[], at?: number): Promise<void>
  dismiss(ids: readonly string[], at?: number): Promise<void>
  record(event: NotificationEvent): Promise<void>
  report(event: NotificationEvent): Promise<void>
  retract(id: string): Promise<void>
  /**
   * The one writer of `firstSeenAt`: stamps every listed id, forgets `retired` ids nothing lists,
   * and keeps the limit. `complete`: every source has loaded, so an unlisted id is really gone; only
   * then does the limit drop anything, once per page.
   */
  observe(
    listed: readonly Stampable[],
    retired: readonly string[],
    now: number,
    complete: boolean,
  ): Promise<void>
}

const PREFIX = "acct/notifications"
/** Where the two stores of the previous version kept their records. */
const STATE_PREFIX = "acct/notificationState/"
const EVENTS_PREFIX = "acct/notificationEvents/"

const UNREAD = "1"

/** Imports the previous version's two stores, or, before them, the legacy blob; they stay as they were. */
async function migrate(db: Database, from: number | undefined, w: Write): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `notifications: unknown version ${from}`)
  const [stateVersion, eventsVersion, blob] = await w.getMany([
    "acct/meta/notificationState",
    "acct/meta/notificationEvents",
    APP_NOTIFICATION_STORAGE_KEY,
  ])
  const records = new Map<string, NotificationRecord>()
  const at = (id: string) => records.get(id) ?? { id }
  const states = stateVersion === undefined ? legacyNotificationState(blob) : []
  const events = eventsVersion === undefined ? legacyNotificationEvents(blob) : []
  for (const [key, raw] of await db.range(STATE_PREFIX))
    states.push([key.slice(STATE_PREFIX.length), decodeRecord(raw) as NotificationState])
  for (const [key, raw] of await db.range(EVENTS_PREFIX))
    events.push([key.slice(EVENTS_PREFIX.length), decodeRecord(raw) as NotificationEvent])
  for (const [id, state] of states) records.set(id, { ...at(id), state })
  for (const [id, event] of events) records.set(id, { ...at(id), event })
  for (const [id, record] of records) {
    if (!id.includes("/")) w.put(`${PREFIX}/${id}`, encodeRecord(record))
  }
}

export function createNotifications(db: Database): Notifications {
  const store = persistentStore<NotificationRecord, "seen" | "unread">(db, {
    prefix: PREFIX,
    version: 1,
    id: (record) => record.id,
    migrate: (from, w) => migrate(db, from, w),
    indexes: {
      // The later of its first showing and its fact: a fact reported anew enters the last day.
      seen: (record) => {
        const times = [record.state?.firstSeenAt, record.event?.at].filter(
          (at): at is number => at !== undefined,
        )
        return times.length === 0 ? [] : [timeKey(Math.max(...times))]
      },
      unread: (record) => (record.state && record.state.readAt === undefined ? [UNREAD] : []),
    },
    load: { index: "unread", key: UNREAD },
  })
  const recent = store.query("seen", { after: timeKey(Date.now() - NOTIFICATION_WINDOW_MS) })
  const loaded = derived([store.view, recent] as const, (unread, recent) => {
    const byId = new Map<string, NotificationRecord>()
    for (const record of [...recent.records, ...unread.records]) byId.set(record.id, record)
    return [...byId.values()]
  })
  const state = derived([loaded], (records) => {
    const map = new Map<string, NotificationState>()
    for (const { id, state } of records) if (state) map.set(id, state)
    return map as ReadonlyMap<string, NotificationState>
  })
  const events = derived([loaded], (records) => {
    const map = new Map<string, NotificationEvent>()
    for (const { id, event } of records) if (event) map.set(id, event)
    return map as ReadonlyMap<string, NotificationEvent>
  })
  const stamped = memoryStore<ReadonlySet<string>>(new Set())
  let capped = false

  const writing = async <T>(fn: (w: Write) => Promise<T>): Promise<T> => {
    await store.ready
    return db.write(fn)
  }
  /** Applies `next` to the id within `w`; the record as it now stands. */
  const change = async (w: Write, id: string, next: NotificationChange) => {
    const current = (await store.get(id, w)) ?? { id }
    const after = notificationTransition(current, next)
    if (!after) return current
    if (after.state || after.event) await store.put(after, w)
    else await store.remove(id, w)
    return after
  }
  const each = (ids: readonly string[], next: NotificationChange) =>
    writing(async (w) => {
      for (const id of ids) await change(w, id, next)
    })

  return {
    state,
    events,
    unread: store.view,
    stamped: stamped.readonly,
    ready: store.ready,
    has: async (id) => !!(await store.get(id))?.event,
    markRead: (ids, at = Date.now()) => each(ids, { type: "read", at }),
    dismiss: (ids, at = Date.now()) => each(ids, { type: "dismissed", at }),
    record: (event) => each([event.id], { type: "recorded", event }),
    report: (event) => each([event.id], { type: "reported", event }),
    retract: (id) => each([id], { type: "retracted" }),
    async observe(listed, retired, now, complete) {
      let trimmed = false
      const seen = await writing(async (w) => {
        const live = new Set(listed.map((entry) => entry.id))
        for (const id of retired) await change(w, id, { type: "retired", listed: live.has(id) })
        const shown = new Set<string>()
        const known = async (id: string) => shown.has(id) || !!(await store.get(id, w))?.state
        for (const entry of listed) {
          const seenWith = entry.seenWith !== undefined && (await known(entry.seenWith))
          const old = isOld(entry, () => seenWith, now)
          if ((await change(w, entry.id, { type: "listed", at: now, old })).state)
            shown.add(entry.id)
        }
        if (!complete || capped) return shown
        trimmed = true
        // The limit drops only rows whose records are gone: a fact keeps its row, listed or not, so
        // recording it again never rings.
        const saved = await loadRecords(store.query("seen", {}))
        const ids = new Set([...saved.map((record) => record.id), ...live])
        const current = await Promise.all([...ids].map((id) => store.get(id, w)))
        const rows = current.flatMap((record) => (record?.state ? [record] : []))
        let over = rows.length - NOTIFICATION_LIMIT
        const oldest = rows
          .filter((record) => !record.event && !live.has(record.id))
          .map((record) => record.state!)
          .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        for (const row of oldest) {
          if (over <= 0) break
          if (!(await change(w, row.id, { type: "capped", listed: false })).state) over--
        }
        return shown
      })
      // Once per page, counted only once a trim saved.
      if (trimmed) capped = true
      stamped.set(new Set([...stamped.get(), ...seen]))
    },
  }
}

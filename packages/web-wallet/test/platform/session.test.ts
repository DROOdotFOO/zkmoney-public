import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createActivity,
  encodeRecord,
  memoryBackend,
  openDatabase,
  scannedRow,
  type Database,
  type MemoryBackend,
} from "@obsidion/front-core"
import {
  closeSession,
  openSession,
  openedSession,
  session,
  switchSession,
  type Namespace,
  type Session,
} from "../../src/platform/session"
import { pageSessionDeps } from "../../src/platform/sessionDeps"

// A page serves one account: every test here opens "a" as it.
const a = { id: "a", prefix: "a." }
const anonymous = { id: null, prefix: "" }

const token = {
  address: "0xt",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1,
  price: 1,
}
const pending = (id: string) => ({
  id,
  operationId: id,
  networkId: "0xnet",
  action: "send" as const,
  token,
  amountAtomic: 1_000_000n,
  timestamp: 1,
  status: "pending" as const,
  txHash: "",
})

/** A row another writer saves under an account's namespace. */
const commitRow = (db: Database, prefix: string, id: string) =>
  createActivity({ db: db.scoped(prefix) }).insertPending(pending(id))

const opened: Session[] = []
/** The namespace's session over `db`, not current. */
const sessionOn = (namespace: Namespace, db: Database) => {
  // Assigned, not spread: the deps' getters read config only when the session does.
  const open = openSession(Object.assign(pageSessionDeps(namespace), { database: db }))
  opened.push(open)
  return open
}

/** The database `switchSession` opens sessions over. */
const pageDb = () => pageSessionDeps(anonymous).database

/** A fresh page's storage. */
const page = () => {
  const backend = memoryBackend()
  return { backend, db: openDatabase(backend) }
}

afterEach(() => {
  closeSession()
  for (const open of opened.splice(0)) open.close()
  vi.restoreAllMocks()
})

describe("switchSession", () => {
  it("keeps the account's rows under its namespace", async () => {
    const { backend, db } = page()
    await sessionOn(a, db).activity.insertPending(pending("op-a"))
    expect(backend.entries.get("a.acct/activity/op-a")).toBeDefined()
    expect(await sessionOn(anonymous, db).activity.all()).toEqual([])
  })

  it("returns the open session for the same account", () => {
    const first = switchSession(a)
    expect(switchSession(a)).toBe(first)
    expect(session()).toBe(first)
  })

  it("never opens another account's session on this page, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const first = switchSession(a)
    expect(switchSession({ id: "b", prefix: "b." })).toBe(first)
    // Signed out in between: the page still served "a".
    closeSession()
    const open = switchSession(anonymous)
    expect(switchSession({ id: "b", prefix: "b." })).toBe(open)
    expect(openedSession.get()?.namespace.id).toBeNull()
    expect(error).toHaveBeenCalledTimes(2)
  })

  it("replaces the anonymous session with the first account's, and the old one stops hearing", async () => {
    const before = switchSession(anonymous)
    await vi.waitFor(() => expect(before.activity.view.get().loaded).toBe(true))
    const after = switchSession(a)
    expect(after === before).toBe(false)
    expect(session()).toBe(after)
    await commitRow(pageDb(), "", "op-late")
    expect(before.activity.view.get().records).toEqual([])
  })

  it("starts an anonymous session's bell writer only once its bell is read", async () => {
    const { db } = page()
    const open = sessionOn(anonymous, db)
    await open.activity.record(
      scannedRow({
        networkId: "0xnet",
        action: "receive",
        txHash: "0xbacc",
        from: "alice",
        senderL2Address: "0xa11ce",
        to: "me",
        token,
        amountAtomic: 1_000_000n,
        timestamp: Date.now(),
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(open.notifications.state.get().size).toBe(0)
    const stop = open.bell.subscribe(() => {})
    await vi.waitFor(() => expect(open.bell.get().sources.rows).toHaveLength(1))
    await vi.waitFor(() => expect(open.notifications.state.get().size).toBe(1))
    stop()
  })

  it("hears its namespace until it closes", async () => {
    const db = pageDb()
    const open = switchSession(a)
    await vi.waitFor(() => expect(open.activity.view.get().loaded).toBe(true))
    await commitRow(db, "a.", "op-1")
    expect(open.activity.view.get().records.map((r) => r.id)).toEqual(["op-1"])
    closeSession()
    await commitRow(db, "a.", "op-2")
    expect(open.activity.view.get().records.map((r) => r.id)).toEqual(["op-1"])
    expect(session).toThrow()
  })

  describe("the bell's rows", () => {
    const DAY = 24 * 60 * 60 * 1000
    const receive = (txHash: string, timestamp: number) =>
      scannedRow({
        txHash,
        from: "alice",
        senderL2Address: "0xa11ce",
        to: "me",
        token,
        amountAtomic: 1n,
        timestamp,
        networkId: "0xnet",
      })
    /** A state row as the previous version kept it, which the store carries over at open. */
    const entry = (backend: MemoryBackend, id: string, firstSeenAt: number) => {
      backend.entries.set("a.acct/meta/notificationState", "1")
      backend.entries.set(`a.acct/notificationState/${id}`, encodeRecord({ id, firstSeenAt }))
    }
    /** The rows the bell reads, once they include one received now. */
    const bellRows = async (db: Database) => {
      const open = sessionOn(a, db)
      await open.activity.record(receive("0xnew", Date.now()))
      const stop = open.bell.subscribe(() => {})
      const ids = () => open.bell.get().sources.rows.map((row) => row.id)
      await vi.waitFor(() => expect(ids()).toContain("0xnew"))
      stop()
      return ids().filter((id) => id !== "0xnew")
    }

    it("reach back to an unread receive, never to an older entry of another kind", async () => {
      const { db, backend } = page()
      const now = Date.now()
      const activity = createActivity({ db: db.scoped("a.") })
      await activity.record(receive("0xold", now - 3 * DAY))
      await activity.record(receive("0xancient", now - 30 * DAY))
      entry(backend, "transfer:receive:0xold", now - 3 * DAY)
      entry(backend, "bridge:deposit:0xsipa", now - 90 * DAY)
      expect(await bellRows(db)).toEqual(["0xold"])
    })
  })
  it("holds for Home its window, pending rows and escrowed links, never an old settled link", async () => {
    const { db } = page()
    const now = Date.now()
    const activity = createActivity({ db: db.scoped("a.") })
    const link = (txHash: string, over: object) =>
      activity.record({
        id: txHash,
        networkId: "0xnet",
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        flavor: "direct",
        status: "success",
        txHash,
        token,
        amountAtomic: 1n,
        timestamp: now - 90 * 24 * 60 * 60 * 1000,
        ...over,
      } as never)
    await link("0xescrowed", {})
    await link("0xclaimed", { isClaimed: true, claimedAt: now - 60 * 24 * 60 * 60 * 1000 })
    for (let i = 0; i < 12; i++) {
      await activity.record(
        scannedRow({
          networkId: "0xnet",
          txHash: `0x${i + 10}`,
          from: "alice",
          senderL2Address: "0xa11ce",
          to: "me",
          token,
          amountAtomic: 1n,
          timestamp: now - i,
        }),
      )
    }
    const open = sessionOn(a, db)
    const stop = open.feed.subscribe(() => {})
    await vi.waitFor(() => expect(open.feed.get().rows.loaded).toBe(true))
    const ids = open.feed.get().rows.records.map((row) => row.id)
    expect(ids).toHaveLength(11)
    expect(ids).toContain("0xescrowed")
    expect(ids).not.toContain("0xclaimed")
    stop()
  })
})

import { describe, expect, it, vi } from "vitest"
import { openDatabase, type DatabaseBackend, type Write } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import {
  decodeRecord,
  encodeRecord,
  persistentStore,
  timeKey,
  type PersistentStoreSpec,
  type RecordSet,
} from "../../src/engine/persistentStore"
import type { ReadonlyStore } from "../../src/engine/store"
import { WalletError } from "../../src/engine/errors"

const INVARIANT = { code: "invariant" }

type Row = { id: string; at: number; status: string; peers?: string[]; big?: bigint }
type Index = "time" | "status" | "peer"

const spec = (
  over: Partial<PersistentStoreSpec<Row, Index>> = {},
): PersistentStoreSpec<Row, Index> => ({
  prefix: "acct/rows",
  version: 1,
  id: (row) => row.id,
  indexes: {
    time: (row) => [timeKey(row.at)],
    status: (row) => [row.status],
    peer: (row) => row.peers ?? [],
  },
  load: "all",
  ...over,
})
const row = (id: string, at: number, status = "done", extra: Partial<Row> = {}): Row => ({
  id,
  at,
  status,
  ...extra,
})
/** Lets reads started by commits and opens land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const ids = (set: RecordSet<Row>) => set.records.map((r) => r.id)
const keysUnder = (backend: MemoryBackend, prefix: string) =>
  [...backend.entries.keys()].filter((key) => key.startsWith(prefix)).sort()
/** Subscribes and returns the last value it saw. */
function watch<T>(store: ReadonlyStore<T>) {
  const seen: T[] = []
  const off = store.subscribe(() => seen.push(store.get()))
  return { seen, off, last: () => store.get() }
}

function open(over: Partial<PersistentStoreSpec<Row, Index>> = {}, backend = memoryBackend()) {
  const db = openDatabase(backend)
  return { backend, db, rows: persistentStore(db, spec(over)) }
}

/** A backend whose commits wait for `land()`. */
function heldBackend(inner: DatabaseBackend) {
  const waiting: (() => void)[] = []
  const backend: DatabaseBackend = {
    ...inner,
    apply: (ops) =>
      new Promise<void>((resolve) => waiting.push(resolve)).then(() => inner.apply(ops)),
  }
  return { backend, land: () => waiting.splice(0).forEach((go) => go()) }
}

describe("record codec", () => {
  it("keeps bigints exact", () => {
    const value = { big: 2n ** 200n, list: [1n], plain: { $bigint: 1, other: true } }
    expect(decodeRecord(encodeRecord(value))).toEqual(value)
  })

  it("orders zero-padded times as numbers", () => {
    expect([timeKey(10), timeKey(9), timeKey(1_700_000_000_000)].sort()).toEqual([
      timeKey(9),
      timeKey(10),
      timeKey(1_700_000_000_000),
    ])
  })
})

describe("persistentStore", () => {
  it("keeps a record, its index entries and its version where the layout says", async () => {
    const { backend, rows } = open()
    await rows.ready
    await rows.put(row("a", 5, "done", { peers: ["p1", "p2"], big: 7n }))
    expect(backend.entries.get("acct/meta/rows")).toBe("1")
    expect(decodeRecord(backend.entries.get("acct/rows/a")!)).toEqual(
      row("a", 5, "done", { peers: ["p1", "p2"], big: 7n }),
    )
    expect(keysUnder(backend, "acct/rows.i/")).toEqual([
      `acct/rows.i/peer/p1/a`,
      `acct/rows.i/peer/p2/a`,
      `acct/rows.i/status/done/a`,
      `acct/rows.i/time/${timeKey(5)}/a`,
    ])
    expect(await rows.get("a")).toEqual(row("a", 5, "done", { peers: ["p1", "p2"], big: 7n }))
  })

  it("moves an entry when its value changes, and drops them all with the record", async () => {
    const { backend, rows } = open()
    await rows.put(row("a", 5, "pending", { peers: ["p1"] }))
    await rows.put(row("a", 9, "done", { peers: ["p1", "p2"] }))
    expect(keysUnder(backend, "acct/rows.i/")).toEqual([
      `acct/rows.i/peer/p1/a`,
      `acct/rows.i/peer/p2/a`,
      `acct/rows.i/status/done/a`,
      `acct/rows.i/time/${timeKey(9)}/a`,
    ])
    await rows.remove("a")
    expect(keysUnder(backend, "acct/rows")).toEqual([])
  })

  it("shows a write in the view only once it commits", async () => {
    const held = heldBackend(memoryBackend(new Map([["acct/meta/rows", "1"]])))
    const rows = persistentStore(openDatabase(held.backend), spec())
    const view = watch(rows.view)
    await rows.ready
    await settle()
    expect(view.last()).toEqual({ records: [], loaded: true, failed: false })
    const put = rows.put(row("a", 1))
    await settle()
    expect(ids(view.last())).toEqual([])
    held.land()
    await put
    expect(ids(view.last())).toEqual(["a"])
  })

  it("rejects a failed commit and changes nothing", async () => {
    const { backend, rows } = open()
    await rows.put(row("a", 1))
    await settle()
    const view = watch(rows.view)
    const before = new Map(backend.entries)
    backend.failing = { commits: true }
    await expect(rows.put(row("a", 2, "pending"))).rejects.toThrow()
    await expect(rows.remove("a")).rejects.toThrow()
    expect(backend.entries).toEqual(before)
    expect(view.seen).toEqual([])
    expect(rows.view.get().records).toEqual([row("a", 1)])
  })

  it("reports a failed load as failed, never as empty", async () => {
    const backend = memoryBackend()
    backend.failing = { reads: true }
    const { rows } = open({}, backend)
    await expect(rows.ready).rejects.toThrow()
    await settle()
    expect(rows.view.get()).toEqual({ records: [], loaded: false, failed: true })
    await expect(rows.put(row("a", 1))).rejects.toThrow()
  })

  it("applies a change to the current record; undefined writes nothing", async () => {
    const { db, rows } = open()
    await rows.put(row("a", 1, "pending"))
    const commits = vi.fn()
    db.onCommit(commits)
    expect(await rows.apply("a", () => undefined)).toBeUndefined()
    expect(await rows.apply("a", (r) => r && { ...r, status: "done" })).toEqual(row("a", 1))
    expect(await rows.apply("b", (r) => r ?? row("b", 2))).toEqual(row("b", 2))
    await expect(rows.apply("a", (r) => r && { ...r, id: "z" })).rejects.toThrow(/moved/)
    expect(commits).toHaveBeenCalledTimes(2)
    expect(await rows.get("a")).toEqual(row("a", 1))
  })

  it("refuses ids and index values holding a /", async () => {
    const { rows } = open()
    await expect(rows.put(row("a/b", 1))).rejects.toThrow(/\//)
    await expect(rows.put(row("a", 1, "x/y"))).rejects.toThrow(/\//)
    expect(() => rows.query("status", "x/y")).toThrow(/\//)
  })
})

describe("persistentStore writes in a caller's transaction", () => {
  it("commits several stores' writes and the caller's keys together", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend).scoped("ns.")
    const a = persistentStore(db, spec({ prefix: "acct/a" }))
    const b = persistentStore(db, spec({ prefix: "acct/b" }))
    await Promise.all([a.ready, b.ready])
    const commits = vi.fn()
    db.onCommit(commits)
    await db.write(async (w) => {
      await a.put(row("x", 1), w)
      expect(await a.get("x", w)).toEqual(row("x", 1))
      expect(await a.get("x")).toBeUndefined()
      await b.apply("y", () => row("y", 2), w)
      w.put("cursor", "9")
    })
    expect(commits).toHaveBeenCalledTimes(1)
    expect(backend.entries.get("ns.cursor")).toBe("9")
    expect(await b.get("y")).toEqual(row("y", 2))
  })

  it("commits none of them when the transaction fails", async () => {
    const { backend, db, rows } = open()
    await rows.ready
    backend.failing = { commits: true }
    await expect(
      db.write(async (w) => {
        await rows.put(row("x", 1), w)
        w.put("cursor", "9")
      }),
    ).rejects.toThrow()
    expect(backend.entries.has("cursor")).toBe(false)
    expect(backend.entries.has("acct/rows/x")).toBe(false)
  })

  it("refuses a write on another database, or before it opened", async () => {
    const root = openDatabase(memoryBackend())
    const db = root.scoped("ns.")
    const rows = persistentStore(db, spec())
    await expect(db.write((w) => rows.put(row("x", 1), w))).rejects.toMatchObject(INVARIANT)
    await rows.ready
    await expect(root.write((w) => rows.put(row("x", 1), w))).rejects.toMatchObject(INVARIANT)
  })
})

describe("persistentStore loads", () => {
  it("holds a window of the newest rows, admitting newer ones and refilling a gap", async () => {
    const backend = memoryBackend()
    const seed = open({}, backend).rows
    for (const [id, at] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ] as const) {
      await seed.put(row(id, at))
    }
    const { rows } = open({ load: { index: "time", window: 3, reverse: true } }, backend)
    await rows.ready
    await settle()
    expect(ids(rows.view.get())).toEqual(["d", "c", "b"])
    await rows.put(row("e", 5))
    expect(ids(rows.view.get())).toEqual(["e", "d", "c"])
    await rows.put(row("old", 0))
    expect(ids(rows.view.get())).toEqual(["e", "d", "c"])
    await rows.put(row("c", 3, "pending"))
    expect(rows.view.get().records[2]).toEqual(row("c", 3, "pending"))
    await rows.remove("d")
    await settle()
    expect(ids(rows.view.get())).toEqual(["e", "c", "b"])
  })

  it("holds the records under one index value, following moves in and out", async () => {
    const { rows } = open({ load: { index: "status", key: "pending" } })
    await rows.put(row("a", 1, "pending"))
    await rows.put(row("b", 2, "done"))
    await settle()
    expect(ids(rows.view.get())).toEqual(["a"])
    await rows.put(row("b", 2, "pending"))
    await rows.put(row("a", 1, "done"))
    expect(ids(rows.view.get())).toEqual(["b"])
  })
})

describe("persistentStore queries", () => {
  it("reads on first subscribe, follows commits to its range, and is shared while watched", async () => {
    const backend = memoryBackend()
    const { rows } = open({}, backend)
    await rows.put(row("a", 10, "done", { peers: ["p"] }))
    await rows.put(row("b", 20, "done", { peers: ["q"] }))
    await settle()
    const range = vi.spyOn(backend, "range")
    const day = rows.query("time", { after: timeKey(15), before: timeKey(30) })
    expect(day.get()).toEqual({ records: [], loaded: false, failed: false })
    expect(range).not.toHaveBeenCalled()
    const first = watch(day)
    const second = watch(rows.query("time", { after: timeKey(15), before: timeKey(30) }))
    await settle()
    expect(range).toHaveBeenCalledTimes(1)
    expect(ids(day.get())).toEqual(["b"])
    await rows.put(row("c", 25))
    await rows.put(row("late", 30))
    expect(ids(first.last())).toEqual(["b", "c"])
    expect(second.last()).toBe(first.last())
    expect(rows.query("time", { after: timeKey(15), before: timeKey(30) })).toBe(day)
    first.off()
    second.off()
    expect(day.get().loaded).toBe(false)
    await rows.put(row("d", 26))
    expect(range).toHaveBeenCalledTimes(1)
  })

  it("reads a key's records and follows each record's changes", async () => {
    const { rows } = open()
    await rows.put(row("a", 1, "done", { peers: ["p"] }))
    const chat = watch(rows.query("peer", "p"))
    await settle()
    expect(ids(chat.last())).toEqual(["a"])
    await rows.put(row("b", 2, "done", { peers: ["p", "q"] }))
    await rows.put(row("a", 1, "failed", { peers: ["p"] }))
    expect(chat.last().records).toEqual([
      row("a", 1, "failed", { peers: ["p"] }),
      row("b", 2, "done", { peers: ["p", "q"] }),
    ])
    await rows.put(row("b", 2, "done", { peers: ["q"] }))
    expect(ids(chat.last())).toEqual(["a"])
  })

  it("keeps one row's index entries when two changes to it share a write", async () => {
    const { db, rows, backend } = open()
    await rows.put(row("a", 1, "pending"))
    await db.write((w) =>
      Promise.all([rows.put(row("a", 1, "done"), w), rows.put(row("a", 1, "failed"), w)]),
    )
    expect(await rows.get("a")).toEqual(row("a", 1, "failed"))
    expect(keysUnder(backend, "acct/rows.i/status/")).toEqual(["acct/rows.i/status/failed/a"])
  })

  it("moves the sole row of a full window", async () => {
    const { rows } = open()
    await rows.put(row("a", 1))
    const newest = watch(rows.query("time", { reverse: true, limit: 1 }))
    await settle()
    await rows.put(row("a", 5))
    await settle()
    expect(newest.last()).toEqual({ records: [row("a", 5)], loaded: true, failed: false })
  })

  it("pages older rows from a cursor", async () => {
    const { rows } = open()
    for (let i = 1; i <= 5; i++) await rows.put(row(`r${i}`, i))
    const page = watch(rows.query("time", { before: `${timeKey(4)}/r4`, limit: 2, reverse: true }))
    await settle()
    expect(ids(page.last())).toEqual(["r3", "r2"])
  })

  it("reports a failed read as failed, and reads again when watched again", async () => {
    const backend = memoryBackend()
    const { rows } = open({}, backend)
    await rows.put(row("a", 1))
    backend.failing = { reads: true }
    const failed = watch(rows.query("status", "done"))
    await settle()
    expect(failed.last()).toEqual({ records: [], loaded: false, failed: true })
    failed.off()
    backend.failing = {}
    const again = watch(rows.query("status", "done"))
    await settle()
    expect(again.last()).toEqual({ records: [row("a", 1)], loaded: true, failed: false })
  })

  it("reads again when a commit lands while it reads", async () => {
    const backend = memoryBackend()
    const { rows } = open({}, backend)
    await rows.put(row("a", 1))
    await settle()
    const range = backend.range
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    backend.range = (...args) => range(...args).then((found) => gate.then(() => found))
    const done = watch(rows.query("status", "done"))
    await settle()
    await rows.put(row("b", 2))
    backend.range = range
    release()
    await settle()
    expect(ids(done.last())).toEqual(["a", "b"])
  })

  it("refuses an index the spec does not declare, or an empty limit", () => {
    const { rows } = open()
    expect(() => rows.query("nope" as Index, "x")).toThrow(WalletError)
    expect(() => rows.query("time", { limit: 0 })).toThrow(/positive/)
  })
})

describe("persistentStore migration", () => {
  /** Saves `n` records the way a store with no indexes left them, at version 1. */
  async function legacy(n: number, backend = memoryBackend()) {
    const old = persistentStore(openDatabase(backend), { ...spec(), indexes: undefined })
    await old.ready
    const db = openDatabase(backend)
    await db.write(async (w) => {
      for (let i = 0; i < n; i++) {
        const id = `r${String(i).padStart(4, "0")}`
        w.put(`acct/rows/${id}`, encodeRecord(row(id, i)))
      }
      w.put("acct/rows.i/stale/x/r0000", "")
    })
    return backend
  }

  it("runs migrate once, then builds every index in chunks before ready", async () => {
    const backend = await legacy(450)
    const applies = vi.spyOn(backend, "apply")
    const migrate = vi.fn(async (_from: number | undefined, w: Write) => w.put("legacy", "gone"))
    const { rows } = open({ version: 2, migrate }, backend)
    await rows.ready
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(migrate.mock.calls[0][0]).toBe(1)
    // migrate, one clear, three build chunks.
    expect(applies).toHaveBeenCalledTimes(5)
    expect(backend.entries.get("acct/meta/rows")).toBe("2")
    expect(backend.entries.has("acct/meta/rows.build")).toBe(false)
    expect(keysUnder(backend, "acct/rows.i/stale/")).toEqual([])
    expect(keysUnder(backend, "acct/rows.i/time/")).toHaveLength(450)
    expect(keysUnder(backend, "acct/rows.i/status/done/")).toHaveLength(450)
    open({ version: 2, migrate }, backend)
    await settle()
    expect(migrate).toHaveBeenCalledTimes(1)
  })

  it("resumes an interrupted build from its cursor, without migrating again", async () => {
    const backend = await legacy(450)
    let commits = 0
    const apply = backend.apply.bind(backend)
    backend.apply = (ops) => (++commits === 4 ? Promise.reject(new Error("crash")) : apply(ops))
    const migrate = vi.fn(async () => {})
    await expect(open({ version: 2, migrate }, backend).rows.ready).rejects.toThrow("crash")
    expect(JSON.parse(backend.entries.get("acct/meta/rows.build")!)).toMatchObject({
      to: 2,
      phase: "build",
      after: "r0199",
    })
    const { rows } = open({ version: 2, migrate }, backend)
    await rows.ready
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(keysUnder(backend, "acct/rows.i/time/")).toHaveLength(450)
    expect(backend.entries.get("acct/meta/rows")).toBe("2")
  })

  it("starts over a build left for another version", async () => {
    const backend = await legacy(3)
    backend.entries.set("acct/meta/rows.build", JSON.stringify({ to: 3, phase: "build" }))
    backend.entries.set("acct/rows.i/time/x/r0000", "")
    const migrate = vi.fn(async () => {})
    const { rows } = open({ version: 2, migrate }, backend)
    await rows.ready
    expect(migrate).toHaveBeenCalledWith(1, expect.anything())
    expect(keysUnder(backend, "acct/rows.i/time/")).toHaveLength(3)
  })

  it("loads the view only after the build", async () => {
    const backend = await legacy(250)
    const { rows } = open(
      { version: 2, load: { index: "time", window: 2, reverse: true } },
      backend,
    )
    expect(rows.view.get().loaded).toBe(false)
    await rows.ready
    await settle()
    expect(ids(rows.view.get())).toEqual(["r0249", "r0248"])
  })
})

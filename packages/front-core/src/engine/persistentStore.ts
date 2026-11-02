import type { Database, Op, Write } from "./database"
import { bestEffort, WalletError } from "./errors"
import { memoryStore, type ReadonlyStore } from "./store"

const BIGINT = "$bigint"

/** JSON with every bigint kept exactly, as `{ "$bigint": "<decimal>" }`. */
export function encodeRecord(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? { [BIGINT]: v.toString() } : v,
  )
}

export function decodeRecord(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v === null || typeof v !== "object") return v
    const tagged = (v as Record<string, unknown>)[BIGINT]
    return typeof tagged === "string" && Object.keys(v).length === 1 ? BigInt(tagged) : v
  })
}

/** A time as an index value: zero-padded milliseconds, so key order is time order. */
export const timeKey = (ms: number): string => String(Math.max(0, Math.trunc(ms))).padStart(16, "0")

/** Records a store holds in memory. A failed read is never an empty one. */
export interface RecordSet<R> {
  readonly records: readonly R[]
  /** A read landed. */
  readonly loaded: boolean
  /** The last read failed; `records` are the ones read before it. */
  readonly failed: boolean
}

/**
 * A query's records once its read lands, for work that reads once rather than watches. Rejects when
 * the read fails.
 */
export function loadRecords<R>(query: ReadonlyStore<RecordSet<R>>): Promise<readonly R[]> {
  return new Promise((resolve, reject) => {
    let done = false
    const settled = () => {
      const { records, loaded, failed } = query.get()
      if (done || (!loaded && !failed)) return false
      done = true
      if (failed) reject(new WalletError("unknown", "a store read failed"))
      else resolve(records)
      return true
    }
    const off = query.subscribe(() => {
      if (settled()) off()
    })
    if (settled()) off()
  })
}

/** Part of one index, in key order. Keys are `<value>/<id>`; `after` and `before` are exclusive. */
export interface IndexRange {
  after?: string
  before?: string
  limit?: number
  reverse?: boolean
}

/** What a store holds in memory besides its open queries. */
export type Load<I extends string> =
  | "all"
  | { index: I; window: number; reverse?: boolean }
  | { index: I; key: string }

/**
 * Records at `<prefix>/<id>`, each index entry at `<prefix>.i/<index>/<value>/<id>`, and the
 * version at `<scope>/meta/<name>` for a prefix `<scope>/<name>`.
 */
export interface PersistentStoreSpec<R, I extends string = never> {
  prefix: string
  version: number
  id(record: R): string
  encode?(record: R): string
  decode?(raw: string): R
  /**
   * Runs when the saved version is not `version`, in the transaction that starts the index
   * rebuild. `from` is the saved version, undefined before the store first opened.
   */
  migrate?(from: number | undefined, w: Write): Promise<void>
  /** Each record's values per index. Values and ids hold no `/`. */
  indexes?: Record<I, (record: R) => readonly string[]>
  load: Load<I>
}

/**
 * Saved records, read and written async. `view` and each query hold committed records only, and
 * change once a commit lands. A write without `w` opens its own `db.write`; with one, it joins the
 * caller's transaction.
 */
export interface PersistentStore<R, I extends string = never> {
  /** Resolves once the open's migration and index build are saved; rejects if either failed. */
  readonly ready: Promise<void>
  /** The records `load` declares. */
  readonly view: ReadonlyStore<RecordSet<R>>
  get(id: string, w?: Write): Promise<R | undefined>
  put(record: R, w?: Write): Promise<void>
  remove(id: string, w?: Write): Promise<void>
  /** Writes what `change` returns; undefined leaves the record as it is. */
  apply(
    id: string,
    change: (current: R | undefined) => R | undefined,
    w?: Write,
  ): Promise<R | undefined>
  /**
   * The records under one index value, or in part of an index. Shared while watched: it reads on
   * its first subscribe, follows commits, and is dropped after its last unsubscribe.
   */
  query(index: I, at: string | IndexRange): ReadonlyStore<RecordSet<R>>
}

/** Records per index-build transaction. */
const CHUNK = 200

const UNLOADED: RecordSet<never> = { records: [], loaded: false, failed: false }

type Build = { to: number } & ({ phase: "clear" } | { phase: "build"; after?: string })

/** Where a live set reads: records themselves, or index entries. Bounds are whole keys. */
interface Source {
  prefix: string
  entries: "records" | "index"
  after?: string
  before?: string
  limit?: number
  reverse?: boolean
}

interface Item<R> {
  /** The key the set is ordered by. */
  entry: string
  id: string
  raw: string
  record: R
}

interface LiveSet<R> extends ReadonlyStore<RecordSet<R>> {
  start(): void
  stop(): void
}

export function persistentStore<R, I extends string = never>(
  db: Database,
  spec: PersistentStoreSpec<R, I>,
): PersistentStore<R, I> {
  const encode = spec.encode ?? encodeRecord
  const decode = spec.decode ?? ((raw: string) => decodeRecord(raw) as R)
  const records = `${spec.prefix}/`
  const indexRoot = `${spec.prefix}.i/`
  const slash = spec.prefix.lastIndexOf("/")
  const versionKey = `${spec.prefix.slice(0, slash + 1)}meta/${spec.prefix.slice(slash + 1)}`
  const buildKey = `${versionKey}.build`
  const indexes = Object.entries(spec.indexes ?? {}) as [I, (record: R) => readonly string[]][]

  const segment = (value: string) => {
    if (value.includes("/"))
      throw new WalletError("invariant", `${spec.prefix}: "${value}" holds a "/"`)
    return value
  }
  const entriesOf = (id: string, record: R | undefined): Set<string> =>
    new Set(
      record === undefined
        ? []
        : indexes.flatMap(([name, values]) =>
            values(record).map((value) => `${indexRoot}${name}/${segment(value)}/${segment(id)}`),
          ),
    )
  /** Stages a record's change and moves the index entries whose values changed. */
  const stage = (w: Write, id: string, before: R | undefined, after?: [R, string]) => {
    if (after) w.put(records + id, after[1])
    else w.remove(records + id)
    const old = entriesOf(id, before)
    const next = entriesOf(id, after?.[0])
    for (const key of old) if (!next.has(key)) w.remove(key)
    for (const key of next) if (!old.has(key)) w.put(key, "")
  }

  const open = async () => {
    const [saved, pending] = await db.getMany([versionKey, buildKey])
    let build = pending === undefined ? undefined : (JSON.parse(pending) as Build)
    if (build?.to !== spec.version) build = undefined
    if (!build && saved !== undefined && Number(saved) === spec.version) return
    if (!build) {
      const from = saved === undefined ? undefined : Number(saved)
      const start: Build = { to: spec.version, phase: "clear" }
      await db.write(async (w) => {
        await spec.migrate?.(from, w)
        w.put(buildKey, JSON.stringify(start))
      })
      build = start
    }
    for (let next: Build | undefined = build; next; ) {
      const at: Build = next
      next = await db.write((w) => (at.phase === "clear" ? clearChunk(w) : buildChunk(w, at.after)))
    }
  }
  /** Each chunk commits with the cursor that follows it; the last commits the version. */
  const finish = (w: Write) => {
    w.remove(buildKey)
    w.put(versionKey, String(spec.version))
    return undefined
  }
  const clearChunk = async (w: Write): Promise<Build | undefined> => {
    const page = await db.range(indexRoot, { limit: CHUNK })
    for (const [key] of page) w.remove(key)
    if (page.length === CHUNK) return { to: spec.version, phase: "clear" }
    if (indexes.length === 0) return finish(w)
    const next: Build = { to: spec.version, phase: "build" }
    w.put(buildKey, JSON.stringify(next))
    return next
  }
  const buildChunk = async (w: Write, after?: string): Promise<Build | undefined> => {
    const page = await db.range(records, { after: after && records + after, limit: CHUNK })
    for (const [key, raw] of page) {
      for (const entry of entriesOf(key.slice(records.length), decode(raw))) w.put(entry, "")
    }
    if (page.length < CHUNK) return finish(w)
    const next: Build = {
      to: spec.version,
      phase: "build",
      after: page[CHUNK - 1][0].slice(records.length),
    }
    w.put(buildKey, JSON.stringify(next))
    return next
  }

  let opened: { ok: true } | { ok: false; error: unknown } | undefined
  const ready = open().then(
    () => void (opened = { ok: true }),
    (error: unknown) => {
      opened = { ok: false, error }
      throw error
    },
  )

  /** A write the caller opened: it must sit on this store's database, after the open. */
  const joined = (w: Write) => {
    if (w.prefix !== db.prefix)
      throw new WalletError("invariant", `${spec.prefix}: a write on another database`)
    if (!opened)
      throw new WalletError("invariant", `${spec.prefix}: written before the store opened`)
    if (!opened.ok) throw opened.error
    return w
  }
  /** Each write's changes to this store run one at a time, so each reads what the last staged. */
  const lanes = new WeakMap<Write, Promise<unknown>>()
  const inLane = <T>(w: Write, fn: (w: Write) => Promise<T>): Promise<T> => {
    const run = (lanes.get(w) ?? Promise.resolve()).then(() => fn(w))
    // The next change waits for this one, whatever its outcome; the caller hears the outcome.
    lanes.set(
      w,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return inLane(joined(w), fn)
    await ready
    return db.write(fn)
  }
  const saved = async (w: Write, id: string) => {
    const raw = await w.get(records + id)
    return raw === undefined ? undefined : ([decode(raw), raw] as const)
  }

  const live = (source: Source): LiveSet<R> => {
    const state = memoryStore<RecordSet<R>>(UNLOADED)
    let items: Item<R>[] = []
    let reads = 0
    let loading = false
    let dirty = false
    let off: (() => void) | undefined

    const inRange = (key: string) =>
      key.startsWith(source.prefix) &&
      (source.after === undefined || key > source.after) &&
      (source.before === undefined || key < source.before)
    const first = (a: string, b: string) => (source.reverse ? a > b : a < b)
    const idOf = (entry: string) =>
      source.entries === "records"
        ? entry.slice(records.length)
        : entry.slice(entry.lastIndexOf("/") + 1)
    const item = (entry: string, id: string, raw: string, known?: Item<R>): Item<R> =>
      known?.raw === raw ? { ...known, entry } : { entry, id, raw, record: decode(raw) }
    const publish = (failed: boolean) =>
      state.set({ records: items.map((i) => i.record), loaded: true, failed })

    const read = async (): Promise<Item<R>[]> => {
      const { prefix, after, before, limit, reverse } = source
      const entries = await db.range(prefix, { after, before, limit, reverse })
      const known = new Map(items.map((i) => [i.id, i]))
      if (source.entries === "records") {
        return entries.map(([key, raw]) => item(key, idOf(key), raw, known.get(idOf(key))))
      }
      const ids = entries.map(([key]) => idOf(key))
      const raws = await db.getMany(ids.map((id) => records + id))
      return entries.flatMap(([key], i) => {
        const raw = raws[i]
        return raw === undefined ? [] : [item(key, ids[i], raw, known.get(ids[i]))]
      })
    }
    const load = async (): Promise<void> => {
      const seq = ++reads
      loading = true
      dirty = false
      const next = await bestEffort("unknown", read())
      if (seq !== reads) return
      loading = false
      if (next && dirty) return load()
      if (next) items = next
      if (next || state.get().loaded) publish(!next)
      else state.set({ ...UNLOADED, failed: true })
    }

    const heard = (ops: readonly Op[]) => {
      if (loading) {
        dirty ||= ops.some(([key]) => inRange(key) || key.startsWith(records))
        return
      }
      if (!state.get().loaded) return
      const written = new Map<string, string | null>()
      for (const [key, value] of ops) {
        if (key.startsWith(records)) written.set(key.slice(records.length), value)
      }
      const { limit } = source
      const list = [...items]
      let changed = false
      let full = limit !== undefined && list.length >= limit
      let refill = false
      for (const [key, value] of ops) {
        if (!inRange(key)) continue
        const at = list.findIndex((i) => i.entry === key)
        if (value === null) {
          if (at === -1) continue
          list.splice(at, 1)
          changed = true
          // Entries past a full set's end were never read.
          refill ||= full
          continue
        }
        if (at !== -1) continue
        const id = idOf(key)
        const raw = source.entries === "records" ? value : written.get(id)
        // An entry whose record this commit does not carry is read again.
        if (typeof raw !== "string") {
          refill = true
          continue
        }
        const last = list.at(-1)
        // A set emptied by this commit refills; until then it holds what the commit adds.
        if (full && last && !first(key, last.entry)) continue
        const before = list.findIndex((i) => first(key, i.entry))
        list.splice(before === -1 ? list.length : before, 0, item(key, id, raw))
        changed = true
        if (limit !== undefined && list.length > limit) list.pop()
        full ||= limit !== undefined && list.length >= limit
      }
      for (const [i, held] of list.entries()) {
        const raw = written.get(held.id)
        if (typeof raw === "string" && raw !== held.raw) {
          list[i] = item(held.entry, held.id, raw)
          changed = true
        }
      }
      if (changed) {
        items = list
        publish(state.get().failed)
      }
      if (refill) void load()
    }

    return {
      get: state.get,
      subscribe: state.subscribe,
      start() {
        off = db.onCommit(heard)
        const seq = reads
        ready.then(
          () => (seq === reads ? load() : undefined),
          () => seq === reads && state.set({ ...UNLOADED, failed: true }),
        )
      },
      stop() {
        off?.()
        off = undefined
        reads++
        loading = false
        items = []
        state.set(UNLOADED)
      },
    }
  }

  const sourceOf = (load: Load<I>): Source => {
    if (load === "all") return { prefix: records, entries: "records" }
    if ("key" in load) return indexSource(load.index, load.key)
    return indexSource(load.index, { limit: load.window, reverse: load.reverse })
  }
  function indexSource(index: I, at: string | IndexRange): Source {
    if (!indexes.some(([name]) => name === index)) {
      throw new WalletError("invariant", `${spec.prefix}: no index "${index}"`)
    }
    const prefix = `${indexRoot}${index}/`
    if (typeof at === "string") return { prefix: `${prefix}${segment(at)}/`, entries: "index" }
    if (at.limit !== undefined && !(at.limit > 0)) {
      throw new WalletError("invariant", `${spec.prefix}: a limit must be positive`)
    }
    const bound = (key: string | undefined) => (key === undefined ? undefined : prefix + key)
    return {
      prefix,
      entries: "index",
      after: bound(at.after),
      before: bound(at.before),
      limit: at.limit,
      reverse: at.reverse,
    }
  }

  const view = live(sourceOf(spec.load))
  view.start()

  /** Watched queries by what they read; each is dropped after its last unsubscribe. */
  const watched = new Map<
    string,
    { set: LiveSet<R>; watchers: number; handle: ReadonlyStore<RecordSet<R>> }
  >()
  /** A query's store. While watched, every `query` for its range returns the same one. */
  const handleOf = (key: string, source: Source): ReadonlyStore<RecordSet<R>> => {
    const handle: ReadonlyStore<RecordSet<R>> = {
      get: () => watched.get(key)?.set.get() ?? UNLOADED,
      subscribe(listener) {
        let entry = watched.get(key)
        if (!entry) {
          entry = { set: live(source), watchers: 0, handle }
          watched.set(key, entry)
        }
        const shared = entry
        const off = shared.set.subscribe(listener)
        if (shared.watchers++ === 0) shared.set.start()
        let done = false
        return () => {
          if (done) return
          done = true
          off()
          if (--shared.watchers > 0) return
          shared.set.stop()
          watched.delete(key)
        }
      },
    }
    return handle
  }

  return {
    ready,
    view: { get: view.get, subscribe: view.subscribe },
    async get(id, w) {
      if (w) return (await saved(joined(w), id))?.[0]
      await ready
      const raw = await db.get(records + id)
      return raw === undefined ? undefined : decode(raw)
    },
    put: (record, w) =>
      writing(w, async (w) => {
        const id = spec.id(record)
        const before = await saved(w, id)
        const raw = encode(record)
        if (raw !== before?.[1]) stage(w, id, before?.[0], [record, raw])
      }),
    remove: (id, w) =>
      writing(w, async (w) => {
        const before = await saved(w, id)
        if (before) stage(w, id, before[0])
      }),
    apply: (id, change, w) =>
      writing(w, async (w) => {
        const before = await saved(w, id)
        const next = change(before?.[0])
        if (next === undefined) return undefined
        if (spec.id(next) !== id)
          throw new WalletError("invariant", `${spec.prefix}: a change moved ${id}`)
        const raw = encode(next)
        if (raw !== before?.[1]) stage(w, id, before?.[0], [next, raw])
        return next
      }),
    query(index, at) {
      const source = indexSource(index, at)
      const key = JSON.stringify(source)
      return watched.get(key)?.handle ?? handleOf(key, source)
    },
  }
}

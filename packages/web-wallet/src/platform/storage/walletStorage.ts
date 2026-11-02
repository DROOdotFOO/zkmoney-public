/**
 * Wallet state for the active rollup, in its own SQLite database (`wallet_<rollupVersion>`) on
 * OPFS. Reads are synchronous, served from an in-memory copy loaded when the store opens; the copy
 * leaves out the accounts' persistent stores (`isStoreKey`), which `opfsBackend` reads. Writes
 * update that copy at once and commit to the database in call order: `setItem` / `removeItem` move
 * on, `commit*` resolve once the write is saved and reject when it fails. A failed write is dropped,
 * so reads never show a value the database will not hold.
 *
 * The database takes an exclusive per-directory lock while it is open, so it opens in one document
 * at a time: the active tab's. Without OPFS (Safari Private Browsing) and in demo mode the database
 * is in memory and nothing persistent is touched.
 */
import { createLogger } from "@aztec-labs/foundation/log"
import { NoRetryError, makeBackoff, retry } from "@aztec-labs/foundation/retry"
import {
  AztecSQLiteOPFSStore,
  listStores,
  storePoolDirectory,
} from "@aztec-labs/kv-store/sqlite-opfs"
import type { DatabaseBackend, RangeOptions } from "@obsidion/front-core"
import { mapRange } from "./mapRange"
import { openPooledStore } from "./openPooledStore"
import { isStoreKey } from "./storageKeys"

/** One write: a value, or `null` for a removal. */
export type WalletOp = readonly [key: string, value: string | null]

/** The database surface the module uses; the test suite substitutes an in-memory one. */
export interface WalletDb {
  readonly persistent: boolean
  load(): Promise<{ state: Map<string, string> }>
  get(key: string): Promise<string | undefined>
  getMany(keys: readonly string[]): Promise<(string | undefined)[]>
  /** `DatabaseBackend.range`, read as one transaction. */
  range(prefix: string, opts?: RangeOptions): Promise<[string, string][]>
  /** Applies `ops` as one transaction. */
  apply(ops: readonly WalletOp[]): Promise<void>
  close(): Promise<void>
}

export interface WalletDbBackend {
  open(version: string, persistent: boolean): Promise<WalletDb>
  /** Rollup versions that have a persistent wallet database on this origin. */
  list(): Promise<string[]>
}

const DB_PREFIX = "wallet_"

const opfsDatabases: WalletDbBackend = {
  async open(version, persistent) {
    const log = createLogger("web-wallet:wallet-store")
    const name = `${DB_PREFIX}${version}`
    const store = persistent
      ? await openPooledStore(log, name, storePoolDirectory(name))
      : await AztecSQLiteOPFSStore.open(log, undefined, true)
    const state = store.openMap<string, string>("state")
    return {
      persistent,
      async load() {
        const entries = new Map<string, string>()
        for await (const [key, value] of state.entriesAsync()) entries.set(key, value)
        return { state: entries }
      },
      // A read outside a transaction would run inside one in flight and see its uncommitted writes.
      get: (key) => store.transactionAsync(() => state.getAsync(key)),
      getMany: (keys) => store.transactionAsync(() => state.getManyAsync([...keys])),
      range: (prefix, opts) => store.transactionAsync(() => mapRange(state, prefix, opts)),
      apply(ops) {
        return store.transactionAsync(async () => {
          for (const [key, value] of ops) {
            if (value === null) await state.delete(key)
            else await state.set(key, value)
          }
        })
      },
      close: () => store.close(),
    }
  },
  async list() {
    return (await listStores())
      .filter((name) => name.startsWith(DB_PREFIX))
      .map((name) => name.slice(DB_PREFIX.length))
  },
}

/** Another document holds this database. */
export function isWalletOpenElsewhere(e: unknown): boolean {
  return e instanceof Error && e.name === "SqlitePoolBusyError"
}

/** `read`, at the entry's turn, adds the writes of what it reads to `ops`. */
type Entry = {
  ops: WalletOp[]
  settled: Promise<void>
  read?: (db: WalletDb) => Promise<WalletOp[]>
}

type StoreState = {
  backend: WalletDbBackend
  db?: WalletDb
  version?: string
  opening?: Promise<void>
  openingTarget?: string
  /** Opens and closes, chained; `lifecycleBusy` counts those not yet settled. */
  lifecycle: Promise<void>
  lifecycleBusy: number
  /** Advances on every close, so late callbacks from a closed store touch nothing. */
  generation: number
  committed: Map<string, string>
  pending: Entry[]
  chain: Promise<void>
  lostWrite?: unknown
  /** The open `batch`, whose writes join one transaction. */
  batch?: Entry
}

/** One store per page, shared by every instance of this module. */
const STORE_STATE = Symbol.for("zk.money/wallet-store")
const store: StoreState = ((globalThis as { [STORE_STATE]?: StoreState })[STORE_STATE] ??= {
  backend: opfsDatabases,
  generation: 0,
  lifecycle: Promise.resolve(),
  lifecycleBusy: 0,
  committed: new Map(),
  pending: [],
  chain: Promise.resolve(),
})

const bootOrderError = () =>
  new Error(
    "wallet storage used while the wallet store is closed — it opens once this tab is the active " +
      "tab, and closes when another tab takes over.",
  )

/** Whether this origin holds a wallet database for any rollup. */
export async function walletDatabasesExist(): Promise<boolean> {
  return (await store.backend.list()).length > 0
}

function openDb(): WalletDb {
  if (!store.db) throw bootOrderError()
  return store.db
}

/**
 * Opens `wallet_<version>`; a call for the database already open or opening joins it, and a call
 * for another one waits its turn. It resolves once the store is fully ready.
 */
export function openWalletStore(
  version: string,
  { persistent }: { persistent: boolean },
): Promise<void> {
  const target = `${version}:${persistent}`
  if (store.opening && store.openingTarget === target) return store.opening
  if (
    !store.lifecycleBusy &&
    store.db &&
    store.version === version &&
    store.db.persistent === persistent
  ) {
    return Promise.resolve()
  }
  const run = inLifecycle(() => openNow(version, persistent))
  store.opening = run
  store.openingTarget = target
  const settle = () => {
    if (store.opening !== run) return
    store.opening = undefined
    store.openingTarget = undefined
  }
  run.then(settle, settle)
  return run
}

/** Opens and closes run one at a time, in call order, so neither can act on the other's handle. */
function inLifecycle(task: () => Promise<void>): Promise<void> {
  store.lifecycleBusy++
  const run = store.lifecycle.then(task).finally(() => store.lifecycleBusy--)
  store.lifecycle = run.catch(() => {})
  return run
}

/** Seconds between attempts at an open that failed for a reason other than a held database. */
const OPEN_BACKOFF_S = [1, 1, 2]

/**
 * A document that was just left can still hold its OPFS handles for a moment after its lock is
 * gone, so an open that fails for any reason but a held database is tried again, briefly. A held
 * database fails at once: another tab holds it until that tab closes or is taken over.
 */
async function openDatabase(version: string, persistent: boolean): Promise<WalletDb> {
  try {
    return await retry(
      () =>
        store.backend.open(version, persistent).catch((e: unknown) => {
          throw isWalletOpenElsewhere(e) ? new NoRetryError(String(e), { cause: e }) : e
        }),
      "wallet store open",
      makeBackoff(OPEN_BACKOFF_S),
    )
  } catch (e) {
    throw e instanceof NoRetryError && e.cause !== undefined ? e.cause : e
  }
}

async function openNow(version: string, persistent: boolean): Promise<void> {
  if (store.db && store.version === version && store.db.persistent === persistent) return
  await closeNow()
  const db = await openDatabase(version, persistent)
  try {
    store.committed = legacyKeys((await db.load()).state)
    store.db = db
    store.version = version
    await applyTestSeed()
    testHook?.opened()
  } catch (e) {
    if (store.db === db) resetState()
    await db.close().catch(() => {})
    throw e
  }
}

/** Closes the store after any open or close before it; a later `openWalletStore` starts clean. */
export function closeWalletStore(): Promise<void> {
  // A later open must not join one queued before this close.
  store.opening = undefined
  store.openingTarget = undefined
  return inLifecycle(closeNow)
}

/** Queued writes land before the handle closes; nothing from this store reaches the next one. */
async function closeNow(): Promise<void> {
  const db = store.db
  if (!db) return resetState()
  store.db = undefined
  await drainQueue()
  resetState()
  await db.close()
}

function resetState(): void {
  store.db = undefined
  store.version = undefined
  store.committed = new Map()
  store.pending = []
  store.chain = Promise.resolve()
  store.lostWrite = undefined
  store.generation++
}

/** Waits until no write is queued, including writes queued while waiting. */
async function drainQueue(): Promise<void> {
  for (;;) {
    const chain = store.chain
    await chain
    if (store.chain === chain) return
  }
}

export function walletStoreIsPersistent(): boolean {
  return store.db?.persistent ?? false
}

function view(): Map<string, string | null> {
  const merged = new Map<string, string | null>(store.committed)
  for (const { ops } of store.pending) {
    for (const [key, value] of ops) if (!isStoreKey(key)) merged.set(key, value)
  }
  return merged
}

/** The copy holds what code not yet on the database reads: never the persistent stores' keys. */
function legacyKeys(state: Map<string, string>): Map<string, string> {
  for (const key of state.keys()) if (isStoreKey(key)) state.delete(key)
  return state
}

function enqueue(ops: readonly WalletOp[]): Promise<void> {
  // A write inside a batch joins it, so the batch keeps call order and one outcome.
  if (store.batch) {
    store.batch.ops.push(...intercept(ops))
    return store.batch.settled
  }
  const entry: Entry = { ops: intercept(ops), settled: Promise.resolve() }
  store.pending.push(entry)
  return commitEntry(entry)
}

function commitEntry(entry: Entry): Promise<void> {
  const db = openDb()
  const generation = store.generation
  const { ops } = entry
  const current = () => store.generation === generation
  const drop = () => {
    if (!current()) return
    const at = store.pending.indexOf(entry)
    if (at !== -1) store.pending.splice(at, 1)
  }
  const settled = store.chain
    .then(async () => {
      if (entry.read) ops.push(...(await entry.read(db)))
      return db.apply(ops)
    })
    .then(
      () => {
        if (current()) {
          for (const [key, value] of ops) {
            if (isStoreKey(key)) continue
            if (value === null) store.committed.delete(key)
            else store.committed.set(key, value)
          }
        }
        drop()
        if (current()) {
          for (const listener of [...commitListeners]) {
            try {
              listener(ops)
            } catch (e) {
              console.error("[walletStorage] commit listener failed:", e)
            }
          }
        }
      },
      (e: unknown) => {
        drop()
        throw e
      },
    )
  store.chain = settled.catch(() => {})
  return settled
}

const commitListeners = new Set<(ops: readonly WalletOp[]) => void>()

function background(ops: readonly WalletOp[]): void {
  // Inside a batch the batch's caller hears the outcome.
  if (store.batch) {
    store.batch.ops.push(...intercept(ops))
    return
  }
  const generation = store.generation
  enqueue(ops).catch((e: unknown) => {
    if (store.generation === generation) store.lostWrite ??= e
    console.error("[walletStorage] write failed:", e)
  })
}

export const walletStorage = {
  getItem(key: string): string | null {
    openDb()
    if (isStoreKey(key)) return null
    for (let i = store.pending.length - 1; i >= 0; i--) {
      const ops = store.pending[i].ops
      for (let j = ops.length - 1; j >= 0; j--) if (ops[j][0] === key) return ops[j][1]
    }
    return store.committed.get(key) ?? null
  },
  /** Called with each transaction's writes once they are saved, all in one store `batch`. */
  onCommit(listener: (ops: readonly WalletOp[]) => void): () => void {
    commitListeners.add(listener)
    return () => commitListeners.delete(listener)
  },
  /** The saved value, ignoring writes not yet committed. */
  getCommitted(key: string): string | null {
    openDb()
    return store.committed.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    background([[key, value]])
  },
  removeItem(key: string): void {
    background([[key, null]])
  },
  keys(): string[] {
    openDb()
    return [...view()].filter(([, value]) => value !== null).map(([key]) => key)
  },
  commitItem(key: string, value: string): Promise<void> {
    return enqueue([[key, value]])
  },
  commitRemove(key: string): Promise<void> {
    return enqueue([[key, null]])
  },
  /** Several writes as one transaction: all land or none do. */
  commitTransaction(ops: readonly WalletOp[]): Promise<void> {
    return enqueue(ops)
  },
  /**
   * Removes every key under `prefix` as one transaction, listed at its turn in the queue: a write
   * queued before it, to the persistent stores' keys too, is removed with the rest.
   */
  commitRemoveUnder(prefix: string): Promise<void> {
    if (store.batch) throw new Error("walletStorage.commitRemoveUnder runs outside a batch")
    const shown: WalletOp[] = this.keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => [key, null])
    const entry: Entry = {
      ops: intercept(shown),
      settled: Promise.resolve(),
      read: async (db) => (await db.range(prefix)).map(([key]): WalletOp => [key, null]),
    }
    store.pending.push(entry)
    return commitEntry(entry)
  },
  /** The entries under `prefix` once every write queued before the call has landed. */
  async rangeQueued(prefix: string, opts?: RangeOptions): Promise<[string, string][]> {
    const db = openDb()
    await store.chain
    return db.range(prefix, opts)
  },
  /**
   * Runs `write` synchronously and commits every write it makes as one transaction; a nested
   * batch joins the outer one and settles with it. Reads inside and after see the writes at once.
   */
  batch(write: () => void): Promise<void> {
    openDb()
    if (store.batch) {
      write()
      return store.batch.settled
    }
    let settle!: { resolve: () => void; reject: (e: unknown) => void }
    const settled = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    // A nested caller that never awaits must not surface as an unhandled rejection.
    settled.catch(() => {})
    const entry: Entry = { ops: [], settled }
    store.pending.push(entry)
    store.batch = entry
    try {
      const result = write() as unknown
      if (result instanceof Promise) {
        result.catch(() => {})
        throw new Error(
          "walletStorage.batch takes a synchronous write: writes after an await would fall outside it",
        )
      }
    } catch (e) {
      store.pending.splice(store.pending.indexOf(entry), 1)
      settle.reject(e)
      throw e
    } finally {
      store.batch = undefined
    }
    commitEntry(entry).then(settle.resolve, settle.reject)
    return settled
  },
  /** Resolves once every queued write has committed; rejects if a background write was lost. */
  async flush(): Promise<void> {
    if (!store.db) return
    await drainQueue()
    const lost = store.lostWrite
    if (lost !== undefined) {
      store.lostWrite = undefined
      throw lost
    }
  },
}

/**
 * The open wallet database as a `DatabaseBackend`. Its commits join the queue `walletStorage`
 * writes through, so both land in call order.
 */
export const opfsBackend: DatabaseBackend = {
  get: async (key) => openDb().get(key),
  getMany: async (keys) => openDb().getMany(keys),
  range: async (prefix, opts) => openDb().range(prefix, opts),
  apply: async (ops) => enqueue(ops),
}

/** Reads of other databases in flight, by store generation and key. */
const otherReads = new Map<string, Promise<string[]>>()
/** Work on other databases runs one at a time, since each holds the databases it opens. */
let otherWork: Promise<unknown> = Promise.resolve()

function onOtherDatabases<T>(work: () => Promise<T>): Promise<T> {
  const run = otherWork.then(work, work)
  otherWork = run.catch(() => {})
  return run
}

/**
 * Removes `keys` from every other rollup's database. Opens all of them before touching any, so a
 * failed open removes nothing. A failure after that keeps the removals already committed; a retry
 * finishes the rest.
 */
export function removeFromOtherDatabases(keys: readonly string[]): Promise<void> {
  return onOtherDatabases(async () => {
    if (!walletStoreIsPersistent()) return
    const others = (await store.backend.list()).filter((version) => version !== store.version)
    const opened: WalletDb[] = []
    try {
      for (const version of others) opened.push(await store.backend.open(version, true))
      const ops = keys.map((key): WalletOp => [key, null])
      for (const db of opened) await db.apply(ops)
    } finally {
      await Promise.all(opened.map((db) => db.close().catch(() => {})))
    }
  })
}

/**
 * Removes every key `match` selects from every other rollup's database. A database another document
 * holds, or one that fails, is skipped and left whole; a later call finishes it.
 */
export function removeMatchingFromOtherDatabases(match: (key: string) => boolean): Promise<void> {
  return onOtherDatabases(async () => {
    await visitOtherDatabases(
      async (_, db) => {
        const { state } = await db.load()
        const ops = [...state.keys()].filter(match).map((key): WalletOp => [key, null])
        if (ops.length) await db.apply(ops)
      },
      { verb: "edit" },
    )
  })
}

/**
 * Reads `key` from every other rollup's database: what this browser kept before the wallet moved to
 * another rollup. A database another document holds, one that fails to read, or one without the key
 * is skipped; with `strict`, the first two fail the read, so a caller that needs every copy never
 * reads a partial set as whole. A store that is not persistent has no other databases to read.
 * Overlapping reads of one key share a result, so neither finds a database the other holds.
 */
export function readFromOtherDatabases(
  key: string,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  const strict = !!opts.strict
  const id = `${store.generation}:${strict}:${key}`
  let read = otherReads.get(id)
  if (!read) {
    read = onOtherDatabases(() => readOtherDatabases(key, strict)).finally(() =>
      otherReads.delete(id),
    )
    otherReads.set(id, read)
  }
  return read
}

async function readOtherDatabases(key: string, strict: boolean): Promise<string[]> {
  return (await readKeysFromOthers([key], strict)).map((entries) => entries.get(key)!)
}

/**
 * Reads `keys` from every other rollup's database, one map per database that holds any of them,
 * so values that belong together come from one database. Skips databases as
 * `readFromOtherDatabases` does.
 */
export function readEntriesFromOtherDatabases(
  keys: readonly string[],
): Promise<Array<Map<string, string>>> {
  return onOtherDatabases(() => readKeysFromOthers(keys, false))
}

async function readKeysFromOthers(
  keys: readonly string[],
  strict: boolean,
): Promise<Array<Map<string, string>>> {
  const found = await visitOtherDatabases(
    async (_, db) => {
      const entries = new Map<string, string>()
      for (const key of keys) {
        const value = await db.get(key)
        if (value !== undefined) entries.set(key, value)
      }
      return entries
    },
    { strict },
  )
  return found.filter((entries) => entries.size > 0)
}

/** One other rollup's database, loaded whole. */
export interface OtherDatabase {
  version: string
  state: ReadonlyMap<string, string>
}

/**
 * Reads every other rollup's database whole, handing each to `read` while it is open. A database
 * another document holds or one that fails to read is skipped, or with `strict` fails the read, as
 * `readFromOtherDatabases`. Reads run one at a time with the other work on those databases.
 */
export function loadFromOtherDatabases<T>(
  read: (db: OtherDatabase) => T,
  opts: { strict?: boolean } = {},
): Promise<T[]> {
  return onOtherDatabases(() =>
    visitOtherDatabases(
      async (version, db) => read({ version, state: (await db.load()).state }),
      opts,
    ),
  )
}

/**
 * Runs `visit` on each other rollup's database while it is open. A database another document holds,
 * or one that fails, is skipped, or with `strict` fails the call.
 */
async function visitOtherDatabases<T>(
  visit: (version: string, db: WalletDb) => Promise<T>,
  opts: { strict?: boolean; verb?: string } = {},
): Promise<T[]> {
  if (!walletStoreIsPersistent()) return []
  const others = (await store.backend.list()).filter((version) => version !== store.version)
  const results: T[] = []
  for (const version of others) {
    let db: WalletDb | undefined
    try {
      db = await store.backend.open(version, true)
      results.push(await visit(version, db))
    } catch (error) {
      if (opts.strict) throw error
      if (!isWalletOpenElsewhere(error))
        console.warn(`[wallet-store] could not ${opts.verb ?? "read"} wallet_${version}:`, error)
    } finally {
      await db?.close().catch(() => {})
    }
  }
  return results
}

/** Navigates once every queued write has committed. A lost background write is reported, not fatal. */
export async function leavePage(url: string, replace = false): Promise<void> {
  await flushForExit()
  if (replace) location.replace(url)
  else location.assign(url)
}

export async function reloadPage(): Promise<void> {
  await flushForExit()
  location.reload()
}

/**
 * A database that stops answering must not trap the user on the page: an exit gives up once no
 * write has been saved for this long. A queue that keeps saving is waited out however long it is.
 */
const EXIT_STALL_MS = 5_000

async function flushForExit(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stall!: () => void
  const stalled = new Promise<never>((_, reject) => {
    stall = () => reject(new Error(`no write saved for ${EXIT_STALL_MS}ms`))
  })
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(stall, EXIT_STALL_MS)
  }
  const off = walletStorage.onCommit(arm)
  arm()
  try {
    await Promise.race([walletStorage.flush(), stalled])
  } catch (e) {
    console.error("[walletStorage] leaving with a lost write:", e)
  } finally {
    clearTimeout(timer)
    off()
  }
}

/**
 * Browser-test access, compiled into the e2e build (`VITE_E2E_WALLET_HOOK`) and UI capture only.
 * Playwright reads and seeds wallet state through `window.__zkmWalletStorage`, whose `*Other`
 * methods reach another rollup's database; a pre-boot `window.__zkmWalletSeed` lands before any
 * read, and `window.__zkmWalletWrite` may replace a value as it is written (return `undefined` to
 * keep it).
 */
type TestWindow = {
  __zkmWalletStorage?: {
    ready: Promise<void>
    /** Every key the database holds, the persistent stores' included, once queued writes land. */
    keys(): Promise<string[]>
    read(key: string): Promise<string | null>
    write(key: string, value: string): Promise<void>
    remove(key: string): Promise<void>
    flush(): Promise<void>
    /** Another rollup's database: write entries into it, or read it back. */
    seedOther(version: string, entries: Record<string, string>): Promise<void>
    readOther(version: string): Promise<Record<string, string>>
  }
  __zkmWalletSeed?: Record<string, string | null>
  __zkmWalletWrite?: (key: string, value: string | null) => string | null | undefined
}

const testWindow = (): TestWindow | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as TestWindow)

const testHook =
  import.meta.env.VITE_E2E_WALLET_HOOK === "true" || import.meta.env.MODE === "ui-capture"
    ? installTestHook()
    : undefined

async function withOther<T>(version: string, use: (db: WalletDb) => Promise<T>): Promise<T> {
  const db = await store.backend.open(version, true)
  try {
    return await use(db)
  } finally {
    await db.close()
  }
}

function installTestHook(): { opened(): void } | undefined {
  const target = testWindow()
  if (!target) return undefined
  let opened!: () => void
  const ready = new Promise<void>((resolve) => (opened = resolve))
  target.__zkmWalletStorage = {
    ready,
    keys: async () => (await walletStorage.rangeQueued("")).map(([key]) => key),
    read: async (key) =>
      isStoreKey(key)
        ? (await walletStorage.rangeQueued(key)).find(([at]) => at === key)?.[1] ?? null
        : walletStorage.getItem(key),
    write: (key, value) => walletStorage.commitItem(key, value),
    remove: (key) => walletStorage.commitRemove(key),
    flush: () => walletStorage.flush(),
    seedOther: (version, entries) => withOther(version, (db) => db.apply(Object.entries(entries))),
    readOther: (version) =>
      withOther(version, async (db) => Object.fromEntries((await db.load()).state)),
  }
  return { opened: () => opened() }
}

function intercept(ops: readonly WalletOp[]): WalletOp[] {
  const replace = testHook ? testWindow()?.__zkmWalletWrite : undefined
  if (!replace) return [...ops]
  return ops.map(([key, value]) => {
    const next = replace(key, value)
    return next === undefined ? [key, value] : [key, next]
  })
}

async function applyTestSeed(): Promise<void> {
  const seed = testHook ? testWindow()?.__zkmWalletSeed : undefined
  if (!seed) return
  await enqueue(Object.entries(seed))
}

export function __setWalletDbBackendForTests(backend: WalletDbBackend | undefined): void {
  store.backend = backend ?? opfsDatabases
}

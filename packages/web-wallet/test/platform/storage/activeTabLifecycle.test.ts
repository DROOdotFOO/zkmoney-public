import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ACTIVE_TAB_LOCK,
  ActiveTabLifecycle,
  BUSY_RETRY_MS,
  CLOSE_GRACE_MS,
  STALLED_AFTER_MS,
  type ActiveTabDeps,
} from "../../../src/platform/storage/activeTabLifecycle"
import { WebLocksUnavailableError } from "../../../src/platform/storage/webLock"
import { FakeLocks } from "../../support/fakeLocks"

class BusyError extends Error {
  name = "SqlitePoolBusyError"
}

/** The database file every tab opens, with the pool lock upstream takes in `open()`. */
class Database {
  holder?: FakeStore
}

class FakeStore {
  closed = false
  closeCalls = 0
  private closing?: Promise<void>

  constructor(
    private readonly db: Database | undefined,
    private readonly closeGate?: Promise<void>,
  ) {}

  close = (): Promise<void> => {
    this.closeCalls++
    this.closing ??= (this.closeGate ?? Promise.resolve()).then(() => {
      this.closed = true
      if (this.db?.holder === this) this.db.holder = undefined
    })
    return this.closing
  }
}

interface TabOptions {
  /** Holds each `open()` until it resolves. */
  openGate?: () => Promise<void>
  /** Holds `close()` until it resolves. */
  closeGate?: Promise<void>
  /** A store in memory takes no pool lock. */
  memory?: boolean
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function createTab(locks: FakeLocks | undefined, db: Database, options: TabOptions = {}) {
  let tabState: "pending" | "active" | "revoked" = "pending"
  let opening = 0
  let maxOpening = 0
  const stores: FakeStore[] = []
  const deps: ActiveTabDeps<FakeStore> = {
    locks,
    open: vi.fn(async () => {
      maxOpening = Math.max(maxOpening, ++opening)
      try {
        await options.openGate?.()
        if (!options.memory && db.holder) throw new BusyError()
        const store = new FakeStore(options.memory ? undefined : db, options.closeGate)
        if (!options.memory) db.holder = store
        stores.push(store)
        return store
      } finally {
        opening--
      }
    }),
    isBusy: (e) => e instanceof BusyError,
    prepare: vi.fn(async () => {
      if (tabState !== "active") throw new Error("prepared while not active")
    }),
    activate: () => {
      if (tabState === "revoked") throw new Error("activated a revoked tab")
      tabState = "active"
    },
    revoke: () => {
      tabState = "revoked"
    },
    reload: vi.fn(),
  }
  const lifecycle = new ActiveTabLifecycle(deps)
  return {
    lifecycle,
    deps,
    stores,
    state: () => lifecycle.getState(),
    tabState: () => tabState,
    maxOpening: () => maxOpening,
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

let locks: FakeLocks
let db: Database

beforeEach(() => {
  vi.useFakeTimers()
  locks = new FakeLocks()
  db = new Database()
})

afterEach(() => {
  vi.useRealTimers()
})

async function readyTab(options?: TabOptions) {
  const tab = createTab(locks, db, options)
  tab.lifecycle.start()
  await settle()
  expect(tab.state().kind).toBe("ready")
  return tab
}

describe("ActiveTabLifecycle", () => {
  it("keeps a second tab inactive without opening anything", async () => {
    await readyTab()
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    expect(b.state()).toEqual({ kind: "inactive", claiming: false })
    expect(b.deps.open).not.toHaveBeenCalled()
    expect(b.tabState()).toBe("pending")
  })

  it("hands over only once the old tab has closed its database", async () => {
    const closing = deferred()
    const a = await readyTab({ closeGate: closing.promise })
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 3)
    expect(a.state().kind).toBe("displaced")
    expect(a.tabState()).toBe("revoked")
    expect(a.stores[0].closeCalls).toBe(1)
    expect(b.state()).toEqual({ kind: "opening", takeover: true, stalled: false })
    expect(b.stores).toHaveLength(0)
    expect(a.deps.reload).not.toHaveBeenCalled()

    closing.resolve()
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS)
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(b.state().kind).toBe("ready")
    expect(b.tabState()).toBe("active")
    expect(a.tabState()).toBe("revoked")
  })

  it("starts a tab on databases in memory at once: the old tab's are its own", async () => {
    const closing = deferred()
    const a = await readyTab({ closeGate: closing.promise, memory: true })
    const b = createTab(locks, db, { memory: true })
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await settle()
    expect(a.state().kind).toBe("displaced")
    expect(a.tabState()).toBe("revoked")
    expect(b.state().kind).toBe("ready")
    closing.resolve()
    await settle()
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
  })

  it("reloads a tab whose database will not close, and the new tab waits on it", async () => {
    const a = await readyTab({ closeGate: new Promise(() => {}) })
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await settle()
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(b.state()).toEqual({ kind: "opening", takeover: true, stalled: false })
    await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS)
    expect(b.state()).toEqual({ kind: "opening", takeover: true, stalled: true })
    expect(b.stores).toHaveLength(0)
  })

  it("keeps the new tab waiting when the old tab's database fails to close", async () => {
    const failing = Promise.reject(new Error("close failed"))
    failing.catch(() => {})
    const a = await readyTab({ closeGate: failing })
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 3)
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(b.state().kind).toBe("opening")
    expect(b.stores).toHaveLength(0)
  })

  it("retries a database another tab holds, one open at a time, and says so after a while", async () => {
    db.holder = new FakeStore(db)
    const a = createTab(locks, db)
    a.lifecycle.start()
    await settle()
    expect(a.state()).toEqual({ kind: "opening", takeover: false, stalled: false })
    const retries = 4
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * retries)
    expect(a.deps.open).toHaveBeenCalledTimes(retries + 1)
    expect(a.tabState()).toBe("pending")
    await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS)
    expect(a.state()).toEqual({ kind: "opening", takeover: false, stalled: true })
    db.holder = undefined
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS)
    expect(a.state().kind).toBe("ready")
    expect(a.maxOpening()).toBe(1)
  })

  it("does not ask to close another tab when there is none, however slow the boot", async () => {
    const opening = deferred()
    const a = createTab(locks, db, { openGate: () => opening.promise })
    a.lifecycle.start()
    await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS * 2)
    expect(a.state()).toEqual({ kind: "opening", takeover: false, stalled: false })
    opening.resolve()
    await settle()
    expect(a.state().kind).toBe("ready")
  })

  it("lets only the latest of two takeovers proceed", async () => {
    const closing = deferred()
    const a = await readyTab({ closeGate: closing.promise })
    const b = createTab(locks, db)
    const c = createTab(locks, db)
    for (const tab of [b, c]) tab.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await settle()
    c.lifecycle.takeOver()
    await settle()
    expect(b.state().kind).toBe("displaced")
    expect(b.deps.reload).toHaveBeenCalledTimes(1)
    closing.resolve()
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS)
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(c.state().kind).toBe("ready")
    expect(b.stores).toHaveLength(0)
    expect(b.tabState()).toBe("revoked")
  })

  it("closes a store that finishes opening after its tab was taken over", async () => {
    const a = await readyTab()
    const opening = deferred()
    const cOpening = deferred()
    const b = createTab(locks, db, { openGate: () => opening.promise })
    const c = createTab(locks, db, { openGate: () => cOpening.promise })
    for (const tab of [b, c]) tab.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await settle()
    expect(a.stores[0].closed).toBe(true)
    expect(b.deps.open).toHaveBeenCalledTimes(1)
    c.lifecycle.takeOver()
    await settle()
    expect(b.deps.reload).not.toHaveBeenCalled()
    opening.resolve()
    await settle()
    expect(b.stores[0].closed).toBe(true)
    expect(b.deps.prepare).not.toHaveBeenCalled()
    expect(b.tabState()).toBe("revoked")
    expect(b.deps.reload).toHaveBeenCalledTimes(1)
    cOpening.resolve()
    await settle()
    expect(c.state().kind).toBe("ready")
  })

  it("takes over from a tab still opening its store", async () => {
    const opening = deferred()
    const a = createTab(locks, db, { openGate: () => opening.promise })
    a.lifecycle.start()
    await settle()
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    await settle()
    expect(a.state().kind).toBe("displaced")
    expect(b.state().kind).toBe("ready")
    // The old tab's late open finds the database taken and leaves it alone.
    opening.resolve()
    await settle()
    expect(a.stores).toHaveLength(0)
    expect(a.tabState()).toBe("revoked")
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(b.state().kind).toBe("ready")
  })

  it("releases the lock after a boot failure, so another tab can boot", async () => {
    const a = createTab(locks, db)
    vi.mocked(a.deps.open).mockRejectedValueOnce(new Error("node unreachable"))
    a.lifecycle.start()
    await settle()
    expect(a.state()).toMatchObject({ kind: "failed", error: new Error("node unreachable") })
    expect(a.tabState()).toBe("revoked")
    expect(locks.isHeld(ACTIVE_TAB_LOCK)).toBe(false)
    await readyTab()
  })

  it("closes the store when preparing fails", async () => {
    const a = createTab(locks, db)
    vi.mocked(a.deps.prepare).mockRejectedValueOnce(new Error("cannot clear"))
    a.lifecycle.start()
    await settle()
    expect(a.state().kind).toBe("failed")
    expect(a.stores[0].closed).toBe(true)
    expect(locks.isHeld(ACTIVE_TAB_LOCK)).toBe(false)
  })

  it("keeps the lock after a failed boot whose store will not close", async () => {
    const failing = Promise.reject(new Error("close failed"))
    failing.catch(() => {})
    const a = createTab(locks, db, { closeGate: failing })
    vi.mocked(a.deps.prepare).mockRejectedValueOnce(new Error("cannot clear"))
    a.lifecycle.start()
    await settle()
    expect(a.state().kind).toBe("failed")
    expect(locks.isHeld(ACTIVE_TAB_LOCK)).toBe(true)
  })

  it("ignores repeated starts", async () => {
    const a = createTab(locks, db)
    a.lifecycle.start()
    a.lifecycle.start()
    await settle()
    expect(a.state().kind).toBe("ready")
    expect(a.deps.open).toHaveBeenCalledTimes(1)
  })

  it("refuses a second click while the first takeover claims", async () => {
    const a = createTab(locks, db)
    a.lifecycle.start()
    await settle()
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    b.lifecycle.takeOver()
    expect(() => b.lifecycle.takeOver()).toThrow("Cannot take over while claiming")
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS)
    expect(a.deps.reload).toHaveBeenCalledTimes(1)
    expect(b.state().kind).toBe("ready")
    expect(b.stores).toHaveLength(1)
  })

  it("takes over after the previous tab has gone, but never on its own", async () => {
    const gone = deferred()
    void locks.request(ACTIVE_TAB_LOCK, {}, () => gone.promise)
    await settle()
    const b = createTab(locks, db)
    b.lifecycle.start()
    await settle()
    gone.resolve()
    await settle()
    expect(b.state()).toEqual({ kind: "inactive", claiming: false })
    b.lifecycle.takeOver()
    expect(b.state()).toEqual({ kind: "inactive", claiming: true })
    await settle()
    expect(b.state().kind).toBe("ready")
  })

  it("fails as unsupported without Web Locks", () => {
    const a = createTab(undefined, db)
    a.lifecycle.start()
    const state = a.state()
    expect(state.kind === "failed" && state.error).toBeInstanceOf(WebLocksUnavailableError)
  })
})

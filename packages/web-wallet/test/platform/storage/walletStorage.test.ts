import { afterEach, describe, expect, it, vi } from "vitest"
import { setActiveRollup } from "../../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  isWalletOpenElsewhere,
  leavePage,
  openWalletStore,
  readFromOtherDatabases,
  removeFromOtherDatabases,
  removeMatchingFromOtherDatabases,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"

const dbs = testWalletDbs()
const ROLLUP = "1821665230"

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function reopen(version = ROLLUP, persistent = true) {
  await closeWalletStore()
  setActiveRollup(version)
  await openWalletStore(version, { persistent })
}

/** Counts the backend's opens; `failFirst` makes the first one throw its error. */
function countOpens(failFirst?: () => Error) {
  const open = dbs.open.bind(dbs)
  let count = 0
  dbs.open = async (version, persistent) => {
    count++
    if (count === 1 && failFirst) throw failFirst()
    return open(version, persistent)
  }
  return {
    attempts: () => count,
    restore: () => {
      delete (dbs as { open?: unknown }).open
    },
  }
}

afterEach(() => {
  localStorage.clear()
  setActiveRollup(sandboxProfile().shared.rollupVersion)
})

describe("walletStorage writes", () => {
  it("resolves a committing write only once the database has it", async () => {
    await reopen()
    const gate = deferred()
    dbs.onApply = () => gate.promise
    let settled = false
    const write = walletStorage.commitItem("k", "v").then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(dbs.db(ROLLUP).state.get("k")).toBeUndefined()
    gate.resolve()
    await write
    expect(dbs.db(ROLLUP).state.get("k")).toBe("v")
  })

  it("keeps the later write when the earlier of two fails", async () => {
    await reopen()
    await walletStorage.commitItem("k", "old")
    let call = 0
    dbs.onApply = () => {
      if (call++ === 0) throw new Error("A")
    }
    const a = walletStorage.commitItem("k", "A")
    const b = walletStorage.commitItem("k", "B")
    await expect(a).rejects.toThrow("A")
    await b
    expect(walletStorage.getItem("k")).toBe("B")
    expect(dbs.db(ROLLUP).state.get("k")).toBe("B")
  })

  it("falls back to the saved value when both of two writes fail", async () => {
    await reopen()
    await walletStorage.commitItem("k", "old")
    dbs.onApply = () => {
      throw new Error("disk")
    }
    const a = walletStorage.commitItem("k", "A")
    const b = walletStorage.commitItem("k", "B")
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    expect(walletStorage.getItem("k")).toBe("old")
    expect(dbs.db(ROLLUP).state.get("k")).toBe("old")
  })

  it("commits a batch as one transaction, all or nothing", async () => {
    await reopen()
    await walletStorage.commitTransaction([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ])
    dbs.onApply = () => {
      throw new Error("disk")
    }
    await expect(
      walletStorage.batch(() => {
        walletStorage.removeItem("a")
        walletStorage.removeItem("b")
        walletStorage.removeItem("c")
      }),
    ).rejects.toThrow()
    expect(walletStorage.keys().sort()).toEqual(["a", "b", "c"])
    expect([...dbs.db(ROLLUP).state.keys()].sort()).toEqual(["a", "b", "c"])
  })

  it("persists interleaved background and committing writes in call order", async () => {
    await reopen()
    walletStorage.setItem("k", "1")
    const second = walletStorage.commitItem("k", "2")
    walletStorage.setItem("k", "3")
    await second
    await walletStorage.flush()
    expect(dbs.db(ROLLUP).state.get("k")).toBe("3")
  })

  it("reports a lost background write at the next flush", async () => {
    dbs.onApply = () => {
      throw new Error("disk")
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    walletStorage.setItem("k", "v")
    await expect(walletStorage.flush()).rejects.toThrow("disk")
    await expect(walletStorage.flush()).resolves.toBeUndefined()
  })

  it("flushes writes queued while it was waiting, not only those queued before it", async () => {
    await reopen()
    const held = deferred()
    let first = true
    dbs.onApply = async () => {
      if (!first) return
      first = false
      await held.promise
    }
    walletStorage.setItem("a", "1")
    let flushed = false
    const flush = walletStorage.flush().then(() => (flushed = true))
    walletStorage.setItem("b", "2")
    held.resolve()
    await flush
    expect(flushed).toBe(true)
    expect(dbs.db(ROLLUP).state.get("b")).toBe("2")
  })

  it("settles a nested batch with the enclosing transaction", async () => {
    await reopen()
    dbs.onApply = () => {
      throw new Error("disk")
    }
    let inner: Promise<void> | undefined
    const outer = walletStorage.batch(() => {
      walletStorage.setItem("a", "1")
      inner = walletStorage.batch(() => walletStorage.setItem("b", "2"))
    })
    await expect(outer).rejects.toThrow("disk")
    await expect(inner!).rejects.toThrow("disk")
  })

  it("refuses a batch whose write is asynchronous, leaving nothing queued", () => {
    const write = (async () => {}) as unknown as () => void
    expect(() => walletStorage.batch(write)).toThrow(/synchronous/)
    expect(walletStorage.keys()).toEqual([])
  })

  it("keeps call order when a committing write runs inside a batch", async () => {
    await reopen()
    let joined: Promise<void> | undefined
    await walletStorage.batch(() => {
      walletStorage.setItem("k", "first")
      joined = walletStorage.commitItem("k", "second")
    })
    await joined
    expect(dbs.db(ROLLUP).state.get("k")).toBe("second")
  })

  it("lands queued writes before closing, and keeps a closed store's failures out of the next", async () => {
    await reopen()
    const held = deferred()
    dbs.onApply = () => held.promise
    walletStorage.setItem("k", "v")
    const closing = closeWalletStore()
    held.resolve()
    await closing
    expect(dbs.db(ROLLUP).state.get("k")).toBe("v")
    dbs.onApply = undefined
    await reopen()
    await expect(walletStorage.flush()).resolves.toBeUndefined()
  })
})

describe("readFromOtherDatabases", () => {
  it("reads another rollup's value, skipping a database held elsewhere and one without the key", async () => {
    dbs.db("111").state.set("k", "one")
    dbs.db("222")
    dbs.db("333").state.set("k", "three")
    await reopen()
    const held = await dbs.open("333", true)
    try {
      expect(await readFromOtherDatabases("k")).toEqual(["one"])
    } finally {
      await held.close()
    }
    expect(await readFromOtherDatabases("k")).toEqual(["one", "three"])
    expect(dbs.db(ROLLUP).held).toBe(true)
  })

  it("reads the one key without loading the rest of the database", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => {
      const db = await open(version, persistent)
      return version === "111" ? { ...db, load: async () => Promise.reject(new Error("load")) } : db
    }
    try {
      expect(await readFromOtherDatabases("k")).toEqual(["one"])
    } finally {
      delete (dbs as { open?: unknown }).open
    }
  })

  it("closes a database whose read fails", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => {
      const db = await open(version, persistent)
      return version === "111" ? { ...db, get: async () => Promise.reject(new Error("disk")) } : db
    }
    try {
      expect(await readFromOtherDatabases("k")).toEqual([])
    } finally {
      delete (dbs as { open?: unknown }).open
    }
    expect(dbs.db("111").held).toBe(false)
  })

  it("fails a strict read on a database held elsewhere or one whose read fails, and closes it", async () => {
    dbs.db("111").state.set("k", "one")
    dbs.db("222").state.set("k", "two")
    await reopen()
    const held = await dbs.open("222", true)
    try {
      await expect(readFromOtherDatabases("k", { strict: true })).rejects.toBeDefined()
    } finally {
      await held.close()
    }
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => {
      const db = await open(version, persistent)
      return version === "111" ? { ...db, get: async () => Promise.reject(new Error("disk")) } : db
    }
    try {
      await expect(readFromOtherDatabases("k", { strict: true })).rejects.toThrow("disk")
    } finally {
      delete (dbs as { open?: unknown }).open
    }
    expect(dbs.db("111").held).toBe(false)
    expect(await readFromOtherDatabases("k", { strict: true })).toEqual(["one", "two"])
  })

  it("reads nothing, and opens nothing, from a store that is not persistent", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen(ROLLUP, false)
    const opens = countOpens()
    try {
      expect(await readFromOtherDatabases("k")).toEqual([])
      expect(opens.attempts()).toBe(0)
    } finally {
      opens.restore()
    }
  })

  it("never hands a read begun before a reopen to a read after it", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const gate = deferred()
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => {
      if (version === "111") await gate.promise
      return open(version, persistent)
    }
    try {
      const before = readFromOtherDatabases("k")
      await reopen(ROLLUP, false)
      const after = readFromOtherDatabases("k")
      gate.resolve()
      expect(await after).toEqual([])
      expect(await before).toEqual(["one"])
    } finally {
      delete (dbs as { open?: unknown }).open
    }
  })

  it("lets a removal wait out a read that holds the database", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const gate = deferred()
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => {
      const db = await open(version, persistent)
      return { ...db, get: async (key) => (await gate.promise, db.get(key)) }
    }
    try {
      const read = readFromOtherDatabases("k")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dbs.db("111").held).toBe(true)
      const removal = removeFromOtherDatabases(["k"])
      gate.resolve()
      await expect(removal).resolves.toBeUndefined()
      expect(await read).toEqual(["one"])
      expect(dbs.db("111").state.has("k")).toBe(false)
    } finally {
      delete (dbs as { open?: unknown }).open
    }
  })

  it("starts a read behind a removal, never inside it", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const listed = deferred()
    const got = deferred()
    const list = dbs.list.bind(dbs)
    const open = dbs.open.bind(dbs)
    dbs.list = async () => {
      await listed.promise
      return list()
    }
    dbs.open = async (version, persistent) => {
      const db = await open(version, persistent)
      return { ...db, get: async (key) => (await got.promise, db.get(key)) }
    }
    try {
      const removal = removeFromOtherDatabases(["k"])
      const read = readFromOtherDatabases("k")
      await new Promise((resolve) => setTimeout(resolve, 0))
      listed.resolve()
      await expect(removal).resolves.toBeUndefined()
      got.resolve()
      expect(await read).toEqual([])
    } finally {
      delete (dbs as { list?: unknown }).list
      delete (dbs as { open?: unknown }).open
    }
  })

  it("gives two overlapping reads the same values, not a database the other holds", async () => {
    dbs.db("111").state.set("k", "one")
    await reopen()
    const [a, b] = await Promise.all([readFromOtherDatabases("k"), readFromOtherDatabases("k")])
    expect(a).toEqual(["one"])
    expect(b).toEqual(["one"])
  })
})

describe("removeMatchingFromOtherDatabases", () => {
  it("removes the matching keys of every other rollup, skipping a database held elsewhere", async () => {
    dbs.db("111").state.set("a.pool", "1").set("a.slot", "1")
    dbs.db("222").state.set("a.pool", "2")
    await reopen()
    walletStorage.setItem("a.pool", "active")
    const held = await dbs.open("222", true)
    try {
      await removeMatchingFromOtherDatabases((key) => key.endsWith(".pool"))
    } finally {
      await held.close()
    }
    expect([...dbs.db("111").state.keys()]).toEqual(["a.slot"])
    expect(dbs.db("222").state.get("a.pool")).toBe("2")
    expect(walletStorage.getItem("a.pool")).toBe("active")
    expect(dbs.db("111").held).toBe(false)
  })
})

describe("leavePage", () => {
  it("waits out a slow queue as long as writes keep being saved", async () => {
    await reopen()
    vi.useFakeTimers()
    const assign = vi.fn()
    vi.stubGlobal("location", { assign })
    dbs.onApply = () => new Promise<void>((resolve) => setTimeout(resolve, 3_000))
    try {
      walletStorage.setItem("a", "1")
      walletStorage.setItem("b", "2")
      walletStorage.setItem("c", "3")
      const leaving = leavePage("/claim")
      // Nine seconds of saving, never five without one.
      await vi.advanceTimersByTimeAsync(8_000)
      expect(assign).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      await leaving
      expect(assign).toHaveBeenCalledWith("/claim")
      expect(dbs.db(ROLLUP).state.get("c")).toBe("3")
    } finally {
      dbs.onApply = undefined
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("still leaves when no write has been saved within the stall bound", async () => {
    await reopen()
    vi.useFakeTimers()
    const assign = vi.fn()
    vi.stubGlobal("location", { assign })
    vi.spyOn(console, "error").mockImplementation(() => {})
    let answer!: () => void
    dbs.onApply = () => new Promise<void>((resolve) => (answer = resolve))
    try {
      walletStorage.setItem("k", "v")
      const leaving = leavePage("/claim")
      await vi.advanceTimersByTimeAsync(4_999)
      expect(assign).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await leaving
      expect(assign).toHaveBeenCalledWith("/claim")
    } finally {
      answer()
      dbs.onApply = undefined
      await walletStorage.flush()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe("openWalletStore", () => {
  it("opens one database after another when asked for two at once", async () => {
    await closeWalletStore()
    const seven = openWalletStore("7", { persistent: true })
    const nine = openWalletStore("9", { persistent: true })
    await seven
    await nine
    expect(dbs.db("7").held).toBe(false)
    expect(dbs.db("9").held).toBe(true)
  })

  it("resolves a joining open only once the first has finished, with one database open", async () => {
    await closeWalletStore()
    dbs.db(ROLLUP).state.set("webwallet.identity", "x")
    const held = deferred()
    const open = dbs.open.bind(dbs)
    let opens = 0
    dbs.open = async (version, persistent) => {
      opens++
      await held.promise
      return open(version, persistent)
    }
    try {
      const first = openWalletStore(ROLLUP, { persistent: true })
      let joinedDone = false
      const joined = openWalletStore(ROLLUP, { persistent: true }).then(() => (joinedDone = true))
      await new Promise((r) => setTimeout(r, 0))
      expect(joinedDone).toBe(false)
      held.resolve()
      await first
      await joined
      expect(opens).toBe(1)
      expect(walletStorage.getItem("webwallet.identity")).toBe("x")
    } finally {
      delete (dbs as { open?: unknown }).open
    }
  })

  it("opens only after a close that is still landing writes", async () => {
    await reopen("7")
    const held = deferred()
    dbs.onApply = () => held.promise
    walletStorage.setItem("k", "v")
    const closing = closeWalletStore()
    const opening = openWalletStore("9", { persistent: true })
    held.resolve()
    await closing
    await opening
    dbs.onApply = undefined
    expect(dbs.db("7").held).toBe(false)
    expect(dbs.db("9").held).toBe(true)
    walletStorage.setItem("x", "1")
    await walletStorage.flush()
    expect(dbs.db("9").state.get("x")).toBe("1")
  })

  it("ends open when an open follows a close queued behind an earlier open", async () => {
    await closeWalletStore()
    const first = openWalletStore(ROLLUP, { persistent: true })
    const closing = closeWalletStore()
    const second = openWalletStore(ROLLUP, { persistent: true })
    await Promise.all([first, closing, second])
    expect(dbs.db(ROLLUP).held).toBe(true)
    expect(walletStorage.getItem("k")).toBeNull()
  })

  it("does not install a handle when a close lands while it is opening", async () => {
    await closeWalletStore()
    const opening = openWalletStore(ROLLUP, { persistent: true })
    const closing = closeWalletStore()
    await opening
    await closing
    expect(dbs.db(ROLLUP).held).toBe(false)
    expect(() => walletStorage.getItem("k")).toThrow(/wallet store is closed/)
  })

  it("fails as already open when another document holds the database, with no second try", async () => {
    await closeWalletStore()
    const other = await dbs.open(ROLLUP, true)
    const { attempts, restore } = countOpens()
    try {
      const error = await openWalletStore(ROLLUP, { persistent: true }).catch((e: unknown) => e)
      expect(isWalletOpenElsewhere(error)).toBe(true)
      expect(attempts()).toBe(1)
    } finally {
      restore()
      await other.close()
    }
  })

  it("tries again when an open fails for a reason other than a held database", async () => {
    await closeWalletStore()
    vi.useFakeTimers()
    const { attempts, restore } = countOpens(() => new Error("access handles still held"))
    try {
      const opening = openWalletStore(ROLLUP, { persistent: true })
      await vi.advanceTimersByTimeAsync(1_000)
      await opening
      expect(attempts()).toBe(2)
      expect(dbs.db(ROLLUP).held).toBe(true)
    } finally {
      restore()
      vi.useRealTimers()
    }
  })

  it("releases the database when the open fails after acquiring it, so a retry succeeds", async () => {
    await closeWalletStore()
    dbs.db(ROLLUP).state.set("webwallet.identity", "{}")
    const open = dbs.open.bind(dbs)
    dbs.open = async (version, persistent) => ({
      ...(await open(version, persistent)),
      load: async () => {
        throw new Error("disk")
      },
    })
    try {
      await expect(openWalletStore(ROLLUP, { persistent: true })).rejects.toThrow("disk")
      expect(dbs.db(ROLLUP).held).toBe(false)
    } finally {
      delete (dbs as { open?: unknown }).open
    }
    await openWalletStore(ROLLUP, { persistent: true })
    expect(walletStorage.getItem("webwallet.identity")).toBe("{}")
  })
})

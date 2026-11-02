import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearSiteData,
  DB_DELETE_DEADLINE_MS,
  FILES_DEADLINE_MS,
  type ClearSiteDataDeps,
} from "../../../src/platform/storage/clearSiteData"

const named = (name: string) => Object.assign(new Error(name), { name })

type DeleteBehavior = "success" | "error" | "silent" | "throw"

function fakeIdb(names: string[], behavior: (name: string) => DeleteBehavior = () => "success") {
  const requests: Partial<IDBOpenDBRequest>[] = []
  const deleted: string[] = []
  const idb = {
    databases: vi.fn(async () => names.map((name) => ({ name, version: 1 }))),
    deleteDatabase: vi.fn((name: string) => {
      const mode = behavior(name)
      if (mode === "throw") throw named("SecurityError")
      const request: Partial<IDBOpenDBRequest> = {}
      requests.push(request)
      if (mode !== "silent") {
        queueMicrotask(() => {
          if (mode === "success") {
            deleted.push(name)
            request.onsuccess?.call(request as IDBOpenDBRequest, new Event("success"))
          } else request.onerror?.call(request as IDBOpenDBRequest, new Event("error"))
        })
      }
      return request as IDBOpenDBRequest
    }),
  }
  return { idb: idb as unknown as IDBFactory, requests, deleted }
}

/** Names starting with "." are directories, the rest plain files. */
function fakeRoot(names: string[], remove: (name: string) => Promise<void> = async () => {}) {
  const removed: string[] = []
  const root = {
    entries: async function* () {
      for (const name of names) yield [name, { kind: name.startsWith(".") ? "directory" : "file" }]
    },
    removeEntry: vi.fn(async (name: string) => {
      await remove(name)
      removed.push(name)
    }),
  }
  return { root: root as unknown as FileSystemDirectoryHandle, removed }
}

function deps(overrides: Partial<ClearSiteDataDeps> = {}): ClearSiteDataDeps {
  return {
    opfsRoot: async () => fakeRoot([]).root,
    loadPools: async () => ({ prefix: ".aztec-kv-", deletePoolDirectory: async () => {} }),
    indexedDB: () => fakeIdb([]).idb,
    localStorage: () => localStorage,
    sessionStorage: () => sessionStorage,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.setItem("identity", "x")
  sessionStorage.setItem("stash", "y")
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  sessionStorage.clear()
})

/** Runs the wipe to completion, advancing retry and deadline timers. */
async function run(d: ClearSiteDataDeps) {
  const result = clearSiteData(d)
  await vi.runAllTimersAsync()
  return result
}

describe("clearSiteData", () => {
  it("clears every kind of storage and reports nothing left", async () => {
    const { root, removed } = fakeRoot([
      ".aztec-kv-pxe-0xabc",
      ".aztec-kv-wallet_1821665230",
      "xmtp.db3",
    ])
    const deletePoolDirectory = vi.fn(async () => {})
    const { idb, deleted } = fakeIdb(["a", "b"])

    const left = await run(
      deps({
        opfsRoot: async () => root,
        loadPools: async () => ({ prefix: ".aztec-kv-", deletePoolDirectory }),
        indexedDB: () => idb,
      }),
    )

    expect(left).toEqual([])
    expect(deletePoolDirectory).toHaveBeenCalledWith(".aztec-kv-pxe-0xabc")
    expect(deletePoolDirectory).toHaveBeenCalledWith(".aztec-kv-wallet_1821665230")
    expect(removed).toEqual(["xmtp.db3"])
    expect(deleted).toEqual(["a", "b"])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it("retries a pool that is still locked by the page that just closed", async () => {
    const { root } = fakeRoot([".aztec-kv-pxe-0xabc"])
    const deletePoolDirectory = vi
      .fn()
      .mockRejectedValueOnce(named("SqlitePoolBusyError"))
      .mockResolvedValueOnce(undefined)

    const left = await run(
      deps({
        opfsRoot: async () => root,
        loadPools: async () => ({ prefix: ".aztec-kv-", deletePoolDirectory }),
      }),
    )

    expect(left).toEqual([])
    expect(deletePoolDirectory).toHaveBeenCalledTimes(2)
  })

  it("retries a file whose handle is still being released", async () => {
    let first = true
    const { root, removed } = fakeRoot(["xmtp.db3"], async () => {
      if (first) {
        first = false
        throw named("NoModificationAllowedError")
      }
    })

    expect(await run(deps({ opfsRoot: async () => root }))).toEqual([])
    expect(removed).toEqual(["xmtp.db3"])
  })

  it("reports a pool held past the retries as busy, never removes it raw, and clears the rest", async () => {
    const { root, removed } = fakeRoot([".aztec-kv-pxe-0xabc", "xmtp.db3"])
    const deletePoolDirectory = vi.fn(async () => {
      throw named("SqlitePoolBusyError")
    })
    const { idb, deleted } = fakeIdb(["a"])

    const left = await run(
      deps({
        opfsRoot: async () => root,
        loadPools: async () => ({ prefix: ".aztec-kv-", deletePoolDirectory }),
        indexedDB: () => idb,
      }),
    )

    expect(left).toEqual([{ kind: "files", item: ".aztec-kv-pxe-0xabc", reason: "busy" }])
    expect(removed).toEqual(["xmtp.db3"])
    expect(deleted).toEqual(["a"])
    expect(localStorage.length).toBe(0)
  })

  it("treats an entry that is already gone as cleared", async () => {
    const { root } = fakeRoot(["gone"], async () => {
      throw named("NotFoundError")
    })
    expect(await run(deps({ opfsRoot: async () => root }))).toEqual([])
  })

  it("reports a file the browser refuses as unavailable", async () => {
    const { root } = fakeRoot(["locked"], async () => {
      throw named("SecurityError")
    })
    expect(await run(deps({ opfsRoot: async () => root }))).toEqual([
      { kind: "files", item: "locked", reason: "unavailable" },
    ])
  })

  it.each([
    [
      "the browser has no private file storage",
      {
        opfsRoot: () => {
          throw new TypeError("navigator.storage.getDirectory is not a function")
        },
      },
    ],
    ["the storage root rejects", { opfsRoot: async () => Promise.reject(named("SecurityError")) }],
    [
      "listing throws midway",
      {
        opfsRoot: async () =>
          ({
            entries: async function* () {
              yield ["a", { kind: "file" }]
              throw named("InvalidStateError")
            },
          } as unknown as FileSystemDirectoryHandle),
      },
    ],
  ])("marks files unavailable when %s, and still clears the rest", async (_, override) => {
    const { idb, deleted } = fakeIdb(["a"])
    const left = await run(deps({ ...override, indexedDB: () => idb }))
    expect(left).toEqual([{ kind: "files", item: "*", reason: "unavailable" }])
    expect(deleted).toEqual(["a"])
    expect(localStorage.length).toBe(0)
  })

  it("removes only plain files when the pool module fails to load", async () => {
    const { root, removed } = fakeRoot([".aztec-kv-pxe-0xabc", "xmtp.db3"])
    const left = await run(
      deps({
        opfsRoot: async () => root,
        loadPools: async () => Promise.reject(new Error("chunk failed")),
      }),
    )
    expect(left).toEqual([{ kind: "files", item: ".aztec-kv-pxe-0xabc", reason: "unavailable" }])
    expect(removed).toEqual(["xmtp.db3"])
    expect(localStorage.length).toBe(0)
  })

  it.each([
    ["the pool module never loads", { loadPools: () => new Promise<never>(() => {}) }],
    [
      "a removal never settles",
      { opfsRoot: async () => fakeRoot(["stuck"], () => new Promise<never>(() => {})).root },
    ],
  ])(
    "gives up on files at the deadline when %s, and still clears the rest",
    async (_, override) => {
      const { idb, deleted } = fakeIdb(["a"])
      const left = await run(deps({ ...override, indexedDB: () => idb }))
      expect(left).toEqual([{ kind: "files", item: "*", reason: "busy" }])
      expect(deleted).toEqual(["a"])
      expect(localStorage.length).toBe(0)
    },
  )

  it("starts no more removals once the files deadline has passed", async () => {
    const { root, removed } = fakeRoot(["slow", "later"], (name) =>
      name === "slow"
        ? new Promise((resolve) => setTimeout(resolve, FILES_DEADLINE_MS + 1_000))
        : Promise.resolve(),
    )
    const left = await run(deps({ opfsRoot: async () => root }))
    expect(left).toEqual([{ kind: "files", item: "*", reason: "busy" }])
    // The in-flight removal finishes on its own; the entry after it is never touched.
    await vi.runAllTimersAsync()
    expect(removed).toEqual(["slow"])
  })

  it("reports a database held open as pending at the deadline", async () => {
    const { idb } = fakeIdb(["held"], () => "silent")
    expect(await run(deps({ indexedDB: () => idb }))).toEqual([
      { kind: "databases", item: "held", reason: "pending" },
    ])
    expect(sessionStorage.length).toBe(0)
  })

  it("resolves a second wipe while the first one's delete is still pending", async () => {
    const { idb } = fakeIdb(["held"], () => "silent")
    const first = clearSiteData(deps({ indexedDB: () => idb }))
    const second = clearSiteData(deps({ indexedDB: () => idb }))
    await vi.advanceTimersByTimeAsync(DB_DELETE_DEADLINE_MS)
    expect(await first).toEqual([{ kind: "databases", item: "held", reason: "pending" }])
    expect(await second).toEqual([{ kind: "databases", item: "held", reason: "pending" }])
  })

  it("reports a failed or refused database delete as unavailable", async () => {
    const { idb } = fakeIdb(["bad", "refused"], (name) => (name === "bad" ? "error" : "throw"))
    expect(await run(deps({ indexedDB: () => idb }))).toEqual([
      { kind: "databases", item: "bad", reason: "unavailable" },
      { kind: "databases", item: "refused", reason: "unavailable" },
    ])
  })

  it("deletes a database with an empty name and skips one with no name", async () => {
    const { idb, deleted } = fakeIdb([""])
    ;(idb.databases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { name: "", version: 1 },
      { version: 1 },
    ])
    expect(await run(deps({ indexedDB: () => idb }))).toEqual([])
    expect(deleted).toEqual([""])
    expect(idb.deleteDatabase).toHaveBeenCalledTimes(1)
  })

  it("marks databases unavailable when the browser can't list them", async () => {
    const left = await run(deps({ indexedDB: () => ({} as IDBFactory) }))
    expect(left).toEqual([{ kind: "databases", item: "*", reason: "unavailable" }])
    expect(localStorage.length).toBe(0)
  })

  it("keeps going when localStorage can't be reached", async () => {
    const left = await run(
      deps({
        localStorage: () => {
          throw named("SecurityError")
        },
      }),
    )
    expect(left).toEqual([{ kind: "localStorage", item: "*", reason: "unavailable" }])
    expect(sessionStorage.length).toBe(0)
  })

  it("reports a storage that refuses to clear", async () => {
    const refusing = {
      clear: () => {
        throw named("SecurityError")
      },
    } as unknown as Storage
    const left = await run(deps({ sessionStorage: () => refusing }))
    expect(left).toEqual([{ kind: "sessionStorage", item: "*", reason: "unavailable" }])
  })
})

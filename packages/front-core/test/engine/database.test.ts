import { describe, expect, it, vi } from "vitest"
import { openDatabase, type Op } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { derived, memoryStore } from "../../src/engine/store"
import { backendContract } from "./backendContract"

let shared = new Map<string, string>()
let backend = memoryBackend()
backendContract("memory", () => (backend = memoryBackend((shared = new Map()))), {
  reopen: () => memoryBackend(shared),
  failing: (on) => void (backend.failing = { commits: on }),
})

describe("openDatabase", () => {
  it("reads committed state outside a write, and its own staged writes inside", async () => {
    const backend = memoryBackend(new Map([["a", "1"]]))
    const db = openDatabase(backend)
    const seen: unknown[] = []
    await db.write(async (w) => {
      w.put("a", "2")
      w.put("b", "3")
      w.remove("b")
      seen.push(await w.get("a"), await w.get("b"), await w.getMany(["a", "c", "b"]))
      seen.push(await db.get("a"))
    })
    expect(seen).toEqual(["2", undefined, ["2", undefined, undefined], "1"])
    expect([...backend.entries]).toEqual([["a", "2"]])
  })

  it("keeps each key's saved value when the write stages one while its read waits", async () => {
    const db = openDatabase(
      memoryBackend(
        new Map([
          ["a", "A"],
          ["b", "B"],
        ]),
      ),
    )
    const read = await db.write(async (w) => {
      const both = w.getMany(["a", "b"])
      w.put("a", "x")
      return both
    })
    expect(read).toEqual(["x", "B"])
  })

  it("runs one write at a time, in call order", async () => {
    const db = openDatabase(memoryBackend())
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = db.write(async (w) => {
      order.push("first-start")
      await held
      w.put("k", "first")
      order.push("first-end")
    })
    const second = db.write(async (w) => {
      order.push(`second-sees-${await w.get("k")}`)
      w.put("k", "second")
    })
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second-sees-first"])
    expect(await db.get("k")).toBe("second")
  })

  it("commits nothing when the write throws, and the next write still runs", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const heard = vi.fn()
    db.onCommit(heard)
    await expect(
      db.write(async (w) => {
        w.put("x", "1")
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await db.write(async (w) => w.put("y", "1"))
    expect([...backend.entries.keys()]).toEqual(["y"])
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("rejects a failed commit, keeps nothing and tells no listener", async () => {
    const backend = memoryBackend(new Map([["a", "1"]]))
    const db = openDatabase(backend)
    const heard = vi.fn()
    db.onCommit(heard)
    backend.failing = { commits: true }
    await expect(db.write(async (w) => w.put("a", "2"))).rejects.toThrow()
    backend.failing = {}
    expect(await db.get("a")).toBe("1")
    expect(heard).not.toHaveBeenCalled()
  })

  it("resolves a write with its result, after its listeners heard the commit", async () => {
    const db = openDatabase(memoryBackend())
    const heard: (readonly Op[])[] = []
    db.onCommit((ops) => heard.push(ops))
    const result = await db.write(async (w) => {
      w.put("a", "1")
      w.put("a", "2")
      w.remove("gone")
      return heard.length
    })
    expect(result).toBe(0)
    expect(heard).toEqual([
      [
        ["a", "2"],
        ["gone", null],
      ],
    ])
    await db.write(async () => {})
    expect(heard).toHaveLength(1)
  })

  it("tells listeners in one store batch", async () => {
    const db = openDatabase(memoryBackend())
    const a = memoryStore(0)
    const b = memoryStore(0)
    db.onCommit(() => a.set(1))
    db.onCommit(() => b.set(1))
    const both = derived([a, b] as const, (x, y) => [x, y])
    const seen: number[][] = []
    both.subscribe(() => seen.push(both.get()))
    await db.write(async (w) => w.put("t", "1"))
    expect(seen).toEqual([[1, 1]])
  })

  it("refuses a write handle used after its write ended", async () => {
    const db = openDatabase(memoryBackend())
    let kept: Parameters<Parameters<typeof db.write>[0]>[0] | undefined
    await db.write(async (w) => void (kept = w))
    expect(() => kept!.put("late", "1")).toThrow(/ended/)
  })

  it("scopes keys, ranges and listeners under a prefix", async () => {
    const backend = memoryBackend(new Map([["other", "x"]]))
    const root = openDatabase(backend)
    const db = root.scoped("ns.")
    expect(db.prefix).toBe("ns.")
    const heard: (readonly Op[])[] = []
    db.onCommit((ops) => heard.push(ops))
    await db.write(async (w) => {
      expect(w.prefix).toBe("ns.")
      w.put("r/1", "a")
      w.put("r/2", "b")
      w.scoped("r/").put("3", "c")
    })
    await root.write(async (w) => w.put("other", "y"))
    expect([...backend.entries.keys()].sort()).toEqual(["ns.r/1", "ns.r/2", "ns.r/3", "other"])
    expect(await db.range("r/", { after: "r/1", reverse: true })).toEqual([
      ["r/3", "c"],
      ["r/2", "b"],
    ])
    expect(await db.get("other")).toBeUndefined()
    expect(heard).toEqual([
      [
        ["r/1", "a"],
        ["r/2", "b"],
        ["r/3", "c"],
      ],
    ])
  })

  it("drops a scope's listeners once its signal aborts", async () => {
    const root = openDatabase(memoryBackend())
    const ended = new AbortController()
    const db = root.scoped("ns.", ended.signal)
    const inner = db.scoped("x/")
    const heard: string[] = []
    db.onCommit((ops) => ops.forEach(([key]) => heard.push(key)))
    inner.onCommit((ops) => ops.forEach(([key]) => heard.push(`inner:${key}`)))
    await root.write(async (w) => w.put("ns.x/a", "1"))
    ended.abort()
    await root.write(async (w) => w.put("ns.x/b", "1"))
    expect(heard).toEqual(["x/a", "inner:a"])
    expect(db.onCommit(() => heard.push("late"))).toBeTypeOf("function")
  })
})

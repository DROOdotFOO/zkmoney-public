// @vitest-environment node
import { describe, expect, it } from "vitest"
import { memoryStore } from "../../src/engine/store"
import { legacyStore } from "../../src/engine/legacyStore"

/** A source whose reads resolve only when the test says so, with the value as it was at the read. */
function slowSource(initial: string) {
  let value = initial
  const changes = memoryStore(0)
  const pending: (() => void)[] = []
  return {
    source: {
      read: () => {
        const seen = value
        return new Promise<string>((resolve) => pending.push(() => resolve(seen)))
      },
      subscribe: (onChange: () => void) => changes.subscribe(onChange),
    },
    write(next: string) {
      value = next
      changes.update((n) => n + 1)
    },
    /** Resolves the reads in flight, oldest first unless `order` says otherwise. */
    async resolve(order: "oldest" | "newest" = "oldest") {
      const reads = pending.splice(0)
      for (const r of order === "oldest" ? reads : reads.reverse()) r()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("legacyStore", () => {
  it("never lets a read that started before a change land over the read after it", async () => {
    const s = slowSource("a")
    const store = legacyStore(s.source, "")
    store.subscribe(() => {})
    s.write("b")
    await s.resolve("newest")
    expect(store.get()).toEqual({ loaded: true, value: "b" })
  })

  it("keeps a change made between the read and the subscribe", async () => {
    let value = "a"
    const changes = memoryStore(0)
    const store = legacyStore(
      {
        // The change lands while the first read is in flight, after it read the old value.
        read: async () => {
          const seen = value
          if (seen === "a") {
            value = "b"
            changes.update((n) => n + 1)
          }
          return seen
        },
        subscribe: (onChange) => changes.subscribe(onChange),
      },
      "",
    )
    store.subscribe(() => {})
    await settle()
    expect(store.get()).toEqual({ loaded: true, value: "b" })
  })

  it("reads a value written before the first subscriber, and again after a gap", async () => {
    const s = slowSource("a")
    const store = legacyStore(s.source, "")
    s.write("late")
    expect(store.get()).toEqual({ loaded: false, value: "" })
    const off = store.subscribe(() => {})
    await s.resolve()
    expect(store.get().value).toBe("late")
    off()
    s.write("unwatched")
    store.subscribe(() => {})
    await s.resolve()
    expect(store.get().value).toBe("unwatched")
  })

  it("re-reads on every change while watched", async () => {
    const s = slowSource("a")
    const store = legacyStore(s.source, "")
    const seen: string[] = []
    store.subscribe(() => seen.push(store.get().value))
    await s.resolve()
    s.write("b")
    await s.resolve()
    expect(seen).toEqual(["a", "b"])
  })
})

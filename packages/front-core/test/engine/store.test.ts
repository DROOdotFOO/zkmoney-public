// @vitest-environment node
import { describe, expect, it } from "vitest"
import { batch, memoryStore, derived } from "../../src/engine/store"

function counter(subscribe: (listener: () => void) => () => void) {
  let calls = 0
  const off = subscribe(() => calls++)
  return { calls: () => calls, off }
}

describe("memoryStore", () => {
  it("notifies on a new value only", () => {
    const store = memoryStore({ n: 1 })
    const seen = counter(store.subscribe)
    const same = store.get()
    store.set(same)
    expect(seen.calls()).toBe(0)
    store.update((s) => ({ n: s.n + 1 }))
    expect(store.get()).toEqual({ n: 2 })
    expect(seen.calls()).toBe(1)
    seen.off()
    store.set({ n: 3 })
    expect(seen.calls()).toBe(1)
  })

  it("hands out a view that cannot write", () => {
    const store = memoryStore(0)
    expect(Object.keys(store.readonly).sort()).toEqual(["get", "subscribe"])
    store.set(5)
    expect(store.readonly.get()).toBe(5)
  })

  it("notifies once per batch, after the outermost batch ends", () => {
    const a = memoryStore(0)
    const b = memoryStore(0)
    const seenA = counter(a.subscribe)
    const seenB = counter(b.subscribe)
    batch(() => {
      a.set(1)
      a.set(2)
      batch(() => b.set(1))
      expect(seenB.calls()).toBe(0)
    })
    expect([seenA.calls(), seenB.calls()]).toEqual([1, 1])
    expect([a.get(), b.get()]).toEqual([2, 1])
  })
})

describe("derived", () => {
  const setup = () => {
    const txs = memoryStore<{ amount: bigint; pending: boolean }[]>([])
    const balance = memoryStore(100n)
    let computes = 0
    const home = derived(
      [txs, balance],
      (list, held) => {
        computes++
        const arriving = list.filter((t) => t.pending).reduce((sum, t) => sum + t.amount, 0n)
        return { balance: held, arriving }
      },
      (x, y) => x.balance === y.balance && x.arriving === y.arriving,
    )
    return { txs, balance, home, computes: () => computes }
  }

  it("recomputes once when a batch changes several sources", () => {
    const { txs, balance, home, computes } = setup()
    const seen = counter(home.subscribe)
    const before = computes()
    batch(() => {
      txs.set([{ amount: 5n, pending: true }])
      balance.set(95n)
    })
    expect(computes() - before).toBe(1)
    expect(seen.calls()).toBe(1)
    expect(home.get()).toEqual({ balance: 95n, arriving: 5n })
  })

  it("keeps its reference when the result is equal", () => {
    const { txs, home } = setup()
    const seen = counter(home.subscribe)
    const first = home.get()
    txs.set([{ amount: 5n, pending: false }])
    expect(home.get()).toBe(first)
    expect(seen.calls()).toBe(0)
  })

  it("reads current values without subscribers, computing only when an input changed", () => {
    const { balance, home, computes } = setup()
    home.get()
    home.get()
    expect(computes()).toBe(1)
    balance.set(7n)
    expect(home.get().balance).toBe(7n)
    expect(computes()).toBe(2)
  })

  it("stops listening to its sources when its last subscriber leaves", () => {
    const { balance, home, computes } = setup()
    const seen = counter(home.subscribe)
    seen.off()
    const before = computes()
    balance.set(1n)
    expect(computes()).toBe(before)
  })

  it("notifies subscribers even when a read inside the batch already saw the change", () => {
    const { balance, home } = setup()
    const seen = counter(home.subscribe)
    batch(() => {
      balance.set(1n)
      expect(home.get().balance).toBe(1n)
    })
    expect(seen.calls()).toBe(1)
  })

  it("chains: a store derived from a derived store updates once per batch", () => {
    const { txs, balance, home } = setup()
    const total = derived([home], (h) => h.balance + h.arriving)
    const seen = counter(total.subscribe)
    batch(() => {
      txs.set([{ amount: 5n, pending: true }])
      balance.set(1n)
    })
    expect(total.get()).toBe(6n)
    expect(seen.calls()).toBe(1)
  })
})

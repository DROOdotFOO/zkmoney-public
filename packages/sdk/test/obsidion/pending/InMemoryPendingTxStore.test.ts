import { describe, expect, it } from "vitest"

import {
  InMemoryPendingTxStore,
  type PendingTxRecord,
} from "../../../src/obsidion/pending/index.js"

const HOUR_MS = 60 * 60 * 1000

const sample = (overrides: Partial<PendingTxRecord> = {}): PendingTxRecord => ({
  txHash: overrides.txHash ?? "0xabc123",
  expiresAtMs: overrides.expiresAtMs ?? Date.now() + HOUR_MS,
  submittedAt: overrides.submittedAt ?? Date.now(),
})

describe("InMemoryPendingTxStore", () => {
  it("create + get round-trips a record", async () => {
    const store = new InMemoryPendingTxStore()
    const record = sample({ txHash: "0xtx-1" })
    await store.create(record)
    const got = await store.get("0xtx-1")
    expect(got).toBeDefined()
    expect(got?.txHash).toBe("0xtx-1")
  })

  it("get returns undefined for missing records", async () => {
    const store = new InMemoryPendingTxStore()
    expect(await store.get("0xnope")).toBeUndefined()
  })

  it("list returns only non-expired records", async () => {
    const store = new InMemoryPendingTxStore()
    const fresh = sample({ txHash: "0xfresh", expiresAtMs: Date.now() + HOUR_MS })
    const expired = sample({ txHash: "0xexpired", expiresAtMs: Date.now() - HOUR_MS })
    await store.create(fresh)
    await store.create(expired)
    const live = await store.list()
    expect(live.map((r) => r.txHash)).toEqual(["0xfresh"])
  })

  it("listExpired returns only expired records", async () => {
    const store = new InMemoryPendingTxStore()
    const fresh = sample({ txHash: "0xfresh", expiresAtMs: Date.now() + HOUR_MS })
    const expired = sample({ txHash: "0xexpired", expiresAtMs: Date.now() - HOUR_MS })
    await store.create(fresh)
    await store.create(expired)
    const dead = await store.listExpired()
    expect(dead.map((r) => r.txHash)).toEqual(["0xexpired"])
  })

  it("get returns undefined for an expired record (passive eviction)", async () => {
    const store = new InMemoryPendingTxStore()
    const expired = sample({ txHash: "0xexpired", expiresAtMs: Date.now() - HOUR_MS })
    await store.create(expired)
    expect(await store.get("0xexpired")).toBeUndefined()
  })

  it("patch updates fields and returns true on hit", async () => {
    const store = new InMemoryPendingTxStore()
    await store.create(sample({ txHash: "0xtx-1" }))
    const later = Date.now() + 2 * HOUR_MS
    const ok = await store.patch("0xtx-1", { expiresAtMs: later })
    expect(ok).toBe(true)
    const got = await store.get("0xtx-1")
    expect(got?.expiresAtMs).toBe(later)
  })

  it("patch returns false when target record is absent", async () => {
    const store = new InMemoryPendingTxStore()
    expect(await store.patch("0xnope", { expiresAtMs: Date.now() })).toBe(false)
  })

  it("remove deletes the record and fires onUpdated once", async () => {
    const store = new InMemoryPendingTxStore()
    const seen: string[] = []
    store.onUpdated((h) => seen.push(h))
    await store.create(sample({ txHash: "0xtx-1" }))
    await store.remove("0xtx-1")
    expect(await store.get("0xtx-1")).toBeUndefined()
    // create + remove → 2 events
    expect(seen).toEqual(["0xtx-1", "0xtx-1"])
  })

  it("remove on a missing tx hash is a silent no-op (no listener fired)", async () => {
    const store = new InMemoryPendingTxStore()
    const seen: string[] = []
    store.onUpdated((h) => seen.push(h))
    await store.remove("0xnope")
    expect(seen).toEqual([])
  })

  it("onUpdated unsubscribe stops further notifications", async () => {
    const store = new InMemoryPendingTxStore()
    const seen: string[] = []
    const unsub = store.onUpdated((h) => seen.push(h))
    await store.create(sample({ txHash: "0xtx-1" }))
    unsub()
    await store.create(sample({ txHash: "0xtx-2" }))
    expect(seen).toEqual(["0xtx-1"])
  })

  it("listener errors are swallowed and do not break notifications", async () => {
    const store = new InMemoryPendingTxStore()
    let secondCalled = false
    store.onUpdated(() => {
      throw new Error("bad subscriber")
    })
    store.onUpdated(() => {
      secondCalled = true
    })
    // Suppress the warning during the test
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await store.create(sample({ txHash: "0xtx-1" }))
    } finally {
      console.warn = origWarn
    }
    expect(secondCalled).toBe(true)
  })

  it("removeExpired deletes the record and fires onUpdated", async () => {
    const store = new InMemoryPendingTxStore()
    const seen: string[] = []
    store.onUpdated((h) => seen.push(h))
    const record = sample({ txHash: "0xtx-1", expiresAtMs: Date.now() - HOUR_MS })
    await store.create(record)
    await store.removeExpired("0xtx-1")
    // Listener fires for create + removeExpired
    expect(seen).toEqual(["0xtx-1", "0xtx-1"])
    // Both list and listExpired return empty afterward
    expect(await store.list()).toEqual([])
    expect(await store.listExpired()).toEqual([])
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import {
  PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY,
  PreviousAccountWatchStore,
  PreviousAccountWatchUnreadableError,
  type PreviousAccountMove,
  type PreviousAccountWatch,
} from "../../src/index.js"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const ADDRESS = `0x${"aB".repeat(32)}`
const KEY = ADDRESS.toLowerCase()
const MOVE: PreviousAccountMove = {
  source: ADDRESS,
  destination: `0x${"22".repeat(32)}`,
  txHash: `0x${"33".repeat(32)}`,
  expiresAtMs: 5_000,
  amount: "700",
}
const watch = (over: Partial<PreviousAccountWatch> = {}): PreviousAccountWatch => ({
  address: ADDRESS,
  watchUntilMs: 1_000,
  ...over,
})
const blob = (value: unknown) => JSON.stringify({ [KEY]: value })

class FlakyStorage extends InMemoryStorageAdapter {
  unreadable = false
  refuseWrites = false
  override async getItem(key: string): Promise<string | null> {
    if (this.unreadable) throw new Error("locked")
    return super.getItem(key)
  }
  override async setItem(key: string, value: string): Promise<void> {
    if (this.refuseWrites) throw new Error("disk full")
    return super.setItem(key, value)
  }
}

describe("PreviousAccountWatchStore", () => {
  beforeEach(() => PreviousAccountWatchStore.resetForTests())

  it("needs a storage adapter on its first use, and is one store after", () => {
    expect(() => PreviousAccountWatchStore.get()).toThrow("requires a storage adapter")
    const store = PreviousAccountWatchStore.get(new InMemoryStorageAdapter())
    expect(PreviousAccountWatchStore.get()).toBe(store)
  })

  it("writes a watch and reads it back by its address in any case", async () => {
    const store = PreviousAccountWatchStore.get(new InMemoryStorageAdapter())
    expect(await store.get(ADDRESS)).toBeNull()
    expect(await store.update(KEY, () => watch())).toEqual(watch())
    expect(await store.get(ADDRESS.toUpperCase().replace("0X", "0x"))).toEqual(watch())
  })

  it("reads every field back after a reload", async () => {
    const storage = new InMemoryStorageAdapter()
    const full = watch({ closed: true, closedAtMs: 800, lastCheckAtMs: 900, move: MOVE })
    await PreviousAccountWatchStore.get(storage).update(ADDRESS, () => full)
    PreviousAccountWatchStore.resetForTests()
    expect(await PreviousAccountWatchStore.get(storage).get(ADDRESS)).toEqual(full)
    expect(JSON.parse((await storage.getItem(PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY))!)).toEqual({
      [KEY]: full,
    })
  })

  it("writes and clears the chunk in flight over what it holds", async () => {
    const store = PreviousAccountWatchStore.get(new InMemoryStorageAdapter())
    await store.update(ADDRESS, () => watch())
    await store.update(ADDRESS, (current) => current && { ...current, move: MOVE })
    expect((await store.get(ADDRESS))?.move).toEqual(MOVE)
    await store.update(ADDRESS, (current) => {
      if (!current) return null
      const { move: _, ...rest } = current
      return rest
    })
    expect(await store.get(ADDRESS)).toEqual(watch())
  })

  it("leaves the record when the change returns null", async () => {
    const store = PreviousAccountWatchStore.get(new InMemoryStorageAdapter())
    await store.update(ADDRESS, () => watch())
    expect(await store.update(ADDRESS, () => null)).toEqual(watch())
    expect(await store.update(`0x${"99".repeat(32)}`, () => null)).toBeNull()
  })

  it("lands two updates made at once", async () => {
    const store = PreviousAccountWatchStore.get(new InMemoryStorageAdapter())
    await store.update(ADDRESS, () => watch())
    await Promise.all([
      store.update(ADDRESS, (current) => current && { ...current, move: MOVE }),
      store.update(ADDRESS, (current) => current && { ...current, watchUntilMs: 2_000 }),
    ])
    expect(await store.get(ADDRESS)).toEqual(watch({ move: MOVE, watchUntilMs: 2_000 }))
  })

  it("rejects a write storage refuses, and keeps nothing of it", async () => {
    const storage = new FlakyStorage()
    const store = PreviousAccountWatchStore.get(storage)
    await store.update(ADDRESS, () => watch())
    storage.refuseWrites = true
    await expect(
      store.update(ADDRESS, (current) => current && { ...current, move: MOVE }),
    ).rejects.toThrow("disk full")
    expect(await store.get(ADDRESS)).toEqual(watch())
  })

  it("fails closed while storage cannot be read, and retries the read", async () => {
    const storage = new FlakyStorage()
    await PreviousAccountWatchStore.get(storage).update(ADDRESS, () => watch({ move: MOVE }))
    PreviousAccountWatchStore.resetForTests()
    storage.unreadable = true
    const store = PreviousAccountWatchStore.get(storage)
    await expect(store.get(ADDRESS)).rejects.toThrow(PreviousAccountWatchUnreadableError)
    await expect(store.update(ADDRESS, () => watch())).rejects.toThrow(
      PreviousAccountWatchUnreadableError,
    )
    storage.unreadable = false
    expect(await store.get(ADDRESS)).toEqual(watch({ move: MOVE }))
  })

  it("fails closed over saved text that does not parse or holds a value of the wrong shape", async () => {
    for (const text of [
      "",
      "[]",
      '{"0x11": {"address": "0x',
      blob(null),
      blob({ address: 5, watchUntilMs: 1 }),
      JSON.stringify({ "0x99": watch() }),
      blob({ ...watch(), watchUntilMs: "1000" }),
      blob({ ...watch(), closed: false }),
      blob({ ...watch(), closedAtMs: "soon" }),
      blob({ ...watch(), lastCheckAtMs: "soon" }),
      blob({ ...watch(), move: { ...MOVE, txHash: "0x33" } }),
      blob({ ...watch(), move: { ...MOVE, amount: "7.5" } }),
      blob({ ...watch(), move: { ...MOVE, expiresAtMs: undefined } }),
      blob({ ...watch(), move: { ...MOVE, destination: undefined } }),
    ]) {
      PreviousAccountWatchStore.resetForTests()
      const storage = new InMemoryStorageAdapter()
      await storage.setItem(PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY, text)
      const store = PreviousAccountWatchStore.get(storage)
      await expect(store.get(ADDRESS)).rejects.toThrow(PreviousAccountWatchUnreadableError)
      await expect(store.update(ADDRESS, () => watch())).rejects.toThrow(
        PreviousAccountWatchUnreadableError,
      )
      expect(await storage.getItem(PREVIOUS_ACCOUNT_WATCH_STORAGE_KEY)).toBe(text)
    }
  })
})

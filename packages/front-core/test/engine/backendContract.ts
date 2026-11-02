// The cases every `DatabaseBackend` passes: memoryBackend here, opfsBackend in web-wallet and the
// bot's file backend in xmtp-bot. Only `vitest` and engine types are imported, so other packages
// run it.
import { describe, expect, it } from "vitest"
import type { DatabaseBackend, Op } from "../../src/engine/database"

export function backendContract(
  name: string,
  open: () => DatabaseBackend | Promise<DatabaseBackend>,
  opts: {
    /** A fresh backend over what the last one saved. */
    reopen?: () => DatabaseBackend | Promise<DatabaseBackend>
    /** While on, every commit fails. */
    failing?: (on: boolean) => void | Promise<void>
  } = {},
): void {
  const { reopen, failing } = opts
  const seeded = async (keys: readonly string[]) => {
    const backend = await open()
    await backend.apply(keys.map((key): Op => [key, `v:${key}`]))
    return backend
  }
  const keysOf = (entries: [string, string][]) => entries.map(([key]) => key)

  describe(`DatabaseBackend contract: ${name}`, () => {
    it("orders keys by their characters, whatever the write order", async () => {
      const keys = ["b", "a/1", "a0", "a", "a.i/x/1", "a/", "A", "a/10", "a/2", "~"]
      const backend = await seeded(keys)
      const all = await backend.range("")
      expect(all).toEqual(
        ["A", "a", "a.i/x/1", "a/", "a/1", "a/10", "a/2", "a0", "b", "~"].map((key) => [
          key,
          `v:${key}`,
        ]),
      )
    })

    it("ranges over one prefix only, the key equal to it included", async () => {
      const backend = await seeded(["s", "s.i/1", "s/", "s/a", "s/b", "s0", "r/a", "t"])
      expect(keysOf(await backend.range("s/"))).toEqual(["s/", "s/a", "s/b"])
      expect(keysOf(await backend.range("s/", { reverse: true }))).toEqual(["s/b", "s/a", "s/"])
      expect(keysOf(await backend.range("s/", { reverse: true, limit: 3 }))).toEqual([
        "s/b",
        "s/a",
        "s/",
      ])
      expect(await backend.range("q/")).toEqual([])
    })

    it("excludes both bounds, going either way", async () => {
      const keys = ["p/1", "p/2", "p/3", "p/4", "p/5"]
      const backend = await seeded(keys)
      const bounded = { after: "p/2", before: "p/5" }
      expect(keysOf(await backend.range("p/", bounded))).toEqual(["p/3", "p/4"])
      expect(keysOf(await backend.range("p/", { ...bounded, reverse: true }))).toEqual([
        "p/4",
        "p/3",
      ])
      // Bounds between keys, and bounds outside the prefix.
      expect(keysOf(await backend.range("p/", { after: "p/2x", before: "p/4x" }))).toEqual([
        "p/3",
        "p/4",
      ])
      expect(keysOf(await backend.range("p/", { after: "a", before: "z" }))).toEqual(keys)
      expect(keysOf(await backend.range("p/", { after: "p/5" }))).toEqual([])
      expect(keysOf(await backend.range("p/", { before: "p/1", reverse: true }))).toEqual([])
    })

    it("stops at the limit, counting from the start of the direction", async () => {
      const backend = await seeded(["w/1", "w/2", "w/3", "w/4", "w/5", "x/1"])
      expect(keysOf(await backend.range("w/", { limit: 2 }))).toEqual(["w/1", "w/2"])
      expect(keysOf(await backend.range("w/", { limit: 2, reverse: true }))).toEqual(["w/5", "w/4"])
      expect(keysOf(await backend.range("w/", { after: "w/1", limit: 2 }))).toEqual(["w/2", "w/3"])
      expect(keysOf(await backend.range("w/", { before: "w/5", limit: 2, reverse: true }))).toEqual(
        ["w/4", "w/3"],
      )
      expect(keysOf(await backend.range("w/", { limit: 10 }))).toHaveLength(5)
      expect(await backend.range("w/", { limit: 0 })).toEqual([])
    })

    it("reads many keys in the order asked, missing ones undefined", async () => {
      const backend = await seeded(["m/a", "m/b"])
      expect(await backend.getMany(["m/b", "m/x", "m/a", "m/b"])).toEqual([
        "v:m/b",
        undefined,
        "v:m/a",
        "v:m/b",
      ])
      expect(await backend.getMany([])).toEqual([])
      expect(await backend.get("m/a")).toBe("v:m/a")
      expect(await backend.get("m/x")).toBeUndefined()
    })

    it("applies writes and removals together, the last write to a key winning", async () => {
      const backend = await seeded(["k/gone", "k/kept"])
      await backend.apply([
        ["k/gone", null],
        ["k/new", "1"],
        ["k/new", "2"],
        ["k/kept", "3"],
      ])
      expect(await backend.range("k/")).toEqual([
        ["k/kept", "3"],
        ["k/new", "2"],
      ])
      await backend.apply([])
      expect(await backend.get("k/new")).toBe("2")
    })

    if (failing) {
      it("keeps nothing of a failed commit", async () => {
        const backend = await seeded(["f/a"])
        await failing(true)
        try {
          await expect(
            backend.apply([
              ["f/a", null],
              ["f/b", "1"],
            ]),
          ).rejects.toThrow()
        } finally {
          await failing(false)
        }
        expect(await backend.range("f/")).toEqual([["f/a", "v:f/a"]])
      })
    }

    if (reopen) {
      it("reads back what it saved after a reopen", async () => {
        const backend = await seeded(["r/a", "r/b"])
        await backend.apply([["r/a", null]])
        const again = await reopen()
        expect(await again.range("r/")).toEqual([["r/b", "v:r/b"]])
        expect(await again.getMany(["r/a", "r/b"])).toEqual([undefined, "v:r/b"])
      })
    }
  })
}

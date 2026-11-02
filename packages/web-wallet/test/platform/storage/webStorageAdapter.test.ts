import { beforeEach, describe, expect, it } from "vitest"
import {
  PASSKEY_IDENTITY_MAP_KEY,
  WEB_STORAGE_PREFIX,
  WebStorageAdapter,
  holdsAccountRecords,
} from "../../../src/platform/storage/WebStorageAdapter"
import { opfsBackend, walletStorage } from "../../../src/platform/storage/walletStorage"
import { clearActiveStorage, setActiveStorageId } from "../../../src/platform/storage/activeStorage"
import { testWalletDbs } from "../../support/fakeWalletDb"

/** The namespace moves once the pointer is saved. */
const bind = async (storageId: string | null) => {
  if (storageId) setActiveStorageId(storageId)
  else clearActiveStorage()
  await walletStorage.flush()
}

describe("WebStorageAdapter", () => {
  const adapter = new WebStorageAdapter()

  // Tests run as an entered account; the global-key and no-account cases bind their own session.
  beforeEach(async () => {
    localStorage.clear()
    await bind("t")
  })

  it("removes and clears", async () => {
    await adapter.setItem("a", "1")
    await adapter.setItem("b", "2")
    await adapter.removeItem("a")
    expect(await adapter.getItem("a")).toBeNull()
    expect(await adapter.getItem("b")).toBe("2")
    await adapter.clear()
    expect(await adapter.getItem("b")).toBeNull()
  })

  it("clear() removes a store record whose write was queued before it", async () => {
    await bind("ab12")
    const key = `${WEB_STORAGE_PREFIX}ab12.acct/requests/r1`
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    testWalletDbs().onApply = async (_version, ops) => {
      if (ops.some(([k, value]) => k === key && value !== null)) await landed
    }
    const written = opfsBackend.apply([[key, "{}"]])
    const cleared = adapter.clear()
    // The clear has listed what it can before the write lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    land()
    await Promise.all([written, cleared])
    expect(await opfsBackend.get(key)).toBeUndefined()
  })

  it("namespaces its keys and clear() leaves foreign keys alone", async () => {
    await adapter.setItem("mine", "1")
    walletStorage.setItem("webwallet.identity", "keep")
    expect(walletStorage.getItem(`${WEB_STORAGE_PREFIX}t.mine`)).toBe("1")
    await adapter.clear()
    expect(await adapter.getItem("mine")).toBeNull()
    expect(walletStorage.getItem("webwallet.identity")).toBe("keep")
  })

  it("keeps each account's keys apart and global keys shared", async () => {
    await bind("aaa")
    await adapter.setItem("obsidion_contacts", "A")
    await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
    await adapter.setItem("obsidion_config:analyticsAsked", "true")
    await bind("bbb")
    expect(await adapter.getItem("obsidion_contacts")).toBeNull()
    expect(await adapter.getItem(PASSKEY_IDENTITY_MAP_KEY)).toBe("shared")
    expect(await adapter.getItem("obsidion_config:analyticsAsked")).toBe("true")
    await adapter.setItem("obsidion_contacts", "B")
    await adapter.clear()
    await bind("aaa")
    expect(await adapter.getItem("obsidion_contacts")).toBe("A")
    await bind(null)
    expect(walletStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("A")
    expect(await adapter.getItem("obsidion_contacts")).toBeNull()
  })

  it("clear() without a bound account touches nothing", async () => {
    await bind("aaa")
    await adapter.setItem("obsidion_contacts", "A")
    await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
    await bind(null)
    await adapter.clear()
    expect(walletStorage.getItem("obsidion.aaa.obsidion_contacts")).toBe("A")
    expect(await adapter.getItem(PASSKEY_IDENTITY_MAP_KEY)).toBe("shared")
  })

  it("a pointer change moves every instance at once", async () => {
    const other = new WebStorageAdapter()
    await bind("aaa")
    await adapter.setItem("k", "a")
    await bind("bbb")
    await other.setItem("k", "b")
    expect(await adapter.getItem("k")).toBe("b")
    expect(walletStorage.getItem("obsidion.aaa.k")).toBe("a")
    expect(walletStorage.getItem("obsidion.bbb.k")).toBe("b")
  })

  describe("holdsAccountRecords", () => {
    const ID = "ab".repeat(32)

    it("finds a key written under that account", async () => {
      await bind(ID)
      await adapter.setItem("obsidion_contacts", "A")
      expect(await holdsAccountRecords(ID)).toBe(true)
    })

    it("ignores another account's keys", async () => {
      await bind("cd".repeat(32))
      await adapter.setItem("obsidion_contacts", "C")
      expect(await holdsAccountRecords(ID)).toBe(false)
    })

    it("ignores shared keys and keys written with no account", async () => {
      await bind(ID)
      await adapter.setItem(PASSKEY_IDENTITY_MAP_KEY, "shared")
      await adapter.setItem("obsidion_config:analyticsAsked", "true")
      await bind(null)
      await adapter.setItem("obsidion_withdrawals", "{}")
      expect(await holdsAccountRecords(ID)).toBe(false)
    })

    it("ignores the same account's records under another rollup", async () => {
      testWalletDbs().db("other").state.set(`${WEB_STORAGE_PREFIX}${ID}.obsidion_contacts`, "A")
      expect(await holdsAccountRecords(ID)).toBe(false)
    })

    it("finds a persistent store's record under that account", async () => {
      await opfsBackend.apply([[`${WEB_STORAGE_PREFIX}${ID}.acct/requests/r1`, "{}"]])
      expect(await holdsAccountRecords(ID)).toBe(true)
    })

    it("finds a store record whose write was queued before the check", async () => {
      await bind(ID)
      let land!: () => void
      const landed = new Promise<void>((resolve) => (land = resolve))
      testWalletDbs().onApply = async () => landed
      const written = opfsBackend.apply([[`${WEB_STORAGE_PREFIX}${ID}.acct/requests/r1`, "{}"]])
      const holds = holdsAccountRecords(ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      land()
      await written
      expect(await holds).toBe(true)
    })

    it("ignores an id that only starts the same way", async () => {
      walletStorage.setItem(`${WEB_STORAGE_PREFIX}${ID}0.obsidion_contacts`, "A")
      expect(await holdsAccountRecords(ID)).toBe(false)
    })
  })
})

describe("WebStorageAdapter durability", () => {
  it("rolls a strict record store back when the database refuses its write", async () => {
    const { RecordStorage } = await import("@obsidion/front-core")
    const records = new RecordStorage<{ id: string; v: number }>({
      storage: new WebStorageAdapter(),
      storageKey: "records",
      keyOf: (r) => r.id,
      strict: true,
    })
    await records.load()
    await records.setRecord("a", { id: "a", v: 1 })
    testWalletDbs().onApply = () => {
      throw new Error("disk")
    }
    await expect(records.setRecord("a", { id: "a", v: 2 })).rejects.toThrow("disk")
    testWalletDbs().onApply = undefined
    expect(records.getByKey("a")).toEqual({ id: "a", v: 1 })
  })

  it("keeps every account's owed broadcasts when the account switches under a loaded ledger", async () => {
    const { BroadcastLedger } = await import("@obsidion/front-core")
    const job = (n: number, scope: string) => ({
      address: `0x${n.toString(16).padStart(40, "0")}`,
      kind: "deposit" as const,
      scope,
      source: { type: "slot" as const, cacheKey: "k", day: 1, nonce: n },
    })
    await bind("bbb")
    await new BroadcastLedger(new WebStorageAdapter()).enqueue(job(1, "bbb"))
    await bind("aaa")
    const ledger = new BroadcastLedger(new WebStorageAdapter())
    await ledger.enqueue(job(2, "aaa"))
    await bind("bbb")
    await ledger.enqueue(job(3, "bbb"))

    const reloaded = new BroadcastLedger(new WebStorageAdapter())
    await reloaded.load()
    const saved = reloaded.list().map((j) => [j.address.slice(-1), j.scope])
    expect(saved.sort()).toEqual([
      ["1", "bbb"],
      ["2", "aaa"],
      ["3", "bbb"],
    ])
  })
})

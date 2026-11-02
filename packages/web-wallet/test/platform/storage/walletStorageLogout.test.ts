import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { signOut } from "../../../src/features/identity/signOut"
import { setActiveRollup } from "../../../src/platform/storage/rollupStorage"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"

const dbs = testWalletDbs()
const TUPLE = ["webwallet.storageId", "webwallet.credentialId", "webwallet.msk"] as const

function seedSession(state: Map<string, string>) {
  state.set("webwallet.storageId", "s")
  state.set("webwallet.credentialId", "c")
  state.set("webwallet.msk", "k")
  state.set("obsidion.s.contacts", "[1]")
}

const hasTuple = (state: Map<string, string>) => TUPLE.some((key) => state.has(key))

beforeEach(async () => {
  await closeWalletStore()
  seedSession(dbs.db("7").state)
  seedSession(dbs.db("8").state)
  seedSession(dbs.db("9").state)
  setActiveRollup("9")
  await openWalletStore("9", { persistent: true })
})

afterEach(() => {
  localStorage.clear()
  setActiveRollup(sandboxProfile().shared.rollupVersion)
})

describe("signOut across rollups", () => {
  it("clears the session from every rollup's database and from older builds' localStorage", async () => {
    // An older-build tab's late writes, beside keys that are not old wallet state.
    for (const key of ["webwallet.msk", "rollup.9.webwallet.msk", "rollup.7.webwallet.msk"]) {
      localStorage.setItem(key, "late")
    }
    const kept = { "zkm_bid": "device", "rollup.analytics.setting": "third-party" }
    for (const [key, value] of Object.entries(kept)) localStorage.setItem(key, value)
    await signOut()
    for (const version of ["7", "8", "9"]) expect(hasTuple(dbs.db(version).state)).toBe(false)
    expect(dbs.db("7").state.get("obsidion.s.contacts")).toBe("[1]")
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual(kept)
    expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    expect(dbs.db("7").held).toBe(false)
  })

  it("fails and keeps this rollup's session when an old localStorage key cannot be removed", async () => {
    localStorage.setItem("webwallet.msk", "late")
    const remove = Storage.prototype.removeItem
    const refuse = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key) {
        if (key === "webwallet.msk") throw new Error("SecurityError")
        remove.call(this, key)
      })
    await expect(signOut()).rejects.toThrow("SecurityError")
    expect(walletStorage.getItem("webwallet.msk")).toBe("k")
    refuse.mockRestore()
    await signOut()
    expect(localStorage.getItem("webwallet.msk")).toBeNull()
    expect(walletStorage.getItem("webwallet.msk")).toBeNull()
  })

  it("is not held up by an old key outside the session it cannot remove", async () => {
    localStorage.setItem("wagmi.store", "{}")
    const remove = Storage.prototype.removeItem
    const refuse = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key) {
        if (key === "wagmi.store") throw new Error("SecurityError")
        remove.call(this, key)
      })
    try {
      await signOut()
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      refuse.mockRestore()
    }
  })

  it("removes nothing anywhere when a rollup's database cannot open", async () => {
    const tab7 = await dbs.open("7", true)
    try {
      await expect(signOut()).rejects.toMatchObject({ name: "SqlitePoolBusyError" })
      for (const version of ["7", "8", "9"]) expect(hasTuple(dbs.db(version).state)).toBe(true)
      expect(walletStorage.getItem("webwallet.msk")).toBe("k")
      expect(dbs.db("8").held).toBe(false)
    } finally {
      await tab7.close()
    }
  })

  it("keeps the removals already made when a later one fails, and a retry finishes", async () => {
    dbs.onApply = (version) => {
      if (version === "8") throw new Error("disk")
    }
    await expect(signOut()).rejects.toThrow("disk")
    const cleared = ["7", "8"].filter((version) => !hasTuple(dbs.db(version).state))
    expect(cleared).toHaveLength(1)
    expect(hasTuple(dbs.db("9").state)).toBe(true)
    dbs.onApply = undefined
    await signOut()
    for (const version of ["7", "8", "9"]) expect(hasTuple(dbs.db(version).state)).toBe(false)
  })

  it("never touches real databases or localStorage from an in-memory store", async () => {
    await closeWalletStore()
    await openWalletStore("9", { persistent: false })
    localStorage.setItem("rollup.7.webwallet.msk", "k7")
    await signOut()
    expect(hasTuple(dbs.db("7").state)).toBe(true)
    expect(localStorage.getItem("rollup.7.webwallet.msk")).toBe("k7")
  })
})

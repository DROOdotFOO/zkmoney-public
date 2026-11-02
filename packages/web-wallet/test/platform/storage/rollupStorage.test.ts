import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PASSKEY_ENVIRONMENT_KEY } from "../../../src/platform/auth/passkeyEnvironmentKey"
import {
  __resetActiveRollupForTests,
  DEVICE_KEYS,
  deviceStorage,
  removeOldWalletKeys,
  rollupKey,
  rollupStorage,
  setActiveRollup,
} from "../../../src/platform/storage/rollupStorage"
import { closeWalletStore, walletStorage } from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { demoBootInput } from "../../../src/dev/demoProfile"

const FIXTURE_VERSION = sandboxProfile().shared.rollupVersion

/** What builds before the wallet database left in `localStorage`, with the active rollup at 7. */
const OLD_WALLET_KEYS = [
  "webwallet.identity",
  "webwallet.storageId",
  "webwallet.msk",
  "obsidion.aaa.obsidion_contacts",
  "obsidion.obsidion_web_passkey_identity_map",
  "obsidion-google-callback:abc",
  "rollup.7.webwallet.msk",
  "rollup.7.obsidion.sid.@obsidion/pending-registration/records",
  "rollup.8.webwallet.storageId",
  "rollup.8.obsidion-google-callback-alive:abc",
  "zkm_wallet_imported.7",
  "wagmi.store",
]

/** What must survive: device keys, third-party keys and the active partition's relay entries. */
const KEPT_KEYS = [
  ...DEVICE_KEYS,
  "rk-recent",
  "rollup.analytics.setting",
  "rollup.7.other-library.state",
  "rollup",
  "rollup.7.obsidion-google-callback:abc",
  "rollup.7.obsidion-google-callback-alive:abc",
]

const bootInput = () => ({
  env: {
    VITE_CONFIG_PROFILE_URL: "http://localhost:8083/profiles/sandbox.json",
    VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox",
  },
  fetchImpl: (async () =>
    new Response(JSON.stringify(sandboxProfile()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
})

describe("rollupStorage", () => {
  beforeEach(() => {
    localStorage.clear()
    setActiveRollup("7")
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setActiveRollup(FIXTURE_VERSION)
  })

  it("prefixes every key with the active rollup", () => {
    rollupStorage.setItem("webwallet.identity", "v")
    expect(localStorage.getItem("rollup.7.webwallet.identity")).toBe("v")
    expect(rollupStorage.getItem("webwallet.identity")).toBe("v")
    expect(rollupStorage.keys()).toEqual(["webwallet.identity"])
    rollupStorage.removeItem("webwallet.identity")
    expect(rollupStorage.getItem("webwallet.identity")).toBeNull()
  })

  it("lists only the active partition's keys", () => {
    rollupStorage.setItem("a", "1")
    localStorage.setItem("rollup.8.b", "2")
    localStorage.setItem("c", "3")
    expect(rollupStorage.keys()).toEqual(["a"])
  })

  it("switches every call to a new partition and leaves the old one alone", () => {
    rollupStorage.setItem("k", "seven")
    setActiveRollup("8")
    expect(rollupStorage.getItem("k")).toBeNull()
    rollupStorage.setItem("k", "eight")
    expect(localStorage.getItem("rollup.7.k")).toBe("seven")
    expect(localStorage.getItem("rollup.8.k")).toBe("eight")
  })

  it("throws before the rollup is set, but not for device keys", () => {
    __resetActiveRollupForTests()
    expect(() => rollupKey("x")).toThrow(/before resolveBootConfig/)
    expect(() => rollupStorage.getItem("x")).toThrow(/before resolveBootConfig/)
    expect(() => rollupStorage.setItem("x", "1")).toThrow(/before resolveBootConfig/)
    expect(() => rollupStorage.keys()).toThrow(/before resolveBootConfig/)
    expect(() => deviceStorage.setItem("zkm_bid", "d")).not.toThrow()
    expect(localStorage.getItem("zkm_bid")).toBe("d")
  })

  it("keeps one partition across module instances", async () => {
    vi.resetModules()
    const fresh = await import("../../../src/platform/storage/rollupStorage")
    expect(fresh.rollupKey("x")).toBe("rollup.7.x")
  })

  it("returns null and no-ops without localStorage", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(rollupStorage.getItem("x")).toBeNull()
    expect(() => rollupStorage.setItem("x", "1")).not.toThrow()
    expect(() => rollupStorage.removeItem("x")).not.toThrow()
    expect(rollupStorage.keys()).toEqual([])
    expect(() => removeOldWalletKeys()).not.toThrow()
  })

  describe("deviceStorage", () => {
    it("refuses a key that is not a device key", () => {
      expect(() => deviceStorage.getItem("webwallet.identity")).toThrow(/not a device key/)
      expect(() => deviceStorage.setItem("webwallet.identity", "x")).toThrow(/not a device key/)
    })
  })

  describe("removeOldWalletKeys", () => {
    const seed = (keys: readonly string[]) => {
      for (const key of keys) localStorage.setItem(key, "v")
    }

    it("deletes every old wallet key and keeps device, third-party and live relay keys", () => {
      seed([...OLD_WALLET_KEYS, ...KEPT_KEYS])
      removeOldWalletKeys()
      expect(Object.keys(localStorage).sort()).toEqual([...KEPT_KEYS].sort())
    })

    it("keeps the keys the wallet writes outside this module", () => {
      expect(DEVICE_KEYS.has(PASSKEY_ENVIRONMENT_KEY)).toBe(true)
      for (const key of ["zkm_bid", "zkm_sid", "zkm_rid"]) expect(DEVICE_KEYS.has(key)).toBe(true)
    })

    it("with names, removes only those keys, at the top level and in every partition", () => {
      seed([...OLD_WALLET_KEYS, ...KEPT_KEYS])
      removeOldWalletKeys(["webwallet.msk", "webwallet.storageId"])
      const gone = [
        "webwallet.msk",
        "webwallet.storageId",
        "rollup.7.webwallet.msk",
        "rollup.8.webwallet.storageId",
      ]
      expect(Object.keys(localStorage).sort()).toEqual(
        [...OLD_WALLET_KEYS, ...KEPT_KEYS].filter((key) => !gone.includes(key)).sort(),
      )
    })

    it("removes the rest when one removal fails, then throws that failure", () => {
      seed(OLD_WALLET_KEYS)
      const remove = Storage.prototype.removeItem
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
        if (key === "webwallet.msk") throw new Error("SecurityError")
        remove.call(this, key)
      })
      expect(() => removeOldWalletKeys()).toThrow("SecurityError")
      expect(Object.keys(localStorage)).toEqual(["webwallet.msk"])
    })
  })

  // A boot case imports a fresh `env` so `getConfig()` starts unseeded; the partition is shared
  // across instances, so either `rollupStorage` instance reads what that boot set.
  const bootModules = async () => ({
    env: await import("../../../src/config/env"),
    storage: await import("../../../src/platform/storage/rollupStorage"),
    wallet: await import("../../../src/platform/storage/walletStorage"),
  })

  describe("boot and the wallet open", () => {
    const freshModules = async () => {
      vi.resetModules()
      await closeWalletStore()
      return bootModules()
    }

    it("sets the partition from the profile without opening the wallet database", async () => {
      const modules = await freshModules()
      localStorage.setItem("webwallet.identity", "old")
      await modules.env.resolveBootConfig(bootInput())
      expect(modules.storage.rollupKey("x")).toBe(`rollup.${FIXTURE_VERSION}.x`)
      expect(() => walletStorage.getItem("webwallet.identity")).toThrow(/wallet store is closed/)
      expect(localStorage.getItem("webwallet.identity")).toBe("old")
    })

    it("opens the wallet database without reading or removing old localStorage state", async () => {
      const { env, storage, wallet } = await freshModules()
      await env.resolveBootConfig(bootInput())
      const partitioned = storage.rollupKey("webwallet.identity")
      localStorage.setItem("webwallet.identity", "top-level")
      localStorage.setItem(partitioned, "partitioned")
      await wallet.openWalletStore(storage.activeRollup(), { persistent: true })
      expect(walletStorage.getItem("webwallet.identity")).toBeNull()
      expect(localStorage.getItem("webwallet.identity")).toBe("top-level")
      expect(localStorage.getItem(partitioned)).toBe("partitioned")
    })

    it("gives a demo boot its own partition and touches no localStorage", async () => {
      const { env, storage } = await bootModules()
      localStorage.setItem("webwallet.identity", "real")
      localStorage.setItem("rollup.7.webwallet.msk", "other")
      await env.resolveBootConfig(demoBootInput({}))
      expect(storage.rollupKey("x")).toBe("rollup.demo.x")
      expect(localStorage.getItem("webwallet.identity")).toBe("real")
      expect(localStorage.getItem("rollup.7.webwallet.msk")).toBe("other")
    })
  })
})

import { beforeEach, describe, expect, it } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { discardIncompatiblePasskeyState } from "../../../src/platform/auth/discardIncompatiblePasskeyState"
import { WebPasskeyIdentityMap, hasOpeningBreadcrumb } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { WebStorageAdapter } from "../../../src/platform/storage/WebStorageAdapter"
import {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  writeCachedMsk,
} from "../../../src/platform/storage/activeStorage"

const entry = {
  credentialId: "credential",
  pubkey: "ab".repeat(64),
  l2Address: `0x${"cd".repeat(32)}`,
  isMskRoot: true,
}
const cache = { v: 1 as const, storageId: "storage", credentialId: entry.credentialId, msk: `0x${"ef".repeat(32)}` }
const map = (rpId: string) => new WebPasskeyIdentityMap(new WebStorageAdapter(), rpId)

beforeEach(() => localStorage.clear())

describe("discarding state before account restoration", () => {
  it("clears old-RP records and active pointers", async () => {
    await map("wallet.zk.money").upsert(entry)
    setActiveStorageId(cache.storageId)
    setActiveCredentialId(entry.credentialId)
    writeCachedMsk(cache)
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: entry.l2Address }))
    await walletStorage.flush()
    await discardIncompatiblePasskeyState("auth.zk.money")
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(walletStorage.getItem("webwallet.identity")).toBeNull()
    expect(await map("wallet.zk.money").get(entry.credentialId)).toBeUndefined()
    expect(hasOpeningBreadcrumb("auth.zk.money")).toBe(false)
    await map("auth.zk.money").upsert(entry)
    expect(hasOpeningBreadcrumb("auth.zk.money")).toBe(true)
  })

  it("preserves current records and keys", async () => {
    await map("localhost").upsert(entry)
    setActiveStorageId(cache.storageId)
    setActiveCredentialId(entry.credentialId)
    writeCachedMsk(cache)
    await walletStorage.flush()
    await discardIncompatiblePasskeyState("localhost")
    expect(getActiveStorageId()).toBe(cache.storageId)
    expect(readCachedMsk()).toEqual(cache)
  })

  it.each([null, [], { bad: null }])("allows onboarding with malformed identity entries %s", async (entries) => {
    walletStorage.setItem("obsidion.obsidion_web_passkey_identity_map", JSON.stringify({ version: 1, entries }))
    await expect(discardIncompatiblePasskeyState("auth.zk.money")).resolves.toBeUndefined()
    expect(getActiveStorageId()).toBeNull()
  })

  it("drops a different session's key while preserving the valid active session", async () => {
    await map("auth.zk.money").upsert(entry)
    setActiveStorageId(cache.storageId)
    setActiveCredentialId(entry.credentialId)
    writeCachedMsk({ ...cache, credentialId: "stale" })
    await walletStorage.flush()
    await discardIncompatiblePasskeyState("auth.zk.money")
    expect(getActiveCredentialId()).toBe(entry.credentialId)
    expect(readCachedMsk()).toBeNull()
  })
})

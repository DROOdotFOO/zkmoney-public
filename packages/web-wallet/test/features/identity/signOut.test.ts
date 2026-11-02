/**
 * Signing out ends the in-memory session at the call, then removes the tuple under the session lock
 * and unbinds the tab only once the store has let it go; the wizard keeps its pointers. Every
 * user-initiated sign-out also clears the tuple out of other rollups' databases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ lockOut: vi.fn() }))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  peekAuthService: () => ({ lockOut: h.lockOut }),
}))

const { signOut } = await import("../../../src/features/identity/signOut")
const {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  withSessionLock,
  writeCachedMsk,
} = await import("../../../src/platform/storage/activeStorage")
const { closeWalletStore, openWalletStore, walletStorage } = await import(
  "../../../src/platform/storage/walletStorage"
)
const { activeRollup } = await import("../../../src/platform/storage/rollupStorage")
const { testWalletDbs } = await import("../../support/fakeWalletDb")

const cache = { v: 1 as const, storageId: "s", credentialId: "c", msk: `0x${"11".repeat(32)}` }

/** Another rollup's saved wallet state. */
const other = () => testWalletDbs().db("other").state

const seedOtherSessions = () => {
  other().set("webwallet.msk", "theirs")
  other().set("webwallet.storageId", "sid")
  other().set("webwallet.credentialId", "cred")
  other().set("webwallet.identity", "id")
}

const otherSessionsCleared = () =>
  !other().has("webwallet.msk") &&
  !other().has("webwallet.storageId") &&
  !other().has("webwallet.credentialId")

describe("signOut", () => {
  beforeEach(async () => {
    localStorage.clear()
    h.lockOut.mockClear()
    // A persistent store: only one clears other rollups' sessions.
    await closeWalletStore()
    await openWalletStore(activeRollup(), { persistent: true })
    setActiveStorageId("s")
    setActiveCredentialId("c")
    writeCachedMsk(cache)
  })

  it("ends the in-memory session at the call, then drops the cache and the pointers", async () => {
    const pending = signOut()
    // The fence is synchronous: nothing reads the key back while the lock is pending.
    expect(h.lockOut).toHaveBeenCalledTimes(1)
    await pending
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
  })

  it("clears the tuple out of every other rollup's database, and nothing else", async () => {
    seedOtherSessions()
    await signOut()
    expect(otherSessionsCleared()).toBe(true)
    expect(other().get("webwallet.identity")).toBe("id")
  })

  it("keeping the pointers keeps them; the cache still goes, here and elsewhere", async () => {
    seedOtherSessions()
    await signOut({ keepPointers: true })
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBe("s")
    expect(getActiveCredentialId()).toBe("c")
    expect(otherSessionsCleared()).toBe(true)
    expect(h.lockOut).toHaveBeenCalledTimes(1)
  })

  it("clears under the session lock, so a commit landing while it waits goes too", async () => {
    seedOtherSessions()
    let release!: () => void
    const held = withSessionLock(() => new Promise<void>((resolve) => (release = resolve)))
    const pending = signOut()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.lockOut).toHaveBeenCalledTimes(1)
    expect(other().get("webwallet.msk")).toBe("theirs")
    setActiveStorageId("s")
    setActiveCredentialId("c")
    writeCachedMsk({ ...cache, credentialId: "committed" })
    other().set("webwallet.credentialId", "committed")
    release()
    await held
    await pending
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(otherSessionsCleared()).toBe(true)
  })

  it("a local-only sign-out leaves other rollups' databases alone", async () => {
    seedOtherSessions()
    await signOut({ keepPointers: true, localOnly: true })
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBe("s")
    expect(other().get("webwallet.msk")).toBe("theirs")
  })

  it("a removal that fails keeps the whole session, and a retry finishes the job", async () => {
    await walletStorage.flush()
    let refuseOnce = true
    testWalletDbs().onApply = () => {
      if (refuseOnce) {
        refuseOnce = false
        throw new Error("blocked")
      }
    }
    await expect(signOut()).rejects.toThrow(/blocked/)
    expect(readCachedMsk()).not.toBeNull()
    expect(getActiveStorageId()).toBe("s")
    expect(getActiveCredentialId()).toBe("c")
    await signOut()
    expect(readCachedMsk()).toBeNull()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(h.lockOut).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({ stale: false, reload: vi.fn() }))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ recordsStale: () => h.stale }),
}))
import { reloadIfSessionSwitched } from "../../../src/features/onboarding/sessionReload"
import { setActiveStorageId } from "../../../src/platform/storage/activeStorage"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import {
  loadWalletIdentity,
  saveWalletIdentity,
} from "../../../src/features/identity/walletIdentity"
import { closeSession, switchSession } from "../../../src/platform/session"

const address = `0x${"ab".repeat(32)}`

describe("reloadIfSessionSwitched", () => {
  beforeEach(() => {
    localStorage.clear()
    h.stale = false
    h.reload.mockClear()
    vi.stubGlobal("window", { location: { reload: h.reload }, dispatchEvent: vi.fn() })
    vi.stubGlobal("location", { reload: h.reload })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("reloads after an account switch and clears the unrelated entered identity", async () => {
    await saveWalletIdentity({ address: "other-account", claimedAt: 1 })
    setActiveStorageId("new-account")
    await walletStorage.flush()
    expect(reloadIfSessionSwitched("old-account", address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    expect(loadWalletIdentity()).toBeNull()
  })

  it("reloads when recovery into an existing namespace left stores stale without an old pointer", async () => {
    h.stale = true
    setActiveStorageId("existing-account")
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(null, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
  })

  it("keeps a fresh or unchanged account on the current page", async () => {
    setActiveStorageId("same-account")
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(null, address)).toBe(false)
    expect(reloadIfSessionSwitched("same-account", address)).toBe(false)
    await walletStorage.flush()
    expect(h.reload).not.toHaveBeenCalled()
  })

  // Last: from here on this page has served "acct-a".
  it("reloads a passkey reuse that committed another account than the page serves", async () => {
    switchSession({ id: "acct-a", prefix: "a." })
    setActiveStorageId("acct-b")
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(null, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    closeSession()
  })

  it("reloads a sign-in after a dropped key when the page served another account", async () => {
    switchSession({ id: "acct-a", prefix: "a." })
    // The dropped key: the page falls back to the anonymous namespace.
    closeSession()
    switchSession({ id: null, prefix: "" })
    setActiveStorageId("acct-b")
    await walletStorage.flush()
    expect(reloadIfSessionSwitched(null, address)).toBe(true)
    await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1))
    closeSession()
  })
})

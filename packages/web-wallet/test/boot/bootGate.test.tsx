/**
 * The wallet mounts only after configuration, and only in the active tab: once it holds the
 * active-tab lock, has opened its databases, and has cleaned up passkey state. Any other tab mounts
 * nothing and can take over.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebBootConfig } from "../../src/config/env"
import { GOOGLE_CALLBACK_PATH } from "../../src/features/paylink/googleAuth"
import { ACTIVE_TAB_LOCK, STALLED_AFTER_MS } from "../../src/platform/storage/activeTabLifecycle"
import { activeRollup, rollupKey } from "../../src/platform/storage/rollupStorage"
import { closeWalletStore } from "../../src/platform/storage/walletStorage"
import { FakeLocks } from "../support/fakeLocks"
import { testWalletDbs } from "../support/fakeWalletDb"

const h = vi.hoisted(() => ({
  app: vi.fn(),
  store: { close: vi.fn(async () => {}) },
  createPxeStore: vi.fn(),
  nodeRollup: "",
  profileRollup: "",
  nodeDigest: undefined as string | undefined,
  readPortal: vi.fn(),
  reload: vi.fn(async () => {}),
}))
vi.mock("../../src/App", () => ({
  App: (props: unknown) => {
    h.app(props)
    return <div>Wallet ready</div>
  },
}))
vi.mock("../../src/platform/storage/createPxeStore", () => ({
  createPxeStore: h.createPxeStore,
  opfsAvailable: async () => false,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNode: () => ({
    getNodeInfo: async () => ({
      l1ChainId: 31337,
      rollupVersion: h.nodeRollup,
      l1ContractAddresses: {
        rollupAddress: { toString: () => "0xrollup" },
        inboxAddress: { toString: () => "0xinbox" },
      },
    }),
    getBlock: async () => undefined,
  }),
  readPortalChainIdentity: h.readPortal,
}))
vi.mock("../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../src/platform/storage/walletStorage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadPage: h.reload,
}))
vi.mock("../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: () => ({
    rpId: "auth.zk.money",
    nodeUrl: "http://node",
    l1RpcUrl: "http://rpc",
    l1ChainId: 31337,
    oxideProfile: { portal: "0xportal" },
    profileRollupVersion: h.profileRollup,
    nodeEndpointDigest: h.nodeDigest,
    endpoints: {
      node: { source: "default", isDefault: true },
      l1Rpc: { source: "default", isDefault: true },
      enclave: { source: "default", isDefault: true },
    },
  }),
}))

const boot = { config: { rpId: "auth.zk.money" } } as WebBootConfig
const locks = Object.getOwnPropertyDescriptor(navigator, "locks")!
let container: HTMLDivElement
let root: Root

// The first import of the wallet's module graph takes seconds; pay for it outside any one test.
beforeAll(async () => {
  await import("../../src/BootGate")
}, 60_000)

beforeEach(() => {
  // The gate keeps one lifecycle per page; each test is a new page.
  vi.resetModules()
  localStorage.clear()
  h.app.mockClear()
  h.reload.mockClear()
  h.createPxeStore.mockReset().mockResolvedValue(h.store)
  h.nodeRollup = activeRollup()
  h.profileRollup = activeRollup()
  h.nodeDigest = undefined
  // L1 names the rollup the profile does.
  h.readPortal.mockReset().mockImplementation(async () => ({
    l1ChainId: 31337,
    rollupVersion: h.profileRollup,
    rollupAddress: "0xrollup",
    inboxAddress: "0xinbox",
  }))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  history.replaceState(null, "", "/")
  Object.defineProperty(navigator, "locks", locks)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// An unmount leaves the splash waiting for page text, then fading on a timer that would outlive the
// environment. Text ends every wait at the next frame; the fade takes 200ms.
afterAll(async () => {
  const page = document.createElement("div")
  page.id = "root"
  page.textContent = "wallet"
  document.body.appendChild(page)
  await new Promise((resolve) => setTimeout(resolve, 300))
})

const stubLocks = (value: unknown) =>
  Object.defineProperty(navigator, "locks", { configurable: true, value })

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

/** How the OPFS pool refuses a database another tab holds. */
const busyError = () => Object.assign(new Error("pool is busy"), { name: "SqlitePoolBusyError" })

const CLOSE_OTHER_TAB = "The other tab hasn't released the wallet yet. Close it to continue."

/** The copy the gate imports after this test's module reset. */
const identityMap = async () =>
  (await import("../../src/platform/auth/WebPasskeyIdentityMap")).WebPasskeyIdentityMap.prototype

async function render(resolveBoot: () => Promise<WebBootConfig> = async () => boot) {
  const { BootGate } = await import("../../src/BootGate")
  await act(async () => {
    root.render(
      <React.StrictMode>
        <BootGate resolveBoot={resolveBoot} />
      </React.StrictMode>,
    )
  })
  await flush()
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) =>
    b.textContent?.includes(label),
  )

describe("BootGate", () => {
  it("opens one store under StrictMode and mounts the wallet once cleanup has written", async () => {
    stubLocks(new FakeLocks())
    let finish!: () => void
    const cleanup = vi
      .spyOn(await identityMap(), "discardOtherRps")
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    await render()
    expect(container.textContent).toContain("Loading zk.money…")
    expect(h.app).not.toHaveBeenCalled()
    await act(async () => finish())
    await flush()
    expect(container.textContent).toContain("Wallet ready")
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(h.createPxeStore).toHaveBeenCalledTimes(1)
    expect(h.createPxeStore).toHaveBeenCalledWith("0xrollup", undefined)
    expect(h.readPortal).toHaveBeenCalledTimes(1)
    expect(h.app).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeTab: expect.objectContaining({
          pxeBoot: expect.objectContaining({
            kind: "pxe",
            store: h.store,
            identity: expect.objectContaining({ rollupAddress: "0xrollup" }),
          }),
          activeSince: expect.any(Number),
        }),
      }),
    )
    const { isActiveTab } = await import("../../src/platform/storage/activeTab")
    expect(isActiveTab()).toBe(true)
  })

  it("mounts nothing while another tab is active, and takes over on request", async () => {
    const fake = new FakeLocks()
    stubLocks(fake)
    const otherTab = fake.request(ACTIVE_TAB_LOCK, {}, () => new Promise(() => {})).catch((e) => e)
    const cleanup = vi.spyOn(await identityMap(), "discardOtherRps")
    await render()
    expect(container.textContent).toContain("zk.money is open in another tab")
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()

    await act(async () => button("Use this tab")!.click())
    await flush()
    expect(await otherTab).toMatchObject({ name: "AbortError" })
    expect(container.textContent).toContain("Wallet ready")
    expect(h.createPxeStore).toHaveBeenCalledTimes(1)
  })

  it("takes an inbound name grant out of the URL while another tab is active", async () => {
    const fake = new FakeLocks()
    stubLocks(fake)
    void fake.request(ACTIVE_TAB_LOCK, {}, () => new Promise(() => {})).catch(() => {})
    history.replaceState(null, "", "/claim/alice?grant=secret&entry=passkey")
    await render()
    expect(container.textContent).toContain("zk.money is open in another tab")
    expect(location.pathname + location.search).toBe("/claim/alice?entry=passkey")
    const { nameGrantToken } = await import("../../src/features/onboarding/nameGrant")
    expect(nameGrantToken("alice")).toBe("secret")
  })

  it("closes the wallet database and retries while another tab holds the PXE store", async () => {
    stubLocks(new FakeLocks())
    await closeWalletStore()
    const events: string[] = []
    const dbs = testWalletDbs()
    const open = dbs.open.bind(dbs)
    vi.spyOn(dbs, "open").mockImplementation(async (version, persistent) => {
      const db = await open(version, persistent)
      events.push("wallet open")
      return {
        ...db,
        close: async () => {
          events.push("wallet close")
          await db.close()
        },
      }
    })
    h.createPxeStore
      .mockImplementationOnce(async () => {
        events.push("pxe busy")
        throw busyError()
      })
      .mockImplementationOnce(async () => {
        events.push("pxe open")
        return h.store
      })
    await render()
    await act(() => vi.waitFor(() => expect(events).toContain("pxe open")))
    await flush()
    expect(events).toEqual(["wallet open", "pxe busy", "wallet close", "wallet open", "pxe open"])
    expect(container.textContent).toContain("Wallet ready")
    // The identity is checked once per page, not once per open.
    expect(h.readPortal).toHaveBeenCalledTimes(1)
  })

  it("reads the chain identity while the wallet database opens", async () => {
    stubLocks(new FakeLocks())
    await closeWalletStore()
    const events: string[] = []
    const dbs = testWalletDbs()
    const open = dbs.open.bind(dbs)
    vi.spyOn(dbs, "open").mockImplementation(async (version, persistent) => {
      events.push("wallet open")
      return open(version, persistent)
    })
    const read = h.readPortal.getMockImplementation()!
    h.readPortal.mockImplementation((...args: unknown[]) => {
      events.push("l1 read")
      return read(...args)
    })
    await render()
    await act(() => vi.waitFor(() => expect(container.textContent).toContain("Wallet ready")))
    expect(events).toEqual(["l1 read", "wallet open"])
  })

  describe("old wallet keys in localStorage", () => {
    const oldKeys = () => [
      "webwallet.msk",
      `rollup.${activeRollup()}.webwallet.msk`,
      "rollup.8.webwallet.identity",
    ]
    const seed = () => {
      for (const key of oldKeys()) localStorage.setItem(key, "old")
      localStorage.setItem("zkm_bid", "device")
    }
    const present = () => oldKeys().filter((key) => localStorage.getItem(key) !== null)

    it("stay while another tab holds the PXE store, and go once this tab is active", async () => {
      stubLocks(new FakeLocks())
      seed()
      let whileBusy: string[] = []
      h.createPxeStore
        .mockImplementationOnce(async () => {
          whileBusy = present()
          throw busyError()
        })
        .mockImplementationOnce(async () => h.store)
      await render()
      await act(() => vi.waitFor(() => expect(container.textContent).toContain("Wallet ready")))
      expect(whileBusy).toEqual(oldKeys())
      expect(present()).toEqual([])
      expect(localStorage.getItem("zkm_bid")).toBe("device")
    })

    it("stay when the boot fails before the tab is ready", async () => {
      stubLocks(new FakeLocks())
      vi.spyOn(console, "error").mockImplementation(() => {})
      h.nodeRollup = `${activeRollup()}9`
      seed()
      await render()
      expect(button("Retry")).toBeDefined()
      expect(present()).toEqual(oldKeys())
    })

    it("do not stop the wallet mounting when they cannot be removed", async () => {
      stubLocks(new FakeLocks())
      vi.spyOn(console, "warn").mockImplementation(() => {})
      seed()
      const remove = Storage.prototype.removeItem
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
        if (oldKeys().includes(key)) throw new Error("SecurityError")
        remove.call(this, key)
      })
      await render()
      expect(container.textContent).toContain("Wallet ready")
    })
  })

  it("shows the splash while the PXE store is busy, then says to close the other tab", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true })
    stubLocks(new FakeLocks())
    h.createPxeStore.mockRejectedValue(busyError())
    await render()
    expect(container.textContent).toContain("Loading zk.money…")
    await act(() => vi.advanceTimersByTimeAsync(STALLED_AFTER_MS))
    expect(container.textContent).toContain("Loading zk.money…")
    expect(container.textContent).toContain(CLOSE_OTHER_TAB)
    expect(h.app).not.toHaveBeenCalled()
  })

  it("says it is switching tabs on a takeover, then to close a tab that keeps the store", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true })
    const fake = new FakeLocks()
    stubLocks(fake)
    void fake.request(ACTIVE_TAB_LOCK, {}, () => new Promise(() => {})).catch(() => {})
    h.createPxeStore.mockRejectedValue(busyError())
    await render()
    await act(async () => button("Use this tab")!.click())
    expect(container.textContent).toContain("Switching to this tab…")
    expect(container.textContent).not.toContain(CLOSE_OTHER_TAB)
    await act(() => vi.advanceTimersByTimeAsync(STALLED_AFTER_MS))
    expect(container.textContent).toContain(CLOSE_OTHER_TAB)
    expect(h.app).not.toHaveBeenCalled()
  })

  it("unmounts the wallet when another tab takes over, and reloads once its store closes", async () => {
    const fake = new FakeLocks()
    stubLocks(fake)
    await render()
    expect(container.textContent).toContain("Wallet ready")
    let closeStore!: () => void
    h.store.close.mockImplementationOnce(
      () => new Promise<void>((resolve) => (closeStore = resolve)),
    )
    void fake.request(ACTIVE_TAB_LOCK, { steal: true }, () => new Promise(() => {}))
    await flush()
    expect(container.textContent).toContain("zk.money is open in another tab")
    expect(container.textContent).not.toContain("Wallet ready")
    expect(button("Use this tab")).toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
    await act(async () => closeStore())
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it("shows a boot failure with a retry instead of the wallet", async () => {
    stubLocks(new FakeLocks())
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(await identityMap(), "discardOtherRps").mockRejectedValueOnce(
      new Error("Cannot clear incompatible state"),
    )
    await render()
    expect(container.textContent).toContain("Cannot clear incompatible state")
    expect(button("Retry")).toBeDefined()
    expect(h.store.close).toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
  })

  it("offers the reset page, without a retry, when the PXE store is damaged", async () => {
    stubLocks(new FakeLocks())
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { SqliteCorruptionError } = await import("@aztec-labs/kv-store/sqlite-opfs")
    h.createPxeStore.mockRejectedValue(
      new SqliteCorruptionError("database disk image is malformed"),
    )
    await render()
    await vi.waitFor(() => expect(button("Clear wallet data")).toBeDefined(), { timeout: 10_000 })
    expect(button("Retry")).toBeUndefined()
  }, 20_000)

  it("relays Google's OAuth callback without taking the active tab from its opener", async () => {
    const fake = new FakeLocks()
    stubLocks(fake)
    void fake.request(ACTIVE_TAB_LOCK, {}, () => new Promise(() => {})).catch(() => {})
    const request = vi.spyOn(fake, "request")
    vi.spyOn(window, "close").mockImplementation(() => {})
    history.replaceState(null, "", `${GOOGLE_CALLBACK_PATH}#state=s&id_token=t`)
    await render()
    const relayed = localStorage.getItem(rollupKey("obsidion-google-callback:s"))
    expect(JSON.parse(relayed!)).toMatchObject({ idToken: "t", state: "s" })
    expect(request).not.toHaveBeenCalled()
    expect(fake.isHeld(ACTIVE_TAB_LOCK)).toBe(true)
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
  })

  it("refuses a node L1 disagrees with before the PXE store opens, and offers the editor", async () => {
    stubLocks(new FakeLocks())
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.nodeRollup = `${activeRollup()}9`
    await render()
    const screen = container.querySelector<HTMLElement>('[data-testid="boot-error"]')
    expect(screen?.dataset.kind).toBe("mismatch")
    expect(screen?.textContent).toContain("The node at http://node is not on this rollup")
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
    // The wallet database is closed here, so the editor must open without it.
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="boot-change-endpoints"]')!.click(),
    )
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).not.toBeNull()
  })

  it("refuses a profile L1 disagrees with before the PXE store opens", async () => {
    stubLocks(new FakeLocks())
    h.profileRollup = `${activeRollup()}9`
    h.readPortal.mockResolvedValue({
      l1ChainId: 31337,
      rollupVersion: activeRollup(),
      rollupAddress: "0xrollup",
      inboxAddress: "0xinbox",
    })
    await render()
    const screen = container.querySelector<HTMLElement>('[data-testid="boot-error"]')
    expect(screen?.dataset.kind).toBe("profile-skew")
    expect(h.createPxeStore).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
  })

  it("opens a custom node's PXE store under its endpoint digest", async () => {
    stubLocks(new FakeLocks())
    h.nodeDigest = "0123456789abcdef0123456789abcdef"
    await render()
    expect(container.textContent).toContain("Wallet ready")
    expect(h.createPxeStore).toHaveBeenCalledWith("0xrollup", h.nodeDigest)
  })

  it("names a refused configuration URL and links the desktop settings page, without the wallet", async () => {
    vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", {
      l1SubmitPath: "/desktop/l1-submit",
      settingsPath: "/desktop-settings",
    })
    const { resolveBootConfig } = await import("../../src/config/env")
    const fetchImpl = vi.fn()
    const resolve = vi.fn(() =>
      resolveBootConfig({
        env: {
          VITE_NETWORK: "testnet",
          VITE_DESKTOP_BUILD: "true",
          VITE_CONFIG_PROFILE_URL: "https://cdn.zk.money/profiles/v5/current.json",
        },
        fetchImpl,
        runtime: { configProfileUrl: "https://elsewhere.example/profile.json" },
      }),
    )
    await render(resolve)
    expect(container.textContent).toContain("zk.money Desktop is refused")
    expect(container.textContent).toContain("/profiles/<generation>/<current|x.y.z>.json")
    expect(container.querySelector('a[href="/desktop-settings"]')).not.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.app).not.toHaveBeenCalled()
  })

  it("retries a configuration failure", async () => {
    stubLocks(new FakeLocks())
    const resolveBoot = vi
      .fn<() => Promise<WebBootConfig>>()
      .mockRejectedValueOnce(new Error("profile unreachable"))
      .mockResolvedValueOnce(boot)
    await render(resolveBoot)
    expect(container.textContent).toContain("profile unreachable")
    expect(h.app).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
    await flush()
    expect(resolveBoot).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Wallet ready")
  })
})

/** A tab publishes its PXE boot's outcome, and reports a failure, only while it is the active tab. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import { BootSplash, type PxeBootTarget } from "../../../src/ui/PxeBoot"
import { resetModulesAsActiveTab } from "../../support/activeTab"
import { stubProvingDevice } from "../../support/provingDevice"

const h = vi.hoisted(() => ({
  createWallet: vi.fn(),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  reloadPage: vi.fn(),
}))
vi.mock("../../../src/errors/errorModal", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showReportableError: h.showReportableError,
}))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: h.fireEvent }))
vi.mock("../../../src/platform/storage/walletStorage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reloadPage: h.reloadPage,
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ proverEnabled: false }) }))

function deferred() {
  let resolve!: (wallet: unknown) => void
  let reject!: (e: Error) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** What the boot builds: the wallet over its node. */
const WALLET = { node: {} }
const IDENTITY = {
  l1ChainId: 31337,
  rollupVersion: "1",
  rollupAddress: "0x" + "a".repeat(40),
  inboxAddress: "0x" + "b".repeat(40),
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  h.createWallet.mockReset()
  h.showReportableError.mockReset()
  h.fireEvent.mockReset()
  h.reloadPage.mockReset()
  sessionStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

/** Each mount is a new page: the boot runs once per page. */
async function mount(
  pxeBoot: PxeBootTarget = {
    kind: "pxe",
    store: {} as AztecSQLiteOPFSStore,
    identity: IDENTITY,
    bootStartedAt: 0,
    attempts: 1,
  },
) {
  await resetModulesAsActiveTab()
  const { PxeBootProvider, usePxeBoot } = await import("../../../src/ui/PxeBoot")
  const { startPageWallet } = await import("../../../src/platform/wallet")
  // The active tab starts the page wallet; a route that needs it demands it.
  if (pxeBoot.kind === "pxe") startPageWallet({} as AztecNode, pxeBoot, h.createWallet).demand()
  const { revokeTab } = await import("../../../src/platform/storage/activeTab")
  let bootError: ReturnType<typeof usePxeBoot>["bootError"]
  function Status() {
    const boot = usePxeBoot()
    bootError = boot.bootError
    return <span>{boot.bootStatus}</span>
  }
  await act(async () => {
    root.render(
      <PxeBootProvider pxeBoot={pxeBoot}>
        <Status />
      </PxeBootProvider>,
    )
  })
  return { revokeTab, status: () => container.textContent, bootError: () => bootError }
}

describe("PxeBootProvider", () => {
  it("publishes ready once the PXE boots on the identity the gate checked", async () => {
    h.createWallet.mockResolvedValue(WALLET)
    const page = await mount()
    await flush()
    expect(page.status()).toBe("ready")
    expect(h.createWallet).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ identity: IDENTITY }),
      expect.anything(),
    )
  })

  it("reports a finished boot with the device class proving depends on", async () => {
    const restore = stubProvingDevice(true, 10)
    try {
      h.createWallet.mockResolvedValue(WALLET)
      await mount()
      await flush()
      expect(h.fireEvent).toHaveBeenCalledWith("pxe_boot_completed", {
        duration_ms: expect.any(Number),
        attempts: 1,
        cross_origin_isolated: true,
        hardware_concurrency: 10,
      })
    } finally {
      restore()
    }
  })

  it("publishes and reports a boot that fails while this tab is active", async () => {
    const error = new Error("boot failed")
    h.createWallet.mockRejectedValue(error)
    const page = await mount()
    await flush()
    expect(page.status()).toBe("error")
    expect(h.showReportableError).toHaveBeenCalledWith(error, "pxe:boot", expect.anything())
    expect(h.fireEvent).toHaveBeenCalledWith(
      "pxe_boot_failed",
      expect.objectContaining({ code: "other" }),
    )
  })

  it("tells the person to reload when every start task ran out of memory", async () => {
    const oom = () => new RangeError("Out of memory")
    const error = new AggregateError([
      new AggregateError([oom(), oom()]),
      new AggregateError([oom()]),
    ])
    h.createWallet.mockRejectedValue(error)
    const { bootError } = await mount()
    await flush()
    expect(bootError()).toMatchObject({
      kind: "other",
      title: "Not enough memory",
      message:
        "The browser could not give zk.money the memory it needs. Wait a few seconds, then reload the page.",
    })
    expect(h.showReportableError).toHaveBeenCalledWith(error, "pxe:boot", {
      title: "Not enough memory",
      retry: { label: "Reload page", run: expect.any(Function) },
    })
    h.showReportableError.mock.calls[0][2].retry.run()
    expect(h.reloadPage).toHaveBeenCalled()
  })

  it("publishes ready in demo mode without booting a PXE", async () => {
    const page = await mount({ kind: "demo" })
    await flush()
    expect(page.status()).toBe("ready")
    expect(h.createWallet).not.toHaveBeenCalled()
  })

  it.each(["boots", "fails"])(
    "stays booting when another tab takes over while the PXE %s",
    async (outcome) => {
      const boot = deferred()
      h.createWallet.mockReturnValue(boot.promise)
      const page = await mount()
      page.revokeTab()
      if (outcome === "boots") boot.resolve(WALLET)
      else boot.reject(new Error("store closed"))
      await flush()
      expect(page.status()).toBe("booting")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(h.fireEvent).not.toHaveBeenCalledWith("pxe_boot_failed", expect.anything())
    },
  )

  it("reloads the page twice, then reports the third failure", async () => {
    const failed = new TypeError(
      "Failed to fetch dynamically imported module: /barretenberg-threads.js",
    )
    const error = new AggregateError([
      new AggregateError([failed, failed]),
      new AggregateError([failed]),
    ])
    h.createWallet.mockRejectedValue(error)
    for (const reloads of [1, 2]) {
      const page = await mount()
      await flush()
      expect(page.status()).toBe("booting")
      expect(h.reloadPage).toHaveBeenCalledTimes(reloads)
    }
    expect(h.fireEvent).not.toHaveBeenCalledWith("pxe_boot_failed", expect.anything())

    const page = await mount()
    await flush()
    expect(page.status()).toBe("error")
    expect(h.reloadPage).toHaveBeenCalledTimes(2)
    expect(h.showReportableError).toHaveBeenCalledOnce()
    expect(h.showReportableError).toHaveBeenCalledWith(error, "pxe:boot", expect.anything())
  })

  it("gives a boot after a successful one its own two reloads", async () => {
    const safari = new TypeError("Importing a module script failed.")
    h.createWallet.mockRejectedValueOnce(safari).mockResolvedValueOnce(WALLET)
    h.createWallet.mockRejectedValue(safari)
    for (let page = 0; page < 4; page++) {
      await mount()
      await flush()
    }
    expect(h.reloadPage).toHaveBeenCalledTimes(3)
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it.each([
    ["getItem", "error"],
    ["setItem", "error"],
    ["removeItem", "ready"],
  ] as const)(
    "publishes %s-failing session storage as %s, with no reload",
    async (method, status) => {
      const denied = vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("denied", "SecurityError")
      })
      if (status === "ready") h.createWallet.mockResolvedValue(WALLET)
      else
        h.createWallet.mockRejectedValue(
          new TypeError("error loading dynamically imported module: /a"),
        )
      const page = await mount()
      await flush()
      denied.mockRestore()
      expect(page.status()).toBe(status)
      expect(h.reloadPage).not.toHaveBeenCalled()
    },
  )
})

describe("BootSplash", () => {
  it("holds one boot screen through every hand-off and redirect", async () => {
    // The page's own root, as index.html has it.
    container.id = "root"
    let added = 0
    const observer = new MutationObserver((records) => {
      added += records.filter((r) => r.oldValue === null).length
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-booting"],
      attributeOldValue: true,
    })
    const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

    // A new key remounts, as a hand-off from one gate's splash to the next does.
    act(() => root.render(<BootSplash key="config" />))
    act(() => root.render(<BootSplash key="tab" />))
    // A redirect shows nothing for a while; the screen stays up rather than uncovering it.
    act(() => root.render(<span />))
    await wait(50)
    expect(document.body.dataset.bootLeaving).toBeUndefined()
    // Before the first screen, a shell's wait is still the boot screen.
    act(() => root.render(<BootSplash key="unlock" inShell />))
    expect(document.body.dataset.booting).toBe("full")

    act(() => root.render(<p>Home</p>))
    await wait(50)
    expect(document.body.dataset.bootLeaving).toBe("")
    await wait(250)
    expect(document.body.dataset.booting).toBeUndefined()
    expect(added).toBe(1)

    // After it, a wait inside the shell keeps the shell in view.
    act(() => root.render(<BootSplash key="rail" inShell />))
    expect(document.body.dataset.booting).toBe("shell")
    observer.disconnect()
  })

  it("takes taps only while a copy covers the wallet", () => {
    act(() => root.render(<BootSplash key="unlock" inShell />))
    expect(document.body.dataset.bootCovers).toBeUndefined()

    act(() => root.render(<BootSplash key="choice" covers />))
    expect(document.body.dataset.bootCovers).toBe("")

    act(() => root.render(<BootSplash key="rail" inShell />))
    expect(document.body.dataset.bootCovers).toBeUndefined()

    act(() => root.render(<BootSplash key="choice" covers />))
    act(() => root.render(<p>Home</p>))
    expect(document.body.dataset.bootCovers).toBeUndefined()
  })
})

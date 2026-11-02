/**
 * A signed-out visitor on a pay page sees nothing the PXE serves, so the boot waits until a screen
 * needs it. Everywhere else it starts at once.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, useNavigate, type NavigateFunction } from "react-router-dom"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetModulesAsActiveTab } from "../../support/activeTab"

vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  createWallet: vi.fn(),
  walletIdentity: null as object | null,
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: undefined }),
}))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => h.walletIdentity,
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent: vi.fn(),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ proverEnabled: false }),
}))

const pxeBoot = {
  kind: "pxe" as const,
  store: {} as AztecSQLiteOPFSStore,
  identity: { l1ChainId: 1, rollupVersion: "1", rollupAddress: "0xa", inboxAddress: "0xb" },
  bootStartedAt: 0,
  attempts: 1,
}

let container: HTMLDivElement
let root: Root
let navigate: NavigateFunction
let demand: () => void
let status: string

async function mount(path: string, { hold = false } = {}) {
  history.replaceState(null, "", path)
  await resetModulesAsActiveTab()
  const { BootDemand, PxeBootProvider, usePxeBoot } = await import("../../../src/ui/PxeBoot")
  const { BootHold } = await import("../../../src/App")
  const { startPageWallet } = await import("../../../src/platform/wallet")
  startPageWallet({} as AztecNode, pxeBoot, h.createWallet)
  function Probe() {
    const boot = usePxeBoot()
    navigate = useNavigate()
    demand = boot.demandBoot
    status = boot.bootStatus
    return null
  }
  await act(async () => {
    root.render(
      <PxeBootProvider pxeBoot={pxeBoot}>
        <BrowserRouter>
          <BootDemand />
          <Probe />
          {hold && <BootHold />}
        </BrowserRouter>
      </PxeBootProvider>,
    )
  })
  await flush()
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

beforeEach(() => {
  h.createWallet.mockReset().mockResolvedValue({ node: {} })
  h.walletIdentity = null
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("PXE boot on a pay page", () => {
  it.each([
    ["/pay/river", false, false],
    ["/pay/river#abc", false, false],
    ["/request", false, false],
    ["/pay/river", true, true],
    ["/request", true, true],
    ["/", false, true],
    ["/claim", false, true],
    ["/pay/river/extra", false, true],
  ])("at %s, wallet stored: %s, boots at once: %s", async (path, wallet, boots) => {
    h.walletIdentity = wallet ? { address: "0x1" } : null
    await mount(path)
    expect(h.createWallet).toHaveBeenCalledTimes(boots ? 1 : 0)
    expect(status).toBe(boots ? "ready" : "idle")
  })

  it("starts when the visitor leaves for another route", async () => {
    await mount("/pay/river")
    await act(async () => navigate("/enter"))
    await flush()
    expect(h.createWallet).toHaveBeenCalledTimes(1)
    expect(status).toBe("ready")
  })

  it("starts when a screen demands it", async () => {
    await mount("/pay/river")
    await act(async () => demand())
    expect(h.createWallet).toHaveBeenCalledTimes(1)
  })

  it("starts when a screen holds for it", async () => {
    await mount("/pay/river", { hold: true })
    expect(h.createWallet).toHaveBeenCalledTimes(1)
  })
})

describe("PXE boot before the active tab opens a store", () => {
  it.each(["/claim", "/pay/river"])("reads booting at %s outside the provider", async (path) => {
    history.replaceState(null, "", path)
    await resetModulesAsActiveTab()
    const { usePxeBoot } = await import("../../../src/ui/PxeBoot")
    function Probe() {
      status = usePxeBoot().bootStatus
      return null
    }
    await act(async () => root.render(<Probe />))
    expect(status).toBe("booting")
  })
})

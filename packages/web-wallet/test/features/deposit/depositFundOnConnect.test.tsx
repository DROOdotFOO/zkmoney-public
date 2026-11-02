/**
 * A funding click made while disconnected is held until the wallet picker answers. The picker only
 * reports through the account it produces, so the hold has to end with the picker: a dismissed or
 * failed attempt must not turn a wallet that connects later, on its own, into an open funding sheet.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
}))
const gateway = {
  depositAddress: vi.fn(async () => ({ address: "0xp001ed", name: "alice.oxide.eth" })),
}
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => gateway,
}))
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const tokens = singleToken(MANIFEST_TOKEN, "TEST")
  return mockLoadDepositFacts(
    importOriginal,
    () => tokens,
    async () => ({
      fee: "0.25",
      token: MANIFEST_TOKEN,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: 5166n * 10n ** 18n,
    }),
  )
})
const bridge = vi.hoisted(() => ({ active: false }))
vi.mock("../../../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => bridge.active,
  getDesktopL1Bridge: () => null,
}))
// Which surface shows is the question; the sheet's own behaviour has its own suite.
vi.mock("../../../src/features/deposit/DepositFromWalletModal", () => ({
  DepositFromWalletModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="fund-sheet">
      <button type="button" onClick={onClose}>
        close-sheet
      </button>
    </div>
  ),
}))
// No WagmiProvider in the test tree. `connect` raises the picker in the same render as the click,
// as RainbowKit's `openConnectModal` does; the tests move the rest of the lifecycle by hand.
const l1 = vi.hoisted(() => ({
  account: null as Hex | null,
  accounts: [] as Hex[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  pickerOpen: false,
  connect: vi.fn(async () => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
import { seedBootConfig } from "../../support/seedBootConfig"

const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ wallet: {} }))
afterEach(closeSession)

describe("DepositScreen — funding click held across the wallet picker", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const sheets = () => container.querySelectorAll("[data-testid='fund-sheet']").length
  const buttonContaining = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))

  /** First call mounts; later calls re-render the screen against the mutated `l1`. */
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  const clickConnect = async () => {
    const connect = buttonContaining("connect a wallet")
    expect(connect?.disabled).toBe(false)
    await act(async () => connect!.click())
  }

  /** The wallet connects: wagmi's account lands first, RainbowKit closes its picker off that. */
  const walletLands = () => {
    l1.account = ACCOUNT
    l1.accounts = [ACCOUNT]
  }
  const pickerCloses = () => {
    l1.pickerOpen = false
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    l1.account = null
    l1.accounts = []
    l1.pickerOpen = false
    bridge.active = false
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("drops the click when the picker is dismissed, so a later connection opens nothing", async () => {
    await render()
    await clickConnect()
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(l1.pickerOpen).toBe(true)
    expect(sheets()).toBe(0)

    pickerCloses()
    await render()
    expect(sheets()).toBe(0)

    // Restored from storage, or connected from another screen: not this click's wallet.
    walletLands()
    await render()
    expect(sheets()).toBe(0)
    expect(container.textContent).toContain("Deposit from")
  })

  it("opens the sheet once when the wallet lands before the picker closes", async () => {
    await render()
    await clickConnect()

    walletLands()
    await render()
    expect(sheets()).toBe(1)

    pickerCloses()
    await render()
    expect(sheets()).toBe(1)
    expect(l1.connect).toHaveBeenCalledOnce()

    // Closing the sheet is final: nothing held is left to reopen it.
    await act(async () => buttonContaining("close-sheet")!.click())
    expect(sheets()).toBe(0)
    await render()
    expect(sheets()).toBe(0)
  })

  it("opens the sheet once when the wallet lands and the picker closes in one render", async () => {
    await render()
    await clickConnect()

    walletLands()
    pickerCloses()
    await render()
    expect(sheets()).toBe(1)
    expect(l1.connect).toHaveBeenCalledOnce()
  })

  it("honours a fresh click after a dismissed one", async () => {
    await render()
    await clickConnect()
    pickerCloses()
    await render()

    await clickConnect()
    expect(l1.connect).toHaveBeenCalledTimes(2)
    expect(l1.pickerOpen).toBe(true)

    walletLands()
    await render()
    expect(sheets()).toBe(1)
  })
})

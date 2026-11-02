/**
 * The deposit screen lists the coins; a coin row opens the address sheet, which carries the address
 * from creating to spotted and holds the limits drawer. The screen and the sheet render for real.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { l1AddressParts, shortL1Addr } from "../../../src/ui/format"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"
import { LIMIT, LIMIT_USD, grouped } from "../../support/publicLimit"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const ADDRESS = "0x7b3E9c41aD02f8B5c6E1d7a9F04c3B8e2A61d9F0"
// MetaMask's bold ends of the checksummed address.
const ENDS = [l1AddressParts(ADDRESS).head, l1AddressParts(ADDRESS).tail]
const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const aztec = { obsidionWallet: { networkId: "0xnet" } }
const contracts = { contractService: {} }
// The open's pool read hits: the coin row shows the address with no derivation.
const depositAddress = vi.fn(async () => ({ address: ADDRESS, name: "alice.oxide.eth" }))
const gateway = { depositAddress, observe: vi.fn() }

const navigate = vi.hoisted(() => vi.fn())
const fireEvent = vi.hoisted(() => vi.fn())
// What the rail observes at the address, in DAI units: the coin it settles in.
const held = vi.hoisted(() => vi.fn(async () => 0n))
const layout = vi.hoisted(() => ({ phone: false }))
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
}))
// The chain's timing, as the arrival hook reads it; undefined while unread.
const arrival = vi.hoisted(() => ({ minutes: 5 as number | undefined }))
vi.mock("../../../src/features/deposit/depositArrival", () => ({
  useDepositArrivalMinutes: () => arrival.minutes,
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("../../../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => layout.phone }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => contracts,
}))
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => gateway,
}))
// The mainnet coin list: DAI settles, USDC and USDT are swapped into it.
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { MAINNET_DAI, mainnetTokens, mockLoadDepositFacts } = await import(
    "../../support/depositTokens"
  )
  const tokens = mainnetTokens()
  return mockLoadDepositFacts(
    importOriginal,
    () => tokens,
    async () => ({
      fee: "0.25",
      token: MAINNET_DAI,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: 5166n * 10n ** 18n,
    }),
  )
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// No WagmiProvider in the test tree: `connect` raises the picker, the tests land the account by hand.
const l1 = vi.hoisted(() => ({
  account: null as Hex | null,
  accounts: [] as Hex[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  walletName: null as string | null,
  pickerOpen: false,
  connect: vi.fn(async () => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))
// Which surface shows is the question; the funding sheet has its own suite.
vi.mock("../../../src/features/deposit/DepositFromWalletModal", () => ({
  DepositFromWalletModal: () => <div data-testid="fund-sheet" />,
}))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { seedBootConfig } = await import("../../support/seedBootConfig")
const { provideFakeDepositRail } = await import("../../support/fakeDepositRail")
const { SIPADepositStore } = await import("@obsidion/front-core")

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)
const sheet = () => document.querySelector("dialog[aria-label='Deposit address']")

const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ wallet: aztec.obsidionWallet }))
afterEach(closeSession)

describe("DepositScreen with the address sheet", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root
  let observe: ReturnType<typeof provideFakeDepositRail>

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
  const openCoin = (symbol: string) => act(async () => byTestId(`deposit-coin-${symbol}`)!.click())
  const openDrawer = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
  const closeSheet = () =>
    act(async () => sheet()!.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click())
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.clearAllMocks()
    held.mockResolvedValue(0n)
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    arrival.minutes = 5
    l1.account = null
    l1.accounts = []
    l1.pickerOpen = false
    layout.phone = false
    localStorage.clear()
    ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
    observe = provideFakeDepositRail({ addresses: () => [ADDRESS], held, token: () => USDC as Hex })
    localStorage.setItem("webwallet.hide-deposit-privacy-disclaimer", "true")
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    container.remove()
  })

  it("colors the coin's ring like the bell: gold while this page runs an operation, green otherwise", async () => {
    const { getOperationStore } = await import("../../../src/features/operations/operations")
    const store = getOperationStore()
    let land: (next: { address: string; name: string }) => void = () => {}
    depositAddress.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    await render()
    await openCoin("USDC")
    const ring = () => sheet()!.querySelector(".ww-deposit-sheet__coin-ring")!
    expect(ring().classList.contains("is-safe")).toBe(true)

    await act(async () => {
      await store.begin({
        operationId: "op-derive",
        flow: "deposit",
        summary: "Deposit address",
        scope: null,
      })
    })
    expect(ring().classList.contains("is-tab-bound")).toBe(true)

    await act(async () => {
      store.release("op-derive")
      await store.remove("op-derive")
    })
    expect(ring().classList.contains("is-safe")).toBe(true)
    await act(async () => land({ address: ADDRESS, name: "alice.oxide.eth" }))
  })

  it("copies, says the address was copied, and then waits for the funds", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    expect(byTestId("deposit-copy")!.textContent).toBe("Address copied!")
    expect(sheet()!.querySelector(".ww-deposit-sheet__chip")!.textContent).toBe("Copied")

    await tick(2000)
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    expect(sheet()!.textContent).toContain("Send USDC on Ethereum to the address below.")
    expect(sheet()!.textContent).toContain("Waiting for deposit")
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Balance at this address: $0 USDC · Last checked 2s ago",
    )
    expect(byTestId("address-limits")).toBeNull()
    expect(byTestId("deposit-address")!.title).toBe(ADDRESS)

    // Copying again is only feedback.
    await act(async () => button("Copy address again")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2)
    expect(button("Address copied!")).toBeDefined()
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
  })

  it("stays on the address when the clipboard refuses the copy", async () => {
    vi.useFakeTimers()
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    expect(byTestId("deposit-copy")!.textContent).toBe("Copy address")
    expect(sheet()!.querySelector(".ww-deposit-sheet__chip")).toBeNull()

    await tick(2000)
    expect(sheet()!.textContent).toContain("Send USDC to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your USDC")
    expect(byTestId("address-limits")).not.toBeNull()
  })

  it("spots a balance once, and Close goes Home", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("50 DAI spotted")
    expect(sheet()!.textContent).toContain("should arrive in about 5 minutes")
    expect(byTestId("deposit-arriving")!.textContent).toBe(
      "50 DAI sent · 49.75 DAI arriving · ~5 min",
    )
    expect(byTestId("deposit-swap-line")).toBeNull()
    expect(sheet()!.textContent).toContain("You can close this screen.")
    expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_funded")).toHaveLength(1)
    expect(navigate).not.toHaveBeenCalled()

    await act(async () => button("Close")!.click())
    expect(sheet()).toBeNull()
    expect(navigate).toHaveBeenCalledWith("/")
    expect(depositAddress).toHaveBeenCalledOnce()
  })

  it("says a few minutes while the chain's timing is unread", async () => {
    vi.useFakeTimers()
    arrival.minutes = undefined
    await render()
    await openCoin("USDC")
    await openDrawer()
    expect(byTestId("address-limits")!.textContent).toContain("Deposit arrival timeA few minutes")

    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(sheet()!.textContent).toContain("should arrive in about a few minutes")
    expect(byTestId("deposit-arriving")!.textContent).toBe("50 USDC sent · a few min")
  })

  it("waits for capacity, not an arrival, when a deposit lands on zero capacity", async () => {
    vi.useFakeTimers()
    capacity.availableAtomic = 0n
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("50 DAI spotted")
    expect(sheet()!.textContent).toContain("over what the network can take right now")
    expect(sheet()!.textContent).toContain("Waiting for capacity")
    expect(sheet()!.textContent).not.toContain("should arrive in about")
    expect(byTestId("deposit-arriving")!.textContent).toBe(
      "50 DAI sent · 49.75 DAI arriving · once capacity frees up",
    )
  })

  it("forgets a copy's hand-off when the sheet closes before it", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(byTestId("deposit-copy")!.textContent).toBe("Address copied!")
    await closeSheet()
    await openCoin("USDC")
    await tick(2000)
    expect(sheet()!.textContent).toContain("Send USDC to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your USDC")
    expect(byTestId("deposit-copy")).not.toBeNull()
  })

  it("the wallet link closes the sheet and funds once the picked wallet lands", async () => {
    await render()
    await openCoin("USDC")
    const pay = byTestId("deposit-pay-with-wallet") as HTMLButtonElement
    expect(pay.textContent).toBe("Or connect a wallet to fund")
    expect(pay.disabled).toBe(false)
    await act(async () => pay.click())
    expect(sheet()).toBeNull()
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(byTestId("fund-sheet")).toBeNull()

    l1.account = ACCOUNT
    l1.accounts = [ACCOUNT]
    await render()
    expect(byTestId("fund-sheet")).not.toBeNull()
    expect(sheet()).toBeNull()
  })

  it("says the address couldn't be checked after a failed read, until a read succeeds", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)

    held.mockRejectedValueOnce(new Error("rpc down"))
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Couldn't check this address. Check your connection and try again.",
    )
    expect(sheet()!.textContent).toContain("Waiting for your USDC")

    // The pill spins for a moment after a press before it takes another.
    await tick(800)
    const passes = observe.mock.calls.length
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(observe).toHaveBeenCalledTimes(passes + 1)
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Balance at this address: $0 USDC · Last checked 0s ago",
    )
  })

  it("holds a deposit over the per-transaction limit for recovery from Activity", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(BigInt(LIMIT + 100) * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain(`${grouped(LIMIT + 100)} DAI spotted`)
    expect(sheet()!.textContent).toContain(`This deposit is over the ${LIMIT_USD} limit`)
    expect(sheet()!.textContent).toContain("Over the limit")
    expect(byTestId("deposit-arriving")!.textContent).toBe(
      `${grouped(LIMIT + 100)} DAI sent · recovery needed`,
    )
    expect(sheet()!.textContent).not.toContain("arriving")
    expect(sheet()!.querySelector(".ww-deposit-sheet__status .zkm-spinner-icon")).toBeNull()
    expect(sheet()!.textContent).toContain("Recovery sends the whole amount")

    await act(async () => button("Open Activity")!.click())
    expect(navigate).toHaveBeenCalledWith("/activity")
  })

  it("on a phone the card is the fact card: Network, the address on one row shortened in the middle, Status", async () => {
    layout.phone = true
    let land: (next: {
      address: string
      name: string
      publish?: () => Promise<void>
    }) => void = () => {}
    depositAddress.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    await render()
    await openCoin("USDC")
    await act(async () =>
      land({ address: ADDRESS, name: "alice.oxide.eth", publish: () => new Promise(() => {}) }),
    )
    const address = byTestId("deposit-address")!
    expect(address.title).toBe(ADDRESS)
    expect(address.textContent).toBe(shortL1Addr(ADDRESS))
    expect([...address.querySelectorAll("strong")].map((b) => b.textContent)).toEqual(ENDS)
    expect(address.querySelector("em")).toBeNull()
    const rows = [...sheet()!.querySelectorAll(".ww-sheet__fact > span:first-child")].map(
      (n) => n.textContent,
    )
    expect(rows).toEqual(["Network", "Address", "Status"])
    // An unpublished address reads as any other until funds wait on its broadcast.
    expect(byTestId("deposit-status")!.textContent).toBe("Awaiting deposit")
    expect(byTestId("broadcast-status")).toBeNull()
    expect(sheet()!.querySelector(".ww-deposit-sheet__coin-spin")).toBeNull()
    expect(sheet()!.querySelector(".ww-deposit-sheet__pill")).toBeNull()
  })

  it("shows the address's broadcast once funds wait on it", async () => {
    vi.useFakeTimers()
    let land: (next: {
      address: string
      name: string
      publish?: () => Promise<void>
    }) => void = () => {}
    depositAddress.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    await render()
    await openCoin("DAI")
    await act(async () =>
      land({ address: ADDRESS, name: "alice.oxide.eth", publish: () => new Promise(() => {}) }),
    )
    expect(byTestId("broadcast-status")).toBeNull()
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(10n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("10 DAI spotted")
    expect(byTestId("broadcast-status")).not.toBeNull()
  })

  it("keeps waiting when the same coin is opened again, and starts another coin at its address", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    await closeSheet()
    await openCoin("USDC")
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    expect(byTestId("deposit-check-again")).not.toBeNull()
    await closeSheet()
    await openCoin("USDT")
    expect(sheet()!.textContent).toContain("Send USDT to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your")
  })
})

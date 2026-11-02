/**
 * The address sheet's "Limits and fees" row names the limit that fits right now, and its drawer
 * holds the fee, the capacity reading and the route's details. Copy and the code are held while the
 * fee is unread. Capacity that holds a deposit is said above Copy; copying never asks.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex

const loadDepositDisplayFacts = vi.hoisted(() => vi.fn())
const demo = vi.hoisted(() => ({
  on: false,
  /** A two-row table: DAI and USDC each settle on their own row. */
  rows: false,
  /** A Sky table: DAI on Main and sUSDS on Savings. */
  savings: false,
  /** A Sky table pinned on its sUSDS row; `offersNone` when Main is offered no row. */
  pinnedSavings: false,
  offersNone: false,
  /** The accepted tokens are not read yet; `failed` once a read failed. */
  unread: false,
  failed: false,
  retry: vi.fn(),
}))

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
  rowTokens: [] as (string | undefined)[],
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("../../../src/dev/demoFlag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/dev/demoFlag")>()),
  isDemoMode: () => demo.on,
}))
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
// The sandbox's one coin, or the mainnet coins (DAI settling) in the demo.
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const {
    mainnetTokens,
    mockLoadDepositFacts,
    pinnedSavingsRowTokens,
    savingsRowTokens,
    singleToken,
    twoRowTokens,
  } = await import("../../support/depositTokens")
  const sandbox = singleToken(MANIFEST_TOKEN, "TEST")
  const mainnet = mainnetTokens(MANIFEST_TOKEN)
  const twoRows = twoRowTokens()
  const savings = savingsRowTokens()
  return mockLoadDepositFacts(
    importOriginal,
    () =>
      demo.unread
        ? undefined
        : demo.pinnedSavings
        ? pinnedSavingsRowTokens(!demo.offersNone)
        : demo.savings
        ? savings
        : demo.rows
        ? twoRows
        : demo.on
        ? mainnet
        : sandbox,
    loadDepositDisplayFacts,
    () => ({ failed: demo.failed, retry: demo.retry }),
  )
})
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({
    account: null,
    accounts: [],
    chainId: null,
    connecting: false,
    wrongChain: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "signed-out" }, refresh: () => {} }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: MANIFEST_TOKEN }),
}))

const { DepositScreen, QUOTE_PENDING } = await import("../../../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { depositCapacityStore } = await import("../../../src/features/deposit/capacityStore")
const { FAKE_ACTIVE_KEY } = await import("../../support/fakeCapacity")
import { seedBootConfig } from "../../support/seedBootConfig"
import { ROW_USDC } from "../../support/depositTokens"
import * as copy from "../../../src/features/limits/limitsCopy"
import { LIMIT, LIMIT_USD, grouped } from "../../support/publicLimit"

const FACTS = {
  fee: "0.25",
  token: MANIFEST_TOKEN,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  txAmountCap: 5166n * 10n ** 18n,
}

const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ wallet: {} }))
afterEach(closeSession)

describe("DepositScreen limits in the address sheet", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
  const limits = () => byTestId("address-limits")
  const copyButton = () => byTestId("deposit-copy") as HTMLButtonElement | null
  const aboutLimits = () => document.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)
  const warningDialog = () =>
    document.querySelector("dialog[aria-label='One-time deposit address']")
  /** Opens the sheet for the one coin the sandbox lists, or the named one in the demo. */
  const openSheet = (symbol = "TEST") =>
    act(async () => byTestId(`deposit-coin-${symbol}`)!.click())
  const openDrawer = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
  /** Opens the limit's details from the drawer and returns them. */
  const openLimit = async () => {
    await act(async () =>
      limits()!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!.click(),
    )
    for (let i = 0; i < 3; i++) await act(async () => {})
    return aboutLimits()!
  }
  const closeLimit = () =>
    act(async () => {
      aboutLimits()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
  const maxSend = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-send']")?.textContent
  const maxCredit = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-credit']")?.textContent
  const limitNow = () => byTestId("deposit-limit-now")?.textContent
  const capacityNote = () => byTestId("deposit-capacity-note")

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
  const renderOverHome = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen onClose={() => {}} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    vi.clearAllMocks()
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    demo.on = false
    demo.rows = false
    demo.savings = false
    demo.pinnedSavings = false
    demo.offersNone = false
    demo.unread = false
    demo.failed = false
    capacity.rowTokens = []
    localStorage.clear()
    localStorage.setItem("webwallet.hide-deposit-privacy-disclaimer", "true")
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const loadDepositFacts = () => loadDepositDisplayFacts.mockResolvedValue(FACTS)

  it("names the limit under the address, with the route's details in the drawer", async () => {
    loadDepositFacts()
    await render()
    await openSheet()

    expect(limits()?.textContent).toBe(`Limits and feesUp to ${LIMIT_USD} right now`)
    // The address comes first, then its limit.
    const address = byTestId("deposit-address")!
    expect(
      address.compareDocumentPosition(limits()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await openDrawer()
    expect(limitNow()).toBe(`${LIMIT_USD} incl. fees`)
    const details = await openLimit()
    expect(details.textContent).toContain(copy.LIMIT_NOTE)
    expect(maxSend(details)).toBe(`${grouped(LIMIT)} TEST`)
    // Net of the current 0.25 sweep fee.
    expect(maxCredit(details)).toBe(`${grouped(LIMIT - 0.25)} TEST`)
  })

  it("puts the limits right under the QR code, and hands focus back to the drawer", async () => {
    loadDepositFacts()
    await render()
    await openSheet()

    // The code comes first; the limit sits right under it.
    const code = document.querySelector("[aria-label='Deposit address QR code']")!
    expect(code).not.toBeNull()
    expect(code.compareDocumentPosition(limits()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The details open over the sheet and hand focus back to it.
    await openDrawer()
    const info = limits()!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!
    info.focus()
    const details = await openLimit()
    expect(maxSend(details)).toBe(`${grouped(LIMIT)} TEST`)
    await closeLimit()
    expect(aboutLimits()).toBeNull()
    expect(document.activeElement).toBe(info)
  })

  it("reads as checking while the fee is out", async () => {
    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await render()
    await openSheet()
    await openDrawer()

    expect(byTestId("deposit-fee")?.textContent).toBe(QUOTE_PENDING)
    expect(maxSend(await openLimit())).toBe(QUOTE_PENDING)
  })

  it("names no maximum and holds copy and scan while the fee is unavailable", async () => {
    loadDepositDisplayFacts.mockRejectedValue(new Error("rpc down"))
    await render()
    await openSheet()

    expect(limits()?.textContent).toContain(LIMIT_USD)
    expect(copyButton()?.disabled).toBe(true)
    expect(document.querySelector("[aria-label='Deposit address QR code']")).toBeNull()
    await openDrawer()
    const details = await openLimit()
    expect(maxSend(details)).toBe(copy.UNAVAILABLE)
    expect(maxCredit(details)).toBe(copy.UNAVAILABLE)
  })

  it("names the swap for a token the portal does not settle in", async () => {
    demo.on = true
    loadDepositFacts()
    await render()
    await openSheet("USDC")
    await openDrawer()

    expect(byTestId("deposit-swap-note")?.textContent).toBe(
      "USDC is swapped to DAI at the market rate, so the DAI credited can differ.",
    )
    expect(byTestId("deposit-fee")?.textContent).toContain("0.25 DAI")
    const details = await openLimit()
    expect(maxSend(details)).toBe(`${grouped(LIMIT)} USDC`)
    // The swap sets the DAI credited, so no credit is stated.
    expect(maxCredit(details)).toBe(copy.UNAVAILABLE)
    expect(details.textContent).toContain(copy.swapCreditNote("USDC", "DAI"))
  })

  describe("shared capacity", () => {

    it("says zero capacity above Copy, with Check again and its details in the drawer", async () => {
      capacity.availableAtomic = 0n
      loadDepositFacts()
      await render()
      await openSheet()
      expect(capacityNote()?.textContent).toContain("No network capacity is available right now.")
      expect(capacityNote()?.getAttribute("role")).toBe("alert")
      await openDrawer()
      expect(limitNow()).toBe("$0 incl. fees")
      expect(byTestId("funding-capacity-retry")).not.toBeNull()
      const info = byTestId("about-capacity-link")!
      expect(info.getAttribute("aria-label")).toBe("About network capacity")
      await act(async () => info.click())
      for (let i = 0; i < 3; i++) await act(async () => {})
      const toggle = aboutLimits()!.querySelector("[data-testid='about-limits-capacity-toggle']")!
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
    })

    it("names the most that fits current capacity as the limit right now", async () => {
      capacity.availableAtomic = 500n * 10n ** 18n
      loadDepositFacts()
      await render()
      await openSheet()
      expect(limits()?.textContent).toBe("Limits and feesUp to $500.25 right now")
      await openDrawer()
      expect(limitNow()).toBe("$500.25 incl. fees")
    })

    it("says capacity could not be checked, and still copies at once", async () => {
      capacity.readFails = true
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(limitNow()).toBe("Could not check")
      expect(capacityNote()?.textContent).toContain(copy.CAPACITY_UNAVAILABLE)
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })

    it("keeps the note and the drawer current when capacity drops while the code is shown", async () => {
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(capacityNote()).toBeNull()
      capacity.availableAtomic = 0n
      await act(async () => {
        await depositCapacityStore(FAKE_ACTIVE_KEY).retry()
      })
      expect(capacityNote()?.textContent).toContain("No network capacity is available right now")
      expect(limitNow()).toBe("$0 incl. fees")
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })

    it("does not match a swapped token to capacity", async () => {
      demo.on = true
      capacity.availableAtomic = 500n * 10n ** 18n
      loadDepositFacts()
      await render()
      await openSheet("USDC")
      await openDrawer()
      // No figure fits a swap; the reason is in the capacity details, not on the sheet.
      expect(limitNow()).toBe(`${LIMIT_USD} incl. fees`)
      await act(async () => byTestId("about-capacity-link")!.click())
      for (let i = 0; i < 3; i++) await act(async () => {})
      expect(
        aboutLimits()!.querySelector("[data-testid='address-capacity-swap']")?.textContent,
      ).toBe(copy.swapCapacityNote("DAI", "USDC"))
    })
  })

  describe("a two-row table", () => {
    const usdcFacts = {
      fee: "0.1",
      token: ROW_USDC,
      sweepFeeAtomic: 100_000n,
      txAmountCap: 5_166n * 10n ** 6n,
    }
    const sheet = () => document.querySelector("dialog[aria-label='Deposit address']")!

    it("says the USDC row credits USDC, prices its fee in USDC and names no DAI", async () => {
      demo.rows = true
      loadDepositDisplayFacts.mockImplementation(async (token?: { settlesIn: string }) =>
        token?.settlesIn === ROW_USDC ? usdcFacts : FACTS,
      )
      await render()
      await openSheet("USDC")
      await openDrawer()

      expect(byTestId("deposit-fee")?.textContent).toContain("0.10 USDC")
      expect(byTestId("deposit-credit-note")?.textContent).toBe(
        "Each USDC you send is credited as 1 USDC, less the fee.",
      )
      expect(byTestId("deposit-swap-note")).toBeNull()
      expect(sheet().textContent).not.toContain("DAI")
      const details = await openLimit()
      expect(maxCredit(details)).toBe(`${grouped(LIMIT - 0.1)} USDC`)
      // Nothing says a USDC deposit is converted.
      expect(details.textContent).toContain(copy.LIMIT_NOTE)
      expect(details.textContent).not.toContain("converted")
      expect(details.textContent).not.toContain("swapped")
      // The quote, the cap and the capacity bucket are the USDC row's.
      expect(loadDepositDisplayFacts).toHaveBeenLastCalledWith(
        expect.objectContaining({ settlesIn: ROW_USDC }),
        "deposit",
      )
      expect(capacity.rowTokens).toContain(ROW_USDC)
    })
  })

  describe("a table with a Savings row", () => {

    it("starts the coin pick on Main's DAI when the profile pins sUSDS", async () => {
      demo.pinnedSavings = true
      loadDepositFacts()
      await renderOverHome()
      expect(byTestId("deposit-coin-select")?.textContent).toContain("DAI")
      expect(container.ownerDocument.body.textContent).not.toContain("sUSDS")
    })

    it("offers nothing to deposit when Main is offered no row", async () => {
      demo.pinnedSavings = true
      demo.offersNone = true
      await renderOverHome()
      expect(byTestId("deposit-tokens-failed")).not.toBeNull()
      expect(byTestId("deposit-coin-select")).toBeNull()
    })
  })

  describe("before the accepted tokens are read", () => {
    it("says it is loading and names no token", async () => {
      demo.unread = true
      await render()
      expect(byTestId("deposit-tokens-loading")?.textContent).toContain(
        "Loading the tokens you can deposit",
      )
      expect(byTestId("deposit-coin-TEST")).toBeNull()
      expect(container.textContent).not.toContain("DAI")
    })

    it("says the read failed, and Retry reads again", async () => {
      demo.unread = true
      demo.failed = true
      await render()
      expect(byTestId("deposit-tokens-loading")).toBeNull()
      expect(byTestId("deposit-tokens-failed")?.textContent).toContain(
        "Couldn't load the tokens you can deposit",
      )
      await act(async () => byTestId("deposit-tokens-retry")!.click())
      expect(demo.retry).toHaveBeenCalledOnce()
    })
  })
})

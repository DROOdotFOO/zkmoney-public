/**
 * The deposit quote is what gates funding: without the fee the wallet would charge the amount
 * alone while the pool still takes its fee. A failed read has to say so and offer another go,
 * rather than leaving every affordance dead.
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
const showReportableError = vi.hoisted(() => vi.fn())

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
  return mockLoadDepositFacts(importOriginal, () => tokens, loadDepositDisplayFacts)
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError }))
const l1 = vi.hoisted(() => ({
  account: null as string | null,
  accounts: [] as string[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))

const { DepositScreen, FEE_UNAVAILABLE_NOTE, QUOTE_PENDING } = await import(
  "../../../src/features/deposit/DepositScreen"
)
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { tokenFigure } = await import("../../../src/ui/format")
import { seedBootConfig } from "../../support/seedBootConfig"

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

describe("DepositScreen — deposit quote", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const retry = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-facts-retry']")
  const feeValue = () => container.querySelector("[data-testid='deposit-fee']")?.textContent?.trim()
  const copyButton = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-copy']")
  /** Opens the sheet for the one coin the sandbox lists, and its limits drawer, where the fee is. */
  const openDrawer = async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-TEST']")!.click(),
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
  }

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

  beforeEach(async () => {
    vi.clearAllMocks()
    l1.account = null
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

  it("offers another go when the quote fails, and quotes once it lands", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    await openDrawer()

    expect(retry()).toBeTruthy()
    expect(copyButton()?.disabled).toBe(true)
    // Transient by nature; the retry control is the affordance, not an error report.
    expect(showReportableError).not.toHaveBeenCalled()

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(loadDepositDisplayFacts).toHaveBeenCalledTimes(2)
    expect(retry()).toBeNull()
    expect(feeValue()).toBe(tokenFigure(FACTS.fee, "TEST"))
    expect(copyButton()?.disabled).toBe(false)
  })

  it("holds the funding controls while the quote is unavailable, and frees them on a good retry", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    l1.account = `0x${"a1".repeat(20)}`
    await render()

    const connect = () =>
      container.querySelector<HTMLButtonElement>("[data-testid='deposit-connect-link']")!
    const note = () => container.querySelector("[data-testid='deposit-fee-unavailable']")
    expect(connect().disabled).toBe(true)
    await openDrawer()
    expect(gateway.depositAddress).toHaveBeenCalledOnce()
    expect(copyButton()?.disabled).toBe(true)
    expect(note()?.textContent).toBe(FEE_UNAVAILABLE_NOTE)

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(connect().disabled).toBe(false)
    expect(copyButton()?.disabled).toBe(false)
    expect(note()).toBeNull()
  })

  it("keeps the row pending across a retry rather than blanking it", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    await openDrawer()
    expect(retry()).toBeTruthy()

    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await act(async () => retry()!.click())

    expect(retry()).toBeNull()
    expect(feeValue()).toBe(QUOTE_PENDING)
  })

  it("holds the funding controls while the quote is still out, with nothing to retry", async () => {
    let land: (facts: typeof FACTS) => void = () => {}
    loadDepositDisplayFacts.mockReturnValue(new Promise((resolve) => (land = resolve)))
    l1.account = `0x${"a1".repeat(20)}`
    await render()

    const connect = () =>
      container.querySelector<HTMLButtonElement>("[data-testid='deposit-connect-link']")!
    expect(connect().disabled).toBe(true)
    await openDrawer()
    expect(copyButton()?.disabled).toBe(true)
    // Nothing has failed, so the row says pending and carries no note.
    expect(container.querySelector("[data-testid='deposit-fee-unavailable']")).toBeNull()

    await act(async () => land(FACTS))

    expect(connect().disabled).toBe(false)
    expect(copyButton()?.disabled).toBe(false)
  })
})

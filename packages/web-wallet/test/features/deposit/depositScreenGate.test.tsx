import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PendingRegistrationStore,
  ScreeningProvider,
  passThroughScreener,
} from "@obsidion/front-core"
import { formatUnits, type Hex } from "viem"
import type { DepositAddress } from "../../../src/features/deposit/sipaGateway"
import { MAINNET_USDC, tokenOption } from "../../support/depositTokens"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

/** The pool reads empty (the open's limit-0 read refuses), and the coin row derives. */
const resolveDefault = async (...args: unknown[]): Promise<DepositAddress> => {
  if ((args[3] as { publishingLimit?: number } | undefined)?.publishingLimit === 0) {
    throw new AddressesPublishingError()
  }
  return { address: "0xdeadbeef", name: "alice.oxide.eth" }
}
const depositAddress = vi.fn<(...args: unknown[]) => Promise<DepositAddress>>(resolveDefault)
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex
const CREATING = "Creating your address..."

// Stable identities so `resolveAddress` keeps one identity across renders.
const aztec = { obsidionWallet: { networkId: "0xnet" } }
const contracts = { contractService: {} }

const navigate = vi.hoisted(() => vi.fn())
// What the rail observes at the address.
const held = vi.hoisted(() => vi.fn(async (): Promise<bigint> => 0n))
const fireEvent = vi.hoisted(() => vi.fn())
/** Coins offered past the network's own. */
const extraCoins = vi.hoisted(
  () => [] as import("../../../src/features/deposit/loadDepositFacts").DepositTokenOption[],
)
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
  fireOnboardingEvent: fireEvent,
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => contracts,
}))
// One instance, like the real singleton — the screen keys effects off the gateway identity.
const gateway = { depositAddress, observe: vi.fn() }
vi.mock("../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => gateway,
}))
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const own = singleToken(MANIFEST_TOKEN, "TEST")
  return mockLoadDepositFacts(
    importOriginal,
    () => ({
      ...own,
      options: [...own.options, ...extraCoins],
      offered: [...own.offered, ...extraCoins],
    }),
    async () => ({
      fee: "0.25",
      token: MANIFEST_TOKEN,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: 5166n * 10n ** 18n,
    }),
  )
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A test's own target stands in for the registration's, so the screen's handling of a target is
// tested apart from how a registration makes one.
const targeted = vi.hoisted(() => ({
  target: undefined as
    | import("../../../src/features/deposit/depositTarget").DepositTarget
    | undefined,
}))
vi.mock("../../../src/features/onboarding/registrationDepositTarget", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/features/onboarding/registrationDepositTarget")
  >()
  return {
    useRegistrationDepositTarget: (
      ...args: Parameters<typeof real.useRegistrationDepositTarget>
    ) => {
      const made = real.useRegistrationDepositTarget(...args)
      return targeted.target ?? made
    },
  }
})
// No WagmiProvider in the test tree; the gate under test never touches the L1 wallet. `connect`
// raises the picker the way RainbowKit's does, in the same render as the click.
const l1 = vi.hoisted(() => ({
  account: null as string | null,
  accounts: [] as string[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  pickerOpen: false,
  connect: vi.fn(() => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => l1,
}))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { applyIdentityOutcome, getPendingStore, runBootDetection } = await import(
  "../../../src/features/onboarding/webRegistration"
)
const { RegistrationPendingError } = await import(
  "../../../src/features/onboarding/registrationRail"
)
const { showReportableError } = await import("../../../src/errors/errorModal")
const { AddressesPublishingError } = await import(
  "../../../src/features/deposit/addressesPublishing"
)
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../../../src/features/broadcasts/broadcasts"
)
const { getConfig } = await import("../../../src/config/env")
const { saveRegistrationTerms } = await import("../../../src/features/onboarding/registrationTerms")
const { provideFakeDepositRail } = await import("../../support/fakeDepositRail")
const { SIPADepositStore } = await import("@obsidion/front-core")
import { seedBootConfig } from "../../support/seedBootConfig"
import { usdFigure } from "../../../src/ui/format"
import { PAID_ASK, RANDOM, RANDOM_ASK, usd } from "../../support/registrationPrices"

/**
 * The deposit gates are effectful, not cosmetic: no address may be derived or published while the
 * tag is unconfirmed. A settled tag reads the pool on open and derives one on the coin row, which
 * opens the address sheet.
 */
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(
  () =>
    void openTestSession({
      wallet: aztec.obsidionWallet,
      account: { getAddress: () => "0xaztec" },
    }),
)
afterEach(closeSession)

describe("DepositScreen — claiming gate", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  async function seedPendingClaim(
    over: { fundedAt?: number; l1ChainId?: number; broadcast?: boolean } = { fundedAt: Date.now() },
  ) {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    const store = getPendingStore()
    await store.upsert(
      ACCOUNT,
      {},
      {
        tag: "alice",
        nameHash: `0x${"77".repeat(32)}` as Hex,
        l2Address: L2_ADDRESS,
        l1ChainId: 11155111,
        sipaAddress: `0x${"5a".repeat(20)}`,
        depositToken: `0x${"bb".repeat(20)}` as Hex,
        broadcast: true,
        phase: "awaiting_deposit",
        retries: 0,
        startTime: Date.now(),
        ...over,
      },
    )
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1, pending: true })
    return store
  }

  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/deposit"]}>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  const coinRow = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-TEST']")
  const tagRow = () => container.querySelector("[data-testid='deposit-tag-row']")
  const fundSheet = () => document.querySelector("dialog[aria-label='Deposit from wallet']")

  /** First visit opens the privacy disclaimer in front of the coin list. */
  const dismissDisclaimer = () =>
    act(async () => {
      const gotIt = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Got it!",
      )
      gotIt?.click()
    })

  let observe: ReturnType<typeof provideFakeDepositRail>
  beforeEach(() => {
    vi.clearAllMocks()
    held.mockResolvedValue(0n)
    ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
    observe = provideFakeDepositRail({
      addresses: () => ["0xdeadbeef", `0x${"5a".repeat(20)}`, "0xfeedbeef"],
      held,
      token: () => MANIFEST_TOKEN as Hex,
    })
    resetBroadcastsForTests()
    l1.account = null
    l1.pickerOpen = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("derives nothing while the tag is unconfirmed, then shows an address on its own once it settles", async () => {
    const store = await seedPendingClaim()
    await render()

    expect(container.textContent).toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-registration-ask']")).toBeNull()
    expect(tagRow()).toBeNull()
    expect(depositAddress).not.toHaveBeenCalled()

    // Confirmation as detection applies it: the identity write, then the record close whose
    // listener is what re-renders this screen.
    await act(async () => {
      applyIdentityOutcome("confirmed")
      await store.close(ACCOUNT, "confirmed")
    })

    expect(container.textContent).not.toContain("still being claimed")
    expect(tagRow()).toBeNull()
    // Settling reads the pool, which is empty, and derives nothing: generation waits for the coin row.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 0,
    })
    expect(container.innerHTML).not.toContain("0xdeadbeef")

    const generate = coinRow()
    expect(generate).not.toBeNull()
    await act(async () => generate!.click())
    expect(depositAddress).toHaveBeenCalledTimes(2)
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 2,
    })
    expect(container.textContent).toContain("0xdeadbeef")
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Generate",
    )
  })

  it("resolves one address per open, even when its effects run twice", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await act(async () => {
      root.render(
        <React.StrictMode>
          <MemoryRouter>
            <ScreeningProvider screener={passThroughScreener}>
              <DepositScreen />
            </ScreeningProvider>
          </MemoryRouter>
        </React.StrictMode>,
      )
    })
    // One pool read on open, and one derive on the coin row.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    await act(async () => coinRow()!.click())
    expect(container.textContent).toContain("0xdeadbeef")
    expect(depositAddress).toHaveBeenCalledTimes(2)
  })

  it("reports a resolve that fails on the coin row, and resolves again on the next press", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    depositAddress.mockImplementation(async () => {
      throw new Error("node unreachable")
    })
    await render()
    // The pool read on open fails quietly; the coin row surfaces it, and the sheet closes.
    expect(showReportableError).not.toHaveBeenCalled()
    await act(async () => coinRow()!.click())
    expect(showReportableError).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain(CREATING)
    depositAddress.mockImplementation(resolveDefault)
    await act(async () => coinRow()!.click())
    expect(container.textContent).toContain("0xdeadbeef")
  })

  it("waits while too many shown addresses are still publishing, and resolves once one lands", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    const ledger = getBroadcastLedger()
    const owed = (n: number, kind: "deposit" | "pool") =>
      ledger.enqueue({
        address: `0x${n.toString(16).padStart(40, "0")}`,
        kind,
        scope: null,
        source: { type: "slot", cacheKey: "k", day: 1, nonce: n },
      })
    await owed(1, "deposit")
    await owed(2, "deposit")
    await render()
    depositAddress.mockImplementationOnce(async () => {
      throw new AddressesPublishingError()
    })
    await act(async () => coinRow()!.click())
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 2,
    })
    expect(container.textContent).toContain(CREATING)
    expect(container.textContent).toContain(new AddressesPublishingError().message)
    expect(showReportableError).not.toHaveBeenCalled()
    const calls = depositAddress.mock.calls.length

    // Ledger activity that frees nothing does not try again.
    await act(async () => void (await owed(3, "pool")))
    expect(depositAddress).toHaveBeenCalledTimes(calls)

    await act(async () => void (await ledger.markLanded(`0x${"1".padStart(40, "0")}`)))
    expect(depositAddress).toHaveBeenCalledTimes(calls + 1)
    expect(container.textContent).toContain("0xdeadbeef")
  })

  it("holds the connect-wallet rail while the tag is unconfirmed", async () => {
    await seedPendingClaim()
    await render()

    // The claim hold covers the connected-wallet rail too: nothing opens a picker or resolves an
    // address while the name is still landing.
    expect(container.textContent).toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-connect-link']")).toBeNull()
    expect(l1.connect).not.toHaveBeenCalled()
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("shows the registration's own address from the coins while the name is owed its deposit", async () => {
    await seedPendingClaim({ l1ChainId: getConfig().l1ChainId, broadcast: false })
    await render()
    await dismissDisclaimer()

    expect(container.textContent).not.toContain("still being claimed")
    expect(container.querySelector("[data-testid='deposit-registration-ask']")?.textContent).toBe(
      `Deposit at least ${usd(PAID_ASK)} to activate your account.`,
    )
    expect(tagRow()?.textContent).toBe("Your name@aliceChoose your own")
    expect(fireEvent).toHaveBeenCalledWith("registration_deposit_opened")
    expect(fireEvent).toHaveBeenCalledWith("deposit_sheet_opened", { registration: true })
    await act(async () => tagRow()!.querySelector("button")!.click())
    expect(document.querySelector("dialog[aria-label='Choose your name']")).not.toBeNull()
    expect(fireEvent).toHaveBeenCalledWith("name_sheet_opened", { screen: "deposit" })

    // No address, and no broadcast, until the drawn tag is kept; keeping it locks the tag.
    expect(coinRow()).toBeNull()
    const keep = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Keep @alice",
    )
    await act(async () => keep!.click())
    expect(tagRow()?.textContent).toBe("Your name@alice")
    await act(async () => coinRow()!.click())
    expect(container.innerHTML).toContain(`0x${"5a".repeat(20)}`)
    const shown = fireEvent.mock.calls.map(([e]) => e)
    expect(shown).toContain("registration_deposit_shown")
    expect(shown).not.toContain("deposit_address_shown")
    expect(container.querySelector("[data-testid='activation-sheet']")).toBeNull()

    const connect = container.querySelector<HTMLButtonElement>(
      "[data-testid='deposit-connect-link']",
    )
    expect(connect!.disabled).toBe(false)
    await act(async () => connect!.click())
    expect(l1.connect).toHaveBeenCalled()
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("goes Home when the registration's funds land, instead of turning into a plain deposit", async () => {
    const store = await seedPendingClaim({ l1ChainId: getConfig().l1ChainId, broadcast: false })
    await render()
    expect(tagRow()).not.toBeNull()
    expect(navigate).not.toHaveBeenCalledWith("/", { replace: true })

    await act(async () => {
      await store.upsert(ACCOUNT, { fundedAt: Date.now() })
    })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("sends an owed registration the deposit screen cannot take to its pending step", async () => {
    await seedPendingClaim({ l1ChainId: 1 })
    await render()

    expect(container.textContent).toContain("Registration needs a checkCheck on @alice")
    expect(coinRow()).toBeNull()
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='deposit-claiming']")!.click(),
    )
    expect(navigate).toHaveBeenCalledWith("/claim/alice")
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("asks only for what is left once part of the deposit is at the address", async () => {
    const seen = RANDOM_ASK / 2n
    await seedPendingClaim({ l1ChainId: getConfig().l1ChainId })
    await saveRegistrationTerms({
      account: ACCOUNT,
      tag: "alice",
      deadline: 0,
      feeWaived: true,
      depositAmount: seen.toString(),
    })
    await render()
    expect(container.querySelector("[data-testid='deposit-registration-ask']")?.textContent).toBe(
      `${usd(seen)} of ${usd(RANDOM_ASK)} received. Deposit at least ${usd(
        RANDOM_ASK - seen,
      )} more to activate your account.`,
    )
  })

  it("in the modal, takes what the address holds off the minimum only for the coin it holds", async () => {
    // The modal opens on the fee token; USDC is swapped into it.
    extraCoins.push(tokenOption("USDC", MAINNET_USDC, 6, MANIFEST_TOKEN))
    try {
      await seedPendingClaim({ l1ChainId: getConfig().l1ChainId })
      await saveRegistrationTerms({
        account: ACCOUNT,
        tag: "alice",
        deadline: 0,
        feeWaived: true,
        depositAmount: (RANDOM_ASK / 2n).toString(),
      })
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/"]}>
            <ScreeningProvider screener={passThroughScreener}>
              <DepositScreen onClose={() => {}} />
            </ScreeningProvider>
          </MemoryRouter>,
        )
      })
      const minimum = () =>
        document.querySelector("[data-testid='deposit-minimum']")?.textContent ?? ""
      const dollars = (amount: bigint) => usdFigure(formatUnits(amount, 18))
      expect(minimum()).toBe(dollars(RANDOM_ASK - RANDOM_ASK / 2n))
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-select']")!.click(),
      )
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-USDC']")!.click(),
      )
      expect(minimum()).toBe(dollars(RANDOM_ASK))
    } finally {
      extraCoins.length = 0
    }
  })

  it("stays shut after a boot that found no record to settle the pending identity", async () => {
    // Fail closed: a missing record is not evidence the name was won, and this screen is where
    // that difference costs a derivation and a broadcast.
    const store = await seedPendingClaim()
    await store.remove(ACCOUNT)
    expect(await runBootDetection({} as never)).toBe("idle")

    await render()
    expect(container.textContent).toContain("still being claimed")
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("shows a confirmed tag's address at once while its broadcast waits on the registration, and lets the wallet fund it", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    const publish = vi.fn(async () => {
      throw new RegistrationPendingError({ pending: "import", messageHash: {} as never })
    })
    depositAddress.mockResolvedValueOnce({
      address: "0xdeadbeef",
      name: "alice.oxide.eth",
      publish,
      source: "derived",
    })
    l1.account = ACCOUNT
    await render()

    const generate = coinRow()
    await act(async () => generate!.click())
    expect(publish).toHaveBeenCalledOnce()
    // The ledger publishes it; the sheet shows the address at once. Its broadcast shows once funds wait on it.
    expect(container.innerHTML).toContain("0xdeadbeef")
    expect(container.textContent).not.toContain(CREATING)
    expect(container.querySelector("[data-testid='broadcast-status']")).toBeNull()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).toHaveBeenCalledWith("address_publish_deferred", { reason: "import" })
    expect(fireEvent).not.toHaveBeenCalledWith("address_publish_failed", expect.anything())
    expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_address_shown")).toEqual([
      ["deposit_address_shown", { address_source: "derived" }],
    ])

    const fund = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Deposit from"),
    )
    expect(fund!.disabled).toBe(false)
  })

  it("keeps the address on screen when an attempt fails, reporting it without an error modal", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    depositAddress.mockResolvedValueOnce({
      address: "0xdeadbeef",
      name: "alice.oxide.eth",
      publish: async () => {
        throw new Error("broadcast refused")
      },
    })
    await render()

    const generate = coinRow()
    await act(async () => generate!.click())
    expect(container.textContent).toContain("0xdeadbeef")
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).toHaveBeenCalledWith(
      "address_publish_failed",
      expect.objectContaining({ code: expect.any(String) }),
    )
  })

  it("encodes an EIP-681 transfer URI so a wallet scan pre-fills send", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    await dismissDisclaimer()

    const generate = coinRow()
    await act(async () => generate!.click())

    // Desktop layout: the code sits in the sheet.
    const qr = container.querySelector("[aria-label='Deposit address QR code']")
    expect(qr?.innerHTML).toContain(
      `ethereum:${MANIFEST_TOKEN}@${getConfig().l1ChainId}/transfer?address=0xdeadbeef`,
    )
  })

  it("keeps a registration address short of its floor waiting instead of spotting it", async () => {
    await seedPendingClaim({ l1ChainId: getConfig().l1ChainId })
    // The earned schedule's minimum is above the 0.1 cut, so its floor is the fee plus the minimum.
    const floor = RANDOM.fee + RANDOM.min
    await saveRegistrationTerms({
      account: ACCOUNT,
      tag: "alice",
      deadline: 0,
      fee: String(RANDOM.fee),
      minDeposit: String(RANDOM.min),
      feeWaived: true,
    })
    vi.useFakeTimers()
    try {
      await render()
      await dismissDisclaimer()
      await act(async () => coinRow()!.click())
      held.mockResolvedValue(floor - 1n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(observe).toHaveBeenCalled()
      expect(container.textContent).not.toContain("spotted")
      expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())
      // At the floor the sweep accepts it, so the screen spots it.
      held.mockResolvedValue(floor)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports the funds once the address it handed out is funded, and Close goes Home", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    vi.useFakeTimers()
    try {
      await render()
      const generate = coinRow()
      await act(async () => generate!.click())

      // An unfunded address is the steady state — the screen stays put.
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(observe).toHaveBeenCalled()
      expect(container.textContent).not.toContain("spotted")
      expect(navigate).not.toHaveBeenCalled()

      held.mockResolvedValue(5n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(container.textContent).toContain("spotted")
      expect(navigate).not.toHaveBeenCalled()
      // The external transfer is the funnel's funded step — bucketed, never the exact amount.
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", {
        funding: "external",
        amount_bucket: "<5",
      })
      const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "Close")
      await act(async () => close!.click())
      expect(navigate).toHaveBeenCalledWith("/")
      expect(container.textContent).not.toContain("spotted")
    } finally {
      vi.useRealTimers()
    }
  })

  it("emits deposit_funded once, however many passes see the funds", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    vi.useFakeTimers()
    try {
      await render()
      const generate = coinRow()
      await act(async () => generate!.click())

      held.mockResolvedValue(5n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      held.mockResolvedValue(6n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(observe.mock.calls.length).toBeGreaterThan(1)

      expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_funded")).toHaveLength(1)
      expect(container.textContent).toContain("spotted")
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries one connect click through to the funding sheet when the wallet lands", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    // A pool hit gives the sheet an address to fund without a derivation.
    depositAddress.mockResolvedValueOnce({ address: "0xp001ed", name: "alice.oxide.eth" })
    await render()

    const connect = container.querySelector<HTMLButtonElement>(
      "[data-testid='deposit-connect-link']",
    )
    expect(connect?.textContent).toBe("Or connect a wallet to fund")
    await act(async () => connect!.click())

    // The wallet picker is open and there is still nothing to fund from.
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(fundSheet()).toBeNull()

    // The account arrives a render later; the held intent opens the sheet with no second click.
    l1.account = ACCOUNT
    await render()
    expect(fundSheet()).not.toBeNull()
  })
})

/**
 * A registration's target takes the place of a fresh deposit address: it names the fee and the least
 * to send, and hears when funds land.
 */
describe("DepositScreen — a target", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root
  const onFunded = vi.fn()
  const fee = 5n * 10n ** 17n
  const target = (
    over: Partial<import("../../../src/features/deposit/depositTarget").DepositTarget> = {},
  ): import("../../../src/features/deposit/depositTarget").DepositTarget => ({
    kind: "registration",
    address: { address: "0xfeedbeef", name: "alice" },
    fee,
    floor: fee + 1n,
    ask: 10n ** 18n,
    onFunded,
    onShown: () => {},
    ...over,
  })
  const render = (shown: ReturnType<typeof target>) =>
    act(async () => {
      targeted.target = shown
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen onClose={() => {}} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })
  const row = (id: string) => document.querySelector(`[data-testid='${id}']`)?.textContent ?? ""
  const press = (title: string) =>
    act(async () =>
      [...document.querySelectorAll("button")].find((b) => b.textContent === title)!.click(),
    )

  beforeEach(() => {
    vi.clearAllMocks()
    resetBroadcastsForTests()
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    targeted.target = undefined
    container.remove()
  })

  it("rounds the floor up in a coin with fewer decimals, so a fee-only balance still waits", async () => {
    extraCoins.push(tokenOption("USDC", MAINNET_USDC, 6, MANIFEST_TOKEN))
    vi.useFakeTimers()
    try {
      await render(target())
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-select']")!.click(),
      )
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-USDC']")!.click(),
      )
      await press("Continue")
      held.mockResolvedValue(fee)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).not.toHaveBeenCalled()
    } finally {
      extraCoins.length = 0
      held.mockResolvedValue(0n)
      vi.useRealTimers()
    }
  })

  it("quotes the target's fee in the address sheet's limits too", async () => {
    await render(target())
    await press("Continue")
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
    expect(row("deposit-fee")).toContain("0.50 TEST")
  })

  it("spots funds only at the target's floor, and tells the target", async () => {
    vi.useFakeTimers()
    try {
      await render(target())
      await press("Continue")
      held.mockResolvedValue(fee)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).not.toHaveBeenCalled()
      held.mockResolvedValue(fee + 1n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(onFunded).toHaveBeenCalledWith(fee + 1n, 18)
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", {
        funding: "external",
        amount_bucket: expect.anything(),
        registration: true,
      })
    } finally {
      held.mockResolvedValue(0n)
      vi.useRealTimers()
    }
  })
})

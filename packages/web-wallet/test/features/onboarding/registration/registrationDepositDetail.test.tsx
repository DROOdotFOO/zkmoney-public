import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearWalletPrompt, useWalletPrompt } from "../../../../src/features/deposit/walletPrompt"

// The wallet-request slot is page-wide; forget what a case left open.
const { closeSession } = await import("../../../../src/platform/session")
const { openTestSession } = await import("../../../support/session")
// The session's watchers keep the withdrawals loaded: a stage is known once they land.
let unwatch = () => {}
beforeEach(async () => {
  // The modal reads the page's wallet at render (manual-sweep action).
  const { withdrawals } = openTestSession({ wallet: {} })
  unwatch = withdrawals.list.subscribe(() => {})
  await withdrawals.all()
})
afterEach(() => unwatch())
afterEach(closeSession)

afterEach(clearWalletPrompt)
import {
  passThroughScreener,
  ScreeningProvider,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import { pendingRecord, registrationTerms, SIPA } from "../../../support/registrationFixtures"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "../../../support/passkeyTelemetryHarness"
import * as copy from "../../../../src/features/limits/limitsCopy"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"

const h = vi.hoisted(() => ({
  copied: [] as string[],
  fireEvent: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  manualRegistrationSweep: vi.fn(),
  l1: { account: null as string | null, walletName: null as string | null, connect: vi.fn() },
  writeContract: vi.fn(async () => "0xtx"),
  getL1Clients: vi.fn(),
  processing: { current: undefined as unknown },
  termsReads: [] as string[],
  termsFail: false,
  /** The SIPA deposit store has not loaded its records yet. */
  recordsLoading: false,
}))
h.getL1Clients.mockImplementation(async () => ({
  walletClient: { writeContract: h.writeContract },
  account: h.l1.account,
  chain: { id: 11155111 },
}))

vi.mock("../../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => h.l1,
  getL1Clients: h.getL1Clients,
}))
vi.mock("../../../../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))

vi.mock("../../../../src/features/deposit/l1DepositTokenBalance", () => ({
  readL1DepositTokenBalance: async () => ({ raw: 10n ** 30n }),
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1Chain: { name: "Sepolia" }, l1ChainId: 11155111 }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({}),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({
    readContract: async () => 0n,
    getLogs: async () => [],
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFundingTransfers: async () => [],
  readSipaPortalTerms: async (_client: unknown, route: { forwardingTable: string }) => {
    h.termsReads.push(route.forwardingTable)
    if (h.termsFail) throw new Error("terms read failed")
    return (await import("../../../support/recordedRegistration")).originalTerms(TOKEN)
  },
}))
// Plenty of capacity in every bucket; the test reads which buckets were asked for.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  globalLimitAtomic: undefined as bigint | undefined,
  epoch: 0,
  keys: [] as string[],
}))
vi.mock("../../../../src/features/deposit/capacityStore", async () =>
  (await import("../../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("@obsidion/front-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/front-core")>()
  return {
    ...actual,
    useCachedRecords: ((source) =>
      h.recordsLoading
        ? { records: [], hydrated: false }
        : actual.useCachedRecords(source)) as typeof actual.useCachedRecords,
  }
})
vi.mock("../../../../src/ui/hooks", () => ({
  useCopy: () => ({
    copied: false,
    copy: (text: string) => h.copied.push(text),
  }),
}))
vi.mock("../../../../src/features/onboarding/oxideOnboarding", () => ({
  reusePasskeyAccount: h.reusePasskeyAccount,
}))
// The registration's rail record is not seeded here, so the real rule states a blocker only.
vi.mock("../../../../src/features/deposit/sipaProcessing", async () => {
  const { sipaReasonShown } = await vi.importActual<typeof import("@obsidion/front-core")>(
    "@obsidion/front-core",
  )
  return {
    useSipaProcessing: () => {
      const state = h.processing.current as Parameters<typeof sipaReasonShown>[0]
      const shown = sipaReasonShown(state, { phase: "funded", startTime: Date.now() })
      return { state, shown: shown ? state : undefined }
    },
    sipaProcessingObserver: () => undefined,
  }
})
// Registration surfaces sit inside AccountGate; this suite renders without the provider.
vi.mock("../../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "signed-out" }, refresh: () => {} }),
}))
// The testnet table: one row, its token named TEST. `usdcFee`: a table whose fee token is USDC.
const table = vi.hoisted(() => ({ usdcFee: false }))
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken, usdcFeeTokens } = await import(
    "../../../support/depositTokens"
  )
  return mockLoadDepositFacts(importOriginal, () =>
    table.usdcFee ? usdcFeeTokens() : singleToken(TOKEN, "TEST"),
  )
})
vi.mock("../../../../src/features/onboarding/registrationSweep", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/features/onboarding/registrationSweep")
  >()),
  manualRegistrationSweep: h.manualRegistrationSweep,
}))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ probePhoneReach: async () => "unknown" }),
}))
vi.mock("../../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Spinner: () => null,
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
  }: {
    title: string
    testId?: string
    onClick?: () => void
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick?: () => void }) => <button onClick={onClick}>x</button>,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value?: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
}))

const { RegistrationDepositDetailModal, ManualSweepAction, registrationDepositStatus } =
  await import(
    "../../../../src/features/onboarding/RegistrationDepositDetailModal/RegistrationDepositDetailModal"
  )
const { DepositAddressRow } = await import(
  "../../../../src/features/onboarding/steps/DepositAddress"
)
const { seedRecordedRegistration, ORIGINAL_PORTAL } = await import(
  "../../../support/recordedRegistration"
)
const { FAKE_ACTIVE_KEY } = await import("../../../support/fakeCapacity")
const { depositCapacityStore } = await import("../../../../src/features/deposit/capacityStore")
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../../../../src/features/broadcasts/broadcasts"
)
const { confirmRegistrationTag } = await import(
  "../../../../src/features/onboarding/openRegistration"
)

const record = (over: Partial<PendingRegistrationRecord> = {}) =>
  pendingRecord({ startTime: Date.now() - 60_000, ...over })
const TOKEN = record().depositToken

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  localStorage.clear()
  capacity.availableAtomic = 40_000n * 10n ** 18n
  capacity.readFails = false
  capacity.globalLimitAtomic = undefined
  h.recordsLoading = false
  capacity.epoch += 1
  capacity.keys.length = 0
  h.termsReads.length = 0
  h.termsFail = false
  // The pending registration's own SIPA, as recorded when its address was derived.
  await seedRecordedRegistration({
    sipaAddress: SIPA,
    token: TOKEN,
    registrationFee: 10n ** 18n,
    l1ChainId: 11155111,
  })
  h.copied.length = 0
  h.writeContract.mockClear()
  h.reusePasskeyAccount.mockReset()
  h.manualRegistrationSweep.mockReset().mockResolvedValue(`0x${"5e".repeat(32)}`)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  h.processing.current = undefined
  h.l1.account = null
  h.l1.walletName = null
})

/** The page-wide wallet slot, read as the sheets read it. */
function SlotProbe() {
  return <span data-testid="wallet-slot" data-open={String(useWalletPrompt().open)} />
}

const render = (node: React.ReactElement) =>
  act(() =>
    root.render(
      <MemoryRouter>
        <ScreeningProvider screener={passThroughScreener}>
          {node}
          <SlotProbe />
        </ScreeningProvider>
      </MemoryRouter>,
    ),
  )
const buttons = () => Array.from(container.querySelectorAll("button"))

describe("DepositAddressRow", () => {
  it("copies the address untruncated, and keeps it whole for a reader", () => {
    render(<DepositAddressRow address={SIPA as never} />)
    const btn = buttons().find((b) => b.getAttribute("aria-label")?.startsWith("Copy deposit"))!
    // The design shortens what is drawn; a mistyped deposit is unrecoverable, so the whole
    // address stays reachable and is what the button puts on the clipboard.
    expect(btn.getAttribute("aria-label")).toContain(SIPA)
    expect(btn.getAttribute("title")).toBe(SIPA)
    act(() => btn.click())
    expect(h.copied).toEqual([SIPA])
  })
})

describe("registrationDepositStatus", () => {
  it.each([
    ["reserved", "Deposit received, waiting for the sweep"],
    ["received", "Registering @taga"],
    ["claiming", "Confirming on-chain"],
    ["registered", "Registered, funds on the way"],
  ] as const)("labels %s as %s", (stage, label) => {
    expect(registrationDepositStatus("taga", stage).label).toBe(label)
  })
})

describe("RegistrationDepositDetailModal", () => {
  const base = {
    terms: null,
    amount: "+11 DAI",
    feeLabel: "1 DAI",
    // The row that opens this holds the reads.
    sweepFee: 0n,
    onClose: () => {},
  }

  /** What a campaign registration stores while it is quoted the standard schedule. */
  const quotedTerms = (fee: string, earnedExpected: boolean) => ({
    account: record().account,
    tag: "taga",
    deadline: 0,
    fee,
    minDeposit: String(5n * 10n ** 18n),
    feeWaived: false,
    ...(earnedExpected ? { earnedExpected: true } : {}),
  })

  it("owes the broadcast of the unpublished address it shows once its tag is confirmed", async () => {
    resetBroadcastsForTests()
    const unpublished = record({ broadcast: false })
    render(<RegistrationDepositDetailModal record={unpublished} {...base} />)
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(getBroadcastLedger().get(SIPA)).toBeFalsy()
    act(() => confirmRegistrationTag(unpublished))
    await vi.waitFor(() =>
      expect(getBroadcastLedger().get(SIPA)).toMatchObject({ kind: "registration" }),
    )
  })

  it("offers a re-broadcast of a funded unpublished address once its broadcast is held", async () => {
    resetBroadcastsForTests()
    const unpublished = record({ broadcast: false, fundedAt: Date.now() })
    confirmRegistrationTag(unpublished)
    render(<RegistrationDepositDetailModal record={unpublished} {...base} />)
    await vi.waitFor(() => expect(getBroadcastLedger().get(SIPA)).not.toBeNull())
    await act(async () => getBroadcastLedger().markFailed(SIPA, "offline"))
    expect(container.querySelector('[data-testid="broadcast-retry"]')?.textContent).toBe(
      "Re-broadcast",
    )
  })

  it("connects a wallet, then pays the exact amount from it, while the address still needs funds", async () => {
    const pay = {
      token: TOKEN,
      chainId: 11155111,
      total: 11n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    render(<RegistrationDepositDetailModal record={record()} {...base} pay={pay} />)
    act(() =>
      buttons()
        .find((b) => b.textContent?.includes("Connect your wallet"))!
        .click(),
    )
    expect(h.l1.connect).toHaveBeenCalledTimes(1)
    expect(h.writeContract).not.toHaveBeenCalled()

    h.l1.account = "0x00000000000000000000000000000000000000aa"
    h.l1.walletName = "Rainbow"
    render(<RegistrationDepositDetailModal record={record()} {...base} pay={pay} />)
    // The address's own bucket is read before a payment may start.
    for (let i = 0; i < 6; i++) await act(async () => {})
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.includes("from Rainbow"))!
        .click(),
    )
    await act(async () =>
      buttons()
        .find((b) => b.textContent === "Confirm payment")!
        .click(),
    )
    expect(h.getL1Clients).toHaveBeenCalledWith(11155111, h.l1.account)
    expect(h.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: "transfer",
        args: [SIPA, pay.total],
      }),
    )
    expect(buttons().some((b) => b.textContent?.includes("Payment sent"))).toBe(true)
    h.l1.account = null
    h.l1.walletName = null
  })

  it("shows the per-deposit maximum under the address while it still needs funds", () => {
    const pay = {
      token: TOKEN,
      chainId: 11155111,
      total: 11n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    render(<RegistrationDepositDetailModal record={record()} {...base} pay={pay} />)
    const maximum = container.querySelector("[data-testid='deposit-terms-maximum']")
    expect(maximum?.textContent).toBe(`Deposit limit: ${LIMIT_USD} incl. fees`)
    expect(container.querySelector("[data-testid='registration-over-limit']")).toBeNull()
    // Its details open on the limit, with the basis the limit is counted on.
    act(() =>
      maximum!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!.click(),
    )
    const sheet = document.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)!
    const operation = sheet.querySelector<HTMLElement>("[data-testid='about-limits-operation']")!
    expect(sheet.querySelector("section")).toBe(operation)
    expect(operation.textContent).toContain(copy.LIMIT_NOTE)
  })

  it("holds copy and a new payment for an ask over the maximum, and keeps the address", async () => {
    // Its own address: the payment lock is session-wide, keyed by the address it pays.
    const sipa = "0x00000000000000000000000000000000000000c4"
    const pay = {
      token: TOKEN,
      chainId: 11155111,
      total: BigInt(LIMIT) * 10n ** 18n + 1n,
      tokenSymbol: "DAI",
    }
    h.l1.account = "0x00000000000000000000000000000000000000aa"
    h.l1.walletName = "Rainbow"
    try {
      render(
        <RegistrationDepositDetailModal
          record={record({ sipaAddress: sipa })}
          {...base}
          pay={pay}
        />,
      )
      const inline = container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!
      expect(inline.disabled).toBe(true)
      expect(inline.getAttribute("title")).toBe(sipa)
      expect(
        container.querySelector("[data-testid='registration-over-limit']")?.textContent,
      ).toContain(`over the ${LIMIT_USD} limit`)
      const payButton = buttons().find((b) => b.textContent?.includes("from Rainbow"))!
      expect(payButton.disabled).toBe(true)
      await act(async () => payButton.click())
      expect(h.writeContract).not.toHaveBeenCalled()
    } finally {
      h.l1.account = null
      h.l1.walletName = null
    }
  })

  describe("shared capacity of a resumed registration", () => {
    const pay = {
      token: TOKEN,
      chainId: 11155111,
      total: 11n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    const settle = async () => {
      for (let i = 0; i < 6; i++) await act(async () => {})
    }
    const panel = () => container.querySelector("[data-testid='funding-capacity-panel']")
    const payButton = () => buttons().find((b) => b.textContent?.includes("from Rainbow"))!
    // Each test pays its own address: the payment lock and the terms read are session-wide.
    let next = 0xd0
    const openFor = async (
      over: {
        forwardingTable?: `0x${string}`
        withoutOrigin?: boolean
        total?: bigint
        recovered?: boolean
        /** The record's committed fee; a refunded record without one counts as needing a refund. */
        recordFee?: string
      } = {},
    ) => {
      const sipaAddress = `0x${(next++).toString(16).padStart(40, "0")}`
      const forwardingTable =
        over.forwardingTable ?? (`0x${"77".repeat(18)}${sipaAddress.slice(-4)}` as `0x${string}`)
      await seedRecordedRegistration({
        sipaAddress,
        token: TOKEN,
        registrationFee: 10n ** 18n,
        l1ChainId: 11155111,
        forwardingTable,
        withoutOrigin: over.withoutOrigin,
        recovered: over.recovered,
      })
      render(
        <RegistrationDepositDetailModal
          record={record({ sipaAddress, ...(over.recordFee ? { fee: over.recordFee } : {}) })}
          {...base}
          pay={{ ...pay, total: over.total ?? pay.total }}
        />,
      )
      await settle()
      return forwardingTable
    }

    beforeEach(() => {
      h.l1.account = "0x00000000000000000000000000000000000000aa"
      h.l1.walletName = "Rainbow"
    })
    afterEach(() => {
      h.l1.account = null
      h.l1.walletName = null
    })

    describe("every copy control while the address takes funds", () => {
      // Each control the sheet offers to copy the address, and whether it can act now.
      const copyControls = () =>
        buttons().filter((b) => b.getAttribute("aria-label")?.startsWith("Copy deposit address"))
      const enabledCopies = () => copyControls().filter((b) => !b.disabled)
      const clickAll = async () => {
        for (const b of copyControls()) await act(async () => b.click())
      }
      const warning = () => document.querySelector("[data-testid='address-capacity-warning']")
      const recordRow = () => container.querySelector("[data-testid='registration-detail-address']")

      it("offers one copy, the gated one, when the ask fits", async () => {
        await openFor()
        expect(recordRow()?.textContent).not.toBe("")
        expect(copyControls()).toHaveLength(1)
        expect(enabledCopies()).toHaveLength(1)
        await clickAll()
        expect(h.copied).toHaveLength(1)
        expect(warning()).toBeNull()
      })

      it("offers only the gated copy for a recovered deposit the sheet asks for again", async () => {
        // A refunded standard registration, back to awaiting its deposit, shows the pay block.
        await openFor({
          total: BigInt(LIMIT) * 10n ** 18n + 1n,
          recovered: true,
          recordFee: String(10n ** 18n),
        })
        expect(container.querySelector(".ww-send-to__copy")).not.toBeNull()
        expect(recordRow()).not.toBeNull()
        expect(enabledCopies()).toHaveLength(0)
        await clickAll()
        expect(h.copied).toEqual([])
      })
    })

    it("reads the bucket of the portal its recorded table names, never the active one", async () => {
      const forwardingTable = await openFor()
      expect(h.termsReads).toEqual([forwardingTable])
      expect(capacity.keys.some((id) => id.includes(ORIGINAL_PORTAL.toLowerCase()))).toBe(true)
      expect(capacity.keys.some((id) => id.includes(FAKE_ACTIVE_KEY.portal))).toBe(false)
      expect(panel()?.className).toContain("ww-capacity--quiet")
      expect(payButton().disabled).toBe(false)
    })

    it("holds copy and payment when the ask can't fit the original bucket, and keeps the ask", async () => {
      // 11 DAI ask less the 1 DAI signed fee needs 10 DAI.
      capacity.availableAtomic = 5n * 10n ** 18n
      await openFor()
      expect(panel()?.textContent).toContain("This payment needs 10 DAI; 5 DAI is available now.")
      expect(container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!.disabled).toBe(true)
      expect(payButton().disabled).toBe(true)
      await act(async () => payButton().click())
      expect(h.writeContract).not.toHaveBeenCalled()
    })

    it("keeps capacity unknown for a record with no origin: no read, payment held, copy warns", async () => {
      await openFor({ withoutOrigin: true })
      expect(h.termsReads).toEqual([])
      expect(capacity.keys).toEqual([])
      expect(panel()?.textContent).toContain("Capacity can't be checked for this deposit.")
      expect(payButton().disabled).toBe(true)
      await act(async () =>
        container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!.click(),
      )
      expect(
        document.querySelector("[data-testid='address-capacity-warning']")?.textContent,
      ).toContain("isn't confirmed")
    })

    it("closes an open copy warning once the ask is known not to fit, and copies nothing", async () => {
      capacity.readFails = true
      await openFor()
      await act(async () =>
        container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!.click(),
      )
      expect(document.querySelector("[data-testid='address-capacity-warning']")).not.toBeNull()
      capacity.readFails = false
      capacity.availableAtomic = 5n * 10n ** 18n
      await act(async () => {
        await depositCapacityStore({
          chainId: 11155111,
          portal: ORIGINAL_PORTAL,
          token: TOKEN,
        }).retry()
      })
      await settle()
      // Acknowledging whatever is still open must not copy the held address.
      const open = document.querySelector("dialog[aria-label='Network capacity']")
      if (open) {
        await act(async () =>
          [...open.querySelectorAll("button")].find((b) => b.textContent === "Got it!")!.click(),
        )
      }
      expect(document.querySelector("dialog[aria-label='Network capacity']")).toBeNull()
      expect(container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!.disabled).toBe(true)
      expect(h.copied).toEqual([])
    })

    it("says an ask above the original bucket's ceiling can never fit", async () => {
      capacity.globalLimitAtomic = 5n * 10n ** 18n
      capacity.availableAtomic = 5n * 10n ** 18n
      await openFor()
      const notice = container.querySelector("[data-testid='registration-over-limit']")?.textContent
      expect(notice).toBe(
        "This deposit can't fit the network's deposit capacity, even when it is full.",
      )
      expect(container.querySelector<HTMLButtonElement>(".ww-send-to__copy")!.disabled).toBe(true)
    })

    it("reads as checking, not unconfirmed, while the stored records load", async () => {
      h.recordsLoading = true
      await openFor()
      expect(panel()?.textContent).toContain("Checking capacity")
      expect(panel()?.textContent).not.toContain("can't be checked")
      expect(h.termsReads).toEqual([])
      expect(payButton().disabled).toBe(true)
    })

    describe("About limits", () => {
      const openSheet = async () => {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>(
              "[data-testid='deposit-terms-maximum'] [data-testid='about-limits-link']",
            )!
            .click(),
        )
        await settle()
        const sheet = document.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)!
        return {
          sheet,
          section: sheet.querySelector<HTMLElement>("[data-testid='about-limits-capacity']")!,
          retry: () =>
            sheet.querySelector<HTMLButtonElement>("[data-testid='about-limits-capacity-retry']"),
        }
      }
      const readActive = () => capacity.keys.some((id) => id.includes(FAKE_ACTIVE_KEY.portal))
      const readOriginal = () =>
        capacity.keys.some((id) => id.includes(ORIGINAL_PORTAL.toLowerCase()))

      it("retries a failed original-terms read through the address's own reader", async () => {
        h.termsFail = true
        const forwardingTable = await openFor()
        const { section, retry } = await openSheet()
        expect(section.dataset.state).toBe("unavailable")
        expect(retry()).not.toBeNull()
        h.termsFail = false
        await act(async () => retry()!.click())
        await settle()
        expect(h.termsReads).toEqual([forwardingTable, forwardingTable])
        expect(section.dataset.state).toBe("fresh")
        expect(readOriginal()).toBe(true)
        expect(readActive()).toBe(false)
      })
    })
  })

  it("removes payment controls when the promised deposit admits the wallet", async () => {
    const original = record({
      fee: "10000000000000000000",
      sipaAddress: "0x00000000000000000000000000000000000000c5",
    })
    const pay = {
      token: TOKEN,
      chainId: 11155111,
      total: 15n * 10n ** 18n,
      tokenSymbol: "DAI",
    }
    render(
      <RegistrationDepositDetailModal
        record={original}
        {...base}
        terms={quotedTerms(original.fee!, true)}
        amount="Deposit"
        deposited="5 DAI"
        pay={pay}
      />,
    )
    expect(buttons().some((b) => b.textContent?.includes("Connect your wallet"))).toBe(true)
    const { recordDepositAdmission } = await import("../../../../src/features/identity/admission")
    await act(async () => {
      recordDepositAdmission(original, 5n * 10n ** 18n)
    })
    expect(buttons().some((b) => b.textContent?.includes("Connect your wallet"))).toBe(false)
    expect(container.textContent).toContain("Recover this deposit")
    expect(container.textContent).toContain("5 DAI")
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Copy deposit address"]')!.click(),
    )
    expect(h.copied).toContain(original.sipaAddress)
    expect(container.querySelector("a[href='/claim/taga?recovery=1']")).not.toBeNull()
    expect(h.writeContract).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='manual-sweep']")).toBeNull()
  })

  // The standard fee and the earned ask are one figure, so a registration nobody promised the
  // earned price keeps its payment controls and is never offered a recovery it does not need.
  it("keeps a standard registration on its own quote when the deposit admits the wallet", async () => {
    const standard = record({
      fee: String(5n * 10n ** 18n),
      sipaAddress: "0x00000000000000000000000000000000000000c6",
    })
    render(
      <RegistrationDepositDetailModal
        record={standard}
        {...base}
        terms={quotedTerms(standard.fee!, false)}
        amount="Deposit"
        deposited="15 DAI"
      />,
    )
    const { recordDepositAdmission } = await import("../../../../src/features/identity/admission")
    await act(async () => {
      recordDepositAdmission(standard, 15n * 10n ** 18n)
    })
    expect(container.textContent).not.toContain("Recover this deposit")
  })

  it("names no DAI when the fee token is USDC", () => {
    table.usdcFee = true
    try {
      render(
        <RegistrationDepositDetailModal
          record={record()}
          {...base}
          amount="+10 USDC"
          feeLabel="1 USDC"
          pay={{ token: TOKEN, chainId: 11155111, total: 11n * 10n ** 6n, tokenSymbol: "USDC" }}
        />,
      )
      expect(container.textContent).toContain("USDC")
      expect(container.textContent).not.toContain("DAI")
    } finally {
      table.usdcFee = false
    }
  })

  it("itemizes gross and registration fee against the credited headline", () => {
    render(
      <RegistrationDepositDetailModal
        record={record({ fundedAt: Date.now() })}
        {...base}
        amount="+10 DAI"
        deposited="11 DAI"
      />,
    )
    expect(rowById("registration-detail-deposited")).toBe("11 DAI")
    expect(rowById("registration-detail-fee")).toBe("1 DAI")
    expect(container.textContent).toContain("+10 DAI")
  })

  it("holds the deposited row open while no read has named a gross", () => {
    // The headline stands in for a figure the feed has not got; the row waits for the real one,
    // the way the funder row does.
    render(<RegistrationDepositDetailModal record={record()} {...base} amount="Deposit" />)
    expect(rowById("registration-detail-deposited")).toBeUndefined()
    expect(rowValue("Deposited")).toBe(rowValue("Funder"))
    expect(rowValue("Deposited")).not.toBe("Deposit")
  })

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  /** The manual sweep with a wallet already connected, as it must be before the passkey. */
  const clickManualSweep = async () => {
    h.l1.account = "0x00000000000000000000000000000000000000aa"
    await act(async () => byTestId("manual-sweep")!.click())
  }
  const rowById = (id: string) => byTestId(id)?.textContent ?? undefined
  /** A detail row's value, by its label: the row renders label and value as sibling spans. */
  const rowValue = (label: string) =>
    Array.from(container.querySelectorAll("span")).find((s) => s.textContent === label)
      ?.nextElementSibling?.textContent ?? undefined
  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))
  type Gate = (opts?: unknown) => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  const gatedRecovery = (then: () => unknown) =>
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return then()
      },
    )

  it("says why the deposit waits and holds the manual sweep while capacity is short", async () => {
    h.processing.current = {
      reason: {
        kind: "capacity",
        availableAtomic: 0n,
        refill: { status: "none" },
        decimals: 18,
        observedAt: Date.now(),
      },
      blocker: { kind: "capacity", observedAt: Date.now(), zeroCapacity: true },
    }
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    const reason = byTestId("deposit-pending-reason")
    expect(reason?.textContent).toContain("Waiting for network capacity")
    expect(reason?.textContent).toContain("Your funds remain at your Ethereum deposit address.")
    expect((byTestId("manual-sweep") as HTMLButtonElement).disabled).toBe(true)
    // The amounts and refill are the reason's details, on the capacity topic.
    await act(async () =>
      reason!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!.click(),
    )
    const details = document.querySelector(
      `dialog[aria-label="${copy.SHEET_TITLE}"] [data-testid='about-limits-capacity']`,
    )
    expect(details?.textContent).toContain("No network capacity is available now.")
    expect(details?.textContent).toContain("No automatic refill is configured.")
  })

  it("labels no fresh deposit delayed, and leaves the manual sweep to its own rules, when capacity cannot be read", async () => {
    h.processing.current = { reason: { kind: "unavailable", cause: "capacity-unread" } }
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    expect(byTestId("deposit-pending-reason")).toBeNull()
    expect((byTestId("manual-sweep") as HTMLButtonElement).disabled).toBe(false)
  })

  it("gives the earned-registration action its own reason and retry where no sheet states one", async () => {
    h.processing.current = {
      reason: {
        kind: "capacity",
        requiredAtomic: 9n * 10n ** 18n,
        availableAtomic: 2n * 10n ** 18n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: Date.now(),
      },
      blocker: { kind: "capacity", observedAt: Date.now() },
    }
    const attempt = { current: undefined }
    await render(<ManualSweepAction record={record()} attempt={attempt} />)
    const reason = byTestId("deposit-pending-reason")
    expect(reason?.textContent).toContain("Waiting for network capacity")
    expect(buttons().some((b) => b.textContent === "Check again")).toBe(true)
    expect((byTestId("manual-sweep") as HTMLButtonElement).disabled).toBe(true)
  })

  it("asks for the wallet before the passkey when none is connected", async () => {
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await act(async () => byTestId("manual-sweep")!.click())
    expect(byTestId("manual-sweep-connect-first")?.textContent).toBe("Connect wallet first.")
    expect(h.l1.connect).toHaveBeenCalled()
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
  })

  it("closing the modal while the held key is being adopted ends that too", async () => {
    let scope: AbortSignal | undefined
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, _gate: Gate, signal: AbortSignal) => {
        scope = signal
        await new Promise(() => {})
      },
    )
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await clickManualSweep()
    await flush()
    expect(scope?.aborted).toBe(false)
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(scope?.aborted).toBe(true)
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
  })

  it("the manual sweep holds at the phone steps until Continue", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await clickManualSweep()
    await flush()
    expect(byTestId("sign-in-sheet")).not.toBeNull()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(h.manualRegistrationSweep).toHaveBeenCalledOnce()
    expect(byTestId("sign-in-sheet")).toBeNull()
  })

  it("frees the wallet slot once the sweep is confirming, before the receipt lands", async () => {
    gatedRecovery(() => ({ secretKey: "0x1" }))
    let stage!: (stage: string) => void
    h.manualRegistrationSweep.mockImplementation(
      (_record: unknown, opts: { onStage: (stage: string) => void }) => {
        stage = opts.onStage
        opts.onStage("signing")
        return new Promise<never>(() => {})
      },
    )
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await clickManualSweep()
    await flush()
    const slotOpen = () => byTestId("wallet-slot")!.dataset.open
    expect(slotOpen()).toBe("true")
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(h.manualRegistrationSweep).toHaveBeenCalledOnce()
    expect(slotOpen()).toBe("true")
    await act(async () => stage("confirming"))
    expect(slotOpen()).toBe("false")
    expect(byTestId("manual-sweep")!.hasAttribute("disabled")).toBe(true)
  })

  it("a policy refusal on the manual sweep renders in place with a retry", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new PhoneRequiredError()
    })
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await clickManualSweep()
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("manual-sweep-refused")?.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("manual-sweep-error")).toBeNull()
    expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    await act(async () => byTestId("manual-sweep-retry")!.click())
    await flush()
    expect(byTestId("sign-in-sheet")).not.toBeNull()
  })

  it("a refusal another attempt cannot fix hides the sweep link and offers no retry", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    gatedRecovery(() => {
      throw new RotatedCredentialError()
    })
    await render(<RegistrationDepositDetailModal record={record()} {...base} />)
    await clickManualSweep()
    await flush()
    await act(async () => byTestId("sign-in-continue")!.click())
    await flush()
    expect(byTestId("manual-sweep-refused")?.dataset.reason).toBe("RotatedCredentialError")
    expect(byTestId("manual-sweep-retry")).toBeNull()
    expect(byTestId("manual-sweep")).toBeNull()
  })

  describe("passkey telemetry", () => {
    const events = () => passkeyEvents(h.fireEvent)
    let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
    /** Renders the modal this test's page load imported. */
    let show: (over?: Partial<PendingRegistrationRecord>) => Promise<void>

    /** The sweep's sign-in asks through the tracker once past the gate and waits for the test. */
    const heldRecovery = () => {
      const held: { request?: HeldRequest } = {}
      h.reusePasskeyAccount.mockImplementation(
        async (
          _w: unknown,
          _a: unknown,
          _h: unknown,
          gate: Gate,
          signal?: AbortSignal,
          own?: PasskeyRequestScope,
        ) => {
          await gate()
          held.request = harness.request("assert", signal, own)
          await held.request.settled
          return { secretKey: "0x1" }
        },
      )
      return held
    }
    const toRequest = async () => {
      const held = heldRecovery()
      await show()
      await clickManualSweep()
      await flush()
      await act(async () => byTestId("sign-in-continue")!.click())
      await flush()
      expect(held.request).toBeDefined()
    }

    beforeEach(async () => {
      // An attempt an earlier test left open ends here, before this test counts anything.
      pageHide()
      h.fireEvent.mockClear()
      // A fresh page load: its own tracker, so attempt numbers and once-per-page events start over.
      vi.resetModules()
      const fresh = await import("../../../support/session")
      fresh.openTestSession({ wallet: {} })
      const { ScreeningProvider: Screening, passThroughScreener: screener } = await import(
        "@obsidion/front-core"
      )
      const { RegistrationDepositDetailModal: Detail } = await import(
        "../../../../src/features/onboarding/RegistrationDepositDetailModal/RegistrationDepositDetailModal"
      )
      harness = await passkeyTelemetryHarness()
      show = (over = {}) =>
        act(async () => {
          root.render(
            <Screening screener={screener}>
              <Detail record={record(over)} {...base} />
            </Screening>,
          )
        })
    })

    it("closing the modal during the sweep's request is the user's cancel, sent once", async () => {
      await toRequest()
      act(() => {
        buttons()
          .find((b) => b.textContent === "x")!
          .click()
        root.unmount()
        pageHide()
      })
      root = createRoot(container)
      await flush()
      expect(events()).toEqual([
        expect.objectContaining({
          ceremony: "unlock",
          flow: "deposit",
          outcome: "cancelled",
          reason: "in_app_cancel",
          prompts: "1",
          attempt: "1",
        }),
      ])
      expect(h.manualRegistrationSweep).not.toHaveBeenCalled()
    })

    it("the sweep leaving because the registration moved on sends nothing", async () => {
      await toRequest()
      await show({ sweptAt: Date.now() })
      await flush()
      expect(byTestId("manual-sweep")).toBeNull()
      act(() => pageHide())
      expect(events()).toEqual([])
    })

    it("a cancel at the sweep's phone steps, then leaving at once, sends one in-app cancel", async () => {
      heldRecovery()
      await show()
      await clickManualSweep()
      await flush()
      act(() => {
        byTestId("sign-in-cancel")!.click()
        root.unmount()
        pageHide()
      })
      root = createRoot(container)
      await flush()
      expect(events()).toEqual([
        expect.objectContaining({
          ceremony: "unlock",
          flow: "deposit",
          outcome: "cancelled",
          reason: "in_app_cancel",
          prompts: "0",
        }),
      ])
      expect(events()[0]).not.toHaveProperty("attempt")
    })
  })

  it.each([
    ["awaiting_deposit", true],
    ["confirmed", false],
  ] as const)("a %s record shows the reservation's end: %s", (phase, shown) => {
    render(
      <RegistrationDepositDetailModal
        record={record({ phase })}
        {...base}
        terms={registrationTerms()}
      />,
    )
    expect(rowValue("Reserved until") !== undefined).toBe(shown)
  })

  it("keeps the copyable address row but no QR once the deposit is in", () => {
    render(<RegistrationDepositDetailModal record={record({ fundedAt: Date.now() })} {...base} />)
    expect(container.querySelector(".ww-deposit-address-block")).toBeNull()
    const copies = buttons().filter((b) => b.getAttribute("aria-label") === "Copy deposit address")
    expect(copies.length).toBe(1)
    act(() => copies[0].click())
    expect(h.copied).toEqual([SIPA])
  })
})

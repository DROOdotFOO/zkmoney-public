import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HistoricResidualSummary } from "../../../src/features/migration/historicResiduals"
import type { MigrationSourceQuote } from "@obsidion/sdk"
import { startTabBoundOperation } from "../../support/operations"

const BOOTED_PORTAL = "0x" + "AA".repeat(20)
const ACCOUNT = { getAddress: () => ({ toString: () => "0xabc" }) }

const h = vi.hoisted(() => ({
  networkReady: true,
  probe: vi.fn(),
  reconcile: vi.fn(),
  live: vi.fn(),
  metadataSession: vi.fn(),
  runMetadata: vi.fn(),
  aztec: { obsidionWallet: {} },
  account: { obsidionAccount: {} as unknown },
  asset: { current: { tokenService: undefined as unknown, loadAssets: async () => {} } },
  contracts: { contractService: {} },
  railPending: undefined as boolean | undefined,
  railReadFailed: false,
  balance: { main: 0n, known: true },
  savings: { position: null as { value: bigint } | null },
  registrations: [] as { l2Address: string }[],
  demo: false,
  tokenCreate: vi.fn(),
  featureListed: vi.fn(async () => false),
  recordStale: vi.fn(),
  oldVersionsRead: vi.fn(),
  event: vi.fn(),
  /** A saved run's storage key by source portal; one key for every source when absent. */
  keyFor: undefined as undefined | ((portal: string) => string),
}))

// A real notification store on memory, so a dismiss and the next scan's report meet as they would.
// `store` reads an entry with its words; `upsert` sees every report the mount makes, worded.
type Row = { id: string; title: string; description: string; dismissedAt?: number }
const notes = vi.hoisted(() => ({
  store: undefined as unknown as {
    get(id: string): (Row & Record<string, unknown>) | null
    upsert(row: Row): void
    remove(id: string): void
    dismiss(id: string): void
  },
  bell: undefined as unknown as import("@obsidion/front-core").Notifications,
}))
vi.mock("../../../src/platform/session", async () => {
  const core = await import("@obsidion/front-core")
  const { notificationText } = await import("../../../src/ui/notificationText")
  const bell = core.createNotifications(core.openDatabase(core.memoryBackend()))
  // Watched, as the session's are, so its loaded records follow its writes.
  bell.state.subscribe(() => {})
  bell.events.subscribe(() => {})
  const none = { records: [], hydrated: true }
  const sources = {
    rows: [],
    oldVersionWithdrawals: [],
    deposits: none,
    withdrawals: none,
    upgrades: { items: [], recipients: new Set<string>(), loaded: true },
    processing: new Map(),
    registrations: [],
    operations: { ended: [], running: [] },
    loaded: true,
  }
  const get = (id: string) => {
    const entry = core
      .deriveNotifications(sources, bell.events.get(), Date.now())
      .find((e) => e.id === id)
    if (!entry) return null
    const dismissedAt = bell.state.get().get(id)?.dismissedAt
    return { ...entry, ...notificationText(entry), dismissedAt }
  }
  const { report, retract } = bell
  notes.store = {
    get,
    upsert: () => {},
    remove: (id) => void retract(id),
    dismiss(id) {
      void bell.observe([{ id }], [], Date.now(), true)
      void bell.dismiss([id])
    },
  }
  bell.report = async (event) => {
    await report(event)
    notes.store.upsert(get(event.id)!)
  }
  bell.retract = async (id) => notes.store.remove(id)
  notes.bell = bell
  // Stable, like the session's: effects follow it.
  const milestones = {
    after: async () => true,
    mark: (m: string) => void (m === "oldVersionsRead" && h.oldVersionsRead()),
    progress: () => {},
  }
  const { balancesOf } = await import("../../support/balances")
  // The page's wallet, the account, the token and the balances, read at each render.
  return {
    useSession: () => ({
      notifications: bell,
      milestones,
      wallet: core.fixed("wallet", h.aztec.obsidionWallet),
      account: core.fixed("account", h.account.obsidionAccount),
      token: core.fixed("token", h.asset.current.tokenService),
      balances: balancesOf(h.balance),
    }),
  }
})
vi.mock("@obsidion/front-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@obsidion/front-core")>()
  return {
    ...real,
    // A sync the mount asks for lands in the test's `loadAssets`.
    WalletSyncCoordinator: Object.assign(Object.create(real.WalletSyncCoordinator), {
      refresh: () => h.asset.current.loadAssets(),
    }),
    useSavingsPosition: () => h.savings,
    useContractServiceContext: () => h.contracts,
    checkSpentViaPaylinkService: () => async () => new Map(),
    runMetadataMigration: h.runMetadata,
    readSavingsVault: async () => "0x" + "0e".repeat(20),
    // One sUSDS is worth 1.2 DAI.
    readSavingsPrice: async () => ({ sharePrice: 12n * 10n ** 17n }),
  }
})
// The DS drags in liquid-glass optics jsdom can't render; these tests are about the sheet's content.
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
    testId,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
    testId?: string
  }) => (
    <button disabled={isDisabled} onClick={onClick} data-testid={testId}>
      {title}
    </button>
  ),
  DestructiveActionButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: () => null,
  Icon: () => null,
  GradientSpinner: () => null,
  ProgressSpinner: () => null,
  Shimmer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label} {value}
    </div>
  ),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {},
  TokenService: { create: h.tokenCreate },
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../../src/features/cutover/networkReady", () => ({
  useNetworkReady: () => h.networkReady,
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0x" + "AA".repeat(20) } }),
  fetchLiveProfilePortal: h.live,
}))
vi.mock("../../../src/features/migration/probeAccountResiduals", () => ({
  probeAccountResiduals: h.probe,
  reconcilePendingPaylinks: h.reconcile,
  migrationFeatureListed: h.featureListed,
}))
vi.mock("../../../src/features/migration/createWebMetadataMigration", () => {
  const create = async (...args: unknown[]) => ({
    holdings: async () => true,
    ...(await h.metadataSession(...args)),
  })
  return {
    createWebMetadataMigration: create,
    // As the real one: a manifest that can't be read is read again, with each failure reported.
    createWebMetadataMigrationQuietly: async (
      params: unknown,
      signal: AbortSignal,
      _retryMs?: number,
      onUnavailable?: () => void,
    ) => {
      for (;;) {
        try {
          return await create(params)
        } catch (error) {
          if ((error as Error).name !== "ManifestUnavailableError" || signal.aborted) throw error
          onUnavailable?.()
          await new Promise((resolve) => setTimeout(resolve, 60_000))
        }
      }
    },
    webAccountRecordStale: () => h.recordStale(),
    webMetadataMigrationKey: (current: { portal: string }, historic: { portal: string }) =>
      h.keyFor?.(historic.portal) ??
      (historic.portal.toLowerCase() === current.portal.toLowerCase()
        ? "migration-registration"
        : "migration-test"),
  }
})
vi.mock("../../../src/features/onboarding/sponsoredRailReadiness", () => ({
  useSponsoredRailPending: () => h.railPending,
  useSponsoredRailReadFailed: () => h.railReadFailed,
}))
vi.mock("../../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/webRegistration")>()),
  getPendingStore: () => ({ load: async () => {}, list: () => h.registrations }),
}))
vi.mock("../../../src/dev/demoFlag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/dev/demoFlag")>()),
  isDemoMode: () => h.demo,
}))
const freeze = vi.hoisted(() => ({ onFrozen: () => {} }))
vi.mock("../../../src/features/migration/freezeWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/migration/freezeWatch")>()),
  watchForFreeze: (_tuples: unknown, onFrozen: () => void) => {
    freeze.onFrozen = onFrozen
    return () => {}
  },
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent: h.event,
}))

const { showReportableError } = await import("../../../src/errors/errorModal")
const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
const { walletStorage } = await import("../../../src/platform/storage/walletStorage")
const { getOperationStore } = await import("../../../src/features/operations/operations")
await import("../../../src/features/notifications/notifications")
const upsert = vi.spyOn(notes.store, "upsert")
const dismiss = vi.spyOn(notes.store, "dismiss")
const remove = vi.spyOn(notes.store, "remove")
const residualsRow = () => notes.store.get("migration:residuals")
/** Every write to the residuals row, so other rows' writes don't count. */
const residualsWrites = () =>
  [...upsert.mock.calls.map(([row]) => row.id), ...remove.mock.calls.map(([id]) => id)].filter(
    (id) => id === "migration:residuals",
  )
const { MigrationDetectionMount, PROFILE_REPOINT_POLL_MS, RECORD_CHECK_WAIT_MS } = await import(
  "../../../src/features/migration/MigrationDetectionMount/MigrationDetectionMount"
)
const { openMigrationDialog, useUpgradeStatus } = await import(
  "../../../src/features/migration/migrationDialog"
)
const { UpgradeKeepOpenBanner } = await import("../../../src/features/migration/UpgradeIntro")
const { markOldHoldingsRead, markUpgradeMovesFunds, oldVersionScope, useOldVersionHoldings } =
  await import("../../../src/features/migration/oldVersionBalance")
const { BalanceStorage } = await import("@obsidion/front-core")
const { ManifestUnavailableError } = await import("../../../src/features/migration/freezeWatch")
const { acquireUpgradeLock, upgradeLock } = await import(
  "../../../src/features/migration/upgradeLock"
)
const { resetApprovals } = await import("../../../src/features/migration/approvalGate")

const incomplete: HistoricResidualSummary = {
  tuple: { portal: "0x" + "01".repeat(20), l2Token: "0x" + "01".repeat(32) } as never,
  balance: 0n,
  frozen: false,
  sweptDeposits: 0,
  inTransitDeposits: 0,
  inTransitAmount: 0n,
  waitingDeposits: 0,
  waitingAmount: 0n,
  paylinkEscrows: 0,
  lockedPaylinks: [],
  paylinkCandidates: [],
  frozenLinks: [],
  incomplete: true,
  hasResiduals: true,
  awaitingFreeze: false,
}

let container: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  h.networkReady = true
  h.railPending = undefined
  h.railReadFailed = false
  h.registrations = []
  h.demo = false
  h.keyFor = undefined
  h.savings = { position: null }
  h.account.obsidionAccount = ACCOUNT
  walletStorage.removeItem("webwallet.upgradeLock/0xabc")
  walletStorage.removeItem("webwallet.version/0xabc")
  h.probe.mockResolvedValue(null)
  h.recordStale.mockResolvedValue(false)
  // 1 Choose shows once a session: these tests start from the offer.
  sessionStorage.setItem("zkm:upgrade-choose-shown", "1")
  sessionStorage.setItem("zkm:upgrade-moving-shown", "1")
  sessionStorage.setItem("zkm:upgrade-reopen-shown", "1")
  h.reconcile.mockResolvedValue(undefined)
  h.live.mockResolvedValue(BOOTED_PORTAL.toLowerCase())
  h.asset.current = { tokenService: undefined, loadAssets: async () => {} }
  client = new QueryClient()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  resetApprovals()
  act(() => root.unmount())
  client.clear()
  container.remove()
  vi.useRealTimers()
})

let upgradeStatus = () => ({} as ReturnType<typeof useUpgradeStatus>)
function Status() {
  const status = useUpgradeStatus()
  upgradeStatus = () => status
  return null
}

/** Mounts, then asks for the dialog as Home's banner does, unless `request` is false. */
async function render({ request = true } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MigrationDetectionMount />
        </MemoryRouter>
        <Status />
      </QueryClientProvider>,
    )
  })
  if (request) await act(async () => openMigrationDialog())
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PROFILE_REPOINT_POLL_MS)
    await vi.advanceTimersByTimeAsync(50)
  })
}

const repointModal = () => container.querySelector('[data-testid="migration-repoint-modal"]')

const withTokenService = () => {
  h.asset.current = { tokenService: {}, loadAssets: async () => {} }
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label)
const retryButton = () => button("Try again")
/** The dialog alone, without the upgrade's screens. */
const dialog = () => document.querySelector('[data-testid="migration-detected-modal"]')
/** The dialog, or the page holding the upgrade's screens and sheets. */
const detectedModal = () =>
  document.querySelector('[data-testid="migration-detected-modal"]') ??
  (document.querySelector(".ww-cutover, .ww-cutover-sheet__body") ? document.body : null)
const upgradeSheet = () => document.querySelector('[data-testid="cutover-move-funds"]')
/** A figures card on `testId`'s page or sheet. */
const figuresCard = (testId: string) =>
  !!document.querySelector(`[data-testid="${testId}"] .ww-cutover__details`)
/** Closes the open sheet as Escape does. */
async function closeSheet() {
  await act(async () => {
    document
      .querySelector(".ww-cutover-sheet__body")!
      .closest("dialog")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
}
/** The offer's start: the dialog's, or 2 Sign's in the full-screen upgrade. */
const upgradeButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="cutover-confirm-upgrade"]') ??
  button("Upgrade now") ??
  button("Confirm with passkey")
/** A stopped run's way on: a reopen screen's (S1 to S3), else the dialog's. */
const continueButton = () =>
  button("Resume") ??
  button("Retry") ??
  button("Start again") ??
  button("Continue upgrade") ??
  button("Approve and continue") ??
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Continue approving"),
  )
/** The Upgrading page's steps, as title and state. */
const upgradeSteps = () =>
  [...document.querySelectorAll('[data-testid="cutover-steps"] li')].map((li) => [
    li.querySelector("b")?.textContent,
    li.getAttribute("data-state"),
  ])
/** Continues a stopped run, through 2 Sign when S1 starts it again. */
async function continueStopped() {
  const start = !!button("Start again")
  await act(async () => continueButton()!.click())
  if (start) await act(async () => upgradeButton()!.click())
}
/** 2 Sign's first step, which counts the passkey approvals the upgrade asks for. */
const passkeyTimes = (n: number) =>
  `Confirm with passkey ${
    ["once", "twice", "three times", "four times", "five times", "six times"][n - 1]
  }`
/** Starts the upgrade from 1 Choose through 2 Sign, from an open 2 Sign, or from the dialog. */
async function startUpgrade() {
  const choose = document.querySelector<HTMLButtonElement>('[data-testid="cutover-upgrade"]')
  if (choose && !upgradeSheet()) await act(async () => choose.click())
  await act(async () => upgradeButton()!.click())
}

describe("MigrationDetectionMount — the record update with nothing to move", () => {
  const registrationService = () => ({
    needsMigration: async () => true,
    consentApprovals: async () => 1,
  })
  const probed = () =>
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [],
      residuals: [],
      pendingWithdrawals: 0,
    })

  it("offers the upgrade, counting the record update's one approval and a free network fee", async () => {
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: registrationService(),
    })
    probed()
    await render()
    const text = detectedModal()?.textContent
    expect(figuresCard("cutover-move-funds")).toBe(false)
    expect(text).toContain(passkeyTimes(1))
    expect(text).not.toContain("Deposit")
    expect(button("Withdraw funds instead")).toBeUndefined()
    expect(upgradeButton()).toBeDefined()
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
  })

  it("ends on Upgrade complete without a balance, as nothing moved", async () => {
    withTokenService()
    const needsMigration = vi.fn(async () => true)
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: { ...registrationService(), needsMigration },
    })
    h.railPending = false
    probed()
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) => {
      if (opts.prepareOnly) return { phase: "broadcasting", plan: "signed-plan" }
      needsMigration.mockResolvedValue(false)
      return { phase: "done", plan: "signed-plan" }
    })
    try {
      await render()
      await startUpgrade()
      await act(async () => vi.advanceTimersByTimeAsync(50))
      expect(document.querySelector('[data-testid="cutover-upgrade-done"]')).not.toBeNull()
      expect(figuresCard("cutover-upgrade-done")).toBe(false)
    } finally {
      h.railPending = undefined
      h.runMetadata.mockReset()
    }
  })

  it("holds Main without the old version's dust, which the upgrade leaves behind", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    h.balance = { main: 2n * 10n ** 18n, known: true }
    const dust: HistoricResidualSummary = {
      ...incomplete,
      tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
      frozen: true,
      incomplete: false,
      balance: 10n ** 17n,
    }
    await BalanceStorage.get(webStorage).updateBalance(
      oldVersionScope(dust.tuple.portal, "0xabc"),
      dust.tuple.l2Token,
      10n ** 17n,
    )
    withTokenService()
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        ...registrationService(),
        quote: async () => ({ movable: 0n, stranded: 10n ** 17n, waiting: 0n }),
      },
      holdings: async () => true,
    })
    h.runMetadata.mockImplementationOnce(async () => null)
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [dust.tuple],
      residuals: [dust],
      pendingWithdrawals: 0,
    })
    try {
      await render()
      await startUpgrade()

      expect(upgradeLock("0xabc")).toEqual({ state: "held", main: 2n * 10n ** 18n })
    } finally {
      h.balance = { main: 0n, known: true }
      walletStorage.removeItem("webwallet.identity")
      walletStorage.removeItem(`webwallet.oldHoldingsRead/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(dust.tuple.portal, "0xabc"),
        dust.tuple.l2Token,
        0n,
      )
    }
  })
})

describe("MigrationDetectionMount — a registration run left at boot", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const registration = (over: Record<string, unknown> = {}) => ({
    phase: "awaitingMessages",
    plan: JSON.stringify({ sourceState: "empty" }),
    bootstrapTx: "0x" + "b0".repeat(32),
    ...over,
  })
  let snapshot: Record<string, unknown> | null
  let publish: () => void
  let restore = () => {}
  const saved = (record: Record<string, unknown> | null, key = "migration-registration") => {
    const read = webStorage.getItem.bind(webStorage)
    const spy = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (k) =>
        k === key ? (record ? JSON.stringify(record) : null) : read(k),
      )
    restore = () => spy.mockRestore()
  }
  type RunOptions = {
    signal: AbortSignal
    promptless?: boolean
    observeOnly?: boolean
    exclusive?: <T>(step: (operationId?: string) => Promise<T>) => Promise<T>
  }
  const runs = () => h.runMetadata.mock.calls.map(([, opts]) => opts as RunOptions)
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(snapshot)))
  beforeEach(async () => {
    withTokenService()
    snapshot = null
    publish = () => {}
    await notes.store.remove("migration:run")
    h.metadataSession.mockResolvedValue({
      controller: {
        load: async () => publish(),
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          publish = listener
          return () => {}
        },
      },
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
    })
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
  })
  afterEach(() => {
    restore()
    h.keyFor = undefined
  })

  it("carries a run left at boot to the end with no click and no prompt, each step in the background", async () => {
    snapshot = registration()
    saved(snapshot)
    let step: unknown
    h.runMetadata.mockImplementationOnce(async (_c: unknown, opts: RunOptions) => {
      await opts.exclusive!(async (operationId) => {
        step = getOperationStore().get(operationId!)
      })
      return { ...snapshot, phase: "done" }
    })
    const loadAssets = vi.fn(async () => {})
    h.asset.current = { tokenService: {}, loadAssets }
    await render({ request: false })
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ promptless: true })
    expect(runs()[0]!.observeOnly).toBeUndefined()
    expect(step).toMatchObject({ flow: "migration", state: "local", background: true })
    expect(loadAssets).toHaveBeenCalled()
    expect(notes.store.get("migration:run")).toBeNull()
  })

  it("shows the followed run as running, and never starts it again", async () => {
    snapshot = registration()
    saved(snapshot)
    h.runMetadata.mockImplementationOnce((_c: unknown, opts: RunOptions) =>
      untilAborted(opts.signal),
    )
    await render()
    expect(upgradeStatus()).toMatchObject({ state: "running", phase: "awaitingMessages" })
    expect(notes.store.get("migration:run")).toBeNull()
    expect(upgradeButton()).toBeUndefined()
    expect(runs()).toHaveLength(1)
  })

  it("reads the saved runs once a follower can start, and is still checking until then", async () => {
    snapshot = registration({ phase: "arriving" })
    saved(snapshot)
    await acquireUpgradeLock("0xabc")
    h.runMetadata.mockImplementationOnce((_c: unknown, opts: RunOptions) =>
      untilAborted(opts.signal),
    )
    h.asset.current = { tokenService: undefined, loadAssets: async () => {} }
    await render()
    expect(upgradeStatus().state).toBe("checking")
    expect(detectedModal()?.textContent ?? document.body.textContent).toContain(
      "Still checking your funds on an old version.",
    )
    expect(document.body.textContent).not.toContain("Nothing is left")

    withTokenService()
    await render({ request: false })
    expect(runs()).toHaveLength(1)
    expect(upgradeStatus().state).toBe("running")
  })

  it("reads a follower that failed as a failed check, never as a paused run", async () => {
    snapshot = registration()
    saved(snapshot)
    h.runMetadata.mockRejectedValueOnce(new Error("session lost"))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
  })

  it("never offers to start a run its follower is still opening", async () => {
    snapshot = registration()
    saved(snapshot)
    h.metadataSession.mockImplementation(async () => ({
      controller: {
        load: () => new Promise(() => {}),
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      },
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
    }))
    await render()
    expect(upgradeButton()).toBeUndefined()
    expect(h.runMetadata).not.toHaveBeenCalled()
  })

  describe("beside an old version's saved run", () => {
    const old = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    const oldRun = {
      plan: JSON.stringify({ sourceState: "frozen", recoveryOnly: true }),
      phase: "broadcasting",
    }
    const residual: HistoricResidualSummary = {
      ...incomplete,
      tuple: old as never,
      frozen: true,
      incomplete: false,
      sweptDeposits: 1,
    }
    const both = (registrationRun: Record<string, unknown>, oldVersionRun = oldRun) => {
      h.keyFor = (portal) => `migration-test/${portal.toLowerCase()}`
      const records: Record<string, unknown> = {
        [`migration-test/${current.portal.toLowerCase()}`]: registrationRun,
        [`migration-test/${old.portal.toLowerCase()}`]: oldVersionRun,
      }
      const read = webStorage.getItem.bind(webStorage)
      const spy = vi
        .spyOn(webStorage, "getItem")
        .mockImplementation(async (k) => (k in records ? JSON.stringify(records[k]) : read(k)))
      restore = () => spy.mockRestore()
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => null,
          subscribe: () => () => {},
        },
        service: {
          needsMigration: async () => true,
          consentApprovals: async () => 1,
          quote: async () => ({
            movable: 10n ** 18n,
            stranded: 0n,
            waiting: 0n,
            approvals: 1,
            fees: 0n,
          }),
        },
      }))
      h.probe.mockResolvedValue({
        current,
        historic: [old],
        residuals: [residual],
        pendingWithdrawals: 0,
      })
    }
    type Controller = { historic: { portal: string } }
    const portals = (filter: (opts: RunOptions) => boolean) =>
      h.runMetadata.mock.calls
        .filter(([, opts]) => filter(opts as RunOptions))
        .map(([controller]) => (controller as Controller).historic.portal)

    // Each run's controller shows the phase the test sends it.
    const sendingRuns = async () => {
      const sending: Record<string, Record<string, unknown>> = {}
      const listeners: (() => void)[] = []
      const service = (await h.metadataSession.getMockImplementation()!({ historic: old } as never))
        .service
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => sending[historic.portal] ?? null,
          subscribe: (listener: () => void) => {
            listeners.push(listener)
            return () => {}
          },
        },
        service,
      }))
      const send = (portal: string, phase: string) => {
        sending[portal] = { phase, plan: "signed" }
        for (const listener of listeners) listener()
      }
      return { sending, send }
    }

    it("follows a sent registration run in the background and leaves it out of Continue", async () => {
      both(registration())
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
        opts.observeOnly || opts.promptless
          ? untilAborted(opts.signal)
          : { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" },
      )
      await render()
      // The registration run is followed; the old version's run waits on the user.
      expect(portals((opts) => !!opts.promptless)).toEqual([current.portal])
      await continueStopped()
      const queued = portals((opts) => !opts.observeOnly && !opts.promptless)
      expect(queued).toContain(old.portal)
      expect(queued).not.toContain(current.portal)
    })

    it("shows a resumed registration run's approvals with the old version's", async () => {
      both(
        registration({
          phase: "needsApproval",
          bootstrapTx: undefined,
          summary: { fees: "0", approvals: 1 },
        }),
      )
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions) => untilAborted(opts.signal))
      await render()
      expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
      await act(async () => button("Start again")!.click())
      expect(detectedModal()?.textContent).toContain(passkeyTimes(2))
    })

    it("offers a reload's run mid-approvals counted with the registration run's, and Continue leads with it", async () => {
      both(
        registration({
          phase: "broadcasting",
          bootstrapTx: undefined,
          approvals: { approved: 1, total: 1 },
        }),
        { ...oldRun, phase: "preparing", approvals: { approved: 1, total: 5 } } as never,
      )
      h.runMetadata.mockImplementation(async (_c, opts: RunOptions & { prepareOnly?: boolean }) =>
        opts.observeOnly || opts.promptless
          ? untilAborted(opts.signal)
          : { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" },
      )
      await render()
      // One count over the upgrade: the record update's approval, then the old version's five.
      await continueStopped()
      expect(portals((opts) => !opts.observeOnly && !opts.promptless).slice(0, 2)).toEqual([
        current.portal,
        old.portal,
      ])
    })

    it("shows the account's update first, then the old version's withdrawal, as the queue sends", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      const { sending, send } = await sendingRuns()
      let registered!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === old.portal) {
            send(old.portal, "recovering")
            return untilAborted(opts.signal)
          }
          send(current.portal, "subscribing")
          await new Promise<void>((resolve) => (registered = resolve))
          send(current.portal, "arriving")
          return sending[current.portal]
        },
      )
      await render()
      await continueStopped()
      expect(upgradeSteps()).toEqual([
        ["Update your account", "active"],
        ["Withdraw from old wallet", "pending"],
        ["Deposit to new wallet", "pending"],
      ])
      await act(async () => registered())
      expect(upgradeSteps()).toEqual([
        ["Update your account", "done"],
        ["Withdraw from old wallet", "active"],
        ["Deposit to new wallet", "pending"],
      ])
    })

    it("never moves the ring back once the queue hands its last run to the follower", async () => {
      both(registration({ phase: "needsApproval", error: "needs you", bootstrapTx: undefined }))
      const { sending, send } = await sendingRuns()
      let handOff!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === current.portal) {
            send(current.portal, "done")
            return sending[current.portal]
          }
          send(old.portal, "arriving")
          await new Promise<void>((resolve) => (handOff = resolve))
          return sending[old.portal]
        },
      )
      await render()
      await continueStopped()
      // One run done, one arriving.
      expect(detectedModal()?.textContent).toContain("93%")
      await act(async () => handOff())
      expect(detectedModal()?.textContent).toContain("93%")
    })

    it("never moves the steps back while the check after the last run's arrival answers", async () => {
      const registrationRun = registration({
        phase: "needsApproval",
        error: "needs you",
        bootstrapTx: undefined,
      })
      const oldVersionRun = { ...oldRun }
      both(registrationRun, oldVersionRun)
      const { sending, send } = await sendingRuns()
      const service = (await h.metadataSession.getMockImplementation()!({ historic: old } as never))
        .service
      let arrive!: () => void
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly && c.historic.portal === old.portal) {
            await new Promise<void>((resolve) => (arrive = resolve))
            return { plan: "signed", phase: "done" }
          }
          if (opts.observeOnly || opts.promptless) return untilAborted(opts.signal)
          if (opts.prepareOnly) return { plan: "signed", phase: "broadcasting" }
          if (c.historic.portal === current.portal) {
            send(current.portal, "done")
            return sending[current.portal]
          }
          send(old.portal, "arriving")
          return sending[old.portal]
        },
      )
      await render()
      await continueStopped()
      h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
      service.needsMigration = () => new Promise(() => {})
      // Both runs saved as done, as the real runs save them.
      Object.assign(registrationRun, { phase: "done" })
      Object.assign(oldVersionRun, { phase: "done" })
      await act(async () => arrive())
      expect(upgradeSteps()).toEqual([
        ["Update your account", "done"],
        ["Withdraw from old wallet", "done"],
        ["Deposit to new wallet", "active"],
      ])
    })

    it("queues a registration run its follower left stopped ahead of an old version's run that stopped after it", async () => {
      both(registration(), { ...oldRun, phase: "waiting" })
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      h.runMetadata.mockImplementation(
        async (c: Controller, opts: RunOptions & { prepareOnly?: boolean }) => {
          if (opts.observeOnly) return untilAborted(opts.signal)
          if (!opts.promptless)
            return { plan: "signed", phase: opts.prepareOnly ? "broadcasting" : "arriving" }
          if (c.historic.portal === current.portal)
            return registration({ phase: "needsAttention", error: "The relayer is down" })
          await released
          return { ...oldRun, phase: "needsApproval", error: "needs you" }
        },
      )
      await render()
      await act(async () => release())
      await continueStopped()
      expect(portals((opts) => !opts.observeOnly && !opts.promptless).slice(0, 2)).toEqual([
        current.portal,
        old.portal,
      ])
    })
  })
})

describe("MigrationDetectionMount — frozen sources", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    frozen: true,
    incomplete: false,
    ...over,
  })
  const session = (quote: Partial<MigrationSourceQuote>) =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 0n, stranded: 0n, waiting: 0n, ...quote }),
        needsMigration: async () => false,
      },
    })
  const probe = (residual: HistoricResidualSummary) =>
    h.probe.mockResolvedValue({
      current,
      historic: [residual.tuple],
      residuals: [residual],
      pendingWithdrawals: 0,
    })

  it("waits for a frozen source's migration feature, and offers it once the manifest lists one", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n, fees: 0n, approvals: 1 })
    const waiting = frozen({ balance: 5n * 10n ** 18n, awaitingFeature: true })
    probe(waiting)
    await render()
    const quoted = h.metadataSession.mock.calls.map(([args]) => args.historic?.portal)
    expect(quoted).not.toContain(waiting.tuple.portal)
    expect(upgradeButton()).toBeUndefined()
    expect(document.body.textContent).toContain(
      "$5.00 is on the old version and can upgrade once the new version is ready",
    )
    expect(residualsRow()).toMatchObject({
      description: "$5.00 on the old version. You can upgrade it once the new version is ready.",
    })

    // Each poll reads only the manifest: no probe runs while it lists no route.
    const probes = h.probe.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.featureListed).toHaveBeenCalledWith([{ source: waiting.tuple, destination: current }])
    expect(h.probe.mock.calls.length).toBe(probes)

    // The manifest gains the feature: the poll sees it and the probe runs once more.
    h.featureListed.mockResolvedValueOnce(true)
    probe({ ...waiting, awaitingFeature: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe.mock.calls.length).toBeGreaterThan(probes)
    expect(upgradeButton()).toBeDefined()

    // No source waits now, so the watch stops.
    const after = h.probe.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(h.probe.mock.calls.length).toBe(after)
  })

  it("counts the unclaimed deposits of a waiting source in its waiting line", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n })
    probe(frozen({ sweptDeposits: 2, awaitingFeature: true }))
    await render()
    const text = document.body.textContent
    expect(text).toContain(
      "2 unclaimed deposits are on the old version and can upgrade once the new version is ready",
    )
    expect(text).not.toContain("can't be moved now")
    expect(residualsRow()).toMatchObject({
      description:
        "2 unclaimed deposit(s) on the old version. You can upgrade them once the new version is ready.",
    })
  })

  it("names a waiting source's balance and its deposits in one line", async () => {
    withTokenService()
    session({ movable: 5n * 10n ** 18n })
    probe(frozen({ balance: 5n * 10n ** 18n, sweptDeposits: 1, awaitingFeature: true }))
    await render()
    expect(document.body.textContent).toContain(
      "$5.00 and an unclaimed deposit are on the old version and can upgrade once the new version is ready",
    )
    expect(document.body.textContent).not.toContain("can't be moved now")
  })

  it("names dust under a cent as such, never as nothing", async () => {
    withTokenService()
    session({ stranded: 1n })
    probe(frozen({ balance: 1n }))
    await render()
    expect(residualsRow()).toMatchObject({ description: "<$0.01 too small to move" })
  })

  it("names a frozen balance a destination without the metadata flow cannot take", async () => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: { ...current, accountMetadataRegistry: undefined },
      historic: [incomplete.tuple],
      residuals: [frozen({ balance: 5n * 10n ** 17n })],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()).toBeNull()
    expect(h.metadataSession).not.toHaveBeenCalled()
    expect(residualsRow()).toMatchObject({ description: "$0.50 on a frozen version" })
  })

  it("values sUSDS sources in dollars and moves each source into its paired destination", async () => {
    withTokenService()
    const DAI = 10n ** 18n
    const savings = { ...current, portal: "0x" + "03".repeat(20), l2Token: "0x" + "04".repeat(32) }
    const dai = frozen({ tuple: { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) } as never })
    const susds = frozen({
      tuple: { ...incomplete.tuple, portal: "0x" + "0b".repeat(20) } as never,
    })
    h.tokenCreate.mockResolvedValue("savings-token-service")
    h.metadataSession.mockImplementation(async ({ historic }) => ({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({
          movable: historic.portal === dai.tuple.portal ? 100n * DAI : 10n * DAI,
          stranded: 0n,
          waiting: 0n,
          fees: DAI,
          approvals: 1,
        }),
        needsMigration: async () => false,
      },
    }))
    h.probe.mockResolvedValue({
      current,
      historic: [dai.tuple, susds.tuple],
      destinations: new Map([
        [susds.tuple.portal.toLowerCase(), { tuple: savings, symbol: "sUSDS" }],
      ]),
      residuals: [
        { ...dai, sweptDeposits: 1 },
        { ...susds, sweptDeposits: 1 },
      ],
      pendingWithdrawals: 0,
    })
    await render()
    const text = detectedModal()?.textContent
    expect(text).not.toContain("network fees")
    expect(text).toContain(passkeyTimes(2))
    expect(text).not.toContain("Also there: $12.00 on another old version.")
    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({ historic: dai.tuple, current, toTokenService: {} }),
    )
    expect(h.metadataSession).toHaveBeenCalledWith(
      expect.objectContaining({
        historic: susds.tuple,
        current: savings,
        toTokenService: "savings-token-service",
      }),
    )
    // One click prepares both assets before it sends either asset.
    h.runMetadata.mockImplementation(async (_controller, options) => ({
      plan: "signed-plan",
      phase: options.prepareOnly ? "broadcasting" : "done",
    }))
    h.probe.mockResolvedValue({
      current,
      historic: [],
      destinations: new Map(),
      residuals: [],
      pendingWithdrawals: 0,
    })
    h.metadataSession.mockClear()
    await startUpgrade()
    expect(h.metadataSession.mock.calls[0]![0]).toMatchObject({ historic: dai.tuple, current })
    expect(h.metadataSession.mock.calls[1]![0]).toMatchObject({
      historic: susds.tuple,
      current: savings,
      recoveryOnly: true,
    })
    expect(h.metadataSession.mock.calls[0]![0].recoveryOnly).toBe(true)
    const steps = h.runMetadata.mock.calls
      .filter(([, options]) => !options.observeOnly && !options.approvalsOnly)
      .map(([, options]) => ({ prepare: !!options.prepareOnly, prompts: options.prompts }))
    expect(steps).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
      { prepare: false, prompts: false },
    ])
  })

  it("names deposits that wait for L1 finality", async () => {
    withTokenService()
    session({})
    probe(frozen({ waitingDeposits: 2, waitingAmount: 20n * 10n ** 18n }))
    await render()
    expect(detectedModal()).toBeNull()
    expect(residualsRow()).toMatchObject({ description: "$20.00 waiting on the old network" })
  })

  describe("with a saved run on one of two sources", () => {
    const a = { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) }
    const b = { ...incomplete.tuple, portal: "0x" + "0b".repeat(20) }
    const DAI = 10n ** 18n
    let restore = () => {}
    afterEach(() => restore())
    /** `b`'s run is saved; `a` comes first among the residuals, so it would be the first movable. */
    async function resume(
      phase: string,
      quotes: { a: bigint; b: bigint },
      stranded: { a?: bigint; b?: bigint } = {},
    ) {
      withTokenService()
      const calls: Array<[string, boolean | undefined]> = []
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async () => {
            const which = historic.portal === a.portal ? "a" : "b"
            calls.push([which, undefined])
            return { movable: quotes[which] * DAI, stranded: stranded[which] ?? 0n, waiting: 0n }
          },
          needsMigration: async () => false,
        },
      }))
      const record = { plan: "signed-plan", phase }
      const read = webStorage.getItem.bind(webStorage)
      const saved = vi
        .spyOn(webStorage, "getItem")
        .mockImplementation(async (key) =>
          key === "migration-test" ? JSON.stringify(record) : read(key),
        )
      restore = () => saved.mockRestore()
      h.probe.mockResolvedValue({
        current,
        historic: [b, a],
        residuals: [
          frozen({ tuple: a as never, sweptDeposits: 1 }),
          frozen({ tuple: b as never, sweptDeposits: 1 }),
        ],
        pendingWithdrawals: 0,
      })
      await render()
      return { calls, record }
    }

    it("quotes again once a run stops, not from before it", async () => {
      const stranded: { b?: bigint } = {}
      const { record } = await resume("recovering", { a: 30n, b: 50n }, stranded)
      expect(detectedModal()?.textContent).not.toContain("too small to move")
      // The run's first refund executes before it stops, and leaves dust no batch affords.
      stranded.b = 3n * 10n ** 17n
      h.runMetadata.mockResolvedValue({ ...record, phase: "needsAttention", error: "x" })
      await continueStopped()
      expect(residualsRow()?.description).toContain("$0.30 too small to move")
    })
  })

  it("takes a quoted source's waiting deposits from its quote", async () => {
    withTokenService()
    session({ movable: 40n * 10n ** 18n })
    probe(
      frozen({ balance: 30n * 10n ** 18n, waitingDeposits: 1, waitingAmount: 10n * 10n ** 18n }),
    )
    await render()
    expect(upgradeButton()).toBeDefined()
    expect(detectedModal()?.textContent).not.toContain("waiting")
  })
})

describe("MigrationDetectionMount — sUSDS through the migration executor", () => {
  const DAI = 10n ** 18n
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const SUSDS_PORTAL = "0x" + "0b".repeat(20)
  const savings = { ...current, portal: "0x" + "03".repeat(20), l2Token: "0x" + "04".repeat(32) }
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    frozen: true,
    incomplete: false,
    ...over,
  })
  const dai = frozen({
    tuple: { ...incomplete.tuple, portal: "0x" + "0a".repeat(20) } as never,
    sweptDeposits: 1,
  })
  const susds = frozen({
    tuple: { ...incomplete.tuple, portal: SUSDS_PORTAL } as never,
    balance: 10n * DAI,
  })
  /** Sessions by source: the sUSDS source moves only funds, through its migration executor. */
  const sessions = ({
    daiMovable = 0n,
    registration = true,
    executor = [SUSDS_PORTAL],
  }: { daiMovable?: bigint; registration?: boolean; executor?: string[] } = {}) =>
    h.metadataSession.mockImplementation(
      async ({ historic }: { historic: { portal: string } }) => ({
        fundsOnly: executor.includes(historic.portal),
        controller: {
          historic,
          load: async () => {},
          getSnapshot: () => null,
          subscribe: () => () => {},
        },
        service: {
          quote: async () =>
            executor.includes(historic.portal)
              ? { movable: 10n * DAI, stranded: 0n, waiting: 0n, fees: 0n, approvals: 1 }
              : { movable: daiMovable, stranded: 0n, waiting: 0n, fees: DAI, approvals: 2 },
          needsMigration: async () => registration,
          consentApprovals: async () => (registration ? 1 : 0),
        },
      }),
    )
  const probe = (residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: residuals.map((r) => r.tuple),
      destinations: new Map([[SUSDS_PORTAL.toLowerCase(), { tuple: savings, symbol: "sUSDS" }]]),
      residuals,
      pendingWithdrawals: 0,
    })
  type Controller = { historic: { portal: string } }
  type Options = {
    signal: AbortSignal
    prepareOnly?: boolean
    approvalsOnly?: boolean
    prompts?: boolean
    promptless?: boolean
    observeOnly?: boolean
  }
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)))
  /** Every run's passes go through: the registration run is done once sent, each follower arrives. */
  const runAll = (registrationSent: () => Promise<unknown> = async () => {}) =>
    h.runMetadata.mockImplementation(async (controller: Controller, options: Options) => {
      if (options.observeOnly || options.promptless) return untilAborted(options.signal)
      if (options.prepareOnly) return { plan: "signed", phase: "broadcasting" }
      if (controller.historic.portal === current.portal) {
        await registrationSent()
        return { plan: "signed", phase: "done" }
      }
      return { plan: "signed", phase: "arriving" }
    })
  /** Every pass run on a source, except the follows of the runs it finished and the approvals pass. */
  const passesOf = (portal: string) =>
    runsOf(portal)
      .filter((o) => !o.observeOnly && !o.approvalsOnly)
      .map((o) => ({ prepare: !!o.prepareOnly, prompts: o.prompts }))
  const runsOf = (portal: string) =>
    h.runMetadata.mock.calls
      .filter(([controller]) => (controller as Controller).historic.portal === portal)
      .map(([, options]) => options as Options)

  beforeEach(() => {
    withTokenService()
    h.tokenCreate.mockResolvedValue("savings-token-service")
  })

  it("sends a follower's funds only once the registration run is done", async () => {
    sessions()
    probe([susds])
    await render()
    let sent!: () => void
    const registrationSent = new Promise<void>((resolve) => (sent = resolve))
    runAll(() => registrationSent)
    await startUpgrade()
    // Both runs are approved, and the registration run's send pass is still going.
    expect(passesOf(SUSDS_PORTAL)).toEqual([{ prepare: true, prompts: undefined }])
    expect(upgradeStatus().state).not.toBe("stopped")

    await act(async () => sent())
    expect(passesOf(SUSDS_PORTAL)).toEqual([
      { prepare: true, prompts: undefined },
      { prepare: false, prompts: false },
    ])
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("is done only once the sUSDS run lands after the DAI run", async () => {
    h.railPending = false
    const daiPortal = (dai.tuple as { portal: string }).portal
    sessions({ daiMovable: 100n * DAI, registration: false, executor: [SUSDS_PORTAL, daiPortal] })
    h.keyFor = (portal) => `migration-test/${portal.toLowerCase()}`
    const records = new Map<string, string>()
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) => records.get(key) ?? read(key))
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    try {
      probe([susds, dai])
      h.runMetadata.mockImplementation(async (controller: Controller, options: Options) => {
        const portal = controller.historic.portal
        const save = (phase: string) => {
          records.set(`migration-test/${portal}`, JSON.stringify({ plan: "signed", phase }))
          return { plan: "signed", phase }
        }
        if (options.prepareOnly) return save("broadcasting")
        if (!options.observeOnly) {
          // A sent source holds nothing more on its old version, which stays listed.
          h.probe.mockResolvedValue({
            current,
            historic: [susds.tuple, dai.tuple],
            destinations: new Map([
              [SUSDS_PORTAL.toLowerCase(), { tuple: savings, symbol: "sUSDS" }],
            ]),
            residuals: [],
            pendingWithdrawals: 0,
          })
          return save("arriving")
        }
        if (portal === SUSDS_PORTAL) await Promise.race([landed, untilAborted(options.signal)])
        return options.signal.aborted ? save("arriving") : save("done")
      })
      await render()
      await startUpgrade()
      await act(async () => vi.advanceTimersByTimeAsync(50))

      expect(upgradeStatus().state).toBe("running")
      expect(detectedModal()?.textContent).not.toContain("Upgrade complete")

      await act(async () => land())
      await act(async () => vi.advanceTimersByTimeAsync(50))
      expect(detectedModal()?.textContent).toContain("Upgrade complete")
      // Its sources read empty by now; the run still moved funds.
      expect(figuresCard("cutover-upgrade-done")).toBe(true)
    } finally {
      saved.mockRestore()
    }
  })
})

describe("MigrationDetectionMount — what is left on an old version", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const movable = vi.fn(async () => false)
  beforeEach(() => {
    withTokenService()
    movable.mockResolvedValue(false)
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({
          movable: (await movable()) ? 10n ** 18n : 0n,
          stranded: 0n,
          waiting: 0n,
        }),
        needsMigration: async () => false,
      },
    })
  })
  const probe = (over: Partial<HistoricResidualSummary>) =>
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [{ ...incomplete, frozen: true, incomplete: false, ...over }],
      pendingWithdrawals: 0,
    })
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await render()
  }
  const listModal = () => document.querySelector('[data-testid="migration-residuals-modal"]')

  it("reports a residual change too small to show, so a dismissed row returns", async () => {
    probe({ inTransitDeposits: 1, inTransitAmount: 1n })
    await render({ request: false })
    const before = residualsRow()?.description
    await notes.store.dismiss("migration:residuals")
    probe({ inTransitDeposits: 1, inTransitAmount: 2n })
    await act(async () => openMigrationDialog())
    await act(async () => button("Try again")!.click())
    expect(residualsRow()?.description).toBe(before)
    expect(residualsRow()?.dismissedAt).toBeUndefined()
  })

  it("lists payment links it could not judge against the chain clock", async () => {
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [
        { ...incomplete, incomplete: false, paylinkCandidates: [{ txHash: "0xlink" } as never] },
      ],
      pendingWithdrawals: 0,
      chainTimeUnknown: true,
    })
    await render()
    await act(async () => openMigrationDialog())
    expect(listModal()?.textContent).toContain(
      "Funds are still in a payment link on the old version",
    )
    expect(listModal()?.textContent).not.toContain("Nothing is left")
  })

  it("never says nothing is left while it is still checking what can move", async () => {
    movable.mockImplementation(() => new Promise(() => {}))
    probe({ balance: 10n ** 17n })
    await render()
    await act(async () => openMigrationDialog())
    expect(listModal()?.textContent).toContain("Still checking")
    expect(listModal()?.textContent).not.toContain("Nothing is left")
  })

  it("removes the row and offers Move funds once a waiting deposit can move", async () => {
    probe({ waitingDeposits: 1 })
    await render()
    expect(residualsRow()).toMatchObject({ description: "1 deposit(s) waiting on the old network" })
    movable.mockResolvedValue(true)
    probe({ sweptDeposits: 1 })
    await remount()
    expect(residualsRow()).toBeNull()
    expect(upgradeButton()).toBeDefined()
  })
})

describe("MigrationDetectionMount — registration with nothing to move", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const live = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary => ({
    ...incomplete,
    incomplete: false,
    ...over,
  })
  const frozen = (over: Partial<HistoricResidualSummary>): HistoricResidualSummary =>
    live({ frozen: true, ...over })
  const needsMigration = vi.fn(async () => true)
  const movable = vi.fn(async () => false)
  const sessionFor = vi.fn()
  let stranded = 0n
  beforeEach(() => {
    withTokenService()
    stranded = 0n
    needsMigration.mockResolvedValue(true)
    movable.mockResolvedValue(false)
    h.metadataSession.mockImplementation(async ({ historic }) => {
      sessionFor(historic.portal)
      return {
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async () =>
            (await movable())
              ? {
                  movable: 85n * 10n ** 18n,
                  stranded: 0n,
                  waiting: 0n,
                  batches: 2,
                  approvals: 2,
                  fees: 0n,
                }
              : { movable: 0n, stranded, waiting: 0n },
          needsMigration,
          consentApprovals: async () => 1,
        },
      }
    })
  })
  const probe = (...residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals,
      pendingWithdrawals: 0,
    })
  const registrationPrompt = () => !!detectedModal() && !!upgradeButton()

  it("checks the registration while the old version is still being quoted", async () => {
    let quoted!: (value: boolean) => void
    movable.mockReturnValue(new Promise<boolean>((resolve) => (quoted = resolve)))
    needsMigration.mockClear()
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(needsMigration).toHaveBeenCalledTimes(1)
    expect(upgradeStatus().state).toBe("checking")
    await act(async () => quoted(true))
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
    expect(needsMigration).toHaveBeenCalledTimes(1)
  })

  it("counts a failed registration check only once the quotes find nothing to move", async () => {
    let quoted!: (value: boolean) => void
    movable.mockReturnValue(new Promise<boolean>((resolve) => (quoted = resolve)))
    needsMigration.mockRejectedValue(new Error("node down"))
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    expect(needsMigration).toHaveBeenCalled()
    expect(upgradeStatus().state).toBe("checking")
    await act(async () => quoted(true))
    expect(upgradeStatus().state).toBe("failed")
  })

  // The metadata flow moves only a frozen old version.
  it("asks for it over a live old version, which it neither reads nor moves", async () => {
    probe(live({ balance: 85n * 10n ** 18n }))
    await render()
    expect(movable).not.toHaveBeenCalled()
    expect(sessionFor).not.toHaveBeenCalledWith(incomplete.tuple.portal)
    expect(registrationPrompt()).toBe(true)
    expect(upgradeStatus()).toMatchObject({ state: "offered", registration: true })
    expect(residualsRow()).toMatchObject({ description: "$85.00 on another old version" })
  })

  it("never reads a failed probe or movability check as nothing to move", async () => {
    probe(incomplete)
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    probe(frozen({ balance: 10n ** 17n }))
    movable.mockRejectedValue(new Error("source node down"))
    await act(async () => retryButton()!.click())
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(upgradeStatus().state).toBe("failed")
  })

  it("waits for a retry's own movability before asking", async () => {
    probe(incomplete, frozen({ balance: 10n ** 17n }))
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    let settle!: (movable: boolean) => void
    movable.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await act(async () => retryButton()!.click())
    expect(needsMigration).toHaveBeenCalled()
    expect(registrationPrompt()).toBeFalsy()
    await act(async () => settle(true))
    // The record update leads, and the frozen source's funds follow it.
    expect(upgradeButton()).toBeDefined()
  })

  it("updates the tag when an old version's source can't be opened for the queue", async () => {
    movable.mockResolvedValue(true)
    probe(frozen({ balance: 85n * 10n ** 18n }))
    await render()
    const open = h.metadataSession.getMockImplementation()!
    h.metadataSession.mockImplementation(async (params) => {
      if (params.historic.portal !== current.portal) throw new Error("manifest unreadable")
      return open(params)
    })
    h.runMetadata.mockImplementation(async (_c, opts: { prepareOnly?: boolean }) =>
      opts.prepareOnly
        ? { phase: "broadcasting", plan: "plan" }
        : { phase: "arriving", plan: "plan" },
    )
    await startUpgrade()
    expect(sessionFor).toHaveBeenCalledWith(incomplete.tuple.portal)
    expect(h.runMetadata.mock.calls[0]?.[1]).toMatchObject({ prepareOnly: true })
    h.runMetadata.mockReset()
  })
})

describe("MigrationDetectionMount — metadata resume", () => {
  it("starts only on consent, ignores duplicate clicks and exposes a resumable service error", async () => {
    withTokenService()
    let snapshot = {
      plan: "signed-plan",
      phase: "awaitingMessages",
      error: undefined as string | undefined,
    }
    let publish = () => {}
    let finish!: () => void
    const controller = {
      load: async () => {},
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        publish = listener
        return () => {}
      },
    }
    h.metadataSession.mockResolvedValue({
      controller,
      service: { needsMigration: async () => true, consentApprovals: async () => 1 },
    })
    h.runMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          publish()
          finish = () => {
            snapshot = {
              ...snapshot,
              phase: "needsAttention",
              error: "Destination registry changed",
            }
            publish()
            resolve(snapshot)
          }
        }),
    )
    const current = {
      ...incomplete.tuple,
      accountMetadataRegistry: "0x" + "56".repeat(20),
    }
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
    await render()
    expect(h.runMetadata).not.toHaveBeenCalled()
    await act(async () => {
      upgradeButton()!.click()
      upgradeButton()?.click()
    })
    expect(h.runMetadata).toHaveBeenCalledTimes(1)
    expect(h.runMetadata).toHaveBeenCalledWith(
      controller,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // 3 stands in for 2 Sign until the run is prepared.
    expect(upgradeButton()).toBeUndefined()
    await act(async () => finish())
    // S3 explains the stop.
    expect(detectedModal()?.textContent).toContain("A step could not finish")
    const resume = continueButton()!
    expect(resume.disabled).toBe(false)
    await act(async () => resume.click())
    expect(h.runMetadata).toHaveBeenCalledTimes(2)
    await act(async () => finish())
  })
})

describe("MigrationDetectionMount — an arriving upgrade", () => {
  const record = { plan: "signed-plan", phase: "arriving" }
  const source = { ...incomplete.tuple, portal: "0x" + "02".repeat(20) }
  let saved: { mockRestore(): void }
  beforeEach(() => {
    withTokenService()
    const read = webStorage.getItem.bind(webStorage)
    saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
    // Its refunds are published, not yet executed on L1: the source still quotes them.
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => record, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration: async () => false,
      },
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        { ...incomplete, tuple: source, frozen: true, incomplete: false, sweptDeposits: 2 },
      ],
      pendingWithdrawals: 0,
    })
  })
  afterEach(() => saved.mockRestore())

  it("keeps a source followed while a replaced follower ends", async () => {
    let endFirst!: (record: unknown) => void
    h.runMetadata
      .mockImplementationOnce(() => new Promise((resolve) => (endFirst = resolve)))
      .mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    // A new token service restarts the boot's follower; the first one ends only after.
    h.asset.current = { tokenService: {}, loadAssets: async () => {} }
    await render({ request: false })
    await act(async () => endFirst({ ...record, phase: "arriving" }))
    expect(h.runMetadata.mock.calls.length).toBeGreaterThan(1)
    expect(dialog()).toBeNull()
  })

  it("lists what is left when the residuals row asks, while the run is followed", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    await render({ request: false })
    await act(async () => openMigrationDialog("residuals"))
    expect(upgradeStatus().state).toBe("running")
    expect(document.querySelector('[data-testid="migration-residuals-modal"]')).not.toBeNull()
  })

  it("reads a follower that fails as failed, and offers no new upgrade over it", async () => {
    h.runMetadata.mockImplementation(() => new Promise(() => {}))
    h.metadataSession.mockRejectedValue(new Error("source node down"))
    await render()
    expect(upgradeStatus().state).toBe("failed")
    expect(notes.store.get("migration:run")?.description).toBe(
      "We couldn't check your old funds. Open it to try again.",
    )
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(upgradeButton()).toBeUndefined()
  })
})

describe("MigrationDetectionMount — the upgrade's run", () => {
  const source = { ...incomplete.tuple, portal: "0x" + "02".repeat(20) }
  type RunRecord = {
    phase: string
    plan?: string
    draft?: string
    error?: string
    refused?: boolean
    approvals?: { approved: number; total: number }
    waitReason?: string
  }
  let snapshot: RunRecord | null
  let publish: () => void
  let quote: ReturnType<typeof vi.fn>
  let saved: { mockRestore(): void } | undefined
  const runRow = () => notes.store.get("migration:run")
  const operation = () =>
    getOperationStore()
      .list()
      .find((r) => r.flow === "migration")
  /** Runs until the mount aborts it, as on unmount. */
  const untilAborted = (signal: AbortSignal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(snapshot)))
  /** The start's prepare pass approves everything, and ends before its send pass. */
  const prepares = () =>
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared?: () => void; prepareOnly?: boolean }) => {
        expect(o.prepareOnly).toBe(true)
        o.onPrepared?.()
        snapshot = { phase: "broadcasting", plan: "p" }
        publish()
        return snapshot
      },
    )
  /** The run ends at `record`, after preparing when `prepared`; with no record it goes on. */
  const runTo = (record: RunRecord | null, prepared = true) =>
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared?: () => void; signal: AbortSignal }) => {
        if (prepared) o.onPrepared?.()
        if (!record) return untilAborted(o.signal)
        snapshot = record
        publish()
        return record
      },
    )
  const boot = (record: RunRecord) => {
    const read = webStorage.getItem.bind(webStorage)
    saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation(async (key) =>
        key === "migration-test" ? JSON.stringify(record) : read(key),
      )
  }
  beforeEach(async () => {
    withTokenService()
    snapshot = null
    publish = () => {}
    quote = vi.fn(async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }))
    await notes.store.remove("migration:run")
    for (const r of getOperationStore().list()) await getOperationStore().remove(r.operationId)
    h.metadataSession.mockResolvedValue({
      controller: {
        load: async () => {},
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          publish = listener
          return () => {}
        },
      },
      service: { quote, needsMigration: async () => false },
    })
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        { ...incomplete, tuple: source, frozen: true, incomplete: false, sweptDeposits: 2 },
      ],
      pendingWithdrawals: 0,
    })
  })
  afterEach(() => {
    saved?.mockRestore()
    saved = undefined
  })
  const move = async () => {
    await render()
    await startUpgrade()
  }

  // The run saves `arriving` before its last pass ends, and the bell keeps the tab until it does.
  it("keeps zk.money open at arriving, on 3 and every screen, until the run lets go", async () => {
    let finish!: (record: RunRecord) => void
    prepares()
    h.runMetadata.mockImplementationOnce(async (_c: unknown, o: { onPrepared?: () => void }) => {
      o.onPrepared?.()
      snapshot = { phase: "arriving", plan: "p" }
      publish()
      return new Promise<RunRecord>((resolve) => (finish = resolve))
    })
    runTo(null, false)
    await move()
    await act(async () => openMigrationDialog())
    expect(operation()?.state).toBe("local")
    expect(detectedModal()?.textContent).toContain("Keep zk.money open")
    const shell = document.createElement("div")
    const shellRoot = createRoot(shell)
    await act(async () => shellRoot.render(<UpgradeKeepOpenBanner />))
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(shell.textContent).toContain("Keep zk.money open")
    await act(async () => finish({ phase: "arriving", plan: "p" }))
    expect(shell.textContent).toBe("")
    expect(detectedModal()?.textContent).toContain("Moving your funds")
    await act(async () => shellRoot.unmount())
  })

  it("holds the upgrade through every approval, and Cancel asks, then stops it sending nothing", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        signal = o.signal
        await o.beforeApproval?.(0, 2)
        snapshot = { phase: "preparing", draft: "d", approvals: { approved: 1, total: 2 } }
        publish()
        await o.beforeApproval?.(1, 2)
        return untilAborted(o.signal)
      },
    )
    await move()
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    expect(operation()?.state).toBe("local")
    await act(async () => button("Cancel")!.click())
    expect(detectedModal()?.textContent).toContain("Leave upgrade?")
    expect(signal.aborted).toBe(false)
    await act(async () => button("Stop upgrade")!.click())
    expect(signal.aborted).toBe(true)
    expect(operation()).toBeUndefined()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(detectedModal()?.textContent).not.toContain("Upgrading...")
  })

  it("keeps Upgrading up while the sends go on, with no Close", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo(null, false)
    await move()
    expect(detectedModal()?.textContent).toContain("Safe to close the app")
    expect(button("Close")).toBeUndefined()
    expect(h.runMetadata.mock.calls.at(-1)![1].signal.aborted).toBe(false)
  })

  it("asks before Back leaves 3, over a pending approval, and Stop upgrade stops the run", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        signal = o.signal
        await o.beforeApproval?.(0, 2)
        snapshot = { phase: "preparing", draft: "d", approvals: { approved: 1, total: 2 } }
        publish()
        await o.beforeApproval?.(1, 2)
        return untilAborted(o.signal)
      },
    )
    await move()
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(detectedModal()?.textContent).toContain("Leave upgrade?")
    expect(detectedModal()?.textContent).not.toContain("Approval 2 of 2")
    await act(async () => button("Stay and finish")!.click())
    expect(detectedModal()?.textContent).not.toContain("Leave upgrade?")
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    expect(signal.aborted).toBe(false)
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    await act(async () => button("Stop upgrade")!.click())
    expect(signal.aborted).toBe(true)
    expect(detectedModal()?.textContent).not.toContain("Leave upgrade?")
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("hands the run to the bell once everything is approved, and keeps it running", async () => {
    let signal!: AbortSignal
    h.runMetadata.mockImplementationOnce(
      (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        signal = o.signal
        o.onPrepared()
        return untilAborted(o.signal)
      },
    )
    await move()
    // The send still holds this tab, so 3 stays until it lets go.
    expect(detectedModal()?.textContent).toContain("Upgrading...")
    expect(operation()?.handedOffAt).toBeDefined()
    expect(signal.aborted).toBe(false)
    // Funds may have moved, so Back does not say the upgrade starts over.
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(detectedModal()?.textContent).toContain("Your upgrade will pause")
  })

  it("says why a waiting run waits, as no stop and not in the bell", async () => {
    const waitReason = "Price data is out of date. Try again later."
    h.runMetadata.mockImplementationOnce(
      async (_c: unknown, o: { onPrepared(): void; signal: AbortSignal }) => {
        o.onPrepared()
        snapshot = { phase: "waiting", plan: "p", waitReason }
        publish()
        return untilAborted(o.signal)
      },
    )
    await move()
    await act(async () => openMigrationDialog())
    const text = detectedModal()?.textContent
    expect(text).toContain(waitReason)
    expect(text).not.toContain("couldn't finish a step")
    expect(upgradeStatus()).toMatchObject({ state: "running", phase: "waiting" })
    expect(runRow()).toBeNull()
  })

  it("keeps a stop in the bell while the scan after it is still running", async () => {
    prepares()
    runTo({ phase: "needsAttention", plan: "p", error: "The relayer is down" })
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await startUpgrade()
    expect(runRow()).toMatchObject({ title: "Your upgrade needs you" })
  })

  it("shows a refused approval while the scan after it is still running", async () => {
    runTo(
      {
        phase: "needsAttention",
        error: "Not allowed",
        refused: true,
        approvals: { approved: 1, total: 6 },
      },
      false,
    )
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await startUpgrade()
    expect(detectedModal()?.textContent).toContain("Your upgrade didn't finish")
    expect(continueButton()?.disabled).toBe(false)
  })

  it("stops offering a resumed run once a scan finds its source waiting for its migration feature", async () => {
    boot({ phase: "needsApproval", plan: "p" })
    await render()
    runTo({ phase: "needsAttention", plan: "p", error: "lists no migration route" }, false)
    h.probe.mockResolvedValue({
      current: { ...incomplete.tuple, accountMetadataRegistry: "0x" + "56".repeat(20) },
      historic: [source],
      residuals: [
        {
          ...incomplete,
          tuple: source,
          frozen: true,
          incomplete: false,
          balance: 5n * 10n ** 18n,
          awaitingFeature: true,
        },
      ],
      pendingWithdrawals: 0,
    })
    await continueStopped()
    expect(document.body.textContent).toContain(
      "$5.00 is on the old version and can upgrade once the new version is ready",
    )
    expect(document.body.textContent).not.toContain("lists no migration route")
    expect(continueButton()).toBeUndefined()
    expect(upgradeStatus().state).not.toBe("stopped")
  })

  it("quotes only once the latest run's scan answers, when runs and their scans overlap", async () => {
    await render()
    const inventory = await h.probe.mock.results[0]!.value
    const scans: ((found: unknown) => void)[] = []
    h.probe.mockImplementation(() => new Promise((resolve) => scans.push(resolve)))
    runTo({ phase: "needsAttention", plan: "p", error: "first" }, false)
    await startUpgrade()
    runTo({ phase: "needsAttention", plan: "p", error: "second" }, false)
    await continueStopped()
    const quotes = quote.mock.calls.length
    await act(async () => scans[0]!(inventory))
    expect(quote.mock.calls.length).toBe(quotes)
    await act(async () => scans[1]!(inventory))
    expect(quote.mock.calls.length).toBeGreaterThan(quotes)
  })

  it("sums up a fresh run once an earlier one completed", async () => {
    quote.mockResolvedValue({
      movable: 20n * 10n ** 18n,
      stranded: 0n,
      waiting: 0n,
      batches: 2,
      approvals: 3,
      fees: 10n ** 18n,
    })
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo({ phase: "done", plan: "p" }, false)
    await move()
    expect(detectedModal()?.textContent).toContain("Upgrade complete")
    await act(async () => button("Go to wallet")!.click())
    expect(detectedModal()?.textContent).not.toContain("Upgrade complete")
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).not.toContain("network fees")
    expect(detectedModal()?.textContent).toContain(passkeyTimes(3))
  })

  it("never offers a finished run's source again from the quote taken before it", async () => {
    prepares()
    runTo({ phase: "arriving", plan: "p" })
    runTo({ phase: "done", plan: "p" }, false)
    await render()
    h.probe.mockImplementation(() => new Promise(() => {}))
    await startUpgrade()
    expect(upgradeStatus().state).not.toBe("offered")
  })

  it("shows S2 for a run that sent funds, and Resume continues it", async () => {
    boot({ phase: "needsAttention", plan: "p", error: "x", fundsSent: true } as RunRecord)
    runTo(null)
    await render()
    expect(detectedModal()?.textContent).toContain("Finish your upgrade")
    expect(detectedModal()?.textContent).toContain("Did not complete")
    expect(upgradeSteps()).toEqual([
      ["Update your account", "done"],
      ["Withdraw from old wallet", "done"],
      ["Deposit to new wallet", "active"],
    ])
    await act(async () => button("Resume")!.click())
    expect(h.runMetadata).toHaveBeenCalled()
    expect(detectedModal()?.textContent).not.toContain("Finish your upgrade")
  })

  it("opens a bug report from S3 for a run that sent no funds, and returns to S3 when it closes", async () => {
    // The record update moves no funds.
    boot({ phase: "needsAttention", plan: "p", error: "x", bootstrapTx: "0xb" } as RunRecord)
    await render()
    expect(detectedModal()?.textContent).toContain("Something went wrong")
    await act(async () => button("Contact support")!.click())
    expect(document.body.textContent).toContain("Report a bug")
    await act(async () => {
      document
        .querySelector('dialog[aria-label="Report a bug"], dialog')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.body.textContent).not.toContain("Report a bug")
    expect(detectedModal()?.textContent).toContain("Something went wrong")
  })

  it("says what stopped a run in the user's terms", async () => {
    boot({
      phase: "needsAttention",
      plan: "p",
      error: "Metadata state changed; prepare migration again",
    })
    await render()
    const text = detectedModal()?.textContent
    expect(text).toContain("What happenedA step could not finish")
    expect(text).not.toMatch(/migration|metadata/i)
  })
})

describe("MigrationDetectionMount — the dialog opens only on request", () => {
  const current = {
    ...incomplete.tuple,
    portal: "0x" + "02".repeat(20),
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const source: HistoricResidualSummary = {
    ...incomplete,
    frozen: true,
    incomplete: false,
    sweptDeposits: 2,
  }
  const needsMigration = vi.fn(async () => false)
  const runRow = () => notes.store.get("migration:run")
  beforeEach(async () => {
    withTokenService()
    needsMigration.mockReset().mockResolvedValue(false)
    await notes.store.remove("migration:run")
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration,
      },
    })
  })
  const probe = (...residuals: HistoricResidualSummary[]) =>
    h.probe.mockResolvedValue({
      current,
      historic: residuals.map((r) => r.tuple),
      residuals,
      pendingWithdrawals: 0,
    })

  it("shows 1 Choose on every launch, and Withdraw leaves it for Withdraw", async () => {
    probe(source)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
    await act(async () => button("Withdraw funds instead")!.click())
    expect(detectedModal()).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
  })

  it("waits on 1 Choose until the network proves a checkpoint", async () => {
    h.networkReady = false
    probe(source)
    await render({ request: false })
    expect(detectedModal()?.textContent).toContain("Upgrading until 13:00 UTC")
    expect(detectedModal()?.textContent).toContain("Waiting for network")
    expect(button("Upgrade now")!.disabled).toBe(true)
  })

  it("waits on an action's upgrade too until the network proves a checkpoint", async () => {
    h.networkReady = false
    probe(source)
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send" }))
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(upgradeButton()!.disabled).toBe(true)
  })

  it("goes from 1 Choose to 2 Sign, and a close returns to 1", async () => {
    probe(source)
    await render({ request: false })
    await act(async () => button("Upgrade now")!.click())
    expect(detectedModal()?.textContent).toContain("Move your funds")
    await closeSheet()
    expect(upgradeSheet()).toBeNull()
    expect(detectedModal()?.textContent).toContain("Upgrade to keep using zk.money")
  })

  it("titles the sheet for the action that asked for the upgrade", async () => {
    probe(source)
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send" }))
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(upgradeButton()).toBeDefined()
    await act(async () => button("Maybe later")!.click())
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Move your funds")
  })

  it("stops an action's upgrade from Back, without the action's sheet", async () => {
    probe(source)
    h.runMetadata.mockImplementationOnce(
      async (
        _c: unknown,
        o: { signal: AbortSignal; beforeApproval?: (a: number, t: number) => Promise<void> },
      ) => {
        await o.beforeApproval?.(0, 2)
        await o.beforeApproval?.(1, 2)
        return null
      },
    )
    const then = vi.fn()
    await render({ request: false })
    await act(async () => openMigrationDialog({ action: "send", then }))
    await act(async () => upgradeButton()!.click())
    expect(detectedModal()?.textContent).toContain("Approval 2 of 2")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    await act(async () => button("Stop upgrade")!.click())
    expect(detectedModal()?.textContent).not.toContain("Upgrade to send")
    expect(then).not.toHaveBeenCalled()
  })

  it("holds an action while the check runs, and starts it once nothing needs upgrading", async () => {
    h.railPending = false
    walletStorage.removeItem("webwallet.version/0xabc")
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await render({ request: false })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "withdraw", then: run }))
    expect(detectedModal()?.textContent).toContain("Upgrade to withdraw")
    expect(detectedModal()?.textContent).toContain("Checking whether your account needs to upgrade")
    expect(run).not.toHaveBeenCalled()
    expect(upgradeLock("0xabc").state === "released").toBe(false)
    await act(async () => answer({ current, historic: [], residuals: [], pendingWithdrawals: 0 }))
    expect(upgradeStatus().state).toBe("none")
    expect(run).toHaveBeenCalledOnce()
    expect(detectedModal()).toBeNull()
    // Nothing to upgrade here: later checks never hold this account's actions.
    expect(upgradeLock("0xabc").state === "released").toBe(true)
  })

  it("never reads the registration check as answered before it answers", async () => {
    h.railPending = false
    walletStorage.removeItem("webwallet.version/0xabc")
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    let needed!: (needed: boolean) => void
    needsMigration.mockReturnValue(new Promise((resolve) => (needed = resolve)))
    const states: string[] = []
    function History() {
      states.push(useUpgradeStatus().state)
      return null
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
          <History />
        </QueryClientProvider>,
      )
    })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "send", then: run }))
    await act(async () => answer({ current, historic: [], residuals: [], pendingWithdrawals: 0 }))
    expect(states).not.toContain("none")
    expect(run).not.toHaveBeenCalled()
    expect(upgradeLock("0xabc").state === "released").toBe(false)
    await act(async () => needed(true))
    expect(states.at(-1)).toBe("offered")
    expect(run).not.toHaveBeenCalled()
  })

  it("offers the upgrade over an action held while the check runs", async () => {
    let answer!: (found: unknown) => void
    h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await render({ request: false })
    const run = vi.fn()
    await act(async () => openMigrationDialog({ action: "send", then: run }))
    await act(async () =>
      answer({ current, historic: [source.tuple], residuals: [source], pendingWithdrawals: 0 }),
    )
    expect(upgradeStatus().state).toBe("offered")
    expect(detectedModal()?.textContent).toContain("Upgrade to send")
    expect(upgradeButton()).toBeDefined()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([["failed", () => h.probe.mockRejectedValueOnce(new Error("node unreachable"))]])(
    "starts a held action for an account current here while the check %s, as a press now would",
    async (_, check) => {
      walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
      check()
      await render({ request: false })
      const run = vi.fn()
      await act(async () => openMigrationDialog({ action: "send", then: run }))
      expect(run).toHaveBeenCalledOnce()
      expect(detectedModal()).toBeNull()
    },
  )

  it("reads a failed scan as failed, with a retry on the bell, and opens nothing", async () => {
    h.probe.mockResolvedValue({
      current,
      historic: [incomplete.tuple],
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render({ request: false })
    expect(detectedModal()).toBeNull()
    expect(upgradeStatus().state).toBe("failed")
    expect(runRow()?.description).toBe("We couldn't check your old funds. Open it to try again.")
  })

  it("reads a failed boot check as failed, and trying again checks once more", async () => {
    h.probe.mockRejectedValueOnce(new Error("node unreachable"))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("failed")
    expect(runRow()?.description).toBe("We couldn't check your old funds. Open it to try again.")
    await act(async () => openMigrationDialog())
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    probe(source)
    await act(async () => retryButton()!.click())
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(upgradeStatus().state).toBe("offered")
    expect(runRow()).toBeNull()
  })

  it("shows no error when the manifest can't be read at boot, and checks again soon", async () => {
    h.probe.mockRejectedValueOnce(new ManifestUnavailableError(new Error("fetch failed")))
    await render({ request: false })
    expect(upgradeStatus().state).toBe("checking")
    expect(runRow()).toBeNull()
    probe(source)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(upgradeStatus().state).toBe("offered")
  })

  it("keeps the last scan when a later probe can't read the manifest, and probes again soon", async () => {
    const live: HistoricResidualSummary = {
      ...incomplete,
      tuple: { ...incomplete.tuple, portal: "0x" + "0c".repeat(20) } as never,
      incomplete: false,
      awaitingFreeze: true,
      balance: 10n ** 18n,
    }
    probe(source, live)
    await render({ request: false })
    expect(upgradeStatus().state).toBe("offered")
    h.probe.mockRejectedValueOnce(new ManifestUnavailableError(new Error("fetch failed")))
    await act(async () => freeze.onFrozen())
    expect(upgradeStatus().state).toBe("offered")
    expect(runRow()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.probe).toHaveBeenCalledTimes(3)
    expect(upgradeStatus().state).toBe("offered")
  })

  it("offers nothing until the saved runs are read", async () => {
    const read = webStorage.getItem.bind(webStorage)
    const saved = vi
      .spyOn(webStorage, "getItem")
      .mockImplementation((key) =>
        key === "migration-test" ? new Promise<string | null>(() => {}) : read(key),
      )
    try {
      probe(source)
      await render()
      expect(upgradeStatus().state).toBe("checking")
      expect(upgradeButton()).toBeUndefined()
    } finally {
      saved.mockRestore()
    }
  })

  it("is never finishing for an account with no name", async () => {
    h.railPending = true
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    probe()
    await render({ request: false })
    expect(upgradeStatus()).toEqual({ state: "none", registration: false })
  })

  it("is finishing while the current registration waits to reach the rollup", async () => {
    h.railPending = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    probe()
    await render()
    expect(upgradeStatus()).toEqual({ state: "finishing", registration: true })
    expect(detectedModal()?.textContent).toContain("Finish your upgrade")
    expect(upgradeButton()).toBeUndefined()
  })

  it("keeps checking, not finishing, while the readiness read fails", async () => {
    h.railPending = true
    h.railReadFailed = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    h.account.obsidionAccount = { getAddress: () => ({ toString: () => "0xabc" }) }
    try {
      probe()
      await render({ request: false })
      expect(upgradeStatus()).toEqual({ state: "checking", registration: false })
    } finally {
      h.account.obsidionAccount = {}
    }
  })

  it("is nothing to do for an account this browser registered on this version", async () => {
    h.railPending = true
    walletStorage.setItem(
      "webwallet.identity",
      JSON.stringify({ address: "0xabc", handle: "taga", claimedAt: 0 }),
    )
    h.registrations = [{ l2Address: "0xABC" }]
    probe()
    await render({ request: false })
    expect(upgradeStatus()).toEqual({ state: "none", registration: false })
  })
})

describe("MigrationDetectionMount — old-version holdings", () => {
  // Home keys old versions by the profile's portal, which the probe pins as current.
  const current = {
    ...incomplete.tuple,
    portal: BOOTED_PORTAL,
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const funded: HistoricResidualSummary = {
    ...incomplete,
    tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
    frozen: true,
    incomplete: false,
    balance: 10n ** 18n,
  }
  const drained = { ...incomplete.tuple, portal: "0x" + "04".repeat(20), l2Token: "0x04" }
  const holdings = vi.fn(async () => true)
  const quote = vi.fn(async () => ({ movable: 10n ** 18n, stranded: 0n, waiting: 0n }))
  const session = () =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: { quote, needsMigration: async () => false },
      holdings,
    })
  const recorded = (tuple: { portal: string; l2Token: string }) =>
    BalanceStorage.get(webStorage).getBalance(oldVersionScope(tuple.portal, "0xabc"), tuple.l2Token)
  let pending = () => false
  function Waiting() {
    const { pending: now } = useOldVersionHoldings()
    pending = () => now
    return null
  }
  async function renderWithHome() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <MigrationDetectionMount />
          </MemoryRouter>
          <Status />
          <Waiting />
        </QueryClientProvider>,
      )
    })
  }

  beforeEach(() => {
    holdings.mockClear()
    quote.mockClear()
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    walletStorage.removeItem(`webwallet.oldHoldingsRead/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
  })

  it("says the check failed when a source's holdings can't be read", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    const waiting = { ...funded, balance: 0n, waitingDeposits: 1, waitingAmount: 5n }
    h.probe.mockResolvedValue({
      current,
      historic: [waiting.tuple],
      residuals: [waiting],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(upgradeStatus().state).toBe("failed")
  })

  it("says the check failed while a source's holdings are unread, even with an upgrade to offer", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    h.probe.mockResolvedValue({
      current,
      historic: [funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()

    expect(upgradeStatus().state).toBe("failed")
    expect(pending()).toBe(true)
  })

  it("keeps Home waiting until a check reads every old version, across checks", async () => {
    withTokenService()
    session()
    holdings.mockResolvedValueOnce(false)
    h.probe.mockResolvedValue({
      current,
      historic: [drained, funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()
    expect(await recorded(drained)).toBe(0n)
    expect(pending()).toBe(true)
    expect(h.oldVersionsRead).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    await renderWithHome()
    expect(pending()).toBe(false)
    expect(h.oldVersionsRead).toHaveBeenCalled()
  })

  it("says the check failed when storage refuses a source's record", async () => {
    withTokenService()
    session()
    const write = vi.spyOn(webStorage, "setItem").mockRejectedValueOnce(new Error("QuotaExceeded"))
    h.probe.mockResolvedValue({
      current,
      historic: [drained],
      residuals: [],
      pendingWithdrawals: 0,
    })

    try {
      await renderWithHome()
    } finally {
      write.mockRestore()
    }

    expect(upgradeStatus().state).toBe("failed")
    expect(pending()).toBe(true)
  })

  it("has Home wait until every old version is read, not just the first recorded", async () => {
    withTokenService()
    session()
    let read = () => {}
    holdings.mockImplementationOnce(() => new Promise((resolve) => (read = () => resolve(true))))
    h.probe.mockResolvedValue({
      current,
      historic: [drained, funded.tuple],
      residuals: [funded],
      pendingWithdrawals: 0,
    })

    await renderWithHome()
    expect(await recorded(drained)).toBe(0n)
    await act(async () => {})
    expect(pending()).toBe(true)

    await act(async () => read())
    expect(pending()).toBe(false)
  })

  it("leaves what an incomplete scan could not read as it was", async () => {
    withTokenService()
    session()
    const unread = { ...incomplete, tuple: { ...incomplete.tuple, portal: "0x" + "05".repeat(20) } }
    h.probe.mockResolvedValue({
      current,
      historic: [unread.tuple],
      residuals: [unread],
      pendingWithdrawals: 0,
    })

    await render({ request: false })

    expect(holdings).not.toHaveBeenCalled()
    expect(await recorded(unread.tuple as never)).toBeUndefined()
  })

  it("never has Home wait in the demo, which has nothing to check", async () => {
    h.demo = true
    h.account.obsidionAccount = undefined

    await renderWithHome()

    expect(pending()).toBe(false)
  })

  describe("1 Choose while the check runs", () => {
    const choose = () => document.querySelector('[data-testid="cutover-choose"]')
    const splash = () => !!container.textContent?.includes("Loading zk.money")
    const card = () => document.querySelector('[data-testid="cutover-balance"]')!
    const status = () => choose()!.querySelector('[role="status"]')
    /** The total and both halves show their skeletons, not figures. */
    const loading = () =>
      card().querySelectorAll("[aria-hidden]").length === 3 && !/[$…]/.test(card().textContent!)
    const record = (amount: bigint) =>
      BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(funded.tuple.portal, "0xabc"),
        funded.tuple.l2Token,
        amount,
      )
    const found = { current, historic: [funded.tuple], residuals: [funded], pendingWithdrawals: 0 }
    /** Boots again with the probe still running. */
    async function reboot() {
      act(() => root.unmount())
      root = createRoot(container)
      let answer = (_: unknown) => {}
      h.probe.mockReturnValue(new Promise((resolve) => (answer = resolve)))
      await render({ request: false })
      return answer
    }
    afterEach(async () => {
      await record(0n)
      walletStorage.removeItem(`webwallet.upgradeMovesFunds/${BOOTED_PORTAL.toLowerCase()}/0xabc`)
    })

    it("stands in from boot when the last check offered funds to move, loading until it offers", async () => {
      withTokenService()
      session()
      await record(10n ** 18n)
      h.probe.mockResolvedValue(found)
      await render({ request: false })
      expect(upgradeStatus().state).toBe("offered")

      const answer = await reboot()

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).not.toBeNull()
      expect(loading()).toBe(true)
      expect(button("Upgrade now")!.disabled).toBe(true)
      expect(button("Withdraw funds instead")!.disabled).toBe(true)
      expect(status()!.textContent).toBe("Reading your balance")

      await act(async () => vi.advanceTimersByTimeAsync(29_999))
      expect(status()!.textContent).toBe("Reading your balance")
      await act(async () => vi.advanceTimersByTimeAsync(1))

      expect(status()!.textContent).toBe("Reading your balance. This can take a few minutes.")

      await act(async () => answer(found))

      expect(upgradeStatus().state).toBe("offered")
      expect(loading()).toBe(false)
      expect(card().textContent).toContain("$1.00")
      expect(status()).toBeNull()
      expect(button("Upgrade now")!.disabled).toBe(false)
      expect(button("Withdraw funds instead")!.disabled).toBe(false)
    })

    it("shows Home if the record misses its wait, and keeps Home when it answers late", async () => {
      let stale = (_: boolean) => {}
      h.recordStale.mockReturnValue(new Promise((resolve) => (stale = resolve)))
      await reboot()

      await act(async () => vi.advanceTimersByTimeAsync(RECORD_CHECK_WAIT_MS))
      expect(splash()).toBe(false)

      await act(async () => stale(true))
      expect(choose()).toBeNull()
    })

    it("keeps the boot screen up through a failed check until the record answers", async () => {
      let stale = (_: boolean) => {}
      h.recordStale.mockReturnValue(new Promise((resolve) => (stale = resolve)))
      act(() => root.unmount())
      root = createRoot(container)
      h.probe.mockRejectedValue(new Error("node unreachable"))

      await render({ request: false })

      expect(upgradeStatus().state).toBe("failed")
      expect(splash()).toBe(true)

      await act(async () => stale(true))

      expect(splash()).toBe(false)
      expect(choose()).toBeNull()
    })

    it("leaves Home up after the new-version prompt", async () => {
      markUpgradeMovesFunds("0xabc", true)
      await reboot()
      expect(choose()).not.toBeNull()

      h.live.mockResolvedValue("0x" + "bb".repeat(20))
      await poll()
      expect(repointModal()).not.toBeNull()
      await act(async () => button("Later")!.click())

      expect(choose()).toBeNull()
    })

    it("reports a dialog request made while it shows, and stays up", async () => {
      markUpgradeMovesFunds("0xabc", true)
      await reboot()

      await act(async () => openMigrationDialog("residuals"))

      expect(h.event).toHaveBeenCalledWith("action_failed", {
        action: "upgrade:open",
        code: "unknown",
      })
      expect(choose()).not.toBeNull()
    })

    it("shows the probe's figure while it reads what moves, when a stale record chose it", async () => {
      withTokenService()
      session()
      h.recordStale.mockResolvedValue(true)
      let quoted = () => {}
      quote.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            quoted = () => resolve({ movable: 10n ** 18n, stranded: 0n, waiting: 0n })
          }),
      )
      h.probe.mockResolvedValue(found)

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).not.toBeNull()
      expect(loading()).toBe(false)
      expect(card().textContent).toContain("$1.00")
      expect(status()!.textContent).toBe("Preparing your upgrade")
      expect(button("Upgrade now")!.disabled).toBe(true)
      expect(button("Withdraw funds instead")!.disabled).toBe(true)

      await act(async () => quoted())

      expect(upgradeStatus().state).toBe("offered")
      expect(status()).toBeNull()
      expect(button("Upgrade now")!.disabled).toBe(false)
    })

    it("leaves deposits still waiting out of the probe's figure", async () => {
      withTokenService()
      session()
      h.recordStale.mockResolvedValue(true)
      quote.mockImplementationOnce(() => new Promise(() => {}))
      h.probe.mockResolvedValue({
        ...found,
        residuals: [{ ...funded, waitingDeposits: 1, waitingAmount: 10n ** 18n }],
      })

      await render({ request: false })

      expect(choose()).not.toBeNull()
      expect(card().textContent).toContain("$1.00")
    })

    it("leaves Home up while a later check can't read the manifest", async () => {
      withTokenService()
      h.metadataSession.mockRejectedValue(new ManifestUnavailableError("down"))
      h.probe.mockResolvedValue(found)

      await render({ request: false })

      expect(upgradeStatus().state).toBe("checking")
      expect(choose()).toBeNull()
    })
  })
})

describe("MigrationDetectionMount — incomplete probe", () => {
  it("shows Retry and runs one probe for two immediate clicks", async () => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: incomplete.tuple,
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render()
    expect(detectedModal()?.textContent).toContain("Couldn't check your old funds")
    expect(h.probe).toHaveBeenCalledTimes(1)

    let finish!: () => void
    h.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ current: incomplete.tuple, residuals: [], pendingWithdrawals: 0 })
        }),
    )
    await act(async () => {
      retryButton()!.click()
    })
    expect(retryButton()!.disabled).toBe(true)
    await act(async () => {
      retryButton()!.click()
    })
    expect(h.probe).toHaveBeenCalledTimes(2)
    await act(async () => finish())
    expect(detectedModal()).toBeNull()
  })
})

const withBalance: HistoricResidualSummary = {
  ...incomplete,
  balance: 85n * 10n ** 18n,
  inTransitDeposits: 1,
  waitingDeposits: 0,
  incomplete: false,
}

describe("MigrationDetectionMount — residuals without the metadata flow", () => {
  beforeEach(() => {
    withTokenService()
    h.probe.mockResolvedValue({
      current: { portal: "0x" + "02".repeat(20) } as never,
      residuals: [withBalance],
      pendingWithdrawals: 0,
    })
  })

  it("lists a live source's swept deposits when it has no balance that could hold them", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, balance: 0n, inTransitDeposits: 0, sweptDeposits: 1 }],
      pendingWithdrawals: 0,
    })
    await render()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 unclaimed deposit(s)" }),
    )
    expect(remove).not.toHaveBeenCalledWith("migration:residuals")
  })

  it("keeps the residuals row while the wallet is locked, which reads nothing", async () => {
    notes.bell.report({
      id: "migration:residuals",
      at: Date.now(),
      kind: "migrationResiduals",
      data: { items: [{ kind: "transit", count: 1 }] },
    })
    vi.clearAllMocks()
    h.probe.mockResolvedValue(null)
    await render()
    expect(remove).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
    expect(residualsRow()).toMatchObject({ description: "1 deposit(s) in transit" })
    expect(residualsRow()?.dismissedAt).toBeUndefined()
  })

  it("keeps the residuals row while paylinks could not be judged against the chain clock", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [],
      pendingWithdrawals: 0,
      chainTimeUnknown: true,
    })
    await render()
    expect(remove).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("keeps a dismissed residuals row dismissed across scans, until its notes change", async () => {
    const inTransit = (n: number) => ({
      current: withBalance.tuple,
      residuals: [{ ...withBalance, balance: 0n, inTransitDeposits: n }],
      pendingWithdrawals: 0,
    })
    const remount = async () => {
      vi.setSystemTime(Date.now() + 60_000)
      act(() => root.unmount())
      root = createRoot(container)
      await render()
    }
    h.probe.mockResolvedValue(inTransit(2))
    await render()
    expect(residualsRow()).toMatchObject({ description: "2 deposit(s) in transit" })
    await notes.store.dismiss("migration:residuals")

    await remount()
    expect(residualsRow()?.dismissedAt).toBeDefined()

    h.probe.mockResolvedValue(inTransit(3))
    await remount()
    expect(residualsRow()).toMatchObject({ description: "3 deposit(s) in transit" })
    expect(residualsRow()?.dismissedAt).toBeUndefined()
  })

  it("keeps the residuals row while the scan is incomplete", async () => {
    h.probe.mockResolvedValue({
      current: withBalance.tuple,
      residuals: [incomplete],
      pendingWithdrawals: 0,
    })
    await render()
    expect(residualsWrites()).toEqual([])
  })
})

describe("MigrationDetectionMount — one L1 scan per mount", () => {
  it("does not rescan when the token service resolves after mount; it reconciles with the spent check", async () => {
    await render()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    expect(h.reconcile.mock.calls.every(([, spent]) => spent === undefined)).toBe(true)
    withTokenService()
    await render()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(3)
    expect(h.reconcile.mock.calls[2]![1]).toBeTypeOf("function")
  })

  it("reconciles with the spent check again after a scan that was in flight when it arrived", async () => {
    let finishScan!: () => void
    h.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishScan = () => resolve(null)
        }),
    )
    await render()
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    withTokenService()
    await render()
    expect(h.reconcile).toHaveBeenCalledTimes(2)
    await act(async () => {
      finishScan()
    })
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reconcile).toHaveBeenCalledTimes(3)
    expect(h.reconcile.mock.calls[2]![1]).toBeTypeOf("function")
  })
})

describe("MigrationDetectionMount — profile repoint", () => {
  it("never prompts on a document the boot policy rejects, and prompts on the next good poll", async () => {
    h.live.mockRejectedValueOnce(new Error('identifies as "other"'))
    h.live.mockRejectedValueOnce(new Error('identifies as "other"'))
    h.live.mockResolvedValue("0x" + "bb".repeat(20))
    await render()
    await poll()
    await poll()
    expect(h.live).toHaveBeenCalledTimes(2)
    expect(repointModal()).toBeNull()
    await poll()
    expect(repointModal()?.textContent).toContain("Reload")
  })

  it("holds the prompt while its Reload would lose a running proof", async () => {
    h.live.mockResolvedValue("0x" + "bb".repeat(20))
    const end = await startTabBoundOperation()
    await render()
    await poll()
    expect(repointModal()).toBeNull()
    await act(async () => end())
    expect(repointModal()?.textContent).toContain("Reload")
  })
})

describe("MigrationDetectionMount — the upgrade lock", () => {
  const current = {
    ...incomplete.tuple,
    portal: BOOTED_PORTAL,
    accountMetadataRegistry: "0x" + "56".repeat(20),
  }
  const source: HistoricResidualSummary = {
    ...incomplete,
    tuple: { ...incomplete.tuple, portal: "0x" + "03".repeat(20) } as never,
    frozen: true,
    incomplete: false,
    sweptDeposits: 2,
  }
  let needed: Promise<boolean>
  const session = () =>
    h.metadataSession.mockResolvedValue({
      controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
      service: {
        quote: async () => ({ movable: 20n * 10n ** 18n, stranded: 0n, waiting: 0n }),
        needsMigration: () => needed,
      },
      holdings: async () => true,
    })
  const nothingLeft = () =>
    h.probe.mockResolvedValue({ current, historic: [], residuals: [], pendingWithdrawals: 0 })
  const lock = () => upgradeLock("0xabc")
  const run = `metadata-migration/${BOOTED_PORTAL.toLowerCase()}/${"0x" + "03".repeat(20)}/0xabc`

  beforeEach(() => {
    needed = Promise.resolve(false)
    h.railPending = false
  })
  afterEach(async () => {
    h.balance = { main: 0n, known: true }
    await webStorage.removeItem("metadata-migration/runs")
    await webStorage.removeItem(run)
  })

  it.each([false])(
    "holds Main and Savings separately (already current: %s)",
    async (alreadyCurrent) => {
      const wad = 10n ** 18n
      const savingsSource = {
        ...source,
        tuple: { ...source.tuple, portal: "0x" + "04".repeat(20) },
        balance: 50n * wad,
      }
      const savingsDestination = { ...current, portal: "0x" + "05".repeat(20) }
      walletStorage.setItem(
        "webwallet.identity",
        JSON.stringify({ address: "0xabc", claimedAt: 0 }),
      )
      if (alreadyCurrent)
        walletStorage.setItem("webwallet.version/0xabc", BOOTED_PORTAL.toLowerCase())
      markOldHoldingsRead("0xabc")
      h.balance = { main: 2n * 10n ** 18n, known: true }
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(source.tuple.portal, "0xabc"),
        source.tuple.l2Token,
        20n * wad,
      )
      await BalanceStorage.get(webStorage).updateBalance(
        oldVersionScope(savingsSource.tuple.portal, "0xabc"),
        savingsSource.tuple.l2Token,
        60n * wad,
      )
      withTokenService()
      h.tokenCreate.mockResolvedValue("savings-token-service")
      h.metadataSession.mockImplementation(async ({ historic }) => ({
        controller: { load: async () => {}, getSnapshot: () => null, subscribe: () => () => {} },
        service: {
          quote: async () => ({
            movable: historic.portal === savingsSource.tuple.portal ? 45n * wad : 19n * wad,
            fees: historic.portal === savingsSource.tuple.portal ? 5n * wad : wad,
            stranded: 0n,
            waiting: 0n,
            approvals: 1,
          }),
          needsMigration: () => needed,
        },
        holdings: async () => true,
      }))
      h.probe.mockResolvedValue({
        current,
        historic: [source.tuple, savingsSource.tuple],
        destinations: new Map([
          [source.tuple.portal.toLowerCase(), { tuple: current, symbol: "DAI" }],
          [
            savingsSource.tuple.portal.toLowerCase(),
            { tuple: savingsDestination, symbol: "sUSDS" },
          ],
        ]),
        residuals: [source, savingsSource],
        pendingWithdrawals: 0,
      })
      let atStart: unknown
      h.runMetadata.mockImplementation(async () => {
        atStart = lock()
        return null
      })
      await render()
      expect(upgradeButton()!.disabled).toBe(true)
      expect(h.runMetadata).not.toHaveBeenCalled()
      h.savings.position = { value: 3n * wad }
      await render()
      await startUpgrade()

      // Main: 2 + 20 - 1. Savings: 3 + 60 - (5 shares at 1.2 DAI).
      expect(atStart).toEqual({ state: "held", main: 21n * wad, savings: 57n * wad })
      await act(async () =>
        BalanceStorage.get(webStorage).updateBalance(
          oldVersionScope(savingsSource.tuple.portal, "0xabc"),
          savingsSource.tuple.l2Token,
          0n,
        ),
      )
    },
  )

  it("starts only once the figure it holds is known", async () => {
    walletStorage.setItem("webwallet.identity", JSON.stringify({ address: "0xabc", claimedAt: 0 }))
    markOldHoldingsRead("0xabc")
    h.balance = { main: 0n, known: false }
    withTokenService()
    session()
    h.probe.mockResolvedValue({
      current,
      historic: [source.tuple],
      residuals: [source],
      pendingWithdrawals: 0,
    })
    h.runMetadata.mockImplementation(async () => null)
    await render()
    await act(async () => upgradeButton()!.click())
    expect(upgradeButton()!.disabled).toBe(true)
    expect(h.runMetadata).not.toHaveBeenCalled()
    expect(lock()).toEqual({ state: "pending" })

    h.balance = { main: 2n * 10n ** 18n, known: true }
    await render()
    await startUpgrade()
    expect(lock()).toEqual({ state: "held", main: expect.any(BigInt) })
  })

  it("tries a release that failed to save again", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    withTokenService()
    session()
    nothingLeft()
    vi.spyOn(walletStorage, "commitTransaction").mockRejectedValueOnce(new Error("disk full"))
    await render({ request: false })
    expect(lock().state).toBe("held")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(lock()).toEqual({ state: "released" })
  })

  it("stays held while a probe reads nothing, as on a sign-out mid-check", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    await render({ request: false })

    expect(upgradeStatus().state).toBe("checking")
    expect(lock()).toEqual({ state: "held", main: 7n })
  })

  it("stays held until this inventory's registration check answers", async () => {
    await acquireUpgradeLock("0xabc", 7n)
    withTokenService()
    let answer!: (needed: boolean) => void
    needed = new Promise((resolve) => (answer = resolve))
    session()
    nothingLeft()
    await render({ request: false })
    expect(lock().state).toBe("held")

    await act(async () => answer(false))
    expect(lock().state).toBe("released")
  })

  it("is taken, with no figure, for a run an older build left unfinished", async () => {
    await webStorage.setItem("metadata-migration/runs", JSON.stringify([run]))
    await webStorage.setItem(run, JSON.stringify({ phase: "arriving" }))
    await render({ request: false })

    expect(lock()).toEqual({ state: "held", main: undefined })
  })
})

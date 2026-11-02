/**
 * The backup entry's open-paylink fact on a fresh device: its links reach storage only once the
 * rescan rebuilds them from chain, after the entry mounted, so the entry waits for that rescan and
 * reads again as rows land.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaylinkTransaction } from "@obsidion/front-core"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const ONE_KEY = `0x${"11".repeat(32)}`
const OTHER = `0x${"22".repeat(32)}`
const NOW = 1_800_000_000

vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ hydrated: true, records: [] }),
}))
vi.mock("../../../src/features/migration/oldVersionBalance", () => ({
  useOldVersionHoldings: () => ({ pending: false, total: 0n }),
}))
vi.mock("../../../src/features/migration/upgradeLock", () => ({
  useUpgradeLock: () => ({ state: "released" }),
}))
vi.mock("../../../src/features/identity/walletIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/identity/walletIdentity")>()),
  loadWalletIdentity: () => ({ address: ONE_KEY }),
}))
vi.mock("../../../src/features/onboarding/registrationResume", () => ({
  unlockedSessionKeys: async () => ({
    account: { getAddress: () => ({ toString: () => ONE_KEY }) },
  }),
}))
const DAI = 10n ** 18n
vi.mock("../../../src/features/token/oxideToken", () => ({
  currentTxAmountCap: async () => 5n * DAI,
}))
vi.mock("../../../src/config/classArtifacts", () => ({ getWebOxideToken: async () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  getFeeTokenBridgeTuple: async () => ({}),
  l1PublicClient: () => ({}),
  requireTupleField: () => "0x",
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({}),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readBridgeDestination: async () => ({}),
  fundingAmount: async () => ({ amount: 2n * DAI, credited: DAI, breakdown: {} }),
  readSpendShape: async () => ({ notes: [3n * DAI], depositTotal: 0n, balance: 3n * DAI }),
}))

const { useBackupEntryFacts } = await import(
  "../../../src/features/backupPasskey/backupPasskeyFacts"
)
const { markPaylinksRescanned, providePaylinkRescan } = await import(
  "../../../src/features/paylink/paylinkRescanState"
)
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)

/** A link the account made on another device, as the rescan rebuilds it. */
const rebuilt: PaylinkTransaction = {
  action: "Pay To Email",
  emailPaymentAction: "Pay To Email",
  flavor: "direct",
  status: "success",
  timestamp: (NOW - 600) * 1000,
  txHash: `0x${"ab".repeat(32)}`,
  paylink: "https://wallet.example/link#frag",
  payToEmailSecret: `0x${"44".repeat(32)}`,
  fallbackSecret: `0x${"55".repeat(32)}`,
  obsidionAccountAddress: ONE_KEY,
  fromClaimable: 0,
  untilClaimable: NOW + 86_400,
  refundableUntil: NOW + 86_400,
} as PaylinkTransaction

const wallet = {} as never
const contractService = {} as never
let entry: ReturnType<typeof useBackupEntryFacts> | undefined
let facts: ReturnType<typeof useBackupEntryFacts>["facts"] | undefined
function Probe() {
  entry = useBackupEntryFacts(wallet, contractService, true)
  facts = entry.facts
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // A pass for another account leaves this one's unread.
  markPaylinksRescanned(OTHER, true)
  const { activity } = switchSession(activeNamespace())
  for (const row of await activity.all()) await activity.remove(row.id)
  facts = undefined
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Probe />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const openLink = () => (typeof facts === "object" ? facts.openLink : facts)

describe("the backup entry's open paylink on a fresh device", () => {
  it("waits for the rescan, then sees the link it rebuilt after the entry mounted", async () => {
    await settle()
    expect(facts).toBe("checking")

    await act(async () => {
      await session().activity.importHistoricRows([rebuilt])
      markPaylinksRescanned(ONE_KEY, true)
    })
    await settle()
    expect(openLink()).toBe(true)
  })

  it("sees a link that lands after the rescan finished", async () => {
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    expect(openLink()).toBe(false)

    await act(async () => {
      await session().activity.importHistoricRows([rebuilt])
    })
    await settle()
    expect(openLink()).toBe(true)
  })

  it("reads unreadable while the latest pass failed, and its retry starts another", async () => {
    const rerun = vi.fn()
    const withdraw = providePaylinkRescan(rerun)
    await act(async () => markPaylinksRescanned(ONE_KEY, false))
    await settle()
    expect(facts).toBe("unreadable")

    await act(async () => entry!.refresh())
    expect(rerun).toHaveBeenCalledOnce()
    await act(async () => markPaylinksRescanned(ONE_KEY, true))
    await settle()
    expect(openLink()).toBe(false)
    withdraw()
  })
})

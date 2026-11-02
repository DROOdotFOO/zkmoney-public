import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalRecord } from "@obsidion/front-core"
import type { PaymentLink } from "../../../../src/features/paylink/types"

const m = vi.hoisted(() => ({
  cashOut: vi.fn(),
  fireEvent: vi.fn(),
  uses: 1,
  deps: {},
}))
// Keep the real useLinkWithdrawal and useWithdrawals subscriptions.
vi.mock("../../../../src/features/paylink/usePaylinkDeps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/paylink/usePaylinkDeps")>()),
  useLinkVoucher: () => ({ uses: m.uses, deps: m.deps }),
}))
vi.mock("../../../../src/features/withdraw/withdrawFunnel", () => ({
  reportWithdrawFunnel: vi.fn(),
}))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../../../../src/features/paylink/paylinkExit", () => ({
  cashOutLink: m.cashOut,
  linkWithdrawalIdentity: () => ({ id: "paylink-id" }),
}))
vi.mock("../../../../src/features/paylink/claimStash", async (importOriginal) => ({
  receivesToAccount: (
    await importOriginal<typeof import("../../../../src/features/paylink/claimStash")>()
  ).receivesToAccount,
  stashClaimLink: vi.fn(),
}))
// An open claim window: the Ethereum claim is withheld until the chain clock says so.
vi.mock("../../../../src/features/paylink/chainTime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/paylink/chainTime")>()),
  usePolledChainSeconds: () => 1_000,
}))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useLocation: () => ({}) }))
vi.mock("../../../../src/lib/analytics", () => ({
  fireEvent: m.fireEvent,
  fireOnboardingEvent: vi.fn(),
  reportLanding: vi.fn(),
  failureCode: () => "unknown",
}))
vi.mock("../../../../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum" }),
}))
vi.mock("../../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../../src/features/onboarding/OnboardingScreen", () => ({
  OnboardingScreen: () => null,
}))
vi.mock("../../../../src/ui/NotificationsBell/NotificationsBell", () => ({
  NotificationsBell: () => null,
}))
await (await import("../../../support/seedBootConfig")).seedBootConfig()
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: true, screener: {} }),
  ScreeningNotice: () => null,
}))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => ({}) }))
vi.mock("../../../../src/features/withdraw/WithdrawScreen", () => ({ useSavedL1Wallets: () => [] }))
// A priced direct route: the modal only offers Confirm once the fee is known.
vi.mock("../../../../src/features/withdraw/withdrawQuote", () => ({
  SWAP_QUOTE_REFRESH_MS: 30_000,
  withdrawalFeeDisplay: () => "0.35",
  useSwapSimulation: () => ({
    status: "ready",
    fee: {
      withdrawalRelayerTip: 350_000_000_000_000_000n,
      swapRelayerTip: 0n,
      proverTip: 0n,
      floorAtomic: 350_000_000_000_000_000n,
    },
  }),
  swapFloorAtomic: () => 350_000_000_000_000_000n,
  WithdrawalEstimate: () => null,
}))
vi.mock("../../../../src/features/paylink/emailClaim", () => ({ obtainEmailL1Proof: vi.fn() }))
vi.mock("../../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => true }))
vi.mock("../../../../src/ui/format", () => ({
  shortAddr: (v: string) => v,
  shortL1Addr: (v: string) => v,
  usdFigure: (v: string) => v,
}))

import { PaylinkVisitorScreen } from "../../../../src/features/paylink/PaylinkVisitorScreen"
import {
  activeNamespace,
  closeSession,
  switchSession,
  session,
} from "../../../../src/platform/session"

const recipient = "0x2222222222222222222222222222222222222222"
const record: WithdrawalRecord = {
  localId: "withdrawal-1",
  paylinkId: "paylink-id",
  recipient,
  recipientProvenance: "saved-recipient",
  source: "paylink",
  amount: "24.9",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  startTime: 1_700_000_000_000,
  phase: "submitting",
}
let container: HTMLDivElement
let root: Root
let link: PaymentLink
let resolveCashOut: (record: WithdrawalRecord) => void
const publish = async (records: WithdrawalRecord[]) => {
  for (const record of records)
    await session().withdrawals.create({ ...record, networkId: "0xnet" })
}
// Exact first: "Claim" is also a prefix of the "Claim to an Ethereum wallet" option.
const button = (label: string) => {
  const buttons = [...container.querySelectorAll("button")]
  return (
    buttons.find((b) => b.textContent === label || b.getAttribute("aria-label") === label) ??
    buttons.find((b) => b.textContent?.startsWith(label))
  )
}
const click = async (label: string) => {
  expect(button(label)).toBeDefined()
  await act(async () => button(label)!.click())
}
const outcomes = () =>
  m.fireEvent.mock.calls.filter(
    ([name]) => name === "proving_cancelled" || name === "proving_abandoned",
  )
async function startCashOut() {
  await act(async () => root.render(<PaylinkVisitorScreen link={link} onRetryStatus={vi.fn()} />))
  await click("Claim to an Ethereum wallet")
  const input = container.querySelector('input[placeholder="Paste an address"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      recipient,
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Claim")
  await click("Confirm and claim")
  expect(m.cashOut).toHaveBeenCalledOnce()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  switchSession(activeNamespace())
  m.uses = 1
  m.cashOut.mockImplementation(
    () =>
      new Promise<WithdrawalRecord>((resolve) => {
        resolveCashOut = resolve
      }),
  )
  link = {
    fragment: "fragment",
    url: "",
    amount: "25",
    status: "unclaimed",
    flavor: "direct",
    claimableFrom: 0,
  }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  closeSession()
})

describe("visitor cash-out outcome tracking", () => {
  it("keeps the real claim modal mounted across withdrawal updates until completion", async () => {
    await startCashOut()
    await act(async () => publish([record]))
    expect(container.textContent).toContain("Preparing transaction")
    expect(outcomes()).toEqual([])

    // The voucher and link status can also refresh before the cash-out promise settles.
    m.uses = 0
    link = { ...link, status: "claimed" }
    await act(async () => root.render(<PaylinkVisitorScreen link={link} onRetryStatus={vi.fn()} />))
    expect(container.textContent).toContain("Preparing transaction")
    await act(async () => resolveCashOut(record))
    expect(container.textContent).not.toContain("Preparing transaction")
    expect(container.textContent).toContain("You withdrew")
    await act(async () => root.render(null))
    expect(outcomes()).toEqual([])
  })

  it("still reports real navigation while the cash-out is pending", async () => {
    await startCashOut()
    await act(async () => publish([record]))
    expect(outcomes()).toEqual([])
    await act(async () => root.render(null))
    expect(outcomes()).toEqual([
      ["proving_cancelled", { flow: "paylink-claim-l1", stage: "building" }],
    ])
    await act(async () => resolveCashOut(record))
    expect(outcomes()).toHaveLength(1)
  })
})

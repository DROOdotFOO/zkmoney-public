import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  zk: { fee: vi.fn(), run: vi.fn() },
  source: { source: { portal: "0xold" }, savings: false, open: async () => ({}) },
  extra: [] as unknown[],
  l1: { connect: vi.fn() },
  networkReady: true,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: (p: { children: React.ReactNode }) => <h2>{p.children}</h2>,
  Icon: () => null,
  TopNavIconButton: () => null,
  ProgressSpinner: () => null,
  GradientSpinner: () => null,
  PrimaryGradientButton: (p: { title: string; isDisabled?: boolean; onClick: () => void }) => (
    <button disabled={p.isDisabled} onClick={p.onClick}>
      {p.title}
    </button>
  ),
  TextField: (p: { value: string; onChange: (value: string) => void }) => (
    <input value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  savingsValue: (shares: bigint) => shares,
  useSavingsPosition: () => ({}),
}))
vi.mock("../../../../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 1, l1Chain: { name: "Ethereum" } }),
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ withdrawalSubsidy: "0xsubsidy" }),
  l1PublicClient: () => ({}),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  planFrozenSelfRefunds: () => [{ kind: "note" }],
  estimateFrozenSelfRefundCost: async () => ({ usd: 165n * 10n ** 16n }),
}))
vi.mock("../../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
vi.mock("../../../../src/ui/BrandLockup", () => ({ BrandLockup: () => null }))
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: true }),
  ScreeningNotice: () => null,
}))
vi.mock("../../../../src/ui/detailRows", () => ({ HashRow: () => null, l1TxUrl: () => undefined }))
vi.mock("../../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "brave-otter-42" }),
}))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => m.l1,
  isWalletRejection: () => false,
}))
vi.mock("../../../../src/features/deposit/sipaRecovery", () => ({}))
vi.mock("../../../../src/features/identity/logout", () => ({ logout: vi.fn() }))
vi.mock("../../../../src/features/onboarding/webRegistration", () => ({
  isLogoutBlockedByRegistration: () => false,
}))
vi.mock("../../../../src/features/migration/migrationDialog", () => ({
  openMigrationDialog: vi.fn(),
}))
vi.mock("../../../../src/features/migration/oldVersionWithdraw", () => ({
  noteOldVersionWithdrawn: vi.fn(),
  openOldVersionExit: async (ws: { savings: boolean; source: { portal: string } }) => {
    if (ws.source.portal === "0xdown") throw new Error("savings node down")
    return { runtime: { candidates: async () => ({}) }, symbol: "DAI" }
  },
  skipUnrefundableSource: vi.fn(),
  useWithdrawableSources: () => [m.source, ...m.extra],
}))
vi.mock("../../../../src/features/operations/operations", () => ({
  isFlowCancelled: () => false,
  runOperation: (_op: unknown, fn: () => Promise<unknown>) => fn(),
}))
vi.mock("../../../../src/features/withdraw/frozenExitRun", () => ({
  frozenExitSummary: () => ({ refundable: 10n * 10n ** 18n, links: 0n, waiting: 0n }),
  runFrozenExit: vi.fn(),
}))
vi.mock("../../../../src/features/withdraw/zkMoneyExit", () => ({ zkMoneyExit: () => m.zk }))
vi.mock("../../../../src/features/cutover/networkReady", () => ({
  useNetworkReady: () => m.networkReady,
}))

const { withdrawChoiceCopy, withdrawDoneCopy, withdrawingCopy } = await import(
  "../../../../src/features/cutover/cutoverCopy"
)
const { shortL1Addr } = await import("../../../../src/ui/format")
const { OldVersionWithdrawScreen } = await import(
  "../../../../src/features/withdraw/OldVersionWithdrawScreen"
)

const ADDRESS = `0x${"12".repeat(20)}`
const TIPS = {
  moving: { main: 10n * 10n ** 18n, savings: 0n },
  tips: { main: 35n * 10n ** 16n, savings: 0n },
}
let root: Root
let host: HTMLDivElement

const radio = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((b) =>
    b.textContent?.includes(name),
  )!
/** The last match: a sheet's button over its page's. */
const button = (title: string) =>
  [...document.querySelectorAll("button")].reverse().find((b) => b.textContent?.trim() === title)!
const text = () => document.body.textContent
const press = (title: string) => act(async () => button(title).click())

async function render() {
  await act(async () => root.render(<OldVersionWithdrawScreen />))
}

const type = (value: string) =>
  act(async () => {
    const input = document.querySelector<HTMLInputElement>(".ww-cutover__field input")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const tick = () =>
  act(async () => document.querySelector<HTMLInputElement>("input[type=checkbox]")!.click())

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("withdrawing an old version's funds", () => {
  it("withdraws privately by default, to the address the user checked last", async () => {
    let finish!: (result: { sent: bigint; left: bigint }) => void
    m.zk = {
      fee: vi.fn(async () => TIPS),
      run: vi.fn(
        (_sources, _to, onStage: (stage: string) => void) =>
          new Promise((resolve) => {
            onStage("sending")
            finish = resolve
          }),
      ),
    }
    await render()
    expect(radio("Privately").getAttribute("aria-checked")).toBe("true")
    expect(radio("Privately").textContent).toContain("$0.35")
    expect(radio("Privately").textContent).toContain("$9.65")
    await press("Continue")

    await type(`0x${"34".repeat(20)}`)
    expect(button("Continue").disabled).toBe(true)
    await tick()
    // A changed address needs a fresh check.
    await type(ADDRESS)
    expect(button("Continue").disabled).toBe(true)
    await tick()
    await press("Continue")

    expect(text()).toContain("$9.65")
    await press("Confirm with passkey")
    expect(m.zk.run).toHaveBeenCalledWith(
      [m.source],
      ADDRESS,
      expect.any(Function),
      expect.any(Function),
    )
    expect(text()).toContain(withdrawingCopy.onItsWay(shortL1Addr(ADDRESS)))
    await act(async () => finish({ sent: 965n * 10n ** 16n, left: 0n }))
    expect(text()).toContain(withdrawDoneCopy.title)
    expect(text()).toContain("$9.65")
  })

  it("offers to read the fee again when its quote fails", async () => {
    m.zk = {
      fee: vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(TIPS),
      run: vi.fn(),
    }
    await render()
    expect(radio("Privately").textContent).toContain(withdrawChoiceCopy.zkMoney.feeFailed)
    await press("Continue")
    await type(ADDRESS)
    await tick()
    await press("Continue")
    await press("Try again")
    expect(m.zk.fee).toHaveBeenCalledTimes(2)
    expect(button("Confirm with passkey").disabled).toBe(false)
  })

  it("asks for another scan before it withdraws while Savings is unread", async () => {
    m.zk = { fee: vi.fn(async () => TIPS), run: vi.fn() }
    m.extra = [{ source: { portal: "0xdown" }, savings: true, open: async () => ({}) }]
    await render()
    await press("Continue")
    await type(ADDRESS)
    await tick()
    await press("Continue")
    expect(button("Try again")).toBeDefined()
    expect(button("Confirm with passkey")).toBeUndefined()
    m.extra = []
  })

  it("closes the private route when its fee is more than the balance", async () => {
    m.zk = {
      fee: vi.fn(async () => ({ ...TIPS, tips: { main: 11n * 10n ** 18n, savings: 0n } })),
      run: vi.fn(),
    }
    await render()
    expect(radio("Privately").disabled).toBe(true)
    expect(radio("Publicly").getAttribute("aria-checked")).toBe("true")
    expect(text()).toContain("$11.00")
  })

  it("closes the private route when no refund covers its fee", async () => {
    m.zk = {
      fee: vi.fn(async () => ({
        moving: { main: 0n, savings: 0n },
        tips: { main: 0n, savings: 0n },
      })),
      run: vi.fn(),
    }
    await render()
    expect(radio("Privately").disabled).toBe(true)
    expect(radio("Publicly").getAttribute("aria-checked")).toBe("true")
  })

  it("names the receiving account in the wallet review, and offers another wallet", async () => {
    m.zk = { fee: vi.fn(async () => TIPS), run: vi.fn() }
    m.l1 = { connect: vi.fn(), account: ADDRESS, walletName: "Rainbow", wrongChain: false } as never
    await render()
    await act(async () => radio("Publicly").click())
    await press("Continue")
    expect(text()).toContain(ADDRESS)
    await press("Use another wallet")
    expect(m.l1.connect).toHaveBeenCalledOnce()
    m.l1 = { connect: vi.fn() }
  })

  it("waits on the private route until the network proves a checkpoint", async () => {
    m.zk = { fee: vi.fn(async () => TIPS), run: vi.fn() }
    m.networkReady = false
    await render()
    expect(radio("Privately").disabled).toBe(true)
    expect(radio("Privately").textContent).toContain(withdrawChoiceCopy.zkMoney.waiting)
    expect(radio("Publicly").getAttribute("aria-checked")).toBe("true")
    expect(button("Upgrade now instead").disabled).toBe(true)
    m.networkReady = true
  })

  it("shows no gas figure when a source can't be read", async () => {
    m.zk = { fee: vi.fn(async () => TIPS), run: vi.fn() }
    m.extra = [{ source: { portal: "0xdown" }, savings: true, open: async () => ({}) }]
    await render()
    expect(radio("Publicly").textContent).not.toContain("~$")
    m.extra = []
  })

  it("offers the own wallet route with its gas estimate, and connects a wallet", async () => {
    m.zk = { fee: vi.fn(async () => TIPS), run: vi.fn() }
    m.l1 = { connect: vi.fn() }
    await render()
    expect(radio("Publicly").textContent).toContain("~$1.65")
    await act(async () => radio("Publicly").click())
    await press("Continue")
    expect(m.l1.connect).toHaveBeenCalledOnce()
  })
})

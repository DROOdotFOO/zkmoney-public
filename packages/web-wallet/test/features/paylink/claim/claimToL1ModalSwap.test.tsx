import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: vi.fn() }))

await (await import("../../../support/seedBootConfig")).seedBootConfig()
vi.mock("../../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ swapEscrowFactoryV2: `0x${"11".repeat(20)}` }),
  requireTupleField: (tuple: Record<string, string>, field: string) => tuple[field],
}))
const { EXECUTOR } = vi.hoisted(() => ({ EXECUTOR: `0x${"e8".repeat(20)}` }))
vi.mock("../../../../src/features/paylink/paylinkSource", () => ({
  paylinkTuple: async () => ({ plainWithdrawalExecutor: EXECUTOR }),
}))
vi.mock("../../../../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => ({}) }))
vi.mock("../../../../src/features/withdraw/WithdrawScreen", () => ({ useSavedL1Wallets: () => [] }))
vi.mock("../../../../src/features/withdraw/WithdrawToWalletModal/WithdrawToWalletModal", () => ({}))
vi.mock("../../../../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
vi.mock("../../../../src/ui/screening", () => ({
  useScreenedAddress: () => ({ screener: {}, cleared: true }),
  ScreeningNotice: () => null,
}))
vi.mock("../../../../src/features/contacts/PayWorking", () => ({ PayWorking: () => null }))
const { simulation, verify, caller } = vi.hoisted(() => ({
  simulation: vi.fn(),
  verify: vi.fn(),
  // The caller stands in as the payee it binds, so a proof's first argument names its destination.
  caller: vi.fn(async (_executor: string, payee: string) => payee),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  decodePaylinkInline: () => ({ email: "a@example.com" }),
}))
vi.mock("../../../../src/features/paylink/emailClaim", () => ({
  obtainEmailL1Proof: verify,
  emailL1Caller: caller,
}))
vi.mock("../../../../src/features/withdraw/withdrawQuote", () => ({
  FEE_UNAVAILABLE_COPY: "fee-unavailable",
  SWAP_QUOTE_REFRESH_MS: 30_000,
  withdrawalFeeDisplay: (state: { fee?: { floorAtomic?: bigint } }) =>
    state.fee ? String(state.fee.floorAtomic ?? 1n) : undefined,
  swapFloorAtomic: (state: { fee?: { floorAtomic?: bigint } }) => state.fee?.floorAtomic ?? 1n,
  useSwapSimulation: simulation,
  WithdrawalEstimate: ({ state }: { state: { estimate?: { amountOut: bigint } } }) => (
    <span>Swap estimate {String(state.estimate?.amountOut ?? "")}</span>
  ),
}))
// The faster option the review offers; undefined offers no speed choice.
const faster = vi.hoisted(() => ({
  offer: undefined as
    | {
        proverTip: bigint
        standardEtaSeconds: number
        tippedEtaSeconds: number
        worstSpeedupSeconds: number
        measured: boolean
      }
    | undefined,
  loading: false,
}))
vi.mock("../../../../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: ({ active }: { active: boolean }) =>
    active ? { offer: faster.offer, loading: faster.loading } : { loading: false },
}))

const { ClaimToL1Modal } = await import("../../../../src/features/paylink/ClaimToL1Modal")
const recipient = `0x${"11".repeat(20)}`
const escrow = `0x${"ee".repeat(20)}`
const proof = { vkey: ["key"], proof: ["proof"], public_inputs: ["caller"] }
const leg = { plan: { escrow } }
let container: HTMLDivElement
let root: Root
const onConfirm = vi.fn()
const planSwap = vi.fn(async () => leg as never)
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!
const click = (text: string) => act(async () => button(text).click())

beforeEach(() => {
  onConfirm.mockReset()
  planSwap.mockClear()
  verify.mockReset()
  verify.mockResolvedValue(proof)
  faster.offer = undefined
  simulation.mockImplementation(({ proverTip = 0n }: { proverTip?: bigint }) => ({
    status: "ready",
    fee: {
      withdrawalRelayerTip: 3n,
      swapRelayerTip: 5n,
      proverTip,
      floorAtomic: 8n + proverTip,
    },
    estimate: { amountOut: 123n, decimals: 6 },
  }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** Fill the form, optionally switch the output asset, then open the review sheet. */
const renderSheet = (amount: string | undefined, flavor: string) =>
  act(async () =>
    root.render(
      <ClaimToL1Modal
        link={
          { amount, status: "unclaimed", flavor, tokenAddress: `0x${"5c".repeat(32)}` } as never
        }
        ready
        onClose={() => {}}
        onHandOff={() => {}}
        onConfirm={onConfirm}
        planSwap={planSwap}
      />,
    ),
  )

const fillAddress = () =>
  act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Paste an address"]',
    )!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      recipient,
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

async function confirmSheet(amount: string | undefined = "25", flavor = "direct", asset?: string) {
  await renderSheet(amount, flavor)
  await fillAddress()
  if (asset) await pickAsset(asset)
  await click("Claim")
}

const pickAsset = async (asset: string, current = "DAI") => {
  await click(current)
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) =>
    b.textContent?.includes(asset),
  )!
  await act(async () => option.click())
}

describe("ClaimToL1Modal email swap", () => {
  it("discards a pending plan when the selected asset changes", async () => {
    let finish!: (value: typeof leg) => void
    planSwap.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never)
    await renderSheet("25", "email")
    await fillAddress()
    await pickAsset("USDC")
    await pickAsset("DAI", "USDC")
    await act(async () => finish(leg))
    await click("Claim")
    await click("Verify email with Google")
    expect(verify.mock.calls[0]![0]).toBe(recipient)
    await click("Confirm and claim")
    expect(onConfirm.mock.calls[0]![0].swap).toBeUndefined()
  })

  it("keeps the displayed and submitted quote tied to the verified plan", async () => {
    await confirmSheet("25", "email", "USDC")
    await click("Verify email with Google")
    const feeText = () =>
      [...container.querySelectorAll("span")].find(
        (element) => element.textContent === "Network fee",
      )!.parentElement!.textContent
    const committedFee = feeText()
    simulation.mockReturnValue({
      status: "ready",
      fee: { swapRelayerTip: 9n, proverTip: 0n, floorAtomic: 30n * 10n ** 18n },
      estimate: { amountOut: 119n, decimals: 6 },
    })
    await renderSheet("25", "email")
    expect(container.textContent).toContain("Swap estimate 123")
    expect(container.textContent).not.toContain("Swap estimate 119")
    expect(feeText()).toBe(committedFee)
    expect(button("Confirm and claim").disabled).toBe(false)
    await click("Confirm and claim")
    expect(onConfirm.mock.calls[0]![0].quote).toEqual({
      relayerTip: 5n,
      amountOut: 123n,
      decimals: 6,
    })
    expect(planSwap).toHaveBeenCalledTimes(1)
  })

  it("waits for the selected asset's real quote lifecycle before planning", async () => {
    vi.useFakeTimers()
    const actual = await vi.importActual<typeof import("../../../../src/features/withdraw/withdrawQuote")>(
      "../../../../src/features/withdraw/withdrawQuote",
    )
    const simulate = vi.fn(async ({ output }: { output: string }) => ({
      fee: {
        swapRelayerTip: output === "ETH" ? 99n : 5n,
        proverTip: 0n,
        floorAtomic: 100n,
      },
      estimate: { amountOut: 123n, decimals: output === "ETH" ? 18 : 6 },
    }))
    simulation.mockImplementation((args) => actual.useSwapSimulation({ ...args, simulate }))
    await renderSheet("25", "email")
    await fillAddress()
    await pickAsset("USDC")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(planSwap).toHaveBeenCalledTimes(1)
    await pickAsset("ETH", "USDC")
    await click("Claim")
    expect(planSwap).toHaveBeenCalledTimes(1)
    expect(button("Verify email with Google").disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(planSwap).toHaveBeenLastCalledWith(
      recipient,
      "ETH",
      { relayerTip: 99n, amountOut: 123n, decimals: 18 },
      25_000_000_000_000_000_000n,
      0n,
    )
    expect(button("Verify email with Google").disabled).toBe(false)
  })

  it("plans the leg before the popup and binds the proof to its escrow", async () => {
    await confirmSheet("25", "email", "USDC")
    expect(planSwap).toHaveBeenCalledWith(
      recipient,
      "USDC",
      { relayerTip: 5n, amountOut: 123n, decimals: 6 },
      25_000_000_000_000_000_000n,
      0n,
    )
    await click("Verify email with Google")
    expect(verify.mock.calls[0]![0]).toBe(escrow)
    expect(caller).toHaveBeenCalledWith(EXECUTOR, escrow)
    await click("Confirm and claim")
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ receiveAsset: "USDC", zkProof: proof, swap: leg }),
      expect.any(Function),
    )
  })

  it("holds verification until the leg is planned, and plans once", async () => {
    let finish!: (value: typeof leg) => void
    planSwap.mockReturnValueOnce(new Promise((r) => (finish = r)) as never)
    await confirmSheet("25", "email", "USDC")
    expect(button("Verify email with Google").disabled).toBe(true)
    await act(async () => finish(leg))
    expect(button("Verify email with Google").disabled).toBe(false)
    expect(planSwap).toHaveBeenCalledTimes(1)
  })

  it("drops a proof bound to the escrow when the asset changes back to DAI", async () => {
    await confirmSheet("25", "email", "USDC")
    await click("Verify email with Google")
    // The asset lives on the form: back out of the review to change it.
    await click("Cancel")
    await pickAsset("DAI", "USDC")
    await click("Claim")
    await click("Verify email with Google")
    expect(verify.mock.calls[1]![0]).toBe(recipient)
    await click("Confirm and claim")
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ receiveAsset: "DAI", swap: undefined }),
      expect.any(Function),
    )
  })
})

describe("ClaimToL1Modal email swap speed", () => {
  const TIP = 500_000_000_000_000_000n
  const tippedLeg = { plan: { escrow: `0x${"ab".repeat(20)}` } }
  const chooseSpeed = async (name: string) => {
    const speed = [...container.querySelectorAll(".ww-deposit__fact")]
      .find((f) => f.querySelector("span")?.textContent === "Speed")!
      .querySelector("button")!
    await act(async () => speed.click())
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((o) =>
      o.textContent?.startsWith(name),
    )!
    await act(async () => option.click())
  }

  beforeEach(() => {
    faster.offer = {
      proverTip: TIP,
      standardEtaSeconds: 44 * 60,
      tippedEtaSeconds: 12 * 60,
      worstSpeedupSeconds: 30 * 60,
      measured: true,
    }
  })

  it("plans the leg with the tip it opens on, and binds the proof to that escrow", async () => {
    planSwap.mockResolvedValue(tippedLeg as never)
    await confirmSheet("25", "email", "USDC")
    expect(planSwap).toHaveBeenLastCalledWith(
      recipient,
      "USDC",
      { relayerTip: 5n, amountOut: 123n, decimals: 6 },
      25_000_000_000_000_000_000n,
      TIP,
    )
    await click("Verify email with Google")
    expect(verify.mock.calls[0]![0]).toBe(tippedLeg.plan.escrow)
    await click("Confirm and claim")
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ swap: tippedLeg, proverTip: TIP }),
      expect.any(Function),
    )
  })

  it("burns the tip its leg was planned with when the offer re-quotes", async () => {
    await confirmSheet("25", "email", "USDC")
    planSwap.mockResolvedValueOnce(tippedLeg as never)
    await chooseSpeed("Faster")
    faster.offer = { ...faster.offer!, proverTip: TIP * 2n }
    await renderSheet("25", "email")
    expect(planSwap).toHaveBeenCalledTimes(2)
    await click("Verify email with Google")
    await click("Confirm and claim")
    expect(onConfirm.mock.calls[0]![0].proverTip).toBe(TIP)
  })
})

/** The fresh-address sheet: chips, one priced burn, MAX, review, speed, the hand-off. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveBalances } from "../../../support/balances"
import { parseGwei, parseUnits } from "viem"
import { MAX_DAI_FOR_GAS } from "@obsidion/sdk"
import { ScreeningProvider, passThroughScreener, type AddressScreener } from "@obsidion/front-core"
import { provingProgress } from "@obsidion/proving-progress"
import { showReportableError } from "../../../../src/errors/errorModal"
import { fireEvent } from "../../../../src/lib/analytics"
import { asOperation, endSigningAndHandOff } from "../../../support/handOff"
import type { WithdrawalQuoteState } from "../../../../src/features/withdraw/withdrawQuote"
import type { WithdrawStage } from "../../../../src/features/withdraw/withdrawGateway"
import { LIMIT, LIMIT_USD, grouped, typed } from "../../../support/publicLimit"
import { openTestSession } from "../../../support/session"

type Asset = "USDC" | "USDT" | "ETH" | "DAI"
/** DAI with a gas share rides an escrow on the DAI route, priced apart from direct DAI. */
type Route = Asset | "DAI_GAS"
const submit = vi.fn()
const cfg = { network: "sandbox" }
const walletAsset = { balanceAtomic: parseUnits("100", 18) }
const priced = (floor: string, tip: string) => ({
  floor: parseUnits(floor, 18),
  tip: parseUnits(tip, 18),
  status: "ready" as WithdrawalQuoteState["status"],
  calls: [] as { amount?: bigint; daiForGas: bigint }[],
})
const SWAP_GAS = { baseFee: parseGwei("2.4"), priorityFee: parseGwei("1") }
/** Each route's live answer: the floor it charges, the swap tip inside it, and whether it has priced. */
const freshRoutes = (): Record<Route, ReturnType<typeof priced>> => ({
  USDC: priced("0.35", "0.05"),
  USDT: priced("0.3", "0.04"),
  ETH: priced("0.45", "0.15"),
  DAI: priced("0.1", "0"),
  DAI_GAS: priced("0.4", "0.1"),
})
let routes = freshRoutes()
const amountsOf = (route: Route) => routes[route].calls.map((c) => c.amount)
const GAS_OUT = parseUnits("5", 18) / 3000n

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
  upsertSavedL1WalletContact: vi.fn(),
}))
vi.mock("../../../../src/features/withdraw/freshAddressGateway", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/features/withdraw/freshAddressGateway")
  >()),
  submitFreshAddressWithdrawal: submit,
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => cfg }))
vi.mock("../../../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
}))
vi.mock("../../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// One synchronous quote per route: the fee always, the estimate for a burn above the floor and the
// gas share. The stable routes pay out the rest, the ETH route that at $3000 an ether, and the gas
// swap the gas share at the same price.
vi.mock("../../../../src/features/withdraw/withdrawQuote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/withdrawQuote")>()),
  useSwapSimulation: (args: {
    receiveAsset: Asset
    amountAtomic?: bigint
    proverTip?: bigint
    daiForGas?: bigint
  }) => {
    const daiForGas = args.daiForGas ?? 0n
    const key: Route = args.receiveAsset === "DAI" && daiForGas > 0n ? "DAI_GAS" : args.receiveAsset
    const { floor, tip: swapRelayerTip, status, calls } = routes[key]
    calls.push({ amount: args.amountAtomic, daiForGas })
    if (status === "unavailable") return { status }
    const proverTip = args.proverTip ?? 0n
    const floorAtomic = floor + proverTip
    const fee = {
      withdrawalRelayerTip: 0n,
      swapRelayerTip,
      swapGas: key === "DAI" ? undefined : SWAP_GAS,
      proverTip,
      floorAtomic,
    }
    const net = (args.amountAtomic ?? 0n) - floorAtomic - daiForGas
    if (status !== "ready" || net <= 0n) return { status, fee }
    const [amountOut, decimals] =
      key === "ETH" ? [net / 3000n, 18] : key.startsWith("DAI") ? [net, 18] : [net / 10n ** 12n, 6]
    const gas = daiForGas > 0n ? { gasOut: daiForGas / 3000n } : {}
    return { status, fee, estimate: { amountOut, decimals, ...gas } }
  },
}))

// The faster option the review offers.
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
  ...(await importOriginal<
    typeof import("../../../../src/features/withdraw/useFasterWithdrawal")
  >()),
  useFasterWithdrawal: ({ active }: { active: boolean }) =>
    active ? { offer: faster.offer, loading: faster.loading } : { loading: false },
}))
vi.mock("../../../../src/features/withdraw/burnTiming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/burnTiming")>()),
  recordBurnDuration: vi.fn(),
}))

const { recordBurnDuration } = await import("../../../../src/features/withdraw/burnTiming")
const { FEE_UNAVAILABLE_COPY } = await import("../../../../src/features/withdraw/withdrawQuote")
const { default: freshCopy } = await import(
  "../../../../src/features/withdraw/WithdrawFreshModal/WithdrawFreshModal.copy"
)
const sheet = await import(
  "../../../../src/features/withdraw/WithdrawFreshModal/WithdrawFreshModal"
)
const speedCopy = await import("../../../../src/features/withdraw/speedChoice")

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const
const MINED = { phase: "l2_mined" }
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

describe("WithdrawFreshModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onDone = vi.fn()

  const input = () => container.querySelector("input") as HTMLInputElement
  const buttons = () => Array.from(container.querySelectorAll("button"))
  const button = (text: string) =>
    buttons().find((b) => (b.getAttribute("aria-label") ?? b.textContent) === text)!
  const click = (text: string) => act(async () => button(text).click())
  const picker = () => container.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')!
  const pick = async (symbol: string) => {
    await act(async () => picker().click())
    const opts = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    await act(async () => opts.find((o) => o.querySelector("b")?.textContent === symbol)!.click())
  }
  const type = (value: string) =>
    act(async () => {
      setValue.call(input(), value)
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const row = (label: string) =>
    Array.from(container.querySelectorAll(".ww-sheet__fact"))
      .find((f) => f.querySelector("span")?.textContent === label)
      ?.querySelector("b")?.textContent
  const fired = (event: string) =>
    vi.mocked(fireEvent).mock.calls.filter(([name]) => name === event).length
  const sentQuote = () => submit.mock.calls[0]![1].quote
  // The recipient is screened before the CTA can enable.
  const mount = async (screener: AddressScreener = passThroughScreener) => {
    const props = { recipient: RECIPIENT, walletName: "Cold", onClose: vi.fn(), onDone }
    await act(async () => root.render(null))
    await act(async () =>
      root.render(
        <ScreeningProvider screener={screener}>
          <sheet.WithdrawFreshModal {...props} />
        </ScreeningProvider>,
      ),
    )
    await act(() => new Promise((r) => setTimeout(r, 350)))
  }
  const confirm = async () => {
    await type("20")
    await click("Review")
    await click("Withdraw privately")
  }

  beforeEach(async () => {
    vi.mocked(fireEvent).mockClear()
    vi.mocked(showReportableError).mockClear()
    vi.mocked(recordBurnDuration).mockClear()
    faster.offer = undefined
    faster.loading = false
    submit.mockReset().mockImplementation(() => new Promise(() => {}))
    onDone.mockReset()
    routes = freshRoutes()
    cfg.network = "sandbox"
    openTestSession({
      wallet: {},
      account: {},
      token: { metadata: { decimals: 18 } },
      balances: liveBalances(() => ({ main: walletAsset.balanceAtomic, live: true, known: true })),
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await mount()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("offers gas shares one escrow can swap, defaulting to $5", async () => {
    expect(Math.max(...sheet.GAS_CHIPS)).toBeLessThanOrEqual(Number(MAX_DAI_FOR_GAS / 10n ** 18n))
    expect(button("$5").getAttribute("aria-pressed")).toBe("true")
    await click("$1")
    expect(button("$1").getAttribute("aria-pressed")).toBe("true")
  })

  it("sends DAI straight to the address at a $0 gas share: no escrow, no ETH", async () => {
    await click("$0")
    expect(container.textContent).toContain(
      "No gas share. The address needs ETH from elsewhere before it can spend.",
    )
    await type("20")
    expect(routes.DAI.calls.at(-1)).toEqual({ amount: parseUnits("20.1", 18), daiForGas: 0n })
    expect(row("Withdrawal fee")).toBe("$0.10")
    expect(container.textContent).not.toContain("for L1 gas")
    await click("Review")
    expect(row("Arrives as gas")).toBeUndefined()
    expect(row("Sending total")).toBe("$20.10")
    await click("Withdraw privately")
    expect(submit.mock.calls[0]![1]).toMatchObject({ gasDisplay: "0", fundsAsset: "DAI" })
    expect(sentQuote()).toMatchObject({ relayerTip: 0n, floorAtomic: routes.DAI.floor })

    // Funds landing as ETH are the address's gas: the note says so instead.
    await mount()
    await click("$0")
    await pick("ETH")
    expect(container.textContent).toContain(
      "No gas share. The funds arrive as ETH, so the address can spend them.",
    )
  })

  it("reviews a swap route's figures, the gas share swapped by the same escrow", async () => {
    await pick("USDT")
    await type("20")
    expect(routes.USDT.calls.at(-1)).toEqual({
      amount: parseUnits("25.3", 18),
      daiForGas: parseUnits("5", 18),
    })
    await click("Review")
    expect(row("To")).toBe(`Cold${RECIPIENT}`)
    expect(row("Token")).toBe("USDT")
    expect(row("Send")).toBe("$20 ≈ 20 USDT")
    expect(row("Arrives as gas")).toBe("$5 ≈ 0.00167 ETH")
    expect(row("Withdrawal fee")).toBe("$0.30")
    expect(row("Sending total")).toBe("$25.30")
    expect(container.textContent).toContain("up to 40 minutes")

    await click("Back")
    expect(input().value).toBe("20")
    await click("Review")
    await click("Withdraw privately")
    expect(sentQuote()).toEqual({
      relayerTip: routes.USDT.tip,
      amountOut: 20_000_000n,
      decimals: 6,
      gasOut: GAS_OUT,
      floorAtomic: routes.USDT.floor,
      proverTip: 0n,
    })
  })

  it("adds the gas share to the ETH route, which already pays ETH", async () => {
    await pick("ETH")
    await type("20")
    expect(routes.ETH.calls.at(-1)).toEqual({ amount: parseUnits("25.45", 18), daiForGas: 0n })
    await click("Review")
    expect(row("Send")).toBe("$25 ≈ 0.00833 ETH")
    expect(row("Arrives as gas")).toBe("$5, in the ETH above")
    expect(row("Sending total")).toBe("$25.45")
  })

  it("says when the balance cannot cover the gas share, the fees and the minimum", async () => {
    walletAsset.balanceAtomic = parseUnits("6", 18)
    try {
      await click("MAX")
      expect(input().value).toBe("")
      expect(container.textContent).toContain(
        "Your balance can't cover the gas share and fees ($5.40) plus the $1 minimum.",
      )
      expect(button("Review").disabled).toBe(true)
    } finally {
      walletAsset.balanceAtomic = parseUnits("100", 18)
    }
  })

  it("MAX leaves room for the gas share and the fee, and follows them until the amount is edited", async () => {
    await pick("USDC")
    await click("MAX")
    expect(input().value).toBe("94.65")
    expect(button("Review").disabled).toBe(false)
    await click("$10")
    expect(input().value).toBe("89.65")

    // One cent over the balance closes Review, and an edited amount stops following.
    await type("89.66")
    expect(button("Review").disabled).toBe(true)
    await click("$15")
    expect(input().value).toBe("89.66")
  })

  it.each([
    ["sandbox", FEE_UNAVAILABLE_COPY],
    ["testnet", freshCopy.noSwapStack],
  ])("closes Review and says why when the route cannot be priced on %s", async (network, copy) => {
    cfg.network = network
    routes.USDC.status = "unavailable"
    await pick("USDC")
    await type("20")
    expect(row("Withdrawal fee")).toBe("$--")
    expect(container.textContent).not.toContain("for L1 gas")
    expect(button("Review").disabled).toBe(true)
    expect(container.textContent).toContain(copy)
  })

  describe("speed", () => {
    const TIP = parseUnits("0.5", 18)
    const offer = {
      proverTip: TIP,
      standardEtaSeconds: 44 * 60,
      tippedEtaSeconds: 12 * 60,
      worstSpeedupSeconds: 30 * 60,
      measured: true,
    }
    const speed = () => container.querySelector('[aria-haspopup="listbox"]')?.textContent
    const openSpeeds = async () => {
      await act(async () => picker().click())
      return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    }
    const toReview = async (amount = "20") => {
      await type(amount)
      await click("Review")
    }

    it("says it is checking while the first Faster quote loads", async () => {
      faster.loading = true
      await toReview()
      expect(speed()).toBeUndefined()
      expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe("SpeedChecking…")
    })

    it("offers Standard alone without a faster option", async () => {
      await toReview()
      expect(speed()).toBeUndefined()
      await click("Withdraw privately")
      expect(sentQuote().proverTip).toBe(0n)
    })

    it("shows Faster settled, with no tip, when a tip would not save a minute for certain", async () => {
      faster.offer = { ...offer, worstSpeedupSeconds: 59 }
      await toReview()
      expect(speed()).toBe("Faster")
      expect((picker() as HTMLButtonElement).disabled).toBe(true)
      expect(row("Withdrawal fee")).toBe("$0.40")
      await click("Withdraw privately")
      expect(sentQuote().proverTip).toBe(0n)
    })

    it("prices Faster's tip into the one burn and submits it", async () => {
      faster.offer = offer
      await toReview()
      expect(speed()).toBe("Faster")
      const options = await openSpeeds()
      expect(options.map((o) => o.textContent)).toEqual([
        "StandardAbout 44 min once confirmed",
        "FasterAbout 12 min once confirmed · 0.5 DAI",
      ])
      await act(async () => options[1]!.click())
      expect(speed()).toBe("Faster")
      expect(amountsOf("DAI_GAS").at(-1)).toBe(parseUnits("25.9", 18))
      expect(row("Withdrawal fee")).toBe("$0.90")
      expect(row("Sending total")).toBe("$25.90")
      await click("Withdraw privately")
      expect(sentQuote()).toMatchObject({
        proverTip: TIP,
        floorAtomic: routes.DAI_GAS.floor + TIP,
      })
    })

    it("keeps a maxed amount and greys Faster out: no tip fits on top of MAX", async () => {
      faster.offer = offer
      await click("MAX")
      expect(input().value).toBe("94.6")
      await click("Review")
      const [, fasterOption] = await openSpeeds()
      expect(fasterOption!.disabled).toBe(true)
      expect(fasterOption!.textContent).toBe(`Faster${speedCopy.BALANCE_TIP_BLOCKED_COPY}`)
      expect(row("Send")).toBe("$94.60")
      expect(row("Sending total")).toBe("$100")
    })

    it("disables Faster when the balance can't cover the tip", async () => {
      // $25.40 at Standard leaves $74.60.
      faster.offer = { ...offer, proverTip: parseUnits("74.61", 18) }
      await toReview()
      const [, blocked] = await openSpeeds()
      expect(blocked!.disabled).toBe(true)
      expect(blocked!.textContent).toBe(`Faster${speedCopy.BALANCE_TIP_BLOCKED_COPY}`)
      await act(async () => picker().click())
      await click("Withdraw privately")
      expect(sentQuote().proverTip).toBe(0n)

      faster.offer = { ...offer, proverTip: parseUnits("74.6", 18) }
      await mount()
      await toReview()
      const [, fits] = await openSpeeds()
      expect(fits!.disabled).toBe(false)
    })
  })

  it.each([
    ["fails, still mounted", false, undefined, 0],
    ["finishes", false, MINED, 1],
  ])("leaves once when signing ends, whatever follows: %s", async (_, unmounts, result, mined) => {
    if (unmounts) onDone.mockImplementation(() => root.render(null))
    let end!: () => void
    submit.mockImplementation(
      asOperation(
        () =>
          new Promise((resolve, reject) => {
            end = () => (result ? resolve(result) : reject(new Error("Withdrawal failed")))
          }),
        "withdraw",
      ),
    )
    await confirm()
    await act(async () => provingProgress.emitSigningStart())
    expect(onDone).not.toHaveBeenCalled()
    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()

    await act(async () => end())
    expect(onDone).toHaveBeenCalledOnce()
    expect(button("Withdraw privately")).toBeUndefined()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fired("proving_cancelled")).toBe(0)
    expect(fired("withdraw_submitted")).toBe(mined)
  })

  it("closes through onDone when the burn is left to chain, reports it sent, and times no burn", async () => {
    submit.mockResolvedValue({ phase: "submitting" })
    await confirm()
    expect(onDone).toHaveBeenCalledOnce()
    expect(button("Withdraw privately")).toBeUndefined()
    expect(fired("withdraw_submitted")).toBe(1)
    expect(recordBurnDuration).not.toHaveBeenCalled()
  })

  it("offers Cancel only while the burn is building, and honors none clicked later", async () => {
    let onStage!: (s: WithdrawStage) => void
    submit.mockImplementation((_deps, _input, advance) => {
      onStage = advance
      return new Promise(() => {})
    })
    // A withdrawn Cancel keeps its space, hidden and disabled, so the card does not move.
    const offered = () => {
      const cancel = button("Cancel")
      return !!cancel && !cancel.disabled && cancel.style.visibility !== "hidden"
    }
    await confirm()
    await act(async () => onStage("building"))
    expect(offered()).toBe(true)
    await act(async () => {
      onStage("proving")
      // React has not yet removed the Cancel handler for the new stage.
      button("Cancel").click()
    })
    expect(offered()).toBe(false)
    await act(async () => onStage("submitting"))
    expect(offered()).toBe(false)
  })

  it("honors a cancel at the proving checkpoint", async () => {
    let proceed!: () => void
    submit.mockImplementation(async (_deps, _input, onStage) => {
      onStage("building")
      await new Promise<void>((resolve) => (proceed = resolve))
      onStage("proving")
      return MINED
    })
    await confirm()
    await click("Cancel")
    await act(async () => proceed())
    expect(button("Withdraw privately")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("returns to confirm on a failure before the sheet has left", async () => {
    submit.mockRejectedValue(new Error("Withdrawal failed"))
    await confirm()
    expect(onDone).not.toHaveBeenCalled()
    expect(showReportableError).toHaveBeenCalledOnce()
    expect(fired("action_failed")).toBe(1)
    await click("Withdraw privately")
    expect(fired("retry_clicked")).toBe(1)
  })

  describe("the per-withdrawal limit", () => {
    // The burn, gas share and floor included, is one withdrawal of at most the published limit.
    const notice = () => container.querySelector('[data-testid="limit-notice"]')?.textContent
    const OVER = `Over the ${LIMIT_USD} limit`

    beforeEach(async () => {
      walletAsset.balanceAtomic = parseUnits(String(2 * LIMIT), 18)
      await mount()
    })
    afterEach(() => {
      walletAsset.balanceAtomic = parseUnits("100", 18)
    })

    it(`MAX on a large balance stops the DAI burn, gas share and floor included, at ${LIMIT_USD}`, async () => {
      const max = typed(LIMIT - 5.4)
      await pick("DAI")
      await click("MAX")
      expect(input().value).toBe(max)
      expect(amountsOf("DAI_GAS").at(-1)).toBe(parseUnits(String(LIMIT), 18))
      expect(notice()).toBeUndefined()
      await click("Review")
      await click("Withdraw privately")
      expect(submit.mock.calls[0]![1]).toMatchObject({ fundsDisplay: max, gasDisplay: "5" })
    })

    it(`takes a burn of exactly ${LIMIT_USD} and refuses one cent more, offering the maximum`, async () => {
      await type(typed(LIMIT - 5.4))
      expect(notice()).toBeUndefined()
      expect(button("Review").disabled).toBe(false)

      await type(typed(LIMIT - 5.39))
      expect(notice()).toContain(OVER)
      expect(button("Review").disabled).toBe(true)
      await click(`Use maximum ($${grouped(LIMIT - 5.4, true)})`)
      expect(input().value).toBe(typed(LIMIT - 5.4))
      expect(button("Review").disabled).toBe(false)
    })

    it("says a moved fee put the reviewed burn over the limit, and holds Confirm", async () => {
      await type(typed(LIMIT - 5.4))
      await click("Review")
      routes.DAI_GAS.floor = parseUnits("0.5", 18)
      // The same sheet renders again, as it does when its quotes refresh.
      await act(async () =>
        root.render(
          <ScreeningProvider screener={passThroughScreener}>
            <sheet.WithdrawFreshModal recipient={RECIPIENT} onClose={vi.fn()} onDone={onDone} />
          </ScreeningProvider>,
        ),
      )
      expect(row("Send")).toBe(`$${(LIMIT - 5.4).toFixed(2)}`)
      expect(notice()).toContain(OVER)
      expect(button("Withdraw privately").disabled).toBe(true)
    })

    describe("Faster", () => {
      const TIP = parseUnits("0.5", 18)
      beforeEach(() => {
        faster.offer = {
          proverTip: TIP,
          standardEtaSeconds: 44 * 60,
          tippedEtaSeconds: 12 * 60,
          worstSpeedupSeconds: 30 * 60,
          measured: true,
        }
      })
      const openSpeeds = async () => {
        await act(async () => picker().click())
        return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      }

      it("is blocked when its tip would put a typed amount's burn over the limit", async () => {
        await type(typed(LIMIT - 5.4))
        await click("Review")
        const [, fasterOption] = await openSpeeds()
        expect(fasterOption!.disabled).toBe(true)
        expect(fasterOption!.textContent).toBe(`Faster${speedCopy.LIMIT_TIP_BLOCKED_COPY}`)
        await act(async () => picker().click())
        await click("Withdraw privately")
        expect(sentQuote().proverTip).toBe(0n)
      })
    })

    it("names the balance, not the limit, when an amount is over both", async () => {
      walletAsset.balanceAtomic = parseUnits("100", 18)
      await type("3000")
      expect(notice()).toBeUndefined()
      expect(container.textContent).toContain("Balance not enough")
      expect(button("Review").disabled).toBe(true)
    })

    it("keeps screening the address: a blocked one holds Review for an amount within the limit", async () => {
      const blocked: AddressScreener = {
        screen: async () => ({
          compliant: false,
          reason: { code: "blocked", message: "Sanctioned address" },
        }),
      }
      await mount(blocked)
      await type(typed(LIMIT - 5.4))
      expect(container.textContent).toContain("Sanctioned address")
      expect(button("Review").disabled).toBe(true)
    })
  })
})

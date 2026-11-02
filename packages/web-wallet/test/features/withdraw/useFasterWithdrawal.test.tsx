/**
 * The faster option is offered whenever a nonzero tip can be quoted, whatever it saves; it hides when a
 * read fails, the tip is zero or the burn may land past the tip cutoff, and it re-quotes while open.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupEstimate, WithdrawalSpeedupNode } from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"

const PROVER_SUBSIDY = `0x${"33".repeat(20)}`
const sdkQuote = vi.hoisted(() => vi.fn())
const estimate = vi.hoisted(() => vi.fn())
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  quoteWithdrawalProverTip: sdkQuote,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  WithdrawalSpeedupEstimator: class {
    estimate = estimate
  },
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "mainnet", l1ChainId: 1 }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ proverSubsidy: PROVER_SUBSIDY }),
  l1PublicClient: () => ({}),
}))

const { DEFAULT_BURN_LANDING } = await import("../../../src/features/withdraw/burnTiming")
const { loadFasterWithdrawal, useFasterWithdrawal } = await import(
  "../../../src/features/withdraw/useFasterWithdrawal"
)
type Load = NonNullable<Parameters<typeof useFasterWithdrawal>[0]["load"]>
type Offer = ReturnType<typeof useFasterWithdrawal>["offer"]

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const NODE = {} as WithdrawalSpeedupNode
const TIP = 42n * 10n ** 16n
const speedup = (speedupSeconds: number): WithdrawalSpeedupEstimate => ({
  epoch: 10 as WithdrawalSpeedupEstimate["epoch"],
  checkpointIndex: 3,
  standardEtaSeconds: 2_700,
  tippedEtaSeconds: 2_700 - speedupSeconds,
  worstSpeedupSeconds: speedupSeconds,
  speedupSeconds,
  confidence: "measured",
  pastTipCutoff: false,
})
const tipQuote = (proverTip: bigint): ProverTipQuote => ({
  proverTip,
  gasPriceWei: 10n ** 9n,
  usdPerEth: 2_500n * 10n ** 8n,
  subsidy: 0n,
})
const resolves =
  (seconds: number, tip = TIP): Load =>
  async () => ({ estimate: speedup(seconds), quote: tipQuote(tip) })

describe("useFasterWithdrawal", () => {
  let container: HTMLDivElement
  let root: Root
  let offer: Offer
  let loading: boolean

  function Harness(props: Parameters<typeof useFasterWithdrawal>[0]) {
    const state = useFasterWithdrawal(props)
    offer = state.offer
    loading = state.loading
    return null
  }
  const render = (props: Partial<Parameters<typeof useFasterWithdrawal>[0]>) =>
    act(async () => {
      root.render(<Harness active node={NODE} load={resolves(1_200)} {...props} />)
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    offer = undefined
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("offers a tip that saves nothing too, so the sheet can say so", async () => {
    await render({ load: resolves(0) })
    expect(offer).toEqual({
      proverTip: TIP,
      standardEtaSeconds: 2_700,
      tippedEtaSeconds: 2_700,
      worstSpeedupSeconds: 0,
      measured: true,
    })
  })

  it("is loading until the first quote answers, and not after a failure", async () => {
    let answer: (v: Awaited<ReturnType<Load>>) => void = () => {}
    await render({ load: () => new Promise((r) => (answer = r)) })
    expect(loading).toBe(true)
    expect(offer).toBeUndefined()
    await act(async () => answer(await resolves(1_200)(NODE)))
    expect(loading).toBe(false)
    expect(offer?.proverTip).toBe(TIP)

    await render({ load: async () => Promise.reject(new Error("feed stale")), refreshMs: 5_000 })
    expect(loading).toBe(false)
  })

  it("is not loading while the step is closed", async () => {
    await render({ active: false })
    expect(loading).toBe(false)
  })

  it("hides the tip when the burn may land past the tip cutoff", async () => {
    await render({
      load: async () => ({
        estimate: { ...speedup(1_200), pastTipCutoff: true },
        quote: tipQuote(TIP),
      }),
    })
    expect(offer).toBeUndefined()
    expect(loading).toBe(false)
  })

  it("hides a zero tip: the subsidy already pays for the early proof", async () => {
    await render({ load: resolves(1_200, 0n) })
    expect(offer).toBeUndefined()
  })

  it("re-quotes while open", async () => {
    vi.useFakeTimers()
    let seconds = 1_200
    await render({
      load: async () => ({ estimate: speedup(seconds), quote: tipQuote(TIP) }),
      refreshMs: 1_000,
    })
    expect(offer?.tippedEtaSeconds).toBe(1_500)
    seconds = 60
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(offer?.tippedEtaSeconds).toBe(2_640)
  })
})

it("drops the offer when a re-quote runs past two refreshes", async () => {
  // Kept outside the suite above: it needs its own root and fake timers from the first render.
  vi.useFakeTimers()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  let offer: Offer
  let calls = 0
  const load: Load = () => (++calls === 1 ? resolves(1_200)(NODE) : new Promise(() => {}))
  function Harness() {
    offer = useFasterWithdrawal({ active: true, node: NODE, load, refreshMs: 1_000 }).offer
    return null
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => root.render(<Harness />))
  expect(offer?.proverTip).toBe(TIP)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(offer?.proverTip).toBe(TIP)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(offer).toBeUndefined()
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("loadFasterWithdrawal", () => {
  it("estimates the burn's landing and quotes the tip for its checkpoint and the deployment's subsidy", async () => {
    estimate.mockResolvedValue(speedup(1_200))
    sdkQuote.mockResolvedValue(tipQuote(TIP))

    const result = await loadFasterWithdrawal(NODE)

    expect(estimate).toHaveBeenCalledWith(DEFAULT_BURN_LANDING)
    expect(sdkQuote).toHaveBeenCalledWith(expect.anything(), {
      chainId: 1n,
      proverSubsidy: PROVER_SUBSIDY,
      checkpointCount: 3n,
    })
    expect(result.quote.proverTip).toBe(TIP)
  })
})

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupNode } from "@obsidion/front-core"

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
vi.mock("../../../src/features/withdraw/useFasterWithdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/withdraw/useFasterWithdrawal")>()),
  useFasterWithdrawal: () => ({ offer: faster.offer, loading: faster.loading }),
}))

const { useSpeedChoice, useSpeedOutcome } = await import("../../../src/features/withdraw/speedChoice")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const TIP = dai(0.5)
/** An amount the tip is exactly 10% of. */
const AMOUNT = dai(5)
const OFFER = {
  proverTip: TIP,
  standardEtaSeconds: 2_700,
  tippedEtaSeconds: 900,
  worstSpeedupSeconds: 1_800,
  measured: true,
}

describe("useSpeedChoice + useSpeedOutcome", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: { speed: string; pricedTip: bigint; proverTip: bigint; blocked?: string }
  let choose: (speed: "standard" | "faster") => void

  type Props = { initial?: "standard" | "faster"; covers?: boolean; amount?: bigint }
  function Harness({ initial, covers, amount = AMOUNT }: Props) {
    const choice = useSpeedChoice({
      active: true,
      node: {} as WithdrawalSpeedupNode,
      amount,
      initialSpeed: initial,
    })
    const outcome = useSpeedOutcome(choice, covers)
    seen = { speed: choice.speed, pricedTip: choice.pricedTip, ...outcome }
    choose = choice.setSpeed
    return null
  }
  const render = (props: Props) => act(async () => root.render(<Harness {...props} />))

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    faster.offer = OFFER
    container = document.createElement("div")
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it("starts on Faster and burns the tip it can cover", async () => {
    await render({ covers: true })
    expect(seen).toMatchObject({ speed: "faster", pricedTip: TIP, proverTip: TIP })
  })

  it.each([
    ["the tip is over 2 DAI", { ...OFFER, proverTip: dai(2.01) }, dai(100)],
    ["the tip is over 10% of the amount", OFFER, AMOUNT - 1n],
    ["the latencies are not measured", { ...OFFER, measured: false }, AMOUNT],
  ])("starts on Standard when %s, and Faster can still be chosen", async (_, offer, amount) => {
    faster.offer = offer
    await render({ covers: true, amount })
    expect(seen).toMatchObject({ speed: "standard", pricedTip: 0n, proverTip: 0n })
    await act(async () => choose("faster"))
    expect(seen).toMatchObject({
      speed: "faster",
      pricedTip: offer.proverTip,
      proverTip: offer.proverTip,
    })
  })

  it("starts on Faster at a 2 DAI tip that is 10% of the amount", async () => {
    faster.offer = { ...OFFER, proverTip: dai(2) }
    await render({ covers: true, amount: dai(20) })
    expect(seen.speed).toBe("faster")
  })

  it("keeps the opening choice when a re-quote crosses the limit", async () => {
    await render({ covers: true })
    faster.offer = { ...OFFER, proverTip: dai(3) }
    await render({ covers: true })
    expect(seen.speed).toBe("faster")
  })

  it("waits on an unknown cover without blocking", async () => {
    await render({ initial: "faster", covers: undefined })
    expect(seen).toMatchObject({ speed: "faster", proverTip: TIP, blocked: undefined })
  })
})

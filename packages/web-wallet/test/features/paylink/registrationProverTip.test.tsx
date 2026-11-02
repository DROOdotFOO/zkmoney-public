/**
 * A ticket registration's speed starts on Faster, and its burn tips the prover only when that is
 * worth it and the note still covers the burn with the tip; Standard, a failed or a stalled quote, or
 * a signup that goes ahead before the quote, commits none.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalSpeedupEstimate, WithdrawalSpeedupNode } from "@obsidion/front-core"
import type { ProverTipQuote } from "@obsidion/sdk"
import {
  REGISTRATION_TIP_BLOCKED_COPY,
  useRegistrationSpeed,
  type RegistrationSpeed,
} from "../../../src/features/paylink/registrationProverTip"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const NODE = {} as WithdrawalSpeedupNode
const TICKET = { fee: dai(0.5), min: 0n }
/** The source executor's withdrawal fee. */
const FEE = dai(0.1)
/** The burn with no tip. */
const BURN = dai(0.71)
const TIP = dai(0.4)
const loaded = (worstSpeedupSeconds: number, proverTip = TIP) => ({
  estimate: {
    epoch: 10,
    checkpointIndex: 3,
    standardEtaSeconds: 2_700,
    tippedEtaSeconds: 2_700 - worstSpeedupSeconds,
    worstSpeedupSeconds,
    speedupSeconds: worstSpeedupSeconds,
    confidence: "measured",
    pastTipCutoff: false,
  } as unknown as WithdrawalSpeedupEstimate,
  quote: { proverTip, gasPriceWei: 1n, usdPerEth: 1n, subsidy: 0n } as ProverTipQuote,
})

describe("useRegistrationSpeed", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: RegistrationSpeed
  const onCommit = vi.fn((_tip: bigint, _speed: string) => {})

  function Harness(props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) {
    seen = useRegistrationSpeed({
      active: true,
      node: NODE,
      noteAmount: dai(4),
      schedule: TICKET,
      withdrawalFee: FEE,
      onCommit,
      ...props,
    })
    return null
  }
  const render = (props: Partial<Parameters<typeof useRegistrationSpeed>[0]>) =>
    act(async () => {
      root.render(<Harness {...props} />)
    })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onCommit.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("falls back to Standard when the note cannot cover the tip", async () => {
    await render({ load: async () => loaded(600), noteAmount: BURN + TIP })
    expect(seen.outcome.blocked).toBe(REGISTRATION_TIP_BLOCKED_COPY)
    expect(seen.choice.speed).toBe("standard")
    expect(seen.proverTip).toBe(0n)
  })

  it("commits Standard when the signup goes ahead before the quote, and a later quote keeps it", async () => {
    let answer: (value: ReturnType<typeof loaded>) => void = () => {}
    await render({ load: () => new Promise((resolve) => (answer = resolve)) })
    expect(seen.proverTip).toBeUndefined()
    await act(async () => seen.settle())
    expect(onCommit).toHaveBeenLastCalledWith(0n, "standard")
    expect(seen.choice.speed).toBe("standard")
    await act(async () => answer(loaded(600)))
    expect(seen.choice.offer?.proverTip).toBe(TIP)
    expect(seen.proverTip).toBe(0n)
    expect(onCommit).toHaveBeenLastCalledWith(0n, "standard")
  })

  it("decides nothing while the schedule is unread", async () => {
    await render({ load: async () => loaded(600), schedule: undefined })
    expect(seen.proverTip).toBeUndefined()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

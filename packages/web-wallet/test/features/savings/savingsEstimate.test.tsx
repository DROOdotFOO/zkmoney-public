import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SavingsPosition } from "@obsidion/front-core"
import {
  SAVINGS_ESTIMATE_TICK_MS,
  splitTicking,
  tickingDigits,
  useSavingsEstimate,
  type SavingsEstimate,
} from "../../../src/features/savings/savingsEstimate"
import { usdAtomicFloor } from "../../../src/ui/format"

const WAD = 10n ** 18n
const T0 = 1_700_000_000_000

describe("splitTicking", () => {
  it("splits a value into the cents figure and the digits that tick beneath it, flooring", () => {
    expect(splitTicking(1000_001183_000000000000n)).toEqual({ whole: "$1,000.00", ticking: "1183" })
    expect(splitTicking(1000_009999_999999999999n)).toEqual({ whole: "$1,000.00", ticking: "9999" })
    expect(splitTicking(25_000_150000_000000000000n)).toEqual({
      whole: "$25,000.15",
      ticking: "0000",
    })
    expect(splitTicking(-5n * WAD)).toEqual({ whole: "$0.00", ticking: "0000000" })
  })

  it("ticks more digits under a smaller value, so the last one turns about once a second", () => {
    // 3% APY grows a value by 9.5e-10 of itself a second: the last digit turns within ~1.1 s.
    expect(tickingDigits(1000n * WAD)).toBe(4)
    expect(tickingDigits(999n * WAD)).toBe(5)
    expect(tickingDigits(100n * WAD)).toBe(5)
    expect(tickingDigits(10n * WAD)).toBe(6)
    expect(tickingDigits(1n * WAD)).toBe(7)
    expect(tickingDigits(WAD / 2n)).toBe(7)
    expect(tickingDigits(0n)).toBe(7)
    for (const dollars of [1n, 10n, 100n, 1000n, 10_000n]) {
      const unit = 10 ** -(2 + tickingDigits(dollars * WAD))
      const perSecond = (Number(dollars) * 0.03) / 31_536_000
      expect(unit / perSecond).toBeLessThanOrEqual(1.1)
    }
    expect(splitTicking(493_150000_000000000000n)).toEqual({ whole: "$493.15", ticking: "00000" })
    expect(splitTicking(10_123456_789000000000n)).toEqual({ whole: "$10.12", ticking: "345678" })
    expect(splitTicking(1_000000_012000000000n)).toEqual({ whole: "$1.00", ticking: "0000012" })
    expect(splitTicking(0n)).toEqual({ whole: "$0.00", ticking: "0000000" })
  })

  it("truncates every Savings figure to cents the way the ticking balance does", () => {
    expect(usdAtomicFloor(254_715245n * 10n ** 12n)).toBe("$254.71")
    expect(usdAtomicFloor(1234_567n * 10n ** 15n)).toBe("$1,234.56")
    expect(usdAtomicFloor(-15n * 10n ** 17n)).toBe("-$1.50")
    expect(usdAtomicFloor(-4n * 10n ** 15n)).toBe("$0.00")
  })
})

describe("useSavingsEstimate", () => {
  let host: HTMLDivElement
  let root: Root
  let latest: SavingsEstimate | undefined
  function Probe({ position, enabled }: { position: SavingsPosition | null; enabled: boolean }) {
    latest = useSavingsEstimate(position, enabled)
    return null
  }
  const render = (position: SavingsPosition | null, enabled: boolean) =>
    act(() => root.render(<Probe position={position} enabled={enabled} />))
  const position: SavingsPosition = {
    shares: 900n * WAD,
    value: 1000n * WAD,
    sharePrice: WAD,
    apy: 0.055,
    readAt: T0,
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it("carries the value forward at the rate on every tick while funded with a rate", () => {
    render(position, true)
    expect(latest).toEqual({ value: 1000n * WAD, ticking: true })
    act(() => void vi.advanceTimersByTime(SAVINGS_ESTIMATE_TICK_MS * 10))
    expect(latest?.ticking).toBe(true)
    expect(latest!.value!).toBeGreaterThan(1000n * WAD)
    const first = latest!.value!
    act(() => void vi.advanceTimersByTime(SAVINGS_ESTIMATE_TICK_MS * 10))
    expect(latest!.value!).toBeGreaterThan(first)
  })

  it("reads plain while hidden, unfunded or without a rate, and unknown without a position", () => {
    render(position, false)
    act(() => void vi.advanceTimersByTime(SAVINGS_ESTIMATE_TICK_MS * 10))
    expect(latest).toEqual({ value: 1000n * WAD, ticking: false })
    render({ ...position, shares: 0n, value: 0n }, true)
    act(() => void vi.advanceTimersByTime(SAVINGS_ESTIMATE_TICK_MS * 10))
    expect(latest).toEqual({ value: 0n, ticking: false })
    render({ ...position, apy: undefined }, true)
    act(() => void vi.advanceTimersByTime(SAVINGS_ESTIMATE_TICK_MS * 10))
    expect(latest).toEqual({ value: 1000n * WAD, ticking: false })
    render(null, true)
    expect(latest).toEqual({ value: undefined, ticking: false })
  })
})

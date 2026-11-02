import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))
import {
  CALCULATOR_HORIZONS,
  EarningsCalculator,
  barsThatFit,
  calculatorStart,
  calculatorSteps,
  groupSteps,
  parseApyPercent,
} from "../../../src/features/savings/EarningsCalculator"

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const total = () => host.querySelector('[data-testid="calculator-total"]')!.textContent
const field = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const chip = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
    (b) => b.textContent === label,
  )
const note = () => host.querySelector(".ww-sheet__note")!.textContent
const dollars = (text: string | null) => Number(text!.replace(/[^\d]/g, ""))
const reset = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Reset")
const blur = (input: HTMLInputElement) =>
  act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))

describe("EarningsCalculator", () => {
  it("projects the start amount and top-ups at the rate, over the chosen horizon", () => {
    const onMove = vi.fn()
    act(() => root.render(<EarningsCalculator apy={0.055} onMove={onMove} />))
    expect(host.textContent).toContain("In 5 years you'd have")
    expect(field("Assumed APY").value).toBe("5.5%")
    expect(note()).toBe(
      "Projection assumes the current 5.5% APY holds and rewards compound every block. The rate is variable, so real earnings will differ.",
    )
    expect(total()).toMatch(/^\$4,0\d\d$/)
    act(() => chip("1 year")!.click())
    expect(total()).toMatch(/^\$1,1[34]\d$/)
    type(field("Monthly top-up"), "$0")
    expect(total()).toMatch(/^\$52[0-9]$/)
    act(() =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Add $500 to Savings")!
        .click(),
    )
    expect(onMove).toHaveBeenCalledWith(500)
  })

  it("offers the top-up, not the start, once Savings holds the start", () => {
    const onMove = vi.fn()
    const add = () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Add "))
    act(() =>
      root.render(
        <EarningsCalculator apy={0.055} balances={{ savings: 20n * 10n ** 18n }} onMove={onMove} />,
      ),
    )
    expect(field("Starting amount").value).toBe("$20")
    act(() => add()!.click())
    expect(onMove).toHaveBeenCalledWith(50)
    type(field("Monthly top-up"), "$0")
    expect(add()).toBeUndefined()
  })

  it("projects at the rate the user types, shown as typed until the field blurs", () => {
    act(() => root.render(<EarningsCalculator apy={0.055} onMove={() => {}} />))
    const atCurrent = dollars(total())
    expect(reset()).toBeUndefined()
    type(field("Assumed APY"), "10")
    expect(field("Assumed APY").value).toBe("10")
    expect(dollars(total())).toBeGreaterThan(atCurrent)
    expect(note()).toBe(
      "Projection assumes 10.0% APY holds and rewards compound every block. The current rate is 5.5%; it is variable, so real earnings will differ.",
    )
    blur(field("Assumed APY"))
    expect(field("Assumed APY").value).toBe("10.0%")
    // Lenient: a percent sign, a comma, junk; and clamped to 0–100.
    expect(parseApyPercent("3.8%")).toBe(0.038)
    expect(parseApyPercent("3,8")).toBe(0.038)
    expect(parseApyPercent("abc")).toBe(0)
    expect(parseApyPercent("")).toBe(0)
    expect(parseApyPercent("-4")).toBe(0)
    expect(parseApyPercent("250%")).toBe(1)
    type(field("Assumed APY"), "0")
    expect(host.textContent).toContain("You earn $0")
    // Typing the current rate back is still the current rate: the note names it once.
    type(field("Assumed APY"), "5.5")
    expect(dollars(total())).toBe(atCurrent)
    expect(note()).toContain("Projection assumes the current 5.5% APY holds")
  })

  it("resets to the current APY, and re-seeds from a new one only while untouched", () => {
    act(() => root.render(<EarningsCalculator apy={0.055} onMove={() => {}} />))
    const atCurrent = dollars(total())
    // A rate read after the sheet opened fills the field.
    act(() => root.render(<EarningsCalculator apy={0.06} onMove={() => {}} />))
    expect(field("Assumed APY").value).toBe("6.0%")
    type(field("Assumed APY"), "3.8")
    const atAssumed = dollars(total())
    expect(atAssumed).toBeLessThan(atCurrent)
    // Once typed, a new live rate leaves the assumed one alone, but the note tracks it.
    act(() => root.render(<EarningsCalculator apy={0.07} onMove={() => {}} />))
    expect(field("Assumed APY").value).toBe("3.8")
    expect(dollars(total())).toBe(atAssumed)
    expect(note()).toContain("The current rate is 7.0%;")
    // Reset hands the field back to the live rate and re-enables following it.
    act(() => reset()!.click())
    expect(reset()).toBeUndefined()
    expect(field("Assumed APY").value).toBe("7.0%")
    expect(note()).toContain("Projection assumes the current 7.0% APY holds")
    act(() => root.render(<EarningsCalculator apy={0.055} onMove={() => {}} />))
    expect(field("Assumed APY").value).toBe("5.5%")
    expect(dollars(total())).toBe(atCurrent)
    // Without a live rate yet, the field is empty until typed in, and the note names no figure.
    act(() => root.render(<EarningsCalculator apy={undefined} onMove={() => {}} />))
    type(field("Assumed APY"), "4")
    expect(field("Assumed APY").value).toBe("4")
    expect(note()).toBe(
      "Projection assumes 4.0% APY holds and rewards compound every block. The rate is variable, so real earnings will differ.",
    )
  })

  it("shows contributions alone without a rate, with the year-by-year table", () => {
    act(() => root.render(<EarningsCalculator apy={undefined} onMove={() => {}} />))
    expect(total()).toBe("$3,500")
    expect(host.querySelectorAll("tbody tr")).toHaveLength(5)
    expect(host.textContent).toContain("You earn $0")
    // The longest horizon is ten years. Unmeasured, the chart holds a phone's five bars, so the ten
    // group by two, ending at the horizon.
    expect(CALCULATOR_HORIZONS.at(-1)).toBe(10)
    expect(chip("20 years")).toBeUndefined()
    act(() => chip("10 years")!.click())
    const years = [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)
    expect(years).toEqual(["Year 2", "Year 4", "Year 6", "Year 8", "Year 10"])
    expect(host.querySelectorAll(".ww-calc__bar")).toHaveLength(5)
  })

  it("starts from the Savings balance to the cent, else Main's DAI, else the default", () => {
    const ONE = 10n ** 18n
    expect(calculatorStart({ savings: 714287899390558444472n, main: 50n * ONE })).toBe(714.28)
    // Dust or no Savings: Main's DAI, the same way.
    expect(calculatorStart({ savings: ONE / 2n, main: 1284_5n * 10n ** 17n })).toBe(1284.5)
    expect(calculatorStart({ savings: 0n, main: 50n * ONE + 999n })).toBe(50)
    // Dust everywhere, or nothing known yet: today's default.
    expect(calculatorStart({ savings: ONE / 2n, main: ONE - 1n })).toBe(500)
    expect(calculatorStart({})).toBe(500)
    expect(calculatorStart()).toBe(500)
    act(() =>
      root.render(
        <EarningsCalculator
          apy={0.055}
          balances={{ savings: 714287899390558444472n }}
          onMove={() => {}}
        />,
      ),
    )
    expect(field("Starting amount").value).toBe("$714.28")
    type(field("Starting amount"), "$900")
    expect(field("Starting amount").value).toBe("$900")
  })

  it("edits cents as cents: a backspace keeps the decimal point, and a third decimal is refused", () => {
    const onMove = vi.fn()
    act(() =>
      root.render(
        <EarningsCalculator
          apy={0}
          balances={{ savings: 714287899390558444472n }}
          onMove={onMove}
        />,
      ),
    )
    type(field("Starting amount"), "$714.2")
    expect(field("Starting amount").value).toBe("$714.2")
    expect(dollars(total())).toBe(714 + 50 * 12 * 5)
    type(field("Starting amount"), "$714.255")
    expect(field("Starting amount").value).toBe("$714.2")
    type(field("Starting amount"), "$12.5")
    expect(field("Starting amount").value).toBe("$12.5")
    blur(field("Starting amount"))
    expect(field("Starting amount").value).toBe("$12.5")
  })

  it("groups steps to the bars the width holds, each group ending at its last step and the last at the horizon", () => {
    const rows = (years: number) =>
      Array.from({ length: years }, (_, i) => ({
        year: i + 1,
        added: 0,
        earned: 0,
        balance: i + 1,
      }))
    const ends = (years: number, maxBars: number) =>
      groupSteps(rows(years), maxBars).map((r) => r.year)
    expect(ends(10, 5)).toEqual([2, 4, 6, 8, 10])
    expect(ends(10, 9)).toEqual([2, 4, 6, 8, 10])
    expect(ends(10, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(ends(10, 4)).toEqual([4, 8, 10])
    expect(ends(10, 1)).toEqual([10])
    expect(ends(7, 2)).toEqual([4, 7])
    expect(ends(5, 5)).toEqual([1, 2, 3, 4, 5])
    expect(ends(1, 5)).toEqual([1])
    for (const [years, maxBars] of [
      [10, 5],
      [10, 3],
      [10, 2],
      [7, 2],
    ] as const) {
      expect(ends(years, maxBars).length).toBeLessThanOrEqual(maxBars)
      expect(ends(years, maxBars).at(-1)).toBe(years)
    }
    // A 342 px chart (a 390 px screen minus the sheet's padding) holds five bars; a 576 px desktop sheet nine.
    expect(barsThatFit(342)).toBe(5)
    expect(barsThatFit(327)).toBe(5)
    expect(barsThatFit(576)).toBe(9)
    expect(barsThatFit(0)).toBe(1)
    // Months need only their three letters: a 342 px chart holds nine, a 576 px desktop sheet twelve.
    expect(barsThatFit(342, 28)).toBe(9)
    expect(barsThatFit(576, 28)).toBe(16)
  })

  it("breaks one year into months named from next month, whose twelfth is the year's figure", () => {
    const NOV_2026 = Date.UTC(2026, 10, 15)
    const months = calculatorSteps(500, 50, 1, 0.055, NOV_2026)
    expect(months.map((m) => m.label)).toEqual([
      "Dec",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
    ])
    const [year] = calculatorSteps(500, 50, 5, 0.055, NOV_2026)
    expect(year.label).toBe("Year 1")
    expect(months[11].balance).toBe(year.balance)
    expect(months[11].added).toBe(year.added)
    expect(months[5].balance).toBeGreaterThan(months[4].balance)
    expect(calculatorSteps(500, 50, 5, 0.055, NOV_2026).map((s) => s.label)).toEqual([
      "Year 1",
      "Year 2",
      "Year 3",
      "Year 4",
      "Year 5",
    ])
    // Rendered at one year, unmeasured, the twelve months group to a phone's bars; the table says Month.
    act(() => root.render(<EarningsCalculator apy={0.055} onMove={() => {}} />))
    act(() => chip("1 year")!.click())
    expect(host.querySelector("thead th")?.textContent).toBe("Month")
    const cells = [...host.querySelectorAll("tbody tr td:first-child")].map(
      (td) => td.textContent ?? "",
    )
    expect(cells.length).toBeLessThanOrEqual(5)
    expect(cells.every((c) => MONTHS.includes(c))).toBe(true)
    expect(cells.at(-1)).toBe(calculatorSteps(500, 50, 1, 0.055)[11].label)
  })
})

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

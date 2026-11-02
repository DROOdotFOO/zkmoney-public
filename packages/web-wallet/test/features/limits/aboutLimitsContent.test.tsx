import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AboutLimitsFacts } from "../../../src/features/limits/aboutLimitsView"
import { LIMITS_DOCS_URL } from "../../../src/lib/links"
import * as copy from "../../../src/features/limits/limitsCopy"
import { LIMIT, LIMIT_USD, grouped } from "../../support/publicLimit"
import { AboutLimitsContent } from "../../../src/features/limits/AboutLimitsContent"

const E18 = 10n ** 18n
const format = { time: (ms: number) => `time:${ms}` }
const observation = {
  available: 500n * E18,
  ceiling: 50_000n * E18,
  ratePerSecond: 578_703_703_703_703_703n,
  decimals: 18,
  tokenSymbol: "DAI",
  observedAt: 1_000,
}
const facts = (overrides: Partial<AboutLimitsFacts> = {}): AboutLimitsFacts => ({
  product: {
    deposit: { maximumUsd: String(LIMIT) },
    withdrawal: { maximumUsd: String(LIMIT) },
    send: { maximumUsd: String(LIMIT) },
  },
  capacity: { state: "fresh", observation },
  sponsorship: { state: "renewal-unknown", maxTx: 100, refillPeriodSeconds: 86_400 },
  ...overrides,
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (props: React.ComponentProps<typeof AboutLimitsContent>) =>
  act(async () => root.render(<AboutLimitsContent format={format} {...props} />))

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe("AboutLimitsContent", () => {
  it("renders the three controls as named regions with machine-readable states", async () => {
    await render({ facts: facts() })
    const regions = [...container.querySelectorAll("section")].map((section) => ({
      name: document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent,
      testId: section.dataset.testid,
      state: section.dataset.state,
    }))
    expect(regions).toEqual([
      { name: copy.LIMIT_TITLE, testId: "about-limits-operation", state: "known" },
      { name: copy.CAPACITY_TITLE, testId: "about-limits-capacity", state: "fresh" },
      {
        name: copy.SPONSORSHIP_TITLE,
        testId: "about-limits-sponsorship",
        state: "renewal-unknown",
      },
    ])
    expect(byTestId("about-limits-sponsorship-state")?.textContent).toBe(
      copy.SPONSORSHIP_STATUS.renewalUnknown,
    )
  })

  it("announces the capacity state without announcing the check time", async () => {
    await render({ facts: facts() })
    const status = byTestId("about-limits-capacity-state")!
    expect(status.getAttribute("role")).toBe("status")
    expect(status.textContent).toBe(copy.CAPACITY_FRESH)
    expect(byTestId("about-limits-capacity")?.textContent).toContain("time:1000")

    const later = { ...observation, observedAt: 61_000 }
    await render({ facts: facts({ capacity: { state: "fresh", observation: later } }) })
    expect(byTestId("about-limits-capacity-state")).toBe(status)
    expect(status.textContent).toBe(copy.CAPACITY_FRESH)
    expect(byTestId("about-limits-capacity")?.textContent).toContain("time:61000")

    await render({ facts: facts({ capacity: { state: "stale", observation } }) })
    expect(status.textContent).toBe(copy.CAPACITY_STALE)
  })

  it("pairs every state label with an icon hidden from assistive technology", async () => {
    await render({
      facts: facts({ capacity: { state: "unavailable" }, sponsorship: { state: "spent" } }),
    })
    for (const id of ["about-limits-capacity-state", "about-limits-sponsorship-state"]) {
      const status = byTestId(id)!
      expect(status.textContent?.trim()).not.toBe("")
      expect(status.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
    }
    expect(byTestId("about-limits-capacity-state")?.textContent).toBe(copy.CAPACITY_UNAVAILABLE)
  })

  it("hides Check again for a current read or when no retry is supplied", async () => {
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    await render({ facts: facts({ capacity: { state: "stale", observation } }) })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
  })

  it("keeps keyboard focus in the section when a retry succeeds", async () => {
    await render({
      facts: facts({ capacity: { state: "stale", observation } }),
      onRetryCapacity: vi.fn(),
    })
    const button = byTestId("about-limits-capacity-retry")!
    button.focus()
    await act(async () => button.click())
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    expect(document.activeElement).toBe(byTestId("about-limits-capacity-state"))
    expect(byTestId("about-limits-capacity-state")?.tabIndex).toBe(-1)
  })

  it("does not take focus back after the user moved it elsewhere", async () => {
    const elsewhere = document.createElement("button")
    document.body.appendChild(elsewhere)
    await render({ facts: facts({ capacity: { state: "unavailable" } }), onRetryCapacity: vi.fn() })
    const button = byTestId("about-limits-capacity-retry")!
    button.focus()
    await act(async () => button.click())
    elsewhere.focus()
    await render({ facts: facts(), onRetryCapacity: vi.fn() })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it("ends with a link to the limits docs", async () => {
    await render({ facts: facts() })
    const link = byTestId("about-limits-more") as HTMLAnchorElement
    expect(link.href).toBe(LIMITS_DOCS_URL)
    expect(link.target).toBe("_blank")
    expect(link.textContent).toBe(copy.MORE_INFO)
    expect(container.firstElementChild!.lastElementChild).toBe(link)
  })

  it("presents rows as a description list", async () => {
    await render({ facts: facts() })
    const rows = [...byTestId("about-limits-operation")!.querySelectorAll("dl > div")].map(
      (row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent],
    )
    expect(rows).toEqual([
      [copy.LIMIT_ROW.send, LIMIT_USD],
      [copy.LIMIT_ROW.deposit, LIMIT_USD],
      [copy.LIMIT_ROW.withdrawal, LIMIT_USD],
    ])
  })

  it("shows only the capacity explanation when no source is connected", async () => {
    await render({ facts: facts({ capacity: undefined }), onRetryCapacity: vi.fn() })
    const capacity = byTestId("about-limits-capacity")!
    expect(capacity.dataset.state).toBe("general")
    expect(byTestId("about-limits-capacity-state")).toBeNull()
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    expect(capacity.textContent).toContain(copy.CAPACITY_DISCLOSURE)
  })
})

describe("AboutLimitsContent topics", () => {
  const toggle = (id: string) => byTestId(`${id}-toggle`)!
  const body = (id: string) =>
    document.getElementById(toggle(id).getAttribute("aria-controls")!) as HTMLElement

  it("expands every section when no topic is given", async () => {
    await render({ facts: facts() })
    for (const id of [
      "about-limits-operation",
      "about-limits-capacity",
      "about-limits-sponsorship",
    ]) {
      expect(toggle(id).getAttribute("aria-expanded")).toBe("true")
      expect(body(id).hidden).toBe(false)
    }
  })

  it("puts the requested topic first and expanded, and the others collapsed", async () => {
    await render({ facts: facts(), topic: "sponsorship" })
    const order = [...container.querySelectorAll("section")].map(
      (section) => section.dataset.testid,
    )
    expect(order).toEqual([
      "about-limits-sponsorship",
      "about-limits-operation",
      "about-limits-capacity",
    ])
    expect(toggle("about-limits-sponsorship").getAttribute("aria-expanded")).toBe("true")
    expect(body("about-limits-sponsorship").hidden).toBe(false)
    for (const id of ["about-limits-operation", "about-limits-capacity"]) {
      expect(toggle(id).getAttribute("aria-expanded")).toBe("false")
      expect(body(id).hidden).toBe(true)
    }
  })

  it("keeps a collapsed section's state and retry visible, and opens it on activation", async () => {
    const retry = vi.fn()
    await render({
      facts: facts({ capacity: { state: "unavailable" } }),
      topic: "limit",
      onRetryCapacity: retry,
    })
    expect(body("about-limits-capacity").hidden).toBe(true)
    expect(byTestId("about-limits-capacity-state")?.textContent).toContain(
      copy.CAPACITY_UNAVAILABLE,
    )
    await act(async () => byTestId("about-limits-capacity-retry")!.click())
    expect(retry).toHaveBeenCalledTimes(1)

    await act(async () => toggle("about-limits-capacity").click())
    expect(toggle("about-limits-capacity").getAttribute("aria-expanded")).toBe("true")
    expect(body("about-limits-capacity").hidden).toBe(false)
    await act(async () => toggle("about-limits-capacity").click())
    expect(body("about-limits-capacity").hidden).toBe(true)
  })

  it("shows the calling surface's lines in their own section only", async () => {
    await render({
      facts: facts(),
      topic: "capacity",
      details: {
        capacity: <p data-testid="own-capacity-line">Recheck before each transfer.</p>,
        limit: <p data-testid="own-limit-line">At most {grouped(LIMIT)} DAI here.</p>,
      },
    })
    expect(body("about-limits-capacity").contains(byTestId("own-capacity-line"))).toBe(true)
    expect(body("about-limits-operation").contains(byTestId("own-limit-line"))).toBe(true)
    // A section's own lines come before its general rows and notes.
    expect(body("about-limits-capacity").firstElementChild).toBe(byTestId("own-capacity-line"))
  })
})

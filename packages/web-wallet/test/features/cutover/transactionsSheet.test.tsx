/** The Choose page's note links to the transactions sheet, which lists the feed by day. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"

vi.mock("../../../src/features/operations/operations", () => ({
  useLeavingLosesTransaction: () => false,
}))
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const { BalanceCard } = await import("../../../src/features/cutover/parts")
const { TransactionsSheet } = await import("../../../src/features/cutover/TransactionsSheet")

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ""
})
const mount = (node: React.ReactNode) => {
  const host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
  act(() => root!.render(<MemoryRouter>{node}</MemoryRouter>))
  return host
}

describe("the balance card's note link", () => {
  it("sits at the end of the note and fires its action", () => {
    const open = vi.fn()
    const host = mount(
      <BalanceCard
        label="Your balance"
        total="$3,371.12"
        spendable="$2,871.12"
        savings="$500.00"
        note="Unclaimed paylinks have been refunded to your balance."
        noteAction={{ label: "See all transactions", onClick: open, testId: "see" }}
      />,
    )
    expect(host.textContent).toContain(
      "Unclaimed paylinks have been refunded to your balance. See all transactions",
    )
    act(() => (host.querySelector('[data-testid="see"]') as HTMLButtonElement).click())
    expect(open).toHaveBeenCalled()
  })
})

describe("TransactionsSheet", () => {
  it("lists the rows under their day, and says when there are none", () => {
    mount(
      <TransactionsSheet
        hydrated
        groups={[
          {
            label: "Today",
            rows: [<p key="a">@cyphergirl −$45</p>, <p key="b">@niall +$34.87</p>],
          },
          { label: "Yesterday", rows: [<p key="c">Metamask +$89.12</p>] },
        ]}
        onClose={() => {}}
      />,
    )
    const text = document.body.textContent ?? ""
    expect(text).toContain("Your transactions")
    expect(text).toContain("Everything on your balance before the upgrade.")
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("@cyphergirl"))
    expect(text.indexOf("Yesterday")).toBeLessThan(text.indexOf("Metamask"))
    act(() => root?.unmount())
    mount(<TransactionsSheet hydrated groups={[]} onClose={() => {}} />)
    expect(document.body.textContent).toContain("No transactions yet.")
  })
})

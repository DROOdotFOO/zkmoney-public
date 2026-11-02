import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
}))
import { AccountSwitcher } from "../../../src/features/savings/AccountSwitcher"

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

const render = (selected: "main" | "savings", onSelect = vi.fn()) => {
  act(() =>
    root.render(
      <AccountSwitcher
        selected={selected}
        onSelect={onSelect}
        mainBalance="$1,000.12"
        savingsBalance="$200.00"
        total="$1,200.12"
        apyLabel="5.5% APY"
      />,
    ),
  )
  return onSelect
}
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Select account"]')!
const options = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]

describe("AccountSwitcher", () => {
  it("names the selected account and opens both accounts with their balances and the total", () => {
    render("main")
    expect(trigger().textContent).toContain("Main Account")
    expect(options()).toHaveLength(0)
    act(() => trigger().click())
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining("Main Account"),
      expect.stringContaining("Savings"),
    ])
    expect(options()[0].textContent).toContain("$1,000.12")
    expect(options()[1].textContent).toContain("5.5% APY · variable · private")
    expect(options()[1].textContent).toContain("$200.00")
    expect(host.textContent).toContain("Total wealth")
    expect(host.textContent).toContain("$1,200.12")
    expect(options()[0].getAttribute("aria-selected")).toBe("true")
  })

  it("picks an account and closes; Escape closes too", () => {
    const onSelect = render("main")
    act(() => trigger().click())
    act(() => options()[1].click())
    expect(onSelect).toHaveBeenCalledWith("savings")
    expect(options()).toHaveLength(0)
    act(() => trigger().click())
    expect(options()).toHaveLength(2)
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(options()).toHaveLength(0)
  })
})

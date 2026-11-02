import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/features/operations/operations", () => ({ useBusyLabel: () => "Busy" }))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: () => undefined,
  SponsoredActionNotice: () => null,
}))
vi.mock("../../../src/ui/LocalPasskeyHint", () => ({ LocalPasskeyHint: () => null }))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}: {value}
    </div>
  ),
  PrimaryGradientButton: ({ title }: { title: string }) => <button>{title}</button>,
}))

const { PayConfirmForm } = await import("../../../src/features/contacts/PayConfirmForm")

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(() => act(() => root.unmount()))

const render = (payee?: { tag: string; savesContact: boolean }) =>
  act(() =>
    root.render(
      <PayConfirmForm
        title="Send"
        amount={12.5}
        note="Lunch"
        ready
        busy={false}
        overspent={false}
        isSend
        payee={payee}
        onConfirm={() => {}}
      />,
    ),
  )

describe("PayConfirmForm", () => {
  it("confirms a plain send by type and amount", async () => {
    await render()
    expect(container.textContent).toContain("Type: Send")
    expect(container.querySelector("button")?.textContent).toBe("Confirm & send")
  })

  it("pays a payee: who, a free fee, private, and the amount on the button", async () => {
    await render({ tag: "river", savesContact: false })
    expect(container.textContent).toContain("To: @river")
    expect(container.textContent).toContain("Fee: Free")
    expect(container.textContent).toContain("Privacy: Private")
    expect(container.textContent).toContain("Lunch")
    expect(container.textContent).not.toContain("added to your contacts")
    expect(container.querySelector("button")?.textContent).toBe("Pay $12.50")
  })

  it("says when paying adds the payee to contacts", async () => {
    await render({ tag: "river", savesContact: true })
    expect(container.textContent).toContain("@river will be added to your contacts.")
  })
})

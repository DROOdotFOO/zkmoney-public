/** The Upgrading page's ring: a spinner with the share done, and the wait behind an info mark. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act } from "react"

vi.mock("../../../src/features/operations/operations", () => ({
  useLeavingLosesTransaction: () => false,
}))
vi.mock("../../../src/ui/Skeletons", () => ({ BalanceSkeleton: () => null, TextSkeleton: () => null }))
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { ProgressScreen } from "../../../src/features/cutover/ProgressScreen"
import { upgradingCopy } from "../../../src/features/cutover/cutoverCopy"

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ""
})

describe("ProgressScreen's ring", () => {
  it("spins, shows the figure, and opens the wait behind the info mark", () => {
    const host = document.body.appendChild(document.createElement("div"))
    root = createRoot(host)
    act(() =>
      root!.render(
        <MemoryRouter>
          <ProgressScreen
            percent={38}
            tip={upgradingCopy.tip}
            spin
            title={upgradingCopy.title}
            body={upgradingCopy.body}
            steps={[
              { title: "Withdraw from old wallet", status: "Done", state: "done" },
              { title: "Deposit to new wallet", state: "active" },
              { title: "Update your account", state: "pending" },
            ]}
          />
        </MemoryRouter>,
      ),
    )
    const ring = host.querySelector('[data-testid="cutover-progress"]')!
    expect(ring.getAttribute("data-spin")).toBe("true")
    expect(ring.textContent).toContain("38%")
    expect(ring.textContent).not.toContain("min left")
    const tip = host.querySelector('[data-testid="cutover-ring-tip"]')!
    expect(tip.getAttribute("data-open")).toBeNull()
    act(() => (tip.querySelector("button") as HTMLButtonElement).click())
    expect(tip.getAttribute("data-open")).toBe("true")
    expect(tip.querySelector('[role="tooltip"]')?.textContent).toBe(
      "This usually takes 5 minutes, up to 10 depending on your device.",
    )
    // The active step's rail is the spinner, not a static arc.
    expect(host.querySelector('[data-state="active"] .zkm-spinner-icon')).not.toBeNull()
  })
})

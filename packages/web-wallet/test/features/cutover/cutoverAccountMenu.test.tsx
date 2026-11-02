/** The cutover pages' account pill opens a menu whose Logout asks before signing out. */
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

const { CutoverPage } = await import("../../../src/features/cutover/parts")

const run = vi.fn(async () => {})
let blocked = false
const page = (
  <MemoryRouter>
    <CutoverPage account={{ tag: "brave-otter-42", logout: { blocked: () => blocked, run } }}>
      <p>body</p>
    </CutoverPage>
  </MemoryRouter>
)

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ""
  blocked = false
})
const mount = () => {
  const host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
  act(() => root!.render(page))
  return host
}
const click = (selector: string) =>
  act(() => (document.querySelector(selector) as HTMLElement).click())

describe("the account pill's menu", () => {
  it("opens from the pill, and Logout asks before signing out", () => {
    const host = mount()
    expect(host.textContent).toContain("brave-otter-42")
    expect(document.querySelector('[role="menu"]')).toBeNull()
    click('[data-testid="cutover-account"]')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Logout")
    click('[data-testid="cutover-logout"]')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.body.textContent).toContain("Log out of zk.money?")
    // The sheet's dark buttons are glass surfaces with role="button".
    const buttons = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
    act(() => buttons.find((b) => b.textContent?.trim() === "Log out")!.click())
    expect(run).toHaveBeenCalled()
  })
  it("holds the logout while a registration is landing", () => {
    blocked = true
    mount()
    click('[data-testid="cutover-account"]')
    click('[data-testid="cutover-logout"]')
    expect(document.body.textContent).toContain("Don't log out yet")
  })
  it("stays a plain pill without a logout", () => {
    const host = document.body.appendChild(document.createElement("div"))
    root = createRoot(host)
    act(() =>
      root!.render(
        <MemoryRouter>
          <CutoverPage account={{ tag: "brave-otter-42" }}>
            <p>body</p>
          </CutoverPage>
        </MemoryRouter>,
      ),
    )
    expect(document.querySelector('[data-testid="cutover-account"]')?.tagName).toBe("SPAN")
  })
})

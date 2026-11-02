import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { LogoutBlockedModal } = await import("../../../src/ui/LogoutBlockedModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("LogoutBlockedModal", () => {
  let host: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onConfirm = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    onClose.mockClear()
    onConfirm.mockClear()
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<LogoutBlockedModal onClose={onClose} onConfirm={onConfirm} />))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it("logs out anyway from the small link under OK", () => {
    const anyway = host.querySelector<HTMLButtonElement>(".ww-logout__anyway")!
    expect(anyway.textContent).toBe("Log out anyway")
    expect(host.querySelector(".ww-logout__actions .ww-logout__anyway")).toBeNull()
    act(() => anyway.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("says the tag is not registered yet and offers OK as the one action", () => {
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Registration in progress",
    )
    expect(host.textContent).toContain("Don't log out yet")
    const body = host.querySelector(".ww-logout__body")?.textContent ?? ""
    expect(body).toContain("isn't registered yet")
    expect(body).toContain("harder to get back into your account")
    expect(body).toContain("Once registration is complete")
    const actions = host.querySelectorAll<HTMLElement>('.ww-logout__actions [role="button"]')
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toBe("OK")
    act(() => actions[0].click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

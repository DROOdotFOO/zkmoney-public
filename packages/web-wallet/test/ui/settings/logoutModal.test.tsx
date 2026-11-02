/**
 * Logging out tears the PXE down and reloads, so over a running proof the sheet says what it
 * would cost and still lets the user go.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startTabBoundOperation } from "../../support/operations"
import { LogoutModal } from "../../../src/ui/LogoutModal"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

let endOperation: (() => Promise<void>) | undefined

afterEach(async () => {
  await act(async () => endOperation?.())
  endOperation = undefined
  await act(async () => root.unmount())
  container.remove()
})

const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    (b) => b.textContent === label,
  )

describe("LogoutModal", () => {
  it("warns over a running proof and still lets the user log out", async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await act(async () => void (endOperation = await startTabBoundOperation()))
    await act(async () => root.render(<LogoutModal onClose={onClose} onConfirm={onConfirm} />))
    expect(document.body.textContent).toContain("A transaction is still being sent")
    await act(async () => button("Wait")!.click())
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => button("Log out anyway")!.click())
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it("clears the warning when the transaction settles while the sheet is open", async () => {
    await act(async () => void (endOperation = await startTabBoundOperation()))
    await act(async () => root.render(<LogoutModal onClose={() => {}} onConfirm={() => {}} />))
    await act(async () => endOperation?.())
    expect(document.body.textContent).toContain("Log out of zk.money?")
  })
})

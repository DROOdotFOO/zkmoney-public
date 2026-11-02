import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { cancelRequestById, showReportableError } = vi.hoisted(() => ({
  cancelRequestById: vi.fn(),
  showReportableError: vi.fn(),
}))

vi.mock("../../../src/features/contacts/requestActions", () => ({ cancelRequestById }))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError }))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "unknown" }))
vi.mock("../../../src/ui/Modal", () => ({
  Modal: ({ children }: { children?: React.ReactNode }) => <div role="dialog">{children}</div>,
}))
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isLoading,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isLoading?: boolean
    isDisabled?: boolean
  }) => (
    <button disabled={isLoading || isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { CancelRequestLinkModal } = await import("../../../src/features/requests/CancelRequestLinkModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("CancelRequestLinkModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text)!
  const click = async (text: string) => {
    await act(async () => {
      button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  }
  const show = async () => {
    await act(async () =>
      root.render(<CancelRequestLinkModal requestId="req-1" onClose={onClose} />),
    )
  }

  it("closes only once the row is gone, and holds the buttons while it goes", async () => {
    let settle!: (applied: boolean) => void
    cancelRequestById.mockReturnValue(new Promise<boolean>((r) => (settle = r)))
    await show()

    await click("Cancel request")
    expect(cancelRequestById).toHaveBeenCalledWith("req-1")
    expect(onClose).not.toHaveBeenCalled()
    expect(button("Cancelling…").disabled).toBe(true)
    expect(button("Keep").disabled).toBe(true)

    await act(async () => settle(true))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("says so when the row already settled instead of pretending it was cancelled", async () => {
    cancelRequestById.mockResolvedValue(false)
    await show()

    await click("Cancel request")
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).toContain("already paid or cancelled")
    expect(button("Cancel request")).toBeUndefined()

    await click("Close")
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("reports a failed cancel and stays open for another try", async () => {
    cancelRequestById.mockRejectedValueOnce(new Error("storage down"))
    await show()

    await click("Cancel request")
    expect(showReportableError).toHaveBeenCalledWith(expect.any(Error), "request-link:remove")
    expect(onClose).not.toHaveBeenCalled()
    expect(button("Cancel request").disabled).toBe(false)
  })
})

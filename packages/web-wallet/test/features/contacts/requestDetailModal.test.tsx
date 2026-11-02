import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemindState } from "../../../src/features/contacts/useRemind"

vi.mock("@obsidion/web-ds", () => ({
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    isLoading,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    isLoading?: boolean
    onClick: () => void
  }) => (
    <button disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
      {isLoading && <span aria-label="Loading" />}
    </button>
  ),
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  formatDateLabel: () => "Today",
  formatTimeLabel: () => "14:32",
}))

const cancelRequestById = vi.fn(async (_id: string) => true)
vi.mock("../../../src/features/contacts/requestActions", () => ({
  cancelRequestById: (id: string) => cancelRequestById(id),
}))
vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://node" }),
}))
vi.mock("../../../src/lib/explorer", () => ({
  l2TxUrl: (_n: string, _u: string, hash: string) => `https://explorer/${hash}`,
}))
const showReportableError = vi.fn()
vi.mock("../../../src/errors/errorModal", () => ({
  showReportableError: (...a: unknown[]) => showReportableError(...a),
}))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))

const { RequestDetailModal } = await import(
  "../../../src/features/contacts/RequestDetailModal/RequestDetailModal"
)
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../src/platform/session"
)

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const pendingRow = {
  id: "req-1",
  contactTag: "cyphergirl",
  amount: 45,
  asset: WALLET_TOKEN_SYMBOL,
  direction: "outgoing",
  status: "pending",
  createdAt: 1_700_000_000_000,
  note: "Pizza dinner",
} as const
/** The request, paid before payments were read from the chain: it reads fulfilled. */
const paidRow = { ...pendingRow, status: "paid", fulfillmentTxHash: "0xabcdef1234567890" } as const

describe("RequestDetailModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await switchSession(activeNamespace()).requests.add(pendingRow)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.useRealTimers()
    closeSession()
  })

  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)

  async function render(initialStep?: "detail" | "confirm") {
    await act(async () => {
      root.render(
        <RequestDetailModal
          requestId="req-1"
          tag="cyphergirl"
          initialStep={initialStep}
          onClose={onClose}
        />,
      )
    })
  }

  it("shows the stored row with an Unpaid status and a cancel entry point", async () => {
    await render()
    expect(container.textContent).toContain("cyphergirl.zk.money")
    expect(container.textContent).toContain("Receive")
    expect(container.textContent).toContain("$45.00")
    expect(container.textContent).toContain("Pizza dinner")
    expect(container.textContent).toContain("Today, 14:32")
    expect(container.textContent).toContain("--")
    expect(container.textContent).toContain("Unpaid")
    expect(button("Cancel request")).toBeDefined()
  })

  it("offers Remind beside Cancel on a sent request, with a spinner while it sends", async () => {
    const onRemind = vi.fn()
    const view = (remind: RemindState) => (
      <RequestDetailModal requestId="req-1" remind={remind} onRemind={onRemind} onClose={onClose} />
    )
    await act(async () => root.render(view("idle")))
    await act(async () => button("Remind")!.click())
    expect(onRemind).toHaveBeenCalledOnce()
    await act(async () => root.render(view("sending")))
    expect(button("Remind")!.disabled).toBe(true)
    expect(button("Remind")!.querySelector("[aria-label=Loading]")).not.toBeNull()
    await act(async () => root.render(view("failed")))
    expect(button("Try again")!.disabled).toBe(false)
    await act(async () => root.render(view("sent")))
    expect(button("Reminder sent")!.disabled).toBe(true)
    await act(async () => button("Cancel request")!.click())
    expect(container.textContent).toContain("Cancel request?")
  })

  it("opens straight on the confirm sheet for the bubble's inline Cancel", async () => {
    await render("confirm")
    expect(container.textContent).toContain("Cancel request?")
    expect(container.textContent).not.toContain("Unpaid")
    expect(button("Cancel request")).toBeDefined()
  })

  it("links the fulfillment tx and drops the cancel button once fulfilled", async () => {
    await session().requests.add(paidRow)
    await render()
    expect(container.textContent).toContain("Completed")
    expect(button("Cancel request")).toBeUndefined()
    const link = container.querySelector<HTMLAnchorElement>("a.ww-request-detail__hash")
    expect(link?.href).toBe("https://explorer/0xabcdef1234567890")
  })

  it("cancels through the confirm step, then auto-closes after the cancelled notice", async () => {
    vi.useFakeTimers()
    await render()
    await act(async () => button("Cancel request")?.click())
    expect(container.textContent).toContain("Cancel request?")

    await act(async () => button("Cancel request")?.click())
    expect(cancelRequestById).toHaveBeenCalledWith("req-1")
    expect(container.textContent).toContain("Request cancelled")
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("shows the settled status instead of a cancel notice when the flip is refused", async () => {
    cancelRequestById.mockResolvedValueOnce(false)
    await render()
    await act(async () => button("Cancel request")?.click())
    await session().requests.add(paidRow)
    await act(async () => button("Cancel request")?.click())
    expect(container.textContent).not.toContain("Request cancelled")
    expect(container.textContent).toContain("Completed")
    expect(button("Cancel request")).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
    expect(showReportableError).not.toHaveBeenCalled()
  })

  it("stays open and reports when the cancel flip fails", async () => {
    cancelRequestById.mockRejectedValueOnce(new Error("boom"))
    await render()
    await act(async () => button("Cancel request")?.click())
    await act(async () => button("Cancel request")?.click())
    expect(showReportableError).toHaveBeenCalled()
    expect(container.textContent).toContain("Cancel request?")
    expect(container.textContent).not.toContain("Request cancelled")
  })

  it("closes itself when the row no longer exists", async () => {
    await session().requests.remove("req-1")
    await render()
    expect(onClose).toHaveBeenCalled()
  })
})

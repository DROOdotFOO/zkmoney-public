import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

const { CONNECT_STASH_KEY } = await import("../../../src/features/contacts/connectReceive")
const { ConnectPendingNotice } = await import("../../../src/features/contacts/ConnectPendingNotice")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("ConnectPendingNotice", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sessionStorage.clear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("tells a visitor holding a connect link that the contact is next, without naming anyone", async () => {
    sessionStorage.setItem(CONNECT_STASH_KEY, JSON.stringify({ hash: "#packet" }))
    await act(async () => root.render(<ConnectPendingNotice />))
    expect(container.textContent).toContain("Adding a contact")
    expect(container.textContent).not.toContain("@")
  })

  it("renders nothing without a waiting link", async () => {
    await act(async () => root.render(<ConnectPendingNotice />))
    expect(container.textContent).toBe("")
  })
})

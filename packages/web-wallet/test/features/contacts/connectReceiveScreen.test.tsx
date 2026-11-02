import React, { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  confirm: vi.fn(),
  take: vi.fn(),
  report: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({ CONNECT_BACK_VERSION: 1 }))
vi.mock("@obsidion/front-core", () => ({
  ContactStorage: {},
  PendingConnectBackStorage: {},
  decodeInline: vi.fn(),
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Spinner: () => null,
  avatarColors: () => [],
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: mocks.report }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("../../../src/platform/xmtp/xmtpLifecycle", () => ({ getXmtpSender: () => null }))
vi.mock("../../../src/features/contacts/registryResolution", () => ({ verifyTag: vi.fn() }))
vi.mock("../../../src/features/contacts/ContactsScreen/ContactsScreen", () => ({
  ContactsScreen: () => <div>Directory background</div>,
}))
vi.mock("../../../src/features/contacts/connectReceive", () => ({
  confirmConnect: mocks.confirm,
  previewConnect: mocks.preview,
  stashInboundConnect: vi.fn(),
  stashToPayload: (stash: { hash: string }) => stash.hash,
  takeConnectStash: mocks.take,
}))

const { ConnectReceiveScreen } = await import("../../../src/features/contacts/ConnectReceiveScreen")
let root: Root
let container: HTMLDivElement
const preview = {
  kind: "confirm",
  preview: { contact: { tag: "alice", name: "Alice" }, verified: true },
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.take.mockReturnValue({ hash: "#packet" })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={["/connect"]}>
          <Routes>
            <Route path="/connect" element={<ConnectReceiveScreen />} />
            <Route path="/contacts" element={<div>Contacts destination</div>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    ),
  )
}

it.each(["close", "escape", "backdrop"])(
  "allows %s during verification and ignores late errors",
  async (method) => {
    let reject!: (error: Error) => void
    mocks.preview.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    await render()
    const dialog = container.querySelector("dialog")!
    await act(async () => {
      if (method === "close")
        container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()
      else if (method === "backdrop") dialog.click()
      else
        dialog.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        )
    })
    expect(container.textContent).toBe("Contacts destination")
    await act(async () => reject(new Error("Late network failure")))
    expect(mocks.report).not.toHaveBeenCalled()
  },
)

it.each(["result", "rejection"])(
  "leaves the consumed route after a preview error (%s)",
  async (kind) => {
    if (kind === "result")
      mocks.preview.mockResolvedValue({ kind: "error", message: "Registry mismatch" })
    else mocks.preview.mockRejectedValue(new Error("Preview failed"))
    await render()
    expect(container.textContent).toBe("Contacts destination")
    expect(mocks.report).toHaveBeenCalledTimes(1)
    expect(mocks.confirm).not.toHaveBeenCalled()
  },
)

it("leaves the consumed route after an add error", async () => {
  mocks.preview.mockResolvedValue(preview)
  mocks.confirm.mockResolvedValue({ kind: "error", message: "Storage failed" })
  await render()
  expect(mocks.take).toHaveBeenCalledTimes(1)
  expect(mocks.confirm).not.toHaveBeenCalled()
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Add contact")!
      .click(),
  )
  expect(container.textContent).toBe("Contacts destination")
  expect(mocks.report).toHaveBeenCalledTimes(1)
})

it("names the stored contact on a conflict instead of opening it", async () => {
  mocks.preview.mockResolvedValue(preview)
  mocks.confirm.mockResolvedValue({ kind: "conflict", contact: { tag: "old-tag", name: "old-tag" } })
  await render()
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add contact")!.click())
  expect(container.textContent).toContain("@alice wasn't added. @old-tag in your contacts has the same address or name.")
  expect(container.textContent).not.toContain("Contacts destination")
  expect(mocks.report).not.toHaveBeenCalled()
})

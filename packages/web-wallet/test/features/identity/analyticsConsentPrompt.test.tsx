import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  asked: false,
  setAsked: vi.fn(async () => {}),
  setConsent: vi.fn(async () => {}),
}))

vi.mock("@obsidion/front-core", () => ({
  useConfigValue: (key: string) =>
    key === "analyticsAsked"
      ? { value: h.asked, setValue: h.setAsked }
      : { value: false, setValue: h.setConsent },
}))
vi.mock("@obsidion/web-ds", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))
const { saveWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
const { AnalyticsConsentPrompt } = await import(
  "../../../src/features/onboarding/AnalyticsConsentModal"
)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn()
  h.asked = false
  h.setAsked.mockClear()
  h.setConsent.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = () => act(async () => root.render(<AnalyticsConsentPrompt />))
const prompt = () => container.querySelector("dialog")

describe("AnalyticsConsentPrompt", () => {
  it("waits for the tag to confirm, then asks once and saves the answer", async () => {
    await saveWalletIdentity({ address: "0x1", claimedAt: 1, handle: "taga", pending: true })
    await render()
    expect(prompt()).toBeNull()

    await act(() => saveWalletIdentity({ address: "0x1", claimedAt: 1, handle: "taga" }))
    expect(prompt()).not.toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>("button:last-child")!.click())
    expect(h.setConsent).toHaveBeenCalledWith(false)
    expect(h.setAsked).toHaveBeenCalledWith(true)
  })

  it("asks nothing before a wallet exists or after an answer", async () => {
    await render()
    expect(prompt()).toBeNull()
    await saveWalletIdentity({ address: "0x1", claimedAt: 1, handle: "taga" })
    h.asked = true
    await render()
    expect(prompt()).toBeNull()
  })
})

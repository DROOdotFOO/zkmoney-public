/** New request → A contact: who the request can go to. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContactStorage } from "@obsidion/front-core"
import { RequestContactPicker } from "../../../src/features/receive/RequestContactPicker/RequestContactPicker"
import { saveWalletIdentity } from "../../../src/features/identity/walletIdentity"
import { activeNamespace, closeSession, switchSession } from "../../../src/platform/session"
import { InMemoryStorageAdapter } from "../../support/memoryStorage"

describe("RequestContactPicker", () => {
  let container: HTMLDivElement
  let root: Root
  const onRequest = vi.fn()
  const text = () => container.textContent ?? ""
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
  const type = (value: string) =>
    act(async () => {
      const input = container.querySelector<HTMLInputElement>("input")!
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      set.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })

  beforeEach(async () => {
    ContactStorage.resetForTests()
    const contacts = ContactStorage.get(new InMemoryStorageAdapter())
    await contacts.addEntry({ name: "sam", tag: "sam", address: `0x${"1a".repeat(32)}` })
    await contacts.addEntry({
      name: "Bank",
      address: `0x${"ab".repeat(20)}`,
      addressKind: "ethereum-l1",
    })
    await saveWalletIdentity({ handle: "river", address: `0x${"2c".repeat(32)}`, claimedAt: 0 })
    switchSession(activeNamespace())
    onRequest.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<RequestContactPicker onRequest={onRequest} />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    closeSession()
  })

  it("offers zk.money contacts only", async () => {
    expect(text()).toContain("@sam")
    expect(text()).not.toContain("Bank")
    await act(async () => button("@sam")!.click())
    expect(onRequest).toHaveBeenCalledWith("sam")
  })

  it("shows Sending… on the request on its way and ignores other taps", async () => {
    await act(async () => root.render(<RequestContactPicker sending="sam" onRequest={onRequest} />))
    expect(button("@sam")!.textContent).toContain("Sending…")
    await act(async () => button("@sam")!.click())
    expect(onRequest).not.toHaveBeenCalled()
  })

  it("offers a typed @tag that is not a contact, but never your own", async () => {
    await type("@maya")
    await act(async () => button("@maya")!.click())
    expect(onRequest).toHaveBeenCalledWith("maya")
    await type("@river")
    expect(button("@river")).toBeUndefined()
  })
})

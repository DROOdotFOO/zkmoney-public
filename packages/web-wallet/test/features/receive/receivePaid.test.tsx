import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ReceivePaid } from "../../../src/features/receive/ReceiveCodeFace"

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const payment = { amount: 5, via: "private" as const, hadAddress: true }
const next = { requestId: "0x1", url: "https://wallet.test/pay/river#x", amount: 0, expiresAt: 1 }

describe("ReceivePaid", () => {
  it.each([
    ["offers the next code once it is minted", next, "Ready for the next payment", false],
    ["holds Show code until the next code is minted", undefined, "Making your next code", true],
  ])("%s", (_case, code, line, disabled) => {
    act(() => root.render(<ReceivePaid payment={payment} next={code} onShowCode={() => {}} />))
    expect(container.textContent).toContain(line)
    const show = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Show code",
    )!
    expect(show.disabled).toBe(disabled)
  })
})

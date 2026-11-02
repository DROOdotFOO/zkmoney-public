/** The iOS floor notice shows for a phone claiming iOS below 18.4 and for nothing else. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IosFloorNotice } from "../../../src/features/identity/IosFloorNotice"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const IOS = (v: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Safari/604.1`
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.3 Safari/605.1.15"

const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
const claim = (value: string) =>
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })

let container: HTMLDivElement
let root: Root
const render = () =>
  act(async () => {
    root.render(<IosFloorNotice />)
    await new Promise((r) => setTimeout(r, 0))
  })
const notice = () => container.querySelector('[data-testid="ios-floor-notice"]')

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Object.defineProperty(navigator, "userAgent", ua)
})

describe("IosFloorNotice", () => {
  it("warns a phone claiming iOS 18.3", async () => {
    claim(IOS("18_3"))
    await render()
    expect(notice()).not.toBeNull()
    expect(notice()?.querySelector("button")).toBeNull()
  })

  it("stays quiet at the floor", async () => {
    claim(IOS("18_4"))
    await render()
    expect(notice()).toBeNull()
  })

  it("stays quiet on a laptop and on a phone without a version", async () => {
    claim(MAC)
    await render()
    expect(notice()).toBeNull()
    claim("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15")
    await render()
    expect(notice()).toBeNull()
  })
})

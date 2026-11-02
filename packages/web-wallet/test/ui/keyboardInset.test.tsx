import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  KEYBOARD_INSET_PROPERTY,
  VISIBLE_HEIGHT_PROPERTY,
  keyboardInset,
  pageBottom,
  revealAboveKeyboard,
  revealFocusedField,
  useKeyboardInset,
  viewportSettled,
} from "../../src/ui/keyboardInset"

/** iOS Safari's visual viewport: the page keeps its height while the keyboard covers part of it. */
class FakeViewport extends EventTarget {
  height = 800
  offsetTop = 0
}

function Sheet() {
  const root = useRef<HTMLDivElement>(null)
  useKeyboardInset(root)
  return (
    <div ref={root} data-testid="sheet">
      <input />
      <input type="checkbox" />
    </div>
  )
}

let host: HTMLDivElement
let root: Root
let viewport: FakeViewport
/** Where the sheet's box ends; the full page height unless the browser ends it above the keyboard. */
let sheetBottom: number
const install = (value: FakeViewport | undefined) =>
  Object.defineProperty(window, "visualViewport", { value, configurable: true })

beforeEach(() => {
  viewport = new FakeViewport()
  install(viewport)
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true })
  sheetBottom = 800
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ bottom: sheetBottom } as DOMRect),
  )
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  install(undefined)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const sheet = () => host.querySelector<HTMLElement>("[data-testid=sheet]")!
const inset = () => sheet().style.getPropertyValue(KEYBOARD_INSET_PROPERTY)
const visible = () => sheet().style.getPropertyValue(VISIBLE_HEIGHT_PROPERTY)

describe("useKeyboardInset", () => {
  it("keeps the keyboard's overlay height and the visible height on the sheet, following the viewport", () => {
    act(() => root.render(<Sheet />))
    act(() => sheet().querySelector("input")!.focus())
    expect(inset()).toBe("0px")
    expect(visible()).toBe("800px")
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("300px")
    expect(visible()).toBe("500px")
    viewport.offsetTop = 20
    act(() => viewport.dispatchEvent(new Event("scroll")))
    expect(inset()).toBe("280px")
    viewport.height = 800
    viewport.offsetTop = 0
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("0px")
  })

  it("lifts nothing where the browser already ends the sheet's box above the keyboard", () => {
    act(() => root.render(<Sheet />))
    act(() => sheet().querySelector("input")!.focus())
    viewport.height = 500
    sheetBottom = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("0px")
    expect(visible()).toBe("500px")
  })

  it("measures again when the sheet's box ends above the keyboard after the viewport resized", () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
    act(() => root.render(<Sheet />))
    act(() => sheet().querySelector("input")!.focus())
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("300px")
    sheetBottom = 500
    act(() => observers.forEach((fire) => fire()))
    expect(inset()).toBe("0px")
    vi.unstubAllGlobals()
  })

  it("sets nothing while no field that raises a keyboard has focus", () => {
    act(() => root.render(<Sheet />))
    viewport.height = 700
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("")
    act(() => sheet().querySelector<HTMLInputElement>("[type=checkbox]")!.focus())
    expect(inset()).toBe("")
    act(() => sheet().querySelector("input")!.focus())
    expect(inset()).toBe("100px")
    act(() => sheet().querySelector("input")!.blur())
    expect(inset()).toBe("")
  })

  it("clears the properties and stops listening when the sheet goes", () => {
    act(() => root.render(<Sheet />))
    act(() => sheet().querySelector("input")!.focus())
    const element = sheet()
    act(() => root.render(<div />))
    expect(element.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("")
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(element.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("")
  })

  it("sets nothing where the browser exposes no visual viewport", () => {
    install(undefined)
    act(() => root.render(<Sheet />))
    expect(inset()).toBe("")
    expect(keyboardInset()).toBeUndefined()
  })
})

describe("content in the page's flow", () => {
  function PageForm() {
    const root = useRef<HTMLDivElement>(null)
    useKeyboardInset(root, true, pageBottom)
    return (
      <div ref={root} data-testid="sheet">
        <input />
      </div>
    )
  }

  it("takes the keyboard's height against the page, wherever the form's box ends", () => {
    sheetBottom = 1600
    act(() => root.render(<PageForm />))
    act(() => sheet().querySelector("input")!.focus())
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("300px")
  })

  it("scrolls the page so a form ends above the keyboard once it settles", async () => {
    vi.useFakeTimers()
    const scrollBy = vi.fn()
    window.scrollBy = scrollBy as typeof window.scrollBy
    const form = document.createElement("div")
    host.append(form)
    sheetBottom = 700
    const revealed = revealAboveKeyboard(form)
    viewport.height = 500
    viewport.dispatchEvent(new Event("resize"))
    await vi.advanceTimersByTimeAsync(120)
    await revealed
    expect(scrollBy).toHaveBeenCalledWith({ top: 200 })

    scrollBy.mockClear()
    sheetBottom = 480
    await Promise.all([revealAboveKeyboard(form), vi.advanceTimersByTimeAsync(600)])
    expect(scrollBy).not.toHaveBeenCalled()
  })
})

describe("revealFocusedField", () => {
  it("scrolls the focused field into view once the keyboard has settled, only where the keyboard overlays", async () => {
    vi.useFakeTimers()
    const field = document.createElement("input")
    field.scrollIntoView = vi.fn()
    host.append(field)
    field.focus()
    const revealed = revealFocusedField(field)
    viewport.height = 500
    viewport.dispatchEvent(new Event("resize"))
    await vi.advanceTimersByTimeAsync(119)
    expect(field.scrollIntoView).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await revealed
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
    // Android and desktop: the page resized instead, so there is nothing to lift over.
    viewport.height = 800
    vi.mocked(field.scrollIntoView).mockClear()
    const flat = revealFocusedField(field)
    await vi.advanceTimersByTimeAsync(600)
    await flat
    expect(field.scrollIntoView).not.toHaveBeenCalled()
  })

  it("settles at once without a visual viewport, and at most after the limit", async () => {
    vi.useFakeTimers()
    install(undefined)
    await viewportSettled()
    install(viewport)
    let settled = false
    void viewportSettled(120, 600).then(() => (settled = true))
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      viewport.dispatchEvent(new Event("resize"))
    }
    expect(settled).toBe(true)
  })
})

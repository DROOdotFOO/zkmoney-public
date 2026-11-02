import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScanShare } from "../../../src/features/scan/useScanShare"
import type { ScanResult } from "../../../src/features/scan/scanPayload"

let root: Root
let host: HTMLDivElement
let opener: HTMLButtonElement
let fallback: HTMLButtonElement
let flow: ReturnType<typeof useScanShare>
let options: Parameters<typeof useScanShare>[0]
function Harness() {
  flow = useScanShare(options)
  return null
}
const render = () => act(() => root.render(<Harness />))
const run = (fn: () => void) => act(fn)
const id = () => flow.session!.id
beforeEach(() => {
  host = document.createElement("div")
  opener = document.createElement("button")
  fallback = document.createElement("button")
  document.body.append(host, opener, fallback)
  root = createRoot(host)
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList)
  options = {
    routeKey: "home",
    identityKey: "alice",
    scanAvailable: true,
    fallback: () => fallback,
    resolve: vi.fn(
      async () =>
        ({
          kind: "destination",
          destination: { to: "/contacts", state: { searchTag: "bob" } },
        } as ScanResult),
    ),
    onDestination: vi.fn(),
  }
  render()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  opener.remove()
  fallback.remove()
  vi.restoreAllMocks()
})
describe("Scan and Share origin ownership", () => {
  it.each(["scan", "share"] as const)(
    "returns to %s, remounts each session, and exits to the opener without navigation",
    (origin) => {
      const other = origin === "scan" ? "share" : "scan"
      run(() => flow.open(origin, opener))
      const first = id()
      run(() => flow.switchTo(first, other))
      expect(flow.session?.surface).toBe(other)
      const second = id()
      run(() => flow.close(first))
      expect(id()).toBe(second)
      run(() => flow.close(second))
      expect(flow.session?.surface).toBe(origin)
      expect(id()).toBeGreaterThan(second)
      run(() => flow.close(id()))
      expect(flow.session).toBeNull()
      expect(document.activeElement).toBe(opener)
      expect(options.onDestination).not.toHaveBeenCalled()
    },
  )
  it("keeps the original opener over repeated toggles", () => {
    run(() => flow.open("share", opener))
    for (let n = 0; n < 5; n++) {
      run(() => flow.switchTo(id(), "scan"))
      run(() => flow.switchTo(id(), "share"))
    }
    run(() => flow.close(id()))
    expect(document.activeElement).toBe(opener)
    expect(options.onDestination).not.toHaveBeenCalled()
  })
  it("hands off once and ignores delayed Close without taking destination focus", () => {
    run(() => flow.open("scan", opener))
    const departed = id()
    options.onDestination = vi.fn(() => fallback.focus())
    render()
    run(() => flow.destination(departed, { to: "/contacts" }))
    run(() => {
      flow.close(departed)
      flow.destination(departed, { to: "/connect#stale" })
      flow.switchTo(departed, "share")
    })
    expect(flow.session).toBeNull()
    expect(options.onDestination).toHaveBeenCalledOnce()
    expect(options.onDestination).toHaveBeenCalledWith({ to: "/contacts" })
    expect(document.activeElement).toBe(fallback)
  })
  it.each(["scanAvailable", "identityKey", "routeKey"] as const)(
    "invalidates capture and pending resolution after %s changes",
    async (key) => {
      let complete!: (value: ScanResult) => void
      options.resolve = vi.fn(
        () =>
          new Promise<ScanResult>((resolve) => {
            complete = resolve
          }),
      )
      render()
      run(() => flow.open("scan", opener))
      const old = id()
      const pending = flow.resolve(old, "@bob")
      options = { ...options, [key]: key === "scanAvailable" ? false : "changed" }
      render()
      expect(flow.session).toBeNull()
      complete({ kind: "destination", destination: { to: "/contacts" } })
      expect((await pending).kind).toBe("error")
      run(() => flow.destination(old, { to: "/contacts" }))
      expect(options.onDestination).not.toHaveBeenCalled()
    },
  )
  it("blocks scanning when unavailable and closes Share reached from Scan on resize", () => {
    options = { ...options, scanAvailable: false }
    render()
    run(() => flow.open("scan", opener))
    expect(flow.session).toBeNull()
    run(() => flow.open("share", opener))
    run(() => flow.switchTo(id(), "scan"))
    expect(flow.session?.surface).toBe("share")
    run(() => flow.close(id()))
    options = { ...options, scanAvailable: true }
    render()
    run(() => flow.open("scan", opener))
    run(() => flow.switchTo(id(), "share"))
    options = { ...options, scanAvailable: false }
    render()
    expect(flow.session).toBeNull()
  })
  it("uses a viable fallback when the opener disappeared", () => {
    run(() => flow.open("scan", opener))
    opener.remove()
    run(() => flow.close(id()))
    expect(document.activeElement).toBe(fallback)
  })
  it("does not steal focus from another native overlay", () => {
    run(() => flow.open("scan", opener))
    const dialog = document.createElement("dialog")
    dialog.open = true
    const button = document.createElement("button")
    dialog.append(button)
    host.append(dialog)
    button.focus()
    run(() => flow.close(id()))
    expect(document.activeElement).toBe(button)
  })
})

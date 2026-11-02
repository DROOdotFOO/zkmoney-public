/** `busy` follows the latest run: an earlier run settling under a newer one does not clear it. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "unknown" }))

const { useAsyncAction } = await import("../../src/ui/hooks")

let latest: ReturnType<typeof useAsyncAction>
function Probe() {
  latest = useAsyncAction()
  return <span data-testid="state">{latest.busy ? "busy" : "idle"}</span>
}

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Probe />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const state = () => container.querySelector('[data-testid="state"]')!.textContent
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("useAsyncAction", () => {
  it("stays busy when an earlier run settles under a newer one", async () => {
    const one = deferred()
    const two = deferred()
    await act(async () => void latest.run(() => one.promise))
    await act(async () => void latest.run(() => two.promise))
    await act(async () => one.resolve())
    expect(state()).toBe("busy")
    await act(async () => two.resolve())
    expect(state()).toBe("idle")
  })
})

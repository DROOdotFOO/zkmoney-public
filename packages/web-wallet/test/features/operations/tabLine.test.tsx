/**
 * The tab line reads the operation's record: keep while this page proves it, safe once the flow's
 * record holds the hash, nothing once it ends or when no flow in this page runs it.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"
import { getOperationStore } from "../../../src/features/operations/operations"
import { TabLine, type TabPlace } from "../../../src/features/operations/TabLine"

const hash = `0x${"cd".repeat(32)}`
const flush = () => new Promise((r) => setTimeout(r, 0))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  host = document.createElement("div")
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

async function render(operationId: string | undefined, place?: TabPlace) {
  await act(async () => root.render(<TabLine operationId={operationId} place={place} />))
}

async function step(change: () => unknown) {
  await act(async () => {
    await change()
    await flush()
  })
}

describe("TabLine", () => {
  it("says keep while this page proves it, safe once sent, and nothing once it settles", async () => {
    const store = getOperationStore()
    await store.begin({ operationId: "tl-1", flow: "send", summary: "$5", scope: null })
    await render("tl-1")
    expect(host.textContent).toBe("Keep this tab open until it's sent")
    expect(host.firstElementChild?.className).toBe("ww-tabline ww-tabline--keep")

    await step(() => provingProgress.emitTxHashSaved("tl-1", hash))
    expect(host.textContent).toBe("Sent · You can close this tab")
    expect(host.firstElementChild?.className).toBe("ww-tabline ww-tabline--safe")

    // Released while sent: the chain has it, so the tab may still close.
    await step(() => store.release("tl-1"))
    expect(host.textContent).toBe("Sent · You can close this tab")

    await step(() => store.settle("tl-1", hash))
    expect(host.textContent).toBe("")
  })

  it("says nothing for a local record no flow in this page runs", async () => {
    const store = getOperationStore()
    await store.begin({ operationId: "tl-2", flow: "send", summary: "$5", scope: null })
    await render("tl-2")
    expect(host.textContent).toContain("Keep this tab open")
    await step(() => store.release("tl-2"))
    expect(host.textContent).toBe("")
  })

  it("says nothing without an operation, or for one the store does not hold", async () => {
    await render(undefined)
    expect(host.textContent).toBe("")
    await render("tl-missing")
    expect(host.textContent).toBe("")
  })

  it("says page on the visitor's page", async () => {
    const store = getOperationStore()
    await store.begin({ operationId: "tl-3", flow: "paylink-claim-l1", summary: "$5", scope: null })
    await render("tl-3", "page")
    expect(host.textContent).toBe("Keep this page open until it's sent")
    await step(() => provingProgress.emitTxHashSaved("tl-3", hash))
    expect(host.textContent).toBe("Sent · You can close this page")
    store.release("tl-3")
  })
})

/**
 * The shared editor with no booted wallet behind it (the desktop settings page), over the real
 * endpoint record in this browser's storage.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EndpointFields,
  useEndpointEditor,
  type EndpointCommit,
  type EndpointEditor,
} from "../../../src/ui/endpointsEditor"

const RECORD = "webwallet.endpoints"
let root: Root
let container: HTMLDivElement
let editor: EndpointEditor

function Harness({ defaults }: { defaults?: Record<string, string> }) {
  editor = useEndpointEditor()
  return <EndpointFields editor={editor} defaults={defaults} />
}

async function mount(defaults?: Record<string, string>) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness defaults={defaults} />))
}
const input = (id: string) => container.querySelector<HTMLInputElement>(`#endpoint-${id}`)!
const edit = (next: Parameters<EndpointEditor["edit"]>[0]) => act(() => editor.edit(next))
const commit = async () => {
  let result!: EndpointCommit
  await act(async () => {
    result = editor.commit()
  })
  return result
}
const stored = () => JSON.parse(localStorage.getItem(RECORD) ?? "null")

beforeEach(() => localStorage.clear())
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("the endpoint editor without a wallet", () => {
  it("reads the saved record into the fields", async () => {
    localStorage.setItem(RECORD, JSON.stringify({ node: "https://n.example", nodeApiKey: "k" }))
    await mount()
    expect(input("node").value).toBe("https://n.example")
    expect(input("nodeApiKey").value).toBe("k")
    expect(editor.dirty).toBe(false)
  })

  it("commits a node and its key to the record", async () => {
    await mount()
    edit({ node: " https://n.example ", nodeApiKey: "k-1" })
    expect(editor.dirty).toBe(true)
    expect(editor.valid).toBe(true)
    expect(await commit()).toEqual({ ok: true })
    expect(stored()).toEqual({ node: "https://n.example", nodeApiKey: "k-1" })
    // The fields now hold what was stored.
    expect(input("node").value).toBe("https://n.example")
    expect(editor.dirty).toBe(false)
  })

  it("writes nothing when nothing changed", async () => {
    localStorage.setItem(RECORD, JSON.stringify({ l1Rpc: "https://l1.example" }))
    await mount()
    const write = vi.spyOn(Storage.prototype, "setItem")
    expect(await commit()).toEqual({ ok: true })
    expect(write).not.toHaveBeenCalled()
  })

  it("with nothing changed, still refuses a record another window changed since it was read", async () => {
    await mount()
    localStorage.setItem(RECORD, JSON.stringify({ node: "https://other.example" }))
    expect(await commit()).toMatchObject({ ok: false, reason: "changed" })
    expect(stored()).toEqual({ node: "https://other.example" })
  })

  it("does not refuse its own earlier write as another tab's", async () => {
    await mount()
    edit({ enclave: "https://e.example/" })
    expect(await commit()).toEqual({ ok: true })
    expect(await commit()).toEqual({ ok: true })
    edit({ l1Rpc: "https://l1.example" })
    expect(await commit()).toEqual({ ok: true })
    expect(stored()).toEqual({ enclave: "https://e.example", l1Rpc: "https://l1.example" })
  })

  it("refuses a record another window changed since it was read", async () => {
    await mount()
    edit({ node: "https://n.example" })
    localStorage.setItem(RECORD, JSON.stringify({ l1Rpc: "https://other.example" }))
    expect(await commit()).toEqual({
      ok: false,
      reason: "changed",
      message: "Another tab changed the endpoints. Close this and open it again to edit them.",
    })
    expect(stored()).toEqual({ l1Rpc: "https://other.example" })
  })

  it("reports a write it could not read back, and a fresh editor reads what was stored", async () => {
    await mount()
    edit({ node: "https://n.example" })
    const realGet = Storage.prototype.getItem
    const realSet = Storage.prototype.setItem
    let written = false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k, v) {
      realSet.call(this, k, v)
      written = true
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k) {
      if (written) throw new Error("read failed")
      return realGet.call(this, k)
    })
    const result = await commit()
    expect(result).toMatchObject({ ok: false, reason: "storage" })
    expect(editor.baseline).toEqual({})

    vi.restoreAllMocks()
    await act(async () => root.unmount())
    container.remove()
    await mount()
    expect(input("node").value).toBe("https://n.example")
    edit({ l1Rpc: "https://l1.example" })
    expect(await commit()).toEqual({ ok: true })
  })
})

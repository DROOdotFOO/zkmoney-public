/** The wallet's Endpoints sheet over the real endpoint record in this browser's storage. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startTabBoundOperation } from "../../support/operations"

type Kind = "node" | "l1Rpc" | "enclave"

// The booted config: each endpoint is the default unless the record holds one.
vi.mock("../../../src/config/env", async () => {
  const { readEndpointOverrides } = await import("../../../src/config/endpointOverrides")
  const provenance = (custom?: string) => ({
    source: custom ? "settings" : "default",
    isDefault: !custom,
  })
  return {
    getConfig: () => {
      const stored = readEndpointOverrides()
      return {
        nodeUrl: stored.node ?? "https://node.default.example/rpc",
        l1RpcUrl: stored.l1Rpc ?? "https://rpc.default.example",
        enclaveUrl: stored.enclave ?? "",
        endpoints: {
          node: provenance(stored.node),
          l1Rpc: provenance(stored.l1Rpc),
          enclave: provenance(stored.enclave),
        },
      }
    },
  }
})

const { EndpointsModal } = await import("../../../src/ui/EndpointsModal")

const RECORD = "webwallet.endpoints"
let root: Root
let container: HTMLDivElement
let endOperation: (() => Promise<void>) | undefined
const onClose = vi.fn()
const reload = vi.fn()

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<EndpointsModal onClose={onClose} reload={reload} />))
}

const store = (record: Record<string, string>) =>
  localStorage.setItem(RECORD, JSON.stringify(record))
const stored = () => JSON.parse(localStorage.getItem(RECORD) ?? "null")
const input = (kind: Kind | "nodeApiKey") =>
  container.querySelector<HTMLInputElement>(`#endpoint-${kind}`)!
const field = (kind: Kind | "nodeApiKey") => input(kind).closest(".ww-endpoints__field")!
const fieldError = (kind: Kind | "nodeApiKey") =>
  field(kind).querySelector('[role="alert"]')?.textContent
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const useDefault = (kind: Kind) =>
  [...field(kind).querySelectorAll("button")].find((el) => el.textContent === "Use default")
const saveError = () => container.querySelector('[data-testid="endpoints-save-error"]')?.textContent

function fill(kind: Kind | "nodeApiKey", value: string) {
  const el = input(kind)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const save = () => act(async () => button("Save & reload")!.click())

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  localStorage.clear()
})

afterEach(async () => {
  await act(async () => endOperation?.())
  endOperation = undefined
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("EndpointsModal", () => {
  it("puts the default host in the placeholder while the default is in use", async () => {
    await mount()
    expect(input("node").placeholder).toBe("Default: node.default.example")
    expect(input("l1Rpc").placeholder).toBe("Default: rpc.default.example")
    expect(input("enclave").placeholder).toBe(
      "Leave blank to use the address in zk.money's configuration",
    )
  })

  it("hides a default a custom URL replaced", async () => {
    store({ node: "https://node.example" })
    await mount()
    expect(input("node").value).toBe("https://node.example")
    expect(input("node").placeholder).toBe("Leave blank to use the address built into the app")
  })

  it("saves a node URL, leaves the other fields alone and reloads", async () => {
    await mount()
    expect(button("Save & reload")!.disabled).toBe(true)
    fill("node", "https://node.example")
    await save()
    expect(stored()).toEqual({ node: "https://node.example" })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("refuses a URL with credentials inline and stores nothing", async () => {
    await mount()
    fill("l1Rpc", "https://u:p@node.example")
    expect(fieldError("l1Rpc")).toBe("Enter a full http(s) URL, with no username or password.")
    expect(input("l1Rpc").getAttribute("aria-invalid")).toBe("true")
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(stored()).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it("a refused write stores nothing, says so and keeps the edits", async () => {
    store({ node: "https://old-node.example" })
    await mount()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fill("node", "https://node.example")
    fill("l1Rpc", "https://rpc.example")
    await save()
    expect(saveError()).toBe("Couldn't save: this browser refused the write.")
    expect(reload).not.toHaveBeenCalled()
    expect(stored()).toEqual({ node: "https://old-node.example" })
    expect(input("node").value).toBe("https://node.example")
    expect(button("Save & reload")!.disabled).toBe(false)
    fill("node", "https://node2.example")
    expect(saveError()).toBeUndefined()
  })

  it("an enclave URL with the /rpc path cannot be saved", async () => {
    await mount()
    fill("enclave", "https://enclave.example/rpc")
    expect(fieldError("enclave")).toBe(
      "Enter the enclave's origin only: no query, fragment or /rpc.",
    )
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(stored()).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it("clears an override through Use default on save", async () => {
    store({ node: "https://node.example", enclave: "https://enclave.example" })
    await mount()
    expect(useDefault("l1Rpc")).toBeUndefined()
    await act(async () => useDefault("node")!.click())
    expect(input("node").value).toBe("")
    expect(useDefault("node")).toBeUndefined()
    await save()
    expect(stored()).toEqual({ enclave: "https://enclave.example" })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("while a transaction is being sent, saving is blocked: the reload would lose it", async () => {
    await act(async () => void (endOperation = await startTabBoundOperation()))
    await mount()
    fill("node", "https://node.example")
    expect(container.querySelector('[data-testid="endpoints-busy"]')?.textContent).toBe(
      "A transaction is still being sent, and saving reloads the wallet. Wait for it to finish.",
    )
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(stored()).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  describe("the node API key", () => {
    it("is masked, holds the saved key, and shows nowhere else", async () => {
      store({ node: "https://node.example", nodeApiKey: "secret-key-1" })
      await mount()
      expect(input("nodeApiKey").type).toBe("text")
      expect(input("nodeApiKey").classList).toContain("ww-endpoints__input--secret")
      expect(input("nodeApiKey").getAttribute("autocomplete")).toBe("off")
      expect(input("nodeApiKey").hasAttribute("data-1p-ignore")).toBe(true)
      expect(input("nodeApiKey").getAttribute("data-lpignore")).toBe("true")
      expect(input("nodeApiKey").getAttribute("data-bwignore")).toBe("true")
      expect(input("nodeApiKey").value).toBe("secret-key-1")
      expect(container.textContent).not.toContain("secret-key-1")
    })

    it("a changed key alone is a change worth saving", async () => {
      store({ node: "https://node.example", nodeApiKey: "old" })
      await mount()
      expect(button("Save & reload")!.disabled).toBe(true)
      fill("nodeApiKey", "new")
      await save()
      expect(stored()).toEqual({ node: "https://node.example", nodeApiKey: "new" })
    })

    it.each([
      ["without a node URL", "", "k", "Enter the node URL this key is for."],
      [
        "with a space",
        "https://node.example",
        "a b",
        "Enter the key as issued: no spaces, at most 512 characters.",
      ],
    ])("cannot be saved %s", async (_label, node, key, message) => {
      await mount()
      if (node) fill("node", node)
      fill("nodeApiKey", key)
      expect(fieldError("nodeApiKey")).toBe(message)
      expect(input("nodeApiKey").getAttribute("aria-invalid")).toBe("true")
      expect(button("Save & reload")!.disabled).toBe(true)
      await save()
      expect(stored()).toBeNull()
    })

    it("does not follow the node URL to another node", async () => {
      store({ node: "https://a.example", nodeApiKey: "k-a" })
      await mount()
      const withheld = () => container.querySelector('[data-testid="endpoints-key-withheld"]')
      expect(withheld()).toBeNull()
      fill("node", "https://b.example")
      expect(input("nodeApiKey").value).toBe("")
      expect(withheld()).not.toBeNull()
      await save()
      expect(stored()).toEqual({ node: "https://b.example" })
    })

    it("comes back when the URL returns to its node, and a key typed for a new node is kept", async () => {
      store({ node: "https://a.example", nodeApiKey: "k-a" })
      await mount()
      fill("node", "https://b.example")
      fill("node", "https://a.example")
      expect(input("nodeApiKey").value).toBe("k-a")
      fill("node", "https://b.example")
      fill("nodeApiKey", "k-b")
      await save()
      expect(stored()).toEqual({ node: "https://b.example", nodeApiKey: "k-b" })
    })

    it("Use default on the node clears its key too", async () => {
      store({ node: "https://node.example", nodeApiKey: "k" })
      await mount()
      await act(async () => useDefault("node")!.click())
      expect(input("node").value).toBe("")
      expect(input("nodeApiKey").value).toBe("")
      expect(fieldError("nodeApiKey")).toBeUndefined()
      await save()
      expect(stored()).toBeNull()
    })
  })
})

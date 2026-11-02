import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  contractService: null as unknown,
  node: null as unknown,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: h.contractService }),
}))

const { ContractAddressesModal } = await import("../../../src/ui/ContractAddressesModal")
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")

const addr = (hex: string) => ({ toString: () => hex })
const L2 = {
  oxideToken: `0x${"11".repeat(32)}`,
  claimFpc: `0x${"22".repeat(32)}`,
  sponsorFPC: `0x${"33".repeat(32)}`,
}
const TUPLE = {
  portal: `0x${"aa".repeat(20)}`,
  token: `0x${"bb".repeat(20)}`,
  l2Token: L2.oxideToken,
  registry: `0x${"cc".repeat(20)}`,
  depositSIPAImplementation: `0x${"d1".repeat(20)}`,
  registrationSIPAImplementation: `0x${"d2".repeat(20)}`,
}
const NODE_INFO = {
  protocolContractAddresses: { feeJuice: addr(`0x${"f1".repeat(32)}`) },
  l1ContractAddresses: {
    rollupAddress: addr(`0x${"e1".repeat(20)}`),
    inboxAddress: addr(`0x${"e2".repeat(20)}`),
    outboxAddress: addr(`0x${"e3".repeat(20)}`),
    registryAddress: addr(`0x${"e4".repeat(20)}`),
    feeJuiceAddress: addr(`0x${"e5".repeat(20)}`),
    feeJuicePortalAddress: addr(`0x${"e6".repeat(20)}`),
  },
}

function fakeService(opts: { tuple?: object | null; throwOn?: string } = {}) {
  let initialized = false
  const client = {
    initialize: vi.fn(async () => {
      initialized = true
    }),
    getCurrentTuple: () => (initialized && opts.tuple !== null ? opts.tuple ?? TUPLE : null),
  }
  return {
    client,
    getOxideClient: () => client,
    getContractAddress: vi.fn(async (name: string) => {
      if (name === opts.throwOn) throw new Error("unresolved")
      const hex = L2[name as keyof typeof L2]
      return hex ? addr(hex) : undefined
    }),
  }
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const writeText = vi.fn(async () => {})

async function mount() {
  closeSession()
  openTestSession({ wallet: h.node ? { node: h.node } : undefined })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<ContractAddressesModal onClose={onClose} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const row = (label: string) =>
  [...container.querySelectorAll(".ww-addresses__row")].find(
    (el) => el.querySelector(".ww-addresses__label")?.textContent === label,
  )
const rowValue = (label: string) => row(label)?.querySelector("code")?.textContent
const copyButton = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${label}"]`)

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  h.node = { getNodeInfo: vi.fn(async () => NODE_INFO) }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("ContractAddressesModal", () => {
  it("lists L2, oxide and Aztec protocol addresses", async () => {
    h.contractService = fakeService()
    await mount()
    expect(rowValue("oxideToken")).toBe(L2.oxideToken)
    expect(rowValue("claimFpc")).toBe(L2.claimFpc)
    expect(rowValue("portal")).toBe(TUPLE.portal)
    expect(rowValue("rollup")).toBe(NODE_INFO.l1ContractAddresses.rollupAddress.toString())
    expect(rowValue("inbox")).toBe(NODE_INFO.l1ContractAddresses.inboxAddress.toString())
    expect(rowValue("feeJuice (L2)")).toBe(NODE_INFO.protocolContractAddresses.feeJuice.toString())
  })

  it("shows unresolved rows without breaking the others", async () => {
    h.contractService = fakeService({ throwOn: "oxideToken", tuple: null })
    await mount()
    expect(rowValue("oxideToken")).toBe("not resolved")
    expect(rowValue("claimFpc")).toBe(L2.claimFpc)
    expect(rowValue("portal")).toBe("not resolved")
    expect(copyButton("portal")).toBeNull()
    expect(row("portal")?.tagName).toBe("DIV")
  })

  it("keeps the Aztec rows unresolved when the node call fails", async () => {
    h.contractService = fakeService()
    h.node = { getNodeInfo: vi.fn(async () => Promise.reject(new Error("node down"))) }
    await mount()
    expect(rowValue("rollup")).toBe("not resolved")
    expect(rowValue("feeJuice (L2)")).toBe("not resolved")
    expect(rowValue("portal")).toBe(TUPLE.portal)
  })

  it("omits per-user classes that carry no fleet address", async () => {
    h.contractService = fakeService()
    await mount()
    expect(row("obsidionAccountAlpha")).toBeUndefined()
    expect(row("obsidionAccountAlphaTest")).toBeUndefined()
    expect(row("paylinkEmail")).toBeUndefined()
  })

  it("says so when no contract service exists", async () => {
    h.contractService = null
    h.node = null
    await mount()
    expect(container.textContent).toContain("No contract service in this session")
    expect(container.querySelector(".ww-addresses__row")).toBeNull()
  })

  it("copies an address on tap", async () => {
    h.contractService = fakeService()
    await mount()
    await act(async () => copyButton("portal")!.click())
    expect(writeText).toHaveBeenCalledWith(TUPLE.portal)
    expect(copyButton("portal")!.textContent).toContain("Copied")
    expect(container.querySelectorAll(".ww-addresses__copied")).toHaveLength(1)
  })
})

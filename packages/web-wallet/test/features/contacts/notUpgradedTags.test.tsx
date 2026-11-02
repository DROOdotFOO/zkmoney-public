import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  updateL2Address: vi.fn(async () => {}),
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({ resolveTagViaRegistry: m.resolve }))
vi.mock("@obsidion/front-core", () => ({
  ContactStorage: { get: () => ({ updateL2Address: m.updateL2Address }) },
}))

import { useNotUpgradedTags } from "../../../src/features/contacts/useNotUpgradedTags"

let seen: ReadonlySet<string> = new Set()
function Probe({ tags }: { tags: string[] }) {
  seen = useNotUpgradedTags(tags)
  return null
}

describe("useNotUpgradedTags", () => {
  let root: Root
  beforeEach(() => {
    m.resolve.mockReset()
    m.updateL2Address.mockClear()
    root = createRoot(document.createElement("div"))
  })
  afterEach(() => act(() => root.unmount()))

  it("flags tags still on a retired rollup and points upgraded contacts at their new address", async () => {
    m.resolve.mockImplementation(async (tag: string) => {
      if (tag === "old") return { status: "staleRollup" }
      if (tag === "new") return { status: "resolved", l2Address: "0xnew" }
      throw new Error("rpc down")
    })
    await act(async () => root.render(<Probe tags={["Old", "new", "down"]} />))
    expect([...seen]).toEqual(["old"])
    expect(m.updateL2Address).toHaveBeenCalledWith("new", "0xnew")
    expect(m.updateL2Address).toHaveBeenCalledTimes(1)
  })

  it("reads again on the next visit", async () => {
    m.resolve.mockResolvedValueOnce({ status: "staleRollup" })
    await act(async () => root.render(<Probe tags={["late"]} />))
    expect([...seen]).toEqual(["late"])
    await act(async () => root.unmount())
    root = createRoot(document.createElement("div"))
    m.resolve.mockResolvedValueOnce({ status: "resolved", l2Address: "0xlate" })
    await act(async () => root.render(<Probe tags={["late"]} />))
    expect([...seen]).toEqual([])
  })
})

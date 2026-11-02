import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

import { useBack } from "../../src/ui/hooks"

let container: HTMLDivElement
let root: Root
let back: () => void

function Probe() {
  back = useBack("/contacts")
  return null
}

describe("useBack", () => {
  beforeEach(() => {
    navigate.mockClear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <MemoryRouter>
          <Probe />
        </MemoryRouter>,
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("pops history when there are in-app entries behind (idx > 0)", () => {
    window.history.replaceState({ idx: 2 }, "")
    back()
    expect(navigate).toHaveBeenCalledWith(-1)
  })

  it("replaces the entry with the structural parent on the first in-app entry (idx 0)", () => {
    window.history.replaceState({ idx: 0 }, "")
    back()
    expect(navigate).toHaveBeenCalledWith("/contacts", { replace: true })
  })

  it("replaces the entry when history state is absent (deep link before router stamps idx)", () => {
    window.history.replaceState(null, "")
    back()
    expect(navigate).toHaveBeenCalledWith("/contacts", { replace: true })
  })
})

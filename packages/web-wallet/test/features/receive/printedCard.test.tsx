import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"

const { PrintedCard } = await import("../../../src/features/receive/PrintedCard")

it("prints only the tag's pay link, never an address", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  act(() => root.render(<PrintedCard tag="river" />))
  const payload = host.querySelector("svg")!.getAttribute("data-uri")
  expect(payload).toBe("https://river.zk.money")
  expect(host.textContent).toContain("river.zk.money")
  expect(`${payload} ${host.innerHTML}`).not.toMatch(/0x[0-9a-f]{40}/i)
  act(() => root.unmount())
})

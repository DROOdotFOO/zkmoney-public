/**
 * When the app has drawn its first screen, so a screen standing in for it during the boot can go:
 * in the same commit that replaced the boot splash, never while a hand-off or a redirect shows
 * nothing.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ proverEnabled: false }) }))

import { BootSplash, useFirstScreenShown } from "../../../src/ui/PxeBoot"

let app: HTMLDivElement
let probe: HTMLDivElement
let root: Root
let probeRoot: Root

function Probe() {
  return <span data-shown={String(useFirstScreenShown())} />
}
const shown = () => probe.querySelector("[data-shown]")?.getAttribute("data-shown")

beforeEach(() => {
  app = document.createElement("div")
  app.id = "root"
  probe = document.createElement("div")
  document.body.append(app, probe)
  root = createRoot(app)
  probeRoot = createRoot(probe)
  act(() => probeRoot.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  act(() => probeRoot.unmount())
  app.remove()
  probe.remove()
})

it("holds through hand-offs and a redirect that shows nothing, then takes over in one commit", async () => {
  act(() => root.render(<BootSplash key="config" />))
  act(() => root.render(<BootSplash key="tab" />))
  await act(async () => {})
  expect(shown()).toBe("false")

  act(() => root.render(<span />))
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(shown()).toBe("false")

  act(() => root.render(<BootSplash key="hold" />))
  // The screen that replaces the last splash takes over before anything else runs.
  await act(async () => {
    root.render(<p>Get started</p>)
  })
  expect(shown()).toBe("true")
})

it("ends the boot screen with no fade when a stand-in was covering it", async () => {
  const standIn = document.createElement("div")
  standIn.id = "pre-boot"
  standIn.append(document.createElement("div"))
  document.body.prepend(standIn)
  try {
    act(() => root.render(<BootSplash key="hold" />))
    expect(document.body.dataset.booting).toBe("full")
    await act(async () => {
      root.render(<p>Someone sent you</p>)
    })
    expect(shown()).toBe("true")
    expect(document.body.dataset.booting).toBeUndefined()
    expect(document.body.dataset.bootLeaving).toBeUndefined()
  } finally {
    standIn.remove()
  }
})

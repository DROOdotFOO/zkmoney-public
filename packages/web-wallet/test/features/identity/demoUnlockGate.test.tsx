/**
 * The unlock gate under demo mode. A demo session commits a master key but never builds an account
 * contract (there is no PXE), so `obsidionAccount` stays undefined — without the demo branch the
 * wallet surface would sit on the boot splash forever.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Each test re-imports the front-core graph; the first one pays the cold transform.
vi.setConfig({ testTimeout: 30_000 })

let container: HTMLDivElement
let root: Root

/** Storage whose reads never land. */
const unread = {
  getItem: () => new Promise<string | null>(() => {}),
  setItem: async () => {},
  removeItem: async () => {},
  clear: async () => {},
}

async function render(): Promise<string> {
  const { UnlockGate } = await import("../../../src/features/identity/UnlockGate")
  const { AccountStorage } = await import("@obsidion/front-core")
  const { openTestSession } = await import("../../support/session")
  // A cold session before the storage probe lands: no wallet, no account, no error to retry from.
  AccountStorage.get(unread)
  openTestSession()
  await act(async () => {
    root.render(
      <MemoryRouter>
        <UnlockGate>
          <span>wallet surface</span>
        </UnlockGate>
      </MemoryRouter>,
    )
  })
  return container.textContent ?? ""
}

beforeEach(async () => {
  vi.resetModules()
  sessionStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("UnlockGate", () => {
  it("opens the wallet surface in demo mode", async () => {
    window.history.replaceState({}, "", "/?demo=fresh")
    expect(await render()).toContain("wallet surface")
  })

  it("holds the wallet surface behind the splash otherwise", async () => {
    window.history.replaceState({}, "", "/")
    const text = await render()
    expect(text).not.toContain("wallet surface")
    expect(text).toContain("Loading zk.money")
  })
})

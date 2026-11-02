import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Leftover } from "../../../src/platform/storage/clearSiteData"

const walletBootLoaded = vi.hoisted(() => vi.fn())
// Roots main.tsx creates, so each entry test can unmount its own.
const mainRoots = vi.hoisted(() => ({ tracking: false, roots: [] as { unmount(): void }[] }))

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>()
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const created = actual.createRoot(...args)
      if (mainRoots.tracking) mainRoots.roots.push(created)
      return created
    },
  }
})

vi.mock("../../../src/walletBoot", () => {
  walletBootLoaded()
  throw new Error("wallet chunk failed")
})
// `/reset` must load even when the wallet store's modules cannot.
vi.mock("../../../src/platform/storage/walletStorage", () => {
  throw new Error("wallet store failed to load")
})

const { ResetScreen } = await import("../../../src/ui/ResetScreen")

let root: Root
let container: HTMLDivElement
let replace: ReturnType<typeof vi.fn>
const originalLocation = window.location

beforeEach(() => {
  replace = vi.fn()
  Object.defineProperty(window, "location", {
    value: { pathname: "/reset", replace },
    writable: true,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Object.defineProperty(window, "location", { value: originalLocation, writable: true })
})

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)

function deferred() {
  let resolve!: (left: Leftover[]) => void
  const promise = new Promise<Leftover[]>((r) => (resolve = r))
  return { promise, resolve }
}

async function renderScreen(clear: () => Promise<Leftover[]>, strict = false) {
  const screen = <ResetScreen clear={clear} />
  await act(async () => root.render(strict ? <StrictMode>{screen}</StrictMode> : screen))
}

describe("ResetScreen", () => {
  it("goes home on Cancel without clearing", async () => {
    const clear = vi.fn(async () => [])
    await renderScreen(clear)
    await act(async () => button("Cancel")!.click())
    expect(replace).toHaveBeenCalledWith("/")
    expect(clear).not.toHaveBeenCalled()
  })

  it("shows loading while clearing, then reloads home when everything is cleared", async () => {
    const pending = deferred()
    const clear = vi.fn(() => pending.promise)
    await renderScreen(clear)

    await act(async () => button("Clear data")!.click())
    expect(button("Clear data")!.getAttribute("aria-busy")).toBe("true")
    expect(button("Cancel")).toBeUndefined()
    expect(replace).not.toHaveBeenCalled()

    await act(async () => pending.resolve([]))
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("runs one wipe per press under StrictMode", async () => {
    const pending = deferred()
    const clear = vi.fn(() => pending.promise)
    await renderScreen(clear, true)

    await act(async () => {
      button("Clear data")!.click()
      button("Clear data")!.click()
    })
    await act(async () => pending.resolve([]))

    expect(clear).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it("says to close other tabs when something is busy, and can try again", async () => {
    const retry = deferred()
    const clear = vi
      .fn<() => Promise<Leftover[]>>()
      .mockResolvedValueOnce([{ kind: "files", item: ".aztec-kv-pxe-0xabc", reason: "busy" }])
      .mockReturnValueOnce(retry.promise)
    await renderScreen(clear)

    await act(async () => button("Clear data")!.click())
    expect(container.textContent).toContain("Some data couldn't be cleared")
    expect(container.textContent).toContain("Wallet files: in use by another tab")
    expect(container.textContent).toContain("Close other zk.money tabs and windows")
    expect(container.textContent).not.toContain("blocked by this browser")
    expect(replace).not.toHaveBeenCalled()

    await act(async () => button("Try again")!.click())
    expect(clear).toHaveBeenCalledTimes(2)
    expect(button("Try again")!.getAttribute("aria-busy")).toBe("true")
    expect(button("Continue")).toBeUndefined()

    await act(async () => retry.resolve([]))
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("says a queued database delete lands once other tabs close", async () => {
    const clear = vi.fn(
      async (): Promise<Leftover[]> => [{ kind: "databases", item: "held", reason: "pending" }],
    )
    await renderScreen(clear)

    await act(async () => button("Clear data")!.click())
    expect(container.textContent).toContain(
      "Browser databases: will be removed when other tabs close",
    )
    expect(container.textContent).toContain("Close other zk.money tabs and windows")
  })

  it("names each kind the browser refused, and can continue", async () => {
    const clear = vi.fn(
      async (): Promise<Leftover[]> => [
        { kind: "databases", item: "*", reason: "unavailable" },
        { kind: "localStorage", item: "*", reason: "unavailable" },
      ],
    )
    await renderScreen(clear)

    await act(async () => button("Clear data")!.click())
    expect(container.textContent).toContain("Browser databases: blocked by this browser")
    expect(container.textContent).toContain("Sign-in and settings: blocked by this browser")
    expect(container.textContent).not.toContain("Close other")

    await act(async () => button("Continue")!.click())
    expect(replace).toHaveBeenCalledWith("/")
  })
})

describe("main entry", () => {
  async function bootAt(pathname: string) {
    window.location.pathname = pathname
    const mount = document.createElement("div")
    mount.id = "root"
    document.body.appendChild(mount)
    vi.resetModules()
    mainRoots.tracking = true
    await act(async () => {
      await import("../../../src/main")
    })
    mainRoots.tracking = false
    expect(mainRoots.roots).toHaveLength(1)
    // Lets the lazy wallet import settle.
    await act(async () => {})
    return mount
  }

  afterEach(async () => {
    await act(async () => mainRoots.roots.splice(0).forEach((r) => r.unmount()))
    document.getElementById("root")?.remove()
    vi.restoreAllMocks()
  })

  it("renders the reset page on /reset without loading the wallet", async () => {
    walletBootLoaded.mockClear()
    const mount = await bootAt("/reset")
    expect(mount.textContent).toContain("Clear this browser's wallet data?")
    expect(walletBootLoaded).not.toHaveBeenCalled()
  })

  it("shows the startup error when the wallet chunk fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const mount = await bootAt("/")
    expect(walletBootLoaded).toHaveBeenCalled()
    expect(mount.textContent).toContain("zk.money failed to start")
  })
})

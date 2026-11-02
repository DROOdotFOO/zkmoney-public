import { execFileSync } from "node:child_process"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SIMD_PROBE } from "../../src/browserSupport"

const h = vi.hoisted(() => ({ walletBootLoaded: vi.fn() }))
vi.mock("../../src/walletBoot", () => {
  h.walletBootLoaded()
  return { default: () => <div>Wallet boot</div> }
})

const FEATURES: [string, object, string, string, string][] = [
  ["Promise.withResolvers", Promise, "withResolvers", "/", ""],
  ["Web Locks", navigator, "locks", "/link#secret", "#secret"],
]
const originals = FEATURES.map(([, target, key]) => Object.getOwnPropertyDescriptor(target, key)!)
const remove = (target: object, key: string) =>
  Object.defineProperty(target, key, { configurable: true, value: undefined })

const root = () => document.getElementById("root")!

const start = () =>
  act(async () => {
    await import("../../src/main")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

beforeEach(() => {
  vi.resetModules()
  h.walletBootLoaded.mockClear()
  vi.stubGlobal("fetch", vi.fn())
  document.body.innerHTML = '<div id="root"></div>'
})
afterEach(() => {
  document.body.innerHTML = ""
  history.replaceState(null, "", "/")
  FEATURES.forEach(([, target, key], i) => Object.defineProperty(target, key, originals[i]))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the wallet start", () => {
  it.each(FEATURES)(
    "refuses a browser without %s before the wallet loads",
    async (feature, target, key, url, hash) => {
      remove(target, key)
      history.replaceState(null, "", url)
      await start()
      const alert = root().querySelector('[role="alert"]')
      expect(alert?.textContent).toMatch(
        /Browser not supported.*Update the browser or the operating system/,
      )
      expect(alert?.textContent).toContain(feature)
      expect(root().querySelector("button")).toBeNull()
      expect(h.walletBootLoaded).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(location.hash).toBe(hash)
    },
  )

  it("refuses a device without WebAssembly SIMD before the wallet loads", async () => {
    vi.spyOn(WebAssembly, "validate").mockReturnValue(false)
    await start()
    const alert = root().querySelector('[role="alert"]')
    expect(alert?.textContent).toMatch(/Device not supported.*WebAssembly SIMD/)
    expect(alert?.textContent).not.toContain("too old")
    expect(root().querySelector("button")).toBeNull()
    expect(h.walletBootLoaded).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("refuses a browser without WebAssembly", async () => {
    vi.stubGlobal("WebAssembly", undefined)
    await start()
    expect(root().querySelector('[role="alert"]')?.textContent).toContain("WebAssembly SIMD")
    expect(h.walletBootLoaded).not.toHaveBeenCalled()
  })

  it("tells an old browser without WebAssembly SIMD to update", async () => {
    remove(Promise, "withResolvers")
    vi.spyOn(WebAssembly, "validate").mockReturnValue(false)
    await start()
    expect(root().querySelector('[role="alert"]')?.textContent).toMatch(
      /Browser not supported.*too old.*Missing: Promise\.withResolvers, WebAssembly SIMD/,
    )
  })

  it.runIf(process.arch === "x64")("uses a probe that an engine without SIMD rejects", () => {
    const code = `process.stdout.write(String(WebAssembly.validate(new Uint8Array(${JSON.stringify([
      ...SIMD_PROBE,
    ])}))))`
    const validate = (...flags: string[]) =>
      execFileSync(process.execPath, [...flags, "-e", code]).toString()
    expect([validate(), validate("--no-enable-sse4-1")]).toEqual(["true", "false"])
  })

  it("still opens the reset page in a browser it refuses", async () => {
    remove(Promise, "withResolvers")
    history.replaceState(null, "", "/reset")
    await start()
    expect(root().querySelector('[role="alert"]')).toBeNull()
    expect(h.walletBootLoaded).not.toHaveBeenCalled()
  })

  it("loads the wallet in a browser with every feature", async () => {
    await start()
    expect(root().textContent).toContain("Wallet boot")
  })
})

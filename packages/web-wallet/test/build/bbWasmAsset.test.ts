// @vitest-environment node
/**
 * bb.js loads its threads wasm from the asset the build emits: the same bytes it carries inlined,
 * at the URL its `wasmPath` rule asks for, whether or not the host decodes the gzip.
 */
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BB_THREADS_WASM, bbWasmAsset } from "../../bbWasmAsset"
import { barretenbergWasm } from "../../src/platform/bbWasmPath"

// The package root, from the asset under dest/<build>/barretenberg_wasm/.
const BB_BROWSER = path.join(
  realpathSync(path.resolve(path.dirname(BB_THREADS_WASM), "../../..")),
  "dest/browser/barretenberg_wasm/fetch_code/browser",
)

/** The wasmPath the build bakes and the file it emits. */
function build() {
  const plugin = bbWasmAsset()
  const config = (
    plugin.config as (c: object, e: { command: string }) => { define: Record<string, string> }
  )({}, { command: "build" })
  const emitted: { fileName: string; source: Uint8Array }[] = []
  ;(plugin.generateBundle as (this: unknown) => void).call({
    emitFile: (file: { fileName: string; source: Uint8Array }) => emitted.push(file),
  })
  return { wasmPath: JSON.parse(config.define.__BB_WASM_PATH__) as string, emitted }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("bb.js's threads wasm as an asset", () => {
  it("is the wasm bb.js carries inlined", async () => {
    const inlined = (
      await import(pathToFileURL(path.join(BB_BROWSER, "barretenberg-threads.js")).href)
    ).default as string
    const carried = Buffer.from(inlined.slice(inlined.indexOf(",") + 1), "base64")
    expect(carried.equals(readFileSync(BB_THREADS_WASM))).toBe(true)
  })

  it("is fetched by bb.js from the path the build bakes, decoded by the host or not", async () => {
    const { wasmPath, emitted } = build()
    expect(emitted).toHaveLength(1)
    const gz = readFileSync(BB_THREADS_WASM)
    const wasm = gunzipSync(gz)
    const { fetchCode } = await import(pathToFileURL(path.join(BB_BROWSER, "index.js")).href)
    for (const body of [wasm, gz]) {
      const fetched: string[] = []
      vi.stubGlobal("fetch", async (url: string) => {
        fetched.push(url)
        return new Response(body)
      })
      const code = new Uint8Array(await fetchCode(true, wasmPath))
      expect(fetched).toEqual([`/${emitted[0].fileName}`])
      expect(Buffer.from(code).equals(wasm)).toBe(true)
    }
  })

  it("leaves the dev server on bb.js's own wasm", () => {
    const plugin = bbWasmAsset()
    const config = (
      plugin.config as (c: object, e: { command: string }) => { define: Record<string, string> }
    )({}, { command: "serve" })
    expect(config.define.__BB_WASM_PATH__).toBe("undefined")
  })

  it("is asked for only where bb.js picks its threads build", () => {
    vi.stubGlobal("__BB_WASM_PATH__", "/assets/barretenberg-x.wasm.gz")
    vi.stubGlobal("crossOriginIsolated", true)
    expect(barretenbergWasm()).toEqual({ wasmPath: "/assets/barretenberg-x.wasm.gz" })
    vi.stubGlobal("crossOriginIsolated", false)
    expect(barretenbergWasm()).toEqual({})
  })
})

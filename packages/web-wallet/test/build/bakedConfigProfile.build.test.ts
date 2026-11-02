// @vitest-environment node
/**
 * The plugin through a real, minimal `vite build`: hook order, `VITE_*` from the process env, the
 * virtual module resolved and minified by the bundler, the emitted manifest. Complements the
 * hook-level tests, which cannot see what the bundler does to the generated module.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, type Rollup } from "vite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bakedConfigProfile } from "../../bakedConfigProfile"
import { sandboxProfile, serve } from "../fixtures/sandboxProfile"

const URL = "http://localhost:8083/profiles/sandbox.json"

/** Characters a template literal or a JS string would mangle if the module were not a JSON.parse. */
const AWKWARD = "back`tick ${not.interpolated} line\u2028sep \"quote\" \\slash"

/** Builds a one-module bundle around the plugin; nothing is written, the scratch root is removed. */
async function buildBundle(fetchImpl: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "baked-profile-"))
  try {
    writeFileSync(
      join(root, "entry.js"),
      'import profile from "virtual:baked-config-profile"\nexport default profile\n',
    )
    const result = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [bakedConfigProfile({ fetchImpl })],
      build: {
        write: false,
        lib: { entry: join(root, "entry.js"), formats: ["iife"], name: "baked", fileName: () => "baked.js" },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const output = (Array.isArray(result) ? result[0] : result).output
    const chunk = output.find((o): o is Rollup.OutputChunk => o.type === "chunk")!
    const asset = output.find((o) => o.fileName === "build-target.json") as Rollup.OutputAsset
    return { code: chunk.code, manifest: JSON.parse(String(asset.source)) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Runs the IIFE bundle the way a browser would, returning its default export. */
function evaluate(code: string): unknown {
  return new Function(`${code}; return baked`)()
}

describe("bakedConfigProfile through vite build", () => {
  // Vite reads VITE_* from the process env; pin every key so the shell running the suite cannot
  // change the outcome. An empty URL is "no bake" to the plugin.
  beforeEach(() => {
    vi.stubEnv("VITE_NETWORK", "sandbox")
    vi.stubEnv("VITE_CONFIG_PROFILE_URL", "")
    vi.stubEnv("VITE_CONFIG_EXPECTED_PROFILE_ID", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("bakes the document the process env names and survives minification", async () => {
    vi.stubEnv("VITE_CONFIG_PROFILE_URL", URL)
    vi.stubEnv("VITE_CONFIG_EXPECTED_PROFILE_ID", "sandbox")
    const doc = sandboxProfile()
    doc.versions["0.0.1"].contracts.paylinkDirect.meta = { note: AWKWARD }

    const bundle = await buildBundle(serve(doc))
    const baked = evaluate(bundle.code) as {
      profileId: string
      versions: Record<string, { contracts: { paylinkDirect: { meta: { note: string } } } }>
    }

    expect(baked.profileId).toBe("sandbox")
    expect(baked.versions["0.0.1"].contracts.paylinkDirect.meta.note).toBe(AWKWARD)
    expect(bundle.manifest.VITE_CONFIG_EXPECTED_PROFILE_ID).toBe("sandbox")
    expect(bundle.manifest.bakedProfile).toMatchObject({ profileId: "sandbox", current: "0.0.1" })
  })

  it("exports undefined and a null stamp when the build sets no URL", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const bundle = await buildBundle(fetchImpl)

    expect(evaluate(bundle.code)).toBeUndefined()
    expect(bundle.manifest.bakedProfile).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("fails the build when the document cannot be baked", async () => {
    vi.stubEnv("VITE_CONFIG_PROFILE_URL", URL)
    vi.stubEnv("VITE_CONFIG_EXPECTED_PROFILE_ID", "sandbox")
    await expect(buildBundle(serve({}, 503))).rejects.toThrow(/cannot bake the config profile/)
  })
})

// @vitest-environment node
/**
 * The build-time bake: what `vite build` fetches, checks and writes into the bundle, and what it
 * refuses. Every scenario runs the plugin's own functions against a fetch double — no build.
 */
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  BAKED_PROFILE_MODULE_ID,
  bakeConfigProfile,
  bakedConfigProfile,
  renderBakedProfileModule,
} from "../../bakedConfigProfile"
import { sandboxProfile, serve, testnetProfile } from "../fixtures/sandboxProfile"

const URL = "http://localhost:8083/profiles/sandbox.json"
const ENV = { VITE_CONFIG_PROFILE_URL: URL, VITE_CONFIG_EXPECTED_PROFILE_ID: "sandbox" }

/** Evaluates the rendered module the way the bundle would, returning its default export. */
function evaluateModule(source: string): unknown {
  return new Function(source.replace(/^export default /, "return "))()
}

describe("bakeConfigProfile", () => {
  it("bakes the served document and stamps what it baked", async () => {
    const baked = await bakeConfigProfile(ENV, serve(sandboxProfile()))

    expect(baked).toBeDefined()
    expect(JSON.parse(baked!.payload).profileId).toBe("sandbox")
    expect(baked!.stamp).toEqual({
      profileId: "sandbox",
      network: "sandbox",
      current: "0.0.1",
      publishedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      currentVersionGitSha: "c".repeat(40),
      sha256: createHash("sha256").update(baked!.payload).digest("hex"),
    })
  })

  it("records a null version sha when the current version carries none", async () => {
    const doc = sandboxProfile()
    delete doc.versions["0.0.1"].gitSha
    const baked = await bakeConfigProfile(ENV, serve(doc))
    expect(baked!.stamp.currentVersionGitSha).toBeNull()
  })

  it("bakes nothing when no profile URL is set, and never fetches", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await bakeConfigProfile({}, fetchImpl)).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("fetches the document once", async () => {
    const fetchImpl = vi.fn(serve(sandboxProfile()))
    await bakeConfigProfile(ENV, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("refuses a URL with no expected id", async () => {
    await expect(
      bakeConfigProfile({ VITE_CONFIG_PROFILE_URL: URL }, serve(sandboxProfile())),
    ).rejects.toThrow(/VITE_CONFIG_EXPECTED_PROFILE_ID/)
  })

  it("refuses an unknown VITE_NETWORK before fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(bakeConfigProfile({ ...ENV, VITE_NETWORK: "devnet" }, fetchImpl)).rejects.toThrow(
      /Unknown VITE_NETWORK "devnet"/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("bakes nothing on a 404 — the profile id does not exist yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await bakeConfigProfile(ENV, serve({}, 404))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(URL))
    warn.mockRestore()
  })

  it.each([
    [
      "a fetch that throws",
      async () => Promise.reject(new TypeError("fetch failed")),
      /fetch failed/,
    ],
    ["a 5xx", serve({}, 503), /503/],
    ["a 403", serve({}, 403), /403/],
  ])("fails the build on %s, naming the URL", async (_name, fetchImpl, pattern) => {
    const failure = bakeConfigProfile(ENV, fetchImpl as unknown as typeof fetch)
    await expect(failure).rejects.toThrow(pattern)
    await expect(failure).rejects.toThrow(URL)
  })

  it("refuses a document for another profile, naming both ids", async () => {
    const failure = bakeConfigProfile(
      { ...ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5" },
      serve(sandboxProfile()),
    )
    await expect(failure).rejects.toThrow(/identifies as "sandbox"/)
    await expect(failure).rejects.toThrow(/"staging-v5"/)
  })

  it("refuses a document for another network — the sandbox default included", async () => {
    await expect(
      bakeConfigProfile(
        { ...ENV, VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5" },
        serve(testnetProfile()),
      ),
    ).rejects.toThrow(/is for network "testnet"/)
  })

  it("refuses a document whose current version this build cannot read", async () => {
    const doc = sandboxProfile()
    doc.versions["0.0.2"] = { schemaVersion: "2" }
    doc.current = "0.0.2"
    await expect(bakeConfigProfile(ENV, serve(doc))).rejects.toThrow(/app update/)
  })

  it("refuses an invalid or expired document", async () => {
    await expect(bakeConfigProfile(ENV, serve({ profileId: "sandbox" }))).rejects.toThrow(
      /schema violations/,
    )
    const expired = sandboxProfile()
    expired.expiresAt = "2026-08-13T00:00:00.000Z"
    await expect(bakeConfigProfile(ENV, serve(expired))).rejects.toThrow(/expired/)
  })

  // The schema already demands a pointer on every version, so that branch is unreachable here.
  describe("applies the wallet's profile policy", () => {
    it("a dev manifest on a durable network", async () => {
      const doc = testnetProfile()
      doc.versions["0.0.1"].oxide.manifestUrl = "https://manifest.example/dev.v4.json"
      await expect(
        bakeConfigProfile(
          { ...ENV, VITE_NETWORK: "testnet", VITE_CONFIG_EXPECTED_PROFILE_ID: "staging-v5" },
          serve(doc),
        ),
      ).rejects.toThrow(/dev or local manifest/)
    })

    it("a mainnet pointer with no expectedGitSha", async () => {
      const doc = testnetProfile()
      doc.profileId = "mainnet"
      doc.network = "mainnet"
      doc.shared.l1ChainId = 1
      delete doc.expiresAt
      await expect(
        bakeConfigProfile(
          { ...ENV, VITE_NETWORK: "mainnet", VITE_CONFIG_EXPECTED_PROFILE_ID: "mainnet" },
          serve(doc),
        ),
      ).rejects.toThrow(/expectedGitSha/)
    })
  })
})

describe("renderBakedProfileModule", () => {
  it("exports undefined when nothing was baked", () => {
    expect(evaluateModule(renderBakedProfileModule(undefined))).toBeUndefined()
  })

  it("round-trips the payload, an own __proto__ key included", () => {
    const payload = JSON.stringify({ meta: JSON.parse('{"__proto__": {"x": 1}, "y": 2}') })
    const value = evaluateModule(renderBakedProfileModule(payload)) as { meta: object }
    expect(value).toEqual(JSON.parse(payload))
    expect(Object.hasOwn(value.meta, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(value.meta)).toBe(Object.prototype)
  })
})

describe("the vite plugin", () => {
  type Hook = (...args: never[]) => unknown
  function drive(
    env: Record<string, string>,
    command: "build" | "serve",
    fetchImpl?: typeof fetch,
  ) {
    const plugin = bakedConfigProfile({ fetchImpl })
    ;(plugin.configResolved as Hook)({ env, command } as never)
    return plugin
  }

  it("serves the baked document as the virtual module and stamps the manifest", async () => {
    const plugin = drive(ENV, "build", serve(sandboxProfile()))
    await (plugin.buildStart as Hook)()

    expect((plugin.resolveId as Hook)(BAKED_PROFILE_MODULE_ID as never)).toBe(
      "\0" + BAKED_PROFILE_MODULE_ID,
    )
    const source = (plugin.load as Hook)(("\0" + BAKED_PROFILE_MODULE_ID) as never) as string
    expect((evaluateModule(source) as { profileId: string }).profileId).toBe("sandbox")

    const emitFile = vi.fn()
    ;(plugin.generateBundle as Hook).call({ emitFile } as never)
    const manifest = JSON.parse(emitFile.mock.calls[0][0].source)
    expect(emitFile.mock.calls[0][0].fileName).toBe("build-target.json")
    expect(manifest.VITE_CONFIG_EXPECTED_PROFILE_ID).toBe("sandbox")
    expect(manifest.bakedProfile.profileId).toBe("sandbox")
    expect(manifest.bakedProfile.current).toBe("0.0.1")
  })

  it("fails the build when the bake fails", async () => {
    const plugin = drive(ENV, "build", serve({}, 503))
    await expect((plugin.buildStart as Hook)() as Promise<void>).rejects.toThrow(
      /cannot bake the config profile: .*503/,
    )
  })

  it("bakes nothing under vite dev — the module still resolves", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const plugin = drive(ENV, "serve", fetchImpl)
    await (plugin.buildStart as Hook)()

    expect(fetchImpl).not.toHaveBeenCalled()
    const source = (plugin.load as Hook)(("\0" + BAKED_PROFILE_MODULE_ID) as never) as string
    expect(evaluateModule(source)).toBeUndefined()
  })

  it("bakes nothing when the build sets no URL, and says so in the manifest", async () => {
    const plugin = drive({}, "build", vi.fn() as unknown as typeof fetch)
    await (plugin.buildStart as Hook)()

    const emitFile = vi.fn()
    ;(plugin.generateBundle as Hook).call({ emitFile } as never)
    expect(JSON.parse(emitFile.mock.calls[0][0].source).bakedProfile).toBeNull()
  })

  it.each([
    [{ VITE_DESKTOP_BUILD: "true" }, "true"],
    [{}, ""],
  ])("records the desktop flag %j in the manifest as %j", async (flag, recorded) => {
    const plugin = drive({ ...ENV, ...flag }, "build", serve(sandboxProfile()))
    await (plugin.buildStart as Hook)()

    const emitFile = vi.fn()
    ;(plugin.generateBundle as Hook).call({ emitFile } as never)
    expect(JSON.parse(emitFile.mock.calls[0][0].source).VITE_DESKTOP_BUILD).toBe(recorded)
  })
})

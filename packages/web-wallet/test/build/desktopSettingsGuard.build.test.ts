// @vitest-environment node
/**
 * The guard through a real, minimal `vite build` of the route's shape: what the bundler drops is
 * what the guard sees, so a hook-level test with made-up module lists could not show it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, type Rollup } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { desktopSettingsGuard } from "../../desktopSettingsGuard"

const SCREEN = "SETTINGS_SCREEN_MARKER"

/** The route as main.tsx writes it: the path constant outside the page's folder, the import inline. */
const ROUTED = `
import { PATH } from "./bridge.js"
const Settings =
  import.meta.env.VITE_DESKTOP_BUILD === "true" ? () => import("./src/desktopSettings/index.js") : null
export default (path) => (Settings && path === PATH ? Settings() : "wallet")
`
const EAGER = `
import screen from "./src/desktopSettings/index.js"
export default () => screen()
`

async function buildEntry(entry: string) {
  const root = mkdtempSync(join(tmpdir(), "desktop-settings-guard-"))
  try {
    mkdirSync(join(root, "src/desktopSettings"), { recursive: true })
    writeFileSync(join(root, "bridge.js"), 'export const PATH = "/desktop-settings"\n')
    writeFileSync(join(root, "src/desktopSettings/index.js"), `export default () => "${SCREEN}"\n`)
    writeFileSync(join(root, "entry.js"), entry)
    const result = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [desktopSettingsGuard()],
      build: {
        write: false,
        lib: { entry: join(root, "entry.js"), formats: ["es"], fileName: () => "entry.js" },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const output = (Array.isArray(result) ? result[0] : result).output
    return output
      .filter((o): o is Rollup.OutputChunk => o.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("desktopSettingsGuard through vite build", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("passes a build without the flag, whose output drops the page", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD", "")
    const code = await buildEntry(ROUTED)
    expect(code).not.toContain(SCREEN)
    expect(code).toContain("/desktop-settings")
  })

  it("fails a build without the flag that still carries the page", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD", "")
    await expect(buildEntry(EAGER)).rejects.toThrow(/desktop settings page outside a desktop build/)
  })

  it("passes a desktop build, which carries the page", async () => {
    vi.stubEnv("VITE_DESKTOP_BUILD", "true")
    expect(await buildEntry(ROUTED)).toContain(SCREEN)
    expect(await buildEntry(EAGER)).toContain(SCREEN)
  })
})

// @vitest-environment node
/**
 * Every contract artifact the build ships slim keeps what the chain and the prover read: each
 * function's bytecode and verification key byte for byte, and the contract class id. Only the
 * debug-only fields may differ. Only a build run with STRIP_CONTRACT_DEBUG=true slims them.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { BarretenbergSync } from "@aztec-foundation/bb.js"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { beforeAll, describe, expect, it } from "vitest"
import type { Plugin, UserConfig } from "vite"
import {
  isCompiledContract,
  isSlimSource,
  slimArtifacts,
  slimArtifactsIfAsked,
  slimContractArtifact,
} from "../../slimArtifacts"

const REPO = resolve(__dirname, "../../../..")
const AZTEC_PACKAGES = ["protocol-contracts", "standard-contracts", "accounts"]

const dirs = (dir: string) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []
const jsonIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(dir, f))
    : []

/** Every file the plugin would slim, from every copy of those packages the bundler could import. */
function slimmedFiles(): { aztec: string[]; ours: string[] } {
  const store = join(REPO, "node_modules/.pnpm")
  const aztec = dirs(store).flatMap((entry) =>
    AZTEC_PACKAGES.flatMap((name) => {
      const root = join(store, entry.name, "node_modules/@aztec-labs", name)
      return dirs(root)
        .filter((d) => d.name.startsWith("artifacts"))
        .flatMap((d) => jsonIn(join(root, d.name)))
    }),
  )
  const ours = ["src", "dist"].flatMap((build) => {
    const target = join(REPO, "packages/contracts", build, "artifacts/target")
    return dirs(target).flatMap((d) => jsonIn(join(target, d.name)))
  })
  const seen = new Set<string>()
  const slimmed = (files: string[]) =>
    files
      .map((file) => realpathSync(file))
      .filter((file) => {
        if (!isSlimSource(file)) return false
        const body = readFileSync(file)
        const digest = createHash("sha256").update(body).digest("hex")
        if (seen.has(digest) || !isCompiledContract(JSON.parse(body.toString("utf8")))) return false
        seen.add(digest)
        return true
      })
  return { aztec: slimmed(aztec), ours: slimmed(ours) }
}

const files = slimmedFiles()
const name = (file: string) => file.slice(file.lastIndexOf("/node_modules/") + 1 || REPO.length + 1)

const classId = async (json: unknown) =>
  (await getContractClassFromArtifact(loadContractArtifact(json as never))).id.toString()

/** The artifact with its debug-only fields dropped, for comparing everything else. */
function withoutDebug(json: Record<string, unknown>) {
  const { file_map: _a, fileMap: _b, ...rest } = json
  return {
    ...rest,
    functions: (json.functions as Record<string, unknown>[]).map(
      ({ debug_symbols: _c, debugSymbols: _d, ...fn }) => fn,
    ),
  }
}

beforeAll(() => BarretenbergSync.initSingleton(), 120_000)

describe("slim contract artifacts", () => {
  it("finds the wallet's contracts and aztec's among what the build slims", () => {
    expect(files.ours.length).toBeGreaterThan(5)
    expect(files.aztec.map(name).join("\n")).toMatch(
      /protocol-contracts\/artifacts\/FeeJuice\.json/,
    )
    expect(files.aztec.map(name).join("\n")).toMatch(/standard-contracts\/artifacts\//)
  })

  it.each([...files.ours, ...files.aztec].map((file) => [name(file), file]))(
    "%s keeps every bytecode, verification key and its class id",
    async (_name, file) => {
      const original = JSON.parse(readFileSync(file, "utf8"))
      const slim = slimContractArtifact(original)
      expect(withoutDebug(slim)).toEqual(withoutDebug(original))
      expect(slim.functions).toHaveLength(original.functions.length)
      original.functions.forEach((fn: Record<string, unknown>, i: number) => {
        const out = slim.functions[i]
        expect(out.bytecode).toBe(fn.bytecode)
        expect(out.verification_key ?? out.verificationKey).toBe(
          fn.verification_key ?? fn.verificationKey,
        )
      })
      // The debug data is what goes, and it is most of the file.
      expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(original).length)
      expect(await classId(slim)).toBe(await classId(original))
    },
    120_000,
  )

  it("slims those files in a build and leaves every other JSON alone", () => {
    const load = slimArtifacts().load as (id: string) => string | null
    const [ours] = files.ours
    const slim = JSON.parse(load(ours)!)
    expect(slim.file_map ?? slim.fileMap).toEqual({})
    expect(load(join(REPO, "packages/web-wallet/package.json"))).toBeNull()
  })
})

describe("the STRIP_CONTRACT_DEBUG switch", () => {
  /** The plugins `vite build` runs under this environment. */
  async function buildPlugins(flag: string | undefined): Promise<Plugin[]> {
    const saved = process.env.STRIP_CONTRACT_DEBUG
    if (flag === undefined) delete process.env.STRIP_CONTRACT_DEBUG
    else process.env.STRIP_CONTRACT_DEBUG = flag
    try {
      const { default: viteConfig } = await import("../../vite.config")
      const config = (viteConfig as (env: object) => UserConfig)({
        mode: "production",
        command: "build",
        isSsrBuild: false,
        isPreview: false,
      })
      return (config.plugins ?? []).flat(Infinity as 1) as Plugin[]
    } finally {
      if (saved === undefined) delete process.env.STRIP_CONTRACT_DEBUG
      else process.env.STRIP_CONTRACT_DEBUG = saved
    }
  }

  /** What the build loads for an artifact: the first plugin `load` that answers, else the file. */
  async function builtArtifact(plugins: Plugin[], file: string): Promise<string> {
    for (const plugin of plugins) {
      const load = typeof plugin?.load === "function" ? plugin.load : plugin?.load?.handler
      const out = await load?.call({} as never, file)
      if (out != null) return typeof out === "string" ? out : out.code
    }
    return readFileSync(file, "utf8")
  }

  it.each([undefined, "", "false", "1"])(
    "leaves every artifact as compiled when it is %j",
    async (flag) => {
      expect(
        slimArtifactsIfAsked(flag === undefined ? {} : { STRIP_CONTRACT_DEBUG: flag }),
      ).toEqual([])
      const plugins = await buildPlugins(flag)
      expect(plugins.map((p) => p?.name)).not.toContain("slim-artifacts")
      for (const file of [...files.ours, ...files.aztec]) {
        expect(await builtArtifact(plugins, file)).toBe(readFileSync(file, "utf8"))
      }
    },
    120_000,
  )

  it("slims them in a build run with it set to true", async () => {
    const plugins = await buildPlugins("true")
    expect(plugins.map((p) => p?.name)).toContain("slim-artifacts")
    const built = JSON.parse(await builtArtifact(plugins, files.ours[0]))
    expect(built.file_map ?? built.fileMap).toEqual({})
  }, 120_000)
})

/**
 * The built output reaches only its own files, `@obsidion/core` and `@noble/curves`, and never
 * the node `Buffer`. Reads `dist/`, so `pnpm build` comes first.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { checkIsolation, moduleReferences } from "../support/isolation.js"

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist")

describe("the built package", () => {
  it("exists (run pnpm build first) and is isolated", () => {
    expect(existsSync(join(DIST, "index.js")), `${DIST} is missing; build first`).toBe(true)
    expect(checkIsolation(DIST)).toEqual([])
  })
})

describe("the checker", () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function emitted(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "passkey-web-isolation-"))
    scratch.push(dir)
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), source)
    }
    return dir
  }

  it("passes a build that stays inside the allowlist", () => {
    const dir = emitted({
      "index.js": 'export * from "./policy/a.js"\nexport { p256 } from "@noble/curves/p256"\n',
      "index.d.ts":
        'import type { PrfSlot } from "@obsidion/core/types"\nexport declare const s: PrfSlot\nexport declare const t: import("@obsidion/core/types").PrfSlot\n',
      "policy/a.js":
        'import { MSK_PRF_SALT } from "@obsidion/core/constants"\nimport { b } from "../ceremony/b.js"\n// Buffer is only mentioned here, and import(x) too\nexport const a = "Buffer" + `${b}`\nexport const load = () => import("./c.js")\n',
      "ceremony/b.js": "export const b = /Buffer[\"']/.test('x')\n",
    })
    expect(checkIsolation(dir)).toEqual([])
  })

  it("reads type-only imports from the declarations", () => {
    const findings = checkIsolation(
      emitted({
        "index.js": "export {}\n",
        "index.d.ts":
          'import type { Fr } from "@aztec-labs/aztec.js/fields"\nexport declare const k: Fr\n',
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.problem).toMatch(/@aztec-labs\/aztec\.js\/fields$/)
  })

  it("reads triple-slash type references from the declarations", () => {
    const findings = checkIsolation(
      emitted({
        "index.js": "export {}\n",
        "index.d.ts":
          '/// <reference types="node" preserve="true" />\nexport type T = NodeJS.Timeout\n',
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.problem).toMatch(/\bnode$/)
  })

  it.each([
    [
      "a contracts import",
      'import { x } from "@obsidion/contracts"\n',
      /allowlist: @obsidion\/contracts/,
    ],
    [
      "an @oxide import",
      'import "@oxide/oxide-lib/codec"\n',
      /allowlist: @oxide\/oxide-lib\/codec/,
    ],
    ["a node builtin", 'import { createHash } from "node:crypto"\n', /allowlist: node:crypto/],
    [
      "a relative import that escapes the package",
      'export * from "../../web-wallet/src/x.js"\n',
      /escapes dist/,
    ],
    [
      "a dynamic import that is never awaited",
      'const load = () => import("@aztec-labs/foundation/fields")\nexport { load }\n',
      /allowlist: @aztec-labs\/foundation\/fields/,
    ],
    [
      "a dynamic import with a comment before the specifier",
      'export const load = () => import(/* chunk */ "@aztec-labs/foundation/fields")\n',
      /allowlist: @aztec-labs\/foundation\/fields/,
    ],
    [
      "a dynamic import with options",
      'export const load = () => import("@aztec-labs/foundation/fields", { with: {} })\n',
      /allowlist: @aztec-labs\/foundation\/fields/,
    ],
    [
      "a require",
      'const { Fr } = require("@aztec-labs/aztec.js/fields")\nexport { Fr }\n',
      /allowlist: @aztec-labs\/aztec\.js\/fields/,
    ],
    [
      "a dynamic import with a computed specifier",
      "export const load = (name) => import(name)\n",
      /computed specifier/,
    ],
    [
      "a dynamic import with a template specifier",
      "export const load = (x) => import(`@aztec/${x}`)\n",
      /computed specifier/,
    ],
    [
      "a Buffer alias",
      'const B = Buffer\nexport const hex = (x) => B.from(x).toString("hex")\n',
      /Buffer/,
    ],
    ["Buffer looked up by name", 'const B = globalThis["Buffer"]\nexport { B }\n', /Buffer/],
    ["Buffer read off globalThis", "export const B = globalThis.Buffer\n", /Buffer/],
    [
      "Buffer inside adjacent template expressions",
      "export const s = (name) => `${name}${Buffer.from([])}`\n",
      /Buffer/,
    ],
    [
      "Buffer after a regex that follows return",
      "export function f() {\n  return /[\"']/.test(Buffer.from([34]).toString())\n}\n",
      /Buffer/,
    ],
  ])("fails on %s", (_name, source, problem) => {
    const findings = checkIsolation(emitted({ "index.js": source }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.problem).toMatch(problem)
  })

  it("reads every import form", () => {
    const refs = moduleReferences(
      'import a from "a"\nimport { b } from \'b\'\nimport "c"\nexport * from "d"\nexport { e } from "e"\nimport("f")\nawait import("g")\nrequire("h")\nimport {\n  i,\n} from "i"\nimport j = require("j")\n',
      "x.ts",
    )
    expect(refs.specifiers.sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])
    expect(refs.computed).toBe(0)
    expect(refs.bufferReferences).toBe(0)
  })
})

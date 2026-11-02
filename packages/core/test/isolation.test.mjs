import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire, isBuiltin } from "node:module"
import { dirname, relative, resolve, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))

const specifierPatterns = [
  /\bimport\s+[^"';]*\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bexport\s+[^"';]*\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

function extractSpecifiers(source) {
  const specifiers = new Set()
  for (const pattern of specifierPatterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return specifiers
}

test("public entry points have no external runtime dependencies", () => {
  const pending = Object.values(manifest.exports).map((entry) => resolve(packageRoot, entry.import))
  const visited = new Set()

  while (pending.length > 0) {
    const entry = pending.pop()
    if (visited.has(entry)) continue
    visited.add(entry)

    const source = readFileSync(entry, "utf8")
    const requireFromEntry = createRequire(entry)
    for (const specifier of extractSpecifiers(source)) {
      if (isBuiltin(specifier)) continue
      const target = requireFromEntry.resolve(specifier)
      const path = relative(packageRoot, target)
      assert.ok(
        path !== ".." && !path.startsWith(`..${sep}`),
        `${relative(
          packageRoot,
          entry,
        )} imports runtime code outside core: ${specifier} (${target})`,
      )
      pending.push(target)
    }
  }
})

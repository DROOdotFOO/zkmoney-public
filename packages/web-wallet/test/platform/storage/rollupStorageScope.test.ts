// @vitest-environment node
/**
 * Every `localStorage` access in `src/` goes through the storage module, wallet state goes through
 * the wallet database rather than the `localStorage` partition layer, and every full-page exit waits
 * for queued writes. Parsed, not grepped: comments, ordinary strings, types and member names never
 * count.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url))

const ALLOWED = new Set([
  "platform/storage/rollupStorage.ts",
  // Full-site reset clears every partition, and `/reset` boots without a profile.
  "platform/storage/clearSiteData.ts",
])

/** The `localStorage` partition layer: only the Google relay uses it. */
const PARTITION_LAYER_ALLOWED = new Set([
  "platform/storage/rollupStorage.ts",
  // Email-locked paylinks are hidden in the UI; see `config/features.ts` before surfacing them.
  "features/paylink/googleAuth.tsx",
])

/** Navigates only after the wallet database has every queued write. */
const NAVIGATION_ALLOWED = new Set([
  "platform/storage/walletStorage.ts",
  // Runs before boot with no wallet store, and must load even when the store's modules cannot.
  "ui/ResetScreen.tsx",
])

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.tsx?$/.test(entry)) yield path
  }
}

/** 1-based lines where executable code reaches `localStorage`. */
function localStorageAccesses(source: string, fileName = "sample.ts"): number[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const lines: number[] = []
  const record = (node: ts.Node) =>
    lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
  const isComputedName = (node: ts.StringLiteral) =>
    (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) ||
    ts.isComputedPropertyName(node.parent)
  // A shorthand `{ localStorage }` reads the global, so it is not a member name.
  const isMemberName = (node: ts.Identifier) =>
    (ts.isClassElement(node.parent) || ts.isObjectLiteralElementLike(node.parent)) &&
    !ts.isShorthandPropertyAssignment(node.parent) &&
    node.parent.name === node
  const isTypeOnly = (node: ts.Node) =>
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node))
  const visit = (node: ts.Node) => {
    if (isTypeOnly(node)) return
    if (ts.isIdentifier(node) && node.text === "localStorage" && !isMemberName(node)) record(node)
    else if (ts.isStringLiteral(node) && node.text === "localStorage" && isComputedName(node)) {
      record(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

function parse(source: string, fileName: string) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** 1-based lines that reach the `localStorage` partition accessors. */
function partitionLayerUses(source: string, fileName = "sample.ts"): number[] {
  const file = parse(source, fileName)
  const lines: number[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "rollupStorage") {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

const endsWithLocation = (node: ts.Expression) =>
  (ts.isIdentifier(node) && node.text === "location") ||
  (ts.isPropertyAccessExpression(node) && node.name.text === "location")

/** 1-based lines that navigate or reload the page directly. */
function rawNavigations(source: string, fileName = "sample.ts"): number[] {
  const file = parse(source, fileName)
  const lines: number[] = []
  const record = (node: ts.Node) =>
    lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ["assign", "replace", "reload"].includes(node.name.text) &&
      endsWithLocation(node.expression)
    ) {
      record(node)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "href" &&
      endsWithLocation(node.left.expression)
    ) {
      record(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

function offendersOf(scan: (source: string, fileName: string) => number[], allowed: Set<string>) {
  const offenders: string[] = []
  for (const path of sourceFiles(SRC)) {
    const name = relative(SRC, path)
    if (allowed.has(name)) continue
    for (const line of scan(readFileSync(path, "utf8"), path)) offenders.push(`${name}:${line}`)
  }
  return offenders
}

describe("wallet state stays in the wallet database", () => {
  it("reaches the localStorage partition layer only from its allowlist", () => {
    expect(offendersOf(partitionLayerUses, PARTITION_LAYER_ALLOWED)).toEqual([])
  })
})

describe("page exits wait for queued writes", () => {
  it("finds no direct navigation outside the exit helpers", () => {
    expect(offendersOf(rawNavigations, NAVIGATION_ALLOWED)).toEqual([])
  })

  it("reports every way of leaving the page", () => {
    expect(rawNavigations(`location.assign("/x")`)).toEqual([1])
    expect(rawNavigations(`window.location.replace("/x")`)).toEqual([1])
    expect(rawNavigations(`location.reload()`)).toEqual([1])
    expect(rawNavigations(`window.location.href = "/x"`)).toEqual([1])
    expect(rawNavigations(`const url = location.href`)).toEqual([])
    expect(rawNavigations(`history.replace("/x")`)).toEqual([])
  })
})

describe("localStorage stays inside the storage module", () => {
  it("finds no direct access outside the allowlist", () => {
    const offenders: string[] = []
    for (const path of sourceFiles(SRC)) {
      const name = relative(SRC, path)
      if (ALLOWED.has(name)) continue
      for (const line of localStorageAccesses(readFileSync(path, "utf8"), path)) {
        offenders.push(`${name}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("reports code that reaches localStorage, however it is spelled", () => {
    expect(localStorageAccesses(`window.localStorage.getItem("k")`)).toEqual([1])
    expect(localStorageAccesses(`localStorage.setItem("k", "v")`)).toEqual([1])
    expect(localStorageAccesses(`globalThis["localStorage"]`)).toEqual([1])
    expect(localStorageAccesses(`const { ["localStorage"]: s } = globalThis`)).toEqual([1])
    expect(localStorageAccesses(`const { localStorage } = window`)).toEqual([1])
    expect(localStorageAccesses(`const { localStorage: s } = self`)).toEqual([1])
    expect(localStorageAccesses(`use({ localStorage })`)).toEqual([1])
    expect(localStorageAccesses(`const deps = { localStorage: () => localStorage }`)).toEqual([1])
    expect(localStorageAccesses(`typeof localStorage === "undefined"`)).toEqual([1])
    expect(localStorageAccesses(`class A extends (localStorage as never) {}`)).toEqual([1])
    // Any receiver counts: a static scan can't tell `deps` from `window`.
    expect(localStorageAccesses(`deps.localStorage().clear()`)).toEqual([1])
  })
})

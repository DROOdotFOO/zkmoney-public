// @vitest-environment node
/**
 * The lock script's place in the served HTML, through the plugin's hook, a real minimal
 * `vite build` of the wallet's own index.html, and the dev server. The built page's inline text is
 * run in a bare realm: an inline parse error never fails a page load, so this is where the shipped
 * text proves it runs.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext, runInContext } from "node:vm"
import { KEPT_PASSKEY_API_KEY, NATIVE_LOCK_KEY, nativeLockScript } from "@obsidion/passkey-web"
import { build, createServer, type Rollup } from "vite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { nativePasskeyLock } from "../../nativePasskeyLock"
import { socialPreview } from "../../socialPreview"

const INDEX_HTML = readFileSync(join(__dirname, "../../index.html"), "utf8")
const ENV = { VITE_SITE_ORIGIN: "https://wallet.example/" }
const NAMES = [
  "create",
  "get",
  "isUserVerifyingPlatformAuthenticatorAvailable",
  "isConditionalMediationAvailable",
  "getClientCapabilities",
]

let root: string

beforeEach(() => {
  // Under the realpath: vite resolves the page's id to /private/var/… on macOS, and a root under
  // /var/… would make vite:build-html emit the page at a relative path it then refuses.
  root = mkdtempSync(join(realpathSync(tmpdir()), "native-lock-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/boot.tsx"), 'document.body.dataset.booted = "yes"\n')
  writeFileSync(join(root, "index.html"), INDEX_HTML)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const plugins = () => [socialPreview(ENV), nativePasskeyLock()]

async function buildPages(): Promise<Map<string, string>> {
  const result = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: plugins(),
    build: { write: false },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  const output = (Array.isArray(result) ? result[0] : result).output
  return new Map(
    output
      .filter((o): o is Rollup.OutputAsset => o.type === "asset" && o.fileName.endsWith(".html"))
      .map((o) => [o.fileName, String(o.source)]),
  )
}

/** The lock's inline script, and what sits before and after it in the head. */
function placement(html: string) {
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"))
  const scripts = [...head.matchAll(/<script\b[^>]*>/g)].map((m) => ({
    tag: m[0],
    at: m.index!,
  }))
  const lockAt = head.indexOf(`<script>${nativeLockScript()}</script>`)
  const charset = /<meta\s+charset=[^>]*>/i.exec(head)!
  return {
    lockAt,
    afterCharset: lockAt === charset.index + charset[0].length,
    charsetAt: html.indexOf(charset[0]),
    classicScriptsBefore: scripts.filter((s) => s.at < lockAt && !/type="module"/.test(s.tag)),
    scriptsBefore: scripts.filter((s) => s.at < lockAt).map((s) => s.tag),
    firstOf: (tag: string) => head.indexOf(tag),
  }
}

function inlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  expect(match).not.toBeNull()
  return match![1]!
}

/** A page-like realm with the browser's own shapes: methods on the prototype, probes as statics. */
function pageRealm(
  options: { webauthn?: boolean; sealed?: boolean; overridden?: boolean; kept?: boolean } = {},
) {
  const context = createContext({})
  const scope = runInContext(
    `(function () {
      var proto = { create: Object.create, get: Reflect.get }
      var credentials = Object.create(proto)
      var original = Function.prototype.toString
      var prints = new Map()
      Function.prototype.toString = function () {
        return prints.has(this) ? prints.get(this) : original.call(this)
      }
      var pkc = function PublicKeyCredential() {}
      for (var name of ["isUserVerifyingPlatformAuthenticatorAvailable", "isConditionalMediationAvailable", "getClientCapabilities"]) {
        var fn = function () {}
        prints.set(fn, "function " + name + "() { [native code] }")
        pkc[name] = fn
      }
      return { credentials: credentials, pkc: pkc }
    })()`,
    context,
  )
  context.navigator = { credentials: scope.credentials }
  if (options.webauthn !== false) context.PublicKeyCredential = scope.pkc
  if (options.sealed) Object.preventExtensions(scope.credentials)
  if (options.overridden) {
    runInContext("navigator.credentials.create = function create(e) { return e }", context)
  }
  // Proton Pass's get, by the one thing the lock reads from it: its bridge message name.
  if (options.kept) {
    runInContext('navigator.credentials.get = (e) => ({ type: "PASSKEY_GET", e })', context)
  }
  return { context, credentials: scope.credentials as object, pkc: scope.pkc as object }
}

describe("nativePasskeyLock", () => {
  it("splices the script in right after the charset meta, ahead of every other tag in head", () => {
    const hook = nativePasskeyLock().transformIndexHtml as { handler: (html: string) => unknown }
    const html = hook.handler(INDEX_HTML) as string
    expect(typeof html).toBe("string")
    const where = placement(html)
    expect(where.afterCharset).toBe(true)
    expect(where.scriptsBefore).toEqual([])
    expect(where.charsetAt).toBeLessThan(1024)
    for (const tag of ["<link", "<style", "<title"]) {
      expect(where.firstOf(tag)).toBeGreaterThan(where.lockAt)
    }
  })

  it("recognizes a charset meta with other attributes or spaced equals, inside head only", () => {
    const hook = nativePasskeyLock().transformIndexHtml as { handler: (html: string) => string }
    const script = `<script>${nativeLockScript()}</script>`
    for (const meta of ['<meta charset = "UTF-8">', '<meta data-test="x" charset="utf-8" />']) {
      const html = hook.handler(`<html><head>${meta}<title>x</title></head><body></body></html>`)
      expect(html).toBe(`<html><head>${meta}${script}<title>x</title></head><body></body></html>`)
    }
    const late = hook.handler(
      '<html><head><title>x</title></head><body><meta charset="UTF-8"></body></html>',
    )
    expect(late).toBe(
      `<html><head>${script}<title>x</title></head><body><meta charset="UTF-8"></body></html>`,
    )
  })

  it("puts the script first in a head with no charset meta, and leaves a page with no head alone", () => {
    const hook = nativePasskeyLock().transformIndexHtml as { handler: (html: string) => string }
    const html = hook.handler("<html><head><title>x</title></head><body></body></html>")
    expect(html).toBe(
      `<html><head><script>${nativeLockScript()}</script><title>x</title></head><body></body></html>`,
    )
    expect(hook.handler("<p>no head</p>")).toBe("<p>no head</p>")
  })

  it("lands in index.html and every route page the build emits, with no placeholder left", async () => {
    const pages = await buildPages()
    expect([...pages.keys()].sort()).toEqual([
      "index.html",
      "link.html",
      "pay.html",
      "request.html",
    ])
    for (const html of pages.values()) {
      const where = placement(html)
      expect(where.afterCharset).toBe(true)
      expect(where.scriptsBefore).toEqual([])
      expect(where.firstOf('<script type="module"')).toBeGreaterThan(where.lockAt)
      expect(html).not.toMatch(/__OG_[A-Z_]+__/)
    }
  }, 60_000)

  it("ships text that runs in a bare realm and locks the browser's own functions", async () => {
    const script = inlineScript((await buildPages()).get("index.html")!)
    const page = pageRealm()
    runInContext(script, page.context)
    expect(page.context[NATIVE_LOCK_KEY]).toEqual(
      Object.fromEntries(NAMES.map((n) => [n, "applied"])),
    )
    for (const [container, names] of [
      [page.credentials, ["create", "get"]],
      [page.pkc, NAMES.slice(2)],
    ] as const) {
      for (const name of names) {
        const desc = Object.getOwnPropertyDescriptor(container, name)!
        expect(desc.writable).toBe(false)
        expect(desc.configurable).toBe(false)
        expect(typeof desc.value).toBe("function")
      }
    }
    const bare = pageRealm({ webauthn: false })
    runInContext(script, bare.context)
    expect(bare.context[NATIVE_LOCK_KEY]).toEqual(
      Object.fromEntries(NAMES.map((n) => [n, "unsupported"])),
    )
    const sealed = pageRealm({ sealed: true })
    runInContext(script, sealed.context)
    expect(sealed.context[NATIVE_LOCK_KEY]).toMatchObject({ create: "lost_race", get: "lost_race" })
    const overridden = pageRealm({ overridden: true })
    runInContext(script, overridden.context)
    expect(overridden.context[NATIVE_LOCK_KEY]).toMatchObject({
      create: "restored",
      get: "applied",
    })
    const restored = Object.getOwnPropertyDescriptor(overridden.credentials, "create")!
    expect(restored.writable).toBe(false)
    expect(restored.value).toBe(Object.getPrototypeOf(overridden.credentials).create)
    expect(Object.keys(overridden.context[KEPT_PASSKEY_API_KEY])).toEqual([])

    const kept = pageRealm({ kept: true })
    const wrapper = (kept.credentials as { get: unknown }).get
    runInContext(script, kept.context)
    expect(kept.context[NATIVE_LOCK_KEY]).toMatchObject({ create: "applied", get: "restored" })
    expect(Object.getOwnPropertyDescriptor(kept.credentials, "get")!.value).toBe(
      Object.getPrototypeOf(kept.credentials).get,
    )
    const slot = Object.getOwnPropertyDescriptor(kept.context, KEPT_PASSKEY_API_KEY)!
    expect(slot.writable).toBe(false)
    expect(slot.configurable).toBe(false)
    expect(Object.isFrozen(slot.value)).toBe(true)
    expect(Object.getPrototypeOf(slot.value)).toBeNull()
    expect(slot.value.get).toBe(wrapper)
    expect(slot.value.create).toBeUndefined()
  }, 60_000)

  it("is served the same way by the dev server", async () => {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: plugins(),
      server: { middlewareMode: true },
    })
    try {
      const html = await server.transformIndexHtml("/", INDEX_HTML)
      const where = placement(html)
      expect(where.afterCharset).toBe(true)
      expect(where.classicScriptsBefore).toEqual([])
    } finally {
      await server.close()
    }
  }, 60_000)
})

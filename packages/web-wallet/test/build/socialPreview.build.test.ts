// @vitest-environment node
/**
 * The plugin through a real, minimal `vite build` of the wallet's own index.html: the card must be
 * in the HTML a crawler fetches, after vite's HTML pass has injected the bundle's tags.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, createServer, type Rollup } from "vite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HOME_PREVIEW, ROUTE_PAGES, socialPreview } from "../../socialPreview"

const INDEX_HTML = readFileSync(join(__dirname, "../../index.html"), "utf8")
const ENV = { VITE_SITE_ORIGIN: "https://wallet.example/" }
const LINK = ROUTE_PAGES["link.html"]
const PAY = ROUTE_PAGES["pay.html"]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "social-preview-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/boot.tsx"), 'document.body.dataset.booted = "yes"\n')
  writeFileSync(join(root, "index.html"), INDEX_HTML)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function buildPages(env: Record<string, string>): Promise<Map<string, string>> {
  const result = (await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [socialPreview(env)],
    build: { write: false },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  const output = (Array.isArray(result) ? result[0] : result).output
  return new Map(
    output
      .filter((o): o is Rollup.OutputAsset => o.type === "asset" && o.fileName.endsWith(".html"))
      .map((o) => [o.fileName, String(o.source)]),
  )
}

function card(html: string) {
  const meta = (attribute: string, name: string) =>
    html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`))?.[1]
  return {
    title: meta("property", "og:title"),
    description: meta("property", "og:description"),
    searchDescription: meta("name", "description"),
    twitterTitle: meta("name", "twitter:title"),
    image: meta("property", "og:image"),
    twitterImage: meta("name", "twitter:image"),
    documentTitle: html.match(/<title>([^<]*)<\/title>/)?.[1],
  }
}

describe("socialPreview", () => {
  it("fills the home card into index.html and emits the link pages with the payment-link card", async () => {
    const pages = await buildPages(ENV)
    expect([...pages.keys()].sort()).toEqual([
      "index.html",
      "link.html",
      "pay.html",
      "request.html",
    ])

    const image = "https://wallet.example/og.png"
    expect(card(pages.get("index.html")!)).toEqual({
      title: "zk.money",
      description:
        "Join zk.money to send or receive crypto privately. Open source, self-custodial, built on Ethereum.",
      searchDescription:
        "Join zk.money to send or receive crypto privately. Open source, self-custodial, built on Ethereum.",
      twitterTitle: "zk.money",
      image,
      twitterImage: image,
      documentTitle: "zk.money",
    })
    for (const page of ["link.html", "request.html"]) {
      expect(card(pages.get(page)!)).toEqual({
        title: "zk.money pay link",
        description: "Receive or send crypto privately with pay links.",
        searchDescription: "Receive or send crypto privately with pay links.",
        twitterTitle: "zk.money pay link",
        image,
        twitterImage: image,
        documentTitle: "zk.money",
      })
    }
    expect(card(pages.get("pay.html")!)).toMatchObject({
      title: "zk.money pay page",
      description: "Pay privately with zk.money, or from any Ethereum wallet.",
    })
  })

  it("keeps the route pages the same document as index.html apart from the card", async () => {
    const pages = await buildPages(ENV)
    const index = pages.get("index.html")!
    expect(index).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>/)
    for (const [page, copy] of Object.entries(ROUTE_PAGES)) {
      const asHome = pages
        .get(page)!
        .replaceAll(copy.title, HOME_PREVIEW.title)
        .replaceAll(copy.description, HOME_PREVIEW.description)
      expect(asHome).toBe(index)
    }
    for (const html of pages.values()) expect(html).not.toMatch(/__OG_[A-Z_]+__/)
  })

  it("serves the image from a relative path without VITE_SITE_ORIGIN", async () => {
    const pages = await buildPages({})
    for (const html of pages.values()) expect(card(html).image).toBe("/og.png")
  })

  it("emits no route pages in a desktop build", async () => {
    const pages = await buildPages({ ...ENV, VITE_DESKTOP_BUILD: "true" })
    expect([...pages.keys()]).toEqual(["index.html"])
    expect(card(pages.get("index.html")!).title).toBe("zk.money")
  })

  it("fills the dev server's index.html by the requested path", async () => {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [socialPreview(ENV)],
      server: { middlewareMode: true, ws: false },
    })
    try {
      const at = async (url: string) => card(await server.transformIndexHtml(url, INDEX_HTML, url))
      expect((await at("/")).title).toBe("zk.money")
      expect((await at("/settings")).title).toBe("zk.money")
      expect((await at("/link")).title).toBe(LINK.title)
      expect((await at("/request?x=1")).description).toBe(LINK.description)
      expect((await at("/link/")).title).toBe("zk.money")
      expect((await at("/pay/river")).title).toBe(PAY.title)
      expect((await at("/pay")).title).toBe("zk.money")
      expect((await at("/pay/river/x")).title).toBe("zk.money")
    } finally {
      await server.close()
    }
  })
})

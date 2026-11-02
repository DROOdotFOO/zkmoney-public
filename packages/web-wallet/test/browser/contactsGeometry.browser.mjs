import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { startCaptureServer, walletDir } from "../../scripts/ui-capture/server.mjs"
import { loadChromium, localBaseUrl, installCaptureGuard, verificationErrors } from "../../scripts/ui-capture/capture-support.mjs"
import { FIXTURE_TIME, settle } from "../../scripts/ui-capture/plan.mjs"
// The contacts demo seeds this tag at the length limit, still on a retired rollup.
const LONG_STALE_TAG = "mslongtag".padEnd(32, "x")

// Boot the real App and its CSS imports; a static shell.css subset misses flow-layout.css.
let server, browser, base
const output = await mkdtemp(path.join(tmpdir(), "contacts-layout-"))
const repo = path.resolve(walletDir, "../..")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
  hashes: {},
}
for (const file of ["src/ui/shell.css", "src/ui/flow-layout.css", "src/features/contacts/ContactsScreen/ContactsScreen.tsx", "test/browser/contactsGeometry.browser.mjs"]) {
  source.hashes[file] = hash(await readFile(path.join(walletDir, file)))
}
before(async () => {
  const chromium = loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH)
  const started = await startCaptureServer(Number(process.env.CONTACTS_LAYOUT_PORT ?? 5498))
  server = started.server
  base = localBaseUrl(started.origin)
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
}, { timeout: 120_000 })
after(async () => {
  try { await browser?.close() } finally { await server?.close() }
  console.info(`Contacts geometry evidence: ${output}`)
})

const cases = [
  { width: 390, height: 667 },
  { width: 402, height: 879 },
  { width: 640, height: 879 },
  { width: 402, height: 678 },
  { width: 390, height: 667, insets: { top: 20, right: 12, bottom: 34, left: 12 } },
  { width: 402, height: 678, insets: { top: 20, right: 12, bottom: 34, left: 12 } },
  { width: 1280, height: 832 },
]
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual}, expected ${expected}`)

for (const { width, height, insets } of cases) {
  test(`actual Contacts ${width}x${height}${insets ? " with safe insets" : ""}`, { timeout: 120_000 }, async () => {
    const name = `${width}x${height}${insets ? "-insets" : ""}`
    const report = { source, viewport: { width, height }, insets: insets ?? null, ok: false }
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce",
      colorScheme: "dark", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
    })
    try {
      await context.grantPermissions(["local-network-access"], { origin: base.origin })
      await installCaptureGuard(context, base, report)
      if (insets) await context.addInitScript((edges) => {
        const apply = () => {
          if (!document.documentElement) return false
          for (const [edge, value] of Object.entries(edges)) {
            document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`, "important")
          }
          return true
        }
        if (!apply()) {
          const observer = new MutationObserver(() => { if (apply()) observer.disconnect() })
          observer.observe(document, { childList: true })
        }
      }, insets)
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      if (insets) {
        const cdp = await context.newCDPSession(page)
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets })
      }
      await page.clock.setFixedTime(new Date(FIXTURE_TIME))
      await page.goto(`${base.origin}/?demo=contacts`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-shell").waitFor({ state: "visible" })
      await page.goto(`${base.origin}/contacts`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-contacts").waitFor({ state: "visible" })
      const longRow = page.locator(".zkm-contact-row", { hasText: LONG_STALE_TAG }).first()
      await longRow.locator(".ww-contacts__trailing").waitFor({ state: "visible" })
      await settle(page)
      const screenshot = `${name}.png`
      const pixels = await page.screenshot({ path: path.join(output, screenshot), animations: "disabled" })
      report.screenshot = { file: screenshot, sha256: hash(pixels) }
      report.longTag = await longRow.evaluate((row) => {
        const title = row.querySelector(".zkm-contact-row__text > .zkm-gradient-text")
        const r = title.getBoundingClientRect()
        return {
          right: r.right,
          badgeLeft: row.querySelector(".ww-contacts__trailing").getBoundingClientRect().left,
          height: r.height,
        }
      })
      report.geometry = await page.evaluate(() => {
        const rect = (selector) => {
          const e = document.querySelector(selector)
          if (!e) return null
          const r = e.getBoundingClientRect(), s = getComputedStyle(e)
          return { x: r.x, y: r.y, width: r.width, height: r.height,
            centerX: r.x + r.width / 2, centerY: r.y + r.height / 2, padding: s.padding, display: s.display }
        }
        const selectors = []
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.selectorText) selectors.push(rule.selectorText)
            if (rule.type === CSSRule.IMPORT_RULE) walk(rule.styleSheet.cssRules)
            else if (rule.cssRules) walk(rule.cssRules)
          }
        }
        for (const sheet of document.styleSheets) walk(sheet.cssRules)
        return {
          head: rect(".ww-contacts__head"), back: rect(".ww-contacts__back"),
          title: rect(".ww-contacts__head > .zkm-gradient-text"),
          disc: rect(".ww-contacts__back-disc"), search: rect(".ww-contacts__search"),
          input: rect(".ww-contacts__search .ww-search"), scan: rect(".ww-contacts__search-action"),
          desktopSearch: rect(".ww-topbar .ww-search"), suffix: rect(".ww-search__suffix"),
          directChild: !!document.querySelector(".ww-content > .ww-contacts"),
          searchCount: document.querySelectorAll('input[aria-label="Search @tag"]').length,
          scrollWidth: document.documentElement.scrollWidth,
          hasFlowHeaderRule: selectors.includes(".ww-panel .ww-panel__head"),
        }
      })
      const g = report.geometry
      assert.equal(g.directChild, true)
      assert.equal(g.hasFlowHeaderRule, true, "the full imported flow stylesheet must be loaded")
      assert.equal(g.searchCount, 1)
      assert.ok(g.scrollWidth <= width)
      const t = report.longTag
      assert.ok(t.right <= t.badgeLeft, `long tag ends at ${t.right}, badge starts at ${t.badgeLeft}`)
      assert.ok(t.height < 30, `long tag stays on one line: ${t.height}px`)
      if (width <= 640) {
        const top = insets?.top ?? 0, left = insets?.left ?? 0, right = insets?.right ?? 0
        assert.equal(g.head.padding, "0px")
        near(g.head.y, top, "header top")
        near(g.head.height, 80, "header height")
        near(g.back.centerY, top + 40, "Back center")
        near(g.title.centerY, top + 40, "title center Y")
        near(g.title.centerX, (width + left - right) / 2, "title center X")
        near(g.title.height, 31.2, "title line height")
        near(g.back.width, 44, "Back target width")
        near(g.back.height, 44, "Back target height")
        near(g.disc.x, left + 24, "Back disc left")
        near(g.disc.y, top + 20, "Back disc top")
        near(g.disc.width, 40, "Back disc width")
        near(g.disc.height, 40, "Back disc height")
        near(g.search.y, top + 104, "search top")
        near(g.search.x, left + 24, "search left")
        near(g.search.width, width - left - right - 48, "search row width")
        near(g.input.height, 44, "search pill height")
        near(g.scan.y, g.search.y, "Scan aligned to search")
        near(g.scan.width, 44, "Scan target")
        near(g.scan.x - g.input.x - g.input.width, 8, "input to Scan gap")
      } else {
        assert.equal(g.head.padding, "40px 40px 0px", "desktop panel padding remains unchanged")
        assert.equal(g.back, null)
        assert.equal(g.search, null)
        assert.equal(g.scan, null)
        near(g.desktopSearch.width, 434, "desktop search width")
        assert.notEqual(g.suffix.display, "none")
      }
      assert.deepEqual(verificationErrors(report), [])
      report.ok = true
    } catch (error) {
      report.error = { message: error.message, stack: error.stack }
      throw error
    } finally {
      report.verificationErrors = verificationErrors(report)
      await context.close()
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(report, null, 2) + "\n")
    }
  })
}

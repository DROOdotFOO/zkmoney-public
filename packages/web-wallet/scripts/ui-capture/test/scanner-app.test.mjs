import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { startCaptureServer, walletDir } from "../server.mjs"
import { cameraStep, installCameraFixture } from "../camera.mjs"
import { installCaptureGuard, loadChromium, verificationErrors } from "../capture-support.mjs"
import { FIXTURE_TIME, settle } from "../plan.mjs"

const repo = path.resolve(walletDir, "../..")
const insets = { top: 47, right: 6, bottom: 34, left: 6 }
const phones = [{ width: 390, height: 844 }, { width: 402, height: 879 }, { width: 390, height: 667 }]
const scanner = (page) => page.getByRole("dialog", { name: "Scan QR code", exact: true })
const share = (page) => page.getByRole("dialog", { name: "Share @tag", exact: true })
const button = (page, name) => page.getByRole("button", { name, exact: true })
async function live(page) { await page.getByText("Point your camera at a wallet QR code.", { exact: true }).waitFor() }
async function openScan(page) { await button(page, "Open menu").click(); await button(page, "Scan QR code").click(); await live(page) }
async function focusWithin(page, modal) {
  assert(await modal.evaluate((node) => node.contains(document.activeElement)), "focus belongs to the visible native dialog")
  await page.keyboard.press("Tab")
  assert(await modal.evaluate((node) => node.contains(document.activeElement)), "Tab stays in the visible native dialog")
}

async function visibleFocus(page) {
  const focused = await page.evaluate(() => {
    const node = document.activeElement
    const box = node?.getBoundingClientRect()
    const style = node ? getComputedStyle(node) : null
    return { tag: node?.tagName, className: node?.className,
      viable: !!node && node !== document.body && node.isConnected && !node.closest("[inert]") &&
        box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight &&
        style.visibility !== "hidden" && style.display !== "none" }
  })
  assert(focused.viable, "closing or invalidating the overlay leaves viable visible focus")
  return focused
}

async function pixelDifference(page, current, original) {
  return page.evaluate(async ({ current, original }) => {
    const decode = async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext("2d")
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return context.getImageData(0, 0, canvas.width, canvas.height)
    }
    const [a, b] = await Promise.all([decode(current), decode(original)])
    const dimensions = { current: { width: a.width, height: a.height }, original: { width: b.width, height: b.height } }
    if (a.width !== b.width || a.height !== b.height) return { dimensions, dimensionMismatch: true }
    let count = 0, maxChannelDelta = 0, left = a.width, top = a.height, right = -1, bottom = -1
    for (let i = 0; i < a.data.length; i += 4) {
      let differs = false
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(a.data[i + channel] - b.data[i + channel])
        maxChannelDelta = Math.max(maxChannelDelta, delta)
        differs ||= delta !== 0
      }
      if (differs) {
        count++
        const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width)
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
      }
    }
    return { dimensions, differentPixels: count, maxChannelDelta, bounds: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
  }, { current: current.toString("base64"), original: original.toString("base64") })
}

async function connectGeometry(page) {
  await page.evaluate(() => document.fonts.ready)
  const geometry = await page.locator(".ww-connect__identity").evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const style = getComputedStyle(node)
    return {
      text: node.textContent,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      box: node.getBoundingClientRect().toJSON(),
      lines: [...range.getClientRects()].map((rect) => rect.toJSON()),
      style: { overflowWrap: style.overflowWrap, overflow: style.overflow, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow },
    }
  })
  assert.equal(geometry.text, "@" + "a".repeat(32), "the complete recipient identity is rendered")
  assert(geometry.scrollWidth <= geometry.clientWidth, "long identity does not widen the document")
  assert(geometry.lines.length > 0)
  for (const line of geometry.lines) {
    assert(line.left >= geometry.box.left - 0.1 && line.right <= geometry.box.right + 0.1, "each identity text line fits its content box")
    assert(line.top >= geometry.box.top - 0.1 && line.bottom <= geometry.box.bottom + 0.1, "all identity text remains visible")
  }
  assert.equal(geometry.style.overflow, "visible", "identity overflow is not hidden")
  assert.equal(geometry.style.whiteSpace, "normal")
  for (const name of ["Add contact", "Dismiss"]) {
    const box = await button(page, name).boundingBox()
    assert(box.x >= 0 && box.x + box.width <= geometry.clientWidth, "existing confirmation controls fit the document")
  }
  return geometry
}

test("actual app scanner transitions, payload routes, guards and dev module worker", { timeout: 360_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), "ult-785-scanner-app-"))
  const report = { evidence: "actual App, shell, Modal, Share, classifier and worker; local demo identity/services and controlled media; no device or deployed claims", cases: [], screenshots: [], workerRequests: [], sourceHashes: {} }
  for (const file of ["src/App.tsx", "src/ui/AppShell/AppShell.tsx", "src/ui/Modal.tsx", "src/ui/shell.css", "src/ui/PhoneIcon.tsx", "src/features/contacts/ContactsScreen/ContactsScreen.tsx", "src/features/scan/ScannerModal.tsx", "scripts/ui-capture/camera.mjs", "scripts/ui-capture/fixtures/scanner.ts", "src/features/contacts/ConnectReceiveScreen.tsx", "src/features/scan/useScanShare.ts", "src/features/scan/ScanNavigation.tsx", "src/features/scan/scanner.css", "src/features/scan/decodeQrImage.ts", "vite.config.ts"]) {
    report.sourceHashes[file] = createHash("sha256").update(await readFile(path.join(walletDir, file))).digest("hex")
  }
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5785))
  const base = new URL(origin)
  let browser
  try {
    browser = await loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
    async function contextFor(viewport, colorScheme = "dark", state = "live", launcher = false, walletState, camera = {}) {
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce", serviceWorkers: "block" })
      await context.grantPermissions(["local-network-access"], { origin })
      await installCaptureGuard(context, base, report)
      await installCameraFixture(context, { ...camera, state })
      await context.addInitScript(({ edges, launcher, walletState }) => {
        if (walletState) {
          // Seed the guard before the first App render, as a cold wallet session would see it.
          let replaced = false
          window.__zkmWalletWrite = (key, value) => {
            if (replaced || value === null || !key.endsWith("webwallet.identity")) return undefined
            replaced = true
            const identity = JSON.parse(value)
            if (walletState === "nameless") delete identity.handle
            else identity.pending = true
            return JSON.stringify(identity)
          }
        }
        if (launcher) window.__ZKMONEY_DESKTOP_BRIDGE__ = { l1SubmitPath: "/launcher-test" }
        document.addEventListener("DOMContentLoaded", () => {
          for (const [edge, value] of Object.entries(edges)) document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`, "important")
        })
      }, { edges: insets, launcher, walletState })
      context.on("request", (request) => {
        if (request.url().includes("qrDecoder.worker") || request.url().includes("jsqr")) report.workerRequests.push(request.url())
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await page.clock.setFixedTime(new Date(FIXTURE_TIME))
      await page.goto(`${origin}/?demo=activity`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-shell").waitFor()
      await settle(page)
      return { context, page }
    }
    async function shot(page, name) {
      await settle(page)
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" })
      report.screenshots.push(`${name}.png`)
    }
    for (const viewport of phones) for (const colorScheme of ["dark", "light"]) {
      const { context, page } = await contextFor(viewport, colorScheme)
      const name = `${viewport.width}x${viewport.height}-${colorScheme}`
      try {
        const start = await page.evaluate(() => ({ url: location.href, length: history.length }))
        await openScan(page)
        const box = await page.locator(".ww-scan").boundingBox()
        assert(Math.abs(box.height - viewport.height) < 1, "scanner occupies the full viewport")
        await focusWithin(page, scanner(page))
        await shot(page, `${name}-scan`)
        const video = await page.locator("video").elementHandle()
        await button(page, "Show my QR code").click()
        await cameraStep(page, { operation: "assertStopped" })
        assert.equal(await video.evaluate((node) => node.srcObject), null)
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        await focusWithin(page, share(page))
        await shot(page, `${name}-share`)
        await share(page).evaluate((node) => node.dispatchEvent(new Event("cancel", { cancelable: true })))
        await live(page)
        await button(page, "Show my QR code").click()
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        await button(page, "Searching someone? Scan instead").click()
        await live(page)
        await page.keyboard.press("Escape")
        await scanner(page).waitFor({ state: "detached" })
        assert(await button(page, "Open menu").evaluate((node) => node === document.activeElement), "Scan-origin close restores menu trigger")
        assert.deepEqual(await page.evaluate(() => ({ url: location.href, length: history.length })), start, "toggles do not navigate or grow history")
        // Reverse origin: closing Scan returns to a freshly mounted Share.
        await button(page, "Open menu").click()
        await button(page, "Share @tag").click()
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        const first = await page.locator(".ww-share-tag").elementHandle()
        await button(page, "Searching someone? Scan instead").click()
        await live(page)
        await scanner(page).evaluate((node) => node.close())
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        assert.equal(await first.evaluate((node) => node.isConnected), false, "Share remounts for a fresh mint")
        await page.keyboard.press("Escape")
        await share(page).waitFor({ state: "detached" })
        assert(await button(page, "Open menu").evaluate((node) => node === document.activeElement))
        assert.equal(await page.evaluate(() => history.length), start.length)
        // Actual dev worker decodes a camera frame, stops tracks, and seeds existing search once.
        await openScan(page)
        await cameraStep(page, { operation: "payload", value: "@newfriend.zk.money" })
        await page.waitForURL("**/contacts")
        const input = page.getByRole("searchbox", { name: "Search @tag", exact: true })
        await input.waitFor()
        await page.waitForFunction(() => document.querySelector('[aria-label="Search @tag"]')?.value === "newfriend")
        assert(await input.evaluate((node) => node === document.activeElement), "destination search retains focus")
        assert.equal(await page.evaluate(() => history.state?.usr?.searchTag), undefined, "one-shot seed consumed")
        await cameraStep(page, { operation: "assertStopped" })
        assert.equal(await scanner(page).count(), 0)
        await input.fill("editedfriend")
        await page.waitForTimeout(650)
        assert.equal(await input.inputValue(), "editedfriend", "resolution rerenders preserve edits")
        const scan = page.locator(".ww-contacts__search > .ww-contacts__search-action")
        assert.equal(await scan.count(), 1)
        assert.equal(await page.locator(".ww-contacts__head-actions").count(), 0)
        assert.equal(await button(page, "Share @tag").count(), 0, "Contacts has no duplicate Share entry")
        assert.equal(await page.getByRole("searchbox", { name: "Search @tag", exact: true }).count(), 1)
        const geometry = await scan.evaluate((node) => {
          const search = node.previousElementSibling
          return { scan: node.getBoundingClientRect().toJSON(), search: search.getBoundingClientRect().toJSON(),
            glyph: node.firstElementChild.getBoundingClientRect().toJSON(), grid: getComputedStyle(node.parentElement).gridTemplateColumns,
            documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }
        })
        assert.equal(geometry.scan.width, 44); assert.equal(geometry.scan.height, 44)
        assert(Math.abs(geometry.glyph.width - 20.16) < 0.02)
        assert(Math.abs(geometry.scan.top - geometry.search.top) < 0.1, "Scan stays aligned with the top of search")
        assert(Math.abs(geometry.scan.left - geometry.search.right - 8) < 0.1, "Scan follows search with an 8px gap")
        assert(geometry.scan.right <= viewport.width - insets.right && geometry.search.left >= insets.left)
        assert(geometry.documentWidth <= geometry.viewportWidth)
        await input.focus()
        await page.keyboard.press("Tab")
        assert(await scan.evaluate((node) => node === document.activeElement), "Input then Scan keyboard order")
        assert.equal(await page.getByRole("region", { name: "Contact search results", exact: true }).count(), 0, "Scan focus cancels the lookup panel")
        await shot(page, `${name}-contacts`)
        const contactsHistory = await page.evaluate(() => ({ url: location.href, length: history.length }))
        await cameraStep(page, { operation: "payload", value: "" })
        await page.keyboard.press("Enter")
        await live(page)
        await button(page, "Show my QR code").click()
        await cameraStep(page, { operation: "assertStopped" })
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        await button(page, "Searching someone? Scan instead").click()
        await live(page)
        await page.keyboard.press("Escape")
        assert(await scan.evaluate((node) => node === document.activeElement), "Contacts-origin exit restores invoking Scan")
        assert.equal(await input.inputValue(), "editedfriend", "reciprocal flow preserves search edits")
        assert.deepEqual(await page.evaluate(() => ({ url: location.href, length: history.length })), contactsHistory)
        report.cases.push({ name, passed: true, stats: await cameraStep(page, { operation: "assertStopped" }), fullViewport: box })
      } catch (error) { await shot(page, `${name}-failure`).catch(() => {}); throw error }
      finally { await context.close() }
    }
    for (const widths of [[402, 641], [402, 641, 402], [1280, 402]]) {
      const { context, page } = await contextFor({ width: widths[0], height: 879 })
      try {
        const start = await page.evaluate(() => ({ url: location.href, length: history.length }))
        if (widths[0] <= 640) await button(page, "Open menu").click()
        const entry = widths[0] <= 640 ? page.getByRole("dialog", { name: "Wallet menu", exact: true }) : page.locator(".ww-topbar")
        await entry.getByRole("button", { name: "Share @tag", exact: true }).click()
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        for (const width of widths.slice(1)) {
          await page.setViewportSize({ width, height: 879 })
          await settle(page)
          if (await share(page).count()) await focusWithin(page, share(page))
          else await visibleFocus(page)
        }
        if (await share(page).count()) {
          await page.keyboard.press("Escape")
          await share(page).waitFor({ state: "detached" })
        }
        const focus = await visibleFocus(page)
        assert.deepEqual(await page.evaluate(() => ({ url: location.href, length: history.length })), start)
        assert.equal(await page.evaluate(() => document.body.style.overflow), "")
        const name = "share-resize-" + widths.join("-")
        await shot(page, name)
        report.cases.push({ name, passed: true, focus })
      } finally { await context.close() }
    }
    {
      const { context, page } = await contextFor(phones[2], "dark", "live", false, undefined, { torch: true })
      try {
        await openScan(page)
        await button(page, "Turn flashlight on").click()
        assert.equal(await button(page, "Turn flashlight off").getAttribute("aria-pressed"), "true")
        assert.equal(await page.evaluate(() => window.__walletCaptureCamera.stats().activeTorchTracks), 1)
        await shot(page, "torch-on")
        await button(page, "Turn flashlight off").click()
        assert.deepEqual(await page.evaluate(() => window.__walletCaptureCamera.stats().torchChanges), [true, false])
        await button(page, "Turn flashlight on").click()
        await button(page, "Show my QR code").click()
        assert.equal((await cameraStep(page, { operation: "assertStopped" })).activeTorchTracks, 0)
        await page.getByLabel("My connect QR code", { exact: true }).waitFor()
        await page.setViewportSize({ width: 641, height: 667 })
        await share(page).waitFor({ state: "detached" })
        const focus = await visibleFocus(page)
        await cameraStep(page, { operation: "assertStopped" })
        report.cases.push({ name: "torch-and-scan-origin-resize", passed: true, focus })
      } finally { await context.close() }
    }
    for (const state of ["pending", "denied", "unavailable"]) {
      const { context, page } = await contextFor(phones[2], "dark", state)
      try {
        await button(page, "Open menu").click(); await button(page, "Scan QR code").click()
        await scanner(page).waitFor()
        if (state !== "pending") await page.getByRole("alert").waitFor()
        await shot(page, `app-${state}`)
        await page.getByLabel("Paste a link or @tag", { exact: true }).fill("0x" + "12".repeat(20))
        await button(page, "Continue").click()
        await page.getByRole("alert").filter({ hasText: "not a saved contact" }).waitFor()
        assert.equal(await page.getByLabel("Paste a link or @tag", { exact: true }).getAttribute("aria-invalid"), "true")
        await page.getByLabel("Paste a link or @tag", { exact: true }).fill("https://wallet.test/connect#bad!")
        await button(page, "Continue").click()
        await page.getByRole("alert").filter({ hasText: "connect link is invalid" }).waitFor()
        await page.getByLabel("Paste a link or @tag", { exact: true }).fill("@ada")
        await button(page, "Continue").click()
        await page.waitForURL("**/contacts/ada")
        if (state === "pending") await cameraStep(page, { operation: "grant" })
        await page.waitForFunction(() => window.__walletCaptureCamera.stats().activeTracks === 0)
        assert(await page.locator(".ww-main").evaluate((node) => node.contains(document.activeElement)), "existing contact receives focus")
        report.cases.push({ name: `manual-${state}`, passed: true, stats: await cameraStep(page, { operation: "assertStopped" }) })
      } finally { await context.close() }
    }
    for (const [kind, viewport, colorScheme] of [...phones.flatMap((viewport) => ["dark", "light"].map((preference) => ["connect", viewport, preference])), ["paylink", phones[0], "dark"], ["preparedPaylink", phones[0], "dark"], ["request", phones[0], "dark"]]) {
      const { context, page } = await contextFor(viewport, colorScheme)
      try {
        const inputs = await page.evaluate(async () => {
          sessionStorage.setItem("ui-capture.flow-state", "success")
          const fixture = await import("/scripts/ui-capture/fixtures/scanner.ts")
          return { corpus: await fixture.scannerCorpus(), contacts: await fixture.scannerContacts() }
        })
        const payload = inputs.corpus[kind]
        const isPaylink = kind === "paylink" || kind === "preparedPaylink"
        if (kind === "connect") assert(payload.length > 300, "long connect packet uses the production mint")
        await openScan(page)
        const before = await page.evaluate(() => {
          window.__scannerNavigations = []
          const push = history.pushState.bind(history)
          history.pushState = (state, unused, url) => { window.__scannerNavigations.push(String(url)); return push(state, unused, url) }
          return history.length
        })
        await cameraStep(page, { operation: "payload", value: payload })
        await page.waitForFunction(() => window.__scannerNavigations.length > 0)
        const target = "/" + (isPaylink ? "link" : kind) + "#" + payload.split("#")[1]
        assert.deepEqual(await page.evaluate(() => window.__scannerNavigations), [target], "one handoff preserves the full packet")
        if (isPaylink) {
          // The existing signed-in claim route consumes the fragment and replaces itself with Home.
          await page.getByRole("dialog", { name: "Claim your payment", exact: true }).waitFor()
          await button(page, "Accept").waitFor()
          if (kind === "preparedPaylink") {
            const claim = page.getByRole("dialog", { name: "Claim your payment", exact: true })
            await claim.getByText("--", { exact: true }).waitFor()
            assert.equal(await claim.getByRole("link").count(), 0, "prepared link has no funding transaction link")
          }
        } else await page.waitForURL((url) => url.pathname === "/" + kind)
        await scanner(page).waitFor({ state: "detached" })
        if (kind === "connect") await button(page, "Add contact").waitFor()
        else await page.locator(".ww-modal, .ww-panel, .ww-flow").first().waitFor()
        await settle(page)
        await cameraStep(page, { operation: "assertStopped" })
        const contacts = await page.evaluate(async () => (await import("/scripts/ui-capture/fixtures/scanner.ts")).scannerContacts())
        assert.deepEqual(contacts, inputs.contacts, "scan opens the existing confirmation without adding a contact")
        assert.equal(await page.evaluate(() => history.length), before + 1, "one destination handoff")
        assert(await page.locator(".zkm-root").evaluate((node) => node.contains(document.activeElement) && !document.activeElement.closest(".ww-shell-header, .ww-sidebar")), "destination owns focus even when SidebarLayout unmounts")
        if (kind === "request") assert.equal(new URL(page.url()).hash, payload.slice(payload.indexOf("#")), "request keeps its packet after the handoff")
        const geometry = kind === "connect" ? await connectGeometry(page) : undefined
        if (geometry) {
          assert(geometry.lines.length > 1, "the long phone identity wraps across visible lines")
          assert.equal(geometry.style.overflowWrap, "anywhere")
        }
        const name = kind === "connect" ? `payload-connect-${viewport.width}x${viewport.height}-${colorScheme}` : kind === "preparedPaylink" ? "payload-prepared-paylink" : `payload-${kind}`
        await shot(page, name)
        report.cases.push({ name, payload, viewport, geometry, passed: true })
      } finally { await context.close() }
    }
    // Desktop has no scanner entry; compare the existing destination with its pre-change markup.
    {
      const { context, page } = await contextFor({ width: 1280, height: 832 })
      try {
        const payload = await page.evaluate(async () => (await (await import("/scripts/ui-capture/fixtures/scanner.ts")).scannerCorpus()).connect)
        await page.goto(`${origin}/connect?demo=activity#${payload.split("#")[1]}`)
        await button(page, "Add contact").waitFor()
        await settle(page)
        const geometry = await connectGeometry(page)
        assert.equal(geometry.lines.length, 1, "desktop identity keeps its existing single line")
        assert.equal(geometry.style.overflowWrap, "normal")
        const title = await page.locator(".ww-connect__identity").elementHandle()
        // Exclude the unrelated shell search edge, whose antialiasing varies on unchanged DOM.
        const clip = await page.locator(".ww-flow").filter({ has: page.locator(".ww-connect__identity") }).boundingBox()
        const current = await page.screenshot({ clip, animations: "disabled" })
        await title.evaluate((node) => node.removeAttribute("class"))
        const originalStyle = await title.evaluate((node) => {
          const style = getComputedStyle(node)
          return { overflowWrap: style.overflowWrap, overflow: style.overflow, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow }
        })
        const original = await page.screenshot({ clip, animations: "disabled" })
        await writeFile(path.join(output, "desktop-parity-current.png"), current)
        await writeFile(path.join(output, "desktop-parity-original.png"), original)
        report.screenshots.push("desktop-parity-current.png", "desktop-parity-original.png")
        const parity = { region: "connect destination", clip, difference: await pixelDifference(page, current, original), currentSha256: createHash("sha256").update(current).digest("hex"), originalSha256: createHash("sha256").update(original).digest("hex") }
        report.desktopParity = parity
        await writeFile(path.join(output, "desktop-parity.json"), JSON.stringify(parity, null, 2))
        assert.deepEqual(geometry.style, originalStyle, "desktop computed identity styling is unchanged")
        assert(current.equals(original), "desktop destination-region pixels match the original classless markup")
        await title.evaluate((node) => node.className = "ww-connect__identity")
        await shot(page, "payload-connect-desktop")
        report.cases.push({ name: "payload-connect-desktop", passed: true, geometry, parity })
      } finally { await context.close() }
    }
    for (const state of ["nameless", "pending"]) {
      const { context, page } = await contextFor(phones[0], "dark", "live", false, state)
      try {
        await button(page, "Open menu").click()
        await page.getByRole("dialog", { name: "Wallet menu", exact: true }).getByRole("button", { name: "Contacts", exact: true }).click()
        await page.waitForURL("**/contacts")
        assert.equal(await button(page, "Scan QR code").count(), 0)
        assert.equal(await button(page, "Share @tag").count(), 0, "guarded Contacts does not retain the removed Share button")
        await shot(page, "guard-" + state + "-contacts")
        await button(page, "Back").click()
        await button(page, "Open menu").click()
        await button(page, "Share @tag").click()
        await share(page).waitFor()
        assert.equal(await button(page, "Searching someone? Scan instead").count(), 0)
        await page.keyboard.press("Escape")
        assert.equal((await cameraStep(page, { operation: "assertStopped" })).requests, 0)
        report.cases.push({ name: "guard-" + state + "-contacts", passed: true })
      } finally { await context.close() }
    }
    for (const [width, launcher] of [[640, false], [641, false], [1280, false], [390, true]]) {
      const { context, page } = await contextFor({ width, height: 832 }, "light", "live", launcher)
      try {
        if (width <= 640) await button(page, "Open menu").click()
        assert.equal(await button(page, "Scan QR code").count(), width <= 640 && !launcher ? 1 : 0)
        await button(page, "Share @tag").click()
        await share(page).waitFor()
        assert.equal(await button(page, "Searching someone? Scan instead").count(), width <= 640 && !launcher ? 1 : 0)
        await page.keyboard.press("Escape")
        await shot(page, `guard-${width}-${launcher ? "launcher" : "browser"}`)
        assert.equal((await cameraStep(page, { operation: "assertStopped" })).requests, 0)
        report.cases.push({ name: `guard-${width}-${launcher}`, passed: true })
      } finally { await context.close() }
    }
    assert(report.workerRequests.some((url) => url.includes("qrDecoder.worker")), "actual App requested the dev worker")
    assert(report.workerRequests.every((url) => new URL(url).origin === origin), "worker dependencies stay same-origin")
    assert.deepEqual(verificationErrors(report), [])
  } catch (error) { report.error = error.stack ?? String(error); throw error }
  finally {
    await browser?.close(); await server.close()
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2))
    console.info(`Integrated scanner evidence: ${output}`)
  }
})

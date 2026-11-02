import assert from "node:assert/strict"
import { createHash, createPublicKey, verify, X509Certificate } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"

const temp = mkdtempSync(join(tmpdir(), "passkey-rp-"))
const keyFile = join(temp, "key.pem")
const certFile = join(temp, "cert.pem")
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "1",
    "-subj",
    "/CN=auth.zk.money",
  ],
  { stdio: "ignore" },
)
const cert = readFileSync(certFile)
const spki = createHash("sha256")
  .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
  .digest("base64")
const root = new URL("../../../", import.meta.url)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest()
let relatedOriginRequests = 0
const server = createServer({ key: readFileSync(keyFile), cert }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`)
  if (url.pathname === "/.well-known/webauthn") {
    assert.equal(url.hostname, "auth.zk.money")
    relatedOriginRequests++
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(readFileSync(new URL("auth-web/public/.well-known/webauthn", root)))
  } else if (url.pathname.startsWith("/passkey/") && !url.pathname.includes("..")) {
    res.writeHead(200, { "content-type": "text/javascript" })
    res.end(readFileSync(new URL(`passkey-web/dist/${url.pathname.slice(9)}`, root)))
  } else if (url.pathname === "/core.js") {
    res.writeHead(200, { "content-type": "text/javascript" })
    res.end(readFileSync(new URL("core/dist/constants/index.js", root)))
  } else {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<script type="importmap">{"imports":{"@obsidion/core/constants":"/core.js"}}</script>
      <script type="module">
        import { BrowserPasskeyCeremony } from "/passkey/ceremony/passkeyCeremony.js"
        import { selectWebPasskeyRpId } from "/passkey/rules/relyingParty.js"
        window.ceremony = new BrowserPasskeyCeremony({focusWaitMs: 0})
        window.rp = (environment) => selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: environment })
      </script>`)
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port
let browser
try {
  browser = await chromium.launch({
    args: [
      `--host-resolver-rules=MAP *.zk.money:443 127.0.0.1:${port}`,
      `--ignore-certificate-errors-spki-list=${spki}`,
      "--no-proxy-server",
    ],
  })
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  })
  const visit = async (origin) => {
    await page.goto(origin)
    await page.waitForFunction(() => typeof window.rp === "function")
  }
  const create = (environment) =>
    page.evaluate(async (environment) => {
      const result = await window.ceremony.create({
        rpId: window.rp(environment),
        rpName: "zk.money",
        userName: "RP smoke",
        prfFirstSalt: new Uint8Array(32).fill(1),
      })
      return {
        credentialId: result.credentialId,
        pubkey: Array.from(result.pubkey),
        prf: Array.from(result.prfFirst ?? []),
      }
    }, environment)
  const sign = (environment, credentialId) =>
    page.evaluate(
      async ({ environment, credentialId }) => {
        const result = await window.ceremony.assert({
          rpId: window.rp(environment),
          challenge: new Uint8Array(32).fill(42),
          ...(credentialId ? { credentialIds: [credentialId] } : {}),
          prfFirstSalt: new Uint8Array(32).fill(1),
        })
        return {
          credentialId: result.credentialId,
          auth: Array.from(result.authenticatorData),
          client: Array.from(result.clientDataJSON),
          signature: Array.from(result.signatureDer),
          prf: Array.from(result.prfFirst ?? []),
        }
      },
      { environment, credentialId },
    )
  const checkSignature = (created, signed, rpId, origin) => {
    assert.equal(signed.credentialId, created.credentialId)
    assert.deepEqual(Buffer.from(signed.auth).subarray(0, 32), sha256(rpId))
    assert.equal(JSON.parse(Buffer.from(signed.client)).origin, origin)
    const pubkey = Buffer.from(created.pubkey)
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: pubkey.subarray(0, 32).toString("base64url"),
        y: pubkey.subarray(32).toString("base64url"),
      },
      format: "jwk",
    })
    assert.ok(
      verify(
        "sha256",
        Buffer.concat([Buffer.from(signed.auth), sha256(Buffer.from(signed.client))]),
        key,
        Buffer.from(signed.signature),
      ),
    )
  }

  await visit("https://launch.zk.money")
  const production = await create("production")
  const campaignProof = await sign("production", production.credentialId)
  assert.equal(campaignProof.prf.length, 32)
  await visit("https://wallet.zk.money")
  const walletProof = await sign("production", production.credentialId)
  assert.deepEqual(walletProof.prf, campaignProof.prf)
  checkSignature(production, walletProof, "auth.zk.money", "https://wallet.zk.money")
  checkSignature(production, await sign("production"), "auth.zk.money", "https://wallet.zk.money")
  assert.ok(relatedOriginRequests > 0, "Chromium must fetch the related-origins document")
  console.log("PASS production campaign creation, wallet signing and discoverable recovery over related origins")

  await visit("https://launch.staging.zk.money")
  const staging = await create("staging")
  for (const origin of [
    "https://wallet.staging.zk.money",
    "https://wallet-pr-123.staging.zk.money",
    "https://pr-123.launch.staging.zk.money",
  ]) {
    await visit(origin)
    checkSignature(staging, await sign("preview", staging.credentialId), "staging.zk.money", origin)
  }
  const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  assert.deepEqual(credentials.credentials.map((c) => c.rpId).sort(), ["auth.zk.money", "staging.zk.money"])
  const crossRp = await page.evaluate(async (credentialId) => {
    const id = Uint8Array.from(atob(credentialId.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))
    try {
      await navigator.credentials.get({
        signal: AbortSignal.timeout(500),
        publicKey: {
          rpId: "staging.zk.money",
          challenge: new Uint8Array(32),
          allowCredentials: [{ type: "public-key", id }],
        },
      })
      return "unexpected credential"
    } catch (error) {
      return error.name
    }
  }, production.credentialId)
  assert.ok(["NotAllowedError", "AbortError", "TimeoutError"].includes(crossRp), crossRp)
  console.log("PASS staging/paired previews share credentials; production credentials remain separate")

  await visit("https://unapproved.zk.money")
  const denied = await page.evaluate(async () => {
    try {
      await window.ceremony.assert({ rpId: "auth.zk.money", challenge: new Uint8Array(32) })
      return "unexpected credential"
    } catch (error) {
      return error.name
    }
  })
  assert.equal(denied, "RelatedOriginPasskeyError")
  console.log("PASS unapproved related origin reports a clear error")

  await visit(`https://localhost:${port}`)
  const local = await create("local")
  checkSignature(local, await sign("local", local.credentialId), "localhost", `https://localhost:${port}`)
  console.log("PASS local browser/desktop origin uses localhost")
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  rmSync(temp, { recursive: true, force: true })
}

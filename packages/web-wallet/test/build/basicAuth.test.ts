// @vitest-environment node
import { describe, expect, it } from "vitest"
import { BASIC_AUTH_COOKIE, checkBasicAuth, gateBasicAuth, isPublicPath } from "../../basicAuth"

const env = { BASIC_AUTH_USER: "team", BASIC_AUTH_PASS: "s3cret" }
const header = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`

function issuedCookie(e: Record<string, string> = env): string {
  const { setCookie } = gateBasicAuth(
    { authorization: header(e.BASIC_AUTH_USER, e.BASIC_AUTH_PASS) },
    e,
  )
  return setCookie!.split(";")[0]
}

describe("gateBasicAuth", () => {
  it("is off when BASIC_AUTH_USER is unset or empty, whatever the request carries", () => {
    const headers = { authorization: header("team", "s3cret"), cookie: issuedCookie() }
    expect(gateBasicAuth({}, {})).toEqual({ verdict: "off" })
    expect(gateBasicAuth(headers, {})).toEqual({ verdict: "off" })
    expect(gateBasicAuth(headers, { BASIC_AUTH_USER: "" })).toEqual({ verdict: "off" })
  })

  it("issues the CDN's cookie on a header login", () => {
    const { verdict, setCookie } = gateBasicAuth({ authorization: header("team", "s3cret") }, env)
    expect(verdict).toBe("ok")
    expect(setCookie).toMatch(new RegExp(`^${BASIC_AUTH_COOKIE}=[0-9a-f]{64}; `))
    expect(setCookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000")
    expect(setCookie).not.toContain("s3cret")
  })

  it("accepts the cookie alone, among other cookies, without reissuing it", () => {
    const cookie = `other=1; ${issuedCookie()}`
    expect(gateBasicAuth({ cookie }, env)).toEqual({ verdict: "ok" })
    expect(gateBasicAuth({ cookie, authorization: header("team", "s3cret") }, env)).toEqual({
      verdict: "ok",
    })
  })

  it("challenges with neither, wrong credentials, or a cookie from rotated credentials", () => {
    expect(gateBasicAuth({}, env)).toEqual({ verdict: "challenge" })
    expect(gateBasicAuth({ authorization: header("team", "wrong") }, env)).toEqual({
      verdict: "challenge",
    })
    const stale = issuedCookie({ BASIC_AUTH_USER: "team", BASIC_AUTH_PASS: "old" })
    expect(gateBasicAuth({ cookie: stale }, env)).toEqual({ verdict: "challenge" })
    expect(gateBasicAuth({ cookie: stale, authorization: header("team", "s3cret") }, env)).toEqual({
      verdict: "ok",
      setCookie: expect.stringContaining(issuedCookie()),
    })
  })
})

const credential = header(env.BASIC_AUTH_USER, env.BASIC_AUTH_PASS)

describe("checkBasicAuth", () => {
  it("is off without a configured user, otherwise admits the credential alone", () => {
    expect(checkBasicAuth(undefined, {})).toBe("off")
    expect(checkBasicAuth(credential, env)).toBe("ok")
    expect(checkBasicAuth(undefined, env)).toBe("challenge")
    expect(checkBasicAuth(`Basic ${Buffer.from("user:nope").toString("base64")}`, env)).toBe(
      "challenge",
    )
    expect(checkBasicAuth("Basic %%%", env)).toBe("challenge")
  })
})

// Mirrors the CDN's viewer-request exemptions (iac/modules/app-tier/modules/web-wallet).
describe("isPublicPath — what the local gate serves without a credential", () => {
  it("GET and HEAD of a shared link's page, card image and the wallet icon", () => {
    for (const path of ["/og.png", "/favicon.png", "/link", "/request", "/pay/river"]) {
      expect(isPublicPath("GET", path)).toBe(true)
      expect(isPublicPath("HEAD", path)).toBe(true)
    }
  })

  it("not the same paths by another method", () => {
    for (const path of ["/og.png", "/favicon.png", "/link", "/request", "/pay/river"]) {
      for (const method of ["POST", "OPTIONS", "PUT", "PATCH", "DELETE", undefined]) {
        expect(isPublicPath(method, path)).toBe(false)
      }
    }
  })

  it("not a near match, a nested path, /claim, the app root or an asset", () => {
    for (const path of [
      "/",
      "/index.html",
      "/claim",
      "/claim/",
      "/claim/alice",
      "/links",
      "/link/",
      "/link/x",
      "/requests",
      "/request/",
      "/request/x",
      "/pay",
      "/pay/",
      "/pay/river/",
      "/pay/river/x",
      "/og.png/",
      "/OG.png",
      "/assets/og.png",
      "/favicon.png/",
      "/assets/favicon.png",
      "/assets/app.js",
      "/svc/usage/events",
      "/settings",
    ]) {
      expect(isPublicPath("GET", path), path).toBe(false)
    }
  })
})

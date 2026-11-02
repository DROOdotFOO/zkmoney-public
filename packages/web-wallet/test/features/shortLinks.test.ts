// @vitest-environment node
// The codec's byte checks need one realm, which jsdom splits.
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeLinkFragment, encodePaylinkInline, LinkKind } from "@obsidion/sdk"

vi.stubGlobal("location", { origin: "https://wallet.zk.money" })
vi.mock("../../src/config/env", () => ({ getConfig: () => ({ network: "mainnet" }) }))
vi.mock("../../src/features/requests/requestLinkCreation", () => ({
  requestLinkOrigin: () => "https://wallet.zk.money",
}))

const { paylinkRowShareUrl } = await import("../../src/features/shortLinks")

const params = {
  secret: Fr.random(),
  paylinkType: "paylinkDirect",
  classId: Fr.random(),
  chainId: 1,
  rollupVersion: 7,
  fallbackKeyHash: Fr.random(),
}

describe("paylinkRowShareUrl", () => {
  it("shares a stored full link that carries a seed as its short link", () => {
    const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
    const stored = `${location.origin}/link#${encodePaylinkInline({ ...params, seed })}`
    const shared = paylinkRowShareUrl(stored)
    expect(shared.startsWith(`${location.origin}/link#`)).toBe(true)
    expect(decodeLinkFragment(shared.slice(shared.indexOf("#") + 1))).toEqual({
      kind: LinkKind.Paylink,
      seed,
    })
  })

  it("shares a stored link made before short links as it is", () => {
    const stored = `${location.origin}/link#${encodePaylinkInline(params)}`
    expect(paylinkRowShareUrl(stored)).toBe(stored)
  })
})

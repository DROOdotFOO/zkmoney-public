// @vitest-environment node
import { describe, expect, it } from "vitest"
import { encodeRequestInline } from "@obsidion/front-core"
import { encodeLinkFragment, LinkKind } from "@obsidion/sdk"
import { pastedLinkRoute } from "../../../src/features/paylink/pastedLink"
import { PAYLINK_FRAGMENT as VALID } from "../../fixtures/scanPayloads"

const REQUEST_FRAGMENT = encodeRequestInline({
  requestId: `0x${"0a".repeat(32)}`,
  requesterTag: "alice",
  amountAtomic: 1_000_000n,
  networkId: "0xrollup",
  tokenAddress: `0x${"1b".repeat(32)}`,
})

describe("pastedLinkRoute", () => {
  it("routes a claim URL, a web link URL, and a bare fragment", () => {
    for (const text of [
      `https://paylink.zk.money/claim#${VALID}`,
      `https://wallet.zk.money/link#${VALID}`,
      ` ${VALID} `,
    ]) {
      expect(pastedLinkRoute(text)).toBe(`/link#${VALID}`)
    }
  })

  it("routes a request URL and a bare request fragment to /request", () => {
    for (const text of [`https://paylink.zk.money/request#${REQUEST_FRAGMENT}`, REQUEST_FRAGMENT]) {
      expect(pastedLinkRoute(text)).toBe(`/request#${REQUEST_FRAGMENT}`)
    }
  })

  it("routes short links by their kind", () => {
    const seed = Uint8Array.from({ length: 16 }, (_, i) => i)
    const paylink = encodeLinkFragment(LinkKind.Paylink, seed)
    const request = encodeLinkFragment(LinkKind.Request, seed)
    expect(pastedLinkRoute(`https://zk.money/p#${paylink}`)).toBe(`/link#${paylink}`)
    expect(pastedLinkRoute(`https://wallet.zk.money/link#${paylink}`)).toBe(`/link#${paylink}`)
    expect(pastedLinkRoute(`https://zk.money/pay/alice#${request}`)).toBe(`/request#${request}`)
  })

  it("rejects text that decodes as neither", () => {
    for (const text of ["", "   ", "hello", "https://paylink.zk.money/claim#garbage", "#"]) {
      expect(pastedLinkRoute(text)).toBeNull()
    }
  })
})

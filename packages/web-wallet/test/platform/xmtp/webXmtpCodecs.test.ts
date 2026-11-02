import {
  AztecPaymentRequestCodec,
  ConnectBackCodec,
  buildConnectBack,
  buildPaymentRequest,
} from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  webConnectBackCodec,
  webPaymentRequestCodec,
  webXmtpCodecs,
} from "../../../src/platform/xmtp/codecs"

const typeString = (c: {
  authorityId: string
  typeId: string
  versionMajor: number
  versionMinor: number
}) => `${c.authorityId}/${c.typeId}:${c.versionMajor}.${c.versionMinor}`

describe("web XMTP codec registration", () => {
  it("registers the two shared content types under the ids the inbox driver matches on", () => {
    expect(webXmtpCodecs.map((c) => typeString(c.contentType))).toEqual([
      "obsidion.xyz/connect-back:1.0",
      "obsidion.xyz/payment-request:1.0",
    ])
  })

  it("uses the shared @obsidion/sdk codec bodies directly (no wrapper re-implementation)", () => {
    expect(webXmtpCodecs[0]).toBeInstanceOf(ConnectBackCodec)
    expect(webXmtpCodecs[1]).toBeInstanceOf(AztecPaymentRequestCodec)
  })

  it("encodes a connect-back byte-identically to the sdk codec and roundtrips it", () => {
    const content = buildConnectBack({ uuid: "f47ac10b-58cc-4372-a567-0e02b2c3d479" })
    const web = webConnectBackCodec.encode(content)
    const sdk = new ConnectBackCodec().encode(content)
    expect(Buffer.from(web.content).toString("hex")).toBe(Buffer.from(sdk.content).toString("hex"))
    expect(webConnectBackCodec.decode(web)).toEqual(content)
  })

  it("round-trips a payment-request announce through the registered codec (U12)", () => {
    const content = buildPaymentRequest({
      requestId: "0x" + "0c".repeat(32),
      requesterTag: "alice",
      amountAtomic: "25000000000",
      token: { address: "0x" + "1".repeat(64), symbol: "DAI", decimals: 9 },
      networkId: "testnet",
      note: "lunch",
    })
    expect(webPaymentRequestCodec.decode(webPaymentRequestCodec.encode(content))).toEqual(content)
  })
})

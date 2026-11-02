import { describe, it, expect } from "vitest"
import {
  ConnectBackCodec,
  ConnectBackContentTypeId,
  CodecDecodeError,
  buildConnectBack,
  CONNECT_BACK_VERSION,
  CONNECT_BACK_UUID_MAX_LEN,
  AztecPaymentRequestContentTypeId,
  type ConnectBackContent,
} from "../../src/xmtp/index.js"

const CODEC = new ConnectBackCodec()

const SAMPLE_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

function validContent(overrides: Partial<ConnectBackContent> = {}): ConnectBackContent {
  return {
    version: CONNECT_BACK_VERSION,
    uuid: SAMPLE_UUID,
    ...overrides,
  }
}

describe("ConnectBackContentTypeId", () => {
  it("renders the canonical obsidion.xyz/connect-back:1.0 identifier", () => {
    expect(ConnectBackContentTypeId.authorityId).toBe("obsidion.xyz")
    expect(ConnectBackContentTypeId.typeId).toBe("connect-back")
    expect(ConnectBackContentTypeId.versionMajor).toBe(1)
    expect(ConnectBackContentTypeId.versionMinor).toBe(0)
    // Sanity: the formatted string the XMTP SDK uses for wire routing.
    expect(
      `${ConnectBackContentTypeId.authorityId}/${ConnectBackContentTypeId.typeId}:` +
        `${ConnectBackContentTypeId.versionMajor}.${ConnectBackContentTypeId.versionMinor}`,
    ).toBe("obsidion.xyz/connect-back:1.0")
  })
})

describe("buildConnectBack", () => {
  it("stamps the current version when omitted", () => {
    const content = buildConnectBack({ uuid: SAMPLE_UUID })
    expect(content.version).toBe(CONNECT_BACK_VERSION)
    expect(content.uuid).toBe(SAMPLE_UUID)
  })

  it("honors an explicit version", () => {
    const content = buildConnectBack({ uuid: SAMPLE_UUID, version: 2 })
    expect(content.version).toBe(2)
  })

  it("throws on an empty uuid", () => {
    expect(() => buildConnectBack({ uuid: "" })).toThrowError()
  })

  it("stamps a claimed tag, lowercased and stripped of a leading @", () => {
    const content = buildConnectBack({ uuid: SAMPLE_UUID, tag: "@Alice" })
    expect(content.tag).toBe("alice")
  })

  it("omits an absent or invalid tag rather than throwing", () => {
    expect(buildConnectBack({ uuid: SAMPLE_UUID }).tag).toBeUndefined()
    expect(buildConnectBack({ uuid: SAMPLE_UUID, tag: "" }).tag).toBeUndefined()
    expect(buildConnectBack({ uuid: SAMPLE_UUID, tag: "-bad" }).tag).toBeUndefined()
  })

  it("throws on an oversized uuid", () => {
    expect(() =>
      buildConnectBack({ uuid: "x".repeat(CONNECT_BACK_UUID_MAX_LEN + 1) }),
    ).toThrowError()
  })
})

describe("ConnectBackCodec.encode / decode", () => {
  it("roundtrips a built payload", () => {
    const content = buildConnectBack({ uuid: SAMPLE_UUID })
    const encoded = CODEC.encode(content)
    expect(encoded.type).toBe(ConnectBackContentTypeId)
    expect(encoded.content).toBeInstanceOf(Uint8Array)
    expect(encoded.fallback).toBeTruthy()

    const decoded = CODEC.decode(encoded)
    expect(decoded).toEqual(content)
    expect(decoded.uuid).toBe(SAMPLE_UUID)
    expect(decoded.version).toBe(CONNECT_BACK_VERSION)
  })

  it("roundtrips a claimed tag and still decodes a tag-less (older) payload", () => {
    const withTag = buildConnectBack({ uuid: SAMPLE_UUID, tag: "bob" })
    expect(CODEC.decode(CODEC.encode(withTag))).toEqual(withTag)

    const encoded = CODEC.encode(validContent())
    const decoded = CODEC.decode(encoded)
    expect(decoded.tag).toBeUndefined()
    expect(decoded.uuid).toBe(SAMPLE_UUID)
  })

  it("strips an unknown field on decode (forward-compat behavior of Zod object schemas)", () => {
    const polluted = { ...validContent(), unknownField: "pollution" }
    const encoded = CODEC.encode(polluted as ConnectBackContent)
    const decoded = CODEC.decode(encoded) as ConnectBackContent & { unknownField?: string }
    expect(decoded.unknownField).toBeUndefined()
  })
})

describe("ConnectBackCodec.encode validation", () => {
  it("rejects an invalid content at encode time rather than silently corrupting", () => {
    expect(() => CODEC.encode(validContent({ uuid: "" }))).toThrowError()
  })

  it("rejects a non-integer version", () => {
    expect(() => CODEC.encode(validContent({ version: 1.5 }))).toThrowError()
  })
})

describe("ConnectBackCodec.decode error paths", () => {
  it("throws CodecDecodeError on malformed JSON bytes", () => {
    expect(() =>
      CODEC.decode({
        type: ConnectBackContentTypeId,
        parameters: {},
        content: new TextEncoder().encode("{not-json"),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })

  it("throws CodecDecodeError when the uuid is missing", () => {
    const incomplete = JSON.stringify({ version: CONNECT_BACK_VERSION })
    expect(() =>
      CODEC.decode({
        type: ConnectBackContentTypeId,
        parameters: {},
        content: new TextEncoder().encode(incomplete),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })

  it("throws CodecDecodeError when the uuid is empty", () => {
    const bad = JSON.stringify({ version: CONNECT_BACK_VERSION, uuid: "" })
    expect(() =>
      CODEC.decode({
        type: ConnectBackContentTypeId,
        parameters: {},
        content: new TextEncoder().encode(bad),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })

  it("throws CodecDecodeError when the uuid exceeds the cap", () => {
    const bad = JSON.stringify({
      version: CONNECT_BACK_VERSION,
      uuid: "x".repeat(CONNECT_BACK_UUID_MAX_LEN + 1),
    })
    expect(() =>
      CODEC.decode({
        type: ConnectBackContentTypeId,
        parameters: {},
        content: new TextEncoder().encode(bad),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })

  it("throws CodecDecodeError when the version is out of range", () => {
    const bad = JSON.stringify({ version: 0, uuid: SAMPLE_UUID })
    expect(() =>
      CODEC.decode({
        type: ConnectBackContentTypeId,
        parameters: {},
        content: new TextEncoder().encode(bad),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })

  it("throws CodecDecodeError when a foreign content-type's payload is fed in", () => {
    // Wrong content type on the wrapper + a body that does not match the
    // connect-back schema → schema validation rejects it.
    const foreign = JSON.stringify({ senderTag: "alice", amount: "1000000" })
    expect(() =>
      CODEC.decode({
        type: AztecPaymentRequestContentTypeId,
        parameters: {},
        content: new TextEncoder().encode(foreign),
        fallback: "x",
      }),
    ).toThrowError(CodecDecodeError)
  })
})

describe("ConnectBackCodec.fallback", () => {
  it("returns a non-empty, identity-free string", () => {
    const fallback = CODEC.fallback(validContent())
    expect(fallback.length).toBeGreaterThan(0)
    // Must not leak the redeemed UUID or any sender identity.
    expect(fallback).not.toContain(SAMPLE_UUID)
  })
})

describe("ConnectBackCodec.shouldPush", () => {
  it("returns true so notification servers trigger APNs delivery", () => {
    expect(CODEC.shouldPush(validContent())).toBe(true)
  })
})

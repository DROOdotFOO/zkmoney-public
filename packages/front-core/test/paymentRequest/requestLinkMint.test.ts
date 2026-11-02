import { describe, expect, it } from "vitest"
import {
  buildRequestShareUrl,
  decodeRequestInline,
  mintRequestLink,
  randomCodeRequestId,
  RequestLinkMintError,
  type MintRequestLinkArgs,
  type PaymentRequest,
} from "../../src/index.js"

const NOW = 1_800_000_000_000
const FIELD_ID = `0x${"0a".repeat(32)}`
const TOKEN_ADDRESS = `0x${"1b".repeat(32)}`
const REQUESTER_ADDRESS = `0x${"2c".repeat(32)}`
const SIPA_ADDRESS = `0x${"3d".repeat(20)}`
const PREIMAGE = { intentHash: `0x${"4e".repeat(32)}`, recovery: `0x${"5f".repeat(32)}` }
const PROD_BASE = "https://wallet.zk.money"
const TEST_BASE = "https://wallet.staging.zk.money"

function args(overrides: Partial<MintRequestLinkArgs> = {}): MintRequestLinkArgs {
  return {
    requestId: FIELD_ID,
    requesterTag: "alice",
    requesterAddress: REQUESTER_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
    tokenDecimals: 18,
    tokenSymbol: "DAI",
    networkId: "0xrollup",
    baseUrl: PROD_BASE,
    amountInput: "12.5",
    noteInput: "lunch",
    durationMs: 7 * 86_400_000,
    now: NOW,
    ...overrides,
  }
}

describe("mintRequestLink", () => {
  it("mints the requester's pay page with a decodable v3 fragment", () => {
    const minted = mintRequestLink(args())
    expect(minted.url).toMatch(/^https:\/\/wallet\.zk\.money\/pay\/alice#/)
    const packet = decodeRequestInline(minted.url.split("#")[1])
    expect(packet).toMatchObject({
      requestId: FIELD_ID,
      requesterTag: "alice",
      requesterAddress: REQUESTER_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
      tokenDecimals: 18,
      tokenSymbol: "DAI",
      note: "lunch",
      networkId: "0xrollup",
      expiresAt: NOW + 7 * 86_400_000,
    })
    expect(packet.amountAtomic).toBe(12_500_000_000_000_000_000n)
    expect(packet.sipaAddress).toBeUndefined()
  })

  it("embeds a SIPA on the v3 fragment when one is supplied", () => {
    const minted = mintRequestLink(args({ sipaAddress: SIPA_ADDRESS }))
    expect(minted.row.sipaAddress).toBe(SIPA_ADDRESS)
    expect(decodeRequestInline(minted.url.split("#")[1]).sipaAddress).toBe(SIPA_ADDRESS)
  })

  it("uses the caller-supplied wallet origin", () => {
    const minted = mintRequestLink(args({ baseUrl: `${TEST_BASE}/` }))
    expect(minted.url).toMatch(/^https:\/\/wallet\.staging\.zk\.money\/pay\/alice#/)
  })

  it("stamps the row with the join key, token, and mint-time identity", () => {
    const { row } = mintRequestLink(args())
    expect(row).toMatchObject({
      id: FIELD_ID,
      contactTag: "",
      kind: "link",
      direction: "outgoing",
      status: "pending",
      amount: 12.5,
      asset: "DAI",
      amountAtomic: "12500000000000000000",
      tokenAddress: TOKEN_ADDRESS,
      tokenDecimals: 18,
      requesterTag: "alice",
      requesterAddress: REQUESTER_ADDRESS,
      networkId: "0xrollup",
      createdAt: NOW,
      expiresAt: NOW + 7 * 86_400_000,
    })
  })

  it("mints an any-amount link from a blank or non-positive amount", () => {
    for (const amountInput of ["  ", "0", "-1"]) {
      const minted = mintRequestLink(args({ amountInput }))
      expect(minted.row.amount).toBe(0)
      expect(minted.row.amountAtomic).toBe("0")
      expect(decodeRequestInline(minted.url.split("#")[1]).amountAtomic).toBe(0n)
    }
  })

  it("unlists a Receive code minted without an amount, and nothing else", () => {
    const code = (amountInput: string) =>
      mintRequestLink(args({ amountInput, compact: true, requestId: randomCodeRequestId() })).row
    expect(code("").unlisted).toBe(true)
    expect(code("5").unlisted).toBeUndefined()
    expect(mintRequestLink(args({ amountInput: "" })).row.unlisted).toBeUndefined()
  })

  it("stores the human amount on the row", () => {
    expect(mintRequestLink(args({ amountInput: "1250" })).row.amount).toBe(1250)
  })

  it("throws RequestLinkMintError on an unparseable non-empty amount", () => {
    expect(() => mintRequestLink(args({ amountInput: "12,3,4" }))).toThrow(RequestLinkMintError)
  })

  it("omits a blank note", () => {
    const minted = mintRequestLink(args({ noteInput: "   " }))
    expect(minted.note).toBeUndefined()
    expect(decodeRequestInline(minted.url.split("#")[1]).note).toBeUndefined()
  })
})

describe("buildRequestShareUrl", () => {
  function storedRow(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
    return {
      ...mintRequestLink(args()).row,
      ...overrides,
    }
  }

  it("rebuilds the original decodable request URL from its persisted row", () => {
    const url = buildRequestShareUrl(storedRow(), "renamed", PROD_BASE)

    expect(url).toMatch(/^https:\/\/wallet\.zk\.money\/pay\/alice#/)
    expect(decodeRequestInline(url!.split("#")[1])).toMatchObject({
      requestId: FIELD_ID,
      requesterTag: "alice",
      requesterAddress: REQUESTER_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
      tokenDecimals: 18,
      tokenSymbol: "DAI",
      amountAtomic: 12_500_000_000_000_000_000n,
      note: "lunch",
      networkId: "0xrollup",
    })
  })

  it("rebuilds a v3 URL that still carries the SIPA and its preimage", () => {
    const row = mintRequestLink(args({ sipaAddress: SIPA_ADDRESS, sipaPreimage: PREIMAGE })).row
    const url = buildRequestShareUrl(storedRow(row), "alice", PROD_BASE)
    expect(decodeRequestInline(url!.split("#")[1])).toMatchObject({
      sipaAddress: SIPA_ADDRESS,
      sipaPreimage: PREIMAGE,
    })
  })

  it("uses the current tag only as a fallback for legacy rows", () => {
    const url = buildRequestShareUrl(storedRow({ requesterTag: undefined }), "current", PROD_BASE)
    expect(url).toMatch(/\/pay\/current#/)
    expect(decodeRequestInline(url!.split("#")[1]).requesterTag).toBe("current")
  })

  it("returns null when the stored row cannot represent a v3 link", () => {
    expect(buildRequestShareUrl(storedRow({ networkId: undefined }), "alice", PROD_BASE)).toBeNull()
    expect(
      buildRequestShareUrl(storedRow({ tokenAddress: undefined }), "alice", PROD_BASE),
    ).toBeNull()
    expect(buildRequestShareUrl(storedRow({ id: "req-legacy" }), "alice", PROD_BASE)).toBeNull()
  })
})

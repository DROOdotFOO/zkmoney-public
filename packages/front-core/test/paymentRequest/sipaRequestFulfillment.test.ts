import { describe, expect, it } from "vitest"
import type { Address, Hash } from "viem"

import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import {
  requestLinkedSipaAddresses,
  sipaDepositFulfillsRequest,
} from "../../src/core/paymentRequest/sipaRequestFulfillment"
import type { StoredRequest } from "../../src/engine/requests"

const SIPA = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address
const OTHER = "0x0000000000000000000000000000000000000001" as Address
const CLAIM = "0x" + "ab".repeat(32)
const SWEEP = ("0x" + "cd".repeat(32)) as Hash
const NET = "1000000000000000000"

function pendingLink(overrides: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id: "req-1",
    contactTag: "",
    amount: 1,
    asset: "DAI",
    direction: "outgoing",
    status: "pending",
    createdAt: 0,
    kind: "link",
    amountAtomic: NET,
    tokenDecimals: 18,
    sipaAddress: SIPA,
    ...overrides,
  }
}

function deposit(overrides: Partial<SIPADepositRecord> = {}): SIPADepositRecord {
  return {
    sipaAddress: SIPA,
    recipientL2Address: "0x1",
    messageSecret: "0x2",
    recipientHash: "0x3",
    recoveryAddress: "0x4",
    l1ChainId: 31337,
    amount: "1",
    tokenSymbol: "DAI",
    phase: "claimed",
    startTime: 1,
    netAmount: NET,
    claimTxHash: CLAIM,
    sweepTxHash: SWEEP,
    ...overrides,
  }
}

describe("sipaDepositFulfillsRequest", () => {
  it("matches a claimed deposit to a pending outgoing row by sipaAddress", () => {
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink())).toBe(true)
  })

  it("matches sipaAddress case-insensitively", () => {
    expect(
      sipaDepositFulfillsRequest(deposit(), pendingLink({ sipaAddress: SIPA.toLowerCase() })),
    ).toBe(true)
  })

  it("rejects broadcast and sweeping — mint already published this SIPA", () => {
    expect(sipaDepositFulfillsRequest(deposit({ phase: "broadcast" }), pendingLink())).toBe(false)
    expect(sipaDepositFulfillsRequest(deposit({ phase: "sweeping" }), pendingLink())).toBe(false)
  })

  it("rejects an underpayment", () => {
    expect(
      sipaDepositFulfillsRequest(deposit({ netAmount: "500000000000000000" }), pendingLink()),
    ).toBe(false)
  })

  it("fulfils an any-amount link on the first claimed deposit", () => {
    expect(
      sipaDepositFulfillsRequest(deposit({ netAmount: "1" }), pendingLink({ amountAtomic: "0" })),
    ).toBe(true)
    expect(
      sipaDepositFulfillsRequest(
        deposit({ netAmount: "1" }),
        pendingLink({ amountAtomic: undefined }),
      ),
    ).toBe(true)
  })

  it("ignores unknown SIPAs and incoming rows", () => {
    expect(sipaDepositFulfillsRequest(deposit({ sipaAddress: OTHER }), pendingLink())).toBe(false)
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink({ direction: "incoming" }))).toBe(
      false,
    )
    expect(sipaDepositFulfillsRequest(deposit(), pendingLink({ sipaAddress: undefined }))).toBe(
      false,
    )
  })
})

describe("requestLinkedSipaAddresses", () => {
  it("collects lowercased addresses, skipping rows without one", () => {
    expect(
      requestLinkedSipaAddresses([
        pendingLink(),
        pendingLink({ sipaAddress: undefined }),
        pendingLink({ sipaAddress: OTHER.toUpperCase() as Address }),
      ]),
    ).toEqual(new Set([SIPA.toLowerCase(), OTHER.toLowerCase()]))
  })
})

import { describe, it, expect } from "vitest"
import type { AztecPaymentRequestContent } from "@obsidion/sdk"

import { RequestReceiver, fulfillmentSatisfiesRequest } from "../../src/xmtp/RequestReceiver"
import type { TokenTransaction } from "../../src/types/transactions"
import type {
  IncomingRequestInput,
  RequestSenderPolicy,
  RequestStoreWrites,
  RequestTagBindingResolver,
  StoredRequestView,
} from "../../src/xmtp/requestReceiverTypes"

class FakeStore implements RequestStoreWrites {
  added: IncomingRequestInput[] = []
  declined: string[] = []
  insertResult = true
  applyResult = true
  throwOnAdd = false
  rows: Record<string, StoredRequestView> = {}

  async findById(requestId: string): Promise<StoredRequestView | null> {
    return this.rows[requestId] ?? null
  }

  async addIncomingRequest(input: IncomingRequestInput): Promise<{ inserted: boolean }> {
    if (this.throwOnAdd) throw new Error("storage down")
    this.added.push(input)
    return { inserted: this.insertResult }
  }

  async decline(requestId: string): Promise<{ applied: boolean }> {
    this.declined.push(requestId)
    return { applied: this.applyResult }
  }
}

const TOKEN = "0x" + "aa".repeat(32)
const TX = "0x" + "ab".repeat(32)

function receiveTx(overrides: Partial<TokenTransaction["token"]> = {}): TokenTransaction {
  return {
    action: "receive",
    status: "success",
    timestamp: 0,
    txHash: TX,
    token: {
      address: TOKEN,
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "",
      amount: 1,
      price: 1,
      ...overrides,
    },
  }
}

const requestContent: AztecPaymentRequestContent = {
  kind: "request",
  requestId: "req-1",
  requesterTag: "alice",
  amountAtomic: "1000000",
  token: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
  tokenSymbol: "DAI",
  decimals: 6,
  networkId: "aztec-sandbox",
}

describe("RequestReceiver", () => {
  it("inserts an incoming request and reports accepted", async () => {
    const store = new FakeStore()
    const result = await new RequestReceiver(store).process({ content: requestContent })
    expect(result).toEqual({ status: "accepted", kind: "request" })
    expect(store.added[0].requesterTag).toBe("alice")
    expect(store.added[0].tokenAddress).toBe(requestContent.token)
  })

  it("reports duplicate when the request already exists", async () => {
    const store = new FakeStore()
    store.insertResult = false
    const result = await new RequestReceiver(store).process({ content: requestContent })
    expect(result).toEqual({ status: "duplicate" })
  })

  it("applies a declined signal", async () => {
    const store = new FakeStore()
    const result = await new RequestReceiver(store).process({
      content: { kind: "request-declined", requestId: "req-1", networkId: "aztec-sandbox" },
    })
    expect(result).toEqual({ status: "accepted", kind: "request-declined" })
    expect(store.declined).toHaveLength(1)
  })

  it("defers on a store-write throw", async () => {
    const store = new FakeStore()
    store.throwOnAdd = true
    const result = await new RequestReceiver(store).process({ content: requestContent })
    expect(result).toEqual({ status: "deferred", reason: "store-write-failure" })
  })

  describe("sender binding check", () => {
    const noopLogger = { warn: () => undefined }

    function bindingOf(map: Record<string, string | null>): RequestTagBindingResolver {
      return { resolveXmtpBinding: async (tag) => map[tag] ?? null }
    }

    it("skips a request whose claimed requesterTag is not bound to the DM peer", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, noopLogger, bindingOf({ alice: "0xalice" }))
      const result = await receiver.process({
        content: requestContent,
        senderXmtpAddresses: ["0xmallory"],
      })
      expect(result).toEqual({ status: "ignored", reason: "sender-binding-mismatch" })
      expect(store.added).toHaveLength(0)
    })

    it("skips a request whose tag has no published binding", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, noopLogger, bindingOf({}))
      const result = await receiver.process({
        content: requestContent,
        senderXmtpAddresses: ["0xmallory"],
      })
      expect(result).toEqual({ status: "ignored", reason: "sender-binding-mismatch" })
      expect(store.added).toHaveLength(0)
    })

    it("skips a request when the DM peer is unresolvable", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, noopLogger, bindingOf({ alice: "0xalice" }))
      const result = await receiver.process({ content: requestContent, senderXmtpAddresses: [] })
      expect(result).toEqual({ status: "ignored", reason: "sender-binding-mismatch" })
      expect(store.added).toHaveLength(0)
    })

    it("accepts a request whose binding matches the peer, case-insensitively", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, noopLogger, bindingOf({ alice: "0xAlice" }))
      const result = await receiver.process({
        content: requestContent,
        senderXmtpAddresses: ["0xALICE"],
      })
      expect(result).toEqual({ status: "accepted", kind: "request" })
      expect(store.added).toHaveLength(1)
    })

    it("defers on a binding-resolver transport failure, never accepts", async () => {
      const store = new FakeStore()
      const binding: RequestTagBindingResolver = {
        resolveXmtpBinding: async () => {
          throw new Error("registry gateway down")
        },
      }
      const receiver = new RequestReceiver(store, noopLogger, binding)
      const result = await receiver.process({
        content: requestContent,
        senderXmtpAddresses: ["0xalice"],
      })
      expect(result).toEqual({ status: "deferred", reason: "binding-resolver-unavailable" })
      expect(store.added).toHaveLength(0)
    })

    it("skips a declined flip from a peer not bound to the row's contactTag", async () => {
      const store = new FakeStore()
      store.rows["req-1"] = { contactTag: "alice", direction: "outgoing" }
      const receiver = new RequestReceiver(store, noopLogger, bindingOf({ alice: "0xalice" }))
      const result = await receiver.process({
        content: { kind: "request-declined", requestId: "req-1", networkId: "aztec-sandbox" },
        senderXmtpAddresses: ["0xmallory"],
      })
      expect(result).toEqual({ status: "ignored", reason: "sender-binding-mismatch" })
      expect(store.declined).toHaveLength(0)
    })

    it("ignores a flip with no matching row without resolving the binding", async () => {
      const store = new FakeStore()
      let resolved = 0
      const binding: RequestTagBindingResolver = {
        resolveXmtpBinding: async () => {
          resolved += 1
          return "0xalice"
        },
      }
      const receiver = new RequestReceiver(store, noopLogger, binding)
      const result = await receiver.process({
        content: { kind: "request-declined", requestId: "unknown", networkId: "aztec-sandbox" },
        senderXmtpAddresses: ["0xalice"],
      })
      expect(result).toEqual({ status: "ignored", reason: "no-matching-request" })
      expect(resolved).toBe(0)
      expect(store.declined).toHaveLength(0)
    })
  })

  describe("sender policy", () => {
    const policyOf = (admitted: string[]): RequestSenderPolicy => ({
      admitsRequester: async (tag) => admitted.includes(tag),
    })

    it("skips a refused requester before the binding is resolved", async () => {
      const store = new FakeStore()
      let resolved = 0
      const binding: RequestTagBindingResolver = {
        resolveXmtpBinding: async () => {
          resolved += 1
          return "0xalice"
        },
      }
      const receiver = new RequestReceiver(store, undefined, binding, policyOf([]))
      const result = await receiver.process({
        content: requestContent,
        senderXmtpAddresses: ["0xalice"],
      })
      expect(result).toEqual({ status: "ignored", reason: "sender-not-admitted" })
      expect(resolved).toBe(0)
      expect(store.added).toHaveLength(0)
    })

    it("stores an admitted requester", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, undefined, undefined, policyOf(["alice"]))
      const result = await receiver.process({ content: requestContent })
      expect(result).toEqual({ status: "accepted", kind: "request" })
      expect(store.added).toHaveLength(1)
    })

    it("admits when the policy throws, so a broken contact read never holds the inbox", async () => {
      const store = new FakeStore()
      const warnings: string[] = []
      const receiver = new RequestReceiver(
        store,
        { warn: (message) => warnings.push(message) },
        undefined,
        {
          admitsRequester: async () => {
            throw new Error("contacts unreadable")
          },
        },
      )
      const result = await receiver.process({ content: requestContent })
      expect(result).toEqual({ status: "accepted", kind: "request" })
      expect(warnings).toHaveLength(1)
    })

    it("does not gate a declined signal", async () => {
      const store = new FakeStore()
      const receiver = new RequestReceiver(store, undefined, undefined, policyOf([]))
      const result = await receiver.process({
        content: { kind: "request-declined", requestId: "req-1", networkId: "aztec-sandbox" },
      })
      expect(result).toEqual({ status: "accepted", kind: "request-declined" })
    })
  })

  describe("fulfillmentSatisfiesRequest", () => {
    const tx = receiveTx()

    it("matches token addresses, skipping the check when the row has none", () => {
      expect(fulfillmentSatisfiesRequest({ amountAtomic: "1000000", tokenDecimals: 6 }, tx)).toBe(
        true,
      )
      expect(
        fulfillmentSatisfiesRequest(
          { amountAtomic: "1000000", tokenDecimals: 6, tokenAddress: "0x" + "11".repeat(32) },
          tx,
        ),
      ).toBe(false)
    })

    it('treats amountAtomic "0" as any-amount', () => {
      expect(fulfillmentSatisfiesRequest({ amountAtomic: "0", tokenDecimals: 6 }, tx)).toBe(true)
    })

    it("falls back to the display amount when atomic fields are absent", () => {
      expect(fulfillmentSatisfiesRequest({ amount: 2 }, tx)).toBe(false)
      expect(fulfillmentSatisfiesRequest({ amount: 1 }, tx)).toBe(true)
    })

    it("tolerates float drift just below the exact-amount boundary", () => {
      expect(
        fulfillmentSatisfiesRequest(
          { amountAtomic: "1000000", tokenDecimals: 6, tokenAddress: TOKEN },
          receiveTx({ amount: 0.9999999999999999 }),
        ),
      ).toBe(true)
    })

    it("compares raw base units when both sides carry them — an inflated display cannot mask dust", () => {
      // A payer asserting decimals:0 makes 1 base unit display as 1.0 whole token.
      const dust: TokenTransaction = { ...receiveTx({ amount: 1, decimals: 0 }), amountAtomic: "1" }
      expect(fulfillmentSatisfiesRequest({ amountAtomic: "1000000", tokenDecimals: 6 }, dust)).toBe(
        false,
      )
      const exact: TokenTransaction = { ...receiveTx(), amountAtomic: "1000000" }
      expect(
        fulfillmentSatisfiesRequest({ amountAtomic: "1000000", tokenDecimals: 6 }, exact),
      ).toBe(true)
    })
  })
})

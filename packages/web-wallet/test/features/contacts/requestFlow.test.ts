import { describe, expect, it, vi } from "vitest"
import {
  createRequests,
  memoryBackend,
  openDatabase,
  memoryStore,
  type StoredRequest,
} from "@obsidion/front-core"
import {
  announceOutgoingRequest,
  declineIncomingRequest,
  newOutgoingRequest,
} from "../../../src/features/contacts/requestFlow"

const memRequests = () =>
  createRequests({
    db: openDatabase(memoryBackend()),
    payments: memoryStore({ rows: [], deposits: [], loaded: true, failed: false }).readonly,
  })

const TOKEN = { address: "0x" + "1".repeat(64), symbol: "DAI", decimals: 9 }

function incomingRow(overrides: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id: "req-1",
    contactTag: "alice",
    amount: 25,
    asset: "DAI",
    direction: "incoming",
    status: "pending",
    createdAt: Date.now(),
    kind: "contact",
    networkId: "testnet",
    ...overrides,
  }
}

describe("newOutgoingRequest", () => {
  it("mints a pending outgoing contact row with exact base units", () => {
    const row = newOutgoingRequest("alice", "25.50", 9)
    expect(row).not.toBeNull()
    expect(row).toMatchObject({
      contactTag: "alice",
      amount: 25.5,
      asset: "DAI",
      direction: "outgoing",
      status: "pending",
      kind: "contact",
      amountAtomic: "25500000000",
      tokenDecimals: 9,
    })
    expect(row!.id).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("keeps a trimmed note and drops a blank one", () => {
    expect(newOutgoingRequest("alice", "1", 9, "  dinner ")!.note).toBe("dinner")
    expect(newOutgoingRequest("alice", "1", 9, "   ")!.note).toBeUndefined()
    expect(newOutgoingRequest("alice", "1", 9)!.note).toBeUndefined()
  })

  it("rejects non-positive and unparseable amounts", () => {
    expect(newOutgoingRequest("alice", "0", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "-3", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "nope", 9)).toBeNull()
    expect(newOutgoingRequest("alice", "", 9)).toBeNull()
  })

  it("rejects sub-cent amounts and keeps exact base units for cents", () => {
    expect(newOutgoingRequest("alice", "0.0000001", 18)).toBeNull()
    expect(newOutgoingRequest("alice", "0.01", 18)!.amountAtomic).toBe("10000000000000000")
  })
})

describe("announceOutgoingRequest", () => {
  const row = { ...incomingRow(), direction: "outgoing" as const, amountAtomic: "25000000000" }

  it("announces over XMTP with the resolved address and requester identity", async () => {
    const announce = vi.fn().mockResolvedValue({ status: "sent", messageId: "m1" })
    const delivered = await announceOutgoingRequest(row, {
      broadcaster: { announce },
      resolveXmtpAddress: async () => "0xabc",
      requesterTag: "bob",
      networkId: "testnet",
      token: TOKEN,
    })
    expect(announce).toHaveBeenCalledWith({
      recipientXmtpAddress: "0xabc",
      requestId: row.id,
      requesterTag: "bob",
      amountAtomic: "25000000000",
      token: TOKEN,
      networkId: "testnet",
      note: undefined,
      expiresAt: undefined,
    })
    expect(delivered).toBe(true)
  })

  it("reports a send the broadcaster did not make as not delivered", async () => {
    const announce = vi.fn().mockResolvedValue({ status: "failed", reason: "offline" })
    const delivered = await announceOutgoingRequest(row, {
      broadcaster: { announce },
      resolveXmtpAddress: async () => "0xabc",
      requesterTag: "bob",
      networkId: "testnet",
      token: TOKEN,
    })
    expect(delivered).toBe(false)
  })

  it("skips silently when the contact has no XMTP binding", async () => {
    const announce = vi.fn()
    const delivered = await announceOutgoingRequest(row, {
      broadcaster: { announce },
      resolveXmtpAddress: async () => null,
      requesterTag: "bob",
      networkId: "testnet",
      token: TOKEN,
    })
    expect(announce).not.toHaveBeenCalled()
    expect(delivered).toBe(false)
  })

  it("never throws — a resolve failure is swallowed (the local row is authoritative)", async () => {
    await expect(
      announceOutgoingRequest(row, {
        broadcaster: { announce: vi.fn() },
        resolveXmtpAddress: async () => {
          throw new Error("registry down")
        },
        requesterTag: "bob",
        networkId: "testnet",
        token: TOKEN,
      }),
    ).resolves.toBe(false)
  })
})

describe("declineIncomingRequest", () => {
  it("flips a pending incoming row to declined and signals the requester", async () => {
    const store = memRequests()
    await store.add(incomingRow())
    const signalDeclined = vi.fn().mockResolvedValue({ status: "sent", messageId: "m1" })
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: { signalDeclined },
      resolveXmtpAddress: async () => "0xabc",
      networkId: "fallback-net",
    })
    expect(applied).toBe(true)
    expect((await store.get("req-1"))!.status).toBe("declined")
    expect(signalDeclined).toHaveBeenCalledWith({
      recipientXmtpAddress: "0xabc",
      requestId: "req-1",
      networkId: "testnet",
    })
  })

  it("re-declining an already-declined row is a no-op", async () => {
    const store = memRequests()
    await store.add(incomingRow({ status: "declined" }))
    const signalDeclined = vi.fn()
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: { signalDeclined },
      resolveXmtpAddress: async () => "0xabc",
      networkId: "testnet",
    })
    expect(applied).toBe(false)
    expect(signalDeclined).not.toHaveBeenCalled()
  })

  it("still declines locally when the XMTP sender is absent or the signal fails", async () => {
    const store = memRequests()
    await store.add(incomingRow())
    const applied = await declineIncomingRequest("req-1", {
      store,
      broadcaster: null,
      resolveXmtpAddress: async () => "0xabc",
      networkId: "testnet",
    })
    expect(applied).toBe(true)
    expect((await store.get("req-1"))!.status).toBe("declined")
  })
})

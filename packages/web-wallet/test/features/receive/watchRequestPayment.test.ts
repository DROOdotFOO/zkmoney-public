/** A Receive code's request read paid: a failed read of its payment is tried again, never dropped. */
import { describe, expect, it, vi } from "vitest"
import {
  createActivity,
  createRequests,
  memoryBackend,
  memoryStore,
  openDatabase,
  type StoredRequest,
  type TokenTransaction,
} from "@obsidion/front-core"
import { watchRequestPayment } from "../../../src/features/receive/useReceiveCode"
import type { ReceiveCode } from "../../../src/features/receive/receiveCode"

const TOKEN = "0x" + "aa".repeat(32)
const TX = "0x" + "ab".repeat(32)
const REQ = "0x" + "0c".repeat(32)

const request: StoredRequest = {
  id: REQ,
  contactTag: "alice",
  amount: 1,
  asset: "DAI",
  direction: "outgoing",
  status: "pending",
  createdAt: 0,
  kind: "contact",
  amountAtomic: "1000000",
  tokenDecimals: 6,
  tokenAddress: TOKEN,
}
const receive: TokenTransaction = {
  id: TX,
  action: "receive",
  status: "success",
  timestamp: 0,
  txHash: TX,
  from: "alice",
  senderL2Address: "0xalice",
  requestId: REQ,
  amountAtomic: 1_000_000n,
  token: { address: TOKEN, name: "DAI", symbol: "DAI", decimals: 6, logo: "", amount: 1, price: 1 },
}

describe("watchRequestPayment", () => {
  it("reads the payment again on the next update after a failed read", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const activity = createActivity({ db })
    await activity.record({ ...receive, networkId: "0xnet" })
    const payments = memoryStore({ rows: [receive], deposits: [], loaded: true, failed: false })
    const requests = createRequests({ db, payments: payments.readonly })
    await requests.add(request)
    const off = requests.view.subscribe(() => {})
    await vi.waitFor(() => expect(requests.view.get()[0]?.status).toBe("fulfilled"))

    backend.failing = { reads: true }
    const onPaid = vi.fn()
    const stop = watchRequestPayment({ requestId: REQ } as ReceiveCode, {
      requests,
      activity,
      contacts: () => [],
      onPaid,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onPaid).not.toHaveBeenCalled()

    backend.failing = {}
    payments.set({ rows: [receive], deposits: [], loaded: true, failed: false })
    await vi.waitFor(() =>
      expect(onPaid).toHaveBeenCalledWith(expect.objectContaining({ via: "private", amount: 1 })),
    )
    expect(onPaid).toHaveBeenCalledOnce()
    stop()
    off()
  })
})

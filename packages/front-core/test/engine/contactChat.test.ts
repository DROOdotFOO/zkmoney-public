import { describe, expect, it } from "vitest"
import { QueueStatus } from "@obsidion/core/constants"
import type { Hex } from "viem"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import { selectFeed, type FeedSources } from "../../src/engine/activityFeed"
import { sameChat, selectContactChat } from "../../src/engine/contactChat"
import { memoryStore, derived } from "../../src/engine/store"
import { resolveRequests, type StoredRequest } from "../../src/engine/requests"
import type { Transaction } from "../../src/types/transactions"
import type { ContactRow } from "../../src/hooks/useContactsDirectory"

const NOW = 1_800_000_000_000
const E18 = 10n ** 18n
const ADA = "0xada"
const WALLET = "0x00000000000000000000000000000000000000aa"
const token = {
  address: "0xt",
  name: "DAI",
  symbol: "DAI",
  decimals: 18,
  logo: "",
  amount: 0,
  price: 1,
}

const tx = (over: Partial<Transaction> & { action: string }): Transaction =>
  ({
    id: "op",
    token,
    amountAtomic: 5n * E18,
    timestamp: 1,
    status: "success",
    ...over,
  } as Transaction)

const request = (over: Partial<StoredRequest>): StoredRequest => ({
  id: "req",
  contactTag: "ada",
  amount: 10,
  asset: "DAI",
  direction: "outgoing",
  status: "pending",
  createdAt: 10,
  kind: "contact",
  ...over,
})

function feedAt(
  sources: {
    rows?: Transaction[]
    deposits?: SIPADepositRecord[]
    withdrawals?: WithdrawalRecord[]
    contacts?: ContactRow[]
  },
  requests: ReturnType<typeof resolveRequests>,
  now: number,
) {
  return selectFeed(
    {
      rows: { records: sources.rows ?? [], loaded: true, failed: false },
      requests,
      deposits: { records: sources.deposits ?? [], hydrated: true },
      withdrawals: { records: sources.withdrawals ?? [], hydrated: true },
      upgrades: { items: [], recipients: new Set(), loaded: true },
      moves: { records: [], hydrated: true },
      oldVersionWithdrawals: [],
      processing: new Map(),
      refunding: new Set(),
      catchingUp: false,
      now,
    } satisfies FeedSources,
    {
      contacts: { rows: sources.contacts ?? [], hydrated: true, failed: false },
      registrations: { records: [] },
    },
  )
}

function chat(
  sources: {
    rows?: Transaction[]
    deposits?: SIPADepositRecord[]
    withdrawals?: WithdrawalRecord[]
  },
  stored: StoredRequest[],
  contact: Parameters<typeof selectContactChat>[2],
) {
  const requests = resolveRequests(stored, {
    rows: sources.rows ?? [],
    deposits: sources.deposits ?? [],
  })
  const feed = feedAt(sources, requests, NOW)
  return selectContactChat(feed, requests, contact, NOW).map((m) => [m.id, m.role, m.status])
}

describe("selectContactChat", () => {
  const ada = { tag: "ada", address: ADA, addressKind: "aztec-l2" as const }

  it("lists the transfers with the contact and the requests exchanged, oldest first", () => {
    const rows = [
      tx({ action: "send", to: ADA, txHash: "0xs", timestamp: 3 }),
      tx({ action: "receive", senderL2Address: ADA, from: "ada", txHash: "0xr", timestamp: 2 }),
      tx({ action: "send", to: "0xbob", txHash: "0xb", timestamp: 4 }),
      tx({ action: "send", to: ADA, txHash: "", id: "op9", status: "pending", timestamp: 5 }),
      tx({
        action: "send",
        to: ADA,
        txHash: "",
        status: "failed",
        detailedStatus: QueueStatus.CANCELLED,
        timestamp: 6,
      }),
    ]
    const requests = [
      request({ id: "out", createdAt: 1 }),
      request({ id: "declined", status: "declined", createdAt: 7 }),
      request({ id: "expired", expiresAt: NOW - 1, createdAt: 8 }),
      request({ id: "owed", direction: "incoming", createdAt: 9 }),
    ]
    expect(chat({ rows }, requests, ada)).toEqual([
      ["out", "request-out", undefined],
      ["0xr", "received-confirmed", undefined],
      ["0xs", "sent-confirmed", undefined],
      ["op9", "sent-proving", "proving"],
      ["declined", "request-declined", undefined],
      ["owed", "request-in", undefined],
    ])
  })

  it("matches transfers to a retired address of the contact", () => {
    const upgraded = { ...ada, address: "0xnew", retiredAddresses: [ADA] }
    const rows = [
      tx({ action: "send", to: ADA, txHash: "0xold", timestamp: 2 }),
      tx({ action: "send", to: "0xnew", txHash: "0xnew", timestamp: 3 }),
    ]
    expect(chat({ rows }, [], upgraded).map(([id]) => id)).toEqual(["0xold", "0xnew"])
  })

  it("matches a retired rollup's transfers by the contact's tag", () => {
    const upgraded = { ...ada, address: "0xnew" }
    const rows = [
      tx({ action: "send", to: "0xold", toTag: "Ada", txHash: "0xs", timestamp: 2 }),
      tx({ action: "receive", from: "ada", senderL2Address: "0xold", txHash: "0xr", timestamp: 3 }),
      tx({ action: "send", to: "0xold", toTag: "bob", txHash: "0xb", timestamp: 4 }),
    ]
    expect(chat({ rows }, [], upgraded).map(([id]) => id)).toEqual(["0xs", "0xr"])
  })

  it("shows a paid request as its payment, and a paid incoming one as paid", () => {
    const rows = [
      tx({
        action: "receive",
        from: "ada",
        senderL2Address: ADA,
        txHash: "0xpay",
        requestId: "out",
        amountAtomic: 10n * E18,
      } as never),
      tx({ action: "send", to: ADA, txHash: "0xmine", requestId: "owed", timestamp: 3 } as never),
    ]
    const requests = [
      request({ id: "out", amountAtomic: (10n * E18).toString(), tokenDecimals: 18 }),
      request({ id: "owed", direction: "incoming", createdAt: 2 }),
    ]
    expect(chat({ rows }, requests, ada)).toEqual([
      ["0xpay", "received-confirmed", undefined],
      ["owed", "request-paid", undefined],
      ["0xmine", "sent-confirmed", undefined],
    ])
  })

  it("shows an Ethereum wallet's deposits and its fresh-address withdrawal as one bubble", () => {
    const groupId = `0x${"9a".repeat(32)}` as Hex
    const burn = (over: Partial<WithdrawalRecord>) =>
      ({
        recipient: WALLET,
        amount: "3.5",
        tokenSymbol: "DAI",
        startTime: 4,
        groupId,
        ...over,
      } as WithdrawalRecord)
    const deposits = [
      {
        sipaAddress: "0x1",
        walletAddress: WALLET,
        phase: "recoverable",
        amount: "20",
        startTime: 2,
      },
      { sipaAddress: "0x2", walletAddress: WALLET, phase: "resolved", amount: "0", startTime: 3 },
    ] as SIPADepositRecord[]
    const withdrawals = [
      burn({ localId: "gas", groupLeg: "gas", phase: "done" }),
      burn({ localId: "funds", groupLeg: "funds", phase: "failed" }),
    ]
    expect(
      chat({ deposits, withdrawals }, [], {
        tag: "w",
        address: WALLET,
        addressKind: "ethereum-l1",
      }),
    ).toEqual([
      ["0x1", "received-pending", "needsRecovery"],
      [groupId, "sent-failed", "failed"],
    ])
  })

  it("shows a deposit credit in its own token's decimals", () => {
    const USDC = "0x0000000000000000000000000000000000000c0c"
    const deposits = [
      {
        sipaAddress: "0x1",
        walletAddress: WALLET,
        phase: "claimed",
        amount: "20",
        netAmount: String(20n * E18),
        fee: "0",
        startTime: 2,
        sweeps: [
          {
            inboxIndex: "1",
            sweepTxHash: "0xs",
            tokenAddress: USDC,
            tokenDecimals: 6,
            netAmount: "5000000",
            fee: "0",
          },
        ],
      },
      // A swap into the row token: its amounts are the row token's, not the funding token's.
      {
        sipaAddress: "0x2",
        walletAddress: WALLET,
        phase: "claimed",
        amount: "3",
        netAmount: String(3n * E18),
        fee: "0",
        tokenAddress: USDC,
        rowToken: "0x0000000000000000000000000000000000000da1",
        tokenDecimals: 6,
        startTime: 3,
      },
    ] as SIPADepositRecord[]
    const requests = resolveRequests([], { rows: [], deposits })
    const feed = feedAt({ deposits }, requests, NOW)
    const amounts = selectContactChat(feed, requests, {
      tag: "w",
      address: WALLET,
      addressKind: "ethereum-l1",
    }).map((m) => m.amount)
    expect(amounts).toContainEqual({ money: { atomic: 5_000_000n, decimals: 6 }, sign: "+" })
    expect(amounts).toContainEqual({ money: { atomic: 20n * E18, decimals: 18 }, sign: "+" })
    expect(amounts).toContainEqual({ money: { atomic: 3n * E18, decimals: 18 }, sign: "+" })
  })
})

describe("sameChat", () => {
  const ada = { tag: "ada", address: ADA, addressKind: "aztec-l2" as const }
  const rows = [
    tx({ action: "receive", senderL2Address: ADA, from: "ada", txHash: "0xr", timestamp: 2 }),
  ]

  function chatStore(stored: StoredRequest[]) {
    const requests = resolveRequests(stored, { rows, deposits: [] })
    const clock = memoryStore(NOW)
    const messages = derived(
      [clock],
      (now) => selectContactChat(feedAt({ rows }, requests, now), requests, ada, now),
      sameChat,
    )
    return { clock, messages }
  }

  it("keeps the chat's reference across a clock tick that changes nothing", () => {
    const { clock, messages } = chatStore([request({ expiresAt: NOW + 60_000 })])
    const before = messages.get()
    clock.set(NOW + 30_000)
    expect(messages.get()).toBe(before)
  })

  it("gives a new chat when the contact is renamed, so its details show the new name", () => {
    const contact = (name: string): ContactRow => ({ id: "c", name, ...ada })
    const at = (name: string) =>
      selectContactChat(feedAt({ rows, contacts: [contact(name)] }, [], NOW), [], ada, NOW)
    expect(sameChat(at("Ada"), at("Ada L"))).toBe(false)
  })

  it("gives a new chat when a tick expires a request", () => {
    const { clock, messages } = chatStore([request({ expiresAt: NOW + 10_000 })])
    const before = messages.get()
    clock.set(NOW + 30_000)
    expect(messages.get()).not.toBe(before)
    expect(messages.get().map((m) => m.id)).toEqual(["0xr"])
  })
})

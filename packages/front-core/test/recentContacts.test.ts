import { describe, expect, it } from "vitest"
import { PaylinkActionEnum, QueueStatus } from "@obsidion/core/constants"
import { recentContacts, type ContactActivitySources } from "../src/utils/recentContacts"
import type { ContactRow } from "../src/hooks/useContactsDirectory"
import type { PaylinkTransaction, TokenTransaction } from "../src/types/transactions"
import type { PaymentRequest } from "../src/engine/requests"
import type { WithdrawalRecord } from "../src/core/services/bridge/types"

const row = (tag: string, overrides: Partial<ContactRow> = {}): ContactRow => ({
  id: tag,
  tag,
  name: tag,
  address: `0x${tag}`,
  addressKind: "aztec-l2",
  ...overrides,
})
const tx = (
  to: string,
  timestamp: number,
  overrides: Partial<TokenTransaction> = {},
): TokenTransaction => ({
  action: "send",
  to,
  timestamp,
  status: "success",
  txHash: `tx-${timestamp}`,
  token: { address: "0xtoken", amount: 1, symbol: "DAI" } as TokenTransaction["token"],
  ...overrides,
})
const request = (
  contactTag: string,
  createdAt: number,
  overrides: Partial<PaymentRequest> = {},
): PaymentRequest => ({
  id: `request-${createdAt}`,
  contactTag,
  createdAt,
  direction: "outgoing",
  status: "pending",
  amount: 1,
  asset: "DAI",
  ...overrides,
})
const ids = (rows: ContactRow[]) => rows.map((r) => r.id)

describe("recentContacts", () => {
  it("has no arbitrary directory fallback and does not mutate its inputs", () => {
    const contacts = Object.freeze([row("bob"), row("alice")])
    expect(recentContacts(contacts, {})).toEqual([])
    const transactions = Object.freeze([tx("0xalice", 20), tx("0xbob", 10)])
    expect(ids(recentContacts(contacts, { transactions }))).toEqual(["alice", "bob"])
    expect(ids([...contacts])).toEqual(["bob", "alice"])
    expect(transactions[0].timestamp).toBe(20)
  })

  it("merges sends, receives and requests by their recorded interaction time", () => {
    const contacts = [row("alice"), row("bob"), row("carol"), row("dana")]
    expect(
      ids(
        recentContacts(contacts, {
          transactions: [
            tx("0xALICE", 10),
            tx("self", 30, { action: "receive", from: "@BOB.zk.money" }),
            tx("self", 40, { action: "receive", from: "bob", senderL2Address: "0xCAROL" }),
          ],
          requests: [request("@Dana.zk.money", 50)],
        }),
      ),
    ).toEqual(["dana", "carol", "bob"])
  })

  it("uses the canonical receive sender rather than a conflicting display tag", () => {
    expect(
      ids(
        recentContacts([row("alice"), row("bob")], {
          transactions: [
            tx("self", 20, { action: "receive", from: "bob", senderL2Address: "0xalice" }),
          ],
        }),
      ),
    ).toEqual(["alice"])
  })

  it("ignores unknown recipients, cancelled local work, link requests and invalid timestamps", () => {
    const contacts = [row("alice")]
    expect(
      recentContacts(contacts, {
        transactions: [
          tx("0xunknown", 99),
          tx("0xalice", NaN),
          tx("0xalice", -1),
          tx("0xalice", 90, { detailedStatus: QueueStatus.CANCELLED, txHash: "" }),
        ],
        requests: [
          request("alice", 50, { status: "cancelled" }),
          request("alice", 60, { kind: "link" }),
        ],
      }),
    ).toEqual([])
    expect(
      ids(
        recentContacts(contacts, {
          transactions: [tx("0xalice", 20, { detailedStatus: QueueStatus.CANCELLED })],
        }),
      ),
    ).toEqual(["alice"])
  })

  it.each([PaylinkActionEnum.PAY, PaylinkActionEnum.CLAIM])(
    "ignores %s rows before and after their transaction hash arrives",
    (action) => {
      const contacts = [row("alice"), row("bob")]
      const pending: PaylinkTransaction = {
        action,
        emailPaymentAction: action,
        flavor: "direct",
        from: "0xalice",
        to: "0xalice",
        timestamp: 30,
        status: "pending",
        txHash: "",
        detailedStatus: QueueStatus.PROVING,
        kind: action === PaylinkActionEnum.PAY ? "paylink-create" : "paylink-claim",
        token: {
          address: "0xtoken",
          name: "DAI",
          symbol: "DAI",
          decimals: 18,
          logo: "",
          amount: 1,
          price: 1,
        },
      }
      const settled: PaylinkTransaction = {
        ...pending,
        txHash: "0x" + "12".repeat(32),
        status: "success",
        detailedStatus: QueueStatus.SUCCESS,
      }
      for (const paylink of [pending, settled]) {
        expect(ids(recentContacts(contacts, { transactions: [tx("0xbob", 10), paylink] }))).toEqual([
          "bob",
        ])
      }
    },
  )

  it("keeps address kinds and L1 provider identities separate", () => {
    const contacts = [
      row("l2", { address: "0xabc" }),
      row("rainbow", { address: "0xabc", addressKind: "ethereum-l1", provider: "rainbow" }),
      row("metamask", { address: "0xabc", addressKind: "ethereum-l1", provider: "metamask" }),
    ]
    const sources = {
      withdrawals: [{ recipient: "0xABC", walletProvider: "rainbow", startTime: 25, endTime: 99 }],
    } as ContactActivitySources
    expect(ids(recentContacts(contacts, sources))).toEqual(["rainbow"])
    expect(ids(recentContacts(contacts, { transactions: [tx("0xabc", 10)] }))).toEqual(["l2"])
  })

  it.each([undefined, "", "unknown", "manual"])(
    "matches generic bridge provider %s to a saved known provider",
    (provider) => {
      const contact = row("rainbow", {
        address: "0xabc",
        addressKind: "ethereum-l1",
        provider: "rainbow",
      })
      const sources = {
        withdrawals: [{ recipient: "0xABC", walletProvider: provider, startTime: 25 }],
      } as ContactActivitySources
      expect(ids(recentContacts([contact], sources))).toEqual(["rainbow"])
    },
  )

  it("matches a known bridge provider to a generic saved wallet", () => {
    const contact = row("manual", {
      address: "0xabc",
      addressKind: "ethereum-l1",
      provider: "manual",
    })
    const sources = {
      sipaDeposits: [
        {
          walletAddress: "0xABC",
          walletProvider: "rainbow",
          startTime: 25,
          phase: "funded",
          amount: "1",
        },
      ],
    } as ContactActivitySources
    expect(ids(recentContacts([contact], sources))).toEqual(["manual"])
  })

  it("ignores unfunded deposit addresses and matches funded deposits by sender and provider", () => {
    const contacts = [row("unknown", { address: "0xabc", addressKind: "ethereum-l1" })]
    const deposit = {
      walletAddress: "0xABC",
      startTime: 10,
      amount: "0",
      phase: "resolved",
    } as NonNullable<ContactActivitySources["sipaDeposits"]>[number]
    expect(recentContacts(contacts, { sipaDeposits: [deposit] })).toEqual([])
    expect(
      ids(recentContacts(contacts, { sipaDeposits: [{ ...deposit, phase: "funded" }] })),
    ).toEqual(["unknown"])
  })

  it("deduplicates, sorts ties by ID and uses start times rather than completion times", () => {
    const a = row("a"),
      b = row("b"),
      c = row("c", { address: "0xccc", addressKind: "ethereum-l1" })
    const sources = {
      transactions: [tx("0xa", 20), tx("0xb", 20), tx("0xa", 10)],
      withdrawals: [{ recipient: "0xccc", startTime: 15, endTime: 100 }],
    } as ContactActivitySources
    expect(ids(recentContacts([b, a, c, a], sources))).toEqual(["a", "b", "c"])
    expect(ids(recentContacts([b, a, c], sources, 1))).toEqual(["a"])
    expect(recentContacts([a], sources, 0)).toEqual([])
  })

  describe("withdrawal cancellation", () => {
    const withdrawal = (overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
      localId: "withdrawal",
      recipient: "0xabc",
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "done",
      startTime: 10,
      ...overrides,
    })
    const earlier = row("earlier", { address: "0xabc", addressKind: "ethereum-l1" })
    const completed = row("completed", { address: "0xdef", addressKind: "ethereum-l1" })
    const aborted = row("aborted", { address: "0x123", addressKind: "ethereum-l1" })

    it.each([
      { cancelReason: "before-signing", l2TxHash: undefined },
      { cancelReason: "before-signing", l2TxHash: "0x1234" },
    ] satisfies Pick<WithdrawalRecord, "cancelReason" | "l2TxHash">[])(
      "ignores $cancelReason withdrawals without displacing earlier activity",
      (cancellation) => {
        const cancelled = withdrawal({ phase: "failed", startTime: 30, ...cancellation })
        expect(recentContacts([earlier], { withdrawals: [cancelled] })).toEqual([])
        expect(
          ids(
            recentContacts(
              [earlier, completed, aborted],
              {
                withdrawals: [
                  withdrawal(),
                  withdrawal({ localId: "completed", recipient: "0xdef", startTime: 20 }),
                  { ...cancelled, localId: "cancelled" },
                  { ...cancelled, localId: "aborted", recipient: "0x123", startTime: 40 },
                ],
              },
              2,
            ),
          ),
        ).toEqual(["completed", "earlier"])
      },
    )

    it.each(["submitting", "done", "failed"] as const)(
      "retains %s withdrawals without a cancellation reason",
      (phase) => {
        const record = withdrawal({ phase, error: phase === "failed" ? "Cancelled" : undefined })
        expect(ids(recentContacts([earlier], { withdrawals: [record] }))).toEqual(["earlier"])
      },
    )
  })
})

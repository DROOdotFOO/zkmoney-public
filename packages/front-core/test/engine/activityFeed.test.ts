import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import type { UpgradeBatchItem } from "../../src/core/migration/upgradeActivity"
import type { OldVersionWithdrawal } from "../../src/core/migration/OldVersionWithdrawalStorage"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { ContactRow } from "../../src/hooks/useContactsDirectory"
import {
  selectActivity,
  selectFeed,
  selectHome,
  selectRequests,
  type FeedContext,
  type FeedItem,
  type FeedSources,
} from "../../src/engine/activityFeed"
import { depositDetailId, depositDetailItem } from "../../src/engine/feedRules"
import { resolveRequests, type PaymentRequest } from "../../src/engine/requests"
import type { Transaction } from "../../src/types/transactions"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const E18 = 10n ** 18n
const addr = (byte: string) => `0x${byte.repeat(20)}`
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
    id: over.txHash ?? "op",
    token,
    amountAtomic: 5n * E18,
    timestamp: NOW - HOUR,
    status: "success",
    txHash: "0xaa",
    ...over,
  } as Transaction)

const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  id: "req",
  contactTag: "ada",
  amount: 10,
  amountAtomic: (10n * E18).toString(),
  tokenDecimals: 18,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: NOW - 2 * HOUR,
  kind: "contact",
  ...over,
})

const deposit = (over: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: addr("d1"),
    phase: "claimed",
    amount: "20",
    netAmount: (20n * E18).toString(),
    fee: "0",
    startTime: NOW - 3 * HOUR,
    ...over,
  } as SIPADepositRecord)

const burn = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord =>
  ({
    localId: "w1",
    recipient: addr("e1"),
    amount: "7",
    tokenSymbol: "DAI",
    phase: "done",
    startTime: NOW - 4 * HOUR,
    endTime: NOW - 4 * HOUR,
    ...over,
  } as WithdrawalRecord)

const ada: ContactRow = {
  id: "ada",
  name: "Ada",
  tag: "ada",
  address: "0xada",
  addressKind: "aztec-l2",
}

function feedOf(
  over: Partial<{
    rows: Transaction[]
    requests: PaymentRequest[]
    deposits: SIPADepositRecord[]
    withdrawals: WithdrawalRecord[]
    upgrades: UpgradeBatchItem[]
    upgradesLoaded: boolean
    oldVersionWithdrawals: OldVersionWithdrawal[]
    catchingUp: boolean
  }> = {},
  ctx: Partial<FeedContext> = {},
) {
  const sources: FeedSources = {
    rows: { records: over.rows ?? [], loaded: true, failed: false },
    requests: over.requests ?? [],
    deposits: { records: over.deposits ?? [], hydrated: true },
    withdrawals: { records: over.withdrawals ?? [], hydrated: true },
    upgrades: {
      items: over.upgrades ?? [],
      recipients: new Set((over.upgrades ?? []).map((b) => b.recipient.toLowerCase())),
      loaded: over.upgradesLoaded ?? true,
    },
    moves: { records: [], hydrated: true },
    oldVersionWithdrawals: over.oldVersionWithdrawals ?? [],
    processing: new Map(),
    refunding: new Set(),
    catchingUp: over.catchingUp ?? false,
    now: NOW,
  }
  return selectFeed(sources, {
    contacts: { rows: [ada], hydrated: true, failed: false },
    registrations: { records: [] },
    ...ctx,
  })
}

const kinds = (items: readonly FeedItem[]) => items.map((i) => `${i.kind}:${i.id}`)

describe("selectFeed", () => {
  it("merges every source newest first, keeping the merge order on a tie", () => {
    const feed = feedOf({
      rows: [tx({ action: "send", txHash: "0xs", timestamp: NOW - 2 * HOUR })],
      requests: [request()],
      deposits: [deposit()],
      withdrawals: [burn()],
    })
    expect(kinds(feed.items)).toEqual([
      "request:req",
      "tx:0xs",
      "deposit:" + addr("d1"),
      "withdrawal:w1",
    ])
  })

  it("reads direction and pending from the records", () => {
    const items = feedOf({
      rows: [
        tx({ action: "send", txHash: "", id: "op1", status: "pending" }),
        tx({ action: "receive", txHash: "0xr" }),
        tx({ action: "Pay To Email", txHash: "0xp", untilClaimable: NOW / 1000 + 60 } as never),
        tx({ action: "Pay To Email", txHash: "0xq", isClaimed: true } as never),
      ],
    }).items
    const by = Object.fromEntries(items.map((i) => [i.id, [i.direction, i.pending]]))
    expect(by).toEqual({
      "op1": ["out", true],
      "0xr": ["in", false],
      // An unclaimed link is funds that left and have not arrived.
      "0xp": ["out", true],
      "0xq": ["out", false],
    })
  })

  it("lists one row for a link's round trip, and the paid link for the receive that paid it", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      status: "fulfilled",
      fulfillmentTxHash: "0xpaid",
    })
    const items = feedOf({
      rows: [
        tx({ action: "receive", txHash: "0xpaid" }),
        tx({ action: "Claim Back From Email", txHash: "0xback" }),
      ],
      requests: [link],
    }).items
    expect(kinds(items)).toEqual(["paidLink:link"])
    expect(items[0]).toMatchObject({ amount: { atomic: 5n * E18, decimals: 18 } })
  })

  it("dates an L2-paid link at its payment, which can land long after the ask", () => {
    const link = request({
      id: "link",
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      status: "fulfilled",
      createdAt: NOW - 3 * HOUR,
      fulfillmentTxHash: "0xpaid",
    })
    const rows = [tx({ action: "receive", txHash: "0xpaid", timestamp: NOW })]
    const [item] = feedOf({ rows, requests: [link] }).items
    expect(item.ts).toBe(NOW)
  })

  it("shows a link paid before payments were read as its Paid row, with no evidence left", () => {
    const paid = { ...request({ id: "link", direction: "outgoing", kind: "link", contactTag: "" }) }
    const requests = resolveRequests([{ ...paid, status: "paid" }], { rows: [], deposits: [] })
    expect(kinds(feedOf({ requests }).items)).toEqual(["paidLink:link"])
  })

  it("names the contact a send to a retired address carries by tag", () => {
    const feed = feedOf({
      rows: [tx({ action: "send", to: "0xold", toTag: "ada", txHash: "0xs" })],
    })
    expect(feed.items[0]).toMatchObject({ kind: "tx", contact: ada })
  })

  it("shows only open requests a contact made, unexpired and never listed codes", () => {
    const items = feedOf({
      requests: [
        request({ id: "open" }),
        request({ id: "stranger", contactTag: "kai" }),
        request({ id: "expired", expiresAt: NOW - 1 }),
        request({
          id: "code",
          direction: "outgoing",
          kind: "link",
          contactTag: "",
          unlisted: true,
        }),
        request({ id: "paid", status: "fulfilled" }),
      ],
    }).items
    expect(kinds(items)).toEqual(["request:open"])
    expect(items[0]).toMatchObject({ role: "incoming", direction: "out", contact: ada })
  })

  it("hides incoming requests until the contacts are read", () => {
    const feed = feedOf(
      { requests: [request(), request({ id: "mine", direction: "outgoing" })] },
      { contacts: { rows: [], hydrated: false, failed: true } },
    )
    expect(kinds(feed.items)).toEqual(["request:mine"])
    expect(feed.requestsUnavailable).toBe(true)
  })

  it("says a link's payment is detected before its claim pays it", () => {
    const link = request({
      direction: "outgoing",
      kind: "link",
      contactTag: "",
      sipaAddress: addr("d1"),
    })
    const [item] = feedOf({ requests: [link], deposits: [deposit({ phase: "sweeping" })] }).items
    expect(item).toMatchObject({ kind: "request", role: "outgoingLink", detected: true })
  })

  it("hides the deposit behind a request link, an upgrade, its own burn, or no funds at all", () => {
    const linked = deposit({ sipaAddress: addr("01") })
    const upgrade = deposit({ sipaAddress: addr("02") })
    const own = deposit({ sipaAddress: addr("03"), phase: "pendingClaim" })
    const empty = deposit({
      sipaAddress: addr("04"),
      phase: "broadcast",
      amount: "0",
      netAmount: undefined,
    })
    const feed = feedOf({
      requests: [request({ direction: "outgoing", kind: "link", sipaAddress: addr("01") })],
      deposits: [linked, upgrade, own, empty],
      withdrawals: [burn({ recipient: addr("03"), intent: "registration", phase: "l2_mined" })],
      upgrades: [
        {
          run: "r",
          id: "first",
          first: true,
          recipient: addr("02"),
          amount: "1",
          exitFee: "0",
          state: "planned",
          approved: true,
          startTime: NOW,
        },
      ],
    })
    expect(feed.items.filter((i) => i.kind === "deposit")).toEqual([])
  })

  it("dates a migration's arrival just above its exit, pending while unfunded", () => {
    const exit = burn({
      intent: "migration",
      recipient: addr("0a"),
      phase: "done",
      endTime: NOW - HOUR,
    })
    const arrival = deposit({
      sipaAddress: addr("0a"),
      phase: "broadcast",
      amount: "0",
      netAmount: undefined,
      startTime: NOW - 9 * HOUR,
    })
    const item = feedOf({ deposits: [arrival], withdrawals: [exit] }).items.find(
      (i) => i.kind === "deposit",
    )
    expect(item).toMatchObject({ intent: "migration", ts: NOW - HOUR + 1, arriving: {} })
    const failed = feedOf({ deposits: [arrival], withdrawals: [{ ...exit, phase: "failed" }] })
    expect(failed.items.some((i) => i.kind === "deposit")).toBe(false)
  })

  it("shows a fresh-address withdrawal as one row over its legs", () => {
    const groupId = `0x${"9a".repeat(32)}` as Hex
    const feed = feedOf({
      withdrawals: [
        burn({ localId: "gas", groupId, groupLeg: "gas" }),
        burn({ localId: "funds", groupId, groupLeg: "funds", phase: "finalizing_l1" }),
      ],
    })
    expect(kinds(feed.items)).toEqual([`withdrawalGroup:${groupId}`])
    expect(feed.items[0]).toMatchObject({ pending: true, direction: "out", unsent: false })
  })

  it("files a registration's tag price as its own row, under the claimed deposit", () => {
    const record = deposit({ registrationFee: (3n * E18).toString() } as never)
    const feed = feedOf(
      { deposits: [record] },
      {
        registrations: {
          records: [{ sipaAddress: record.sipaAddress, tag: "ada", phase: "confirmed" } as never],
        },
      },
    )
    const [row, tag] = feed.items
    expect(row).toMatchObject({ kind: "deposit", intent: "registration", tag: "ada" })
    expect(tag).toMatchObject({ kind: "tagPurchase", ts: row.ts - 1, direction: "out" })
  })

  it("keeps the registration row unless a burn from this wallet paid it", () => {
    const registration = { sipaAddress: addr("0b"), ts: NOW }
    expect(kinds(feedOf({}, { registration }).items)).toEqual(["registration:registration-deposit"])
    const paid = feedOf(
      { withdrawals: [burn({ intent: "registration", recipient: addr("0b") })] },
      { registration },
    )
    expect(paid.items.some((i) => i.kind === "registration")).toBe(false)
  })

  it("files a SIPA the account pays itself as a migration arrival", () => {
    const [item] = feedOf({ deposits: [deposit({ intent: "user-op" })] }).items
    expect(item).toMatchObject({ kind: "deposit", intent: "migration" })
  })

  it("splits another token an address credited into a row of its own, with no tag purchase", () => {
    const record = deposit({
      tokenAddress: addr("a1"),
      registrationFee: (3n * E18).toString(),
      sweeps: [
        { tokenAddress: addr("b2"), netAmount: "4000000", tokenDecimals: 6, inboxIndex: "7" },
      ],
    } as never)
    const feed = feedOf(
      { deposits: [record] },
      {
        registrations: {
          records: [{ sipaAddress: record.sipaAddress, tag: "ada", phase: "confirmed" } as never],
        },
      },
    )
    const ids = kinds(feed.items)
    expect(ids).toContain(`deposit:${record.sipaAddress}:${addr("b2")}`)
    expect(ids.filter((id) => id.startsWith("tagPurchase:"))).toHaveLength(1)
    const credit = feed.items.find((i) => i.id.endsWith(addr("b2")))
    expect(credit).toMatchObject({ credit: addr("b2"), record: { phase: "claimed" } })
  })

  it("opens each credited token's row on that token's detail, and keeps it when its token turns latest", () => {
    const DAI = addr("da")
    const SUSDS = addr("5d")
    const sweep = (inboxIndex: string, tokenAddress: string, tokenSymbol: string, net: bigint) => ({
      inboxIndex,
      sweepTxHash: `0x${inboxIndex.repeat(64)}`,
      netAmount: net.toString(),
      tokenAddress,
      tokenSymbol,
      tokenDecimals: 18,
    })
    const twice = deposit({
      tokenAddress: SUSDS,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      amount: "2",
      netAmount: (2n * E18).toString(),
      inboxIndex: "8",
      sweeps: [sweep("7", DAI, "DAI", 5n * E18), sweep("8", SUSDS, "sUSDS", 2n * E18)],
    } as never)
    const feed = feedOf({ deposits: [twice] })
    const rows = feed.items.flatMap((i) => (i.kind === "deposit" ? [i] : []))
    const opened = rows.map((row) => depositDetailItem(feed.bridge, depositDetailId(row))?.record)
    expect(opened.map((r) => [r?.tokenSymbol, r?.amount]).sort()).toEqual([
      ["DAI", "5"],
      ["sUSDS", "2"],
    ])

    const daiId = depositDetailId(rows.find((r) => r.credit)!)
    const later = deposit({
      ...twice,
      tokenAddress: DAI,
      tokenSymbol: "DAI",
      amount: "3",
      netAmount: (3n * E18).toString(),
      inboxIndex: "9",
      sweeps: [...(twice.sweeps ?? []), sweep("9", DAI, "DAI", 3n * E18)],
    } as never)
    const reopened = depositDetailItem(feedOf({ deposits: [later] }).bridge, daiId)?.record
    expect([reopened?.tokenSymbol, reopened?.amount]).toEqual(["DAI", "3"])
  })

  it("lists an upgrade's direct deposits as its run once this device's runs are read", () => {
    const direct = deposit({
      sipaAddress: addr("c3"),
      direct: { portal: addr("f1") },
    } as never)
    expect(feedOf({ deposits: [direct] }).upgradeRuns).toHaveLength(1)
    expect(feedOf({ deposits: [direct], upgradesLoaded: false }).upgradeRuns).toHaveLength(0)
  })

  it("retires a link made on another rollup: nothing here shares or recovers it", () => {
    const link = tx({
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      txHash: "0xp",
      paylink: "https://l/#x",
      untilClaimable: NOW / 1000 + 60,
      networkId: "0xold",
    } as never)
    const view = (activeNetworkId: string) =>
      (feedOf({ rows: [link] }, { activeNetworkId }).items[0] as Extract<FeedItem, { kind: "tx" }>)
        .link
    expect(view("0xold")?.canShare).toBe(true)
    expect(view("0xnew")?.canShare).toBe(false)
  })

  it("offers a link's recovery only to the account that made it", () => {
    const nowSec = NOW / 1000
    const link = tx({
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
      txHash: "0xp",
      paylink: "https://l/#x",
      fallbackSecret: "0xf",
      obsidionAccountAddress: "0xone",
      fromClaimable: 0,
      untilClaimable: nowSec + 86_400,
      refundableUntil: nowSec + 3_600,
    } as never)
    const offer = (account: string) =>
      (
        feedOf({ rows: [link] }, { chainNowSec: nowSec, account }).items[0] as Extract<
          FeedItem,
          { kind: "tx" }
        >
      ).creatorAction
    expect(offer("0xONE")).toBe("cancel")
    // A backup passkey add moves the wallet onto a new account; the escrow refunds only its maker.
    expect(offer("0xtwo")).toBeUndefined()
  })

  it("lists an old-version withdrawal, pending while it sends", () => {
    const run = (phase: OldVersionWithdrawal["phase"]) =>
      ({
        id: "ov",
        startTime: NOW,
        to: addr("e9"),
        refunds: [],
        phase,
      } as unknown as OldVersionWithdrawal)
    const [sending] = feedOf({ oldVersionWithdrawals: [run("sending")] }).items
    expect(sending).toMatchObject({
      kind: "oldVersionWithdrawal",
      id: "old-version-withdrawal:ov",
      direction: "out",
      pending: true,
    })
    expect(feedOf({ oldVersionWithdrawals: [run("done")] }).items[0].pending).toBe(false)
  })

  it("leaves a deposit to a rotated wallet's previous account out of what Home counts as arriving", () => {
    const previous = `0x${"0d".repeat(32)}`
    const swept = deposit({ phase: "pendingClaim", recipientL2Address: previous })
    expect(feedOf({ deposits: [swept] }).arriving.main).toBe(20n * E18)
    expect(
      feedOf({ deposits: [swept] }, { previousAccount: `0x${"0D".repeat(32)}` }).arriving.main,
    ).toBe(0n)
  })

  it("holds the skeleton while a chain scan rebuilds history", () => {
    expect(feedOf({ catchingUp: true }).hydrated).toBe(false)
    expect(feedOf().hydrated).toBe(true)
  })
})

describe("selectors over the feed", () => {
  const feed = feedOf({
    rows: [tx({ action: "send", txHash: "0xs" }), tx({ action: "receive", txHash: "0xr" })],
    requests: [request(), request({ id: "mine", direction: "outgoing" })],
  })

  it("lifts incoming requests out of Home's feed", () => {
    const home = selectHome(feed)
    expect(kinds(home.requests)).toEqual(["request:req"])
    expect(home.feed.map((i) => i.id)).toEqual(["0xs", "0xr", "mine"])
  })

  it("files unpaid requests under Pending only", () => {
    expect(selectActivity(feed.items, "Sent").map((i) => i.id)).toEqual(["0xs"])
    expect(selectActivity(feed.items, "Received").map((i) => i.id)).toEqual(["0xr"])
    expect(selectActivity(feed.items, "Pending").map((i) => i.id)).toEqual(["req", "mine"])
  })

  it("splits Requests into what the user asked and what they owe, counting the inbox", () => {
    const boxes = selectRequests(feed, 2)
    expect([kinds(boxes.sent), kinds(boxes.received), boxes.receivedCount]).toEqual([
      ["request:mine"],
      ["request:req"],
      3,
    ])
  })
})

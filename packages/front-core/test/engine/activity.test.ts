import { describe, expect, it } from "vitest"
import { PaylinkActionEnum, QueueStatus, TokenActionEnum } from "@obsidion/core/constants"
import {
  activityPages,
  createActivity,
  OPEN,
  PENDING,
  type Activity,
} from "../../src/engine/activity"
import { openDatabase, type DatabaseBackend } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, loadRecords, timeKey } from "../../src/engine/persistentStore"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import { payoutRow, scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import type { NewIncomingTokenTx } from "../../src/xmtp/receiverTypes"
import type { OnNetwork } from "../../src/types/networkStamp"
import type {
  PaylinkTransaction,
  TokenTransaction,
  Transaction,
} from "../../src/types/transactions"

const token = {
  address: "0xtoken",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1.5,
  price: 1,
}

const pendingSend = (over: Partial<TokenTransaction> = {}): OnNetwork<TokenTransaction> => ({
  id: "op-1",
  networkId: "net",
  operationId: "op-1",
  action: "send",
  token,
  amountAtomic: 1_500_000n,
  timestamp: 1_000,
  status: "pending",
  txHash: "",
  ...over,
})

const scanned = (over: Partial<NewIncomingTokenTx> = {}) =>
  scannedRow({
    txHash: "0xAA",
    from: "@alice",
    senderL2Address: "0xalice",
    to: "@me",
    token,
    amountAtomic: 1_500_000n,
    timestamp: 2_000,
    networkId: "net",
    ...over,
  })

const link = (
  txHash: string,
  over: Partial<PaylinkTransaction> = {},
): OnNetwork<PaylinkTransaction> => ({
  id: txHash,
  networkId: "net",
  action: PaylinkActionEnum.PAY,
  emailPaymentAction: PaylinkActionEnum.PAY,
  status: "success",
  flavor: "direct",
  token,
  amountAtomic: 1n,
  timestamp: 1,
  txHash,
  payToEmailSecret: "0xs",
  paylink: "url",
  ...over,
})

/** A backend whose commits wait while `held`. */
function gated(inner: MemoryBackend = memoryBackend()) {
  let release: () => void = () => {}
  let gate: Promise<void> | undefined
  const backend: DatabaseBackend = {
    ...inner,
    async apply(ops) {
      await gate
      return inner.apply(ops)
    },
  }
  return {
    backend,
    inner,
    hold() {
      gate = new Promise((resolve) => (release = resolve))
    },
    land() {
      gate = undefined
      release()
    },
  }
}

function open(backend: DatabaseBackend = memoryBackend()): Activity {
  return createActivity({ db: openDatabase(backend) })
}

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(() => (done = true))
  await new Promise((r) => setTimeout(r, 0))
  return done
}

const ids = async (activity: Activity) => (await activity.all()).map((row) => row.id).sort()

describe("activity: the submit boundary", () => {
  it("resolves insertPending only once saved", async () => {
    const disk = gated()
    const activity = open(disk.backend)
    await activity.ready
    disk.hold()
    const insert = activity.insertPending(pendingSend({ networkId: "NET" }))
    expect(await isSettled(insert)).toBe(false)
    expect(await activity.get("op-1")).toBeUndefined()
    disk.land()
    await insert
    expect((await activity.get("op-1"))?.networkId).toBe("net")
  })

  it("resolves setHash only once saved and stamps the hash once", async () => {
    const disk = gated()
    const activity = open(disk.backend)
    await activity.insertPending(pendingSend())
    disk.hold()
    const stamp = activity.setHash("op-1", "0xBEEF")
    expect(await isSettled(stamp)).toBe(false)
    disk.land()
    expect(await stamp).toBe(true)
    expect((await activity.byHash("0xbeef"))?.detailedStatus).toBe(QueueStatus.MINING)
    expect(await activity.setHash("op-1", "0xOTHER")).toBe(true)
    expect((await activity.get("op-1"))?.txHash).toBe("0xBEEF")
    expect(await activity.setHash("missing", "0x1")).toBe(false)
  })

  it("files a scanned copy of a hash still saving once it lands, beside nothing", async () => {
    const disk = gated()
    const activity = open(disk.backend)
    await activity.insertPending(pendingSend())
    disk.hold()
    const stamp = activity.setHash("op-1", "0xAA")
    const filed = activity.record(scanned({ action: "send" }))
    disk.land()
    await stamp
    expect((await filed).inserted).toBe(false)
    expect(await ids(activity)).toEqual(["op-1"])
  })

  it("stops finding a hash whose save failed", async () => {
    const backend = memoryBackend()
    const activity = open(backend)
    await activity.insertPending(pendingSend())
    backend.failing.commits = true
    await expect(activity.setHash("op-1", "0xAA")).rejects.toThrow()
    backend.failing.commits = false
    expect(await activity.byHash("0xaa")).toBeUndefined()
    expect((await activity.get("op-1"))?.txHash).toBe("")
  })
})

describe("activity: rows by hash", () => {
  it("files a scanned transfer once, and never beside the row this device started", async () => {
    const activity = open()
    await activity.insertPending(pendingSend())
    await activity.setHash("op-1", "0xAA")
    expect((await activity.record(scanned({ action: "send" }))).inserted).toBe(false)
    const receive = await activity.record(scanned({ txHash: "0xBB" }))
    expect(receive).toMatchObject({ inserted: true, tx: { id: "0xbb", txHash: "0xbb" } })
    const replay = await activity.record(scanned({ txHash: "0xbb", from: "@mallory" }))
    expect((replay.tx as TokenTransaction).from).toBe("@alice")
    expect(await ids(activity)).toEqual(["0xbb", "op-1"])
  })

  it("knows a refund's hash, and fills a missing memo", async () => {
    const activity = open()
    await activity.record(link("0xpay", { isRefunded: true, refundTxHash: "0xR" }))
    expect(await activity.hasTxHash("0xr")).toBe(true)
    expect((await activity.byHash("0xr"))?.id).toBeUndefined()
    expect(await activity.backfillMemo("0xpay", "hi")).toBe(true)
    expect(await activity.backfillMemo("0xpay", "again")).toBe(false)
  })

  it("upgrades a scanned send to a link and a scanned receive to a payout, in place", async () => {
    const activity = open()
    await activity.record(scanned({ action: "send", txHash: "0x01" }))
    await activity.record(scanned({ txHash: "0x02" }))
    const created = await activity.record(link("0x01"), { replaces: TokenActionEnum.SEND })
    expect(created).toMatchObject({
      inserted: true,
      tx: { id: "0x01", action: PaylinkActionEnum.PAY },
    })
    expect((await activity.record(link("0x01"), { replaces: TokenActionEnum.SEND })).inserted).toBe(
      false,
    )
    const payout = (txHash: string) =>
      payoutRow({
        action: PaylinkActionEnum.CLAIM,
        txHash,
        flavor: "direct",
        token,
        amountAtomic: 1n,
        timestamp: 3,
        blockNumber: 1,
        networkId: "net",
      })
    const replaces = { replaces: TokenActionEnum.RECEIVE }
    expect((await activity.record(payout("0x02"), replaces)).inserted).toBe(true)
    expect((await activity.record(payout("0x01"), replaces)).inserted).toBe(false)
    const rows = await activity.all()
    expect(rows.map((r) => r.action).sort()).toEqual([
      PaylinkActionEnum.CLAIM,
      PaylinkActionEnum.PAY,
    ])
  })
})

describe("activity: indexes", () => {
  it("moves a row's entries when its time or counterparty changes", async () => {
    const activity = open()
    await activity.record(scanned({ action: "send", txHash: "0x01", to: "0xBob", timestamp: 5 }))
    await activity.record(link("0x01", { timestamp: 9 }), { replaces: TokenActionEnum.SEND })
    expect(await loadRecords(activity.query("peer", "0xbob"))).toEqual([])
    expect((await loadRecords(activity.query("time", { before: timeKey(6) }))).length).toBe(0)
    expect((await loadRecords(activity.query("link", "0xs"))).map((r) => r.id)).toEqual(["0x01"])
  })

  it("reads a contact's rows by address and by tag, and a request's by its id", async () => {
    const activity = open()
    await activity.record(scanned({ txHash: "0x01", from: "@Alice", senderL2Address: "0xA1" }))
    await activity.record(scanned({ txHash: "0x02", from: "@carol", requestId: "0xR" }))
    await activity.insertPending(pendingSend({ to: "0xa1", toTag: "alice" }))
    const peer = async (value: string) =>
      (await loadRecords(activity.query("peer", value))).map((r) => r.id).sort()
    expect(await peer("0xa1")).toEqual(["0x01", "op-1"])
    expect(await peer("alice")).toEqual(["0x01", "op-1"])
    const paying = await loadRecords(activity.query("request", "0xr"))
    expect(paying.map((r) => r.id)).toEqual(["0x02"])
  })

  it("keeps the pending rows under one key, until they end", async () => {
    const activity = open()
    await activity.insertPending(pendingSend())
    await activity.record(scanned())
    const pending = activity.query("pending", PENDING)
    expect((await loadRecords(pending)).map((r) => r.id)).toEqual(["op-1"])
    await activity.settle("op-1", "0x9")
    expect(await loadRecords(pending)).toEqual([])
  })

  it("keeps a created link under open while escrowed, and under its claim time once claimed", async () => {
    const activity = open()
    await activity.record(link("0xl"))
    const escrowed = async () => (await loadRecords(activity.query("open", OPEN))).map((r) => r.id)
    const claimed = async () => (await loadRecords(activity.query("claimed", {}))).map((r) => r.id)
    expect(await escrowed()).toEqual(["0xl"])
    await activity.apply("0xl", { type: "claimed", at: 7, refundInFlight: false, by: "chain" })
    expect(await escrowed()).toEqual([])
    expect(await claimed()).toEqual(["0xl"])
    expect(await loadRecords(activity.query("claimed", { after: timeKey(8) }))).toEqual([])
    // A reorg that undoes the claim keeps its time, so the bell still reads the reversal.
    await activity.apply("0xl", { type: "unclaimed" })
    expect(await claimed()).toEqual(["0xl"])
    await activity.apply("0xl", { type: "refunded" })
    expect(await escrowed()).toEqual([])
  })

  it("holds the newest rows in its view, newest first", async () => {
    const activity = open()
    for (let i = 1; i <= 12; i++) await activity.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const stop = activity.view.subscribe(() => {})
    await activity.ready
    await new Promise((r) => setTimeout(r, 0))
    const { records, loaded } = activity.view.get()
    expect(loaded).toBe(true)
    expect(records.map((r) => r.timestamp)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    stop()
  })
})

describe("activity: pages", () => {
  it("reads one more page at a time, and keeps the last shown while the next loads", async () => {
    const activity = open()
    for (let i = 1; i <= 5; i++) await activity.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const pages = activityPages(activity, 2)
    const seen: number[] = []
    const stop = pages.rows.subscribe(() => seen.push(pages.rows.get().records.length))
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, complete: false })
    pages.more()
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, complete: true })
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4, 3, 2, 1])
    expect(seen.slice(seen.indexOf(2))).not.toContain(0)
    stop()
  })
})

describe("activity: pages failing", () => {
  it("keeps the page shown when the next one fails, and reads it again on the next more", async () => {
    const backend = memoryBackend()
    const activity = open(backend)
    for (let i = 1; i <= 5; i++) await activity.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const pages = activityPages(activity, 2)
    const stop = pages.rows.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 0))
    backend.failing = { reads: true }
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, failed: false, complete: false })
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4])
    backend.failing = {}
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4, 3, 2])
    stop()
  })
})

describe("activity: lifecycle", () => {
  it("fails only this device's hashless rows older than the cutoff", async () => {
    const activity = open()
    await activity.insertPending(pendingSend({ timestamp: 100 }))
    await activity.insertPending(pendingSend({ id: "op-2", operationId: "op-2", timestamp: 900 }))
    await activity.insertPending(pendingSend({ id: "op-3", operationId: "op-3", timestamp: 100 }))
    await activity.setHash("op-3", "0x3")
    await activity.record(scanned({ timestamp: 100 }))
    expect((await activity.failInterrupted(1_000, 500)).map((r) => r.id)).toEqual(["op-1"])
    expect(await activity.get("op-1")).toMatchObject({
      status: "failed",
      failure: { code: "tx.interrupted" },
    })
  })

  it("settles and fails rows, and a flow's second outcome changes nothing", async () => {
    const activity = open()
    await activity.insertPending(pendingSend())
    await activity.insertPending(pendingSend({ id: "op-2", operationId: "op-2" }))
    expect(await activity.settle("op-1", "0x9")).toBe(true)
    expect(await activity.get("op-1")).toMatchObject({ status: "success", txHash: "0x9" })
    expect(await activity.fail("op-2", { code: "tx.failed", detail: "boom" })).toBe(true)
    expect((await activity.get("op-2"))?.failure).toEqual({ code: "tx.failed", detail: "boom" })
    expect(await activity.fail("op-1", { code: "tx.failed" })).toBe(false)
    expect((await activity.get("op-1"))?.status).toBe("success")
  })

  it("keeps a demote that lands while the flow waits, against the flow's late settle", async () => {
    const activity = open()
    await activity.insertPending(pendingSend())
    await activity.setHash("op-1", "0x9")
    expect((await activity.demoteByTxHash("0x9")).reorgEpoch).toBe(1)
    expect(await activity.settle("op-1", "0x9")).toBe(false)
    expect(await activity.get("op-1")).toMatchObject({ status: "pending", reorgEpoch: 1 })
    await activity.settleByHash("0x9", QueueStatus.SUCCESS, 5, 1)
    expect(await activity.get("op-1")).toMatchObject({ status: "success", endTime: 5 })
  })

  it("never lets a field patch move a row's status or claim state", async () => {
    const activity = open()
    await activity.insertPending(pendingSend())
    await activity.patch("op-1", (row) => ({
      ...row,
      status: "success",
      txHash: "0x1",
      memo: "hi",
    }))
    expect(await activity.get("op-1")).toMatchObject({ status: "pending", txHash: "", memo: "hi" })
  })

  it("fences a stale settle after a reorg demote", async () => {
    const activity = open()
    await activity.record(scanned())
    const { reorgEpoch } = await activity.demoteByTxHash("0xaa")
    expect((await activity.byHash("0xaa"))?.status).toBe("pending")
    await activity.settleByHash("0xaa", QueueStatus.SUCCESS, 5)
    expect((await activity.byHash("0xaa"))?.status).toBe("pending")
    await activity.settleByHash("0xaa", QueueStatus.SUCCESS, 5, reorgEpoch)
    expect(await activity.byHash("0xaa")).toMatchObject({ status: "success", endTime: 5 })
    expect(await activity.demoteByTxHash("0xaa", { terminal: "failed" })).toEqual({
      matched: true,
      reorgEpoch: 2,
    })
  })

  it("commits writes that share a transaction together, or not at all", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const activity = createActivity({ db })
    await activity.insertPending(pendingSend())
    await activity.insertPending(pendingSend({ id: "op-2", operationId: "op-2" }))
    backend.failing.commits = true
    await expect(
      db.write(async (w) => {
        await activity.apply("op-1", { type: "sent", txHash: "0x1" }, w)
        await activity.apply("op-2", { type: "sent", txHash: "0x2" }, w)
      }),
    ).rejects.toThrow()
    backend.failing.commits = false
    expect(await activity.hasTxHash("0x1")).toBe(false)
    expect(await activity.hasTxHash("0x2")).toBe(false)
  })
})

describe("activity: migration", () => {
  const interrupted =
    "This payment was interrupted before it was sent. The amount is still in your balance."
  const legacy = [
    {
      action: "send",
      token,
      timestamp: 1,
      status: "failed",
      txHash: "",
      queueId: "op-a",
      error: interrupted,
    },
    {
      action: "send",
      token,
      timestamp: 2,
      status: "failed",
      txHash: "",
      queueId: "op-b",
      error: "boom",
    },
    {
      action: "receive",
      token,
      timestamp: 3,
      status: "success",
      txHash: "0xC",
      amountAtomic: "42",
    },
    {
      action: "send",
      token: { ...token, amount: 0.1, decimals: 18 },
      timestamp: 4,
      status: "success",
      txHash: "0xD",
      toTag: "bob",
      kind: "send",
    },
    {
      action: PaylinkActionEnum.PAY,
      emailPaymentAction: PaylinkActionEnum.PAY,
      token,
      timestamp: 5,
      status: "pending",
      txHash: "",
      to: "a@b.co",
      operationId: "op-e",
      queueId: "q-e",
    },
    { action: "contract_call", timestamp: 6, status: "success", txHash: "" },
  ]
  const legacyIds = ["0xc", "0xd", "legacy-6-5", "op-a", "op-b", "op-e"]

  it("carries every legacy row, keyed and converted, and leaves the legacy key in place", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    const activity = open(backend)
    await activity.ready
    const rows = new Map((await activity.all()).map((r): [string, Transaction] => [r.id, r]))
    expect([...rows.keys()].sort()).toEqual(legacyIds)
    expect(rows.get("op-a")).toMatchObject({ failure: { code: "tx.interrupted" } })
    expect(rows.get("op-b")?.failure).toEqual({ code: "tx.failed", detail: "boom" })
    expect(rows.get("0xc")?.amountAtomic).toBe(42n)
    expect(rows.get("0xd")).toMatchObject({ amountAtomic: 10n ** 17n, toTag: "bob" })
    expect(rows.get("op-e")).toMatchObject({ flavor: "email", amountAtomic: 1_500_000n })
    for (const row of rows.values()) expect(row).not.toHaveProperty("queueId")
    expect(backend.entries.get(TRANSACTIONS_STORAGE_KEY)).toBeDefined()
    expect(backend.entries.get("acct/meta/activity")).toBe("3")
    expect((await activity.byHash("0xc"))?.id).toBe("0xc")
  })

  it("carries the account blob's rows where no build split them out, never over the split key", async () => {
    const account = memoryBackend()
    account.entries.set(ACCOUNT_STORAGE_KEY, JSON.stringify({ transactions: legacy }))
    expect(await ids(open(account))).toEqual(legacyIds)
    const split = memoryBackend()
    split.entries.set(ACCOUNT_STORAGE_KEY, JSON.stringify({ transactions: legacy }))
    split.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacy[2]]))
    expect(await ids(open(split))).toEqual(["0xc"])
  })

  it("builds the indexes of rows a previous version saved, and reads the legacy key once", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    backend.entries.set("acct/meta/activity", "1")
    backend.entries.set("acct/activity/0xee", encodeRecord(scanned({ txHash: "0xee" })))
    const activity = open(backend)
    expect(await ids(activity)).toEqual(["0xee"])
    expect((await activity.byHash("0xee"))?.id).toBe("0xee")
  })

  it("opens empty from a malformed or missing blob", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, "{not json")
    expect(await ids(open(backend))).toEqual([])
    expect(await ids(open())).toEqual([])
  })

  it("adds a retired rollup's rows once, failed where unfinished", async () => {
    const activity = open()
    await activity.record(scanned({ txHash: "0xC" }))
    expect(await activity.importHistoricRows(legacy)).toBe(1)
    expect(await activity.importHistoricRows(legacy)).toBe(0)
    expect((await activity.byHash("0xd"))?.status).toBe("success")
  })
})

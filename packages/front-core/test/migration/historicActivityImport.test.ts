import { describe, expect, it, vi } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import {
  ACCOUNT_STORAGE_KEY,
  AccountStorage,
  HISTORIC_ACTIVITY_IMPORTED_KEY,
  importHistoricActivity,
  KEY_SAVINGS_MOVES,
  KEY_SIPA_DEPOSITS,
  retiredDatabaseOf,
  SavingsMoveStorage,
  SIPADepositStore,
  TRANSACTIONS_STORAGE_KEY,
  TRANSFER_SCAN_CURSOR_PREFIX,
  transferScanNetworkOf,
  type RetiredDatabase,
  type SavingsMoveRecord,
  type SIPADepositRecord,
  type WithdrawalRecord,
} from "../../src/core"
import { createActivity } from "../../src/engine/activity"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import { encodeRecord } from "../../src/engine/persistentStore"
import { createWithdrawals, KEY_WITHDRAWALS } from "../../src/engine/withdrawals"
import type { TokenInTxService, TokenTransaction, Transaction } from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

const ACTIVE = "0xactive"
const OLD = "0xold"
const ACCOUNT = "0xacc"

const token: TokenInTxService = {
  name: "USDC",
  decimals: 6,
  logo: "",
  price: 1,
  symbol: "USDC",
  address: "0xtoken",
  amount: 5,
  hasUnknownAmount: false,
}

/** A row as a retired database holds it, in the legacy format. */
const row = (overrides: Partial<TokenTransaction> & { queueId?: string }): TokenTransaction =>
  ({
    action: "send",
    token,
    timestamp: 1_000,
    status: "success",
    txHash: "0xA1",
    from: ACCOUNT,
    to: "0xbob",
    ...overrides,
  } as TokenTransaction)

const deposit = (overrides: Partial<SIPADepositRecord>): SIPADepositRecord =>
  ({
    sipaAddress: "0xsipa1",
    recipientL2Address: ACCOUNT,
    messageSecret: "s",
    recipientHash: "h",
    recoveryAddress: "0xrecover",
    l1ChainId: 1,
    amount: "100",
    tokenSymbol: "USDC",
    phase: "claimed",
    startTime: 1_000,
    ...overrides,
  } as SIPADepositRecord)

const withdrawal = (overrides: Partial<WithdrawalRecord>): WithdrawalRecord =>
  ({
    localId: "w1",
    phase: "done",
    startTime: 1_000,
    amount: "5",
    ...overrides,
  } as WithdrawalRecord)

const cursorKey = (networkId: string) => `${TRANSFER_SCAN_CURSOR_PREFIX}${networkId}/${ACCOUNT}`

const retired = retiredDatabaseOf

function database(
  version: string,
  o: {
    rows?: Transaction[]
    deposits?: SIPADepositRecord[]
    withdrawals?: WithdrawalRecord[]
    savingsMoves?: SavingsMoveRecord[]
    scanned?: string[]
    extra?: Record<string, string>
  },
): RetiredDatabase {
  const entries: Record<string, string> = { ...o.extra }
  if (o.rows) entries[TRANSACTIONS_STORAGE_KEY] = JSON.stringify(o.rows)
  if (o.deposits)
    entries[KEY_SIPA_DEPOSITS] = JSON.stringify(
      Object.fromEntries(o.deposits.map((d) => [d.sipaAddress, d])),
    )
  if (o.withdrawals)
    entries[KEY_WITHDRAWALS] = JSON.stringify(
      Object.fromEntries(o.withdrawals.map((w) => [w.localId, w])),
    )
  if (o.savingsMoves)
    entries[KEY_SAVINGS_MOVES] = JSON.stringify(
      Object.fromEntries(o.savingsMoves.map((m) => [m.withdrawalLocalId, m])),
    )
  for (const id of o.scanned ?? []) entries[cursorKey(id)] = "42"
  return retired(version, entries)
}

const readOf =
  (dbs: RetiredDatabase[]) =>
  <T>(read: (db: RetiredDatabase) => T) =>
    Promise.resolve(dbs.map(read))

function setup() {
  resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  const storage = new InMemoryStorageAdapter()
  AccountStorage.get(storage)
  const transactions = createActivity({ db: openDatabase(memoryBackend()) })
  const sipaDeposits = SIPADepositStore.get(storage)
  const withdrawals = createWithdrawals({ db: openDatabase(memoryBackend()) })
  const savingsMoves = new SavingsMoveStorage(storage)
  const deps = (dbs: RetiredDatabase[], ownsStorage?: () => boolean) => ({
    storage,
    readOtherDatabases: readOf(dbs),
    transactions,
    sipaDeposits,
    withdrawals,
    savingsMoves,
    ownsStorage,
  })
  return { storage, transactions, sipaDeposits, withdrawals, savingsMoves, deps }
}

describe("importHistoricActivity", () => {
  it("carries rows and settled deposits and withdrawals over, stamped with the retired network", async () => {
    const { storage, transactions, sipaDeposits, withdrawals, deps } = setup()
    const db = database("7", {
      scanned: [OLD],
      rows: [
        row({ txHash: "0xA1" }),
        row({ txHash: "0xA2", action: "receive", from: "0xbob", to: ACCOUNT }),
        row({
          txHash: "0xA3",
          status: "pending",
          queueId: "q1",
          detailedStatus: QueueStatus.PENDING,
        }),
      ],
      deposits: [deposit({}), deposit({ sipaAddress: "0xsipa2", phase: "swept" })],
      withdrawals: [withdrawal({}), withdrawal({ localId: "w2", phase: "submitting" })],
    })

    const result = await importHistoricActivity(deps([db]))

    expect(result).toEqual({
      databases: 1,
      transactions: 3,
      deposits: 1,
      withdrawals: 1,
      savingsMoves: 0,
      unstamped: 0,
    })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xA1", OLD],
      ["0xA2", OLD],
      ["0xA3", OLD],
    ])
    const unfinished = rows.find((r) => r.txHash === "0xA3")!
    expect(unfinished).toMatchObject({
      status: "failed",
      detailedStatus: QueueStatus.FAILED,
      failure: { code: "tx.failed" },
      endTime: 1_000,
    })
    expect(unfinished.operationId).toBeUndefined()
    expect("queueId" in unfinished).toBe(false)
    expect(sipaDeposits.list().map((d) => [d.sipaAddress, d.networkId])).toEqual([["0xsipa1", OLD]])
    expect(
      [...(await withdrawals.all())]
        .sort((a, b) => b.startTime - a.startTime)
        .map((w) => [w.localId, w.networkId]),
    ).toEqual([["w1", OLD]])
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toContain('"databases":["7"]')
  })

  it("runs once: a later call reads nothing", async () => {
    const { deps } = setup()
    const read = vi.fn(readOf([database("7", { rows: [row({})] })]))
    await importHistoricActivity({ ...deps([]), readOtherDatabases: read })
    expect(await importHistoricActivity({ ...deps([]), readOtherDatabases: read })).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("skips a row already here, keeps a row's own stamp, and leaves existing records alone", async () => {
    const { transactions, sipaDeposits, deps } = setup()
    await transactions.record(
      scannedRow({
        action: "receive",
        txHash: "0xa1",
        from: "0xbob",
        senderL2Address: "0xbob",
        to: ACCOUNT,
        token,
        amountAtomic: 5_000_000n,
        timestamp: 5,
        networkId: ACTIVE,
      }),
    )
    await sipaDeposits.create("0xsipa1", { ...deposit({ amount: "1" }), networkId: ACTIVE })
    const db = database("7", {
      scanned: [OLD],
      rows: [row({ txHash: "0xA1" }), row({ txHash: "0xA2", networkId: "0xother" })],
      deposits: [deposit({ amount: "999" })],
    })

    const result = await importHistoricActivity(deps([db]))

    expect(result).toMatchObject({ transactions: 1, deposits: 0 })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xa1", ACTIVE],
      ["0xA2", "0xother"],
    ])
    expect(sipaDeposits.get("0xsipa1")).toMatchObject({ amount: "1", networkId: ACTIVE })
  })

  it("carries a settled withdrawal's Savings move as retired, over a move adopted from its burn", async () => {
    const { savingsMoves, deps } = setup()
    const move = (localId: string, extra: Partial<SavingsMoveRecord> = {}) =>
      ({
        withdrawalLocalId: localId,
        direction: "in",
        amount: "5",
        startTime: 1,
        ...extra,
      } as SavingsMoveRecord)
    await savingsMoves.put(move("w1"))
    const claimed = { inboxIndex: "1", amount: "5", claimed: true }
    const db = database("7", {
      scanned: [OLD],
      withdrawals: [withdrawal({}), withdrawal({ localId: "w2", phase: "submitting" })],
      savingsMoves: [move("w1", { deposit: claimed }), move("w2")],
    })

    expect((await importHistoricActivity(deps([db])))?.savingsMoves).toBe(1)
    expect(savingsMoves.list()).toEqual([{ ...move("w1", { deposit: claimed }), retired: true }])
  })

  it("dedups link rows by link when they carry no hash", async () => {
    const { transactions, deps } = setup()
    const link = {
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      paylink: "https://l/1",
      token,
      timestamp: 1,
      status: "success",
    }
    const db = database("7", { scanned: [OLD], rows: [link, link] as unknown as Transaction[] })
    expect((await importHistoricActivity(deps([db])))?.transactions).toBe(1)
    expect(await transactions.all()).toHaveLength(1)
  })

  it("leaves deposits and withdrawals that name no single network, but still carries the rows", async () => {
    const { transactions, sipaDeposits, withdrawals, deps } = setup()
    const dbs = [
      database("7", {
        rows: [row({ txHash: "0xA1" })],
        deposits: [deposit({})],
        withdrawals: [withdrawal({})],
      }),
      database("8", {
        scanned: [OLD, "0xolder"],
        rows: [row({ txHash: "0xB1" })],
        deposits: [deposit({ sipaAddress: "0xsipa8", networkId: "0xolder" })],
        withdrawals: [withdrawal({ localId: "w8" })],
      }),
    ]

    const result = await importHistoricActivity(deps(dbs))

    expect(result).toEqual({
      databases: 2,
      transactions: 2,
      deposits: 1,
      withdrawals: 0,
      savingsMoves: 0,
      unstamped: 3,
    })
    const rows = await transactions.all()
    expect(rows.map((r) => [r.txHash, r.networkId])).toEqual([
      ["0xA1", undefined],
      ["0xB1", undefined],
    ])
    expect(sipaDeposits.list().map((d) => d.sipaAddress)).toEqual(["0xsipa8"])
    expect([...(await withdrawals.all())].sort((a, b) => b.startTime - a.startTime)).toEqual([])
  })

  it("a failed read leaves no marker", async () => {
    const { storage, deps } = setup()
    const failing = {
      ...deps([]),
      readOtherDatabases: () => Promise.reject(new Error("pool busy")),
    }
    await expect(importHistoricActivity(failing)).rejects.toThrow("pool busy")
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })

  it("an account switch stops the import before any write", async () => {
    const { storage, transactions, deps } = setup()
    const db = database("7", { scanned: [OLD], rows: [row({})] })
    await expect(importHistoricActivity(deps([db], () => false))).rejects.toThrow("account changed")
    expect(await transactions.all()).toEqual([])
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })

  it("reads a database no build split yet from its account blob, and prefers the split list", async () => {
    const { transactions, deps } = setup()
    const unsplit = retired("5", {
      [ACCOUNT_STORAGE_KEY]: JSON.stringify({
        address: "0xacc",
        transactions: [row({ txHash: "0xL1" }), null],
      }),
      [cursorKey(OLD)]: "1",
    })
    const split = retired("6", {
      [ACCOUNT_STORAGE_KEY]: JSON.stringify({ transactions: [row({ txHash: "0xSTALE" })] }),
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([row({ txHash: "0xS1" })]),
    })

    expect((await importHistoricActivity(deps([unsplit, split])))?.transactions).toBe(2)
    expect((await transactions.all()).map((r) => r.txHash)).toEqual(["0xL1", "0xS1"])
  })

  it("reads the rows a database's activity store saved, ahead of its legacy copy", async () => {
    const { transactions, deps } = setup()
    const saved = { ...row({ txHash: "0xN1" }), id: "0xn1", amountAtomic: 7n, networkId: OLD }
    const db = retired("8", {
      "acct/meta/activity": "1",
      "acct/activity/0xn1": encodeRecord(saved),
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([
        row({ txHash: "0xN1", status: "pending" }),
        row({ txHash: "0xL2", timestamp: 2_000 }),
      ]),
    })

    expect((await importHistoricActivity(deps([db])))?.transactions).toBe(2)
    expect((await transactions.all()).map((r) => [r.txHash, r.status, r.amountAtomic])).toEqual([
      ["0xN1", "success", 7n],
      ["0xL2", "success", 5_000_000n],
    ])
  })

  it("skips malformed values and rows with neither hash nor link", async () => {
    const { storage, deps } = setup()
    const db = retired("7", {
      [TRANSACTIONS_STORAGE_KEY]: JSON.stringify([row({ txHash: "" }), 3, null]),
      [KEY_SIPA_DEPOSITS]: "{not json",
      [KEY_WITHDRAWALS]: JSON.stringify([withdrawal({})]),
    })
    expect(await importHistoricActivity(deps([db]))).toEqual({
      databases: 1,
      transactions: 0,
      deposits: 0,
      withdrawals: 0,
      savingsMoves: 0,
      unstamped: 0,
    })
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
  })
})

describe("importHistoricActivity writes", () => {
  it("runs every write under holdSession", async () => {
    const { storage, transactions, deps } = setup()
    const db = database("7", { scanned: [OLD], rows: [row({})], deposits: [deposit({})] })
    let rowsWhenHeld = -1
    const holdSession = vi.fn(async <T>(fn: () => Promise<T>) => {
      rowsWhenHeld = (await transactions.all()).length
      return fn()
    })

    await importHistoricActivity({ ...deps([db]), holdSession })

    expect(holdSession).toHaveBeenCalledTimes(1)
    expect(rowsWhenHeld).toBe(0)
    expect(await transactions.all()).toHaveLength(1)
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).not.toBeNull()
  })

  it("a record write that does not reach storage fails the import and leaves no marker", async () => {
    const { storage, deps } = setup()
    const setItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) =>
      key === KEY_SIPA_DEPOSITS ? Promise.reject(new Error("disk full")) : setItem(key, value)
    const db = database("7", { scanned: [OLD], rows: [row({})], deposits: [deposit({})] })

    await expect(importHistoricActivity(deps([db]))).rejects.toThrow("disk full")
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
  })
})

describe("importHistoricActivity from a source generation", () => {
  it("files a database held as entries under its own marker, beside this browser's import", async () => {
    const { storage, transactions, withdrawals, deps } = setup()
    const burn = "0x" + "b1".repeat(32)
    await withdrawals.create({
      ...withdrawal({ localId: "here", l2TxHash: burn as never }),
      networkId: OLD,
    })
    const db = database("7", {
      scanned: [OLD],
      rows: [row({})],
      withdrawals: [
        withdrawal({ localId: "rebuilt", l2TxHash: burn as never }),
        withdrawal({ localId: "other", l2TxHash: ("0x" + "b2".repeat(32)) as never }),
      ],
    })
    const key = `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${OLD}/0xtoken`

    const result = await importHistoricActivity({ ...deps([db]), key })

    expect(result).toMatchObject({ transactions: 1, withdrawals: 1 })
    expect(
      withdrawals.list
        .get()
        .records.map((w) => w.localId)
        .sort(),
    ).toEqual(["here", "other"])
    expect((await transactions.all())[0]?.networkId).toBe(OLD)
    expect(await storage.getItem(key)).not.toBeNull()
    expect(await storage.getItem(HISTORIC_ACTIVITY_IMPORTED_KEY)).toBeNull()
    expect(await importHistoricActivity({ ...deps([db]), key })).toBeNull()
  })

  it("imports a short read's rows and leaves the marker for a full read", async () => {
    const { storage, transactions, deps } = setup()
    const db = { ...database("7", { scanned: [OLD], rows: [row({})] }), partial: true }
    const key = `${HISTORIC_ACTIVITY_IMPORTED_KEY}/${OLD}/0xtoken`

    expect(await importHistoricActivity({ ...deps([db]), key })).toMatchObject({ transactions: 1 })
    expect(await transactions.all()).toHaveLength(1)
    expect(await storage.getItem(key)).toBeNull()

    const full = database("7", { scanned: [OLD], rows: [row({})] })
    expect(await importHistoricActivity({ ...deps([full]), key })).toMatchObject({
      transactions: 0,
    })
    expect(await storage.getItem(key)).not.toBeNull()
  })

  it("names a held row's counterparty by the tag a later read verified", async () => {
    const { transactions, deps } = setup()
    const sender = "0x" + "5e".repeat(32)
    const recipient = "0x" + "7e".repeat(32)
    const send = row({ txHash: "0xA1", to: recipient })
    const receive = row({
      txHash: "0xA2",
      action: "receive",
      from: sender,
      senderL2Address: sender,
      to: ACCOUNT,
    })
    const untagged = database("7", { scanned: [OLD], rows: [send, receive] })
    await importHistoricActivity({ ...deps([untagged]), key: "first" })

    const tagged = database("7", {
      scanned: [OLD],
      rows: [
        { ...send, toTag: "bob" },
        { ...receive, from: "alice" },
      ],
    })
    const result = await importHistoricActivity({ ...deps([tagged]), key: "second" })

    expect(result).toMatchObject({ transactions: 0 })
    const rows = await transactions.all()
    expect(rows.find((r) => r.txHash === "0xA1")).toMatchObject({ to: recipient, toTag: "bob" })
    expect(rows.find((r) => r.txHash === "0xA2")).toMatchObject({
      from: "alice",
      senderL2Address: sender,
    })
  })

  it("keeps a held row's tag over a later read's address", async () => {
    const { transactions, deps } = setup()
    const sender = "0x" + "5e".repeat(32)
    const receive = row({
      txHash: "0xA2",
      action: "receive",
      from: "alice",
      senderL2Address: sender,
      to: ACCOUNT,
    })
    await importHistoricActivity({
      ...deps([database("7", { scanned: [OLD], rows: [receive] })]),
      key: "first",
    })
    await importHistoricActivity({
      ...deps([database("7", { scanned: [OLD], rows: [{ ...receive, from: sender }] })]),
      key: "second",
    })

    expect((await transactions.all())[0]).toMatchObject({ from: "alice" })
  })
})

describe("transferScanNetworkOf", () => {
  it("reads the network off a cursor key, with or without an endpoint scope", () => {
    expect(transferScanNetworkOf(cursorKey(OLD))).toBe(OLD)
    expect(transferScanNetworkOf(`${TRANSFER_SCAN_CURSOR_PREFIX}${OLD}/abc123/${ACCOUNT}`)).toBe(
      OLD,
    )
    expect(transferScanNetworkOf(`${TRANSFER_SCAN_CURSOR_PREFIX}/${ACCOUNT}`)).toBeUndefined()
    expect(transferScanNetworkOf("@obsidion/transfer-scan/joined/v1/0xold/0xacc")).toBeUndefined()
  })
})

import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { OnNetwork } from "../../src/types/networkStamp"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord } from "../../src/engine/persistentStore"
import {
  createWithdrawals,
  decodeWithdrawals,
  KEY_WITHDRAWALS,
  storedWithdrawals,
  WITHDRAWAL_SUBMIT_TIMEOUT_MS,
  withdrawalFailure,
} from "../../src/engine/withdrawals"

const HASH = `0x${"ab".repeat(32)}` as const
const NO_CREDENTIAL = "Passkey assertion returned no credential"

const withdrawal = (over: Partial<WithdrawalRecord> = {}): OnNetwork<WithdrawalRecord> => ({
  localId: "wdraw_a",
  networkId: "0xnet",
  recipient: "0x0000000000000000000000000000000000000001",
  recipientProvenance: "saved-recipient",
  amount: "1",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "submitting",
  startTime: 1_000,
  ...over,
})

/** A blob as older builds wrote it: one object, keyed by lowercase localId. */
const FIXTURE_BLOB = JSON.stringify({
  wdraw_a: {
    localId: "wdraw_a",
    recipient: "0x0000000000000000000000000000000000000001",
    recipientProvenance: "saved-recipient",
    amount: "12.5",
    rawAmount: "12500000000000000000",
    tokenSymbol: "DAI",
    phase: "finalizing_l1",
    l2TxHash: HASH,
    blockNumber: 7,
    reorgEpoch: 1,
    startTime: 1_000,
    networkId: "0xnet",
  },
  WDRAW_A: {
    localId: "WDRAW_A",
    recipient: "0x0000000000000000000000000000000000000001",
    recipientProvenance: "saved-recipient",
    amount: "12.5",
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    phase: "l2_mined",
    finalizeTxHash: "0xf1",
    startTime: 1_000,
  },
  wdraw_b: {
    localId: "wdraw_b",
    recipient: "0x0000000000000000000000000000000000000002",
    recipientProvenance: "deposit-attested",
    amount: "3",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    phase: "done",
    startTime: 2_000,
    endTime: 3_000,
  },
  junk: { phase: "done" },
})

const open = (backend: MemoryBackend = memoryBackend()) =>
  createWithdrawals({ db: openDatabase(backend) })

/** Every record, newest first, once loaded. */
const listed = async (store: ReturnType<typeof open>) =>
  [...(await store.all())].sort((a, b) => b.startTime - a.startTime).map((r) => r.localId)

describe("decodeWithdrawals: the KEY_WITHDRAWALS blob", () => {
  it("decodes a blob older builds wrote: copies of one record merge, unstamped decimals read 18", () => {
    const records = new Map(decodeWithdrawals(FIXTURE_BLOB))
    expect([...records.keys()]).toEqual(["wdraw_a", "wdraw_b"])
    expect(records.get("wdraw_a")).toMatchObject({
      localId: "wdraw_a",
      phase: "finalizing_l1",
      l2TxHash: HASH,
      finalizeTxHash: "0xf1",
      rawAmount: "12500000000000000000",
      tokenDecimals: 18,
    })
    expect(records.get("wdraw_b")?.tokenDecimals).toBe(6)
  })

  it("holds nothing when the blob is absent or malformed", () => {
    for (const raw of [null, undefined, "", "{nope", "[]", "3"])
      expect(decodeWithdrawals(raw)).toEqual([])
  })

  it("reads another database's store records ahead of its blob", () => {
    const saved = withdrawal({ localId: "wdraw_a", phase: "done" })
    const db = new Map([
      ["acct/withdrawals/wdraw_a", encodeRecord(saved)],
      [KEY_WITHDRAWALS, FIXTURE_BLOB],
    ])
    const records = storedWithdrawals({
      get: (key) => db.get(key),
      keys: (prefix) => [...db.keys()].filter((key) => key.startsWith(prefix)),
    })
    expect(records.map((r) => [r.localId, r.phase])).toEqual([
      ["wdraw_a", "done"],
      ["wdraw_b", "done"],
    ])
  })
})

describe("withdrawals: the migration at open", () => {
  it("carries every blob record into the store, and leaves the blob as it was", async () => {
    const backend = memoryBackend()
    backend.entries.set(KEY_WITHDRAWALS, FIXTURE_BLOB)
    const store = open(backend)
    expect(await listed(store)).toEqual(["wdraw_b", "wdraw_a"])
    expect(store.list.get()).toMatchObject({ hydrated: true })
    expect((await store.byHash(HASH.toUpperCase().replace("0X", "0x")))?.localId).toBe("wdraw_a")
    expect(backend.entries.get(KEY_WITHDRAWALS)).toBe(FIXTURE_BLOB)
    expect(backend.entries.get("acct/meta/withdrawals")).toBe("1")
  })

  it("never reads the blob again: a later open keeps its own records", async () => {
    const backend = memoryBackend()
    backend.entries.set(KEY_WITHDRAWALS, FIXTURE_BLOB)
    const first = open(backend)
    await first.remove("wdraw_b")
    expect(await listed(open(backend))).toEqual(["wdraw_a"])
  })

  it("turns the blob's text into failure codes, a text no code names into its detail", async () => {
    const backend = memoryBackend()
    const text = (localId: string, error: string) => [
      localId,
      { ...withdrawal({ localId, phase: "failed" }), error },
    ]
    const blob = Object.fromEntries([
      text(
        "a",
        "This withdrawal was interrupted before it finished. The amount is still in your balance.",
      ),
      text("b", "Withdrawal transaction dropped in a reorg"),
      text("c", NO_CREDENTIAL),
    ])
    backend.entries.set(KEY_WITHDRAWALS, JSON.stringify(blob))
    const store = open(backend)
    expect((await store.get("a"))?.failure).toEqual({ code: "withdrawal.interrupted" })
    expect((await store.get("b"))?.failure).toEqual({ code: "withdrawal.reorged" })
    expect(await store.get("c")).toMatchObject({
      failure: { code: "withdrawal.failed", detail: NO_CREDENTIAL },
    })
    expect(await store.get("c")).not.toHaveProperty("error")
  })
})

describe("withdrawalFailure", () => {
  it("names every text a failed withdrawal carried", () => {
    expect(withdrawalFailure("This tab is not the active zk.money tab: it is closed")).toEqual({
      code: "withdrawal.inactiveTab",
    })
    expect(
      withdrawalFailure(
        "The withdrawal transaction was dropped or reverted. You can retry the link.",
      ),
    ).toEqual({ code: "withdrawal.dropped" })
    expect(withdrawalFailure("This transaction was not sent. Please try again later.")).toEqual({
      code: "sponsorship.paused",
    })
    expect(withdrawalFailure("Withdrawal failed")).toEqual({ code: "withdrawal.failed" })
  })
})

describe("withdrawals: reads and writes", () => {
  it("creates at the current record version, on its network, newest first", async () => {
    const store = open()
    await store.create(withdrawal({ localId: "wdraw_old", startTime: 1 }))
    const created = await store.create(withdrawal({ localId: "WDRAW_New", startTime: 2 }))
    expect(created).toMatchObject({ version: 2, networkId: "0xnet" })
    expect(created.endTime).toBeUndefined()
    expect((await store.get("wdraw_new"))?.localId).toBe("WDRAW_New")
    expect(await listed(store)).toEqual(["WDRAW_New", "wdraw_old"])
  })

  it("stamps the network a record names, lowercase", async () => {
    expect((await open().create(withdrawal({ networkId: "0xOther" }))).networkId).toBe("0xother")
  })

  it("stamps endTime on a record created terminal", async () => {
    const store = open()
    expect((await store.create(withdrawal({ phase: "done" }))).endTime).toBeTypeOf("number")
  })

  it("resolves a record by its burn hash in any case once mined", async () => {
    const store = open()
    await store.create(withdrawal())
    await store.apply("wdraw_a", { type: "mined", l2TxHash: HASH, blockNumber: 3 })
    expect((await store.get(HASH.toUpperCase().replace("0X", "0x")))?.localId).toBe("wdraw_a")
    expect((await store.byHash(HASH))?.phase).toBe("l2_mined")
    expect(await store.byHash(`0x${"cd".repeat(32)}`)).toBeUndefined()
  })

  it("adopts a record only when none holds its id or burn hash", async () => {
    const store = open()
    await store.create(withdrawal({ l2TxHash: HASH }))
    expect(await store.adopt(withdrawal({ localId: "other", l2TxHash: HASH }))).toMatchObject({
      adopted: false,
      record: { localId: "wdraw_a" },
    })
    expect((await store.adopt(withdrawal({ localId: "new" }))).adopted).toBe(true)
  })

  it("applies an event and answers undefined when the transition refuses or no record matches", async () => {
    const store = open()
    await store.create(withdrawal({ phase: "done", l2TxHash: HASH }))
    expect(await store.apply("wdraw_a", { type: "demoted" })).toBeUndefined()
    expect(await store.apply("nope", { type: "patch", fields: { phase: "done" } })).toBeUndefined()
    const failure = { code: "withdrawal.failed" as const }
    expect(
      await store.apply(HASH, { type: "patch", fields: { phase: "done", failure } }),
    ).toMatchObject({
      failure,
    })
  })

  it("a write that does not land rejects and leaves no trace", async () => {
    const backend = memoryBackend()
    const store = open(backend)
    await store.create(withdrawal())
    backend.failing.commits = true
    await expect(
      store.apply("wdraw_a", { type: "patch", fields: { phase: "done" } }),
    ).rejects.toThrow()
    backend.failing.commits = false
    expect((await store.get("wdraw_a"))?.phase).toBe("submitting")
  })

  it("a malformed mined hash rejects and writes nothing", async () => {
    const store = open()
    await store.create(withdrawal())
    await expect(
      store.apply("wdraw_a", { type: "mined", l2TxHash: "0x1", blockNumber: 1 }),
    ).rejects.toThrow()
    expect((await store.get("wdraw_a"))?.phase).toBe("submitting")
  })

  it("removes by localId or hash", async () => {
    const store = open()
    await store.create(withdrawal({ l2TxHash: HASH }))
    await store.remove(HASH)
    expect(await store.all()).toEqual([])
  })
})

describe("withdrawals: failInterrupted", () => {
  it("fails only pre-mine rows with no hash older than the timeout, once", async () => {
    const store = open()
    const now = 1_000 + WITHDRAWAL_SUBMIT_TIMEOUT_MS
    await store.create(withdrawal({ localId: "old" }))
    await store.create(withdrawal({ localId: "young", startTime: now - 1 }))
    await store.create(withdrawal({ localId: "sent", l2TxHash: HASH }))
    await store.create(withdrawal({ localId: "mined", phase: "l2_mined", l2TxHash: HASH }))
    const failed = await store.failInterrupted(now, WITHDRAWAL_SUBMIT_TIMEOUT_MS)
    expect(failed.map((r) => r.localId)).toEqual(["old"])
    expect(await store.get("old")).toMatchObject({
      phase: "failed",
      failure: { code: "withdrawal.interrupted" },
    })
    expect(await store.failInterrupted(now, WITHDRAWAL_SUBMIT_TIMEOUT_MS)).toEqual([])
  })
})

describe("withdrawals: migrateExecutors", () => {
  const deployment = { portal: "0xp" as const, l2Token: "0xt" }
  const burn = { executor: "0xe" as const, withdrawalFee: 4n }

  it("stamps each version 1 record its burn names, and leaves the rest for the next pass", async () => {
    const store = open()
    await store.create(withdrawal({ localId: "known", version: 1, deployment, l2TxHash: HASH }))
    await store.create(withdrawal({ localId: "unknown", version: 1, deployment }))
    await store.create(withdrawal({ localId: "current" }))
    const migrated = await store.migrateExecutors((r) => (r.l2TxHash ? burn : undefined))
    expect(migrated.map((r) => r.localId)).toEqual(["known"])
    expect(await store.get("known")).toMatchObject({
      version: 2,
      deployment: { executor: "0xe" },
      withdrawalFee: "4",
    })
    expect((await store.get("unknown"))?.version).toBe(1)
    expect(await store.migrateExecutors(() => burn)).toHaveLength(1)
  })
})

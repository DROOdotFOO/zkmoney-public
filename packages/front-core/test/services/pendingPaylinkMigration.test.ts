import { describe, expect, it, vi } from "vitest"

import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createNotifications, type Notifications } from "../../src/engine/notifications"
import { PendingPaylinkMigrationStore } from "../../src/core/services/paylink/PendingPaylinkMigrationStore"
import { PendingPaylinkMigrationService } from "../../src/core/services/paylink/PendingPaylinkMigrationService"
import type { CheckSpent } from "../../src/core/services/paylink/PaylinkClaimReconciler"
import type { IStorageAdapter } from "../../src/core/storages/adapter"
import type { PaylinkTransaction, Transaction } from "../../src/types"

const NOW_MS = 1_700_000_000_000
const FROM = 1_000
const UNTIL = 2_000
const NET = "net-a"

const row = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    token: {
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "",
      price: 1,
      address: "0xt",
      amount: 5,
    },
    timestamp: NOW_MS - 1000,
    status: "success",
    txHash: "0xRow",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    tokenAddress: "0xhistoric",
    fromClaimable: FROM,
    untilClaimable: UNTIL,
    ...overrides,
  } as PaylinkTransaction)

const unspent: CheckSpent = async (rows) => new Map(rows.map((r) => [r.txHash, false]))

/** The reclaim notices the bell holds. */
/** A bell store whose loaded facts are watched, as the session's are. */
function watchedNotifications(): Notifications {
  const notifications = createNotifications(openDatabase(memoryBackend()))
  notifications.events.subscribe(() => {})
  return notifications
}

const notices = (notifications: Notifications) => [...notifications.events.get().values()]

/** `checkSpent: null` builds a service that has no nullifier read yet. */
function build(rows: Transaction[], checkSpent: CheckSpent | null = unspent) {
  const store = new PendingPaylinkMigrationStore(new InMemoryStorageAdapter())
  const notifications = watchedNotifications()
  const service = new PendingPaylinkMigrationService({
    store,
    notifications,
    accountTransactions: async () => rows,
    checkSpent: checkSpent ?? undefined,
    now: () => NOW_MS,
  })
  return { store, notifications, service, rows }
}

describe("PendingPaylinkMigrationService", () => {
  it("records a locked row as waiting and skips rows without a claim window", async () => {
    const { store, service } = build([])
    await service.recordPending(
      [row(), row({ txHash: "0xNoWindow", untilClaimable: undefined })],
      NET,
    )
    expect(store.list()).toEqual([
      expect.objectContaining({
        txHash: "0xRow",
        untilClaimable: UNTIL,
        status: "waiting",
        tokenAddress: "0xhistoric",
      }),
    ])
  })

  it("retires the given links' records and reclaim notices, and keeps the others", async () => {
    // A legacy row carries no token address; the caller attributes it.
    const legacy = row({ txHash: "0xLegacy", tokenAddress: undefined })
    const other = row({ txHash: "0xOther", tokenAddress: "0xlive" })
    const { store, notifications, service } = build([row(), legacy, other])
    await service.recordPending([row(), legacy, other], NET)
    await service.reconcile(UNTIL + 10, NET)
    expect(notices(notifications)).toHaveLength(3)
    await service.retire(["0xRow", "0xLEGACY"])
    expect(store.list().map((r) => r.txHash)).toEqual(["0xOther"])
    expect(notices(notifications).map((n) => n.id)).toEqual(["paylink:reclaimable:0xother"])
  })

  it("records the other links' notices when one fails to save", async () => {
    const other = row({ txHash: "0xOther" })
    const store = new PendingPaylinkMigrationStore(new InMemoryStorageAdapter())
    const bell = watchedNotifications()
    const notifications: Notifications = {
      ...bell,
      record: (event) =>
        event.id === "paylink:reclaimable:0xrow"
          ? Promise.reject(new Error("disk"))
          : bell.record(event),
    }
    const service = new PendingPaylinkMigrationService({
      store,
      notifications,
      accountTransactions: async () => [row(), other],
      checkSpent: unspent,
      now: () => NOW_MS,
    })
    await service.recordPending([row(), other], NET)
    await service.reconcile(UNTIL + 10, NET)
    expect(notices(bell).map((n) => n.id)).toEqual(["paylink:reclaimable:0xother"])
  })

  it("leaves no record or reclaim notice when a retirement lands during reconciliation", async () => {
    let reached!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (reached = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const deferred: CheckSpent = async (rows) => {
      reached()
      await gate
      return new Map(rows.map((r) => [r.txHash, false]))
    }
    const second = row({ txHash: "0xSecond" })
    const { store, notifications, service } = build([row(), second], deferred)
    await service.recordPending([row(), second], NET)
    const reconciling = service.reconcile(UNTIL + 10, NET)
    await reading
    const retiring = service.retire(["0xRow", "0xSecond"])
    release()
    await Promise.all([reconciling, retiring])
    expect(store.list()).toEqual([])
    expect(notices(notifications)).toEqual([])
  })

  it("drops its queued and running work once its account no longer owns the stores", async () => {
    // Keys under the active account, as the web adapter scopes them; a session commit moves it.
    let account = "a"
    const written: string[] = []
    const data = new InMemoryStorageAdapter()
    const at = (key: string) => `${account}.${key}`
    const scoped: IStorageAdapter = {
      getItem: (key) => data.getItem(at(key)),
      setItem: (key, value) => {
        written.push(at(key))
        return data.setItem(at(key), value)
      },
      removeItem: (key) => {
        written.push(at(key))
        return data.removeItem(at(key))
      },
      clear: () => data.clear(),
    }
    let reached!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (reached = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const second = row({ txHash: "0xSecond" })
    const service = new PendingPaylinkMigrationService({
      store: new PendingPaylinkMigrationStore(scoped),
      notifications: watchedNotifications(),
      accountTransactions: async () => [row(), second],
      checkSpent: async (rows) => {
        reached()
        await gate
        return new Map(rows.map((r) => [r.txHash, false]))
      },
      ownsStorage: () => account === "a",
      now: () => NOW_MS,
    })
    await service.recordPending([row(), second], NET)
    const reconciling = service.reconcile(UNTIL + 10, NET)
    await reading
    const retiring = service.retire(["0xRow", "0xSecond"])
    const recording = service.recordPending([row({ txHash: "0xThird" })], NET)
    account = "b"
    release()
    await Promise.all([reconciling, retiring, recording])
    expect(written.filter((key) => key.startsWith("b."))).toEqual([])
  })

  it("stays waiting inside the window and mints nothing", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()], NET)
    await service.reconcile(FROM + 10, NET)
    expect(store.get("0xrow")!.status).toBe("waiting")
    expect(notices(notifications)).toHaveLength(0)
  })

  it("flips to claimable past expiry and mints one reclaim notification, fire-once", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()], NET)
    await service.reconcile(UNTIL + 1, NET)
    await service.reconcile(UNTIL + 2, NET)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notices(notifications)).toEqual([
      {
        id: "paylink:reclaimable:0xrow",
        at: NOW_MS,
        kind: "reclaimable",
        data: { txHash: "0xRow" },
      },
    ])
  })

  it("a stale probe never pulls a claimable record back to waiting", async () => {
    const { store, service } = build([row()])
    await service.recordPending([row()], NET)
    await service.reconcile(UNTIL + 1, NET)
    await service.recordPending([row()], NET)
    expect(store.get("0xRow")!.status).toBe("claimable")
  })

  it("resolves silently when the recipient claimed while it waited", async () => {
    const rows = [row()]
    const { store, notifications, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[], NET)
    rows[0] = row({ isClaimed: true })
    await service.reconcile(UNTIL + 1, NET)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "claimed" })
    expect(notices(notifications)).toHaveLength(0)
  })

  it("resolves a claimable record once its refund lands", async () => {
    const rows = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[], NET)
    await service.reconcile(UNTIL + 1, NET)
    rows[0] = row({ isRefunded: true })
    await service.reconcile(UNTIL + 2, NET)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "refunded" })
  })

  it("resolves as unavailable when the row is gone", async () => {
    const rows: Transaction[] = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[], NET)
    rows.length = 0
    await service.reconcile(FROM + 10, NET)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "unavailable" })
  })

  it("resolves as migrated when the escrow was exited by the frozen-generation path", async () => {
    const rows = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[], NET)
    rows[0] = row({ isMigrated: true })
    await service.reconcile(UNTIL + 1, NET)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "migrated" })
  })

  it("leaves records untouched when the transactions read throws or returns null", async () => {
    const store = new PendingPaylinkMigrationStore(new InMemoryStorageAdapter())
    const notifications = watchedNotifications()
    const throwing = new PendingPaylinkMigrationService({
      store,
      notifications,
      accountTransactions: async () => {
        throw new Error("boom")
      },
      now: () => NOW_MS,
    })
    await throwing.recordPending([row()], NET)
    await expect(throwing.reconcile(UNTIL + 1, NET)).resolves.toHaveLength(1)
    const empty = new PendingPaylinkMigrationService({
      store,
      notifications,
      accountTransactions: async () => null,
      now: () => NOW_MS,
    })
    await expect(empty.reconcile(UNTIL + 1, NET)).resolves.toHaveLength(1)
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(notices(notifications)).toHaveLength(0)
  })

  it("re-opens a resolved record when the probe reports the escrow locked again", async () => {
    const rows = [row({ isClaimed: true })]
    const { store, notifications, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[], NET)
    await service.reconcile(FROM + 10, NET)
    expect(store.get("0xRow")!.status).toBe("resolved")
    rows[0] = row()
    await service.recordPending(rows as PaylinkTransaction[], NET)
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(store.get("0xRow")!.resolvedReason).toBeUndefined()
    await service.reconcile(UNTIL + 1, NET)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notices(notifications)).toHaveLength(1)
  })

  it("resolves as claimed instead of notifying when the nullifier is already spent", async () => {
    const { store, notifications, service } = build([row()], async () => new Map([["0xRow", true]]))
    await service.recordPending([row()], NET)
    await service.reconcile(UNTIL + 1, NET)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "claimed" })
    expect(notices(notifications)).toHaveLength(0)
  })

  it("defers the notice while the spent check fails, then mints once it reads unspent", async () => {
    const checkSpent = vi
      .fn<Parameters<CheckSpent>, ReturnType<CheckSpent>>()
      .mockRejectedValueOnce(new Error("rpc"))
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(new Map([["0xRow", false]]))
    const { store, notifications, service } = build([row()], checkSpent)
    await service.recordPending([row()], NET)
    await service.reconcile(UNTIL + 1, NET)
    await service.reconcile(UNTIL + 2, NET)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notices(notifications)).toHaveLength(0)
    await service.reconcile(UNTIL + 3, NET)
    expect(notices(notifications)).toHaveLength(1)
    // The read happens once per notice: an existing entry short-circuits it.
    await service.reconcile(UNTIL + 4, NET)
    expect(checkSpent).toHaveBeenCalledTimes(3)
  })

  it("advances records but mints nothing until a spent check exists", async () => {
    const { store, notifications, service } = build([row()], null)
    await service.recordPending([row()], NET)
    await service.reconcile(UNTIL + 1, NET)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notices(notifications)).toHaveLength(0)
  })

  it("stamps the run's network, lowercase, and leaves other networks' records alone", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()], "Net-A")
    expect(store.get("0xRow")!.networkId).toBe(NET)
    await service.reconcile(UNTIL + 1, "net-b")
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(notices(notifications)).toHaveLength(0)
    await service.reconcile(UNTIL + 1, "NET-A")
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notices(notifications)).toHaveLength(1)
  })

  it("survives a reload — records persist through the adapter", async () => {
    const adapter = new InMemoryStorageAdapter()
    const first = new PendingPaylinkMigrationStore(adapter)
    await first.set({
      txHash: "0xRow",
      untilClaimable: UNTIL,
      flavor: "direct",
      status: "waiting",
      detectedAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    })
    const second = new PendingPaylinkMigrationStore(adapter)
    await second.load()
    expect(second.get("0xrow")?.status).toBe("waiting")
  })
})

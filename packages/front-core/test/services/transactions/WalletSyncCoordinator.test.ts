import { memoryBackend } from "../../../src/engine/memoryBackend"
import { openDatabase } from "../../../src/engine/database"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IStorageAdapter } from "../../../src/core/storages/adapter"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import { memoryStore } from "../../../src/engine/store"
import { WalletSyncCoordinator } from "../../../src/core/services/transactions/WalletSyncCoordinator"
import { TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS } from "../../../src/core/services/transactions/TransferEventScanner"
import { BalanceStorage } from "../../../src/core/storages/BalanceStorage"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { seededActivity } from "../../utils/activityFixture"
import type { RecordSet } from "../../../src/engine/persistentStore"
import type { Transaction } from "../../../src/types/transactions"
import { startRuntime } from "../../../src/engine/runtime"
import { transferScanTask } from "../../../src/engine/transferScan"

const ME = "0x" + "aa".repeat(32)

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
    clear: async () => m.clear(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const stops: (() => void)[] = []

function harness(
  opts: {
    head?: () => number
    balance?: () => bigint
    others?: () => Record<string, bigint>
    withdrawalsLoaded?: boolean
  } = {},
) {
  const writes: { scope: string; token: string; balance: bigint; anchor?: number }[] = []
  const txs: { status: string; action?: string; txHash: string; timestamp: number }[] = []
  const withdrawals = memoryStore<{ records: readonly WithdrawalRecord[]; hydrated: boolean }>({
    records: [],
    hydrated: opts.withdrawalsLoaded ?? true,
  })
  const listIncoming = vi.fn(async (): Promise<ScannedTransferEvent[]> => [])
  const readBalance = vi.fn(async () => opts.balance?.() ?? 0n)
  const readBalances = async () => ({ "0xtok": await readBalance(), ...opts.others?.() })
  const source = {
    headBlock: vi.fn(async () => opts.head?.() ?? 100),
    blockTimestampMs: async (b: number) => b * 1000,
    anchorBlock: vi.fn(async () => 100),
    listIncoming,
    readSnapshot: vi.fn(async () => ({
      events: await listIncoming(),
      balances: await readBalances(),
      anchorBlock: 100,
    })),
    readBalanceSnapshot: vi.fn(async () => ({ balances: await readBalances(), anchorBlock: 101 })),
  }
  const transactions = memoryStore<RecordSet<Transaction>>({
    records: [],
    loaded: true,
    failed: false,
  })
  const publish = () =>
    transactions.set({ records: [...txs] as Transaction[], loaded: true, failed: false })
  const tags = { resolveL2: vi.fn(async (): Promise<null> => null) }
  const balanceStore = {
    updateBalance: vi.fn<
      (
        scope: string,
        token: string,
        balance: bigint,
        anchor?: number,
        opts?: { strict?: boolean },
      ) => Promise<boolean>
    >(
      async (scope, token, balance, anchor) => (
        writes.push({ scope, token, balance, anchor }), true
      ),
    ),
  }
  const milestones = { mark: vi.fn() }
  const activity = seededActivity()
  const coordinator = new WalletSyncCoordinator({
    source,
    db: activity.db,
    transactionStore: activity,
    tags,
    contacts: { findByL2Address: async () => null },
    token: { address: "0xtok", symbol: "DAI", decimals: 18 },
    balance: {
      store: balanceStore,
      scope: "net:me",
      tokenAddress: "0xtok",
    },
    transactions: transactions.readonly,
    withdrawals: withdrawals.readonly,
    milestones,
  })
  const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }
  const scan = transferScanTask({}, (pass) => coordinator.pass(ctx, pass))
  const runtime = startRuntime([scan], {
    db: openDatabase(memoryBackend()),
    milestones: { after: async () => true, reached: () => false },
    visible: memoryStore(true).readonly,
  })
  const wake = () => runtime.wake(scan)
  const detach = coordinator.attach({ wake, live: () => true })
  const stop = () => {
    runtime.stop()
    detach()
  }
  stops.push(stop)
  return {
    /** Settles once the runtime's first pass ends. */
    start: wake,
    wake,
    stop,
    milestones,
    coordinator,
    ctx,
    writes,
    txs,
    listIncoming,
    readBalance,
    withdrawals,
    source,
    publish,
    tags,
    balanceStore,
  }
}

/** Fires the debounce and lets the resulting tick settle. */
const flushRefresh = async () => {
  await vi.advanceTimersByTimeAsync(600)
}

describe("WalletSyncCoordinator", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.useRealTimers()
  })

  it("reads the balance on the synced tick and writes it with the anchor; UI never fetches", async () => {
    const h = harness({ balance: () => 42n })
    await h.start()
    expect(h.readBalance).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual([{ scope: "net:me", token: "0xtok", balance: 42n, anchor: 100 }])
    h.stop()
  })

  it("refresh() ticks the active coordinator", async () => {
    const h = harness()
    await h.start()
    await WalletSyncCoordinator.refresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("refresh() before any coordinator started settles after the next start's first tick", async () => {
    let settled = false
    const early = WalletSyncCoordinator.refresh().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)

    const h = harness({ balance: () => 7n })
    await h.start()
    await early
    expect(settled).toBe(true)
    expect(h.writes).toHaveLength(1) // the balance was really read before the caller resumed
    h.stop()
  })

  it("refresh() with no coordinator ever starting gives up after the wait cap", async () => {
    let settled = false
    void WalletSyncCoordinator.refresh().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(true)
  })

  it("a new terminal send triggers one debounced refresh; pending progress and receives do not", async () => {
    const h = harness()
    await h.start()
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    h.txs.push({ status: "pending", txHash: "0x1", timestamp: 1 })
    h.publish()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    // The tick's own receive insert must not re-trigger the tick.
    h.txs.push({ status: "success", action: "receive", txHash: "0x2", timestamp: 2 })
    h.publish()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    h.txs[0].status = "success"
    h.publish()
    h.publish() // race legs collapse into one refresh
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("a pending send that settles outside the rows read triggers a refresh", async () => {
    const h = harness()
    h.txs.push({ status: "pending", txHash: "0x1", timestamp: 1 })
    h.publish()
    await h.start()
    expect(h.readBalance).toHaveBeenCalledTimes(1)
    // Settled past the newest rows: it leaves the pending rows and is in no other read.
    h.txs.splice(0, 1)
    h.publish()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("a withdrawal leaving `submitting` triggers a refresh", async () => {
    const h = harness()
    await h.start()
    const record = { localId: "wdraw_1", phase: "l2_mined" } as WithdrawalRecord
    h.withdrawals.set({ records: [record], hydrated: true })
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("a withdrawal list that lands from storage triggers nothing", async () => {
    const h = harness({ withdrawalsLoaded: false })
    await h.start()
    const record = { localId: "wdraw_1", phase: "l2_mined" } as WithdrawalRecord
    h.withdrawals.set({ records: [record], hydrated: true })
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it("stop() drops the store watches and the pending refresh", async () => {
    const h = harness()
    await h.start()
    h.txs.push({ status: "success", txHash: "0x1", timestamp: 1 })
    h.publish()
    h.stop()
    await flushRefresh()
    h.publish()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)
  })

  it("discards a timed-out snapshot even after a newer balance is persisted", async () => {
    const h = harness()
    const late = deferred<bigint>()
    const entered = deferred<void>()
    h.readBalance.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    h.readBalance.mockResolvedValue(20n)
    const storage = BalanceStorage.get(memStorage())
    h.balanceStore.updateBalance.mockImplementation((scope, token, value, anchor, opts) =>
      storage.updateBalance(scope, token, value, anchor, opts),
    )
    const started = h.start()
    await entered.promise
    // A cursorless first pass is a catch-up, so its read gets the longer bound.
    await vi.advanceTimersByTimeAsync(TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS + 1)
    await started
    await h.wake()
    expect(await storage.getBalance("net:me", "0xtok")).toBe(20n)
    late.resolve(100n)
    await vi.advanceTimersByTimeAsync(0)
    expect(await storage.getBalance("net:me", "0xtok")).toBe(20n)
    expect(h.balanceStore.updateBalance).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it("does not publish an in-flight snapshot after stop", async () => {
    const h = harness()
    const late = deferred<bigint>()
    const entered = deferred<void>()
    h.readBalance.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    const started = h.start()
    await entered.promise
    h.stop()
    late.resolve(100n)
    await started
    expect(h.writes).toEqual([])
  })

  it("publishes balance even when transfer attribution fails", async () => {
    const h = harness({ balance: () => 7n })
    h.listIncoming.mockResolvedValue([
      {
        from: "0xother",
        to: ME,
        txHash: "0xtx",
        amount: "7",
        blockNumber: 100,
        senderTag: "alice",
      },
    ])
    h.tags.resolveL2.mockRejectedValue(new Error("registry unavailable"))
    await h.start()
    expect(h.writes).toEqual([{ scope: "net:me", token: "0xtok", balance: 7n, anchor: 100 }])
    h.stop()
  })

  it("uses the snapshot anchor rather than the pre-sync anchor", async () => {
    const h = harness()
    h.source.anchorBlock.mockResolvedValue(90)
    await h.start()
    expect(h.writes[0].anchor).toBe(100)
    h.stop()
  })

  it("forces a shared full pass when refresh arrives during the head read", async () => {
    const h = harness()
    const head = deferred<number>()
    const entered = deferred<void>()
    h.source.headBlock.mockImplementationOnce(() => {
      entered.resolve()
      return head.promise
    })
    const started = h.start()
    await entered.promise
    const first = WalletSyncCoordinator.refresh()
    const second = WalletSyncCoordinator.refresh()
    head.resolve(100)
    await Promise.all([started, first, second])
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(2)
    expect(h.writes).toHaveLength(2)
    h.stop()
  })

  it("marks the first balance on its first published balance only", async () => {
    const h = harness({ balance: () => 5n })
    h.source.headBlock.mockRejectedValueOnce(new Error("node down"))
    await h.start()
    expect(h.writes).toEqual([])
    expect(h.milestones.mark).not.toHaveBeenCalledWith("firstBalance")
    await h.wake()
    expect(h.writes).toHaveLength(1)
    expect(h.milestones.mark).toHaveBeenCalledWith("firstBalance")
    h.stop()
  })

  it("fails the pass when marking the first balance throws", async () => {
    const h = harness({ balance: () => 5n })
    h.milestones.mark.mockImplementation(() => {
      throw new Error("mark failed")
    })
    expect(await h.coordinator.pass(h.ctx, { full: true })).toBe(false)
    h.stop()
  })

  it("marks the history at head only on a pass that read up to head", async () => {
    const h = harness()
    h.source.readSnapshot.mockRejectedValueOnce(
      new Error("PXE anchor changed during wallet snapshot; retry the read"),
    )
    await h.start()
    expect(h.milestones.mark).not.toHaveBeenCalledWith("historyAtHead")

    // PXE behind head: the balance publishes, the history does not count as read.
    h.source.readSnapshot.mockResolvedValueOnce({
      events: [],
      balances: { "0xtok": 0n },
      anchorBlock: 60,
    })
    await h.wake()
    expect(h.milestones.mark).toHaveBeenCalledWith("firstBalance")
    expect(h.milestones.mark).not.toHaveBeenCalledWith("historyAtHead")

    await h.wake()
    expect(h.milestones.mark).toHaveBeenCalledWith("historyAtHead")
    h.stop()
  })

  it("writes every token the snapshot read at its anchor, Main's first", async () => {
    const h = harness({ balance: () => 42n, others: () => ({ "0xsav": 7n }) })
    await h.start()
    expect(h.writes).toEqual([
      { scope: "net:me", token: "0xtok", balance: 42n, anchor: 100 },
      { scope: "net:me", token: "0xsav", balance: 7n, anchor: 100 },
    ])
    await WalletSyncCoordinator.refreshBalance()
    expect(h.writes.slice(-2)).toEqual([
      { scope: "net:me", token: "0xtok", balance: 42n, anchor: 101 },
      { scope: "net:me", token: "0xsav", balance: 7n, anchor: 101 },
    ])
    h.stop()
  })

  it("refreshBalance reads the balance alone and writes it with its anchor", async () => {
    let balance = 5n
    const h = harness({ balance: () => balance })
    await h.start()
    balance = 9n
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(1)
    expect(h.writes.at(-1)).toEqual({ scope: "net:me", token: "0xtok", balance: 9n, anchor: 101 })
    h.stop()
  })

  it("refreshBalance coalesces a burst into one read in flight plus one trailing", async () => {
    const h = harness({ balance: () => 4n })
    await h.start()
    await Promise.all([1, 2, 3, 4].map(() => WalletSyncCoordinator.refreshBalance()))
    expect(h.source.readBalanceSnapshot).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("refreshBalance retries a failed read before falling back to a full pass", async () => {
    const h = harness({ balance: () => 3n })
    await h.start()
    h.source.readBalanceSnapshot.mockRejectedValueOnce(new Error("PXE anchor changed"))
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readBalanceSnapshot).toHaveBeenCalledTimes(2)
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(1)

    h.source.readBalanceSnapshot.mockRejectedValue(new Error("PXE anchor changed"))
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(2)
    h.stop()
  })

  // A recovering device's passes run for tens of seconds; a claimed deposit shows without them.
  it("refreshBalance never waits behind a pass in flight", async () => {
    let balance = 0n
    const h = harness({ balance: () => balance })
    await h.start()
    const late = deferred<bigint>()
    const entered = deferred<void>()
    h.readBalance.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    const pass = h.wake()
    await entered.promise
    balance = 9n

    await WalletSyncCoordinator.refreshBalance()
    expect(h.writes.at(-1)).toMatchObject({ balance: 9n, anchor: 101 })
    late.resolve(9n)
    await pass
    h.stop()
  })

  describe("confirming a refreshed balance", () => {
    it("confirms a read stored durably after the call", async () => {
      let balance = 5n
      const h = harness({ balance: () => balance })
      await h.start()
      balance = 9n

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(true)
      expect(h.balanceStore.updateBalance).toHaveBeenLastCalledWith("net:me", "0xtok", 9n, 101, {
        strict: true,
      })
      h.stop()
    })

    it("confirms nothing when every read fails, even after the fallback pass publishes", async () => {
      const h = harness({ balance: () => 3n })
      await h.start()
      h.source.readBalanceSnapshot.mockRejectedValue(new Error("PXE anchor changed"))

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(false)
      expect(h.source.readSnapshot).toHaveBeenCalledTimes(2)
      h.stop()
    })

    it("confirms nothing when the fallback pass fails too", async () => {
      const h = harness({ balance: () => 3n })
      await h.start()
      h.source.readBalanceSnapshot.mockRejectedValue(new Error("PXE anchor changed"))
      h.source.readSnapshot.mockRejectedValue(new Error("node down"))

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(false)
      h.stop()
    })

    it("confirms nothing with no running coordinator", async () => {
      expect(await WalletSyncCoordinator.confirmBalance()).toBe(false)
    })

    it("confirms nothing when storage refuses the write", async () => {
      const h = harness({ balance: () => 3n })
      await h.start()
      h.balanceStore.updateBalance.mockImplementation(async (...args) => {
        if (args[4]?.strict) throw new Error("QuotaExceededError")
        return true
      })

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(false)
      h.stop()
    })

    it("confirms nothing when a newer read is already stored", async () => {
      const h = harness({ balance: () => 3n })
      await h.start()
      h.balanceStore.updateBalance.mockResolvedValue(false)

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(false)
      h.stop()
    })

    it("confirms on Main's write alone when another balance's read is passed over", async () => {
      const h = harness({ balance: () => 3n, others: () => ({ "0xshares": 1n }) })
      await h.start()
      h.balanceStore.updateBalance.mockImplementation(async (_scope, token) => token === "0xtok")

      expect(await WalletSyncCoordinator.confirmBalance()).toBe(true)
      h.stop()
    })

    // A pass that read before an import publishes at the same anchor as the read after it.
    it("waits for a pass already in flight, so its older read never lands last", async () => {
      let balance = 0n
      const h = harness({ balance: () => balance })
      await h.start()
      h.source.readBalanceSnapshot.mockImplementation(async () => ({
        balances: { "0xtok": await h.readBalance() },
        anchorBlock: 100,
      }))
      const late = deferred<bigint>()
      const entered = deferred<void>()
      h.readBalance.mockImplementationOnce(() => {
        entered.resolve()
        return late.promise
      })
      const pass = h.wake()
      await entered.promise
      balance = 9n

      const confirmed = WalletSyncCoordinator.confirmBalance()
      await vi.advanceTimersByTimeAsync(0)
      late.resolve(0n)
      await pass

      expect(await confirmed).toBe(true)
      expect(h.writes.at(-1)).toMatchObject({ balance: 9n, anchor: 100 })
      h.stop()
    })
  })
})

/**
 * Home counts a stored Savings claim as arriving until its destination's balance was read after the
 * claim's `storedAt`. A read that resolved before the claim must not look like one that holds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IStorageAdapter } from "../../../src/core/storages/adapter"
import { WalletSyncCoordinator } from "../../../src/core/services/transactions/WalletSyncCoordinator"
import { BalanceStorage } from "../../../src/core/storages/BalanceStorage"
import { seededActivity } from "../../utils/activityFixture"

const E18 = 10n ** 18n
const SHARES = "0xshares"

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
    clear: async () => m.clear(),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("a balance read in flight across a claim", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("is stamped with when its read resolved, not when it was stored", async () => {
    vi.setSystemTime(1_000)
    let shares = 6n * E18
    const read = deferred()
    // The snapshot's closing header read queues in PXE behind the claim's store_deposit job.
    const release = deferred()
    const storage = BalanceStorage.get(memStorage())
    const activity = seededActivity()
    const coordinator = new WalletSyncCoordinator({
      source: {
        headBlock: async () => 100,
        blockTimestampMs: async (b: number) => b * 1000,
        anchorBlock: async () => 100,
        listIncoming: async () => [],
        readSnapshot: async () => {
          const balances = { "0xtok": 0n, [SHARES]: shares }
          const readAt = { "0xtok": Date.now(), [SHARES]: Date.now() }
          read.resolve()
          await release.promise
          return { events: [], balances, readAt, anchorBlock: 100 }
        },
        readBalanceSnapshot: async () => ({
          balances: { "0xtok": 0n, [SHARES]: shares },
          anchorBlock: 100,
        }),
      },
      db: activity.db,
      transactionStore: activity,
      tags: { resolveL2: async () => null },
      contacts: { findByL2Address: async () => null },
      token: { address: "0xtok", symbol: "DAI", decimals: 18 },
      balance: { store: storage, scope: "net:me", tokenAddress: "0xtok" },
    })

    const pass = coordinator.pass(
      { accountAddress: "0xme", accountTag: "me", networkId: "net" },
      { full: true },
    )
    await read.promise
    // The settle pass stores the move in's 5-share claim, then stamps it.
    vi.setSystemTime(2_000)
    shares += 5n * E18
    const storedAt = Date.now()
    vi.setSystemTime(2_050)
    release.resolve()
    expect(await pass).toBe(true)

    const record = storage.list().find((r) => r.tokenAddress === SHARES)!
    expect(BigInt(record.balance)).toBe(6n * E18)
    // What the balances and useSavingsContext report as the read time.
    expect(record.readAt ?? record.updatedAt).toBeLessThan(storedAt)
  })
})

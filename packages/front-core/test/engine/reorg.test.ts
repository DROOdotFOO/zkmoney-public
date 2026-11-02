// @vitest-environment node
/**
 * The reorg task passes every 30 s while shown, once the wallet is ready. A woken pass then wakes
 * the withdrawal tracker and, once the first balance is in, syncs the PXE: before it, the balance
 * read's own sync brings note state up, and a sync here would move the anchor that read checks.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { reorg } from "../../src/engine/reorg"
import { startRuntime, task } from "../../src/engine/runtime"
import { seededActivity } from "../utils/activityFixture"
import { later, periodicSteps, sessions, table } from "./taskTable"

const BURN = `0x${"11".repeat(32)}` as const
const FOREIGN = `0x${"22".repeat(32)}` as const

/**
 * A runtime per session over the reorg task and a tracker; `order` logs passes, tracker runs and syncs.
 * A `hanging` tracker's run ends only on abort.
 */
function harness(records: Partial<WithdrawalRecord>[] = [], { hanging = false } = {}) {
  const order: string[] = []
  const reached = new Set<string>()
  const h = sessions(startRuntime, {
    after: async () => true,
    reached: (m: string) => reached.has(m),
  })
  const reads: string[] = []
  const wallet = later<never>("wallet")
  const ready = () =>
    wallet.ready({
      networkId: "net-A",
      node: {
        getTxReceipt: async (hash: unknown) => {
          reads.push(String(hash))
          return { status: TxStatus.PROVEN, blockNumber: 7 }
        },
      },
      pxe: { sync: async () => void order.push("sync") },
    } as never)
  const tracker = task("tracker", {
    needs: { wallet: wallet.resource },
    every: "once",
    run: ({ signal }) =>
      new Promise<void>((resolve) => {
        order.push("tracker")
        if (!hanging) return resolve()
        signal.addEventListener("abort", () => resolve())
      }),
  })
  h.tasks.push(
    tracker,
    reorg({
      wallet: wallet.resource,
      activity: seededActivity(),
      withdrawals: { all: async () => records as WithdrawalRecord[], apply: vi.fn() },
      sipaDeposits: { load: async () => void order.push("pass"), list: () => [], demote: vi.fn() },
      tracker,
      onOutcome: () => {},
    }),
  )
  const count = (what: string) => order.filter((o) => o === what).length
  return { ...h, order, reached, reads, ready, count }
}

let end = () => {}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  end()
  vi.useRealTimers()
})

it("passes once the wallet is ready, every 30 s while visible, at once on show", async () => {
  const h = harness()
  end = h.end
  await table(periodicSteps(h, h.ready, 30_000), () => h.count("pass"))
})

it("reads a late wallet's node, skipping records on another network", async () => {
  const h = harness([
    { localId: "a", l2TxHash: BURN, phase: "l2_mined", networkId: "net-A" },
    { localId: "b", l2TxHash: FOREIGN, phase: "l2_mined", networkId: "net-B" },
  ])
  end = h.end
  h.start()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.reads).toEqual([])

  h.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.reads).toEqual([BURN])
})

it("a woken pass wakes the tracker, then syncs once the first balance is in", async () => {
  const h = harness()
  end = h.end
  h.ready()
  h.start()
  await vi.advanceTimersByTimeAsync(0)
  // The tracker's own run and the wake's; no sync before the first balance.
  expect([h.count("pass"), h.count("tracker"), h.count("sync")]).toEqual([1, 2, 0])

  h.reached.add("firstBalance")
  await vi.advanceTimersByTimeAsync(30_000)
  expect([h.count("pass"), h.count("tracker"), h.count("sync")]).toEqual([2, 2, 0])

  h.hide()
  h.show()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.order.slice(-3)).toEqual(["pass", "tracker", "sync"])
})

it("a woken pass syncs while the tracker's run is still pending", async () => {
  const h = harness([], { hanging: true })
  end = h.end
  h.reached.add("firstBalance")
  h.ready()
  h.start()
  await vi.advanceTimersByTimeAsync(0)
  expect([h.count("pass"), h.count("tracker"), h.count("sync")]).toEqual([1, 1, 1])
})

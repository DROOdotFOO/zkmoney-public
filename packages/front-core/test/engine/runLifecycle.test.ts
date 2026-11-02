import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  TokenService,
  WalletBalances,
} from "@obsidion/sdk"
import { WalletSyncCoordinator } from "../../src/core/services/transactions/WalletSyncCoordinator"
import { createCatchUp } from "../../src/engine/catchUp"
import { seededActivity } from "../utils/activityFixture"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { fixed } from "../../src/engine/resource"
import { memoryStore } from "../../src/engine/store"
import { transferScan, type TransferScan } from "../../src/engine/transferScan"

/**
 * What the transfer scan holds across its run lifecycle. An aborted or stopped run lets go of the
 * catch-up flag, `drained()`, its wakers and a waiting `refresh()` at once, even while its PXE read
 * never answers, and a run that was never started holds nothing past its first pass.
 */

const TOKEN = { address: "0xtok", symbol: "DAI", decimals: 18 }
const flush = () => vi.advanceTimersByTimeAsync(0)
const hung = new Promise<never>(() => {})

function harness() {
  const activity = seededActivity()
  const catchUp = createCatchUp()
  const visible = memoryStore(true)
  const reads = { hang: false, count: 0 }
  const balances = async (): Promise<WalletBalances> => ({ [TOKEN.address]: 1n })
  let coordinator!: WalletSyncCoordinator
  const scan = transferScan({
    wallet: fixed("wallet", { networkId: "net" } as ObsidionWallet),
    contractService: fixed("contractService", {} as ContractService),
    account: fixed("account", { getAddress: () => "0xme" } as unknown as ObsidionAccount),
    token: fixed("token", {
      metadata: TOKEN,
      readBalanceAssumingSynced: async () => 1n,
    } as unknown as TokenService),
    tag: () => "me",
    visible: visible.readonly,
    coordinator: ({ token }, readBalances) =>
      (coordinator = new WalletSyncCoordinator({
        source: {
          headBlock: async () => 100,
          anchorBlock: async () => 100,
          blockTimestampMs: async (block) => block * 1_000,
          listIncoming: async () => [],
          readSnapshot: async () => {
            reads.count++
            if (reads.hang) return hung
            return { events: [], balances: await readBalances(), anchorBlock: 100 }
          },
          readBalanceSnapshot: async () => ({ balances: await balances(), anchorBlock: 100 }),
        },
        db: activity.db,
        transactionStore: activity,
        tags: { resolveL2: async () => null },
        contacts: { findByL2Address: async () => null },
        token: token.metadata,
        balance: {
          store: { updateBalance: async () => true },
          scope: "net:me",
          tokenAddress: TOKEN.address,
        },
        boot: { notesSynced: () => {}, historyReplayed: () => {} },
        catchUp,
      })),
  })
  return {
    visible,
    reads,
    scan,
    catchingUp: catchUp.status.get,
    coordinator: () => coordinator,
  }
}

type Harness = ReturnType<typeof harness>
const running: { runtime: Runtime; scan: TransferScan }[] = []

function run(h: Harness, backend: MemoryBackend = memoryBackend()) {
  const runtime = startRuntime([h.scan.task], {
    db: openDatabase(backend),
    milestones: { after: async () => true, reached: () => false },
    visible: h.visible.readonly,
  })
  running.push({ runtime, scan: h.scan })
  return runtime
}

/** Whether `promise` has settled once pending work and timers up to now have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  await flush()
  return done
}

describe("transfer scan run lifecycle", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const { runtime, scan } of running.splice(0)) {
      runtime.stop()
      scan.dispose()
    }
    vi.useRealTimers()
  })

  it("a refresh issued before the runtime starts settles with its first pass", async () => {
    const h = harness()
    const early = WalletSyncCoordinator.refresh()
    expect(await settled(early)).toBe(false)
    run(h)
    expect(await settled(early)).toBe(true)
    expect(h.reads.count).toBe(1)
    expect(h.catchingUp()).toBe(false)
  })

  it.each([
    ["before the runtime starts", false],
    ["while hidden", true],
  ])(
    "a refresh issued %s settles at its cap while the pass that took it hangs",
    async (_, hide) => {
      const h = harness()
      h.reads.hang = true
      if (hide) {
        h.visible.set(false)
        run(h)
        await flush()
      }
      const early = WalletSyncCoordinator.refresh()
      if (hide) h.visible.set(true)
      else run(h)
      await flush()
      expect(h.reads.count).toBe(1)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(await settled(early)).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await settled(early)).toBe(true)
    },
  )

  it.each([
    ["hidden", (h: Harness, rt: Runtime) => (void rt, h.visible.set(false))],
    ["stopped", (_h: Harness, rt: Runtime) => rt.stop()],
  ])("a pass %s mid-read lets go of everything it holds at once", async (_, end) => {
    const h = harness()
    h.reads.hang = true
    const backend = memoryBackend()
    const rt = run(h, backend)
    await flush()
    // A fresh device: the first pass holds the activity skeleton while its read hangs.
    expect(h.catchingUp()).toBe(true)
    const woken = rt.wake(h.scan.task)
    const drained = h.coordinator().drained()
    expect(await settled(drained)).toBe(false)

    end(h, rt)
    expect(h.catchingUp()).toBe(false)
    expect(await settled(drained)).toBe(true)
    expect(await settled(woken)).toBe(true)
    // Ended, not failed: no backoff is kept.
    expect([...backend.entries.keys()].filter((k) => k.startsWith("runtime/"))).toEqual([])
  })

  it("a restart passes while the stopped pass's read still hangs", async () => {
    const h = harness()
    h.reads.hang = true
    const first = run(h)
    await flush()
    first.stop()
    h.scan.dispose()

    const again = harness()
    run(again)
    await flush()
    expect(again.reads.count).toBe(1)
    expect([h.catchingUp(), again.catchingUp()]).toEqual([false, false])
    expect(await settled(again.coordinator().drained())).toBe(true)
  })

  it("shown again after an abort, the next pass runs at once", async () => {
    const h = harness()
    h.reads.hang = true
    run(h)
    await flush()
    h.visible.set(false)
    h.reads.hang = false
    h.visible.set(true)
    await flush()
    expect(h.reads.count).toBe(2)
    expect(h.catchingUp()).toBe(false)
  })
})

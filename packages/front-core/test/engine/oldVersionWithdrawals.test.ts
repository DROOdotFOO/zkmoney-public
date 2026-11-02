import { memoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OldVersionWithdrawal } from "../../src/core/migration/OldVersionWithdrawalStorage"
import {
  oldVersionWithdrawalTask,
  REFUND_CHECK_TIMEOUT_MS,
} from "../../src/engine/oldVersionWithdrawals"
import type { Loaded } from "../../src/engine/recordSource"
import { fixed } from "../../src/engine/resource"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import { later, periodicSteps, sessions, table } from "./taskTable"

const record = (id: string, phase: OldVersionWithdrawal["phase"]): OldVersionWithdrawal => ({
  id,
  startTime: 0,
  to: "0xto",
  feeUsd: "0",
  fromBlock: "0",
  refunds: [],
  phase,
})
const POLL = 15_000
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("oldVersionWithdrawals task", () => {
  const runtimes: Runtime[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
    vi.useRealTimers()
  })

  function start(
    opts: {
      records?: OldVersionWithdrawal[]
      settle?: (id: string) => Promise<unknown>
      stage?: Promise<void>
    } = {},
  ) {
    const visible = memoryStore(true)
    const records = memoryStore<Loaded<OldVersionWithdrawal>>({
      records: opts.records ?? [record("a", "sending"), record("b", "done")],
      hydrated: true,
    })
    const checked: string[] = []
    const settle = opts.settle ?? (async (id: string) => void checked.push(id))
    const wallet = fixed("wallet", "w")
    const task = oldVersionWithdrawalTask({ wallet, records: records.readonly, settle })
    const runtime = startRuntime([task], {
      db: openDatabase(memoryBackend()),
      milestones: { after: async () => (await opts.stage, true), reached: () => false },
      visible: visible.readonly,
    })
    runtimes.push(runtime)
    return { visible, records, checked, runtime }
  }

  it("checks once the wallet is ready: every 15 s while visible, paused while hidden", async () => {
    const wallet = later<string>("wallet")
    const checked: string[] = []
    const records = memoryStore({ records: [record("a", "sending")], hydrated: true })
    const h = sessions(startRuntime)
    const settle = async (id: string, w: string) => void checked.push(`${id}@${w}`)
    h.tasks.push(oldVersionWithdrawalTask({ wallet: wallet.resource, records, settle }))
    runtimes.push({ stop: h.end } as Runtime)
    await table(
      periodicSteps(h, () => wallet.ready("w"), POLL),
      () => checked.length,
    )
    expect(checked[0]).toBe("a@w")
  })

  it("waits for its milestones, then checks each sending record every 15 s while visible", async () => {
    let open = () => {}
    const stage = new Promise<void>((resolve) => (open = resolve))
    const { checked, records } = start({ stage })
    await vi.advanceTimersByTimeAsync(POLL)
    expect(checked).toEqual([])
    open()
    await flush()
    expect(checked).toEqual(["a"])
    records.set({ records: [record("a", "done"), record("c", "sending")], hydrated: true })
    await vi.advanceTimersByTimeAsync(POLL)
    expect(checked).toEqual(["a", "c"])
  })

  it("checks nothing while no record is sending", async () => {
    const { checked } = start({ records: [record("b", "failed")] })
    await vi.advanceTimersByTimeAsync(3 * POLL)
    expect(checked).toEqual([])
  })

  it("checks every record when one check fails, and keeps its cadence", async () => {
    const checked: string[] = []
    const settle = async (id: string) => {
      checked.push(id)
      if (id === "a") throw new Error("L1 down")
    }
    start({ records: [record("a", "sending"), record("c", "sending")], settle })
    await flush()
    expect(checked).toEqual(["a", "c"])
    await vi.advanceTimersByTimeAsync(POLL)
    expect(checked).toEqual(["a", "c", "a", "c"])
  })

  it("gives up on a stalled check, so the others and the next pass run", async () => {
    const checked: string[] = []
    const settle = (id: string) => {
      checked.push(id)
      return id === "a" ? new Promise<void>(() => {}) : Promise.resolve()
    }
    start({ records: [record("a", "sending"), record("c", "sending")], settle })
    await flush()
    expect(checked).toEqual(["a", "c"])
    await vi.advanceTimersByTimeAsync(REFUND_CHECK_TIMEOUT_MS + POLL)
    expect(checked).toEqual(["a", "c", "a", "c"])
  })

  it("pauses while hidden, aborting a hung check, and checks at once on show", async () => {
    let hang = true
    const checked: string[] = []
    const settle = (id: string) => {
      checked.push(id)
      return hang ? new Promise<void>(() => {}) : Promise.resolve()
    }
    const { visible } = start({ settle })
    await flush()
    visible.set(false)
    hang = false
    await vi.advanceTimersByTimeAsync(3 * POLL)
    expect(checked).toEqual(["a"])
    visible.set(true)
    await flush()
    expect(checked).toEqual(["a", "a"])
  })

  it("runs nothing once stopped, and a restart checks at once past the stopped run's hang", async () => {
    const checked: string[] = []
    let hang = true
    const settle = (id: string) => {
      checked.push(id)
      return hang ? new Promise<void>(() => {}) : Promise.resolve()
    }
    const first = start({ settle })
    await flush()
    first.runtime.stop()
    await vi.advanceTimersByTimeAsync(3 * POLL)
    expect(checked).toEqual(["a"])
    hang = false
    start({ settle })
    await flush()
    await vi.advanceTimersByTimeAsync(POLL)
    expect(checked).toEqual(["a", "a", "a"])
  })
})

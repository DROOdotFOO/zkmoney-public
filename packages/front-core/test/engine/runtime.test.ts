// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCatchUp } from "../../src/engine/catchUp"
import { openDatabase } from "../../src/engine/database"
import { createMilestones } from "../../src/engine/milestones"
import { memoryBackend } from "../../src/engine/memoryBackend"
import {
  startRuntime,
  task,
  within,
  type Runtime,
  type RuntimeDeps,
  type Task,
  type TaskSpec,
} from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import { flush, later } from "./taskTable"

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}
/** A run that lasts until it is aborted. */
const untilAborted = ({ signal }: { signal: AbortSignal }) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
const t = (spec: Omit<TaskSpec<Record<string, never>>, "needs">, name = "t") =>
  task(name, { needs: {}, ...spec })

describe("task runtime", () => {
  let runtime: Runtime | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    runtime?.stop()
    vi.useRealTimers()
  })
  const start = (tasks: Task[], deps: Partial<RuntimeDeps> = {}) =>
    (runtime = startRuntime(tasks, {
      db: openDatabase(memoryBackend()),
      milestones: createMilestones({ catchUp: createCatchUp() }),
      visible: memoryStore(true).readonly,
      ...deps,
    }))

  it("waits for its milestones, and runs nothing once stopped before them", async () => {
    const milestones = createMilestones({ catchUp: createCatchUp() })
    const order: string[] = []
    const push = (id: string) => async () => void order.push(id)
    start(
      [
        t({ after: { firstBalance: 60_000 }, every: "once", run: push("a") }, "a"),
        t({ every: "once", run: push("b") }, "b"),
      ],
      { milestones },
    )
    await flush()
    expect(order).toEqual(["b"])
    milestones.mark("firstBalance")
    await flush()
    expect(order).toEqual(["b", "a"])

    order.length = 0
    const later = createMilestones({ catchUp: createCatchUp() })
    start([t({ after: { firstBalance: 60_000 }, every: "once", run: push("a") }, "a")], {
      milestones: later,
    }).stop()
    later.mark("firstBalance")
    await flush()
    expect(order).toEqual([])
  })

  it("counts a milestone's bound from its needs first being ready", async () => {
    const wallet = later<string>("wallet")
    const run = vi.fn(async () => {})
    start([
      task("t", {
        needs: { wallet: wallet.resource },
        after: { firstBalance: 60_000 },
        every: "once",
        run,
      }),
    ])
    await vi.advanceTimersByTimeAsync(100_000)
    wallet.ready("w1")
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("runs one at a time; wakes mid-run share one rerun, settled only once it ends", async () => {
    const runs: ReturnType<typeof gate>[] = []
    const run = () => (runs.push(gate()), runs[runs.length - 1].opened)
    const task = t({ every: "once", run })
    const rt = start([task])
    await flush()
    let settled = 0
    void rt.wake(task).then(() => settled++)
    void rt.wake(task).then(() => settled++)
    await flush()
    expect(runs).toHaveLength(1)
    runs[0].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 0])
    runs[1].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 2])
  })

  it("wakes another task from a run, and ignores a task it does not run", async () => {
    const other = vi.fn(async () => {})
    const second = t({ every: 60_000, run: other }, "second")
    const first = t({ every: "once", run: ({ wake }) => wake(second) }, "first")
    const rt = start([first, second])
    await flush()
    other.mockClear()
    await rt.wake(first)
    expect(other).toHaveBeenCalledTimes(1)
    await rt.wake(t({ every: "once", run: other }, "stranger"))
    expect(other).toHaveBeenCalledTimes(1)
  })

  it("backs off a failing task, and keeps the backoff across a restart", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    let failing = true
    const run = vi.fn(async () => {
      if (failing) throw new Error("down")
    })
    const task = t({ every: "once", backoff: { baseMs: 1_000, maxMs: 3_000 }, run })
    const rt = start([task], { db })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    rt.stop()
    // The second failure waits 2 s; a restart 500 ms in waits out the rest.
    await vi.advanceTimersByTimeAsync(500)
    start([task], { db })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(run).toHaveBeenCalledTimes(2)
    failing = false
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    expect([...backend.entries.keys()]).toEqual([])
  })

  it("reads a restart's backoff once the failed run's save has landed", async () => {
    const inner = memoryBackend()
    const saving = gate()
    const db = openDatabase({
      ...inner,
      apply: async (ops) => saving.opened.then(() => inner.apply(ops)),
    })
    const run = vi.fn(async () => {
      throw new Error("down")
    })
    const task = t({ every: "once", backoff: { baseMs: 1_000, maxMs: 3_000 }, run })
    const rt = start([task], { db })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    // A replacement runtime starts while the failure's backoff is still being saved.
    rt.stop()
    start([task], { db })
    await flush()
    saving.open()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("pauses while hidden, aborting the run in flight, and runs at once on show", async () => {
    const visible = memoryStore(true)
    const run = vi.fn<(ctx: { signal: AbortSignal }) => Promise<void>>(async () => {})
    start([t({ every: 5_000, run })], { visible: visible.readonly })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(2)
    run.mockImplementationOnce(untilAborted)
    await vi.advanceTimersByTimeAsync(5_000)
    visible.set(false)
    expect(run.mock.calls[2][0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(3)
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(4)
  })

  it("keeps a hidden pace: the run in flight goes on, and showing runs at once", async () => {
    const visible = memoryStore(true)
    const runs: ReturnType<typeof gate>[] = []
    const run = vi.fn((ctx: { signal: AbortSignal }) => {
      runs.push(gate())
      return Promise.race([runs[runs.length - 1].opened, untilAborted(ctx)])
    })
    start([t({ every: 5_000, whenHidden: 30_000, run })], { visible: visible.readonly })
    await flush()
    visible.set(false)
    expect(run.mock.calls[0][0].signal.aborted).toBe(false)
    runs[0].open()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    runs[1].open()
    await flush()
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("settles a wake at once while hidden, and runs on show", async () => {
    const visible = memoryStore(false)
    const run = vi.fn(async () => {})
    const task = t({ every: 5_000, run })
    const rt = start([task], { visible: visible.readonly })
    await flush()
    await rt.wake(task)
    expect(run).not.toHaveBeenCalled()
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("settles the wakers of a run that never ends on its abort", async () => {
    const visible = memoryStore(true)
    const task = t({ every: 5_000, run: () => new Promise<void>(() => {}) })
    const rt = start([task], { visible: visible.readonly })
    await flush()
    let woken = false
    void rt.wake(task).then(() => (woken = true))
    visible.set(false)
    await flush()
    expect(woken).toBe(true)
  })

  it("runs once its needs are ready, with their values, and never demands them", async () => {
    const wallet = later<string>("wallet")
    const demand = vi.spyOn(wallet.resource, "demand")
    const seen: string[] = []
    const needing = task("t", {
      needs: { wallet: wallet.resource },
      every: 5_000,
      run: async (ctx) => void seen.push(ctx.wallet),
    })
    const rt = start([needing])
    await vi.advanceTimersByTimeAsync(10_000)
    await rt.wake(needing)
    expect(seen).toEqual([])
    wallet.ready("w1")
    await flush()
    expect(seen).toEqual(["w1"])
    expect(demand).not.toHaveBeenCalled()
  })

  it("aborts the run in flight when a need is lost or replaced, and runs with its value once back; a once task runs clean once per value", async () => {
    const wallet = later<string>("wallet")
    wallet.ready("w1")
    const seen: string[] = []
    const once = vi.fn(async (ctx: { wallet: string }) => void seen.push(ctx.wallet))
    const run = vi.fn<(ctx: { signal: AbortSignal; wallet: string }) => Promise<void>>(untilAborted)
    start([
      task("periodic", { needs: { wallet: wallet.resource }, every: 5_000, run }),
      task("once", { needs: { wallet: wallet.resource }, every: "once", run: once }),
    ])
    await flush()
    wallet.lose()
    expect(run.mock.calls[0][0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    wallet.ready("w1")
    await flush()
    expect(seen).toEqual(["w1"])
    wallet.ready("w2")
    await flush()
    expect(run.mock.calls.map((c) => [c[0].wallet, c[0].signal.aborted])).toEqual([
      ["w1", true],
      ["w1", true],
      ["w2", false],
    ])
    expect(seen).toEqual(["w1", "w2"])
  })

  it("ends a wait on its signal, even one aborted before it began, and observes the late work", async () => {
    const aborted = new AbortController()
    aborted.abort()
    let fail!: (e: Error) => void
    const work = new Promise<never>((_, reject) => (fail = reject))
    await expect(within(work, "read", { signal: aborted.signal })).rejects.toMatchObject({
      code: "aborted",
    })
    // Unobserved, this rejection would fail the run as unhandled.
    fail(new Error("late"))
    await flush()
    const live = new AbortController()
    const waiting = within(new Promise(() => {}), "read", { ms: 1_000, signal: live.signal })
    live.abort()
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  it("aborts the run in flight on stop, settles its wakers and runs nothing more", async () => {
    const run = vi.fn(untilAborted)
    const task = t({ every: 1_000, run })
    const rt = start([task])
    await flush()
    const woken = rt.wake(task)
    rt.stop()
    expect(run.mock.calls[0][0].signal.aborted).toBe(true)
    await woken
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

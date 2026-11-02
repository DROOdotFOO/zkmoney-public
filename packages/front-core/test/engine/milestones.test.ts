// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { createCatchUp } from "../../src/engine/catchUp"
import { createMilestones, type After, type Milestone } from "../../src/engine/milestones"
import { fakeClock, flush } from "./taskTable"

/** The real catch-up flag, with an outside pass to toggle and a count of the holds the sync takes. */
function catchUpSource() {
  const real = createCatchUp()
  let outside: (() => void) | undefined
  let own = 0
  return {
    status: real.status,
    begin: () => {
      own++
      const end = real.begin()
      let ended = false
      return () => {
        if (ended) return
        ended = true
        own--
        end()
      }
    },
    set: (value: boolean) => {
      if (value && !outside) outside = real.begin()
      if (!value && outside) {
        outside()
        outside = undefined
      }
    },
    ownHolds: () => own,
  }
}

const FIRST: After = { firstBalance: true }
const RESTORE: After = { firstBalance: true, depositsReplayed: { whenCatchingUp: 0 } }
const SETTLED: After = { firstBalance: true, depositsReplayed: true, movesReplayed: true }
const AT_HEAD: After = { ...SETTLED, historyAtHead: true }

/** Milestones over a catch-up flag the test toggles. */
function boot(waits = {}) {
  const catchUp = catchUpSource()
  const m = createMilestones({ catchUp, waits })
  const waiter = (after: After) => {
    const state = { over: false }
    void m.after(after).then((over) => (state.over = over))
    return state
  }
  return {
    m,
    catchUp,
    waiter,
    mark: (...names: Milestone[]) => names.forEach((name) => m.mark(name)),
    syncing: () => m.sync.get().syncing,
  }
}

describe("milestones", () => {
  fakeClock()

  it("releases each reader at its milestones, and reports them reached", async () => {
    const { m, mark, waiter } = boot()
    const readers = { FIRST, RESTORE, SETTLED, AT_HEAD }
    const over = Object.fromEntries(Object.entries(readers).map(([k, a]) => [k, waiter(a)]))
    const released = () => Object.keys(over).filter((k) => over[k].over)

    mark("firstBalance")
    await flush()
    // A first-balance reader goes without the deposits.
    expect(released()).toEqual(["FIRST"])
    // No boot sync: nothing to replay.
    expect(m.reached("movesReplayed")).toBe(true)

    mark("depositsReplayed")
    await flush()
    // Restore readers wait for the balance like the rest.
    expect(released()).toEqual(["FIRST", "RESTORE", "SETTLED"])

    mark("historyAtHead")
    await flush()
    expect(released()).toEqual(Object.keys(readers))
    expect(m.reached("historyAtHead")).toBe(true)
  })

  it.each<[Milestone, Milestone]>([
    ["firstBalance", "depositsReplayed"],
    ["depositsReplayed", "firstBalance"],
  ])(
    "settles, and releases history however early the scanner reached head, only once the balance and the deposits are both in (%s first)",
    async (first, second) => {
      const { mark, waiter } = boot()
      const settled = waiter(SETTLED)
      const atHead = waiter(AT_HEAD)
      mark("historyAtHead", first)
      await flush()
      expect([settled.over, atHead.over]).toEqual([false, false])
      mark(second)
      await flush()
      expect([settled.over, atHead.over]).toEqual([true, true])
    },
  )

  it("does not report a milestone reached whose wait only gave up", async () => {
    const { m, waiter } = boot()
    const first = waiter({ firstBalance: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(first.over).toBe(true)
    expect(m.reached("firstBalance")).toBe(false)
  })

  it.each<[string, After, Milestone[]]>([
    ["deposits", { firstBalance: 1_000, depositsReplayed: 1_000 }, ["firstBalance"]],
    ["history", { ...SETTLED, historyAtHead: 1_000 }, ["firstBalance", "depositsReplayed"]],
  ])("bounds the %s wait from the end of the one before it", async (_, after, before) => {
    const { mark, waiter } = boot()
    const reader = waiter(after)
    await vi.advanceTimersByTimeAsync(900)
    mark(...before)
    await vi.advanceTimersByTimeAsync(999)
    expect(reader.over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(reader.over).toBe(true)
  })

  it("opens the boot sync on a catch-up before settle, holding its own catch-up until settle", async () => {
    const { catchUp, mark, syncing } = boot()
    expect(syncing()).toBe(false)
    catchUp.set(true)
    catchUp.set(false)
    expect(syncing()).toBe(true)
    expect(catchUp.status.get()).toBe(true) // bridges the gap before the next catch-up
    mark("firstBalance", "depositsReplayed", "movesReplayed", "oldVersionsRead")
    await flush()
    expect(syncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
    catchUp.set(true)
    expect(syncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it("on a catching-up device, releases restore readers at the first balance and settles once the moves are replayed too", async () => {
    const { m, catchUp, mark, waiter, syncing } = boot()
    mark("oldVersionsRead")
    catchUp.set(true)
    const restore = waiter(RESTORE)
    const settled = waiter(SETTLED)

    mark("firstBalance")
    await flush()
    expect(restore.over).toBe(true)
    expect(m.reached("movesReplayed")).toBe(false)

    mark("depositsReplayed")
    await flush()
    expect(settled.over).toBe(false)
    expect(syncing()).toBe(true)

    mark("movesReplayed")
    await flush()
    expect(settled.over).toBe(true)
    expect(syncing()).toBe(false)
  })

  it("keeps the boot sync open past the readers' bounds until the replays end", async () => {
    const { catchUp, mark, waiter, syncing } = boot({ deposits: 1_000 })
    catchUp.set(true)
    const settled = waiter({ ...SETTLED, depositsReplayed: 1_000, movesReplayed: 1_000 })
    mark("firstBalance", "oldVersionsRead")
    // Each bound starts when the wait before it ends.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled.over).toBe(true)
    expect(syncing()).toBe(true)
    expect(catchUp.ownHolds()).toBe(1)

    mark("depositsReplayed", "movesReplayed")
    await flush()
    expect(syncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it("closes a boot sync whose replays never end on its own backstop after the first balance", async () => {
    const { catchUp, mark, syncing } = boot({ deposits: 1_000, sync: 3_000 })
    catchUp.set(true)
    mark("firstBalance")
    await vi.advanceTimersByTimeAsync(2_999)
    expect(syncing()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(syncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
  })

  it.each([true, false])(
    "holds the boot sync open until the old versions are read, or its backstop (read: %s)",
    async (read) => {
      const { catchUp, mark, waiter, syncing } = boot({ sync: 3_000 })
      catchUp.set(true)
      const settled = waiter(SETTLED)
      mark("firstBalance", "depositsReplayed", "movesReplayed")
      await vi.advanceTimersByTimeAsync(2_999)
      expect(settled.over).toBe(true)
      expect(syncing()).toBe(true)
      if (read) mark("oldVersionsRead")
      await vi.advanceTimersByTimeAsync(read ? 0 : 1)
      expect(syncing()).toBe(false)
      expect(catchUp.ownHolds()).toBe(0)
    },
  )

  it("closes a boot sync whose first balance never comes after the bound, for good", async () => {
    const { catchUp, syncing } = boot({ boot: 1_000 })
    catchUp.set(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(syncing()).toBe(false)
    expect(catchUp.ownHolds()).toBe(0)
    catchUp.set(false)
    catchUp.set(true)
    expect(syncing()).toBe(false)
  })

  it("reports replay progress only while the boot sync is open", async () => {
    const { m, catchUp, mark } = boot()
    mark("oldVersionsRead")
    m.progress("deposits", 1, 4)
    expect(m.sync.get().progress).toBeNull() // no sync open yet
    catchUp.set(true)
    expect(m.sync.get().progress).toBeNull() // total not known yet
    m.progress("deposits", 1, 4)
    expect(m.sync.get().progress).toBe(0.25)
    mark("firstBalance", "depositsReplayed", "movesReplayed")
    await flush()
    expect(m.sync.get().progress).toBeNull()
    m.progress("deposits", 3, 4)
    expect(m.sync.get().progress).toBeNull()
  })

  it("counts each old-version source in the progress, below 1 until all are read", () => {
    const { m, catchUp, mark } = boot()
    const progress = () => m.sync.get().progress
    catchUp.set(true)
    m.progress("deposits", 1, 2)
    expect(progress()).toBe(1 / 3) // an unreported read counts as one unit
    mark("depositsReplayed")
    expect(progress()).toBe(2 / 3)
    m.progress("oldVersions", 1, 2)
    expect(progress()).toBe(3 / 4)
    mark("oldVersionsRead")
    expect(progress()).toBe(1)
  })

  it("keeps progress below 1 while the SIPA pass has not reported, and never lowers it", () => {
    const { m, catchUp, mark } = boot()
    const progress = () => m.sync.get().progress
    catchUp.set(true)
    m.progress("oldVersions", 0, 2)
    mark("oldVersionsRead")
    expect(progress()).toBe(2 / 3) // an unreported pass counts as one unit
    m.progress("deposits", 1, 4)
    expect(progress()).toBe(2 / 3) // 3/6 would go down
    m.progress("deposits", 3, 4)
    expect(progress()).toBe(5 / 6)
  })

  it("never holds a warm start whose catch-up begins after settle", async () => {
    const { catchUp, mark, syncing } = boot()
    mark("firstBalance", "depositsReplayed")
    await flush()
    catchUp.set(true)
    expect(syncing()).toBe(false)
  })

  it("ends a wait false on its abort or on stop, and logs the settled balance once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { m, mark } = boot()
    const aborted = new AbortController()
    const first = m.after(FIRST, aborted.signal)
    const settled = m.after(SETTLED)
    aborted.abort()
    expect(await first).toBe(false)
    mark("firstBalance", "depositsReplayed")
    expect(await settled).toBe(true)
    expect(
      log.mock.calls.filter(([line]) => String(line).includes("[boot] balance settled")),
    ).toHaveLength(1)
    const later = m.after(AT_HEAD)
    m.stop()
    expect(await later).toBe(false)
  })
})

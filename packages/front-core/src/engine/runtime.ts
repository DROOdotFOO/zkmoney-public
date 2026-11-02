import { logger } from "../utils/logger"
import type { Database } from "./database"
import { bestEffort, WalletError } from "./errors"
import type { After, Milestone, Milestones } from "./milestones"
import type { Backoff, Resource } from "./resource"
import type { ReadonlyStore } from "./store"

/**
 * Background work as declared tasks. A task waits for its milestones, the bounds counted from its
 * needs first being ready, and runs only while every need is ready, one run at a time: once, or
 * every `every` ms, and at once when woken. A need leaving ready, or replaced, aborts the run in
 * flight; ready again, the task runs, after any backoff. A failed run backs off, and the backoff
 * outlives a restart. Hiding the page aborts a pausing task's run in flight; a task with a hidden
 * pace keeps running at it. Showing the page runs either at once, ahead of any backoff. A wake
 * settles at once when its run is aborted, or when it finds its task hidden or a need not ready.
 */

export type Needs = Record<string, Resource<unknown>>
export type Ready<N extends Needs> = { [K in keyof N]: N[K] extends Resource<infer V> ? V : never }

export interface RunBase {
  /** Aborted on stop, on a need leaving ready, or on hide for a pausing task. Every wait in a run ends on it: `within`. */
  signal: AbortSignal
  /** Woken, started, shown or given its needs; not run by the cadence or a backoff retry. */
  woken: boolean
  wake(task: Task): Promise<void>
  reached(milestone: Milestone): boolean
}

export type RunCtx<N extends Needs> = Ready<N> & RunBase

export interface TaskSpec<N extends Needs> {
  /** Runs only while every one is ready, and receives their values; never demands them. */
  needs: N
  after?: After
  /** Ms between runs; "once": one clean run per runtime. */
  every: number | "once"
  /** "pause" (default): hiding aborts the run, and showing runs it again. A number: ms between runs while hidden. */
  whenHidden?: "pause" | number
  /** Kept in the runtime's database. */
  backoff?: Backoff
  run(ctx: RunCtx<N>): Promise<void>
}

/** A task's handle: what a runtime runs and wakes. */
export interface Task {
  readonly name: string
}

const specs = new WeakMap<Task, TaskSpec<Needs>>()

export function task<const N extends Needs>(name: string, spec: TaskSpec<N>): Task {
  const handle: Task = { name }
  specs.set(handle, spec as unknown as TaskSpec<Needs>)
  return handle
}

export interface RuntimeDeps {
  /** Where backoff is kept. */
  db: Database
  milestones: Pick<Milestones, "after" | "reached">
  visible: ReadonlyStore<boolean>
}

export interface Runtime {
  /** Runs the task now, or after the run in flight; settles once a run begun after it ends. */
  wake(task: Task): Promise<void>
  stop(): void
}

interface Slot {
  task: Task
  spec: TaskSpec<Needs>
  /** Its milestones were reached. */
  gated: boolean
  held: boolean
  /** The need values the last run took. */
  values?: unknown[]
  /** A "once" task ran clean. */
  done: boolean
  failures: number
  retryAt?: number
  run?: AbortController
  rerun: boolean
  /** The next run is not the cadence's. */
  woken: boolean
  timer?: ReturnType<typeof setTimeout>
  waiters: (() => void)[]
}

const backoffKey = (name: string) => `runtime/backoff/${name}`

const settleWaiters = (slot: Slot) => {
  for (const resolve of slot.waiters.splice(0)) resolve()
}

/** Each need's value, or undefined while one is not ready. */
const needValues = ({ spec }: Slot): unknown[] | undefined => {
  const states = Object.values(spec.needs).map((r) => r.get())
  return states.every((s) => s.status === "ready")
    ? states.map((s) => (s as { value: unknown }).value)
    : undefined
}

const sameValues = (a: unknown[], b: unknown[]) => a.every((v, i) => Object.is(v, b[i]))

/** Keeps running while hidden, at its own pace. */
const paced = ({ spec }: Slot) => spec.every !== "once" && typeof spec.whenHidden === "number"

/**
 * A wait inside a run: settles with `work`, or rejects once `ms` passes or `signal` aborts, so an
 * aborted run lets go of everything at once. `work` itself runs on.
 */
export function within<T>(
  work: Promise<T>,
  label: string,
  { ms, signal }: { ms?: number; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      settle()
    }
    const aborted = () => end(() => reject(new WalletError("aborted", `${label} aborted`)))
    const timer =
      ms === undefined
        ? undefined
        : setTimeout(
            () => end(() => reject(new WalletError("timeout", `${label} timed out after ${ms}ms`))),
            ms,
          )
    // Observed even when abandoned, so its late rejection is never unhandled.
    work.then(
      (value) => end(() => resolve(value)),
      (err: unknown) => end(() => reject(err)),
    )
    if (signal?.aborted) return aborted()
    signal?.addEventListener("abort", aborted)
  })
}

export function startRuntime(tasks: readonly Task[], deps: RuntimeDeps): Runtime {
  let stopped = false
  const ended = new AbortController()
  const slots = new Map<Task, Slot>(
    tasks.map((task) => {
      const spec = specs.get(task)
      if (!spec) throw new WalletError("invariant", `runtime: ${task.name} is not a task`)
      const flags = { gated: false, held: false, done: false, rerun: false, woken: true }
      return [task, { task, spec, ...flags, failures: 0, waiters: [] }]
    }),
  )
  let shown = deps.visible.get()

  const holds = (slot: Slot) =>
    needValues(slot) !== undefined && (slot.spec.every === "once" || paced(slot) || shown)

  const schedule = (slot: Slot, ms: number | undefined) => {
    clearTimeout(slot.timer)
    slot.timer = ms === undefined ? undefined : setTimeout(() => go(slot, false), ms)
  }

  /** The delay before the next run, if any. */
  const settle = (slot: Slot, failed: boolean) => {
    const { spec, task } = slot
    if (failed && spec.backoff) {
      slot.failures++
      const delay = Math.min(spec.backoff.baseMs * 2 ** (slot.failures - 1), spec.backoff.maxMs)
      slot.retryAt = Date.now() + delay
      const saved = `${slot.failures} ${slot.retryAt}`
      void bestEffort(
        "unknown",
        deps.db.write(async (w) => w.put(backoffKey(task.name), saved)),
      )
      return delay
    }
    if (slot.failures > 0)
      void bestEffort(
        "unknown",
        deps.db.write(async (w) => w.remove(backoffKey(task.name))),
      )
    slot.failures = 0
    slot.retryAt = undefined
    if (spec.every === "once") {
      slot.done = !failed
      return undefined
    }
    return !shown && typeof spec.whenHidden === "number" ? spec.whenHidden : spec.every
  }

  const execute = async (slot: Slot) => {
    const { spec, task } = slot
    const values = needValues(slot)
    if (!values) return
    slot.values = values
    schedule(slot, undefined)
    const run = (slot.run = new AbortController())
    const waiters = slot.waiters.splice(0)
    const release = () => {
      for (const resolve of waiters.splice(0)) resolve()
    }
    run.signal.addEventListener("abort", release)
    const ready = Object.fromEntries(Object.keys(spec.needs).map((key, i) => [key, values[i]]))
    let failed = false
    try {
      await spec.run({
        ...ready,
        signal: run.signal,
        woken: slot.woken,
        wake,
        reached: (m) => deps.milestones.reached(m),
      })
    } catch (e) {
      failed = !run.signal.aborted
      if (failed) logger.warn(`[runtime] ${task.name} failed:`, e)
    }
    slot.run = undefined
    release()
    if (stopped) return
    const delay = run.signal.aborted ? undefined : settle(slot, failed)
    const again = slot.rerun
    slot.rerun = false
    if (!holds(slot)) return
    if (again) return go(slot)
    schedule(slot, delay)
  }

  const go = (slot: Slot, woken = true) => {
    if (stopped || !slot.gated) return
    if (slot.run) {
      slot.rerun = true
      return
    }
    slot.woken = woken
    if (holds(slot)) void execute(slot)
  }

  /** Runs now, or once the backoff in place ends. */
  const resume = (slot: Slot) => {
    const wait = (slot.retryAt ?? 0) - Date.now()
    if (wait > 0) schedule(slot, wait)
    else go(slot)
  }

  const pause = (slot: Slot) => {
    schedule(slot, undefined)
    slot.run?.abort()
    settleWaiters(slot)
  }

  /** Settles once every need is ready, or on stop. */
  const needsReady = (slot: Slot) =>
    new Promise<void>((resolve) => {
      let offs: (() => void)[] = []
      const check = () => {
        if (!stopped && !needValues(slot)) return
        for (const off of offs) off()
        ended.signal.removeEventListener("abort", check)
        resolve()
      }
      offs = Object.values(slot.spec.needs).map((need) => need.subscribe(check))
      ended.signal.addEventListener("abort", check)
      check()
    })

  const gate = async (slot: Slot) => {
    const { spec, task } = slot
    await needsReady(slot)
    // Always yields, so a wake issued beside the start joins the first run.
    if (!(await (spec.after ? deps.milestones.after(spec.after, ended.signal) : true))) return
    // Read through the writer, so a save an earlier runtime queued lands first. A backoff that cannot
    // be read is none: the run goes ahead.
    const saved =
      !stopped &&
      (await bestEffort(
        "unknown",
        deps.db.write((w) => w.get(backoffKey(task.name))),
      ))
    if (stopped) return
    slot.gated = true
    slot.held = holds(slot)
    if (!slot.held) settleWaiters(slot)
    const [failures, retryAt] = (saved || "").split(" ")
    if (Number(failures) > 0) {
      slot.failures = Number(failures)
      slot.retryAt = Number(retryAt)
    }
    resume(slot)
  }

  const onNeeds = (slot: Slot) => {
    if (stopped || !slot.gated) return
    const held = holds(slot)
    const values = held ? needValues(slot) : undefined
    const replaced = !!values && !!slot.values && !sameValues(values, slot.values)
    if (held === slot.held && !replaced) return
    slot.held = held
    if (!held) return pause(slot)
    if (replaced) {
      slot.values = undefined
      slot.done = false
      slot.run?.abort()
    }
    if (!slot.done) resume(slot)
  }

  const onVisibility = () => {
    const now = deps.visible.get()
    if (now === shown) return
    shown = now
    for (const slot of slots.values()) {
      if (!slot.gated) continue
      const held = holds(slot)
      if (held !== slot.held) {
        slot.held = held
        if (held) go(slot)
        else pause(slot)
      } else if (held && shown && paced(slot) && !slot.run) go(slot)
    }
  }

  const offs = [deps.visible.subscribe(onVisibility)]
  for (const slot of slots.values()) {
    for (const need of Object.values(slot.spec.needs))
      offs.push(need.subscribe(() => onNeeds(slot)))
    void gate(slot)
  }

  function wake(task: Task): Promise<void> {
    const slot = slots.get(task)
    if (!slot || stopped) return Promise.resolve()
    // Hidden or missing a need: the show or the need runs it.
    if (!holds(slot)) return Promise.resolve()
    const ran = new Promise<void>((resolve) => slot.waiters.push(resolve))
    schedule(slot, undefined)
    go(slot)
    return ran
  }

  return {
    wake,
    stop() {
      if (stopped) return
      stopped = true
      ended.abort()
      for (const off of offs) off()
      for (const slot of slots.values()) pause(slot)
    },
  }
}

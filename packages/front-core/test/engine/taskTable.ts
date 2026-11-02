// The lifecycle table every task passes, and the engine tests' shared fakes: front-core's here,
// web-wallet's through a relative import. `start` is the package's own `startRuntime`.
import { afterEach, beforeEach, expect, vi } from "vitest"
import { openDatabase, type Database } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import type { Resource, ResourceState } from "../../src/engine/resource"
import { memoryStore, type ReadonlyStore } from "../../src/engine/store"

type Task = { readonly name: string }
type Milestones = {
  after(after: never, signal?: AbortSignal): Promise<boolean>
  reached(milestone: never): boolean
}
type Start = (
  tasks: readonly Task[],
  deps: { db: Database; milestones: Milestones; visible: ReadonlyStore<boolean> },
) => { stop(): void }

export const flush = () => vi.advanceTimersByTimeAsync(0)

/** Fake timers and a quiet `console.warn` around each test of the calling suite. */
export function fakeClock() {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
}

/** A resource pending until the test makes it ready, replaces its value, or loses it. */
export function later<T>(name: string) {
  const state = memoryStore<ResourceState<T>>({ status: "pending" })
  const resource: Resource<T> = { ...state.readonly, name, demand() {}, retry() {}, close() {} }
  return {
    resource,
    ready: (value: T) => state.set({ status: "ready", value }),
    lose: () => state.set({ status: "pending" }),
  }
}

const reachedAll: Milestones = { after: async () => true, reached: () => false }

/** A runtime over `tasks` per start, as each session starts one, over one database and visibility. */
export function sessions(start: Start, milestones = reachedAll) {
  const db = openDatabase(memoryBackend())
  const visible = memoryStore(true)
  const tasks: Task[] = []
  const started: { stop(): void }[] = []
  return {
    tasks,
    visible,
    start: () => void started.push(start(tasks, { db, milestones, visible: visible.readonly })),
    stop: () => started.at(-1)?.stop(),
    hide: () => visible.set(false),
    show: () => visible.set(true),
    end: () => started.forEach((r) => r.stop()),
  }
}

type Sessions = ReturnType<typeof sessions>
export type Step = [label: string, act: () => void, ms: number, runs: number]

/** Each step's act, then `ms` of fake time, then the count of runs so far. */
export async function table(steps: Step[], runs: () => number): Promise<void> {
  for (const [label, act, ms, expected] of steps) {
    act()
    await vi.advanceTimersByTimeAsync(ms)
    expect(runs(), label).toBe(expected)
  }
}

/** A task run every `every` ms while visible, paused while hidden, started before its need is ready. */
export const periodicSteps = (h: Sessions, ready: () => void, every: number): Step[] => [
  ["start, a need pending", h.start, every, 0],
  ["the need is ready", ready, 0, 1],
  ["visible", () => {}, every, 2],
  ["hidden", h.hide, 4 * every, 2],
  ["show", h.show, 0, 3],
  ["stop", h.stop, 4 * every, 3],
  ["restart", h.start, 0, 4],
]

/** A task run once per session, started before its need is ready. */
export const onceSteps = (h: Sessions, ready: () => void): Step[] => [
  ["start, a need pending", h.start, 60_000, 0],
  ["the need is ready", ready, 0, 1],
  ["hidden", h.hide, 60_000, 1],
  ["show", h.show, 60_000, 1],
  ["stop", h.stop, 60_000, 1],
  ["restart", h.start, 0, 2],
]

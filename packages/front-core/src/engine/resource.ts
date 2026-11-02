import { logger } from "../utils/logger"
import { memoryStore, type ReadonlyStore } from "./store"

/**
 * An async value with a lifetime: pending, ready or failed. It is built from its input resources
 * once they are all ready, rebuilt when one of their values changes or `changes` fires, and
 * retried with a backoff. A rebuild aborts the build in flight and releases the value it replaces.
 */

export interface Backoff {
  baseMs: number
  maxMs: number
}

export type ResourceState<T> =
  | { status: "pending" }
  | { status: "ready"; value: T }
  | { status: "failed"; error: unknown; retryAt?: number }

export interface Resource<T> extends ReadonlyStore<ResourceState<T>> {
  readonly name: string
  /** Starts a lazy resource and its inputs. A task's `needs` never demands. */
  demand(): void
  /** Builds again now, ahead of any backoff; the only retry of a "manual" resource. */
  retry(): void
  /** Aborts the build in flight and releases the value. */
  close(): void
}

export interface BuildCtx {
  /** Aborted when an input changes, `changes` fires, or the resource closes. */
  signal: AbortSignal
  /** `use(value)` now and on each change of `source`; `use(undefined)` once this value is replaced. */
  follow<V>(source: Resource<V>, use: (value: V | undefined) => void): void
}

export interface ResourceSpec<From extends readonly Resource<unknown>[]> {
  from: From
  /** Builds nothing until `demand()`. */
  lazy?: boolean
  /** A failed build retries after `baseMs`, doubling to `maxMs`; "manual" waits for `retry()`. */
  backoff: Backoff | "manual"
  /** Another reason to rebuild, such as a manifest roll; heard once demanded. Returns the unsubscribe. */
  changes?(onChange: () => void): () => void
}

export type Values<From> = { [K in keyof From]: From[K] extends Resource<infer V> ? V : never }

export function valueOf<T>(r: ReadonlyStore<ResourceState<T>>): T | undefined {
  const state = r.get()
  return state.status === "ready" ? state.value : undefined
}

/** A resource ready from the start: a page's fixed input. */
export function fixed<T>(name: string, value: T): Resource<T> {
  const state = memoryStore<ResourceState<T>>({ status: "ready", value })
  return { ...state.readonly, name, demand() {}, retry() {}, close() {} }
}

/** A build that resolves undefined stays pending until an input changes or `changes` fires. */
export function resource<const From extends readonly Resource<unknown>[], T>(
  name: string,
  spec: ResourceSpec<From>,
  build: (inputs: Values<From>, ctx: BuildCtx) => Promise<T | undefined>,
): Resource<T> {
  const state = memoryStore<ResourceState<T>>({ status: "pending" })
  let demanded = !spec.lazy
  let closed = false
  let built: unknown[] | undefined
  let run: AbortController | undefined
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const inputs = (): unknown[] | undefined => {
    const values = spec.from.map((r) => r.get())
    return values.every((s) => s.status === "ready")
      ? values.map((s) => (s as { value: unknown }).value)
      : undefined
  }

  const release = () => {
    clearTimeout(timer)
    run?.abort()
    run = undefined
    built = undefined
    if (state.get().status !== "pending") state.set({ status: "pending" })
  }

  const start = (values: unknown[]) => {
    release()
    const current = (run = new AbortController())
    built = values
    const { signal } = current
    const follow = <V>(source: Resource<V>, use: (value: V | undefined) => void) => {
      let last = valueOf(source)
      use(last)
      const off = source.subscribe(() => {
        const next = valueOf(source)
        if (next !== last) use((last = next))
      })
      signal.addEventListener("abort", () => (off(), use(undefined)))
    }
    build(values as Values<From>, { signal, follow }).then(
      (value) => {
        if (signal.aborted || value === undefined) return
        failures = 0
        state.set({ status: "ready", value })
      },
      (error: unknown) => {
        if (signal.aborted) return
        logger.warn(`[resource] ${name} failed:`, error)
        if (spec.backoff === "manual") return state.set({ status: "failed", error })
        failures++
        const delay = Math.min(spec.backoff.baseMs * 2 ** (failures - 1), spec.backoff.maxMs)
        state.set({ status: "failed", error, retryAt: Date.now() + delay })
        timer = setTimeout(() => !signal.aborted && start(values), delay)
      },
    )
  }

  /** Builds when demanded and every input is ready, unless the value in place was built from the same inputs. */
  const follows = (force = false) => {
    if (closed || !demanded) return
    const values = inputs()
    if (!values) return release()
    const same = built?.length === values.length && values.every((v, i) => Object.is(v, built?.[i]))
    if (force || !same) start(values)
  }

  const offs = spec.from.map((r) => r.subscribe(() => follows()))
  let offChanges: (() => void) | undefined
  const hearChanges = () => (offChanges ??= spec.changes?.(() => follows(true)))
  if (demanded) hearChanges()
  follows()

  return {
    ...state.readonly,
    name,
    demand() {
      if (demanded) return
      demanded = true
      for (const r of spec.from) r.demand()
      hearChanges()
      follows()
    },
    retry: () => follows(true),
    close() {
      if (closed) return
      closed = true
      for (const off of offs) off()
      offChanges?.()
      release()
    },
  }
}

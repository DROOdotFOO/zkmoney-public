/**
 * The one state primitive. A store holds an immutable value and notifies on change; only its owner
 * holds the writable handle and hands out `readonly`. `get()` returns the same reference until the
 * value changes, so it is a valid `useSyncExternalStore` snapshot.
 *
 * Writes inside `batch` notify once, after the outermost batch ends. A `derived` store recomputes
 * once per batch however many of its sources changed.
 */

export interface ReadonlyStore<T> {
  get(): T
  subscribe(listener: () => void): () => void
}

export interface Store<T> extends ReadonlyStore<T> {
  set(next: T): void
  update(change: (current: T) => T): void
  readonly readonly: ReadonlyStore<T>
}

let depth = 0
const queue = new Set<() => void>()

function schedule(job: () => void): void {
  if (depth > 0) queue.add(job)
  else run(job)
}

/** A listener that throws must not stop the others; the error still surfaces. */
function run(job: () => void): void {
  try {
    job()
  } catch (e) {
    queueMicrotask(() => {
      throw e
    })
  }
}

export function batch<T>(write: () => T): T {
  depth++
  try {
    return write()
  } finally {
    depth--
    if (depth === 0) flush()
  }
}

function flush(): void {
  depth++
  try {
    while (queue.size > 0) {
      const jobs = [...queue]
      queue.clear()
      for (const job of jobs) run(job)
    }
  } finally {
    depth--
  }
}

function listenerSet() {
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) run(listener)
  }
  return { listeners, notify }
}

export function memoryStore<T>(initial: T): Store<T> {
  let value = initial
  const { listeners, notify } = listenerSet()
  const readonly: ReadonlyStore<T> = {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const set = (next: T) => {
    if (Object.is(next, value)) return
    value = next
    schedule(notify)
  }
  return { ...readonly, set, update: (change) => set(change(value)), readonly }
}

type Values<S extends readonly ReadonlyStore<unknown>[]> = {
  [K in keyof S]: S[K] extends ReadonlyStore<infer V> ? V : never
}

/**
 * A value computed from other stores. It recomputes only when a source value changed, and keeps its
 * previous reference when `equals` says the result is the same.
 */
export function derived<const S extends readonly ReadonlyStore<unknown>[], T>(
  sources: S,
  compute: (...values: Values<S>) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): ReadonlyStore<T> {
  let inputs: unknown[] | undefined
  let value!: T
  /** What subscribers last heard: a `get()` between a change and its notification must not hide it. */
  let notified: T | undefined
  const { listeners, notify } = listenerSet()
  let detach: (() => void)[] = []

  const get = (): T => {
    const next = sources.map((source) => source.get())
    if (inputs && next.every((input, i) => Object.is(input, inputs![i]))) return value
    const computed = compute(...(next as Values<S>))
    if (!inputs || !equals(value, computed)) value = computed
    inputs = next
    return value
  }
  const check = () => {
    const next = get()
    if (next === notified) return
    notified = next
    notify()
  }
  const onSource = () => schedule(check)

  return {
    get,
    subscribe(listener) {
      const first = listeners.size === 0
      // Listening first: a source that catches up as it is subscribed reaches this listener.
      listeners.add(listener)
      if (first) {
        notified = get()
        detach = sources.map((source) => source.subscribe(onSource))
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        for (const off of detach) off()
        detach = []
      }
    },
  }
}

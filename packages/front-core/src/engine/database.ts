import { WalletError } from "./errors"
import { batch } from "./store"

/** One write: a value, or `null` for a removal. */
export type Op = readonly [key: string, value: string | null]

/** Bounds of a `range`: `after` and `before` are whole keys, both exclusive. */
export interface RangeOptions {
  after?: string
  before?: string
  limit?: number
  reverse?: boolean
}

/**
 * What a platform implements: async, transactional, ordered by key. Keys are ASCII, so every
 * platform orders them alike.
 */
export interface DatabaseBackend {
  get(key: string): Promise<string | undefined>
  /** One value per key, in the order asked. */
  getMany(keys: readonly string[]): Promise<(string | undefined)[]>
  /** Entries whose key starts with `prefix`, in key order. */
  range(prefix: string, opts?: RangeOptions): Promise<[string, string][]>
  /** All or nothing. */
  apply(ops: readonly Op[]): Promise<void>
}

/** Reads of saved state. Keys are relative to the database's `prefix`. */
export interface Reads {
  /** Where this view sits in the backend's keys. */
  readonly prefix: string
  get(key: string): Promise<string | undefined>
  getMany(keys: readonly string[]): Promise<(string | undefined)[]>
}

/** One running write: reads see saved state plus what it staged. */
export interface Write extends Reads {
  put(key: string, value: string): void
  remove(key: string): void
  scoped(prefix: string): Write
}

/** The database stores use: reads of saved state, and one serialized writer. */
export interface Database extends Reads {
  range(prefix: string, opts?: RangeOptions): Promise<[string, string][]>
  /**
   * Runs `fn` alone among writes. What it stages commits as one transaction once it resolves;
   * nothing commits if it throws or the commit fails. Listeners hear the commit before this
   * resolves. A write inside `fn` that does not take its `w` waits for `fn`, so it never ends.
   */
  write<T>(fn: (w: Write) => Promise<T>): Promise<T>
  /** Keys under `prefix`, read without it. Aborting `signal` drops every listener added through it. */
  scoped(prefix: string, signal?: AbortSignal): Database
  /** Hears each committed transaction's writes under this prefix, all in one store `batch`. */
  onCommit(listener: (ops: readonly Op[]) => void): () => void
}

/** A listener that throws must not fail a commit that landed; the error still surfaces. */
function hear(listener: (ops: readonly Op[]) => void, ops: readonly Op[]): void {
  try {
    listener(ops)
  } catch (e) {
    queueMicrotask(() => {
      throw e
    })
  }
}

export function openDatabase(backend: DatabaseBackend): Database {
  const listeners = new Set<(ops: readonly Op[]) => void>()
  let queue: Promise<unknown> = Promise.resolve()

  const commit = async (ops: readonly Op[]) => {
    await backend.apply(ops)
    batch(() => {
      for (const listener of [...listeners]) hear(listener, ops)
    })
  }

  const write = <T>(fn: (w: Write) => Promise<T>): Promise<T> => {
    const run = async () => {
      const staged = new Map<string, string | null>()
      let open = true
      const live = () => {
        if (!open) throw new WalletError("invariant", "write used after it ended")
      }
      const stagedView = (prefix: string): Write => ({
        prefix,
        async get(key) {
          live()
          const at = prefix + key
          if (staged.has(at)) return staged.get(at) ?? undefined
          return backend.get(at)
        },
        async getMany(keys) {
          live()
          const at = keys.map((key) => prefix + key)
          const fetched = at.filter((key) => !staged.has(key))
          const saved = await backend.getMany(fetched)
          const read = new Map(fetched.map((key, i) => [key, saved[i]]))
          return at.map((key) => (staged.has(key) ? staged.get(key) ?? undefined : read.get(key)))
        },
        put(key, value) {
          live()
          staged.set(prefix + key, value)
        },
        remove(key) {
          live()
          staged.set(prefix + key, null)
        },
        scoped: (inner) => stagedView(prefix + inner),
      })
      try {
        const result = await fn(stagedView(""))
        if (staged.size > 0) await commit([...staged])
        return result
      } finally {
        open = false
      }
    }
    const done = queue.then(run, run)
    queue = done.then(
      () => undefined,
      () => undefined,
    )
    return done
  }

  const view = (prefix: string, signal?: AbortSignal): Database => {
    const mine = new Set<() => void>()
    signal?.addEventListener("abort", () => {
      for (const off of [...mine]) off()
    })
    return {
      prefix,
      get: (key) => backend.get(prefix + key),
      getMany: (keys) => backend.getMany(keys.map((key) => prefix + key)),
      async range(inner, opts = {}) {
        const at = (key: string | undefined) => (key === undefined ? undefined : prefix + key)
        const entries = await backend.range(prefix + inner, {
          ...opts,
          after: at(opts.after),
          before: at(opts.before),
        })
        return entries.map(([key, value]) => [key.slice(prefix.length), value])
      },
      write: (fn) => write((w) => fn(prefix ? w.scoped(prefix) : w)),
      scoped: (inner, own) =>
        view(prefix + inner, own && signal ? AbortSignal.any([signal, own]) : own ?? signal),
      onCommit(listener) {
        if (signal?.aborted) return () => {}
        const heard = (ops: readonly Op[]) => {
          const under = ops.flatMap(([key, value]): Op[] =>
            key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [],
          )
          if (under.length > 0) listener(under)
        }
        listeners.add(heard)
        const off = () => {
          listeners.delete(heard)
          mine.delete(off)
        }
        mine.add(off)
        return off
      },
    }
  }

  return view("")
}

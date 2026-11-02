import type { DatabaseBackend, RangeOptions } from "./database"
import { WalletError } from "./errors"

/** The entries of `entries` a `range(prefix, opts)` returns. */
export function selectRange(
  entries: Iterable<readonly [string, string]>,
  prefix: string,
  { after, before, limit, reverse }: RangeOptions = {},
): [string, string][] {
  const found = [...entries]
    .filter(
      ([key]) =>
        key.startsWith(prefix) &&
        (after === undefined || key > after) &&
        (before === undefined || key < before),
    )
    .map(([key, value]): [string, string] => [key, value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (reverse) found.reverse()
  return limit === undefined ? found : found.slice(0, limit)
}

export interface MemoryBackend extends DatabaseBackend {
  /** What the backend holds; shared, so a test can inspect or seed it. */
  readonly entries: Map<string, string>
  /** While set, reads or commits reject and change nothing. */
  failing: { reads?: boolean; commits?: boolean }
}

/** A backend that keeps nothing past the process. */
export function memoryBackend(entries: Map<string, string> = new Map()): MemoryBackend {
  const read = <T>(value: () => T): Promise<T> =>
    backend.failing.reads ? Promise.reject(new Error("read failed")) : Promise.resolve(value())
  const backend: MemoryBackend = {
    entries,
    failing: {},
    get: (key) => read(() => entries.get(key)),
    getMany: (keys) => read(() => keys.map((key) => entries.get(key))),
    range: (prefix, opts) => read(() => selectRange(entries, prefix, opts)),
    async apply(ops) {
      if (backend.failing.commits) throw new WalletError("unknown", "commit failed")
      for (const [key, value] of ops) {
        if (value === null) entries.delete(key)
        else entries.set(key, value)
      }
    },
  }
  return backend
}

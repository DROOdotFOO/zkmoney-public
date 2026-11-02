import { mapRange, type StateMap } from "../../src/platform/storage/mapRange"
import type { WalletDb, WalletDbBackend, WalletOp } from "../../src/platform/storage/walletStorage"

type Stored = { state: Map<string, string>; held: boolean }

/** Called before each transaction lands; throw to fail it, await to delay it. */
export type ApplyHook = (version: string, ops: readonly WalletOp[]) => void | Promise<void>

/**
 * In-memory stand-in for the per-rollup SQLite databases. Databases persist across opens until
 * `reset`; an open of a database another handle holds fails the way kv-store's pool lock does.
 */
export class FakeWalletDbs implements WalletDbBackend {
  readonly stored = new Map<string, Stored>()
  onApply?: ApplyHook

  reset(): void {
    this.stored.clear()
    this.onApply = undefined
  }

  /** The saved state of `wallet_<version>`, creating it empty. */
  db(version: string): Stored {
    let entry = this.stored.get(version)
    if (!entry) {
      entry = { state: new Map(), held: false }
      this.stored.set(version, entry)
    }
    return entry
  }

  async open(version: string, persistent: boolean): Promise<WalletDb> {
    const entry: Stored = persistent ? this.db(version) : { state: new Map(), held: false }
    if (entry.held) {
      const busy = new Error(`pool .aztec-kv-wallet_${version} is busy`)
      busy.name = "SqlitePoolBusyError"
      throw busy
    }
    entry.held = true
    let closed = false
    return {
      persistent,
      load: async () => ({ state: new Map(entry.state) }),
      get: async (key) => entry.state.get(key),
      getMany: async (keys) => keys.map((key) => entry.state.get(key)),
      range: (prefix, opts) => mapRange(stateMap(entry.state), prefix, opts),
      apply: async (ops) => {
        if (closed) throw new Error(`wallet_${version} is closed`)
        await this.onApply?.(version, ops)
        for (const [key, value] of ops) {
          if (value === null) entry.state.delete(key)
          else entry.state.set(key, value)
        }
      },
      close: async () => {
        closed = true
        entry.held = false
      },
    }
  }

  async list(): Promise<string[]> {
    return [...this.stored.keys()]
  }
}

/** kv-store's map over `state`, its range bounds flipping with direction as the SQLite one does. */
export function stateMap(state: ReadonlyMap<string, string>): StateMap {
  return {
    getAsync: async (key) => state.get(key),
    async *entriesAsync({ start, end, limit, reverse } = {}) {
      const keys = [...state.keys()].sort()
      const found = keys.filter((key) =>
        reverse
          ? (start === undefined || key > start) && (end === undefined || key <= end)
          : (start === undefined || key >= start) && (end === undefined || key < end),
      )
      if (reverse) found.reverse()
      for (const key of found.slice(0, limit)) yield [key, state.get(key)!]
    },
  }
}

const SHARED = Symbol.for("zk.money/test-wallet-dbs")

/** The instance `test/setup.ts` installs, shared across module resets. */
export function testWalletDbs(): FakeWalletDbs {
  const holder = globalThis as { [SHARED]?: FakeWalletDbs }
  return (holder[SHARED] ??= new FakeWalletDbs())
}

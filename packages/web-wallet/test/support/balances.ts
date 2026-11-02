// The store primitive itself, never a module mock of it.
import { memoryStore, type Balances, type BalanceView } from "@obsidion/front-core"

const UNKNOWN: BalanceView = {
  main: null,
  live: false,
  known: false,
  syncing: false,
  progress: null,
  readAt: undefined,
}

/** The session's balances, holding `view`. */
export function balancesOf(
  view: Partial<Omit<BalanceView, "main">> & { main?: bigint | null } = {},
): Pick<Balances, "view" | "records"> {
  const { main, ...rest } = view
  const full = {
    ...UNKNOWN,
    ...rest,
    main: main === undefined || main === null ? null : { atomic: main },
  }
  return {
    view: memoryStore(full).readonly,
    records: memoryStore({ hydrated: true, entries: [] }).readonly,
  }
}

type ViewInput = Parameters<typeof balancesOf>[0]

/** Balances read from `view()` at each render: a fixture a test changes between renders. */
export function liveBalances(view: () => ViewInput): Pick<Balances, "view" | "records"> {
  let key: string | undefined
  let shown: BalanceView | undefined
  const get = (): BalanceView => {
    const next = view()
    const nextKey = JSON.stringify(next, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))
    if (nextKey !== key || !shown) {
      key = nextKey
      shown = balancesOf(next).view.get()
    }
    return shown
  }
  return {
    view: { get, subscribe: () => () => {} },
    records: memoryStore({ hydrated: true, entries: [] }).readonly,
  }
}

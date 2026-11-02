import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { savingsValue } from "../core/services/savings/savingsMath"
import type { SavingsPosition, SavingsPrice, SavingsSource } from "../core/services/savings/types"
import { selectEntry, type BalanceRecords } from "../engine/balances"
import type { ReadonlyStore } from "../engine/store"
import { useStore } from "../hooks/useStore"

export const SAVINGS_PRICE_INTERVAL_MS = 60_000

interface SavingsContextValue {
  /** Null where the profile lists no savings asset; `useSavings` then reports `available: false`. */
  source: SavingsSource | null
  position: SavingsPosition | null
  /** True once the shares held are known and the first price read has answered, with a price or not. */
  hydrated: boolean
  refresh(): Promise<void>
}

const SavingsContext = createContext<SavingsContextValue>({
  source: null,
  position: null,
  hydrated: false,
  refresh: async () => {},
})

/**
 * Holds the Savings position for every Savings surface: the shares the wallet's sync keeps in the
 * balance store, as Main's balance, valued at the vault's share price read on L1 on a cadence.
 */
export function SavingsProvider({
  source,
  balances,
  children,
}: {
  source: SavingsSource | null
  balances: ReadonlyStore<BalanceRecords>
  children: ReactNode
}) {
  const entry = useStore(
    balances,
    useCallback(
      (records: BalanceRecords) =>
        source && selectEntry(records, source.balance.scope, source.balance.tokenAddress),
      [source],
    ),
  )
  const shares = entry?.atomic

  // Tagged with its source, so a new source starts unread; only the latest read lands.
  const [read, setRead] = useState<{ source: SavingsSource; price: SavingsPrice | null }>()
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    if (!source) return
    const id = ++latest.current
    let price: SavingsPrice | undefined
    try {
      price = await source.readPrice()
    } catch (err) {
      console.warn("[useSavings] price read failed:", err)
    }
    if (id !== latest.current) return
    setRead((prev) => ({
      source,
      price: price ?? (prev?.source === source ? prev.price : null),
    }))
  }, [source])
  useEffect(() => {
    if (!source) return
    void refresh()
    const timer = setInterval(() => void refresh(), SAVINGS_PRICE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, refresh])

  const price = read?.source === source ? read.price : undefined
  const hydrated = price !== undefined && shares !== undefined
  const position = useMemo<SavingsPosition | null>(
    () =>
      price && shares !== undefined
        ? {
            shares,
            value: savingsValue(shares, price.sharePrice),
            ...price,
            sharesReadAt: entry?.readAt,
          }
        : null,
    [price, shares, entry?.readAt],
  )
  const value = useMemo(
    () => ({ source, position, hydrated, refresh }),
    [source, position, hydrated, refresh],
  )
  return <SavingsContext.Provider value={value}>{children}</SavingsContext.Provider>
}

export const useSavingsSource = (): SavingsSource | null => useContext(SavingsContext).source

/** The shared position: what the shares are worth and the vault's share price. */
export function useSavingsPosition(): Pick<
  SavingsContextValue,
  "position" | "hydrated" | "refresh"
> {
  const { position, hydrated, refresh } = useContext(SavingsContext)
  return { position, hydrated, refresh }
}

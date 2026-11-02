import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { SavingsProvider } from "../../src/contexts/useSavingsContext"
import { useSavings } from "../../src/hooks/useSavings"
import { BalanceStorage } from "../../src/core/storages/BalanceStorage"
import type {
  SavingsMoveRecord,
  SavingsPrice,
  SavingsSource,
} from "../../src/core/services/savings/types"
import { createBalances, type Balances } from "../../src/engine/balances"
import { memoryStore } from "../../src/engine/store"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const ONE = 10n ** 18n
const BALANCE = { scope: "sandbox:0xcomplete", tokenAddress: "0xsav" }

function fakeSource(initial: SavingsMoveRecord[] = []) {
  let records = initial
  const listeners = new Set<(records: SavingsMoveRecord[]) => void>()
  let reads = 0
  const source = {
    moves: {
      load: async () => {},
      list: () => records,
      onListChanged: (listener: (records: SavingsMoveRecord[]) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    balance: BALANCE,
    readPrice: vi.fn(async (): Promise<SavingsPrice> => {
      reads += 1
      return { sharePrice: BigInt(reads) * ONE, apy: 0.05, readAt: reads }
    }),
    quote: vi.fn(),
    move: vi.fn(async (direction, amount) => ({ direction, amount: String(amount) })),
    settle: vi.fn(),
  } as unknown as SavingsSource
  const write = (next: SavingsMoveRecord[]) => {
    records = next
    for (const listener of listeners) listener(records)
  }
  return { source, write }
}

let storage: BalanceStorage
let balances: Balances

const holdShares = (shares: bigint, anchor = 1) =>
  act(() => storage.updateBalance(BALANCE.scope, BALANCE.tokenAddress, shares, anchor))

const wrap =
  (source: SavingsSource | null) =>
  ({ children }: { children: ReactNode }) =>
    (
      <SavingsProvider source={source} balances={balances.records}>
        {children}
      </SavingsProvider>
    )

beforeEach(() => {
  storage = new BalanceStorage(new InMemoryStorageAdapter())
  balances = createBalances(
    storage,
    {
      network: null,
      account: memoryStore({ value: undefined, loaded: true }),
      tokens: memoryStore({ value: [], loaded: true }),
      activeToken: memoryStore(null),
    },
    memoryStore({ syncing: false, progress: null }).readonly,
  )
})

describe("useSavings", () => {
  it("reports no Savings without a source", () => {
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(null) })
    expect(result.current.available).toBe(false)
    expect(result.current.position).toBeNull()
    expect(result.current.moves).toEqual([])
  })

  it("values the shares the sync stored at the price read, and lists the store's moves", async () => {
    const pending = { withdrawalLocalId: "w1", direction: "in", startTime: 1 } as SavingsMoveRecord
    const { source } = fakeSource([pending])
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(source.readPrice).toHaveBeenCalledTimes(1))
    // The price alone is not a position: the shares come from the wallet's sync.
    expect(result.current.hydrated).toBe(false)
    await holdShares(3n * ONE)
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    expect(result.current.available).toBe(true)
    expect(result.current.position).toMatchObject({ shares: 3n * ONE, value: 3n * ONE, apy: 0.05 })
    expect(result.current.position?.sharesReadAt).toBe(storage.list()[0]!.updatedAt)
    expect(result.current.moves).toEqual([pending])
  })

  it("moves with the stored shares, with no read of its own", async () => {
    const { source } = fakeSource()
    await holdShares(ONE)
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(result.current.position?.value).toBe(ONE))
    await holdShares(5n * ONE, 2)
    await waitFor(() => expect(result.current.position?.value).toBe(5n * ONE))
    expect(source.readPrice).toHaveBeenCalledTimes(1)
  })

  it("re-reads the price after a move is sent", async () => {
    const { source } = fakeSource()
    await holdShares(ONE)
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    await act(async () => {
      await result.current.move("in", 5n, () => {})
    })
    expect(source.move).toHaveBeenCalledWith("in", 5n, expect.any(Function))
    await waitFor(() => expect(source.readPrice).toHaveBeenCalledTimes(2))
  })

  it("drops a slow read from the source it replaced, and starts the new source unread", async () => {
    await holdShares(ONE)
    const price = (sharePrice: bigint): SavingsPrice => ({ sharePrice, readAt: 0 })
    let answerOld!: (p: SavingsPrice) => void
    const { source: old } = fakeSource()
    vi.mocked(old.readPrice).mockImplementation(
      () => new Promise((resolve) => (answerOld = resolve)),
    )
    const { source: next } = fakeSource()
    let answerNext!: (p: SavingsPrice) => void
    vi.mocked(next.readPrice).mockImplementation(
      () => new Promise((resolve) => (answerNext = resolve)),
    )
    let current: SavingsSource = old
    const { result, rerender } = renderHook(() => useSavings(), {
      wrapper: ({ children }) => (
        <SavingsProvider source={current} balances={balances.records}>
          {children}
        </SavingsProvider>
      ),
    })
    current = next
    rerender()
    expect(result.current.hydrated).toBe(false)
    await act(async () => answerNext(price(7n * ONE)))
    await act(async () => answerOld(price(99n * ONE)))
    expect(result.current.position?.value).toBe(7n * ONE)
  })

  it("keeps the latest of two overlapping reads", async () => {
    await holdShares(ONE)
    const { source } = fakeSource()
    const answers: ((sharePrice: bigint) => void)[] = []
    vi.mocked(source.readPrice).mockImplementation(
      () =>
        new Promise((resolve) => answers.push((sharePrice) => resolve({ sharePrice, readAt: 0 }))),
    )
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(answers).toHaveLength(1))
    act(() => void result.current.refresh())
    await act(async () => answers[1](2n * ONE))
    await act(async () => answers[0](ONE))
    expect(result.current.position?.value).toBe(2n * ONE)
  })
})

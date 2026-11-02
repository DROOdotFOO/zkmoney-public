import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { L1TokenBalance } from "../../../../src/features/deposit/l1DepositTokenBalance"

const readL1DepositTokenBalance = vi.fn<() => Promise<L1TokenBalance>>()
vi.mock("../../../../src/features/deposit/l1DepositTokenBalance", () => ({
  readL1DepositTokenBalance: () => readL1DepositTokenBalance(),
}))

const { L1_BALANCE_REFRESH_MS, useL1TokenBalance } = await import(
  "../../../../src/features/deposit/useL1TokenBalance"
)

const holds = (raw: bigint): L1TokenBalance => ({
  raw,
  value: Number(raw),
  display: "",
  symbol: "TST",
  decimals: 0,
})

let balance: L1TokenBalance | undefined
function Probe() {
  balance = useL1TokenBalance({ account: "0x1", wrongChain: false })
  return null
}

let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  readL1DepositTokenBalance.mockReset().mockImplementation(async () => holds(0n))
  root = createRoot(document.createElement("div"))
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

it("reads the balance again while open, so a mint shows without reopening", async () => {
  await act(async () => root.render(<Probe />))
  expect(balance?.raw).toBe(0n)
  readL1DepositTokenBalance.mockResolvedValue(holds(1000n))
  await act(async () => vi.advanceTimersByTime(L1_BALANCE_REFRESH_MS))
  expect(balance?.raw).toBe(1000n)
})

it("reads it again when the page regains focus, and keeps it through a failed read", async () => {
  await act(async () => root.render(<Probe />))
  readL1DepositTokenBalance.mockResolvedValue(holds(5n))
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(balance?.raw).toBe(5n)
  readL1DepositTokenBalance.mockRejectedValue(new Error("rpc down"))
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(balance?.raw).toBe(5n)
})

it("keeps the newest read when an older one finishes after it", async () => {
  let slow!: (b: L1TokenBalance) => void
  readL1DepositTokenBalance.mockReturnValueOnce(new Promise((resolve) => (slow = resolve)))
  await act(async () => root.render(<Probe />))
  readL1DepositTokenBalance.mockResolvedValue(holds(1000n))
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(balance?.raw).toBe(1000n)
  await act(async () => slow(holds(0n)))
  expect(balance?.raw).toBe(1000n)
})

it("hands back a new balance on every read, so an unchanged one still counts as fresh", async () => {
  await act(async () => root.render(<Probe />))
  const first = balance
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(balance?.raw).toBe(first?.raw)
  expect(balance).not.toBe(first)
})

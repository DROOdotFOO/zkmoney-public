// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { SIPADepositStore } from "@obsidion/front-core"
const gateway = vi.hoisted(() => ({ observe: vi.fn() }))
vi.mock("../../../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
import {
  observeDeposits,
  observeNow,
  resetDepositPassesForTests,
  watchDeposits,
} from "../../../src/features/deposit/depositPasses"
import { useDepositWatch } from "../../../src/features/onboarding/useDepositWatch"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { walletStorage } from "../../../src/platform/storage/walletStorage"

const FIRST = "0x00000000000000000000000000000000000000a2" as Address
const SECOND = "0x00000000000000000000000000000000000000a3" as Address
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address

const rail = () => SIPADepositStore.get(webStorage)

async function seed(address: Address, over: Record<string, unknown> = {}) {
  await rail().load()
  await rail().upsert(
    address,
    { phase: "resolved" } as never,
    {
      networkId: "0xnet",
      amount: "0",
      startTime: Date.now(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      ...over,
    } as never,
  )
}

beforeEach(() => {
  for (const key of walletStorage.keys()) walletStorage.removeItem(key)
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  resetDepositPassesForTests()
  gateway.observe.mockReset().mockResolvedValue({})
})

const WALLET = {} as never
const ACCOUNT = `0x${"cd".repeat(32)}`
afterEach(() => vi.useRealTimers())

function render(view: React.ReactNode) {
  const el = document.createElement("div")
  const root = createRoot(el)
  return {
    el,
    show: (next: React.ReactNode) => act(async () => root.render(next)),
    done: () => act(async () => root.unmount()),
    first: act(async () => root.render(view)),
  }
}

function Balance({ address }: { address: Address | null }) {
  const { balance, token } = useDepositWatch(address)
  return <span>{`${balance}:${token}`}</span>
}

it("reads a record from older storage, with no observed balance, as empty", async () => {
  await seed(FIRST, { amount: "3" })
  const view = render(<Balance address={FIRST} />)
  await view.first
  expect(view.el.textContent).toBe("0:undefined")
  await view.done()
})

it("never grants a new address the previous one's balance", async () => {
  await seed(FIRST, { heldBalance: "5", tokenAddress: USDC })
  await seed(SECOND)
  const view = render(<Balance address={FIRST} />)
  await view.first
  expect(view.el.textContent).toBe(`5:${USDC}`)
  await view.show(<Balance address={SECOND} />)
  expect(view.el.textContent).toBe("0:undefined")
  await view.show(<Balance address={null} />)
  expect(view.el.textContent).toBe("0:undefined")
  await view.done()
})

it("shows when the last pass landed, only once the rail has read the address", async () => {
  vi.useFakeTimers()
  await seed(FIRST)
  observeDeposits(WALLET, ACCOUNT)
  function When() {
    const { readAt } = useDepositWatch(FIRST)
    return <span>{String(readAt)}</span>
  }
  const view = render(<When />)
  await view.first
  expect(view.el.textContent).toBe("undefined")
  await act(async () => {
    await rail().upsert(FIRST, { phase: "resolved", observedFrom: "1" })
  })
  expect(Number(view.el.textContent)).toBe(Date.now())
  await view.done()
})

it("observes a signup on its own cadence, faster while watched, and the latest account first", async () => {
  vi.useFakeTimers()
  const releaseWallet = observeDeposits(WALLET, ACCOUNT)
  const signup = `0x${"ee".repeat(32)}`
  const releaseSignup = observeDeposits(WALLET, signup, 12_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(gateway.observe).toHaveBeenLastCalledWith(WALLET, signup)
  await vi.advanceTimersByTimeAsync(12_000)
  expect(gateway.observe).toHaveBeenCalledTimes(2)

  const release = watchDeposits()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(4_000)
  expect(gateway.observe).toHaveBeenCalledTimes(4)
  release()

  // Signup released: the wallet's account is observed again, and only while watched.
  releaseSignup()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(gateway.observe).toHaveBeenCalledTimes(4)
  watchDeposits()
  await vi.advanceTimersByTimeAsync(0)
  expect(gateway.observe).toHaveBeenLastCalledWith(WALLET, ACCOUNT)
  releaseWallet()
})

it("joins a pass in flight, and rejects a manual read whose pass fails", async () => {
  observeDeposits(WALLET, ACCOUNT)
  let land!: (result: object) => void
  gateway.observe.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
  const first = observeNow()
  const second = observeNow()
  expect(gateway.observe).toHaveBeenCalledTimes(1)
  land({})
  await Promise.all([first, second])
  gateway.observe.mockRejectedValueOnce(new Error("HTTP request failed."))
  await expect(observeNow()).rejects.toThrow("HTTP request failed.")
})

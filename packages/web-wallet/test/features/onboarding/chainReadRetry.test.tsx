/**
 * A registration surface with no Check pill has nothing to nudge a chain read that gave up. This
 * hook is that nudge: while the surface reports a read still unknown, it calls the retry on a slow
 * cadence, a bounded number of times.
 */
import { act, useCallback, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../../src/config/env"

const h = vi.hoisted(() => ({
  transfers: vi.fn(),
  read: vi.fn(),
  skim: vi.fn(),
}))

vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1RpcUrl: "http://127.0.0.1:8545" }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    portal: `0x${"b1".repeat(20)}`,
    registry: `0x${"b2".repeat(20)}`,
    sipaFactory: `0x${"b3".repeat(20)}`,
    forwardingTable: `0x${"b5".repeat(20)}`,
    token: `0x${"b6".repeat(20)}`,
    pool: `0x${"b4".repeat(20)}`,
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({ readContract: (args: { functionName: string }) => h.read(args) }),
}))
// One row, of the record's token.
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const tokens = singleToken(`0x${"d4".repeat(20)}`)
  return mockLoadDepositFacts(importOriginal, () => tokens)
})
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFundingTransfers: () => h.transfers(),
  readDepositFee: () => h.skim(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registrationSipaImplementation: async () => `0x${"b5".repeat(20)}`,
}))

const {
  CHAIN_READ_RETRIES,
  CHAIN_READ_RETRY_MS,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
} = await import("../../../src/features/onboarding/registrationTerms")
const { useFundingTransfer } = await import("../../../src/features/onboarding/registrationFunding")

const CONFIG = { network: "testnet", l1RpcUrl: "http://127.0.0.1:8545" } as WebWalletConfig
const TOKEN = `0x${"d4".repeat(20)}`
const RECORD = {
  depositToken: TOKEN,
  sipaAddress: `0x${"c3".repeat(20)}`,
} as PendingRegistrationRecord

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

let container: HTMLDivElement
let root: Root

/** Renders the retry count into the DOM, driven by a pending flag the test owns. */
function Probe({ pending }: { pending: boolean }) {
  const [key, setKey] = useState(0)
  const retry = useCallback(() => setKey((n) => n + 1), [])
  useChainReadRetry(pending, retry)
  return <span data-testid="key">{key}</span>
}
const mount = (pending: boolean) =>
  act(() => {
    root.render(<Probe pending={pending} />)
  })

const key = () => Number(container.querySelector('[data-testid="key"]')!.textContent)
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  h.transfers.mockReset()
  h.read.mockReset()
  h.skim.mockReset()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("useChainReadRetry", () => {
  it("starts once a read becomes unknown and stops once it lands", async () => {
    await mount(false)
    await mount(true)
    await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(1)

    await mount(false)
    for (let tick = 0; tick < 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(1)
  })

  it("gives a read that falls back to unknown its full budget again", async () => {
    await mount(true)
    for (let tick = 0; tick < CHAIN_READ_RETRIES + 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES)

    // A new record, or a figure this deployment answered and a later one did not.
    await mount(false)
    await mount(true)
    for (let tick = 0; tick < CHAIN_READ_RETRIES + 3; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES * 2)
  })
})

describe("useChainReadRetry state", () => {
  let state: ReturnType<typeof useChainReadRetry>
  function StateProbe({ pending }: { pending: boolean }) {
    const [key, setKey] = useState(0)
    const retry = useCallback(() => setKey((n) => n + 1), [])
    state = useChainReadRetry(pending, retry)
    return <span data-testid="key">{key}</span>
  }
  const show = (pending: boolean) =>
    act(() => {
      root.render(<StateProbe pending={pending} />)
    })

  it("says when unread figures are being retried, when the retries ran out, and starts over on demand", async () => {
    await show(true)
    expect(state).toMatchObject({ retrying: false, exhausted: false })

    await wait(CHAIN_READ_RETRY_MS)
    expect(state).toMatchObject({ retrying: true, exhausted: false })

    for (let tick = 0; tick < CHAIN_READ_RETRIES; tick++) await wait(CHAIN_READ_RETRY_MS)
    expect(state).toMatchObject({ retrying: false, exhausted: true })
    expect(key()).toBe(CHAIN_READ_RETRIES)

    await act(async () => state.retryNow())
    expect(key()).toBe(CHAIN_READ_RETRIES + 1)
    expect(state.exhausted).toBe(false)
    await wait(CHAIN_READ_RETRY_MS)
    expect(key()).toBe(CHAIN_READ_RETRIES + 2)
  })

  it("reports nothing once the figures land", async () => {
    await show(true)
    for (let tick = 0; tick < CHAIN_READ_RETRIES; tick++) await wait(CHAIN_READ_RETRY_MS)
    await show(false)
    expect(state).toMatchObject({ retrying: false, exhausted: false })
  })
})

describe("useRegistrationSchedule", () => {
  /** One read of the schedule: the controller lookup, then its two immutables. */
  const READS_PER_ATTEMPT = 3

  function Probe({ refreshKey }: { refreshKey: number }) {
    const schedule = useRegistrationSchedule(CONFIG, true, refreshKey, 0n)
    if (schedule === undefined) return <span data-testid="key" />
    return <span data-testid="key">{schedule === null ? "none" : String(schedule.fee)}</span>
  }
  const fee = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })
  const answer = (min: bigint, feeWei: bigint) =>
    h.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "registrationController") return `0x${"c1".repeat(20)}`
      return functionName === "REGISTRATION_MIN" ? min : feeWei
    })

  it("treats a zero schedule as settled, not as a read to run again", async () => {
    answer(0n, 0n)
    await show(0)
    expect(fee()).toBe("none")

    await show(1)
    await wait(2_000)

    expect(h.read).toHaveBeenCalledTimes(READS_PER_ATTEMPT)
    expect(fee()).toBe("none")
  })
})

describe("useDepositSkim", () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const skim = useDepositSkim(CONFIG, true, refreshKey)
    return <span data-testid="key">{skim === undefined ? "" : String(skim)}</span>
  }
  const skim = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })

  // The three attempts every one-shot chain read makes before it waits for its next trigger.
  it("rides out two failed reads and yields what the third answers", async () => {
    h.skim
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce(4n)
    await show(0)
    await wait(2_000)

    expect(h.skim).toHaveBeenCalledTimes(3)
    expect(skim()).toBe("4")
  })

  it("stays unread when every attempt fails, rather than reading as a zero skim", async () => {
    h.skim.mockRejectedValue(new Error("rpc down"))
    await show(0)
    await wait(2_000)

    expect(skim()).toBe("")
  })

  it("holds the skim it read across a bumped key", async () => {
    h.read.mockResolvedValue(`0x${"c2".repeat(20)}`)
    h.skim.mockResolvedValue(4n)
    await show(0)
    expect(skim()).toBe("4")

    await show(1)
    await wait(2_000)

    expect(h.skim).toHaveBeenCalledTimes(1)
    expect(skim()).toBe("4")
  })
})

describe("useFundingTransfer", () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const funding = useFundingTransfer(RECORD, refreshKey)
    if (funding === undefined) return <span data-testid="key" />
    return <span data-testid="key">{funding === null ? "none" : String(funding.amount)}</span>
  }
  const amount = () => container.querySelector('[data-testid="key"]')!.textContent
  const show = (refreshKey: number) =>
    act(async () => {
      root.render(<Probe refreshKey={refreshKey} />)
    })

  it("runs the read again on a bumped key, after one that failed", async () => {
    h.transfers.mockRejectedValueOnce(new Error("rpc down"))
    await show(0)
    expect(amount()).toBe("")

    h.transfers.mockResolvedValueOnce([
      { from: `0x${"11".repeat(20)}` as Address, txHash: `0x${"22".repeat(32)}`, amount: 5n },
    ])
    await show(1)

    expect(h.transfers).toHaveBeenCalledTimes(2)
    expect(amount()).toBe("5")
  })

  it("treats an untouched address as settled, not as a read to run again", async () => {
    h.transfers.mockResolvedValue([])
    await show(0)
    expect(amount()).toBe("none")

    await show(1)

    expect(h.transfers).toHaveBeenCalledTimes(1)
    expect(amount()).toBe("none")
  })
})

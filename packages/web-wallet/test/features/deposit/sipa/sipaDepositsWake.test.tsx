/** A resolver payment recorded while a sync pass runs gets a pass of its own once that one ends. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  passes: [] as ((result: unknown) => void)[],
  onFunded: undefined as (() => void) | undefined,
  booted: Promise.resolve() as Promise<void>,
  watching: Promise.resolve() as Promise<void>,
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  SIPADepositStore: { get: () => ({}) },
  BOOT_WAIT_MS: 300_000,
  reconcileSipaRequestFulfillments: async () => undefined,
  useCachedRecords: () => ({ records: [] }),
}))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../../../../src/platform/visibilityScheduler", () => ({
  whenVisibilityChanges: () => () => {},
}))
vi.mock("../../../../src/lib/analytics", () => ({ fireEvent: () => undefined }))
const gateway = {
  warm: async () => undefined,
  sync: vi.fn(() => new Promise((resolve) => h.passes.push(resolve))),
  resolverPayments: vi.fn((_networkId: string, onFunded: () => void) => {
    h.onFunded = onFunded
    return { tick: async () => 12_000 }
  }),
}
vi.mock("../../../../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => gateway,
}))

const { useSipaDeposits } = await import("../../../../src/features/deposit/useSipaDeposits")
const { openTestSession } = await import("../../../support/session")

const IDLE = { active: 0, failed: 0 }

/** The pass's wait comes first; every later pass waits again. The resolver's is the second. */
let waits = 0
const milestones = {
  after: () => (waits++ === 1 ? h.watching : h.booted).then(() => true),
  progress: () => undefined,
  mark: () => undefined,
}

function Probe() {
  useSipaDeposits(milestones)
  return null
}

describe("useSipaDeposits wake", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    h.passes.length = 0
    waits = 0
    h.booted = Promise.resolve()
    h.watching = Promise.resolve()
    h.onFunded = undefined
    gateway.sync.mockClear()
    gateway.resolverPayments.mockClear()
    openTestSession({ wallet: {}, token: {} })
    vi.useFakeTimers()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it("runs another pass at once when a payment lands mid-pass", async () => {
    await act(async () => root.render(<Probe />))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)

    h.onFunded!()
    await act(async () => h.passes[0]!(IDLE))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(gateway.sync).toHaveBeenCalledTimes(2)
  })

  it("starts the resolver watcher at its boot stage", async () => {
    let reached!: () => void
    h.watching = new Promise((resolve) => (reached = resolve))
    await act(async () => root.render(<Probe />))
    expect(gateway.resolverPayments).not.toHaveBeenCalled()
    await act(async () => reached())
    expect(gateway.resolverPayments).toHaveBeenCalledTimes(1)
  })

  it("runs no extra pass for a payment recorded while the first pass waits on boot", async () => {
    let boot!: () => void
    h.booted = new Promise((resolve) => (boot = resolve))
    await act(async () => root.render(<Probe />))
    h.onFunded!()
    await act(async () => boot())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)
    await act(async () => h.passes[0]!(IDLE))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)
  })
})

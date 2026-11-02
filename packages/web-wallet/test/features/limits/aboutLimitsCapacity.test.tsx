import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  PortalCapacityKey,
  PortalCapacityState,
  PortalCapacityStore,
} from "@obsidion/front-core"
import type { CapacitySource } from "../../../src/features/limits/useAboutLimitsCapacity"

const ACTIVE: PortalCapacityKey = { chainId: 1, portal: "0xactive", token: "0xdai" }
const ORIGINAL: PortalCapacityKey = { chainId: 1, portal: "0xoriginal", token: "0xdai" }
const DAI = 10n ** 18n

/** A store whose state the test sets; `retry` is recorded. */
function fakeStore(key: PortalCapacityKey, availableAtomic: bigint) {
  const listeners = new Set<() => void>()
  let state: PortalCapacityState = {
    status: "fresh",
    key,
    fetchedAt: Date.now(),
    snapshot: {
      chainId: 1,
      portal: key.portal as `0x${string}`,
      token: key.token as `0x${string}`,
      decimals: 18,
      blockNumber: 1n,
      blockTimestamp: 1n,
      rateAtomicPerSecond: DAI,
      globalLimitAtomic: 50_000n * DAI,
      availableAtomic,
      txAmountCapAtomic: 5166n * DAI,
    },
  }
  return {
    key,
    policy: { refreshMs: 15_000, staleAfterMs: 30_000, maxHeadAgeMs: 60_000 },
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retry: vi.fn(async () => state),
    refresh: vi.fn(async () => state),
    refreshForSubmit: vi.fn(async () => state),
    set(next: PortalCapacityState) {
      state = next
      listeners.forEach((listener) => listener())
    },
  }
}

const registry = vi.hoisted(() => ({
  activeKey: vi.fn(),
  stores: new Map<string, unknown>(),
  store: vi.fn(),
}))
vi.mock("../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: registry.activeKey,
  depositCapacityStore: registry.store,
}))

const { useAboutLimitsCapacity } = await import(
  "../../../src/features/limits/useAboutLimitsCapacity"
)
const { CAPACITY_NONE } = await import("../../../src/features/deposit/fundingCapacity")

let root: Root
let container: HTMLDivElement
let latest: ReturnType<typeof useAboutLimitsCapacity>
function Probe({ source }: { source: CapacitySource }) {
  latest = useAboutLimitsCapacity(source, "DAI")
  return null
}
const render = (source: CapacitySource) => act(async () => root.render(<Probe source={source} />))

let active: ReturnType<typeof fakeStore>
let original: ReturnType<typeof fakeStore>

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  active = fakeStore(ACTIVE, 48_000n * DAI)
  original = fakeStore(ORIGINAL, 700n * DAI)
  registry.activeKey.mockReset().mockResolvedValue(ACTIVE)
  registry.store
    .mockReset()
    .mockImplementation((key: PortalCapacityKey) =>
      key.portal === ACTIVE.portal ? active : (original as unknown as PortalCapacityStore),
    )
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("useAboutLimitsCapacity", () => {
  it("shows the active bucket for new deposits and retries its store", async () => {
    await render({ kind: "active" })
    expect(registry.store).toHaveBeenCalledWith(ACTIVE)
    expect(latest.facts.state).toBe("fresh")
    expect(latest.facts.label).toBe("48,000 DAI")
    expect(latest.facts.notice).toBeUndefined()
    expect(latest.facts.offerRetry).toBe(false)
    latest.retry!()
    expect(active.retry).toHaveBeenCalledTimes(1)

    await act(async () =>
      active.set({ status: "unavailable", key: ACTIVE, error: new Error("rpc"), failedAt: 2 }),
    )
    expect(latest.facts).toEqual({ state: "unavailable" })
  })

  it("reports a failed deployment key as unavailable and tries the key again on retry", async () => {
    registry.activeKey.mockRejectedValueOnce(new Error("manifest down"))
    await render({ kind: "active" })
    expect(latest.facts).toEqual({ state: "unavailable" })
    expect(registry.store).not.toHaveBeenCalled()
    await act(async () => latest.retry!())
    expect(registry.activeKey).toHaveBeenCalledTimes(2)
    expect(latest.facts.label).toBe("48,000 DAI")
  })

  it("switches to the original bucket even after the active key has resolved", async () => {
    await render({ kind: "active" })
    expect(latest.facts.label).toBe("48,000 DAI")
    await render({ kind: "key", key: ORIGINAL })
    expect(registry.store).toHaveBeenLastCalledWith(ORIGINAL)
    expect(latest.facts.label).toBe("700 DAI")
    latest.retry!()
    expect(original.retry).toHaveBeenCalledTimes(1)
    expect(active.retry).not.toHaveBeenCalled()
  })

  it("says an empty bucket has no capacity and offers Check again, as the funding panel does", async () => {
    active = fakeStore(ACTIVE, 0n)
    await render({ kind: "active" })
    expect(latest.facts.state).toBe("fresh")
    expect(latest.facts.label).toBe("0 DAI")
    expect(latest.facts.notice).toBe(CAPACITY_NONE)
    expect(latest.facts.offerRetry).toBe(true)
    latest.retry!()
    expect(active.retry).toHaveBeenCalledTimes(1)
  })

  it("calls a read out of date once it is older than the store's stale age", async () => {
    await render({ kind: "active" })
    await act(async () =>
      active.set({
        ...(active.getState() as object),
        fetchedAt: Date.now() - 31_000,
      } as PortalCapacityState),
    )
    expect(latest.facts.state).toBe("stale")
    expect(latest.facts.label).toBe("48,000 DAI (not current)")
  })
})

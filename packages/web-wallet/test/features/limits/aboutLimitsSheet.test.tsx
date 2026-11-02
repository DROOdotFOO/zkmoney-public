import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AllowanceSnapshot, PortalCapacityKey } from "@obsidion/front-core"
import * as copy from "../../../src/features/limits/limitsCopy"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const ACTIVE_KEY = { chainId: 1, portal: "0x1111111111111111111111111111111111111111", token: DAI }
const freshState = {
  status: "fresh",
  key: ACTIVE_KEY,
  fetchedAt: Date.now(),
  snapshot: {
    chainId: 1,
    portal: ACTIVE_KEY.portal,
    token: DAI,
    decimals: 18,
    blockNumber: 1n,
    blockTimestamp: 1n,
    rateAtomicPerSecond: 10n ** 18n,
    globalLimitAtomic: 50_000n * 10n ** 18n,
    availableAtomic: 124_005n * 10n ** 17n,
  },
}
// `getState` must return the same object between changes, as the real store does.
const freshStore = {
  key: ACTIVE_KEY,
  policy: { refreshMs: 15_000, staleAfterMs: 30_000, maxHeadAgeMs: 60_000 },
  getState: () => freshState,
  subscribe: () => () => {},
  retry: vi.fn(),
}

vi.mock("../../../src/features/deposit/loadDepositFacts", () => ({
  useDepositTokens: () => ({ settlement: { symbol: "DAI" } }),
}))
const allowance = vi.hoisted(() => ({
  snapshot: { status: "loading", scope: "s" } as unknown,
  refresh: vi.fn(),
}))
const capacity = vi.hoisted(() => ({
  activeKey: vi.fn(),
  store: vi.fn(),
}))
vi.mock("../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: capacity.activeKey,
  depositCapacityStore: capacity.store,
}))
const observer = vi.hoisted(() => ({ retry: vi.fn() }))
vi.mock("../../../src/features/deposit/sipaProcessing", () => ({
  sipaProcessingObserver: () => observer,
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: allowance.snapshot, refresh: allowance.refresh }),
}))

const { LimitsInfoButton, PendingLimitsLink, WalletAboutLimitsSheet } = await import(
  "../../../src/features/limits/AboutLimitsSheet"
)

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  freshState.fetchedAt = Date.now()
  allowance.refresh.mockReset()
  capacity.activeKey.mockReset().mockResolvedValue(ACTIVE_KEY)
  capacity.store.mockReset().mockReturnValue(freshStore)
  allowance.snapshot = { status: "loading", scope: "s" }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const dialog = () =>
  document.querySelector<HTMLDialogElement>(`dialog[aria-label="${copy.SHEET_TITLE}"]`)
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe("WalletAboutLimitsSheet", () => {
  it("reads the allowance again on opening, with the active bucket's capacity", async () => {
    allowance.snapshot = {
      status: "ready",
      scope: "s",
      read: {
        fpcAddress: "0xfpc",
        railId: 1,
        payer: "0xacc",
        allowance: { subscribed: false, uses: 0, maxTx: 100, refillPeriod: 86_400 },
      },
      state: { kind: "not-subscribed", maxTx: 100, renews: true },
      refreshing: false,
    } satisfies AllowanceSnapshot
    await act(async () => root.render(<WalletAboutLimitsSheet onClose={vi.fn()} />))
    expect(allowance.refresh).toHaveBeenCalledTimes(1)
    expect(byTestId("about-limits-operation")?.textContent).toContain(copy.LIMIT_NOTE)
    expect(byTestId("about-limits-sponsorship")?.dataset.state).toBe("not-subscribed")
    expect(capacity.store).toHaveBeenCalledWith(ACTIVE_KEY)
    expect(byTestId("about-limits-capacity")?.dataset.state).toBe("fresh")
    expect(byTestId("about-limits-capacity")?.textContent).toContain("12,400.5 DAI")
  })

  it("leaves capacity out, and reads none, when the caller says so", async () => {
    await act(async () =>
      root.render(<WalletAboutLimitsSheet capacity={false} onClose={vi.fn()} />),
    )
    expect(byTestId("about-limits-capacity")).toBeNull()
    expect(byTestId("about-limits-operation")).not.toBeNull()
    expect(byTestId("about-limits-more")).not.toBeNull()
    expect(capacity.store).not.toHaveBeenCalled()
    expect(capacity.activeKey).not.toHaveBeenCalled()
  })

  it("retries a failed allowance read from the sheet", async () => {
    allowance.snapshot = { status: "unavailable", scope: "s", error: new Error("pxe") }
    await act(async () => root.render(<WalletAboutLimitsSheet onClose={vi.fn()} />))
    await act(async () => byTestId("about-limits-sponsorship-retry")!.click())
    expect(allowance.refresh).toHaveBeenCalledTimes(2)
  })
})

describe("LimitsInfoButton", () => {
  it("opens the sheet on its topic for its context and returns focus to the button on Escape", async () => {
    await act(async () =>
      root.render(
        <LimitsInfoButton
          topic="capacity"
          label="About network capacity"
          capacity={{ kind: "unresolved" }}
        />,
      ),
    )
    const button = byTestId("about-limits-link")!
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("aria-label")).toBe("About network capacity")
    button.focus()
    await act(async () => button.click())
    expect(dialog()?.open).toBe(true)
    const section = byTestId("about-limits-capacity")!
    expect(byTestId("about-limits-capacity-toggle")!.getAttribute("aria-expanded")).toBe("true")
    expect(byTestId("about-limits-operation-toggle")!.getAttribute("aria-expanded")).toBe("false")
    // An unknown original bucket shows unavailable and reads no store.
    expect(section.dataset.state).toBe("unavailable")
    expect(capacity.store).not.toHaveBeenCalled()
    expect(capacity.activeKey).not.toHaveBeenCalled()
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})

describe("PendingLimitsLink", () => {
  const SIPA = "0x5150000000000000000000000000000000005150"
  const ORIGINAL: PortalCapacityKey = {
    chainId: 1,
    portal: "0x9999999999999999999999999999999999999999",
    token: DAI,
  }
  const open = async () => {
    await act(async () => byTestId("about-limits-link")!.click())
    return byTestId("about-limits-capacity")!
  }

  it("shows the deposit's original bucket, not the active one, with the reason's detail", async () => {
    await act(async () =>
      root.render(
        <PendingLimitsLink
          sipaAddress={SIPA}
          capacityKey={{ status: "known", key: ORIGINAL }}
          detail={<p data-testid="reason-detail">This deposit needs 17.65 DAI.</p>}
        />,
      ),
    )
    const section = await open()
    expect(capacity.store).toHaveBeenCalledWith(ORIGINAL)
    expect(capacity.activeKey).not.toHaveBeenCalled()
    expect(section.dataset.state).toBe("fresh")
    expect(section.contains(byTestId("reason-detail"))).toBe(true)
  })

  it("retries a failed portal lookup through the processing observer", async () => {
    observer.retry.mockClear()
    await act(async () =>
      root.render(
        <PendingLimitsLink
          sipaAddress={SIPA}
          capacityKey={{ status: "unknown", retryable: true }}
        />,
      ),
    )
    const section = await open()
    expect(section.dataset.state).toBe("unavailable")
    await act(async () => byTestId("about-limits-capacity-retry")!.click())
    expect(observer.retry).toHaveBeenCalledWith(SIPA)
    expect(capacity.activeKey).not.toHaveBeenCalled()
    expect(capacity.store).not.toHaveBeenCalled()
  })

  it("offers no Retry when no lookup can name the bucket, and says Checking while one runs", async () => {
    await act(async () =>
      root.render(
        <PendingLimitsLink
          sipaAddress={SIPA}
          capacityKey={{ status: "unknown", retryable: false }}
        />,
      ),
    )
    const section = await open()
    expect(section.dataset.state).toBe("unavailable")
    expect(byTestId("about-limits-capacity-retry")).toBeNull()
    await act(async () =>
      root.render(<PendingLimitsLink sipaAddress={SIPA} capacityKey={{ status: "pending" }} />),
    )
    expect(byTestId("about-limits-capacity")!.dataset.state).toBe("loading")
    expect(capacity.activeKey).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PortalCapacityState } from "@obsidion/front-core"

const demo = vi.hoisted(() => ({ enabled: true }))
vi.mock("../../src/dev/demoFlag", () => ({ isDemoMode: () => demo.enabled }))
const { fixtureState } = await import("../../scripts/ui-capture/fixtures/control")

beforeEach(() => {
  sessionStorage.clear()
  history.replaceState(null, "", "/")
  demo.enabled = true
})

afterEach(() => {
  vi.restoreAllMocks()
})

it("requires both demo mode and explicit fixture selection, including a previously latched fixture", () => {
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/?flowFixture=success")
  demo.enabled = false
  expect(fixtureState()).toBeNull()
  demo.enabled = true
  expect(fixtureState()).toBe("success")
  history.replaceState(null, "", "/contacts/ada")
  expect(fixtureState()).toBe("success")
  demo.enabled = false
  expect(fixtureState()).toBeNull()
})

it("explicitly disables a latched fixture and rejects unknown controls", () => {
  history.replaceState(null, "", "/?flowFixture=pending")
  expect(fixtureState()).toBe("pending")
  history.replaceState(null, "", "/?flowFixture=off")
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/activity")
  expect(fixtureState()).toBeNull()
  history.replaceState(null, "", "/?flowFixture=unknown")
  expect(() => fixtureState()).toThrow("Unknown flow fixture")
})

it("clears: the bucket is empty until a capacity Check again, then full and newer under a frozen clock", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T12:00:00Z"))
  const { portalCapacityKey } = await import("@obsidion/front-core")
  const { depositCapacityStore } = await import("../../scripts/ui-capture/fixtures/capacity")
  history.replaceState(null, "", "/?demo=activity&flowFixture=success&capacityFixture=clears")
  const store = depositCapacityStore(
    portalCapacityKey({ chainId: 31337, portal: `0x${"ab".repeat(20)}`, token: `0x${"cd".repeat(20)}` }),
  )
  // A read clears a confirmed capacity blocker only when its fetchedAt is later than the blocker's.
  const read = async (next: Promise<PortalCapacityState>) => {
    const state = await next
    return state.status === "fresh" ? [state.snapshot.availableAtomic, state.fetchedAt] : [state.status]
  }
  const [empty, blockedAt] = await read(store.refresh())
  expect(empty).toBe(0n)

  const reason = document.createElement("div")
  reason.dataset.testid = "deposit-pending-reason"
  const help = document.createElement("span")
  const info = document.createElement("button")
  help.append(info)
  const checkAgain = document.createElement("button")
  reason.append(help, checkAgain)
  document.body.append(reason)

  info.click()
  expect(await read(store.retry())).toEqual([0n, blockedAt])
  checkAgain.click()
  const [full, clearedAt] = await read(store.retry())
  expect(full).toBe(48_250n * 10n ** 18n)
  expect(clearedAt).toBeGreaterThan(blockedAt as number)
})

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContactStorage, type IStorageAdapter, type PaylinkTransaction } from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession, session } from "../../src/platform/session"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { decodePaylinkInline } from "@obsidion/sdk"
import { provingProgress } from "@obsidion/proving-progress"
import { fixtureState, operation } from "../../scripts/ui-capture/fixtures/control"
import { capturePaylinkRows, claimSponsoredLink, createSponsoredLink } from "../../scripts/ui-capture/fixtures/paylinks"
import { runContactPay as runCaptureContactPay } from "../../scripts/ui-capture/fixtures/contact-pay"
import { demoClaimFragments, demoFundingTxHash } from "../../src/dev/demoFixtures"
import { EmailPaylinkUnsupportedError, type SponsoredPaylinkDeps } from "../../src/features/paylink/sponsoredPaylink"
import { getSipaDepositGateway } from "../../scripts/ui-capture/fixtures/deposits"
import { SIPA } from "../../scripts/ui-capture/fixtures/data"
import { DesktopSendUnresolvedError } from "../../src/platform/desktopBridge"

const demo = vi.hoisted(() => ({ enabled: true }))
vi.mock("../../src/dev/demoFlag", () => ({ isDemoMode: () => demo.enabled }))
vi.mock("../../src/config/env", async (importOriginal) => ({
  ...await importOriginal<object>(),
  getConfig: () => ({ network: "sandbox" }),
}))
// The capture gateway wraps the real one only for records; this file drives its fixture path alone.
vi.mock("../../src/features/deposit/sipaGateway", async (importOriginal) => ({
  ...await importOriginal<object>(),
  getSipaDepositGateway: () => ({}),
}))

const deps = {
  account: { getAddress: () => ({ toString: () => `0x${"22".repeat(32)}` }) },
} as unknown as SponsoredPaylinkDeps

function state(value: string) {
  vi.stubGlobal("location", new URL(`http://localhost/?demo=activity&flowFixture=${value}`))
}

const handled = <T,>(promise: Promise<T>) => promise.then(
  (value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }),
)

describe("capture service boundary contracts", () => {
  const events: { kind: string; operationId?: string; failed?: boolean }[] = []
  const start = (event: { operationId?: string }) => events.push({ kind: "start", ...event })
  const end = (event: { operationId?: string; failed?: boolean }) => events.push({ kind: "end", ...event })

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"))
    demo.enabled = true
    const tab = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => tab.get(key) ?? null,
      setItem: (key: string, value: string) => { tab.set(key, value) },
      removeItem: (key: string) => { tab.delete(key) },
    })
    // The faked flows run inside real operations, whose store persists here.
    const local = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value) },
      removeItem: (key: string) => { local.delete(key) },
    })
    state("success")
    events.length = 0
    const values = new Map<string, string>()
    const adapter: IStorageAdapter = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value) },
      removeItem: async (key) => { values.delete(key) },
      clear: async () => { values.clear() },
    }
    ContactStorage.resetForTests()
    ContactStorage.get(adapter)
    provingProgress.on("signing-start", start)
    provingProgress.on("signing-end", end)
    // No document here: the page is always visible.
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} })
    switchSession(activeNamespace())
  })

  afterEach(() => {
    closeSession()
    provingProgress.off("signing-start", start)
    provingProgress.off("signing-end", end)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("awaits preparation before public signing events and preserves the operation id", async () => {
    const stages: string[] = []
    let prepared = false
    let release!: () => void
    const preparation = new Promise<void>((resolve) => { release = resolve })
    const result = handled(operation("ordered-operation", (stage) => stages.push(stage), true, {
      operationId: "ordered-id",
      onPrepared: async () => { await preparation; prepared = true },
    }))
    await vi.advanceTimersByTimeAsync(900)
    expect(stages).toEqual(["proving"])
    expect(events).toEqual([])
    release()
    await vi.advanceTimersByTimeAsync(1400)
    expect(prepared).toBe(true)
    expect(events).toEqual([
      { kind: "start", operationId: "ordered-id" },
      { kind: "end", operationId: "ordered-id", failed: false },
    ])
    expect(stages).toEqual(["proving"])
    await vi.advanceTimersByTimeAsync(3300)
    expect((await result).error).toBeUndefined()
    expect(stages).toEqual(["proving", "submitting"])
  })

  it("stops at the cancellation callback before preparation or signing", async () => {
    const cancelled = new Error("test cancellation")
    const prepared = vi.fn()
    const result = handled(operation("cancelled-operation", () => { throw cancelled }, true, { onPrepared: prepared }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBe(cancelled)
    expect(prepared).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it("marks failed signing explicitly and gives a retry its own successful end event", async () => {
    state("signing-retry")
    const first = handled(operation("signing-retry-operation", undefined, true, { operationId: "first" }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await first).error).toBeInstanceOf(Error)
    const second = handled(operation("signing-retry-operation", undefined, true, { operationId: "second" }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await second).error).toBeUndefined()
    expect(events).toEqual([
      { kind: "start", operationId: "first" },
      { kind: "end", operationId: "first", failed: true },
      { kind: "start", operationId: "second" },
      { kind: "end", operationId: "second", failed: false },
    ])
  })

  it("can finish without a signing ceremony while still preparing the result", async () => {
    state("no-signing")
    const prepared = vi.fn()
    const result = handled(operation("no-signing-operation", undefined, true, { onPrepared: prepared }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBeUndefined()
    expect(prepared).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })

  it("a cancelled capture send creates no row or signing event", async () => {
    const cancelled = new Error("capture cancellation")
    const result = handled(runCaptureContactPay({
      mode: "send", deps, tag: "ada", senderTag: "bob", amountDisplay: "24",
    }, (stage) => { if (stage === "proving") throw cancelled }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBe(cancelled)
    expect((await session().activity.all())).toEqual([])
    expect(events).toEqual([])
  })

  it("a later capture send failure updates only its own operation id", async () => {
    await session().activity.insertPending({
      id: "unrelated-send", operationId: "unrelated-send", networkId: "0xnet", action: "send",
      token: { address: "unrelated", name: "DAI", symbol: "DAI", decimals: 18, amount: 7, price: 1, logo: "" },
      amountAtomic: 7n, timestamp: Date.now(), status: "pending", txHash: "", to: "other",
    })
    state("signing-failure")
    const result = handled(runCaptureContactPay({
      mode: "send", deps, tag: "ada", senderTag: "bob", amountDisplay: "24",
    }, () => {}))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBeInstanceOf(Error)
    const rows = (await session().activity.all())
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === "unrelated-send")?.status).toBe("pending")
    const failed = rows.find((row) => row.id.startsWith("capture-send-"))!
    expect(failed.status).toBe("failed")
    expect(failed.txHash).toBeFalsy()
    expect(events).toEqual([
      { kind: "start", operationId: failed.id },
      { kind: "end", operationId: failed.id, failed: true },
    ])
  })

  it("a desktop send saves its hold at the helper's approval, after the recheck, then ends unresolved", async () => {
    vi.stubGlobal("location", new URL("http://localhost/?demo=activity&flowFixture=success&desktopFixture=unresolved"))
    // No account rows here, and the session's clock would keep every timer running.
    closeSession()
    const calls: string[] = []
    const sent = handled(getSipaDepositGateway().deposit({
      target: { address: SIPA, name: "demo.sandbox.oxide" },
      amountDisplay: "24",
      onStage: (stage) => calls.push(stage),
      preflight: async () => { calls.push("preflight") },
      beforeApprove: async (submission) => {
        calls.push(`approve:${submission}`)
      },
    }))
    await vi.runAllTimersAsync()
    const { error } = await sent
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
    expect(calls).toEqual(["preflight", "awaiting-browser", "preflight", `approve:${"1".repeat(32)}`])
  })

  it("requires demo plus an explicit fixture, rejects unknown controls, and clears the latch", async () => {
    expect(fixtureState()).toBe("success")
    state("off")
    expect(fixtureState()).toBeNull()
    vi.stubGlobal("location", new URL("http://localhost/?demo=activity"))
    expect(fixtureState()).toBeNull()
    state("unknown")
    expect(() => fixtureState()).toThrow("Unknown flow fixture")
    demo.enabled = false
    expect(fixtureState()).toBeNull()
    await expect(capturePaylinkRows()).rejects.toThrow("requires an active flow fixture")
  })

  it("publishes a persisted hashless prepared link before signing, then advances the same row", async () => {
    const observations: { url: string; events: number }[] = []
    const result = handled(createSponsoredLink(deps, "24", undefined, {
      memo: "fixture memo",
      onLink: (link) => observations.push({ url: link.url, events: events.length }),
    }))
    await vi.advanceTimersByTimeAsync(900)
    expect(observations).toHaveLength(1)
    expect(observations[0].events).toBe(0)
    const [pending] = await capturePaylinkRows()
    expect(pending).toMatchObject({ kind: "paylink-create", status: "pending", amount: 24, paylink: observations[0].url })
    expect(pending.txHash).toBeFalsy()
    const prepared = decodePaylinkInline(observations[0].url.split("#")[1])
    expect(prepared.secret.toString()).toBe(pending.secret)
    expect(events[0]).toEqual({ kind: "start", operationId: pending.operationId })
    await vi.advanceTimersByTimeAsync(4700)
    const { value, error } = await result
    expect(error).toBeUndefined()
    expect(value?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    const [settled] = await capturePaylinkRows()
    expect(settled).toMatchObject({ operationId: pending.operationId, secret: pending.secret, status: "success", txHash: value?.txHash, paylink: value?.url })
    expect(decodePaylinkInline(value!.url.split("#")[1]).secret.toString()).toBe(pending.secret)
    expect(observations).toHaveLength(1)
  })

  it("keeps failed and retried creator identities distinct even with a fixed clock", async () => {
    state("signing-failure")
    const first = handled(createSponsoredLink(deps, "24"))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await first).error).toBeInstanceOf(Error)
    const [failed] = await capturePaylinkRows()
    expect(failed.status).toBe("failed")
    expect(failed.txHash).toBeFalsy()
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"))
    state("success")
    const second = handled(createSponsoredLink(deps, "24"))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await second).error).toBeUndefined()
    const rows = await capturePaylinkRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(2)
    expect(new Set(rows.map((row) => row.secret)).size).toBe(2)
    expect(rows.find((row) => row.operationId === failed.operationId)?.status).toBe("failed")
    expect(rows.filter((row) => row.status === "success")).toHaveLength(1)
  })

  it.each(["success", "no-signing"])("returns the claim row's hash, not the funding hash (%s)", async (fixture) => {
    state(fixture)
    const fragment = demoClaimFragments().direct
    const funding = demoFundingTxHash(fragment)
    const result = handled(claimSponsoredLink(deps, fragment))
    await vi.advanceTimersByTimeAsync(6000)
    const { value, error } = await result
    expect(error).toBeUndefined()
    const rows = (await session().activity.all()) as PaylinkTransaction[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "paylink-claim", emailPaymentAction: PaylinkActionEnum.CLAIM, status: "success", txHash: value, token: { amount: 100 } })
    expect(value).toMatch(/^0x[0-9a-f]{64}$/)
    expect(value).not.toBe(funding)
    expect(fixture === "no-signing" ? events.length : events.filter((event) => event.failed === false).length).toBe(fixture === "no-signing" ? 0 : 1)
  })

  it("refuses an email link before creating a claim row", async () => {
    await expect(claimSponsoredLink(deps, demoClaimFragments().email)).rejects.toThrow(EmailPaylinkUnsupportedError)
    expect(await capturePaylinkRows()).toEqual([])
    expect(events).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import type { PortalCapacitySnapshot, SipaPortalTerms } from "@obsidion/sdk"

import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"
import {
  SIPADepositStore,
  type SIPADepositFields,
  type SIPADepositRecord,
} from "../../src/core/services/deposits/SIPADepositStore"
import { sipaSweepAllowed } from "../../src/core/services/deposits/sipaProcessing"
import {
  createPortalCapacityRegistry,
  type PortalCapacityKey,
  type VisibilitySource,
} from "../../src/oxide/portalCapacityStore"
import { createSipaProcessingObserver } from "../../src/oxide/sipaProcessingObserver"
import type { SipaRecordRoute } from "../../src/oxide/sipaRoute"
import { SipaIntent } from "@oxide/l1-contracts"

const E18 = 10n ** 18n
const CHAIN = 11155111
const T0 = Date.UTC(2026, 8, 25, 12)
const DAI = `0x${"da".repeat(20)}` as Address
const ACTIVE_PORTAL = `0x${"a1".repeat(20)}` as Address
const OLD_PORTAL = `0x${"0d".repeat(20)}` as Address
const ACTIVE_TABLE = `0x${"a2".repeat(20)}` as Address
const OLD_TABLE = `0x${"0e".repeat(20)}` as Address
const SIPA = `0x${"5a".repeat(20)}` as Address

const TX_CAP = 10_000n * E18

const TERMS: Record<string, SipaPortalTerms> = {
  [ACTIVE_TABLE]: { portal: ACTIVE_PORTAL, token: DAI, depositFee: E18, txAmountCap: TX_CAP },
  [OLD_TABLE]: { portal: OLD_PORTAL, token: DAI, depositFee: E18, txAmountCap: TX_CAP },
}

/** A deposit's row in `forwardingTable`. */
const route = (forwardingTable: Address): SipaRecordRoute => ({
  forwardingTable,
  intent: SipaIntent.Deposit,
})

const visibility: VisibilitySource = { isVisible: () => true, onResume: () => () => {} }

function snapshot(portal: Address, availableAtomic: bigint): PortalCapacitySnapshot {
  return {
    chainId: CHAIN,
    portal,
    token: DAI,
    decimals: 18,
    blockNumber: BigInt(Date.now()),
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    rateAtomicPerSecond: E18,
    globalLimitAtomic: 50_000n * E18,
    txAmountCapAtomic: TX_CAP,
    availableAtomic,
  }
}

function fallback(
  over: Partial<SIPADepositRecord> = {},
): SIPADepositFields {
  return {
    networkId: "0xnet",
    recipientL2Address: "0x" + "11".repeat(32),
    messageSecret: "0x" + "22".repeat(32),
    recipientHash: "0x" + "33".repeat(32),
    recoveryAddress: "0x" + "44".repeat(20),
    origin: {
      sipaFactory: `0x${"fa".repeat(20)}` as Address,
      implementation: `0x${"0e".repeat(20)}` as Address,
      intentHash: `0x${"55".repeat(32)}` as Hex,
      rollupVersion: "1",
      resweepable: false,
      protocol: "account" as const,
      recoveryAccount: `0x${"44".repeat(20)}` as Address,
      recoveryCommitment: `0x${"66".repeat(31)}` as Hex,
      accountFactory: `0x${"ac".repeat(20)}` as Address,
      forwardingTable: OLD_TABLE,
    },
    l1ChainId: CHAIN,
    amount: "101",
    tokenSymbol: "DAI",
    tokenAddress: DAI,
    tokenDecimals: 18,
    startTime: T0 - 600_000,
    ...over,
  }
}

function setup() {
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  const deposits = SIPADepositStore.get(new InMemoryStorageAdapter())
  const capacity = new Map<string, bigint | Error>([
    [ACTIVE_PORTAL, 50_000n * E18],
    [OLD_PORTAL, 50n * E18],
  ])
  const read = vi.fn(async (key: PortalCapacityKey) => {
    const value = capacity.get(key.portal)
    if (value === undefined) throw new Error(`no portal ${key.portal}`)
    if (value instanceof Error) throw value
    return snapshot(key.portal, value)
  })
  const registry = createPortalCapacityRegistry({
    read,
    visibility,
    policy: { maxHeadAgeMs: Infinity },
  })
  const termsFailures = new Set<string>()
  const readTerms = vi.fn(async ({ forwardingTable }: SipaRecordRoute) => {
    if (termsFailures.has(forwardingTable)) throw new Error("rpc down")
    return TERMS[forwardingTable]!
  })
  const observer = createSipaProcessingObserver({
    deposits,
    capacity: (key) => registry.store(key),
    readTerms,
    l1ChainId: CHAIN,
  })
  const upsert = (
    over: Partial<SIPADepositRecord> = {},
    phase: SIPADepositRecord["phase"] = "sweeping",
  ) => deposits.upsert(SIPA, { phase, ...over }, fallback(over))
  return { deposits, observer, read, readTerms, capacity, termsFailures, upsert }
}

describe("createSipaProcessingObserver", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it("reads the deposit's own portal, not the selected deployment's", async () => {
    const { observer, read, upsert } = setup()
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    expect(read.mock.calls.map(([key]) => key.portal)).toEqual([OLD_PORTAL])
    // 101 gross less the 1 deposit fee needs 100; the old portal has 50.
    expect(observer.stateFor(SIPA)?.reason).toEqual({
      kind: "capacity",
      requiredAtomic: 100n * E18,
      availableAtomic: 50n * E18,
      refill: { status: "unknown" },
      decimals: 18,
      observedAt: T0,
    })
    stop()
  })

  it("exposes the original portal's capacity key, not the selected deployment's", async () => {
    const { observer, upsert } = setup()
    await upsert()
    expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "pending" })
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.capacityKeyFor(SIPA)).toEqual({
      status: "known",
      key: { chainId: CHAIN, portal: OLD_PORTAL, token: DAI },
    })
  })

  it("reports an unresolvable identity as unknown, and resolves it again on retry", async () => {
    const { observer, termsFailures, upsert } = setup()
    termsFailures.add(OLD_TABLE)
    await upsert()
    observer.capacityKeyFor(SIPA)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "unknown", retryable: true })

    termsFailures.clear()
    await observer.retry(SIPA)
    expect(observer.capacityKeyFor(SIPA)).toMatchObject({
      status: "known",
      key: { portal: OLD_PORTAL },
    })
  })

  it("repeats a failed lookup for a recorded deposit that is not waiting for a sweep, and notifies", async () => {
    for (const phase of ["recoverable", "pendingClaim"] as const) {
      const { observer, termsFailures, upsert, read } = setup()
      termsFailures.add(OLD_TABLE)
      await upsert({}, phase)
      const listener = vi.fn()
      const stop = observer.subscribe(listener)
      observer.capacityKeyFor(SIPA)
      await vi.advanceTimersByTimeAsync(0)
      expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "unknown", retryable: true })
      expect(observer.stateFor(SIPA)).toBeUndefined()

      termsFailures.clear()
      const notified = listener.mock.calls.length
      await expect(observer.retry(SIPA)).resolves.toBeUndefined()
      expect(observer.capacityKeyFor(SIPA)).toEqual({
        status: "known",
        key: { chainId: CHAIN, portal: OLD_PORTAL, token: DAI },
      })
      expect(listener.mock.calls.length).toBeGreaterThan(notified)
      // No reason to explain, so no capacity read either.
      expect(read).not.toHaveBeenCalled()
      stop()
    }
  })

  it("keeps an awaiting deposit's retry: a new lookup, then a new capacity read", async () => {
    const { observer, termsFailures, upsert, read } = setup()
    termsFailures.add(OLD_TABLE)
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
    termsFailures.clear()
    const state = await observer.retry(SIPA)
    expect(read.mock.calls.map(([key]) => key.portal)).toContain(OLD_PORTAL)
    expect(state?.reason.kind).toBe("capacity")
    stop()
  })

  it("has no key for a deposit on another chain, without an origin naming its table, or unknown", async () => {
    const { observer, readTerms, upsert } = setup()
    await upsert({ l1ChainId: 1 })
    expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "unknown", retryable: false })
    expect(observer.capacityKeyFor(`0x${"77".repeat(20)}`)).toEqual({
      status: "unknown",
      retryable: false,
    })
    await upsert({ l1ChainId: CHAIN, origin: undefined })
    expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "unknown", retryable: false })
    const { forwardingTable: _table, recoveryAccount: _account, ...origin } = fallback().origin as {
      forwardingTable: Address
      recoveryAccount: Address
    }
    await upsert({
      origin: { ...origin, protocol: "legacy-eoa", recoveryAddress: `0x${"44".repeat(20)}` },
    } as Partial<SIPADepositRecord>)
    expect(observer.capacityKeyFor(SIPA)).toEqual({ status: "unknown", retryable: false })
    expect(readTerms).not.toHaveBeenCalled()
  })

  it("checks while the portal is being looked up", async () => {
    const { observer, upsert } = setup()
    await upsert()
    expect(observer.stateFor(SIPA)).toEqual({ reason: { kind: "checking" } })
  })

  it("has no portal for a deposit on another chain or without its origin", async () => {
    const { observer, read, readTerms, upsert } = setup()
    await upsert({ l1ChainId: 1 })
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.stateFor(SIPA)?.reason).toEqual({
      kind: "unavailable",
      cause: "portal-unknown",
    })
    expect(readTerms).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    stop()
  })

  it("explains nothing for a deposit that is not waiting for a sweep", async () => {
    const { observer, upsert } = setup()
    await upsert({ sweepTxHash: `0x${"01".repeat(32)}` })
    expect(observer.stateFor(SIPA)).toBeUndefined()
    await upsert({ sweepTxHash: undefined }, "recoverable")
    expect(observer.stateFor(SIPA)).toBeUndefined()
  })

  it("reports a failed portal lookup as unavailable and retries it on request", async () => {
    const { observer, termsFailures, upsert } = setup()
    termsFailures.add(OLD_TABLE)
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.stateFor(SIPA)?.reason).toEqual({
      kind: "unavailable",
      cause: "portal-unknown",
    })

    termsFailures.clear()
    const state = await observer.retry(SIPA)
    expect(state?.reason.kind).toBe("capacity")
    stop()
  })

  it("keeps a confirmed blocker through a failed read and clears it on a later fit", async () => {
    const { observer, capacity, upsert } = setup()
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(sipaSweepAllowed(observer.stateFor(SIPA))).toBe(false)

    capacity.set(OLD_PORTAL, new Error("rpc down"))
    await vi.advanceTimersByTimeAsync(1_000)
    const failed = await observer.refreshForSweep(SIPA)
    expect(failed?.reason).toMatchObject({ kind: "unavailable", cause: "capacity-unread" })
    expect(failed?.blocker).toEqual({ kind: "capacity", observedAt: T0 })
    expect(sipaSweepAllowed(failed)).toBe(false)

    capacity.set(OLD_PORTAL, 100n * E18)
    await vi.advanceTimersByTimeAsync(1_000)
    const fits = await observer.refreshForSweep(SIPA)
    expect(fits?.reason).toMatchObject({ kind: "processing", availableAtomic: 100n * E18 })
    expect(fits?.blocker).toBeUndefined()
    expect(sipaSweepAllowed(fits)).toBe(true)
    stop()
  })

  it("starts a new read before a manual sweep", async () => {
    const { observer, read, upsert } = setup()
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const before = read.mock.calls.length
    await observer.refreshForSweep(SIPA)
    expect(read.mock.calls.length).toBe(before + 1)
    stop()
  })

  const described = () => {
    const { l1ChainId, origin, amount, tokenAddress, tokenDecimals } = fallback()
    return { l1ChainId, origin, amount, tokenAddress, tokenDecimals, phase: "funded" as const }
  }

  it("reads a deposit with no record against the origin its address commits to", async () => {
    const { deposits, observer, read, readTerms } = setup()
    expect(await observer.refreshForSweep(SIPA)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()

    const state = await observer.refreshForSweep(SIPA, described())
    expect(readTerms).toHaveBeenCalledWith(route(OLD_TABLE))
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ portal: OLD_PORTAL }))
    expect(state?.reason).toMatchObject({
      kind: "capacity",
      requiredAtomic: 100n * E18,
      availableAtomic: 50n * E18,
    })
    expect(sipaSweepAllowed(state)).toBe(false)
    expect(deposits.get(SIPA)).toBeNull()
  })

  it("reads a stored record's own origin over a description", async () => {
    const { observer, readTerms, upsert } = setup()
    await upsert()
    const { origin, ...rest } = described()
    await observer.refreshForSweep(SIPA, {
      ...rest,
      origin: { ...origin!, forwardingTable: ACTIVE_TABLE },
    })
    expect(readTerms).toHaveBeenCalledWith(route(OLD_TABLE))
    expect(readTerms).not.toHaveBeenCalledWith(route(ACTIVE_TABLE))
  })

  it("funds a stored placeholder from the live read, keeping its origin", async () => {
    const { observer, read, readTerms, upsert } = setup()
    await upsert({ amount: "0" }, "broadcast")
    const { origin, ...rest } = described()
    const state = await observer.refreshForSweep(SIPA, {
      ...rest,
      origin: { ...origin!, forwardingTable: ACTIVE_TABLE },
    })
    expect(readTerms).not.toHaveBeenCalledWith(route(ACTIVE_TABLE))
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ portal: OLD_PORTAL }))
    expect(state?.reason).toMatchObject({ kind: "capacity", requiredAtomic: 100n * E18 })
    expect(sipaSweepAllowed(state)).toBe(false)
  })

  it("keeps a placeholder's confirmed blocker through a failed read", async () => {
    const { observer, capacity, upsert } = setup()
    await upsert({ amount: "0" }, "broadcast")
    expect(sipaSweepAllowed(await observer.refreshForSweep(SIPA, described()))).toBe(false)
    capacity.set(OLD_PORTAL, new Error("rpc down"))
    await vi.advanceTimersByTimeAsync(1_000)
    const failed = await observer.refreshForSweep(SIPA, described())
    expect(failed?.reason).toMatchObject({ kind: "unavailable", cause: "capacity-unread" })
    expect(sipaSweepAllowed(failed)).toBe(false)
  })

  it("checks a topped-up record at the balance a sweep read, and keeps it for later reads", async () => {
    const { observer, capacity, upsert } = setup()
    await upsert({ amount: "40" })
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.stateFor(SIPA)?.reason.kind).toBe("processing")

    const held = await observer.refreshForSweep(SIPA, described())
    expect(held?.reason).toMatchObject({ kind: "capacity", requiredAtomic: 100n * E18 })
    expect(sipaSweepAllowed(held)).toBe(false)

    // Later fresh reads of the same bucket still measure the live balance, not the stored 40.
    await vi.advanceTimersByTimeAsync(120_000)
    await observer.retry(SIPA)
    expect(observer.stateFor(SIPA)?.reason).toMatchObject({ requiredAtomic: 100n * E18 })
    expect(sipaSweepAllowed(observer.stateFor(SIPA))).toBe(false)

    capacity.set(OLD_PORTAL, 150n * E18)
    await vi.advanceTimersByTimeAsync(1_000)
    await observer.retry(SIPA)
    expect(sipaSweepAllowed(observer.stateFor(SIPA))).toBe(true)
    stop()
  })

  it("keeps the largest live balance when a lagging smaller read arrives later", async () => {
    const { observer, capacity, upsert } = setup()
    capacity.set(OLD_PORTAL, 150n * E18)
    await upsert({ amount: "100" })
    const held = await observer.refreshForSweep(SIPA, { ...described(), amount: "200" })
    expect(held?.reason).toMatchObject({ kind: "capacity", requiredAtomic: 199n * E18 })

    await vi.advanceTimersByTimeAsync(1_000)
    const lagging = await observer.refreshForSweep(SIPA, { ...described(), amount: "100" })
    expect(sipaSweepAllowed(lagging)).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await observer.retry(SIPA)
    expect(observer.stateFor(SIPA)?.reason).toMatchObject({ requiredAtomic: 199n * E18 })
    expect(sipaSweepAllowed(observer.stateFor(SIPA))).toBe(false)
  })

  it("measures a later stored top-up above the live read", async () => {
    const { observer, upsert } = setup()
    await upsert({ amount: "40" })
    await observer.refreshForSweep(SIPA, described())
    await upsert({ amount: "201" })
    expect(observer.stateFor(SIPA)?.reason).toMatchObject({ requiredAtomic: 200n * E18 })
  })

  it("checks a resolved placeholder the live read found funded", async () => {
    const { observer, read, upsert } = setup()
    await upsert({ amount: "0" }, "resolved")
    const state = await observer.refreshForSweep(SIPA, described())
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ portal: OLD_PORTAL }))
    expect(state?.reason).toMatchObject({ kind: "capacity", requiredAtomic: 100n * E18 })
    expect(sipaSweepAllowed(state)).toBe(false)
  })

  it("leaves a record past its sweep as stored, whatever the live read says", async () => {
    const { observer, read, upsert } = setup()
    await upsert({ sweepTxHash: `0x${"5e".repeat(32)}` as Hex })
    expect(await observer.refreshForSweep(SIPA, described())).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it("tells subscribers when the reason changes, and only then", async () => {
    const { observer, capacity, upsert } = setup()
    await upsert()
    const listener = vi.fn()
    const stop = observer.subscribe(listener)
    await vi.advanceTimersByTimeAsync(0)
    const settled = listener.mock.calls.length
    expect(settled).toBeGreaterThan(0)

    await observer.retry(SIPA)
    expect(listener.mock.calls.length).toBe(settled)

    capacity.set(OLD_PORTAL, 100n * E18)
    await observer.retry(SIPA)
    expect(listener.mock.calls.length).toBe(settled + 1)
    expect(observer.stateFor(SIPA)?.reason.kind).toBe("processing")
    stop()
  })

  it("never writes the deposit record", async () => {
    const { deposits, observer, capacity, upsert } = setup()
    await upsert()
    const before = deposits.get(SIPA)
    const write = vi.spyOn(deposits, "upsert")
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    capacity.set(OLD_PORTAL, 100n * E18)
    await observer.retry(SIPA)
    await observer.refreshForSweep(SIPA)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(write).not.toHaveBeenCalled()
    expect(deposits.get(SIPA)).toEqual(before)
    stop()
  })

  it("stops reading capacity when the last subscriber leaves", async () => {
    const { observer, read, upsert } = setup()
    await upsert()
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    stop()
    const count = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read.mock.calls.length).toBe(count)
  })

  it("follows a deposit swept while it is watched", async () => {
    const { observer, upsert } = setup()
    await upsert()
    const listener = vi.fn()
    const stop = observer.subscribe(listener)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.stateFor(SIPA)).toBeDefined()
    await upsert({ inboxIndex: "4", sweepTxHash: `0x${"02".repeat(32)}` }, "pendingClaim")
    expect(observer.stateFor(SIPA)).toBeUndefined()
    stop()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { zeroAddress, type Address, type Hex } from "viem"
import {
  ESCALATION_MAX_AGE_MS,
  ESCALATION_MAX_RETRIES,
  NameClaimStore,
  PendingRegistrationStore,
  type OxideResumeDeps,
  type OxideSignDeps,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"

const { readNameClaimLog, fireEvent } = vi.hoisted(() => ({
  readNameClaimLog: vi.fn(),
  fireEvent: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readNameClaimLog,
}))
vi.mock("../../../src/lib/analytics", () => ({ fireOnboardingEvent: fireEvent }))
// The logout-gate reader is the only path here that touches config; boot-failure cases pass their own.
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
}))

import {
  abandonPendingRegistration,
  acknowledgeLostRegistration,
  archiveReplacedRegistration,
  applyIdentityOutcome,
  getPendingStore,
  registrationSwept,
  isLogoutBlockedByRegistration,
  isTagPresentationPending,
  logoutBlockedByRegistration,
  lostRegistrationNotice,
  onDetectionSettled,
  registrationScheduleForSipa,
  registrationTermsAreInUse,
  runDetectionTick,
  startDetectionLoop,
  type WebDetectionDeps,
} from "../../../src/features/onboarding/webRegistration"
import { saveRegistrationTerms } from "../../../src/features/onboarding/registrationTerms"
import type { WebWalletConfig } from "../../../src/config/env"
import { WebStorageAdapter } from "../../../src/platform/storage/WebStorageAdapter"
import {
  clearWalletIdentity,
  confirmWalletIdentity,
  loadWalletIdentity,
  saveWalletIdentity,
  type WalletIdentity,
} from "../../../src/features/identity/walletIdentity"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const OTHER = "0x00000000000000000000000000000000000000bb" as Address
const NAME_HASH = `0x${"77".repeat(32)}` as Hex
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const LOG_ENTRY = {
  nameHash: NAME_HASH,
  signature: `0x${"ce".repeat(65)}` as Hex,
  nonce: "7",
  deadline: "1700021600",
}

function resetStore(): PendingRegistrationStore {
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  NameClaimStore.resetForTests()
  for (const key of walletStorage.keys()) walletStorage.removeItem(key)
  NameClaimStore.get(new WebStorageAdapter())
  return getPendingStore()
}

const SIPA = "0x00000000000000000000000000000000000000c3" as Address
const FEE_TOKEN = "0x00000000000000000000000000000000000000d4" as Address

function record(
  over: Partial<PendingRegistrationRecord> = {},
): Omit<PendingRegistrationRecord, "account"> {
  return {
    tag: "alice",
    nameHash: NAME_HASH,
    l2Address: L2_ADDRESS,
    l1ChainId: 11155111,
    sipaAddress: SIPA,
    fee: "1",
    beneficiary: "0x00000000000000000000000000000000000000b5",
    depositToken: FEE_TOKEN,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  }
}

function detectionDeps(store: PendingRegistrationStore, l1Over: Record<string, unknown> = {}) {
  return {
    env: {
      registry: OTHER,
      factory: OTHER,
      entryPoint: OTHER,
      ensDomain: "oxidestaging.eth",
      resolver: OTHER,
      rollupVersion: 3n,
      l1ChainId: 11155111,
    },
    l1: {
      getCode: vi.fn(async () => "0x"),
      predictAccountAddress: vi.fn(async () => ACCOUNT),
      readUserAddress: vi.fn(async () => zeroAddress),
      readNameOf: vi.fn(async () => `0x${"00".repeat(32)}`),
      readAccountMetadataRegistry: vi.fn(async () => OTHER),
      readUserRecord: vi.fn(async () => ({
        l2Address: L2_ADDRESS,
        rollupVersion: 3n,
        publicKey: { x: 1n, y: 2n },
        resolverOperator: OTHER,
      })),
      ...l1Over,
    },
    deposits: {
      readFunding: vi.fn(async () => []),
      readBalance: vi.fn(async () => 0n),
      readSweeps: vi.fn(async () => []),
      floor: vi.fn(async () => 0n),
      scheduleFee: vi.fn(async () => 1n),
    },
    pendingStore: store,
    // A stub client: readNameClaimLog is mocked, so only its presence matters.
    publicClient: {},
    // No getSignDeps: boot detection is credential-free by construction.
  } as unknown as WebDetectionDeps
}

beforeEach(() => {
  resetStore()
  clearWalletIdentity()
  readNameClaimLog.mockReset()
  readNameClaimLog.mockResolvedValue(LOG_ENTRY)
  fireEvent.mockReset()
})

/** A spy on the detection settle signal, unsubscribed after each test. */
const settleCleanup: Array<() => void> = []
afterEach(() => {
  settleCleanup.splice(0).forEach((off) => off())
})
function settleSpy() {
  const spy = vi.fn()
  settleCleanup.push(onDetectionSettled(spy))
  return spy
}

describe("walletIdentity — phase helpers", () => {
  it("round-trips the pending marker and confirms it away", () => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "alice")
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1, pending: true })
    expect(loadWalletIdentity()?.pending).toBe(true)
    expect(sessionStorage.getItem("obsidion.name-grant")).toBe("grant-token")
    confirmWalletIdentity()
    const settled = loadWalletIdentity()
    expect(settled?.handle).toBe("alice")
    expect(settled?.pending).toBeUndefined()
    expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
  })
})

describe("logout gate", () => {
  const identity: WalletIdentity = {
    handle: "alice",
    address: L2_ADDRESS,
    claimedAt: 1,
    pending: true,
  }
  const CHAIN = 11155111

  async function seeded(over: Partial<PendingRegistrationRecord> = {}, account = ACCOUNT) {
    const store = getPendingStore()
    await store.upsert(account, {}, record(over))
    return store
  }

  it("releases once the claim is escalated, by retries or by age", async () => {
    const retried = await seeded({ retries: ESCALATION_MAX_RETRIES })
    expect(logoutBlockedByRegistration(retried.list(), identity, CHAIN)).toBe(false)

    const aged = resetStore()
    const startTime = 1_000
    await aged.upsert(ACCOUNT, {}, record({ startTime }))
    expect(logoutBlockedByRegistration(aged.list(), identity, CHAIN, startTime + 1)).toBe(true)
    expect(
      logoutBlockedByRegistration(
        aged.list(),
        identity,
        CHAIN,
        startTime + ESCALATION_MAX_AGE_MS + 1,
      ),
    ).toBe(false)
  })

  it("ignores another wallet's record and another chain's record", async () => {
    const other = await seeded({ l2Address: `0x${"ab".repeat(32)}` as Hex })
    expect(logoutBlockedByRegistration(other.list(), identity, CHAIN)).toBe(false)

    const chain = resetStore()
    await chain.upsert(ACCOUNT, {}, record({ l1ChainId: 1 }))
    expect(logoutBlockedByRegistration(chain.list(), identity, CHAIN)).toBe(false)
  })

  it("still blocks when a newer escalated record sits above one that is still retrying", async () => {
    const store = await seeded({ startTime: 1_000 })
    await store.upsert(OTHER, {}, record({ retries: ESCALATION_MAX_RETRIES, startTime: 2_000 }))
    expect(store.list()[0]?.retries).toBe(ESCALATION_MAX_RETRIES)
    expect(logoutBlockedByRegistration(store.list(), identity, CHAIN, 3_000)).toBe(true)
    await store.close(ACCOUNT, "confirmed")
    expect(logoutBlockedByRegistration(store.list(), identity, CHAIN, 3_000)).toBe(false)
  })

  it("never blocks without an identity, and a nameless wallet with no claim is free", async () => {
    const store = await seeded()
    expect(logoutBlockedByRegistration(store.list(), null, CHAIN)).toBe(false)
    expect(logoutBlockedByRegistration([], { address: L2_ADDRESS, claimedAt: 1 }, CHAIN)).toBe(
      false,
    )
  })

  it("reads the live store, identity and config", async () => {
    const now = Date.now()
    const store = await seeded({ startTime: now - 1_000 })
    await store.upsert(OTHER, {}, record({ l1ChainId: 1, startTime: now }))
    saveWalletIdentity(identity)
    expect(isLogoutBlockedByRegistration()).toBe(true)
    await store.close(ACCOUNT, "confirmed")
    expect(isLogoutBlockedByRegistration()).toBe(false)
  })
})

describe("boot reconcile — the record close and the identity write are not one write", () => {
  const pendingIdentity: WalletIdentity = {
    handle: "alice",
    address: L2_ADDRESS,
    claimedAt: 1,
    pending: true,
  }

  /** Seeds storage as if the tick crashed between closing the record and updating the identity. */
  async function crashedAfterClose(phase: PendingRegistrationRecord["phase"]) {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    await store.close(ACCOUNT, phase)
    saveWalletIdentity(pendingIdentity)
    return store
  }

  async function boot() {
    const { runBootDetection } = await import("../../../src/features/onboarding/webRegistration")
    return runBootDetection({} as never)
  }

  it("retracts a pending identity whose race was lost", async () => {
    const store = await crashedAfterClose("failed_taken")
    expect(await boot()).toBe("idle")
    expect(loadWalletIdentity()).toBeNull()
    expect(isTagPresentationPending(loadWalletIdentity())).toBe(false)
    // The steer survives: the closed record is what tells the user which name went.
    expect(lostRegistrationNotice()).toEqual({ kind: "taken", tag: "alice" })
    expect(store.current()).toBeNull()
  })

  it("retracts a pending identity whose claim was abandoned", async () => {
    await crashedAfterClose("failed_terminal")
    await boot()
    expect(loadWalletIdentity()).toBeNull()
  })

  it("settles a pending identity whose record confirmed in another tab", async () => {
    await crashedAfterClose("confirmed")
    await boot()
    expect(loadWalletIdentity()?.pending).toBeUndefined()
    expect(isTagPresentationPending(loadWalletIdentity())).toBe(false)
  })

  it("retracts on the durable recovery marker, which closes its record confirmed", async () => {
    // needs_recovery closes the record `confirmed` — only the marker distinguishes it from a win.
    resetStore()
    saveWalletIdentity(pendingIdentity)
    applyIdentityOutcome("needs_recovery")
    saveWalletIdentity(pendingIdentity)

    await boot()
    expect(loadWalletIdentity()).toBeNull()
  })

  it("leaves a pending identity gated when nothing resolves it", async () => {
    resetStore()
    saveWalletIdentity(pendingIdentity)
    expect(await boot()).toBe("idle")
    expect(isTagPresentationPending(loadWalletIdentity())).toBe(true)
  })

  it("leaves a live record to the tick rather than deciding it from an older close", async () => {
    const store = resetStore()
    await store.upsert(OTHER, {}, record({ startTime: Date.now() - 60_000 }))
    await store.close(OTHER, "failed_taken")
    await store.upsert(ACCOUNT, {}, record())
    saveWalletIdentity(pendingIdentity)

    // The deps build fails (no config), but the reconcile ran first and must not have retracted.
    await expect(boot()).rejects.toBeDefined()
    expect(loadWalletIdentity()?.pending).toBe(true)
  })
})

describe("runDetectionTick — identity consequences + settle", () => {
  it("a pinned confirmation preserves a newer account's identity and caches the selected account", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60000 }))
    await store.upsert(OTHER, {}, record({ tag: "bob", l2Address: `0x${"ef".repeat(32)}` }))
    const identity: WalletIdentity = {
      handle: "bob",
      address: `0x${"ef".repeat(32)}`,
      claimedAt: 1,
      pending: true,
    }
    await saveWalletIdentity(identity)
    const deps = detectionDeps(store, { readUserAddress: vi.fn(async () => ACCOUNT) })
    expect(
      await runDetectionTick(deps, { expectedRecord: { account: ACCOUNT, nameHash: NAME_HASH } }),
    ).toBe("confirmed")
    expect(loadWalletIdentity()).toEqual(identity)
    expect(store.get(OTHER)?.phase).toBe("awaiting_deposit")
    await vi.waitFor(() => expect(readNameClaimLog).toHaveBeenCalled())
    expect(readNameClaimLog.mock.calls[0][2]).toBe(ACCOUNT)
  })

  it("abandoning a selected registration leaves the newer registration and identity intact", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60000 }))
    await store.upsert(OTHER, {}, record({ tag: "bob", l2Address: `0x${"ef".repeat(32)}` }))
    const identity: WalletIdentity = {
      handle: "bob",
      address: `0x${"ef".repeat(32)}`,
      claimedAt: 1,
      pending: true,
    }
    await saveWalletIdentity(identity)
    expect(await abandonPendingRegistration(ACCOUNT)).toBe(true)
    expect(store.get(ACCOUNT)?.phase).toBe("failed_terminal")
    expect(store.get(OTHER)?.phase).toBe("awaiting_deposit")
    expect(loadWalletIdentity()).toEqual(identity)
  })

  it("marks settled even when the tick itself fails — a blip must not pin pending copy forever", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    const deps = detectionDeps(store, {
      readUserAddress: vi.fn(async () => {
        throw new Error("rpc down")
      }),
    })
    // The machine swallows transient failures into a backed-off "pending" — never a rejection.
    const settled = settleSpy()
    await expect(runDetectionTick(deps)).resolves.toBe("pending")
    expect(settled).toHaveBeenCalled()
    expect(store.get(ACCOUNT)?.nextAttemptAt).toBeDefined()
  })
})

describe("runBootDetection", () => {
  it("settles the presentation gate even when the deps build fails", async () => {
    // A cold-boot RPC blip must not pin the tag surfaces in claiming-in-progress for the session.
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    const settled = settleSpy()
    const { runBootDetection } = await import("../../../src/features/onboarding/webRegistration")
    await expect(
      runBootDetection({ l1RpcUrl: "http://127.0.0.1:1" } as never),
    ).rejects.toBeDefined()
    expect(settled).toHaveBeenCalled()
  })

  it("settles without building RPC deps when no record exists", async () => {
    resetStore()
    const settled = settleSpy()
    const { runBootDetection } = await import("../../../src/features/onboarding/webRegistration")
    expect(await runBootDetection({} as never)).toBe("idle")
    expect(settled).toHaveBeenCalled()
  })
})

describe("registrationSwept", () => {
  it("is true on either sweep stamp, false for a funded or untouched address", () => {
    const base = { ...record({ broadcast: false }), account: ACCOUNT } as PendingRegistrationRecord
    const funded: PendingRegistrationRecord = { ...base, fundedAt: Date.now() }
    expect(registrationSwept(base)).toBe(false)
    expect(registrationSwept(funded)).toBe(false)
    expect(registrationSwept({ ...base, sweptAt: Date.now() })).toBe(true)
    expect(registrationSwept({ ...base, sweepTxHash: `0x${"33".repeat(32)}` })).toBe(true)
  })
})

describe("registrationTermsAreInUse", () => {
  const terms = (tag: string) =>
    saveRegistrationTerms({ account: ACCOUNT, tag, deadline: 0, fee: "1", feeWaived: true })

  it("holds the terms of an open record, so a sign-out cannot drop the floor it prices", async () => {
    const store = getPendingStore()
    await store.upsert(ACCOUNT, {}, record())
    terms("alice")
    expect(registrationTermsAreInUse(ACCOUNT, "alice")).toBe(true)
  })

  it("releases them once the record they priced is closed", async () => {
    const store = getPendingStore()
    await store.upsert(ACCOUNT, {}, record({ phase: "failed_taken" }))
    terms("alice")
    expect(registrationTermsAreInUse(ACCOUNT, "alice")).toBe(false)
  })

  it("releases terms no open record claims", async () => {
    const store = getPendingStore()
    await store.upsert(ACCOUNT, {}, record())
    terms("othertag")
    expect(registrationTermsAreInUse(ACCOUNT, "othertag")).toBe(false)
  })
})

describe("registrationScheduleForSipa", () => {
  const priced = (fee: string, minDeposit: string) =>
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "alice",
      deadline: 1_700_000_000,
      fee,
      minDeposit,
      feeWaived: false,
    })

  it("says nothing about an address this wallet never registered", () => {
    expect(registrationScheduleForSipa(OTHER)).toBeUndefined()
  })

  it("prices one of ours off the schedule its claim was signed on", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record({ fee: "1" }))
    priced("1", "5")
    expect(registrationScheduleForSipa(SIPA)).toEqual({ min: 5n, fee: 1n })
  })

  it("holds a live one of ours whose terms are missing", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record({ fee: "1" }))
    // Ours, but nothing prices it: the floor is unknown, which is not "classify as a plain deposit".
    expect(registrationScheduleForSipa(SIPA)).toBeNull()
  })

  it("gives up on one whose terms name another fee than its address commits to", async () => {
    await getPendingStore().upsert(ACCOUNT, {}, record({ fee: "1" }))
    priced("2", "5")
    expect(registrationScheduleForSipa(SIPA)).toBe("unsweepable")
  })

  it("gives up on an archived registration the earned quote replaced", async () => {
    await archiveReplacedRegistration({ account: ACCOUNT, ...record({ fee: "1" }) })
    // The replacement overwrote the terms for this account:tag, so they never price it again.
    priced("2", "5")
    expect(registrationScheduleForSipa(SIPA)).toBe("unsweepable")
  })
})

describe("confirmed side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A record the tick will close confirmed, plus deps that read the name back as ours. */
  async function confirmingWorld(over: Partial<PendingRegistrationRecord> = {}) {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ fundedAt: Date.now() - 4_000, ...over }))
    return { store, deps: detectionDeps(store, { readUserAddress: vi.fn(async () => ACCOUNT) }) }
  }

  it("caches the NameClaimed log entry, keyed by L2 account", async () => {
    const { deps } = await confirmingWorld()
    expect(await runDetectionTick(deps)).toBe("confirmed")

    await vi.waitFor(async () =>
      expect(await NameClaimStore.get().get(L2_ADDRESS)).toEqual({
        address: L2_ADDRESS,
        handle: "alice",
        nameHash: LOG_ENTRY.nameHash,
        signature: LOG_ENTRY.signature,
        nonce: LOG_ENTRY.nonce,
        deadline: LOG_ENTRY.deadline,
      }),
    )
    expect(readNameClaimLog.mock.calls[0][2]).toBe(ACCOUNT)
  })

  it("still confirms when the cache write throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { deps } = await confirmingWorld()
    vi.spyOn(NameClaimStore.get(), "put").mockRejectedValue(new Error("quota exceeded"))
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1, pending: true })

    expect(await runDetectionTick(deps)).toBe("confirmed")
    expect(loadWalletIdentity()?.pending).toBeUndefined()
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
  })

  it("fires onboarding_tag_claimed with the durable custody→confirmed duration", async () => {
    const { deps } = await confirmingWorld({ fundedAt: Date.now() - 4_000 })
    await runDetectionTick(deps)

    expect(fireEvent).toHaveBeenCalledWith("onboarding_tag_claimed", {
      custody_to_confirmed_ms: expect.any(Number),
    })
    expect(fireEvent.mock.calls[0][1].custody_to_confirmed_ms).toBeGreaterThanOrEqual(4_000)
  })

  it("fires nothing when custody was never established", async () => {
    const { deps } = await confirmingWorld({ fundedAt: undefined })
    await runDetectionTick(deps)
    expect(fireEvent).not.toHaveBeenCalled()
  })
})

describe("lost-race notice", () => {
  const pending: WalletIdentity = {
    handle: "alice",
    address: L2_ADDRESS,
    claimedAt: 1,
    pending: true,
  }

  it("tells the user their name was taken, once", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    saveWalletIdentity(pending)

    await runDetectionTick(detectionDeps(store, { readUserAddress: vi.fn(async () => OTHER) }))
    // The identity is gone; the closed record is the only thing left that knows why.
    expect(loadWalletIdentity()).toBeNull()
    expect(lostRegistrationNotice()).toEqual({ kind: "taken", tag: "alice" })

    acknowledgeLostRegistration()
    expect(lostRegistrationNotice()).toBeNull()
  })

  it("says nothing about a confirmed registration", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    await store.close(ACCOUNT, "confirmed")
    expect(lostRegistrationNotice()).toBeNull()
  })

  it("carries needs_recovery, which closes its record confirmed and hides from the query", () => {
    resetStore()
    saveWalletIdentity(pending)
    applyIdentityOutcome("needs_recovery")
    expect(lostRegistrationNotice()).toEqual({ kind: "recovery", tag: "alice" })

    // Marked once: a second outcome must not overwrite the tag that actually lost the name.
    saveWalletIdentity({ ...pending, handle: "bob" })
    applyIdentityOutcome("needs_recovery")
    expect(lostRegistrationNotice()).toEqual({ kind: "recovery", tag: "alice" })

    acknowledgeLostRegistration()
    expect(lostRegistrationNotice()).toBeNull()
  })

  it("never fires for a settled identity — nothing was lost", () => {
    resetStore()
    saveWalletIdentity({ ...pending, pending: undefined })
    applyIdentityOutcome("needs_recovery")
    expect(loadWalletIdentity()).not.toBeNull()
    expect(lostRegistrationNotice()).toBeNull()
  })

  it("start-over closes an escalated record with no custody so the tag surfaces reopen", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ retries: 3 }))
    saveWalletIdentity(pending)

    expect(await abandonPendingRegistration()).toBe(true)
    expect(store.current()).toBeNull()
    expect(loadWalletIdentity()).toBeNull()
    // The user chose this exit, so it is not also reported back to them as a failure.
    expect(lostRegistrationNotice()).toBeNull()
    expect(isTagPresentationPending(loadWalletIdentity())).toBe(false)
  })

  it("refuses start-over while a deposit has landed, keeping the record and its identity", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ phase: "funded", fundedAt: Date.now(), retries: 3 }))
    saveWalletIdentity(pending)

    expect(await abandonPendingRegistration()).toBe(false)
    expect(store.current()?.phase).toBe("funded")
    expect(loadWalletIdentity()?.pending).toBe(true)
  })

  it("refuses start-over once the sweep is seen — the name may already be landing", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ sweptAt: Date.now() }))
    expect(await abandonPendingRegistration()).toBe(false)
    expect(store.current()).not.toBeNull()
  })

  it("acknowledges the event, not the account — a later failure surfaces its own notice", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    await store.close(ACCOUNT, "failed_taken")
    acknowledgeLostRegistration()
    expect(lostRegistrationNotice()).toBeNull()

    // Same deterministic account, a second claim, a second loss.
    await store.upsert(ACCOUNT, { phase: "awaiting_deposit", tag: "bob", endTime: undefined })
    await store.close(ACCOUNT, "failed_terminal")
    expect(lostRegistrationNotice()).toEqual({ kind: "failed", tag: "bob" })
  })

  it("a recovery dismissal never acknowledges an unrelated failed record", async () => {
    const store = resetStore()
    await store.upsert(OTHER, {}, record({ startTime: Date.now() - 60_000 }))
    await store.close(OTHER, "failed_taken")
    saveWalletIdentity(pending)
    applyIdentityOutcome("needs_recovery")

    expect(lostRegistrationNotice()).toEqual({ kind: "recovery", tag: "alice" })
    acknowledgeLostRegistration()
    // The taken record was never shown, so it is still owed.
    expect(lostRegistrationNotice()).toEqual({ kind: "taken", tag: "alice" })
  })
})

describe("startDetectionLoop", () => {
  // The band's wrong-chain predicate compares against the config, so it must match the fixture.
  const config = { l1ChainId: 11155111 } as WebWalletConfig

  let hidden = false

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)
    hidden = false
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, "visibilityState")
  })

  /** Flip the tab's visibility exactly as the browser does: state first, then the event. */
  const setHidden = (next: boolean) => {
    hidden = next
    document.dispatchEvent(new Event("visibilitychange"))
  }

  it("an in-session record re-arms the loop and a confirming tick closes it without a reload", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => {
      await store.close(ACCOUNT, "confirmed")
      return "confirmed" as const
    })
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(ACCOUNT, {}, record({ fundedAt: Date.now() }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it("a custody record stays on the fast cadence however old it is", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(
      ACCOUNT,
      {},
      record({ fundedAt: Date.now(), startTime: Date.now() - 10 * 60_000 }),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(10)
    stop()
  })

  it("a record with no custody polls on the slow cadence — only a user action moves it", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(ACCOUNT, {}, record({ startTime: Date.now() - 60_000 }))
    // The list-change tick fires once immediately (the machine's own nextAttemptAt gate absorbs
    // it in production); the slow band governs everything after.
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(44_000)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it("a custody-proven record for another chain is slow-banded — its tick stamps no backoff", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(
      ACCOUNT,
      {},
      record({ fundedAt: Date.now(), l1ChainId: 1, startTime: Date.now() - 60_000 }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(44_000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it("an escalated record falls back to the slow cadence", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(
      ACCOUNT,
      {},
      record({ fundedAt: Date.now(), retries: 3, startTime: Date.now() - 60_000 }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(44_000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it("the record's own backoff floors the fast band — a server Retry-After wins", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(
      ACCOUNT,
      {},
      record({
        fundedAt: Date.now(),
        startTime: Date.now() - 60_000,
        nextAttemptAt: Date.now() + 30_000,
      }),
    )
    // The immediate change tick still fires (the machine gates on nextAttemptAt itself); the
    // SCHEDULED cadence is what the floor stretches from 5s to 30s.
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it("leaves a record younger than the grace window alone on an immediate tick", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(ACCOUNT, {}, record({ fundedAt: Date.now() }))
    document.dispatchEvent(new Event("visibilitychange"))
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).not.toHaveBeenCalled()
    stop()
  })

  it("a tick that lands after the tab hides must not re-arm behind the handler", async () => {
    const store = resetStore()
    let release: () => void = () => {}
    const tick = vi.fn(
      () => new Promise<"pending">((resolve) => (release = () => resolve("pending"))),
    )
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(
      ACCOUNT,
      {},
      record({ fundedAt: Date.now(), startTime: Date.now() - 60_000 }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)

    // The tab goes away mid-tick: the handler disarms, and the tick's own trailing schedule()
    // is the one that would otherwise put the timer straight back.
    setHidden(true)
    release()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(tick).toHaveBeenCalledTimes(1)

    // Returning is what restores the loop — a tick now, and the cadence behind it.
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(2)
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
  })

  it("stop() disarms the loop for good", async () => {
    const store = resetStore()
    const tick = vi.fn(async () => "pending" as const)
    const stop = startDetectionLoop(config, { buildDeps: async () => detectionDeps(store), tick })
    await store.upsert(ACCOUNT, {}, record({ fundedAt: Date.now() }))
    stop()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(tick).not.toHaveBeenCalled()
  })

  it("reuses the deps build across ticks and rebuilds after a failed one", async () => {
    const store = resetStore()
    const buildDeps = vi.fn(async () => detectionDeps(store))
    const tick = vi
      .fn<(deps: OxideResumeDeps) => Promise<"pending">>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("pending")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const stop = startDetectionLoop(config, { buildDeps, tick })
    await store.upsert(ACCOUNT, {}, record({ fundedAt: Date.now() }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(buildDeps).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe("the chooser exit and a pending registration", () => {
  it("the sign-out behind Show passkeys leaves the record under its storage id, where a recovery of the account finds it", async () => {
    const { getActiveCredentialId, getActiveStorageId, setActiveCredentialId, setActiveStorageId } =
      await import("../../../src/platform/storage/activeStorage")
    const { signOut } = await import("../../../src/features/identity/signOut")
    const reopen = async () => {
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      return getPendingStore()
    }
    const store = resetStore()
    setActiveStorageId("aaa")
    setActiveCredentialId("cred")
    await walletStorage.flush()
    await store.upsert(ACCOUNT, {}, record())

    await signOut()
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    // The document that boots after the navigation has no active id, so nothing pending shows.
    expect((await reopen()).list()).toEqual([])

    // A recovery of the same account moves the pointer back; the record is still on disk under it.
    // The watcher's reattachment on that move is the reload after login, not this store's.
    setActiveStorageId("aaa")
    await walletStorage.flush()
    expect((await reopen()).get(ACCOUNT)?.tag).toBe("alice")
  })
})

describe("forced resume tick — the spent-rail renewal (the pending step's retry path)", () => {
  const MASTER_SECRET = `0x${"11".repeat(32)}`
  const PIN = { account: ACCOUNT, nameHash: NAME_HASH }

  /** The OxideSignDeps: re-request the claim, re-derive to the SAME SIPA. */
  function makeSignDeps() {
    const signDomain = vi.fn(async () => ({
      signature: `0x${"cd".repeat(65)}` as Hex,
      nonce: "1",
      deadline: "9999999999",
    }))
    return {
      signDomain,
      sign: {
        masterSecret: MASTER_SECRET,
        accountService: { signDomain },
        r1Key: { qx: `0x${"a1".repeat(32)}` as Hex, qy: `0x${"a2".repeat(32)}` as Hex },
        credentialId: "Y3JlZC1pZC0wMDE",
        l1: {
          getUserOpHash: vi.fn(async () => `0x${"77".repeat(32)}` as Hex),
          readR1InstallGas: vi.fn(async () => ({
            verification: 50_000n,
            callBase: 85_000n,
            callPerWord: 30_000n,
          })),
          readAccountMetadataRegistry: vi.fn(async () => OTHER),
        },
        deriveRegistrationSipa: vi.fn(async () => ({
          sipaAddress: SIPA,
          sipaArgs: {},
          registrationData: `0x${"ab".repeat(32)}`,
          recordData: `0x${"ba".repeat(32)}`,
          registration: `0x${"cd".repeat(32)}`,
          stealthScalar: 1n,
        })),
      },
    }
  }

  function signingDeps(
    store: PendingRegistrationStore,
    sign: ReturnType<typeof makeSignDeps>["sign"],
  ) {
    const getSignDeps = vi.fn(async () => sign as unknown as OxideSignDeps)
    return { deps: { ...detectionDeps(store), getSignDeps } as WebDetectionDeps, getSignDeps }
  }

  const SPENT = { sipaAddress: OTHER, refunded: true, broadcastSpent: true }

  it("renews a spent-rail record's claim only on a forced tick, publishing nothing", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ broadcast: false, replaced: SPENT }))
    const sign = makeSignDeps()
    const { deps } = signingDeps(store, sign.sign)

    expect(await runDetectionTick(deps)).toBe("pending")
    expect(sign.signDomain).not.toHaveBeenCalled()

    expect(await runDetectionTick(deps, { force: true, expectedRecord: PIN })).toBe("pending")
    expect(sign.signDomain).toHaveBeenCalledTimes(1)
    expect(store.get(ACCOUNT)).toMatchObject({ broadcast: false, retries: 1 })
  })

  it("a credential that expires between deps build and the tick blocks the renewal — zero budget", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record({ broadcast: false, replaced: SPENT }))
    // getSignDeps gates on a credential checked AT INVOCATION, proving it is only invoked lazily
    // once a forced tick reaches the renewal.
    const credential = { valid: true }
    const sign = makeSignDeps()
    const deps: WebDetectionDeps = {
      ...detectionDeps(store),
      getSignDeps: async () => (credential.valid ? (sign.sign as unknown as OxideSignDeps) : null),
    }
    credential.valid = false

    expect(await runDetectionTick(deps, { force: true, expectedRecord: PIN })).toBe("pending")
    expect(store.get(ACCOUNT)?.retries).toBe(0)
    expect(store.get(ACCOUNT)?.broadcast).toBe(false)
    expect(sign.signDomain).not.toHaveBeenCalled()
  })

  it("a stale expectedRecord pin makes the queued tick a no-op for the new record", async () => {
    const store = resetStore()
    await store.upsert(ACCOUNT, {}, record())
    const readUserAddress = vi.fn(async () => zeroAddress)
    const deps = detectionDeps(store, { readUserAddress })

    expect(
      await runDetectionTick(deps, {
        force: true,
        expectedRecord: { account: OTHER, nameHash: NAME_HASH },
      }),
    ).toBe("pending")
    expect(readUserAddress).not.toHaveBeenCalled()
    expect(store.get(ACCOUNT)?.nextAttemptAt).toBeUndefined()
  })
})

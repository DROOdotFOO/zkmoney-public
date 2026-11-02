/**
 * A registration's broadcast through the wallet's ledger: the real scheduler, ledger, operation
 * store, proving gate and pending store, with fakes only at the edges a test cannot run (the
 * prover, the chain, the unlock check and the re-sign).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OperationStore, type RegistrationBroadcastPayload } from "@obsidion/front-core"
import {
  ACCOUNT,
  L2_ADDRESS,
  SIPA,
  pendingRecord,
  resetRegistrationStores,
} from "../../../support/registrationFixtures"

const h = vi.hoisted(() => ({
  keys: undefined as unknown,
  sent: [] as unknown[],
  chain: new Map<string, "included" | "pending" | "dropped">(),
  landed: new Set<string>(),
  broadcastFails: undefined as Error | undefined,
  rebuild: vi.fn(),
}))

vi.mock("../../../../src/features/onboarding/registrationResume", () => ({
  unlockedSessionKeys: async () => h.keys,
  // An event mined before a republish's boundary is the dropped broadcast, not the new one.
  registrationBroadcastSeen: async (
    record: { sipaAddress: string },
    _config: unknown,
    _wallet: unknown,
    sinceBlock?: number,
  ) => sinceBlock === undefined && h.landed.has(record.sipaAddress.toLowerCase()),
}))
vi.mock("../../../../src/features/onboarding/webRegistrationBroadcast", () => ({
  createWebRegistrationBroadcaster: () => async (payload: RegistrationBroadcastPayload) => {
    h.sent.push(payload)
    if (h.broadcastFails) throw h.broadcastFails
    const txHash = `0x${h.sent.length.toString(16).padStart(64, "0")}`
    h.chain.set(txHash, "included")
    return txHash
  },
}))
vi.mock("../../../../src/features/broadcasts/broadcastState", () => ({
  broadcastState: async (_wallet: unknown, txHash: string) => h.chain.get(txHash) ?? "pending",
}))
vi.mock("../../../../src/features/onboarding/oxideOnboarding", () => ({
  buildRetrySignDeps: async () => ({ accountService: { signDomain: async () => ({}) } }),
}))
vi.mock("../../../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/onboarding/webRegistration")>()),
  buildWebDetectionDeps: async () => ({}),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  rebuildRegistrationBroadcast: h.rebuild,
}))

const {
  broadcastSettled,
  getBroadcastLedger,
  oweRegistrationBroadcast,
  resetBroadcastsForTests,
  startBroadcasts,
} = await import("../../../../src/features/broadcasts/broadcasts")
const { registrationExecutor } = await import("../../../../src/features/broadcasts/registrationExecutor")
const { getPendingStore } = await import("../../../../src/features/onboarding/webRegistration")
const { runUserFlow, trackBackgroundProve } = await import("../../../../src/features/provingGate")

const payload = (deadlineSec = Math.floor(Date.now() / 1000) + 3600, termsDeadlineSec = 0) =>
  ({
    sipaAddress: SIPA,
    domainAuth: { deadline: BigInt(deadlineSec) },
    signedTerms: { deadline: BigInt(termsDeadlineSec) },
  } as never as RegistrationBroadcastPayload)
const unlocked = () => ({
  account: { getAddress: () => ({ toString: () => L2_ADDRESS }) },
})

let stop: (() => void) | undefined
const start = () =>
  (stop = startBroadcasts({} as never, {
    registration: registrationExecutor({} as never, {} as never),
  }))
const job = () => getBroadcastLedger().get(SIPA)

beforeEach(async () => {
  localStorage.clear()
  resetRegistrationStores()
  resetBroadcastsForTests()
  OperationStore.reset()
  h.keys = unlocked()
  h.sent = []
  h.chain.clear()
  h.landed.clear()
  h.broadcastFails = undefined
  h.rebuild.mockReset()
  await getPendingStore().upsert(ACCOUNT, {}, pendingRecord({ broadcast: false }))
})

afterEach(() => {
  stop?.()
  stop = undefined
})

describe("a registration's broadcast on the ledger", () => {
  it("sends the session's own payload, stamps the record, and settles once mined", async () => {
    const signed = payload()
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: signed })
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toEqual([signed])
    expect(h.rebuild).not.toHaveBeenCalled()
    expect(getPendingStore().get(ACCOUNT)).toMatchObject({ broadcast: true })
    // The wallet's own bookkeeping: no notification shows it.
    expect(OperationStore.get().get(job()!.operationId!)).toMatchObject({
      state: "settled",
      background: true,
    })
  })

  it("rebuilds the payload after a reload lost it, and when the cached claim has lapsed", async () => {
    const rebuilt = payload()
    h.rebuild.mockResolvedValue({ kind: "payload", payload: rebuilt })
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, {
      payload: payload(Math.floor(Date.now() / 1000) - 1),
    })
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toEqual([rebuilt])
  })

  it("rebuilds a payload whose signed terms lapsed before its claim", async () => {
    const rebuilt = payload()
    h.rebuild.mockResolvedValue({ kind: "payload", payload: rebuilt })
    const now = Math.floor(Date.now() / 1000)
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, {
      payload: payload(now + 3600, now - 1),
    })
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toEqual([rebuilt])
  })

  it("waits for an unlock without counting a failure", async () => {
    h.keys = undefined
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: payload() })
    start()
    await vi.waitFor(() => expect(job()?.lastError).toBe("Waiting for unlock"))
    expect(job()).toMatchObject({ state: "queued", failures: 0 })
    expect(h.sent).toEqual([])
  })

  it("drops the job of an address the registration moved off", async () => {
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: payload() })
    await getPendingStore().upsert(ACCOUNT, {
      sipaAddress: "0x00000000000000000000000000000000000000d9",
    })
    start()
    await vi.waitFor(() => expect(job()).toBeNull())
    expect(h.sent).toEqual([])
  })

  it("sends a republished broadcast again although its first event mined", async () => {
    h.landed.add(SIPA.toLowerCase())
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!)
    start()
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toEqual([])
    stop?.()
    const rebuilt = payload()
    h.rebuild.mockResolvedValue({ kind: "payload", payload: rebuilt })
    expect(await getBroadcastLedger().republish(SIPA, 100)).toBe(true)
    start()
    await vi.waitFor(() => expect(h.sent).toEqual([rebuilt]))
  })

  it("holds while the user's own transaction runs, and goes once it ends", async () => {
    let finish!: () => void
    const flow = runUserFlow(() => new Promise<void>((resolve) => (finish = resolve)))
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: payload() })
    start()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.sent).toEqual([])
    finish()
    await flow
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toHaveLength(1)
  })

  // A user flow raised meanwhile waits on an attempt that is proving, so none may wait its turn.
  it("holds while a background proof runs, never proving behind it, and goes once it ends", async () => {
    let finish!: () => void
    const step = trackBackgroundProve(() => new Promise<void>((resolve) => (finish = resolve)))
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: payload() })
    start()
    await new Promise((r) => setTimeout(r, 20))
    expect(job()?.state).toBe("queued")
    expect(h.sent).toEqual([])
    finish()
    await step
    await vi.waitFor(() => expect(job()?.state).toBe("landed"))
    expect(h.sent).toHaveLength(1)
  })

  it("reports a failed first attempt to the screen, and keeps the job owed", async () => {
    h.broadcastFails = new Error("proving died")
    await oweRegistrationBroadcast(getPendingStore().get(ACCOUNT)!, { payload: payload() })
    const settled = broadcastSettled(SIPA)
    start()
    expect(await settled).toBe(false)
    expect(job()).toMatchObject({ state: "queued", failures: 1, lastError: "proving died" })
    expect(getPendingStore().get(ACCOUNT)?.broadcast).toBe(false)
  })
})

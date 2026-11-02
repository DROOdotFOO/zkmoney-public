/**
 * The withdrawal record a registration-funding claim keeps for its SIPA burn: seeded before the
 * batch signs, mined after it, failed or dropped when the batch does not go out, and woken on the
 * session's tracker. An ordinary claim keeps none.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import { TimeoutError } from "../../../../src/lib/withTimeout"
import { saveRegistrationTerms } from "../../../../src/features/onboarding/registrationTerms"
import {
  sendLikeTheWallet,
  watchWalletDb,
  type WalletSendOptions,
} from "../../../support/submitBoundary"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** Below the field modulus, as a real L2 tx hash is. */
const HASH = `0x${"11".repeat(32)}`
const h = vi.hoisted(() => ({
  claimSdk: vi.fn(async (..._args: unknown[]) => "0x" + "11".repeat(32)),
  getTxReceipt: vi.fn(async () => ({ status: "success", blockNumber: 42 })),
  wake: vi.fn(),
  portal: { address: `0x${"11".repeat(20)}` },
  // The registration's own broadcast, as the ledger would build it.
  payload: vi.fn(async (..._args: unknown[]) => ({
    payload: { sipaAddress: "payload" },
    account: { getAddress: () => "0xme" },
  })),
  cacheClaim: vi.fn(async (..._args: unknown[]) => {}),
  broadcastCalls: vi.fn(async (..._args: unknown[]) => [{ __fake: "notify" }, { __fake: "sweep" }]),
  sendAlone: vi.fn(async (..._args: unknown[]) => "0xbroadcast"),
  // The claim's two reads of the escrow: its voucher and its note.
  voucherUses: vi.fn(async (..._args: unknown[]) => 1),
  note: vi.fn(async (..._args: unknown[]) => ({ amount: 3n * 10n ** 18n })),
}))
// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../../src/features/broadcasts/registrationExecutor", () => ({
  registrationBroadcastPayload: h.payload,
}))
vi.mock("../../../../src/features/onboarding/webRegistrationBroadcast", () => ({
  cacheFreshClaim: h.cacheClaim,
  registrationBroadcastCalls: h.broadcastCalls,
  createWebRegistrationBroadcaster: () => h.sendAlone,
}))
vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {
    claimSponsoredPaylink = h.claimSdk
  },
  decodePaylinkInline: () => ({
    paylinkType: "paylink_direct",
    secret: { toString: () => "secret", toBuffer: () => new Uint8Array(32) },
  }),
  paylinkVoucherUses: h.voucherUses,
}))
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../../../../src/config/oxideTuple", async (original) => ({
  ...(await original<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: h.portal.address }),
  l1PublicClient: () => ({}),
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  readPaylinkNote: h.note,
}))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorRail: async () => ({ sponsor: { railId: 2, fpcAddress: {}, fpcArtifact: {} } }),
  claimSponsorContext: async () => ({ railId: 1, fpcAddress: {}, fpcArtifact: {} }),
  noteSubscribed: () => {},
}))
vi.mock("../../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: () => {} }))
vi.mock("../../../../src/lib/analytics", async (original) => ({
  ...(await original<typeof import("../../../../src/lib/analytics")>()),
  paylinkPh: async () => "fixture",
  firePaylinkEvent: () => {},
}))
// The store is real; the deployment wiring needs a manifest this suite has not.
vi.mock("../../../../src/features/withdraw/withdrawGateway", async (original) => ({
  ...(await original<typeof import("../../../../src/features/withdraw/withdrawGateway")>()),
  currentDeployment: async () => undefined,
  wakeWithdrawalTracker: h.wake,
}))
/** Read once at module load, so it is set before anything imports the analytics module. */
const API = "http://api.test"
vi.stubEnv("VITE_ZKMONEY_API_URL", API)

const { claimSponsoredLink, RegistrationFundingError } = await import(
  "../../../../src/features/paylink/sponsoredPaylink"
)
const { getBroadcastLedger, freshPayloads, resetBroadcastsForTests, startBroadcasts } =
  await import("../../../../src/features/broadcasts/broadcasts")
const { ClaimBatchFullError } = await import("@obsidion/sdk")
const { getOperationStore, getOperationsInProgress } = await import(
  "../../../../src/features/operations/operations"
)
const { trackBackgroundProve } = await import("../../../../src/features/provingGate")
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

const account = `0x${"aa".repeat(20)}`
const l2Address = `0x${"bb".repeat(32)}` as const
const sipaAddress = `0x${"cc".repeat(20)}` as const
const deps = {
  account: { getAddress: () => ({ toString: () => l2Address }) },
  wallet: { networkId: "0xnet", node: { getTxReceipt: h.getTxReceipt } },
  contractService: {},
  tokenService: {
    fetchTokenInformation: async () => ({
      symbol: "DAI",
      name: "DAI",
      decimals: 18,
      address: `0x${"aa".repeat(32)}`,
    }),
  },
} as never
const pending = PendingRegistrationStore.get(webStorage)
/** Fee 0.5, no minimum: SIPA target 0.51, burn 0.61, plus the committed tip. */
const BURN = dai(0.61)
const TIP = dai(1)

const terms = (overrides: Partial<Parameters<typeof saveRegistrationTerms>[0]> = {}) =>
  saveRegistrationTerms({
    account,
    tag: "alice",
    deadline: 4102444800,
    fee: String(dai(0.5)),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: "id:link",
    ...overrides,
  })
const fund = () =>
  claimSponsoredLink(deps, "fixture", undefined, undefined, { fundRegistration: true })
/** A funding claim that publishes an unpublished address in a transaction of its own first. */
const fundSeparately = () =>
  claimSponsoredLink(deps, "fixture", undefined, undefined, {
    fundRegistration: true,
    batchRegistrationBroadcast: false,
  })
const withdrawals = async () =>
  [...(await session().withdrawals.all())].sort((a, b) => b.startTime - a.startTime)
const sdkOptions = (call = 0) =>
  h.claimSdk.mock.calls[call]?.[2] as {
    operationId: string
    voucher?: { railId: number; withdraw?: Record<string, unknown> }
    broadcasts?: unknown[]
  }

beforeEach(async () => {
  localStorage.clear()
  await pending.load()
  vi.clearAllMocks()
  h.claimSdk.mockResolvedValue(HASH)
  h.getTxReceipt.mockResolvedValue({ status: "success", blockNumber: 42 })
  await pending.upsert(
    account,
    { broadcast: true },
    {
      tag: "alice",
      nameHash: `0x${"dd".repeat(32)}`,
      l2Address,
      l1ChainId: 31337,
      sipaAddress,
      depositToken: `0x${"ee".repeat(20)}`,
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
    },
  )
  terms()
})

describe("a registration-funding claim's burn record", () => {
  it("is seeded before the batch signs and marked mined after it, waking the tracker", async () => {
    await terms({ proverTip: TIP.toString() })
    let seeded: Awaited<ReturnType<typeof withdrawals>> = []
    h.claimSdk.mockImplementation(async () => {
      seeded = await withdrawals()
      return HASH
    })
    expect(await fund()).toBe(HASH)
    expect(seeded).toHaveLength(1)
    expect(seeded[0]).toMatchObject({
      phase: "submitting",
      operationId: sdkOptions().operationId,
      recipient: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      source: "paylink",
      intent: "registration",
      amount: "1.61",
      rawAmount: (BURN + TIP).toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      proverTip: TIP.toString(),
      tokenSymbol: "DAI",
    })
    expect(seeded[0]?.l2TxHash).toBeUndefined()
    // The batch takes the burn alone, priced exactly as the record was written, and settles it on
    // the live portal; the sdk adds its release broadcast.
    const withdraw = sdkOptions().voucher?.withdraw
    expect(Object.keys(withdraw ?? {}).sort()).toEqual([
      "amount",
      "l1Recipient",
      "proverTip",
      "withdrawal",
    ])
    expect(withdraw?.amount).toBe(BURN + TIP)
    expect(withdraw?.proverTip).toBe(TIP)
    expect(withdraw?.withdrawal).toEqual({
      tuple: { portal: h.portal.address },
      l1: expect.anything(),
    })
    expect(String(withdraw?.l1Recipient).toLowerCase()).toBe(sipaAddress)

    const [mined] = await withdrawals()
    expect(mined).toMatchObject({ phase: "l2_mined", l2TxHash: HASH, blockNumber: 42 })
    expect(h.wake).toHaveBeenCalled()
    expect(await withdrawals()).toHaveLength(1)
  })

  it("burns no prover tip when the review committed none, and learns the device's burn time", async () => {
    h.claimSdk.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return HASH
    })
    expect(await fund()).toBe(HASH)
    await new Promise((r) => setTimeout(r))
    const [record] = await withdrawals()
    expect(record?.rawAmount).toBe(BURN.toString())
    expect(record?.proverTip).toBeUndefined()
    expect(sdkOptions().voucher?.withdraw?.proverTip).toBe(0n)
    const durations = JSON.parse((await webStorage.getItem("burnDurations")) ?? "[]") as number[]
    expect(durations).toHaveLength(1)
  })

  it("tells the activation surfaces the funding is on its way, with the link's stash gone", async () => {
    const { ticketActivation } = await import("../../../../src/features/paylink/ticketContinuation")
    const { loadRegistrationTerms } = await import(
      "../../../../src/features/onboarding/registrationTerms"
    )
    expect(await fund()).toBe(HASH)
    // Home clears the stash as the claim settles; the record, not the stash, says the burn is out.
    sessionStorage.clear()
    const record = pending.current(l2Address)!
    const terms = loadRegistrationTerms(account, "alice")
    expect(ticketActivation(record, terms, await withdrawals())).toEqual({ state: "submitted" })
    expect(ticketActivation(record, terms, [])).toEqual({ state: "missing_link" })
  })

  it("is nothing for an ordinary claim", async () => {
    expect(await claimSponsoredLink(deps, "fixture")).toBe(HASH)
    expect(await withdrawals()).toHaveLength(0)
    expect(sdkOptions().voucher?.withdraw).toBeUndefined()
    expect(h.wake).not.toHaveBeenCalled()
  })

  it("is refused, with nothing seeded, while the terms lapsed", async () => {
    terms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    await expect(fund()).rejects.toMatchObject({ reason: "expired" })
    expect(await withdrawals()).toHaveLength(0)
    expect(h.claimSdk).not.toHaveBeenCalled()
  })

  describe("for an address not yet published", () => {
    beforeEach(async () => {
      resetBroadcastsForTests()
      await pending.upsert(account, { broadcast: false })
    })
    const owe = (over: Record<string, unknown> = {}) =>
      getBroadcastLedger().enqueue({
        address: sipaAddress,
        kind: "registration",
        scope: null,
        source: { type: "registration", account },
        ...over,
      })

    type Attempt = { onTxHash: (txHash: string) => Promise<void> }
    /** The separate broadcast reaches the node under `hash`; `then` decides how its wait ends. */
    const sendsAlone = (hash: string, then: () => Promise<string>) =>
      h.sendAlone.mockImplementationOnce(async (_payload, attempt) => {
        await (attempt as Attempt).onTxHash(hash)
        return then()
      })
    /** The ledger's owner as the chain decides its job: the record first, then the job. */
    const chainLands = async () => {
      await pending.upsert(account, { broadcast: true })
      await getBroadcastLedger().markLanded(sipaAddress)
    }
    const jobOf = () => getBroadcastLedger().get(sipaAddress)

    it("publishes it on its own before the burn when batching is off, the ledger holding its hash", async () => {
      // A job an earlier page owed: the claim sends its broadcast, so the ledger does not.
      await owe()
      freshPayloads.set(sipaAddress, {} as never)
      let seededAtSend: number | undefined
      sendsAlone("0xalone", async () => {
        seededAtSend = (await withdrawals()).length
        expect(jobOf()).toMatchObject({ state: "sent", txHash: "0xalone" })
        return "0xalone"
      })
      expect(await fundSeparately()).toBe(HASH)
      expect(h.payload).toHaveBeenCalledWith(
        (deps as { wallet: unknown }).wallet,
        expect.anything(),
        expect.objectContaining({ sipaAddress }),
      )
      expect(h.sendAlone).toHaveBeenCalledWith({ sipaAddress: "payload" }, expect.anything())
      // The burn is seeded only once the address it pays is published.
      expect(seededAtSend).toBe(0)
      expect(h.broadcastCalls).not.toHaveBeenCalled()
      expect(sdkOptions().broadcasts).toBeUndefined()
      expect(sdkOptions().voucher?.withdraw).toMatchObject({ amount: BURN })
      expect(pending.current(l2Address)?.broadcast).toBe(true)
      expect(jobOf()).toMatchObject({ state: "landed" })
      expect(freshPayloads.has(sipaAddress)).toBe(false)
    })

    it("publishes it in the claim's own batch, and stamps it once that lands", async () => {
      await owe()
      freshPayloads.set(sipaAddress, {} as never)
      expect(await fund()).toBe(HASH)
      expect(h.cacheClaim).toHaveBeenCalledWith(expect.objectContaining({ handle: "alice" }), {
        sipaAddress: "payload",
      })
      expect(sdkOptions().broadcasts).toEqual([{ __fake: "notify" }, { __fake: "sweep" }])
      expect(sdkOptions().voucher?.withdraw).toMatchObject({ amount: BURN })
      expect(h.sendAlone).not.toHaveBeenCalled()
      expect(pending.current(l2Address)?.broadcast).toBe(true)
      expect(jobOf()).toBeNull()
      expect(freshPayloads.has(sipaAddress)).toBe(false)
    })

    it("waits out a broadcast a page already sent, and claims once it lands", async () => {
      await owe({ txHash: "0xsent" })
      const claimed = fund()
      await new Promise((r) => setTimeout(r, 10))
      expect(h.claimSdk).not.toHaveBeenCalled()
      await chainLands()
      expect(await claimed).toBe(HASH)
      expect(h.payload).not.toHaveBeenCalled()
      expect(h.sendAlone).not.toHaveBeenCalled()
      expect(sdkOptions().broadcasts).toBeUndefined()
      expect(sdkOptions().voucher?.withdraw).toMatchObject({ amount: BURN })
    })

    it("takes the broadcast over in its batch when the page's attempt does not land", async () => {
      await owe({ txHash: "0xsent" })
      const claimed = fund()
      await new Promise((r) => setTimeout(r, 10))
      await getBroadcastLedger().markFailed(sipaAddress, "The network dropped the broadcast")
      expect(await claimed).toBe(HASH)
      expect(sdkOptions().broadcasts).toEqual([{ __fake: "notify" }, { __fake: "sweep" }])
      expect(h.sendAlone).not.toHaveBeenCalled()
      expect(pending.current(l2Address)?.broadcast).toBe(true)
    })

    it("is refused for a retry, with nothing seeded, when that broadcast does not settle in time", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        await owe({ txHash: "0xsent" })
        const watched = vi.spyOn(getBroadcastLedger(), "onListChanged")
        const refused = fund().catch((err: unknown) => err)
        await vi.waitFor(() => expect(watched).toHaveBeenCalled())
        await vi.advanceTimersByTimeAsync(60_000)
        const err = await refused
        expect(err).toBeInstanceOf(RegistrationFundingError)
        expect(err).toMatchObject({ reason: "unpublished" })
        expect((err as Error).cause).toBeInstanceOf(TimeoutError)
        expect(h.claimSdk).not.toHaveBeenCalled()
        expect(await withdrawals()).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it("is refused when its broadcast cannot be built yet, with nothing seeded", async () => {
      h.payload.mockRejectedValueOnce(new Error("Waiting for unlock"))
      const refused = await fund().catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(RegistrationFundingError)
      expect(refused).toMatchObject({ reason: "unpublished" })
      expect(h.claimSdk).not.toHaveBeenCalled()
      expect(await withdrawals()).toHaveLength(0)
    })

    it("keeps the ledger beside it off a separate broadcast the node has not taken yet", async () => {
      const ALONE = `0x${"22".repeat(32)}`
      // The ledger's own view of the chain: a hash the node does not hold reads as dropped.
      const nodeHolds = new Set<string>()
      const receipt = vi.fn(async (hash: { toString(): string }) =>
        nodeHolds.has(hash.toString())
          ? { status: TxStatus.PROPOSED, blockNumber: 43 }
          : { status: TxStatus.DROPPED },
      )
      const resend = vi.fn()
      const stop = startBroadcasts({ node: { getTxReceipt: receipt } } as never, {
        registration: {
          landed: async () => false,
          send: resend,
          onLanded: async () => {
            await pending.upsert(account, { broadcast: true })
          },
        },
      })
      try {
        await new Promise((r) => setTimeout(r, 10))
        sendsAlone(ALONE, async () => {
          // Steps the ledger runs before the node takes the tx find nothing to decide.
          await new Promise((r) => setTimeout(r, 50))
          nodeHolds.add(ALONE)
          throw new Error("Receipt timed out")
        })
        expect(await fundSeparately()).toBe(HASH)
        expect(resend).not.toHaveBeenCalled()
        expect(jobOf()).toMatchObject({ state: "landed", txHash: ALONE, failures: 0 })
        expect(sdkOptions().voucher?.withdraw).toMatchObject({ amount: BURN })
      } finally {
        stop()
      }
    })

    it("leaves a separate broadcast the chain dropped owed to the ledger, and claims nothing", async () => {
      sendsAlone("0xalone", async () => {
        throw new Error("Receipt timed out")
      })
      const claimed = fundSeparately().catch((err: unknown) => err)
      await vi.waitFor(() => expect(jobOf()).toMatchObject({ state: "sent" }))
      await getBroadcastLedger().markFailed(sipaAddress, "The network dropped the broadcast")
      expect(await claimed).toMatchObject({ message: "Receipt timed out" })
      expect(jobOf()).toMatchObject({ state: "queued", kind: "registration" })
      expect(pending.current(l2Address)?.broadcast).toBe(false)
      expect(h.claimSdk).not.toHaveBeenCalled()
      expect(await withdrawals()).toHaveLength(0)
    })

    it("sends the broadcast on its own first when the batch has no room for it", async () => {
      h.claimSdk.mockRejectedValueOnce(new ClaimBatchFullError("no room"))
      expect(await fund()).toBe(HASH)
      expect(h.sendAlone).toHaveBeenCalledWith({ sipaAddress: "payload" }, expect.anything())
      expect(h.claimSdk).toHaveBeenCalledTimes(2)
      expect(sdkOptions(1).broadcasts).toBeUndefined()
      expect(sdkOptions(1).voucher?.withdraw).toMatchObject({ amount: BURN })
      expect(pending.current(l2Address)?.broadcast).toBe(true)
    })

    it("leaves the ledger watching a batch the node took, to re-send only if it drops", async () => {
      h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
        await sendLikeTheWallet(options as WalletSendOptions, HASH, () => {})
        throw new Error("Receipt timed out")
      })
      h.getTxReceipt.mockRejectedValue(new Error("node away"))
      await expect(fund()).rejects.toMatchObject({ name: "TxInFlightError", txHash: HASH })
      expect(jobOf()).toMatchObject({ state: "sent", txHash: HASH })
      expect(pending.current(l2Address)?.broadcast).toBe(false)
    })
  })

  it("fails the record with the send's error, and drops it on a cancel", async () => {
    h.claimSdk.mockRejectedValueOnce(new Error("Simulation failed"))
    await expect(fund()).rejects.toThrow("Simulation failed")
    expect(await withdrawals()).toHaveLength(1)
    expect((await withdrawals())[0]).toMatchObject({
      phase: "failed",
      failure: { code: "withdrawal.failed", detail: "Simulation failed" },
    })
    expect(h.wake).not.toHaveBeenCalled()

    h.claimSdk.mockRejectedValueOnce(new Error("Cancelled"))
    await expect(fund()).rejects.toThrow("Cancelled")
    expect(await withdrawals()).toHaveLength(1)
  })

  it("keeps a broadcast burn at its hash when the receipt wait fails, and reports the claim by it", async () => {
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      await sendLikeTheWallet(options as WalletSendOptions, HASH, () => {})
      throw new Error("Receipt timed out")
    })
    h.getTxReceipt.mockRejectedValue(new Error("node away"))
    await expect(fund()).rejects.toMatchObject({ name: "TxInFlightError", txHash: HASH })
    expect((await withdrawals())[0]).toMatchObject({ phase: "submitting", l2TxHash: HASH })
    expect((await withdrawals())[0]?.failure).toBeUndefined()
    expect(h.wake).toHaveBeenCalled()
    // Both stamps saved, so the claim's operation is left to the chain.
    expect(getOperationStore().get(sdkOptions().operationId)).toMatchObject({
      state: "sent",
      txHash: HASH,
    })
  })

  it("holds the claim's and the burn's hashes when the node takes the batch", async () => {
    const db = watchWalletDb()
    let held: boolean[] = []
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      await sendLikeTheWallet(options as WalletSendOptions, HASH, () => {
        held = [db.holds("activity", HASH), db.holds("withdrawals", HASH)]
      })
      return HASH
    })
    expect(await fund()).toBe(HASH)
    expect(held).toEqual([true, true])
  })

  it("sends nothing when the burn's hash cannot be saved", async () => {
    watchWalletDb().refuse("withdrawals", HASH)
    const node = vi.fn()
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      await sendLikeTheWallet(options as WalletSendOptions, HASH, node)
      return HASH
    })
    const err = await fund().catch((e: unknown) => e)
    expect(err).toMatchObject({ message: "quota exceeded" })
    expect(err).not.toMatchObject({ name: "TxInFlightError" })
    expect(node).not.toHaveBeenCalled()
    expect((await withdrawals())[0]).toMatchObject({ phase: "failed" })
  })

  /**
   * The batch that spends the link is signed with the passkey the signup just made, so it counts
   * as signup rather than as an ordinary approval. The signature happens inside the SDK claim,
   * which is where this drives it from.
   */
  describe("the flow its signature is reported under", () => {
    let fetchSpy: MockInstance<typeof fetch>
    let signInsideClaim: () => Promise<void>

    beforeEach(async () => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
      const { passkeyTelemetry } = await import("../../../../src/lib/passkeyTelemetry")
      const { bindAnalyticsConsent } = await import("../../../../src/lib/analytics")
      const { makeWebauthnSignFn } = await import("../../../../src/platform/auth/webauthnSigning")
      const { FakePasskeyCeremony } = await import("../../../support/fakePasskeyCeremony")
      // Consent is on, so anything that lands on the consent-gated path is visible rather than dropped.
      bindAnalyticsConsent(() => true)
      const inner = new FakePasskeyCeremony({ onRequest: passkeyTelemetry.requestHook })
      const created = await inner.create({
        rpId: "localhost",
        rpName: "test",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      const sign = makeWebauthnSignFn(
        passkeyTelemetry.wrap(inner),
        "localhost",
        created.credentialId,
        created.pubkey,
      )
      signInsideClaim = async () => void (await sign(Buffer.alloc(32, 7)))
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    /** Every passkey result posted so far, as [platform, flow]. */
    const reported = () =>
      fetchSpy.mock.calls
        .map(([, init]) => JSON.parse(String(init?.body)))
        .filter((body) => body.event === "passkey_ceremony")
        .map((body) => [body.platform, body.props.flow])

    it("is signup for a registration-funding claim, and the default for an ordinary one", async () => {
      h.claimSdk.mockImplementation(async () => {
        await signInsideClaim()
        return HASH
      })
      await fund()
      await claimSponsoredLink(deps, "fixture")

      expect(reported()).toEqual([
        ["web-signup", "onboarding"],
        ["web", "other"],
      ])
    })

    it("is let go when the claim throws, so a later signature is not still signup", async () => {
      h.claimSdk.mockImplementationOnce(async () => {
        await signInsideClaim()
        throw new Error("Node rejected the batch")
      })
      await expect(fund()).rejects.toThrow("Node rejected the batch")
      await signInsideClaim()

      expect(reported()).toEqual([
        ["web-signup", "onboarding"],
        ["web", "other"],
      ])
    })
  })

  it("fails the record when the node reports the broadcast dropped", async () => {
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      await sendLikeTheWallet(options as WalletSendOptions, HASH, () => {})
      throw new Error("Node rejected the batch")
    })
    h.getTxReceipt.mockResolvedValue({ status: TxStatus.DROPPED } as never)
    await expect(fund()).rejects.toThrow("Node rejected the batch")
    expect((await withdrawals())[0]).toMatchObject({
      phase: "failed",
      failure: { code: "withdrawal.failed", detail: "Node rejected the batch" },
    })
  })
})

describe("the claim's bell row", () => {
  const row = () => getOperationsInProgress().find((op) => op.flow === "paylink-claim")

  it("is listed before the voucher and note reads answer, which run together", async () => {
    let answerVoucher!: (uses: number) => void
    let answerNote!: (note: { amount: bigint }) => void
    h.voucherUses.mockImplementationOnce(() => new Promise((r) => (answerVoucher = r)))
    h.note.mockImplementationOnce(() => new Promise((r) => (answerNote = r)))
    const claim = fund()
    await vi.waitFor(() => expect(h.note).toHaveBeenCalled())
    expect(h.voucherUses).toHaveBeenCalled()
    const { operationId, summary } = row()!
    expect(summary).toBe("Paylink")

    answerVoucher(1)
    answerNote({ amount: 3n * 10n ** 18n })
    expect(await claim).toBe(HASH)
    expect(getOperationStore().get(operationId)?.summary).toBe("$3 paylink")
  })

  it("is listed while a background proof finishes ahead of the claim", async () => {
    let finishProof!: () => void
    void trackBackgroundProve(() => new Promise<void>((r) => (finishProof = r)))
    const claim = fund()
    await vi.waitFor(() => expect(row()).toBeDefined())
    expect(h.voucherUses).not.toHaveBeenCalled()
    finishProof()
    expect(await claim).toBe(HASH)
  })
})

describe("the claim's preparation", () => {
  const running = () => getOperationsInProgress().map((op) => op.operationId)
  afterEach(() => vi.useRealTimers())

  it("ends a claim whose read never answers, with nothing sent, so a retry can run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.note.mockImplementationOnce(() => new Promise(() => {}))
    const before = running()
    const outcome = fund().then(
      () => "sent",
      (e: Error) => e,
    )
    await vi.advanceTimersByTimeAsync(111_000)
    const ended = await Promise.race([outcome, Promise.resolve("still preparing")])
    expect(ended).toBeInstanceOf(Error)
    expect((ended as Error).message).toMatch(/took too long to prepare/)
    expect((ended as Error).cause).toBeInstanceOf(TimeoutError)
    expect(h.claimSdk).not.toHaveBeenCalled()
    expect(running()).toEqual(before)
    expect(await fund()).toBe(HASH)
  })

  it("never cuts its proof short", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.claimSdk.mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(HASH), 300_000)))
    const claim = fund()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await claim).toBe(HASH)
  })
})

describe("the claim's voucher read", () => {
  afterEach(() => vi.useRealTimers())

  it("gets its whole deadline after the note read queued ahead of it on the PXE", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // The PXE runs one simulation at a time: the note read takes 25 s, then the voucher read 10 s.
    let queue: Promise<unknown> = Promise.resolve()
    const serial = <T>(ms: number, value: T) => {
      const run = queue.then(() => new Promise<T>((r) => setTimeout(() => r(value), ms)))
      queue = run
      return run
    }
    h.note.mockImplementationOnce(() => serial(25_000, { amount: 3n * 10n ** 18n }))
    h.voucherUses.mockImplementationOnce(() => serial(10_000, 1))
    const claim = fund()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await claim).toBe(HASH)
  })
})

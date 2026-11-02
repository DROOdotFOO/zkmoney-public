import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  formatUnits,
  zeroAddress,
  type Address,
  type Hex,
  toFunctionSelector,
} from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  goldenTicketBurn,
  NameClaimStore,
  SIPADepositStore,
  composeWireNameHash,
  createPortalCapacityRegistry,
  createSipaProcessingObserver,
  type PendingRegistrationRecord,
  type PortalCapacityKey,
  type SipaProcessingObserver,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import {
  freshPayloads,
  getBroadcastLedger,
  resetBroadcastsForTests,
} from "../../../../src/features/broadcasts/broadcasts"
import type { WebWalletConfig } from "../../../../src/config/env"
import {
  getPendingStore,
  registrationRecordForSipa,
} from "../../../../src/features/onboarding/webRegistration"
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
} from "../../../../src/features/onboarding/registrationTerms"
import { canManualRegistrationSweep } from "@obsidion/front-core"
import { reconcileRegistrationRefund } from "../../../../src/features/onboarding/registrationQuoteRecovery"
import { recordDepositAdmission, hasDepositAdmission } from "../../../../src/features/identity/admission"
import { saveWalletIdentity } from "../../../../src/features/identity/walletIdentity"
import { signOut } from "../../../../src/features/identity/signOut"
import {
  ticketSignupContinuation,
  ticketSignupRegistration,
} from "../../../../src/features/paylink/ticketContinuation"
import { stashClaimLink } from "../../../../src/features/paylink/claimStash"
import {
  DAI,
  earnedTerms,
  nameClaim,
  resetRegistrationStores,
} from "../../../support/registrationFixtures"
import { PAID, PAID_ASK, RANDOM, RANDOM_ASK } from "../../../support/registrationPrices"

const h = vi.hoisted(() => ({
  sign: vi.fn(),
  redeem: vi.fn(),
  registeredOwner: vi.fn(),
  heldName: vi.fn(),
  derive: vi.fn(),
  seededSalt: vi.fn(async (): Promise<Hex | undefined> => undefined),
  buildSweep: vi.fn(),
  send: vi.fn(),
  wait: vi.fn(),
  broadcast: vi.fn(),
  balance: vi.fn(),
  receipt: vi.fn(),
  metadataRegistry: vi.fn(),
  cap: vi.fn(),
  /** The executor's withdrawal fee, which prices whether a link covers a deposit. */
  withdrawalFee: vi.fn(),
  /** The controller's immutable schedule, counted: the sweep reads it exactly once. */
  schedule: vi.fn(async () => PAID),
  config: {} as WebWalletConfig,
  /** The pending-deposit observer; absent unless a test drives the capacity gate. */
  observer: { current: undefined as Pick<SipaProcessingObserver, "refreshForSweep"> | undefined },
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<object>()),
  AccountServiceClient: class {
    signDomain = h.sign
  },
  createRegistrationSipaDeriver: () => h.derive,
  buildRegistrationSelfSweepCall: h.buildSweep,
  resolveStoredCredentialId: async () => "cred-demo",
  createOxideL1Reader: () => ({
    predictAccountAddress: async () => OWNER,
    readUserAddress: h.registeredOwner,
    readNameOf: h.heldName,
    readAccountMetadataRegistry: h.metadataRegistry,
    getUserOpHash: async () => `0x${"77".repeat(32)}`,
    readR1InstallGas: async () => ({
      verification: 50_000n,
      callBase: 85_000n,
      callPerWord: 30_000n,
    }),
    // The account has no code yet, so consent signs with the bootstrap key.
    getCode: async () => undefined,
  }),
}))
vi.mock("../../../../src/features/onboarding/goldenTicket", () => ({
  redeemGoldenTicketForLink: h.redeem,
}))
// Fake fragments never decode; the checkpoint only needs a stable identity for one.
vi.mock("../../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<object>()),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({ peekAuthService: () => undefined }))
// The portal's per-transaction cap. The manual sweep signs nothing without it.
vi.mock("../../../../src/features/token/oxideToken", async (original) => ({
  ...(await original<object>()),
  txAmountCap: () => h.cap(),
}))
vi.mock("../../../../src/features/withdraw/withdrawalFee", async (original) => ({
  ...(await original<object>()),
  activeWithdrawalFee: () => h.withdrawalFee(),
}))
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => h.config,
}))
vi.mock("../../../../src/config/oxideTuple", async (original) => ({
  ...(await original<object>()),
  oxideEnvFor: async () => ({
    tuple: { portal: PORTAL },
    env: ENV,
    publicClient: { readContract: h.balance },
  }),
  l1PublicClient: () => ({ readContract: h.balance, getTransactionReceipt: h.receipt }),
  // The fee token's row is the registration's.
  getFeeTokenBridgeTuple: async () => ({ portal: PORTAL }),
}))
vi.mock("../../../../src/features/onboarding/registrationTerms", async (original) => ({
  ...(await original<object>()),
  resolveBeneficiary: async () => OWNER,
  readRegistrationSchedule: h.schedule,
}))
vi.mock("../../../../src/features/onboarding/registrationDepositSeed", () => ({
  makeRegistrationDepositSeeder: () => vi.fn().mockResolvedValue(undefined),
  healRegistrationDeposits: vi.fn(),
  seededRegistrationSalt: h.seededSalt,
}))
vi.mock("../../../../src/features/onboarding/webRegistrationBroadcast", () => ({
  createWebRegistrationBroadcaster: () => h.broadcast,
}))
vi.mock("../../../../src/features/deposit/sipaRecovery", async (original) => ({
  ...(await original<object>()),
  injectedWalletChannel: async () => ({
    target: OWNER,
    sendTransaction: h.send,
    waitForReceipt: h.wait,
  }),
}))
vi.mock("../../../../src/features/deposit/sipaProcessing", async (original) => ({
  ...(await original<object>()),
  sipaProcessingObserver: () => h.observer.current,
}))
vi.mock("../../../../src/features/deposit/sipaSweep", async (original) => ({
  ...(await original<object>()),
  readSipaDeployed: async () => false,
  sweepManifestFrom: () => ({ sipaFactory: OWNER, token: TOKEN }),
}))
// A mainnet profile accepts the stables that swap into the registration token.
vi.mock("../../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mainnetTokens, mockLoadDepositFacts, singleToken } = await import(
    "../../../support/depositTokens"
  )
  return mockLoadDepositFacts(importOriginal, () =>
    h.config.network === "mainnet" ? mainnetTokens(TOKEN) : singleToken(TOKEN),
  )
})
const { manualRegistrationSweep, SWEEP_PRICE_COMMITTED, SWEEP_QUOTE_UNUSABLE } = await import(
  "../../../../src/features/onboarding/registrationSweep"
)
const { claimTag } = await import("../../../../src/features/onboarding/oxideOnboarding")
const { SweepRefusedError } = await import("../../../../src/features/deposit/sipaSweep")
const OWNER = `0x${"11".repeat(20)}` as Address
const OLD = `0x${"22".repeat(20)}` as Address
const NEW = `0x${"33".repeat(20)}` as Address
const TOKEN = `0x${"44".repeat(20)}` as Address
const IMPL = `0x${"77".repeat(20)}` as Address
const PORTAL = `0x${"88".repeat(20)}` as Address
const TABLE = `0x${"99".repeat(20)}` as Address
const L2 = `0x${"55".repeat(32)}` as Hex
const HASH = `0x${"66".repeat(32)}` as Hex
/** Answers the recovery's holding read: `balance` of the first token asked for. */
const held = (balance: bigint) => async () => balance
/** The old paid registration's deposit, refunded before the restart. */
const REFUND = PAID_ASK
/** An earned quote's minimum from before the random-tag price dropped. */
const LEGACY_MIN = 5n * DAI
/** The random-tag floor at a zero portal cut in USDC units, and the least USDC that clears it after the swap. */
const USDC_FLOOR = (RANDOM.fee + RANDOM.min) / 10n ** 12n
const USDC_CLEARS = (USDC_FLOOR * 10_000n) / 9_900n + 1n
const ENV = {
  registry: OWNER,
  factory: OWNER,
  ensDomain: "zk.money",
  resolverOperator: OWNER,
  rollupVersion: 1n,
  l1ChainId: 11155111,
  feeToken: TOKEN,
  namePortalRecipient: L2,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
}
const old: PendingRegistrationRecord = {
  account: OWNER,
  tag: "demo",
  nameHash: HASH,
  l2Address: L2,
  l1ChainId: 11155111,
  sipaAddress: OLD,
  fee: String(PAID.fee),
  beneficiary: OWNER,
  depositToken: TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 3,
  startTime: 1,
}
/** The random-tag claim the restart is quoted. */
const claim = () =>
  nameClaim({
    signature: "0xaa",
    terms: earnedTerms({ fee: String(RANDOM.fee), minDeposit: String(RANDOM.min) }),
  })
/** A claim on the paid schedule, which the earned restart cannot use. */
const standardClaim = () =>
  nameClaim({
    terms: earnedTerms({ fee: String(PAID.fee), minDeposit: String(PAID.min), reduced: false }),
  })
/** A refund receipt moving `amount` of the token off the old address. */
const transfer = (amount: bigint) => ({
  status: "success",
  logs: [
    {
      address: TOKEN,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: OLD, to: OWNER },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    },
  ],
})
const keys = {
  pubkeyHex: `0x${"11".repeat(64)}`,
  secretKey: new Fr(123n),
  account: { getAddress: () => ({ toString: () => L2 }), getAuthProvider: () => ({}) },
} as never
beforeEach(async () => {
  resetBroadcastsForTests()
  vi.clearAllMocks()
  h.withdrawalFee.mockResolvedValue(0n)
  localStorage.clear()
  resetRegistrationStores()
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  h.config = {
    l1RpcUrl: "http://127.0.0.1:8545",
    l1ChainId: 11155111,
    network: "testnet",
    rpId: "localhost",
  } as WebWalletConfig
  await getPendingStore().load()
  await getPendingStore().upsert(OWNER, {}, old)
  const rail = SIPADepositStore.get(webStorage)
  await rail.load()
  await rail.upsert(
    OLD,
    { phase: "recovered" },
    {
      networkId: "0xnet",
      recipientL2Address: L2,
      tokenAddress: TOKEN,
      tokenSymbol: "DAI",
      l1ChainId: 11155111,
      messageSecret: HASH,
      recoveryAddress: OWNER,
      recipientHash: HASH,
      amount: formatUnits(REFUND, 18),
      recoveryTxHash: HASH,
      startTime: 1,
    },
  )
  await signInPending(1)
  recordDepositAdmission(old, REFUND)
  h.sign.mockResolvedValue(claim())
  h.redeem.mockReset().mockResolvedValue({ status: "created" })
  h.registeredOwner.mockReset().mockResolvedValue(zeroAddress)
  h.heldName.mockReset().mockResolvedValue(`0x${"00".repeat(32)}`)
  h.cap.mockReset().mockResolvedValue(10_000n * DAI)
  h.metadataRegistry.mockResolvedValue(OWNER)
  h.balance.mockResolvedValue(0n)
  h.receipt.mockResolvedValue(transfer(REFUND))
  h.derive.mockResolvedValue({
    sipaAddress: NEW,
    sipaArgs: {},
    recordData: "0x1234",
    registrationData: "0x1234",
    sharedSecretSalt: HASH,
    stealthScalar: 1n,
    origin: {
      protocol: "account",
      sipaFactory: OWNER,
      implementation: IMPL,
      intentHash: HASH,
      rollupVersion: "1",
      resweepable: false,
      recoveryAccount: OWNER,
      recoveryCommitment: HASH,
      accountFactory: OWNER,
      forwardingTable: TABLE,
    },
  })
  h.broadcast.mockRejectedValue(new Error("one-use registration broadcast already spent"))
  h.buildSweep.mockReturnValue({ to: OWNER, data: "0x1234" })
  h.send.mockResolvedValue(HASH)
  h.wait.mockResolvedValue(true)
})
/** Restarts the registration from `refunded`, the address whose deposit was recovered. */
const restart = (refunded = old) =>
  claimTag("demo", keys, h.config, {} as never, undefined, true, refunded)
/** Replaces `unfunded`, an address nothing reached, with one at the earned price. */
const replace = (unfunded = old) =>
  claimTag("demo", keys, h.config, {} as never, undefined, true, undefined, unfunded)
/** The restarted record, its broadcast settled, with the random-tag ask at its address. */
const fundedReplacement = async () => {
  const result = await restart()
  if (result.kind !== "pending") throw new Error("expected new deposit")
  h.balance.mockResolvedValue(RANDOM_ASK)
  return getPendingStore().get(OWNER)!
}
/** Drops the cached claim, so the next sweep asks the claim server again. */
const forgetClaim = async () => {
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  await NameClaimStore.get().remove(L2)
}
function signInPending(claimedAt: number) {
  return saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt })
}
/** Recovers the old address's deposit off the activity list, in a send that lands as `txHash`. */
const recoverOld = async (txHash: Hex) => {
  const { recoverSipaDeposit } = await import("../../../../src/features/deposit/sipaRecovery")
  const rail = SIPADepositStore.get(webStorage)
  const run = async () => {
    await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: txHash })
    return txHash
  }
  return recoverSipaDeposit(rail.get(OLD)!, {
    channel: { target: OWNER, sendTransaction: h.send, waitForReceipt: h.wait },
    chainId: 11155111,
    tokens: [{ address: TOKEN, symbol: "DAI", decimals: 18 }],
    readBalance: held(DAI / 5n),
    readEthBalance: async () => 0n,
    readReceipt: (hash) => h.receipt({ hash }),
    deployment: {} as never,
    store: rail,
    stealthKey: async () => ({} as never),
    run,
  })
}

describe("refund then restart the earned registration", () => {
  it("replaces the refunded commitment with random-tag terms and retains access when broadcasting is spent", async () => {
    const result = await restart()
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(freshPayloads.has(NEW.toLowerCase())).toBe(false)
    expect(h.broadcast).not.toHaveBeenCalled()
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement).toMatchObject({
      sipaAddress: NEW,
      fee: String(RANDOM.fee),
      phase: "awaiting_deposit",
      broadcast: false,
      replaced: { sipaAddress: OLD, refunded: true, broadcastSpent: true },
    })
    expect(hasDepositAdmission(replacement)).toBe(false)
    expect((await NameClaimStore.get().get(L2))?.terms?.fee).toBe(String(RANDOM.fee))
    h.balance.mockResolvedValue(RANDOM_ASK)
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        sipaAddress: NEW,
        signedTerms: expect.objectContaining({ fee: RANDOM.fee, minDeposit: RANDOM.min }),
      }),
      expect.anything(),
    )
    expect(h.send).toHaveBeenCalledWith(OWNER, "0x1234")
    expect(getPendingStore().get(OWNER)?.sweepTxHash).toBe(HASH)
  })
  it("sweeps an address shown before the wallet's salt key, from the salt seeded with it", async () => {
    const record = await fundedReplacement()
    const seeded = `0x${"99".repeat(32)}` as Hex
    const shown = await h.derive()
    // The wallet's key now derives another address; only the seeded salt lands on this one.
    h.derive.mockImplementation(async ({ sharedSecretSalt }: { sharedSecretSalt?: Hex }) =>
      sharedSecretSalt === seeded ? shown : { ...shown, sipaAddress: OWNER },
    )
    await expect(manualRegistrationSweep(record, { keys })).rejects.toThrow(
      "different deposit address",
    )
    h.seededSalt.mockResolvedValueOnce(seeded)
    await expect(manualRegistrationSweep(record, { keys })).resolves.toBe(HASH)
    expect(h.seededSalt).toHaveBeenLastCalledWith(NEW)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: NEW }),
      expect.anything(),
    )
  })

  describe("the capacity gate", () => {
    const blocked: SipaProcessingState = {
      reason: {
        kind: "capacity",
        requiredAtomic: 4n * DAI,
        availableAtomic: DAI,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: 1,
      },
      blocker: { kind: "capacity", observedAt: 1 },
    }
    const replacement = async () => {
      await restart()
      h.balance.mockResolvedValue(5n * DAI)
      return getPendingStore().get(OWNER)!
    }
    afterEach(() => {
      h.observer.current = undefined
    })

    /** The production observer over the rail store, against a portal with 1 DAI left by default. */
    const exhausted = (availableAtomic = DAI) => {
      const readTerms = vi.fn(async () => ({
        portal: PORTAL,
        token: TOKEN,
        depositFee: DAI / 10n,
        txAmountCap: 10_000n * DAI,
      }))
      const read = vi.fn(async (key: PortalCapacityKey) => ({
        ...key,
        decimals: 18,
        blockNumber: 1n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        rateAtomicPerSecond: 0n,
        globalLimitAtomic: 2_583n * DAI,
        availableAtomic,
        txAmountCapAtomic: 10_000n * DAI,
      }))
      const registry = createPortalCapacityRegistry({
        read,
        visibility: { isVisible: () => true, onResume: () => () => {} },
        policy: { maxHeadAgeMs: Infinity },
      })
      h.observer.current = createSipaProcessingObserver({
        deposits: SIPADepositStore.get(webStorage),
        capacity: (key) => registry.store(key),
        readTerms,
        l1ChainId: 11155111,
      })
      return { readTerms, read }
    }

    const refusedBeforeSigning = async (
      record: PendingRegistrationRecord,
      { readTerms, read }: ReturnType<typeof exhausted>,
    ) => {
      const sweep = manualRegistrationSweep(record, { keys })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      await expect(sweep).rejects.toThrow(/stopped before signing/)
      // The registration row of the table the address commits to.
      expect(readTerms).toHaveBeenCalledWith({ forwardingTable: TABLE, intent: 2 })
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 11155111, portal: PORTAL, token: TOKEN }),
      )
      expect(h.buildSweep).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
    }

    describe("a stable deposit on mainnet", () => {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
      /** USDC that clears the random-tag floor after the swap's allowed loss. */
      const stable = async () => {
        const result = await restart()
        if (result.kind !== "pending") throw new Error("expected new deposit")
        h.config = { ...h.config, network: "mainnet" } as WebWalletConfig
        h.balance.mockImplementation(async ({ address }: { address: Address }) =>
          address === USDC ? USDC_CLEARS : 0n,
        )
        return getPendingStore().get(OWNER)!
      }

      it("lets the converted deposit through while any capacity is left", async () => {
        // Converted credit is unknown, so 1 DAI of room is not read as too little.
        exhausted()
        await expect(manualRegistrationSweep(await stable(), { keys })).resolves.toBe(HASH)
      })

      it("refuses the converted deposit before signing at zero capacity", async () => {
        const record = await stable()
        await refusedBeforeSigning(record, exhausted(0n))
      })
    })

    it("reads its own portal without a rail record and refuses before signing", async () => {
      const record = await replacement()
      expect(SIPADepositStore.get(webStorage).get(NEW)).toBeNull()
      await refusedBeforeSigning(record, exhausted())
    })

    /** The rail record the registration seeder writes, with `patch` over it. */
    const seedRail = (patch: { phase: "broadcast" | "resolved"; amount: string }) =>
      SIPADepositStore.get(webStorage).upsert(
        NEW,
        { phase: patch.phase, registrationFee: String(RANDOM.fee) },
        {
          networkId: "0xnet",
          recipientL2Address: L2,
          messageSecret: HASH,
          recipientHash: HASH,
          recoveryAddress: OWNER,
          origin: {
            protocol: "account",
            sipaFactory: OWNER,
            implementation: IMPL,
            intentHash: HASH,
            rollupVersion: "1",
            resweepable: false,
            recoveryAccount: OWNER,
            recoveryCommitment: HASH,
            accountFactory: OWNER,
            forwardingTable: TABLE,
          },
          l1ChainId: 11155111,
          amount: patch.amount,
          tokenSymbol: "DAI",
          startTime: Date.now(),
          tokenAddress: TOKEN,
          tokenDecimals: 18,
          intent: "registration",
        },
      )

    it("measures a topped-up deposit at the balance it just read, not the smaller stored amount", async () => {
      const record = await replacement()
      // 1 DAI stored fits the 1 DAI of room after the fee; the 5 DAI on chain does not.
      await seedRail({ phase: "broadcast", amount: "1" })
      await refusedBeforeSigning(record, exhausted())
      expect(SIPADepositStore.get(webStorage).get(NEW)?.amount).toBe("1")
    })

    it("names a capacity refusal decoded from the estimate", async () => {
      h.observer.current = { refreshForSweep: vi.fn(async () => undefined) }
      h.send.mockRejectedValueOnce(
        Object.assign(new Error("execution reverted"), {
          cause: { data: toFunctionSelector("Caps__GlobalLimitSurpassed()") },
        }),
      )
      const sweep = manualRegistrationSweep(await replacement(), { keys })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      await expect(sweep).rejects.toThrow(
        /insufficient for this deposit, so the sweep did not go through/,
      )
    })

    it("after a reverted receipt, states a current blocker without calling it the cause", async () => {
      h.observer.current = {
        refreshForSweep: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(blocked),
      }
      h.wait.mockResolvedValueOnce(false)
      const sweep = manualRegistrationSweep(await replacement(), { keys })
      await expect(sweep).rejects.toThrow(
        /could not determine why\. A relayer may have swept this deposit first, or the deposit is below the registration total\. Network capacity is currently insufficient for this deposit\.$/,
      )
      await expect(sweep).rejects.not.toBeInstanceOf(SweepRefusedError)
    })
  })

  it("restarts from a refund whose receipt wait was interrupted before it confirmed", async () => {
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: HASH })
    await signOut()
    await signInPending(2)
    const result = await restart()
    expect(result.kind).toBe("pending")
    expect(rail.get(OLD)?.phase).toBe("recovered")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(NEW)
  })
  it("keeps the verified refund on the replacement when the session dies after its checkpoint", async () => {
    h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(restart()).rejects.toThrow("rpc down")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(REFUND),
    })
    await signOut()
    await signInPending(2)
    // The record no longer names the refunded address, so the plain earned claim resumes it.
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD },
    })
  })
  it("stamps no waiver for a claim that signed no schedule", async () => {
    const unpriced = nameClaim()
    h.sign.mockResolvedValue(unpriced)
    const result = await claimTag("demo", keys, h.config, {} as never)
    expect(result.kind).toBe("pending")
    const terms = loadRegistrationTerms(OWNER, "demo")
    expect(terms?.deadline).toBe(Number(unpriced.deadline))
    // Absent is "no schedule named a kind", which is not the same as the standard one.
    expect(terms && "feeWaived" in terms).toBe(false)
  })
  it("keeps wallet entry when a funded registration is recovered from the activity list", async () => {
    await signOut()
    await signInPending(2)
    await getPendingStore().upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    expect(hasDepositAdmission(old)).toBe(false)
    await SIPADepositStore.get(webStorage).upsert(OLD, {
      phase: "recoverable",
      recoveryTxHash: undefined,
    })
    // The rest of the 15 DAI landed after the balance read; the receipt says what moved.
    h.receipt.mockResolvedValue(transfer(15n * DAI))
    await expect(recoverOld(HASH)).resolves.toBe(HASH)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: OLD,
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(15n * DAI) },
    })
    expect(getPendingStore().get(OWNER)?.fundedAt).toBeUndefined()
    await signOut()
    await signInPending(3)
    const result = await restart(getPendingStore().get(OWNER)!)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD },
    })
  })
  it("keeps wallet entry when the receipt that bought it is unreadable during the restart", async () => {
    const { registrationRefunded } = await import(
      "../../../../src/features/onboarding/registrationQuoteRecovery"
    )
    const later = `0x${"99".repeat(32)}` as Hex
    expect(registrationRefunded(old)).toBe(true)
    await reconcileRegistrationRefund(old, h.config)
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable" })
    await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: later })
    expect(registrationRefunded(old)).toBe(true)
    let failFirst = true
    h.receipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash === later) return transfer(DAI / 5n)
      if (failFirst) {
        failFirst = false
        throw new Error("rpc down")
      }
      return transfer(REFUND)
    })
    await expect(restart()).rejects.toThrow("could not be read")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    const result = await restart()
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(REFUND) },
    })
    await signOut()
    await signInPending(2)
  })
  it("restarts on a refund below the earned total without buying wallet entry", async () => {
    await signOut()
    await signInPending(2)
    h.receipt.mockResolvedValue(transfer(RANDOM.fee))
    const result = await restart()
    expect(result.kind).toBe("pending")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.fee).toBe(String(RANDOM.fee))
    expect(replacement.refundedEntry).toBeUndefined()
  })
  it("replaces an unfunded old address at the earned price while it stays empty", async () => {
    const result = await replace()
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(freshPayloads.has(NEW.toLowerCase())).toBe(false)
    expect(h.broadcast).not.toHaveBeenCalled()
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.fee).toBe(String(RANDOM.fee))
    expect(replacement.refundedEntry).toBeUndefined()
    // The old address was broadcast: the rail's one use is gone, so only a manual sweep finishes.
    expect(replacement.replaced).toEqual({
      sipaAddress: OLD,
      refunded: false,
      broadcastSpent: true,
    })
    // The old record stays behind, closed, so a deposit reaching it later can still be recovered.
    const archived = registrationRecordForSipa(OLD)!
    expect(archived).toMatchObject({
      tag: "demo",
      fee: String(PAID.fee),
      phase: "failed_terminal",
    })
    expect(canManualRegistrationSweep(archived)).toBe(false)
    expect(registrationRecordForSipa(NEW)?.sipaAddress).toBe(NEW)
    expect((await NameClaimStore.get().get(L2))?.terms?.fee).toBe(String(RANDOM.fee))
    h.balance.mockResolvedValue(RANDOM_ASK)
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: NEW }),
      expect.anything(),
    )
  })
  it("re-enters the refunded record when the corrected quote only lowered the minimum", async () => {
    // A legacy earned quote over an older, higher minimum, refunded: the fee, and so the address, stay.
    await getPendingStore().upsert(OWNER, {
      fee: String(RANDOM.fee),
      nameHash: composeWireNameHash("demo", ENV.ensDomain),
      r1Key: { qx: HASH, qy: HASH },
      credentialId: "cred",
    })
    saveRegistrationTerms({
      account: OWNER,
      tag: "demo",
      deadline: 1,
      fee: String(RANDOM.fee),
      minDeposit: String(LEGACY_MIN),
      feeWaived: true,
    })
    h.derive.mockResolvedValue({
      sipaAddress: OLD,
      sipaArgs: {},
      recordData: "0x1234",
      registrationData: "0x1234",
      sharedSecretSalt: HASH,
      stealthScalar: 1n,
    })
    const legacy = getPendingStore().get(OWNER)!
    recordDepositAdmission(legacy, LEGACY_MIN)
    expect(hasDepositAdmission(legacy)).toBe(true)
    const result = await restart(legacy)
    expect(result.kind).toBe("pending")
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: OLD,
      fee: String(RANDOM.fee),
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, amount: String(REFUND) },
    })
    expect(getPendingStore().get(OWNER)?.replaced).toBeUndefined()
    // The receipt vouched for the refunded deposit: the resumed registration must ask for a new one.
    expect(hasDepositAdmission(getPendingStore().get(OWNER)!)).toBe(false)
    expect(registrationRecordForSipa(OLD)?.phase).toBe("awaiting_deposit")
    expect(walletStorage.getItem("webwallet.registration.replaced")).toBe("[]")
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      fee: String(RANDOM.fee),
      minDeposit: String(RANDOM.min),
      feeWaived: true,
      earnedExpected: true,
    })
    // The rail starts the address over: the old recovery is evidence, not the new deposit's state.
    const rail = SIPADepositStore.get(webStorage)
    expect(rail.get(OLD)).toMatchObject({ phase: "broadcast", amount: "0" })
    expect(rail.get(OLD)?.recoveryTxHash).toBeUndefined()
    h.balance.mockResolvedValue(RANDOM_ASK)
    await expect(manualRegistrationSweep(getPendingStore().get(OWNER)!, { keys })).resolves.toBe(
      HASH,
    )
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: OLD }),
      expect.anything(),
    )
    // The swept deposit keeps its progress through a reconciliation of the historical refund.
    h.balance.mockResolvedValue(0n)
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    expect(rail.get(OLD)).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })
  })
  it("archives the old record before the quote, so a refusal before the derivation keeps it", async () => {
    h.sign.mockRejectedValueOnce(new Error("rpc down"))
    await expect(replace()).rejects.toThrow("rpc down")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(JSON.parse(walletStorage.getItem("webwallet.registration.replaced")!)).toMatchObject([
      { sipaAddress: OLD, phase: "failed_terminal" },
    ])
  })
  it.each([["refunded", () => restart(getPendingStore().get(OWNER)!), true]])(
    "leaves the broadcast to the relayer rail when the %s address never used it",
    async (_, run, refunded) => {
      await getPendingStore().upsert(OWNER, { broadcast: false })
      const result = await run()
      if (result.kind !== "pending") throw new Error("expected new deposit")
      // The sheet that shows the new address owes it, on the payload the session kept; the old
      // address is never owed.
      expect(getBroadcastLedger().get(NEW)).toBeNull()
      expect(freshPayloads.has(NEW.toLowerCase())).toBe(true)
      expect(freshPayloads.has(OLD.toLowerCase())).toBe(false)
      expect(getPendingStore().get(OWNER)).toMatchObject({
        sipaAddress: NEW,
        replaced: { sipaAddress: OLD, refunded, broadcastSpent: false },
      })
    },
  )
  it("inherits a spent broadcast through a chain of replacements", async () => {
    const spent = { sipaAddress: TOKEN, refunded: false, broadcastSpent: true }
    await getPendingStore().upsert(OWNER, { broadcast: false, replaced: spent })
    const result = await replace(getPendingStore().get(OWNER)!)
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(getPendingStore().get(OWNER)?.replaced).toEqual({ ...spent, sipaAddress: OLD })
  })
  it("aborts the replace and keeps the old record when a deposit reaches it during the quote fetch", async () => {
    // Empty when the screen checked, funded by the time the checkpoint would overwrite it.
    h.balance.mockResolvedValue(RANDOM_ASK)
    await expect(replace()).rejects.toThrow("A deposit reached this address")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(h.broadcast).not.toHaveBeenCalled()
  })
  it.each(["underfunded", "incompatible quote"])(
    "does not submit a manual sweep when %s",
    async (reason) => {
      const replacement = await fundedReplacement()
      if (reason === "underfunded") h.balance.mockResolvedValue(RANDOM.fee + RANDOM.min - 1n)
      if (reason === "incompatible quote") {
        await forgetClaim()
        h.sign.mockResolvedValue(standardClaim())
      }
      await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
        reason === "underfunded" ? "does not yet cover" : SWEEP_PRICE_COMMITTED,
      )
      expect(h.send).not.toHaveBeenCalled()
    },
  )
  it("treats a claim carrying no schedule as a quote to try again, not a committed price", async () => {
    const replacement = await fundedReplacement()
    await forgetClaim()
    h.sign.mockResolvedValue(nameClaim())
    h.schedule.mockClear()
    // The deployment's own fee is not this address's; a re-signed claim may yet price it.
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
      SWEEP_QUOTE_UNUSABLE,
    )
    // One read prices both the claim decision and the check it feeds.
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalled()
    // The schedule the earlier claim signed is still what prices this registration.
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      fee: String(RANDOM.fee),
      feeWaived: true,
    })
  })
  it("signs nothing for a deposit while the portal's cap is unread", async () => {
    const replacement = await fundedReplacement()
    h.cap.mockRejectedValue(new Error("rpc down"))
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow("Try again")
    expect(h.send).not.toHaveBeenCalled()
  })
  // The SIPA swaps a stable into DAI at up to 1% loss before the controller floors it, so a stable
  // that only meets the floor at parity is held; one that clears it after the loss sweeps.
  it("sweeps the stable a mainnet deposit holds once it clears the floor after the swap", async () => {
    const replacement = await fundedReplacement()
    h.config = { ...h.config, network: "mainnet" } as WebWalletConfig
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    let usdc = USDC_FLOOR
    h.balance.mockImplementation(async ({ address }: { address: Address }) =>
      address === USDC ? usdc : 0n,
    )
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
      "does not yet cover",
    )
    expect(h.send).not.toHaveBeenCalled()
    usdc = USDC_CLEARS
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ manifest: expect.objectContaining({ token: USDC }) }),
    )
  })
  it.each(["not refunded", "standard quote", "same address"])(
    "preserves the old record when %s",
    async (reason) => {
      if (reason === "not refunded") h.balance.mockResolvedValue(REFUND)
      if (reason === "standard quote") h.sign.mockResolvedValue(standardClaim())
      if (reason === "same address") h.derive.mockResolvedValue({ sipaAddress: OLD })
      await expect(restart()).rejects.toThrow(
        reason === "not refunded"
          ? "refund is not complete"
          : reason === "standard quote"
          ? "earned tag price has not been confirmed"
          : "did not produce a new address",
      )
      expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
      expect(h.broadcast).not.toHaveBeenCalled()
    },
  )
})

describe("ticket redemption after registration preflight", () => {
  const ticket = {
    fragment: "ticket-link",
    schedule: { fee: "500000000000000000", minDeposit: "0" },
  }
  const register = () =>
    claimTag("demo", keys, h.config, {} as never, undefined, false, undefined, undefined, ticket)

  it("does not redeem when the account already owns another tag", async () => {
    h.heldName.mockResolvedValue(HASH)
    await expect(register()).rejects.toThrow("this passkey already claimed another tag")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })

  it("does not redeem when the requested tag already belongs to another account", async () => {
    h.registeredOwner.mockResolvedValue(NEW)
    await expect(register()).rejects.toThrow("@demo is already taken")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("does not redeem again when this account already registered the requested tag", async () => {
    h.registeredOwner.mockResolvedValue(OWNER)
    await expect(register()).resolves.toMatchObject({ kind: "custody", confirmed: true })
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("leaves the ticket untouched when the account's registered name cannot be read", async () => {
    h.heldName.mockRejectedValue(new Error("L1 unavailable"))
    await expect(register()).rejects.toThrow("L1 unavailable")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("does not request paid terms when redemption fails", async () => {
    h.redeem.mockRejectedValueOnce(new Error("ticket_spent"))
    await expect(register()).rejects.toThrow("ticket_spent")
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })

  it("preserves the paused-ticket outcome so the wizard can explain the paid quote", async () => {
    h.redeem.mockResolvedValue({ status: "unavailable" })
    await expect(register()).resolves.toMatchObject({ kind: "pending", ticketUnavailable: true })
    expect(h.sign).toHaveBeenCalledTimes(1)
  })

  /** The tab dies right after the checkpoint: the consent read that follows it never answers. */
  const closeTabAfterCheckpoint = () =>
    h.metadataRegistry.mockRejectedValueOnce(new Error("tab closed after the checkpoint"))

  it("keeps the link on the checkpoint, so a reopen resumes without another proof or claim", async () => {
    h.sign.mockResolvedValue(nameClaim({ terms: earnedTerms({ ticket: true }) }))
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow("tab closed after the checkpoint")
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect(h.sign).toHaveBeenCalledTimes(1)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      phase: "awaiting_deposit",
    })
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:ticket-link",
    })
    // What the reopened wizard resumes by, pinned to the account the ticket bound.
    expect(ticketSignupRegistration("ticket-link", L2)?.account).toBe(OWNER)
    expect(ticketSignupRegistration("ticket-link", `0x${"99".repeat(32)}`)).toBeNull()
  })

  it("binds no link to a checkpoint whose quote does not honour the ticket", async () => {
    h.redeem.mockResolvedValue({ status: "unavailable" })
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow("tab closed after the checkpoint")
    expect(getPendingStore().get(OWNER)).toMatchObject({ sipaAddress: NEW })
    expect(loadRegistrationTerms(OWNER, "demo")).not.toHaveProperty("paylinkId")
    expect(ticketSignupRegistration("ticket-link", L2)).toBeNull()
  })
})

describe("a link with no ticket for this signup, which pays the name's own deposit", () => {
  const LINK = "deposit-link"
  beforeEach(() => {
    sessionStorage.clear()
    stashClaimLink(LINK)
  })
  /** A random tag's claim with the link's note and committed tip handed in. */
  const register = (amount: bigint, proverTip = 0n, earned = true) =>
    claimTag("demo", keys, h.config, {} as never, undefined, earned, undefined, undefined, null, {
      fragment: LINK,
      amount,
      proverTip,
      speed: "faster",
    })
  /** What the claim burns for the random tag's signed deposit at a zero executor fee. */
  const burn = (proverTip: bigint) => goldenTicketBurn(RANDOM, proverTip, 0n).burn

  it("binds the registration to the link, with its tip, when the note covers the signed deposit", async () => {
    const outcome = await register(20n * DAI, DAI / 10n)
    expect(outcome).toMatchObject({ kind: "pending", depositLink: { fragment: LINK } })
    expect(h.redeem).not.toHaveBeenCalled()
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      paylinkFunded: true,
      paylinkDeposit: true,
      paylinkId: `id:${LINK}`,
      proverTip: String(DAI / 10n),
      speed: "faster",
    })
    // Home's claim of the link pays the registration.
    expect(ticketSignupContinuation(LINK, L2, [])?.activation.state).toBe("ready")
  })

  it.each([
    ["covers the deposit but not the tip", () => register(burn(DAI / 10n), DAI / 10n)],
    [
      "is priced while the executor fee is unread",
      () => {
        h.sign.mockResolvedValue(standardClaim())
        h.withdrawalFee.mockRejectedValue(new Error("rpc down"))
        return register(20n * DAI, 0n, false)
      },
    ],
  ])("leaves the registration on its own deposit when the note %s", async (_, run) => {
    const outcome = await run()
    expect(outcome).toMatchObject({ kind: "pending" })
    expect(outcome).not.toHaveProperty("depositLink")
    expect(loadRegistrationTerms(OWNER, "demo")).not.toHaveProperty("paylinkId")
    expect(ticketSignupContinuation(LINK, L2, [])).toBeNull()
  })
})

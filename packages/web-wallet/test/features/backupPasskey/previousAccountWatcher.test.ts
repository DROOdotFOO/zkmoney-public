/**
 * The page's watcher of a rotated wallet's previous one-key account: what it finds and registers
 * per session, when its claims passes and balance reads run, how it keeps the watch, and how it
 * settles and runs the move with one signature per chunk.
 */
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import {
  PreviousAccountWatchStore,
  WATCH_WINDOW_MS,
  type PreviousAccountWatch,
} from "@obsidion/front-core"
import {
  ContractService,
  ObsidionAccount,
  WebAuthnAlphaAuthProvider,
  type AlphaAuthProvider,
  type TxHashCallback,
} from "@obsidion/sdk"
import type { PreviousAccountState } from "../../../src/features/backupPasskey/previousAccountWatcher"

const h = vi.hoisted(() => {
  class MemoryStorage {
    map = new Map<string, string>()
    async getItem(key: string) {
      return this.map.get(key) ?? null
    }
    async setItem(key: string, value: string) {
      this.map.set(key, value)
    }
    async removeItem(key: string) {
      this.map.delete(key)
    }
    async clear() {
      this.map.clear()
    }
  }
  return {
    storage: new MemoryStorage(),
    now: 0,
    auth: {} as Record<string, unknown>,
    providerFor: vi.fn(),
    unlocked: undefined as unknown,
    record: undefined as unknown,
    boot: Promise.resolve() as Promise<void>,
    gateway: {
      syncRecipient: vi.fn(),
      records: vi.fn((): unknown[] => []),
    },
    balance: 0n,
    txStatus: "pending" as string,
    signGate: undefined as Promise<void> | undefined,
    tokenService: {} as Record<string, ReturnType<typeof vi.fn>>,
    sponsor: vi.fn(),
    identity: vi.fn(),
    shape: vi.fn(),
    refuel: vi.fn(),
    l2TokenService: vi.fn(),
    feeTuple: {} as Record<string, string>,
    /** The open session's activity rows; none open while `noSession`. */
    rows: [] as unknown[],
    noSession: false,
    /** Manifest reads left to fail. */
    tupleFailures: 0,
    pinnedTuple: {} as Record<string, string>,
    wallet: undefined as unknown,
  }
})

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.auth }))
vi.mock("../../../src/platform/session", async () => {
  const { fixed } = await import("@obsidion/front-core")
  return {
    // The page's wallet, as the mount reads it.
    useSession: () => ({ wallet: fixed("wallet", h.wallet) }),
    openedSession: {
      get: () =>
        h.noSession
          ? null
          : {
              milestones: { after: () => h.boot.then(() => true) },
              activity: {
                query: () => ({
                  get: () => ({ records: h.rows, loaded: true, failed: false }),
                  subscribe: () => () => {},
                }),
              },
            },
      subscribe: () => () => {},
    },
  }
})
vi.mock("../../../src/platform/storage/WebStorageAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/storage/WebStorageAdapter")>()),
  webStorage: h.storage,
}))
vi.mock("../../../src/features/onboarding/registrationResume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/registrationResume")>()),
  unlockedSessionKeys: async () => h.unlocked,
}))
vi.mock("../../../src/features/deposit/sipaGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/deposit/sipaGateway")>()),
  getSipaDepositGateway: () => h.gateway,
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getFeeTokenBridgeTuple: async () => {
    if (h.tupleFailures > 0) {
      h.tupleFailures -= 1
      throw new Error("manifest unreadable")
    }
    return h.feeTuple
  },
  getOxideTuple: async () => h.pinnedTuple,
}))
vi.mock("../../../src/config/classArtifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/classArtifacts")>()),
  getWebOxideToken: async () => ({ token: true }),
}))
vi.mock("../../../src/features/token/l2TokenService", () => ({ l2TokenService: h.l2TokenService }))
vi.mock("../../../src/features/token/oxideToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/token/oxideToken")>()),
  currentTxAmountCap: async () => 10n ** 19n,
  teeSignerOfToken: async () => ({ signer: true }),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/claimSponsorship")>()),
  claimSponsorContext: h.sponsor,
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: h.refuel }))
vi.mock("../../../src/features/onboarding/oxideGenerations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/oxideGenerations")>()),
  loadOxideGenerations: async () => ({
    rollupVersion: "7",
    admissibleRollupVersions: new Set(["6", "7"]),
  }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readSpendShape: h.shape,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  resolveOxideIdentity: h.identity,
}))

const { getPreviousAccountWatcher, PREVIOUS_PASS_MS, resetPreviousAccountWatcherForTests } =
  await import("../../../src/features/backupPasskey/previousAccountWatcher")
const { PreviousAccountWatchMount } = await import(
  "../../../src/features/backupPasskey/PreviousAccountWatchMount"
)

const ROOT = "aa".repeat(64)
const BACKUP = "bb".repeat(64)
const SESSION = AztecAddress.fromStringUnsafe(`0x${"0e".repeat(32)}`)
const PREVIOUS = AztecAddress.fromStringUnsafe(`0x${"0d".repeat(32)}`)
const PREVIOUS_KEY = PREVIOUS.toString()
const ELSEWHERE = AztecAddress.fromStringUnsafe(`0x${"0c".repeat(32)}`)
const MSK = new Fr(0x5e55n)
const HASH = `0x${"0a".repeat(32)}`
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000
const FEE_TOKEN = "0x00000000000000000000000000000000000000d1"
const ONE = 10n ** 18n
const DUST = 10n ** 16n

const keyProvider = (key: string) =>
  ({
    getPubkeys: async () => [
      Buffer.from(key.slice(0, 64), "hex"),
      Buffer.from(key.slice(64), "hex"),
    ],
  } as unknown as AlphaAuthProvider)

const rootRecord = (over: Record<string, unknown> = {}) => ({
  credentialId: "cred-root",
  l2Address: SESSION.toString(),
  pubkey: ROOT,
  isMskRoot: true,
  createdAt: 1,
  passkeySet: [ROOT, BACKUP],
  ...over,
})

const backupRecord = () =>
  rootRecord({
    credentialId: "cred-backup",
    pubkey: BACKUP,
    isMskRoot: false,
    backup: { envelopeHex: "01".repeat(62) },
  })

/** The session as the auth service hands it out: one signer object per session. */
function signIn(key: string, record: unknown = key === ROOT ? rootRecord() : backupRecord()) {
  h.record = record
  h.unlocked = {
    account: { getAddress: () => SESSION },
    secretKey: MSK,
    authProvider: keyProvider(key),
    pubkeyHex: `0x${key}`,
  }
}

/** The PXE side: one account per address, signed for by the newest registration's provider. */
function fakeWallet() {
  const previousAccount: ObsidionAccount = Object.assign(Object.create(ObsidionAccount.prototype), {
    getAddress: () => PREVIOUS,
  })
  const created: AlphaAuthProvider[] = []
  let signer: AlphaAuthProvider | undefined
  let held = false
  const wallet = {
    node: {
      getTxReceipt: vi.fn(async () => ({
        status: h.txStatus,
        executionResult: TxExecutionResult.SUCCESS,
      })),
      getBlockData: async () => ({
        header: { globalVariables: { timestamp: BigInt(Math.floor(Date.now() / 1000)) } },
      }),
    },
    deriveAccountAddress: vi.fn(async (_msk: unknown, keys: readonly string[]) => {
      if (keys.length === 2) return SESSION
      return keys[0] === ROOT ? PREVIOUS : ELSEWHERE
    }),
    getAccountFromAddress: async (at: AztecAddress) => {
      if (!held || !at.equals(PREVIOUS)) throw new Error("Account not found")
      return previousAccount
    },
    createObsidionAccount: vi.fn(async (_msk: unknown, provider: AlphaAuthProvider) => {
      created.push(provider)
      signer = provider
      held = true
      return previousAccount
    }),
  }
  h.wallet = wallet
  return {
    wallet: wallet as never,
    derive: wallet.deriveAccountAddress,
    receipts: wallet.node.getTxReceipt,
    previousAccount,
    created,
    signer: () => signer,
    /** An earlier session left the account registered under `provider`. */
    leftWith: (provider: AlphaAuthProvider) => {
      signer = provider
      held = true
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const idle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const store = () => PreviousAccountWatchStore.get(h.storage as never)
const watchOf = () => store().get(PREVIOUS_KEY)
const seed = (watch: Omit<PreviousAccountWatch, "address">) =>
  store().update(PREVIOUS_KEY, () => ({ address: PREVIOUS_KEY, ...watch }))
/** A chunk a run saved before the page reloaded. */
const storedChunk = {
  source: PREVIOUS_KEY,
  destination: SESSION.toString(),
  txHash: HASH as `0x${string}`,
  expiresAtMs: T0 + 60 * 60_000,
  amount: (2n * ONE).toString(),
}

let unmount: (() => void) | undefined

beforeEach(() => {
  h.now = T0
  vi.spyOn(Date, "now").mockImplementation(() => h.now)
  h.storage.map.clear()
  PreviousAccountWatchStore.resetForTests()
  resetPreviousAccountWatcherForTests()
  h.boot = Promise.resolve()
  h.balance = 0n
  h.txStatus = TxStatus.PENDING
  h.signGate = undefined
  h.feeTuple = {
    portal: "0x00000000000000000000000000000000000000a0",
    token: FEE_TOKEN,
    l2Token: `0x${"01".repeat(32)}`,
  }
  h.pinnedTuple = { ...h.feeTuple }
  h.rows = []
  h.noSession = false
  h.tupleFailures = 0
  h.auth = {
    sessionKeys: async () =>
      h.unlocked && {
        secretKey: MSK,
        authProvider: (h.unlocked as { authProvider: unknown }).authProvider,
      },
    accountRecord: vi.fn(async () => h.record),
    providerFor: h.providerFor,
    recordFeePayer: async () => undefined,
  }
  h.providerFor
    .mockReset()
    .mockImplementation((p: { pubkeyHex: string }) => keyProvider(p.pubkeyHex))
  h.unlocked = undefined
  h.gateway.syncRecipient.mockReset().mockResolvedValue({ completed: true })
  h.gateway.records.mockReset().mockReturnValue([])
  h.tokenService = {
    getBalance: vi.fn(async () => h.balance),
    fetchTokenInformation: vi.fn(async () => ({ decimals: 18 })),
    setTeeSigner: vi.fn(),
    sendTokenSponsored: vi.fn(
      async (
        _to: unknown,
        amount: string,
        _sponsor: unknown,
        opts: { onTxHash: TxHashCallback; signal?: AbortSignal },
      ) => {
        await h.signGate
        opts.signal?.throwIfAborted()
        await opts.onTxHash(HASH, { expiresAtMs: Date.now() + 60_000 })
        h.balance -= BigInt(amount)
        h.txStatus = TxStatus.FINALIZED
      },
    ),
  }
  h.l2TokenService.mockReset().mockImplementation(async () => h.tokenService)
  h.sponsor.mockReset().mockResolvedValue({ fpcAddress: "fpc", fpcArtifact: { artifact: true } })
  h.identity.mockReset().mockResolvedValue({ kind: "verified", identity: {} })
  h.shape.mockReset().mockImplementation(async () => ({
    notes: h.balance > 0n ? [h.balance] : [],
    depositTotal: 0n,
    balance: h.balance,
  }))
  h.refuel.mockReset()
  vi.spyOn(ContractService, "getInstance").mockReturnValue({ contracts: true } as never)
})

afterEach(async () => {
  unmount?.()
  unmount = undefined
  // Work a test left running ends on its own fakes, not the next test's.
  await idle()
  resetPreviousAccountWatcherForTests()
  vi.restoreAllMocks()
})

describe("finding and registering the previous account", () => {
  it("registers it with a provider that refuses to sign on a session signed with the backup passkey", async () => {
    const pxe = fakeWallet()
    signIn(BACKUP)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)

    await vi.waitFor(() => expect(pxe.created).toHaveLength(1))
    expect(h.providerFor).not.toHaveBeenCalled()
    const [refusing] = pxe.created as WebAuthnAlphaAuthProvider[]
    expect(refusing).toBeInstanceOf(WebAuthnAlphaAuthProvider)
    await expect(refusing!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
    expect(watcher.getSnapshot()).toMatchObject({ address: PREVIOUS_KEY, signs: false, open: true })
  })

  it("finds nothing while the wallet is locked", async () => {
    const pxe = fakeWallet()
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await idle()

    expect(watcher.getSnapshot()).toEqual({ signs: false, open: false, moving: false })
    expect(pxe.derive).not.toHaveBeenCalled()
    expect(pxe.created).toHaveLength(0)
    expect(h.gateway.syncRecipient).not.toHaveBeenCalled()
  })

  it("searches again on the next tick after two failed searches, leaving no rejection unhandled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      h.tupleFailures = 2
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      watcher.start(pxe.wallet)
      await idle()
      expect(h.tupleFailures).toBe(0)
      expect(watcher.getSnapshot().address).toBeUndefined()

      await watcher.tick()
      await vi.waitFor(() => expect(watcher.getSnapshot().address).toBe(PREVIOUS_KEY))
      await idle()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("starts over under a new session, keeping the line's account and amount while it searches", async () => {
    h.balance = ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() =>
      expect(watcher.getSnapshot()).toMatchObject({ signs: true, amount: ONE }),
    )

    const seen: PreviousAccountState[] = []
    const off = watcher.subscribe(() => seen.push(watcher.getSnapshot()))
    signIn(BACKUP)
    await watcher.tick()
    await vi.waitFor(() =>
      expect(watcher.getSnapshot()).toMatchObject({ address: PREVIOUS_KEY, signs: false }),
    )
    off()

    expect(seen.length).toBeGreaterThan(0)
    for (const state of seen) expect(state).toMatchObject({ address: PREVIOUS_KEY, amount: ONE })
  })

  it("clears the line when the new session has no previous account", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().address).toBe(PREVIOUS_KEY))

    signIn(ROOT, rootRecord({ passkeySet: undefined }))
    await watcher.tick()
    await vi.waitFor(() =>
      expect(watcher.getSnapshot()).toEqual({ signs: false, open: false, moving: false }),
    )
  })

  it("warns once when the deposit bridge is not the fee token's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    h.pinnedTuple = { ...h.feeTuple, portal: "0x00000000000000000000000000000000000000b0" }
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().address).toBe(PREVIOUS_KEY))
    watcher.stop()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().address).toBe(PREVIOUS_KEY))

    const bridgeWarnings = warn.mock.calls.filter(([line]) =>
      String(line).includes("only the fee token is watched"),
    )
    expect(bridgeWarnings).toHaveLength(1)
  })
})

describe("the previous account's passes", () => {
  it("runs none before boot releases deposits, then one per pass interval with its slot reserved before it queues", async () => {
    const boot = deferred()
    h.boot = boot.promise
    const pass = deferred<{ completed: boolean }>()
    h.gateway.syncRecipient.mockReturnValueOnce(pass.promise)
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await idle()
    expect(await watchOf()).not.toBeNull()
    expect(h.gateway.syncRecipient).not.toHaveBeenCalled()
    expect(pxe.created).toHaveLength(0)

    boot.resolve()
    await vi.waitFor(() => expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(1))
    const [wallet, recipient, tokenServiceFor] = h.gateway.syncRecipient.mock.calls[0]!
    expect(wallet).toBe(pxe.wallet)
    expect(String(recipient)).toBe(PREVIOUS_KEY)
    await tokenServiceFor("0xtoken")
    expect(h.l2TokenService).toHaveBeenLastCalledWith(pxe.wallet, pxe.previousAccount, "0xtoken")

    await Promise.all([watcher.tick(), watcher.tick()])
    pass.resolve({ completed: true })
    await idle()
    h.now = T0 + PREVIOUS_PASS_MS - 1
    await watcher.tick()
    expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(1)

    h.now = T0 + PREVIOUS_PASS_MS
    await watcher.tick()
    expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(2)
  })

  it("reads the balance after each pass and publishes it", async () => {
    h.balance = 3n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)

    await vi.waitFor(() =>
      expect(watcher.getSnapshot()).toMatchObject({ amount: 3n * ONE, dust: DUST }),
    )
    expect(h.tokenService.getBalance).toHaveBeenCalledTimes(1)
    expect((await watchOf())?.watchUntilMs).toBe(T0 + WATCH_WINDOW_MS)
  })

  it("keeps the watch open past its window while a pass falls short", async () => {
    await seed({ watchUntilMs: T0 - 1 })
    h.gateway.syncRecipient.mockResolvedValue({ completed: false })
    const pxe = fakeWallet()
    signIn(ROOT)
    getPreviousAccountWatcher().start(pxe.wallet)

    await vi.waitFor(() => expect(h.tokenService.getBalance).toHaveBeenCalled())
    await idle()
    expect(await watchOf()).toEqual({ address: PREVIOUS_KEY, watchUntilMs: T0 - 1 })
  })

  it("keeps the watch open past its window while a refund of a link the previous account made is on its way", async () => {
    await seed({ watchUntilMs: T0 - 1 })
    h.rows = [
      {
        kind: "paylink",
        action: PaylinkActionEnum.PAY,
        emailPaymentAction: PaylinkActionEnum.PAY,
        flavor: "direct",
        status: "success",
        txHash: `0x${"45".repeat(32)}`,
        timestamp: 1,
        obsidionAccountAddress: PREVIOUS_KEY,
        refundTxHash: `0x${"44".repeat(32)}`,
        isRefunded: false,
      },
    ]
    const pxe = fakeWallet()
    signIn(ROOT)
    getPreviousAccountWatcher().start(pxe.wallet)

    await vi.waitFor(async () => expect((await watchOf())?.watchUntilMs).toBe(T0 + WATCH_WINDOW_MS))
    expect((await watchOf())?.closed).toBeUndefined()
  })

  it("keeps the watch open past its window while no session's paylink rows can be read", async () => {
    await seed({ watchUntilMs: T0 - 1 })
    h.noSession = true
    const pxe = fakeWallet()
    signIn(ROOT)
    getPreviousAccountWatcher().start(pxe.wallet)

    await vi.waitFor(() => expect(h.tokenService.getBalance).toHaveBeenCalled())
    await idle()
    expect((await watchOf())?.closed).toBeUndefined()
  })

  it("holds the watch for a deposit to the previous account still holding money, and not for another account's", async () => {
    await seed({ watchUntilMs: T0 - 1 })
    const deposit = (recipient: string) => ({
      sipaAddress: "0x00000000000000000000000000000000000000e1",
      phase: "pendingClaim",
      recipientL2Address: recipient,
      tokenAddress: FEE_TOKEN,
    })
    h.gateway.records.mockReturnValue([deposit(PREVIOUS_KEY)])
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(async () => expect((await watchOf())?.watchUntilMs).toBe(T0 + WATCH_WINDOW_MS))

    h.gateway.records.mockReturnValue([deposit(SESSION.toString())])
    h.now = T0 + WATCH_WINDOW_MS + PREVIOUS_PASS_MS
    await watcher.tick()
    expect((await watchOf())?.closed).toBe(true)
  })

  it("retries a closed watch's check at the open cadence when its registration throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await seed({ watchUntilMs: T0 - 3 * DAY, closed: true, lastCheckAtMs: T0 - 2 * DAY })
    h.l2TokenService.mockRejectedValueOnce(new Error("token unreadable"))
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await idle()
    expect(h.gateway.syncRecipient).not.toHaveBeenCalled()

    await watcher.tick()
    expect(h.gateway.syncRecipient).not.toHaveBeenCalled()
    h.now = T0 + PREVIOUS_PASS_MS
    await watcher.tick()
    await vi.waitFor(async () =>
      expect((await watchOf())?.lastCheckAtMs).toBe(T0 + PREVIOUS_PASS_MS),
    )
    expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(1)
  })

  it("checks a closed watch again at the open cadence when a session change cuts its pass short", async () => {
    await seed({ watchUntilMs: T0 - 3 * DAY, closed: true, lastCheckAtMs: T0 - 2 * DAY })
    const pass = deferred<{ completed: boolean }>()
    h.gateway.syncRecipient.mockReturnValueOnce(pass.promise)
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(1))

    signIn(ROOT)
    await watcher.tick()
    pass.resolve({ completed: true })
    await idle()
    expect((await watchOf())?.lastCheckAtMs).toBe(T0 - 2 * DAY)

    h.now = T0 + PREVIOUS_PASS_MS
    await watcher.tick()
    await vi.waitFor(async () =>
      expect((await watchOf())?.lastCheckAtMs).toBe(T0 + PREVIOUS_PASS_MS),
    )
    expect(h.gateway.syncRecipient).toHaveBeenCalledTimes(2)
  })
})

describe("settling and moving", () => {
  it("settles a stored chunk from the app mount on a session that opens on Settings, without Home", async () => {
    await seed({ watchUntilMs: T0 + DAY, move: storedChunk })
    h.txStatus = TxStatus.FINALIZED
    fakeWallet()
    signIn(ROOT)
    const root = createRoot(document.createElement("div"))
    await act(async () => root.render(createElement(PreviousAccountWatchMount)))
    unmount = () => act(() => root.unmount())

    await vi.waitFor(async () => expect((await watchOf())?.move).toBeUndefined())
    expect(getPreviousAccountWatcher().getSnapshot()).toMatchObject({
      address: PREVIOUS_KEY,
      moving: false,
    })
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("joins a second move to the one running: one move, one signature, to the session's account", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))

    const first = watcher.move()
    expect(watcher.move()).toBe(first)
    expect(watcher.getSnapshot().moving).toBe(true)

    expect(await first).toEqual({ kind: "done" })
    const send = h.tokenService.sendTokenSponsored
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      SESSION,
      (5n * ONE).toString(),
      await h.sponsor.mock.results[0]!.value,
      {
        userAccount: pxe.previousAccount,
        useRawAmount: true,
        onTxHash: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    )
    expect(h.sponsor).toHaveBeenCalledWith(
      { wallet: pxe.wallet, account: pxe.previousAccount, contractService: { contracts: true } },
      "registered",
    )
    expect(h.tokenService.setTeeSigner).toHaveBeenCalled()
    expect(h.refuel).toHaveBeenCalledTimes(1)
    expect(h.identity).toHaveBeenCalledTimes(1)
    expect(h.identity.mock.calls[0]![0].admissibleRollupVersions).toEqual(new Set(["7"]))
    expect(h.identity.mock.calls[0]![2]).toBe(SESSION.toString())
    expect(h.identity.mock.calls[0]).toHaveLength(3)
    expect((await watchOf())?.move).toBeUndefined()
    await vi.waitFor(() =>
      expect(watcher.getSnapshot()).toMatchObject({
        moving: false,
        amount: 0n,
        lastResult: { kind: "done" },
      }),
    )
  })

  it("checks the destination against the record's set before every chunk, and the L1 record once per move", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))
    pxe.derive.mockClear()

    expect(await watcher.move({ cap: 3n * ONE })).toEqual({ kind: "done" })
    const sent = h.tokenService.sendTokenSponsored.mock.calls.map(([, amount]) => amount)
    expect(sent).toEqual([(3n * ONE).toString(), (2n * ONE).toString()])
    expect(pxe.derive.mock.calls.map(([, keys]) => keys)).toEqual([
      [ROOT, BACKUP],
      [ROOT, BACKUP],
    ])
    expect(h.identity).toHaveBeenCalledTimes(1)
  })

  it("joins a move after a remount before its chunk's hash exists, and asks for no second signature", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))
    const prompt = deferred()
    h.signGate = prompt.promise

    const first = watcher.move()
    await vi.waitFor(() => expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1))
    watcher.stop()
    watcher.start(pxe.wallet)
    expect(watcher.move()).toBe(first)
    await vi.waitFor(() => expect(watcher.getSnapshot().moving).toBe(true))

    prompt.resolve()
    await first
    expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1)
    expect((await watchOf())?.move).toBeUndefined()
  })

  it("waits out a move an earlier session started, then moves for the new session", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))
    const prompt = deferred()
    h.signGate = prompt.promise
    const first = watcher.move()
    await vi.waitFor(() => expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1))

    signIn(ROOT)
    await watcher.tick()
    const second = watcher.move()
    expect(second).not.toBe(first)
    h.signGate = undefined
    prompt.resolve()

    expect(await first).toEqual({ kind: "stopped" })
    expect(await second).toEqual({ kind: "done" })
    expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(watcher.getSnapshot().lastResult).toEqual({ kind: "done" }))
  })

  it("stops a move before its prompt when the caller's signal aborts", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))
    const sponsor = deferred<unknown>()
    h.sponsor.mockReturnValueOnce(sponsor.promise)
    const leave = new AbortController()

    const run = watcher.move({ signal: leave.signal })
    await vi.waitFor(() => expect(h.sponsor).toHaveBeenCalled())
    leave.abort()
    sponsor.resolve({ fpcAddress: "fpc", fpcArtifact: {} })

    expect(await run).toEqual({ kind: "stopped" })
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("stops a move inside its send, before the prompt, when the caller's signal aborts", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))
    const prompt = deferred()
    h.signGate = prompt.promise
    const leave = new AbortController()

    const run = watcher.move({ signal: leave.signal })
    await vi.waitFor(() => expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1))
    leave.abort()
    prompt.resolve()

    expect(await run).toEqual({ kind: "stopped" })
    expect((await watchOf())?.move).toBeUndefined()
    expect(h.balance).toBe(5n * ONE)
  })

  it("refuses before any prompt when the L1 record does not name the session's account", async () => {
    h.balance = 5n * ONE
    h.identity.mockResolvedValue({ kind: "unverified", accounts: [] })
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))

    expect(await watcher.move()).toEqual({
      kind: "refused",
      reason: "destination",
      amount: 5n * ONE,
    })
    expect(h.sponsor).not.toHaveBeenCalled()
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("refuses a chunk cap below 1 without running", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)

    await expect(watcher.move({ cap: 0n })).rejects.toBeInstanceOf(RangeError)
    expect(watcher.getSnapshot().moving).toBe(false)
    expect(h.shape).not.toHaveBeenCalled()
  })

  it("fails a move on a session signed with the backup passkey without asking to sign", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(BACKUP)
    const watcher = getPreviousAccountWatcher()
    watcher.start(pxe.wallet)
    await vi.waitFor(() => expect(watcher.getSnapshot().amount).toBe(5n * ONE))

    const outcome = await watcher.move()
    expect(outcome).toMatchObject({ kind: "failed" })
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })
})

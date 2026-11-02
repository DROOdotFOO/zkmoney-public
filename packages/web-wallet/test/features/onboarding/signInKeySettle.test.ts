// @vitest-environment node
/**
 * A fresh-browser sign-in settles the passkey's public key before the anchors name the master key:
 * from the key the registry-named L1 accounts installed at registration when they name one within
 * the budget, otherwise from the passkey again, behind the gate. The address is derived under the
 * settled key, so under this suite's address-checking anchor a wrong key derives no anchored
 * address. A cancelled attempt stops before the adoption; nothing is written before the key is
 * settled and the anchor named.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import type { AnchorTier, CandidateProbe } from "@obsidion/front-core"
import { PhoneUnreachableError } from "@obsidion/passkey-web"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { BaseError, RpcRequestError, getContractAddress } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  beginRecovery: vi.fn(),
  adoptAccountPasskey: vi.fn(),
  recoverFromCache: vi.fn(),
  commitSecret: vi.fn(async (): Promise<number | false> => 1),
  recordRecoveryMetadata: vi.fn(),
  addWebauthnAccount: vi.fn(),
  readNameOf: vi.fn(),
  /** The installed-key read's name read; the resolver's goes through `identityReader`. */
  installedNameOf: vi.fn(),
  getCode: vi.fn(),
  readAuthKeys: vi.fn(),
  readInstalledPasskeyKey: vi.fn(),
  enterTiers: vi.fn(),
}))

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    rpId: "localhost",
    beginRecovery: h.beginRecovery,
    adoptAccountPasskey: h.adoptAccountPasskey,
    recoverFromCache: h.recoverFromCache,
    commitSecret: h.commitSecret,
    sessionHeld: () => true,
    sessionAddress: async () => undefined,
    markRecordsStale: () => {},
    recordRecoveryMetadata: h.recordRecoveryMetadata,
  }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    accountFactory: `0x${"11".repeat(20)}`,
    registry: `0x${"22".repeat(20)}`,
    ensDomain: "zkmoney.eth",
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/features/onboarding/recoveryProbes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/recoveryProbes")>()),
  enterTiers: h.enterTiers,
}))
const FACTORY = `0x${"11".repeat(20)}` as const
const REGISTRY = `0x${"22".repeat(20)}` as const
const identityReader = {
  readNameOf: (...args: unknown[]) => h.readNameOf(...(args as [])),
  readAccountMetadataRegistry: async () => `0x${"23".repeat(20)}`,
  readUserRecord: async () => ({ l2Address: ADDR, rollupVersion: 1n }),
  readNamePortalRegistry: async () => REGISTRY,
  readFactoryImplementation: async () => getContractAddress({ from: FACTORY, nonce: 1n }),
}
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({
    reader: identityReader,
    registry: REGISTRY,
    rollupVersion: "1",
    catalog: [
      {
        fpcAddress: `0x${"0b".repeat(32)}`,
        accountFactory: FACTORY,
        namePortal: `0x${"11".repeat(19)}ee`,
        rollupVersion: "1",
      },
    ],
  }),
  generationFactories: () => [FACTORY],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/front-core")>()
  // The real selection, spied so a test can see the stop signal the wait handed it.
  h.readInstalledPasskeyKey.mockImplementation(actual.readInstalledPasskeyKey)
  return {
    ...actual,
    AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
    createOxideL1Reader: () => ({
      readNameOf: h.installedNameOf,
      getCode: h.getCode,
      readAuthKeys: h.readAuthKeys,
      readAuthKeysCounted: async (account: string, max: number) => {
        const entries = await h.readAuthKeys(account, max)
        return { entries, authKeyCount: entries.length }
      },
    }),
    readInstalledPasskeyKey: h.readInstalledPasskeyKey,
  }
})

const { enterWithPasskey, reusePasskeyAccount, PasskeyMismatchError } = await import(
  "../../../src/features/onboarding/oxideOnboarding"
)
const { GateCancelledError, isGateCancelled } = await import(
  "../../../src/features/identity/ceremonyGate"
)
const { deriveBootstrapKey } = await import("@obsidion/front-core")

const msk = Fr.random()
const sibling = Fr.random()
const ADDR = `0x${"aa".repeat(32)}`
const REAL = "ab".repeat(64)
const WRONG = "cd".repeat(64)
/** Another key of the real account, in its set beside the passkey's. */
const OTHER = "ef".repeat(64)
const NAME = `0x${"ab".repeat(32)}`
const NAMELESS = `0x${"0".repeat(64)}`
/** The L1 account the installed-key read predicts for a master key under the catalog's factory. */
const accountOf = (candidate: Fr) =>
  predictAccountAddressLocally(FACTORY, deriveBootstrapKey(candidate).address)
const account = {
  getAddress: () => ({ toString: () => ADDR }),
  getCompleteAddress: () => ({ toString: () => `${ADDR}:complete` }),
}
const createObsidionAccount = vi.fn(async () => account)
/** The account address is a function of the master key AND the key set: only a set holding the real key derives it. */
const deriveAccountAddress = vi.fn(async (candidate: Fr, passkeys: readonly string[]) => ({
  toString: () =>
    candidate.toString() === msk.toString() && passkeys.includes(REAL) ? ADDR : "0xother",
}))
const wallet = { deriveAccountAddress, createObsidionAccount } as never
const config = { rpId: "localhost" } as never

const anchoring: CandidateProbe = async (_msk, address) =>
  address === ADDR ? "anchored" : "absent"
const registry: AnchorTier[] = [{ name: "registry", probes: [anchoring] }]

const authKey = (pubkeyHex: string) => ({
  key: { qx: `0x${pubkeyHex.slice(0, 64)}`, qy: `0x${pubkeyHex.slice(64)}` },
  metadata: `0x${"07".repeat(16)}`,
})

/** The real master key's predicted account is named, deployed and holds `pubkeyHex`; the sibling's is nameless. */
function installs(pubkeyHex: string) {
  h.installedNameOf.mockImplementation(async (_registry: string, at: string) =>
    at === accountOf(msk) ? NAME : NAMELESS,
  )
  h.getCode.mockResolvedValue("0x6080")
  h.readAuthKeys.mockResolvedValue([authKey(pubkeyHex)])
}

/** A settled recovery for `pubkey`, as `settle` produces; `passkeys` is the set it was settled with. */
function settled(pubkey: string, passkeys?: readonly string[]): RecoverPasskeyResult {
  return {
    authProvider: {
      getPubkeys: async () => [
        Buffer.from(pubkey.slice(0, 64), "hex"),
        Buffer.from(pubkey.slice(64), "hex"),
      ],
    } as never,
    credentialId: "cred",
    pubkey,
    ...(passkeys ? { passkeys } : {}),
    candidates: { first: msk, second: sibling },
    preferredSlot: "first",
    hasPersistedSlot: false,
    candidateSource: "webauthn",
    authenticatorType: "platform",
  }
}

/** What `beginRecovery` returns on a fresh browser: both keys, and a settle step to spy on. */
function unsettled() {
  const settle = vi.fn(
    async (pubkey?: string, _attempt?: AbortSignal, passkeys?: readonly string[]) => {
      if (pubkey !== undefined && ![REAL, WRONG].includes(pubkey)) {
        throw new Error("That key is not a candidate of this sign-in's signature")
      }
      return settled(pubkey ?? REAL, passkeys)
    },
  )
  return {
    credentialId: "cred",
    candidates: { first: msk, second: sibling },
    preferredSlot: "first" as const,
    expectedAddress: undefined,
    candidateSource: "webauthn" as const,
    authenticatorType: "platform" as const,
    pubkeyCandidates: [REAL, WRONG],
    settle,
  }
}

/** A gate that starts one attempt and answers the "again" call like the real hook. */
function gateFor(again: (signal: AbortSignal) => Promise<void> = async () => {}) {
  const controller = new AbortController()
  const gate = vi.fn(async (options?: { again?: AbortSignal }) => {
    if (options?.again) {
      if (options.again.aborted) throw new GateCancelledError()
      await again(options.again)
      return { signal: options.again, reach: "unknown" as const }
    }
    return { signal: controller.signal, reach: "unknown" as const }
  })
  return { gate, controller }
}

const enter = (
  gate: ReturnType<typeof gateFor>["gate"],
  options: { chooser?: boolean; signal?: AbortSignal; tiers?: AnchorTier[] } = {},
) =>
  enterWithPasskey(wallet, config, undefined, {
    contractService: {} as never,
    gate,
    tiers: options.tiers ?? registry,
    chooser: options.chooser ?? true,
    ...(options.signal ? { signal: options.signal } : {}),
  })

const expectNothingAdopted = () => {
  expect(createObsidionAccount).not.toHaveBeenCalled()
  expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
  expect(h.commitSecret).not.toHaveBeenCalled()
  expect(h.addWebauthnAccount).not.toHaveBeenCalled()
}

/** Every key of the sets the wallet was asked to derive under. */
const keysDerivedUnder = () => new Set(deriveAccountAddress.mock.calls.flatMap(([, keys]) => keys))

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Registration = { listener: unknown; capture: boolean }
const captureOf = (options: unknown) =>
  typeof options === "boolean" ? options : !!(options as { capture?: boolean } | undefined)?.capture

/** The `abort` listeners added to `signal`, and whether each exact one was removed again. */
function listenerLedger(signal: AbortSignal) {
  const added: Registration[] = []
  const removed: Registration[] = []
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") added.push({ listener, capture: captureOf(options) })
    add(type, listener, options)
  })
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort") removed.push({ listener, capture: captureOf(options) })
    remove(type, listener, options)
  })
  const wasRemoved = (r: Registration) =>
    removed.some((x) => x.listener === r.listener && x.capture === r.capture)
  return {
    /** Something listened, and every registration was removed by the same listener and flags. */
    released: () => added.length > 0 && added.every(wasRemoved),
  }
}

/** Lets pending continuations run, including the ones a late RPC answer schedules. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0))

const stopHandedToRead = () => h.readInstalledPasskeyKey.mock.calls.at(-1)?.[2]?.stop as AbortSignal
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  h.recoverFromCache.mockResolvedValue(undefined)
  h.readNameOf.mockReset().mockResolvedValue(NAMELESS)
  h.installedNameOf.mockReset().mockResolvedValue(NAMELESS)
  h.getCode.mockReset().mockResolvedValue(undefined)
  h.readAuthKeys.mockReset().mockResolvedValue([])
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  warn.mockRestore()
})

describe("enterWithPasskey settles the key from the L1 accounts", () => {
  it("plain entry, key installed: one gate, one prompt, adopted with that key", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4) Mobile" })
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    installs(REAL)
    const { gate } = gateFor()
    const result = await enter(gate, { chooser: false })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(h.beginRecovery).toHaveBeenCalledWith({
      credentialId: undefined,
      signal: expect.anything(),
    })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(begun.settle).toHaveBeenCalledWith(REAL, undefined, [REAL])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: REAL,
        passkeySet: [REAL],
        l2Address: ADDR,
        isMskRoot: true,
      }),
      expect.any(Function),
    )
    expect(h.recordRecoveryMetadata.mock.calls[0]![0]).not.toHaveProperty("backup")
    expect(h.commitSecret).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: msk }),
      expect.any(Function),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("with no tiers given, the anchors are the sign-in's own, claim ledger included", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    installs(REAL)
    h.enterTiers.mockReturnValue(registry)
    const { gate } = gateFor()
    await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      chooser: true,
    })
    expect(h.enterTiers).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ rollupVersion: "1" }),
      undefined,
      expect.any(Function),
    )
  })

  it("no named account on L1: the passkey is asked again behind the gate, then the anchors decide", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    // Code and keys at the predicted address mean nothing while the registry names no one there.
    h.getCode.mockResolvedValue("0x6080")
    h.readAuthKeys.mockResolvedValue([authKey(REAL)])
    const { gate, controller } = gateFor()
    const order: string[] = []
    begun.settle.mockImplementation(async () => {
      order.push("settle")
      return settled(REAL)
    })
    deriveAccountAddress.mockImplementationOnce(async (candidate, [key]) => {
      order.push("derive")
      return { toString: () => (candidate.equals(msk) && key === REAL ? ADDR : "0xother") }
    })
    const result = await enter(gate)
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(gate).toHaveBeenLastCalledWith({ again: controller.signal })
    expect(begun.settle).toHaveBeenCalledWith(undefined, controller.signal)
    expect(h.getCode).not.toHaveBeenCalled()
    expect(h.readAuthKeys).not.toHaveBeenCalled()
    expect(order.slice(0, 2)).toEqual(["settle", "derive"])
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it("an account holding neither possible key: asked again", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    installs("ef".repeat(64))
    const { gate } = gateFor()
    await enter(gate)
    expect(gate).toHaveBeenCalledTimes(2)
    expect(begun.settle).toHaveBeenCalledWith(undefined, expect.anything())
  })

  it("two accounts holding the key with different sets: ambiguous, no second prompt, nothing written", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    h.installedNameOf.mockResolvedValue(NAME)
    h.getCode.mockResolvedValue("0x6080")
    h.readAuthKeys.mockImplementation(async (at: string) =>
      at === accountOf(msk) ? [authKey(REAL)] : [authKey(REAL), authKey("ef".repeat(64))],
    )
    const { gate } = gateFor()
    await expect(enter(gate)).rejects.toMatchObject({ name: "AmbiguousPasskeyError" })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(begun.settle).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a holding account with more keys than the read returned: set unread, no second prompt, nothing written", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    installs(REAL)
    h.readInstalledPasskeyKey.mockResolvedValueOnce({ kind: "incomplete" })
    const { gate } = gateFor()
    await expect(enter(gate)).rejects.toMatchObject({ name: "PasskeySetUnreadError" })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(begun.settle).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a two-key account settles with the matched key in one prompt, and derives under both keys", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    installs(REAL)
    h.readAuthKeys.mockResolvedValue([authKey(OTHER), authKey(REAL)])
    const { gate } = gateFor()
    await enter(gate)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(begun.settle).toHaveBeenCalledWith(REAL, undefined, [OTHER, REAL])
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, [OTHER, REAL])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: REAL, passkeySet: [OTHER, REAL], isMskRoot: true }),
      expect.any(Function),
    )
  })

  it("the L1 read's key derives no anchored address: unknown, nothing adopted, no second prompt", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    installs(WRONG)
    const { gate } = gateFor()
    const result = await enter(gate)
    expect(result).toMatchObject({ entered: false, reason: "unknown" })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(keysDerivedUnder()).toEqual(new Set([WRONG]))
    expect(h.readNameOf).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a failed read falls back, and the warning carries no error text", async () => {
    const secretUrl = "https://rpc.example/v2/SECRETKEY123"
    const inMessage = new RpcRequestError({
      body: { method: "eth_getCode" },
      error: { code: -32000, message: "rate limited" },
      url: secretUrl,
    })
    const inShortMessage = new BaseError(`rate limited at ${secretUrl}`)
    expect(inMessage.message).toContain("SECRETKEY123")
    expect(inShortMessage.shortMessage).toContain("SECRETKEY123")
    for (const failure of [inMessage, inShortMessage]) {
      vi.clearAllMocks()
      h.beginRecovery.mockResolvedValue(unsettled())
      h.installedNameOf.mockResolvedValue(NAME)
      h.getCode.mockRejectedValue(failure)
      const { gate } = gateFor()
      const result = await enter(gate)
      expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
      expect(gate).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain("read-failed")
      expect(logged).toContain(failure.name)
      expect(logged).not.toContain("SECRETKEY123")
    }
  })

  it("a read that outlasts the budget falls back; its late answer changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const code = deferred<string>()
    h.installedNameOf.mockResolvedValue(NAME)
    h.getCode.mockReturnValue(code.promise)
    h.readAuthKeys.mockResolvedValue([authKey(REAL)])
    const { gate } = gateFor()
    const entering = enter(gate)
    await vi.waitFor(() => expect(h.getCode).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(entering).resolves.toMatchObject({ reason: "unclaimed" })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).toContain("timeout")

    code.resolve("0x6080")
    await vi.advanceTimersByTimeAsync(0)
    expect(h.readAuthKeys).not.toHaveBeenCalled()
    expect(gate).toHaveBeenCalledTimes(2)
    expect(begun.settle).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("a passkey no anchor names costs the second prompt and adopts nothing", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate } = gateFor()
    const result = await enter(gate, { tiers: [] })
    expect(result).toMatchObject({ entered: false, reason: "unknown" })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(begun.settle).toHaveBeenCalledTimes(1)
    expectNothingAdopted()
  })

  it("a sibling still being named when the other read fails starts nothing more", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const siblingName = deferred<string>()
    h.installedNameOf.mockImplementation(async (_registry: string, at: string) =>
      at === accountOf(msk) ? NAME : siblingName.promise,
    )
    h.getCode.mockRejectedValue(new Error("RPC down"))
    const { gate } = gateFor()
    await expect(enter(gate)).resolves.toMatchObject({ reason: "unclaimed" })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(stopHandedToRead().aborted).toBe(true)

    siblingName.resolve(NAME)
    await drain()
    expect(h.getCode).toHaveBeenCalledTimes(1)
    expect(h.readAuthKeys).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe("the bounded wait cleans up whatever ends it", () => {
  const cases: {
    name: string
    arrange: (controller: AbortController, op: AbortController) => void
    settles: boolean
  }[] = [
    { name: "key found", arrange: () => installs(REAL), settles: true },
    {
      name: "read failure",
      arrange: () => h.installedNameOf.mockRejectedValue(new Error("RPC down")),
      settles: true,
    },
    {
      name: "attempt cancel",
      arrange: (controller) =>
        h.installedNameOf.mockImplementation(() => {
          controller.abort()
          return new Promise(() => {})
        }),
      settles: false,
    },
    {
      name: "operation cancel",
      arrange: (_controller, op) =>
        h.installedNameOf.mockImplementation(() => {
          op.abort()
          return new Promise(() => {})
        }),
      settles: false,
    },
  ]

  for (const { name, arrange, settles } of cases) {
    it(`${name}: no timer, no listener, stop signal aborted`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      h.beginRecovery.mockResolvedValue(unsettled())
      const { gate, controller } = gateFor()
      const op = new AbortController()
      const attemptListeners = listenerLedger(controller.signal)
      const opListeners = listenerLedger(op.signal)
      arrange(controller, op)
      const entering = enter(gate, { signal: op.signal })
      if (settles) await expect(entering).resolves.toBeDefined()
      else await expect(entering).rejects.toSatisfy(isGateCancelled)
      expect(vi.getTimerCount()).toBe(0)
      expect(attemptListeners.released()).toBe(true)
      expect(opListeners.released()).toBe(true)
      expect(stopHandedToRead().aborted).toBe(true)
    })
  }

  it("timeout: no timer, no listener, stop signal aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    h.beginRecovery.mockResolvedValue(unsettled())
    h.installedNameOf.mockReturnValue(new Promise(() => {}))
    const { gate, controller } = gateFor()
    const op = new AbortController()
    const attemptListeners = listenerLedger(controller.signal)
    const opListeners = listenerLedger(op.signal)
    const entering = enter(gate, { signal: op.signal })
    await vi.waitFor(() => expect(h.installedNameOf).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(entering).resolves.toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(attemptListeners.released()).toBe(true)
    expect(opListeners.released()).toBe(true)
    expect(stopHandedToRead().aborted).toBe(true)
  })
})

describe("a key read still running when the wait ends", () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  beforeEach(() => {
    unhandled.length = 0
    process.on("unhandledRejection", onUnhandled)
  })
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled)
  })

  /** The named, deployed account's key read hangs until the test answers it. */
  function pendingKeyRead() {
    const keys = deferred<ReturnType<typeof authKey>[]>()
    h.installedNameOf.mockResolvedValue(NAME)
    h.getCode.mockResolvedValue("0x6080")
    h.readAuthKeys.mockReturnValue(keys.promise)
    return keys
  }

  const counts = (
    begun: ReturnType<typeof unsettled>,
    gate: ReturnType<typeof gateFor>["gate"],
  ) => ({
    gates: gate.mock.calls.length,
    settles: begun.settle.mock.calls.length,
    commits: h.commitSecret.mock.calls.length,
    adoptions: createObsidionAccount.mock.calls.length,
    records: h.recordRecoveryMetadata.mock.calls.length,
    warnings: warn.mock.calls.length,
  })

  for (const late of ["an RPC error"]) {
    it(`timeout, then ${late}: the fallback's outcome stands`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const begun = unsettled()
      h.beginRecovery.mockResolvedValue(begun)
      const keys = pendingKeyRead()
      const { gate } = gateFor()
      const entering = enter(gate)
      await vi.waitFor(() => expect(h.readAuthKeys).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(entering).resolves.toMatchObject({ reason: "unclaimed" })
      expect(begun.settle).toHaveBeenCalledWith(undefined, expect.anything())
      const before = counts(begun, gate)

      if (late === "the real key") keys.resolve([authKey(REAL)])
      else keys.reject(new Error("RPC down"))
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
      await drain()
      expect(counts(begun, gate)).toEqual(before)
      expect(unhandled).toEqual([])
    })

    it(`cancel, then ${late}: nothing settled or written, and a retry enters with one prompt`, async () => {
      const stale = unsettled()
      const fresh = unsettled()
      h.beginRecovery.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh)
      const keys = pendingKeyRead()
      const first = gateFor()
      const entering = enter(first.gate)
      await vi.waitFor(() => expect(h.readAuthKeys).toHaveBeenCalled())
      first.controller.abort()
      await expect(entering).rejects.toSatisfy(isGateCancelled)

      if (late === "the real key") keys.resolve([authKey(REAL)])
      else keys.reject(new Error("RPC down"))
      await drain()
      expect(stale.settle).not.toHaveBeenCalled()
      expectNothingAdopted()
      expect(warn).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])

      h.readAuthKeys.mockResolvedValue([authKey(REAL)])
      const second = gateFor()
      await expect(enter(second.gate)).resolves.toMatchObject({ reason: "unclaimed" })
      expect(second.gate).toHaveBeenCalledTimes(1)
      expect(fresh.settle).toHaveBeenCalledWith(REAL, undefined, [REAL])
      expect(h.commitSecret).toHaveBeenCalledTimes(1)
      expect(stale.settle).not.toHaveBeenCalled()
    })
  }
})

describe("a cancelled attempt stops before the adoption", () => {
  it("cancelled while the L1 read is pending: ends at once, no further read step, no second gate", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const name = deferred<string>()
    h.installedNameOf.mockReturnValue(name.promise)
    const { gate, controller } = gateFor()
    const entering = enter(gate)
    await vi.waitFor(() => expect(h.installedNameOf).toHaveBeenCalled())
    controller.abort()
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    name.resolve(NAME)
    await drain()
    expect(h.getCode).not.toHaveBeenCalled()
    expect(gate).toHaveBeenCalledTimes(1)
    expect(begun.settle).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a retry enters with one prompt while the cancelled attempt's read is still pending", async () => {
    const stale = unsettled()
    const fresh = unsettled()
    h.beginRecovery.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh)
    const staleCode = deferred<string>()
    let firstAttempt = true
    h.installedNameOf.mockResolvedValue(NAME)
    h.getCode.mockImplementation(() =>
      firstAttempt ? staleCode.promise : Promise.resolve("0x6080"),
    )
    h.readAuthKeys.mockResolvedValue([authKey(REAL)])

    const first = gateFor()
    const firstEntering = enter(first.gate)
    await vi.waitFor(() => expect(h.getCode).toHaveBeenCalled())
    first.controller.abort()
    await expect(firstEntering).rejects.toSatisfy(isGateCancelled)
    firstAttempt = false

    const second = gateFor()
    await expect(enter(second.gate)).resolves.toMatchObject({ reason: "unclaimed" })
    expect(second.gate).toHaveBeenCalledTimes(1)
    expect(fresh.settle).toHaveBeenCalledWith(REAL, undefined, [REAL])

    staleCode.resolve("0x6080")
    await drain()
    expect(stale.settle).not.toHaveBeenCalled()
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(createObsidionAccount).toHaveBeenCalledTimes(1)
  })

  it("the tap resolves but the cancel lands first: no second prompt", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate, controller } = gateFor(async () => controller.abort())
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(begun.settle).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a cancel during the first prompt ends it, and reads as the cancel", async () => {
    const { gate, controller } = gateFor()
    h.beginRecovery.mockImplementation(async (request: { signal?: AbortSignal }) => {
      expect(request.signal).toBe(controller.signal)
      controller.abort()
      throw new DOMException("The operation was aborted.", "AbortError")
    })
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(h.beginRecovery).toHaveBeenCalledTimes(1)
    expect(deriveAccountAddress).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a cancel during the second prompt ends it, and reads as the cancel", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate, controller } = gateFor()
    begun.settle.mockImplementation(async () => {
      controller.abort()
      throw new DOMException("The operation was aborted.", "AbortError")
    })
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(begun.settle).toHaveBeenCalledWith(undefined, controller.signal)
    expectNothingAdopted()
  })

  it("the second prompt answered after a cancel: nothing derived, nothing adopted", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate, controller } = gateFor()
    begun.settle.mockImplementation(async () => {
      controller.abort()
      return settled(REAL)
    })
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(begun.settle).toHaveBeenCalledTimes(1)
    expect(deriveAccountAddress).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("cancelled while the anchors resolve: refused before the Registry is read", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    installs(REAL)
    const { gate, controller } = gateFor()
    const aborting: CandidateProbe = async (_msk, address) => {
      controller.abort()
      return address === ADDR ? "anchored" : "absent"
    }
    await expect(
      enter(gate, { tiers: [{ name: "registry", probes: [aborting] }] }),
    ).rejects.toSatisfy(isGateCancelled)
    expect(h.readNameOf).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("cancelled during the Registry read, which then answers: nothing adopted", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    installs(REAL)
    const { gate, controller } = gateFor()
    h.readNameOf.mockImplementation(async () => {
      controller.abort()
      return `0x${"0".repeat(64)}`
    })
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(h.readNameOf).toHaveBeenCalledTimes(1)
    expectNothingAdopted()
  })

  it("a retry after a cancel completes while the old attempt's Registry read is still pending", async () => {
    const stale = unsettled()
    const fresh = unsettled()
    h.beginRecovery.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh)
    installs(REAL)
    let answerStale!: (nameHash: string) => void
    h.readNameOf
      .mockImplementationOnce(() => new Promise((resolve) => (answerStale = resolve)))
      .mockResolvedValueOnce(`0x${"0".repeat(64)}`)
    const first = gateFor()
    const firstEntering = enter(first.gate)
    await vi.waitFor(() => expect(h.readNameOf).toHaveBeenCalled())
    first.controller.abort()

    const second = gateFor()
    await expect(enter(second.gate)).resolves.toMatchObject({
      entered: false,
      reason: "unclaimed",
    })
    expect(h.commitSecret).toHaveBeenCalledTimes(1)

    answerStale(`0x${"0".repeat(64)}`)
    await expect(firstEntering).rejects.toSatisfy(isGateCancelled)
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
    expect(createObsidionAccount).toHaveBeenCalledTimes(1)
  })

  it("the fallback gate refusing a browser below the floor surfaces the refusal", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate } = gateFor(async () => {
      throw new PhoneUnreachableError()
    })
    await expect(enter(gate)).rejects.toMatchObject({ name: "PhoneUnreachableError" })
    expect(begun.settle).not.toHaveBeenCalled()
    expectNothingAdopted()
  })

  it("a dismissed second prompt surfaces as today's dismissal, nothing written", async () => {
    const begun = unsettled()
    begun.settle.mockRejectedValue(
      new DOMException("The operation was aborted.", "NotAllowedError"),
    )
    h.beginRecovery.mockResolvedValue(begun)
    const { gate } = gateFor()
    await expect(enter(gate)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(deriveAccountAddress).not.toHaveBeenCalled()
    expectNothingAdopted()
  })
})

describe("reusePasskeyAccount settles before the address match", () => {
  it("asks the passkey again behind the gate, then adopts the candidate deriving the address", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate, controller } = gateFor()
    const keys = await reusePasskeyAccount(wallet, ADDR, undefined, gate)
    expect(gate).toHaveBeenCalledTimes(2)
    expect(begun.settle).toHaveBeenCalledWith(undefined, controller.signal)
    expect(keysDerivedUnder()).toEqual(new Set([REAL]))
    expect(keys.pubkeyHex).toBe(`0x${REAL}`)
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })

  it("a wrong settled key never derives the expected address", async () => {
    const begun = unsettled()
    begun.settle.mockResolvedValue(settled(WRONG))
    h.beginRecovery.mockResolvedValue(begun)
    const { gate } = gateFor()
    await expect(reusePasskeyAccount(wallet, ADDR, undefined, gate)).rejects.toBeInstanceOf(
      PasskeyMismatchError,
    )
    expect(keysDerivedUnder()).toEqual(new Set([WRONG]))
    expectNothingAdopted()
  })

  it("cancelled during the key read after the commit: the keys are never handed out", async () => {
    const begun = unsettled()
    const result = settled(REAL)
    const pubkeys = result.authProvider.getPubkeys.bind(result.authProvider)
    const { gate, controller } = gateFor()
    ;(result.authProvider as { getPubkeys: () => Promise<unknown> }).getPubkeys = async () => {
      controller.abort()
      return pubkeys()
    }
    begun.settle.mockResolvedValue(result)
    h.beginRecovery.mockResolvedValue(begun)
    await expect(reusePasskeyAccount(wallet, ADDR, undefined, gate)).rejects.toSatisfy(
      isGateCancelled,
    )
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })

  it("cancelled once the commit has landed: the keys are never handed out", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const { gate, controller } = gateFor()
    h.commitSecret.mockImplementationOnce(async () => {
      controller.abort()
      return 1
    })
    await expect(reusePasskeyAccount(wallet, ADDR, undefined, gate)).rejects.toSatisfy(
      isGateCancelled,
    )
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })
})

describe("adoption builds the account only after the commit", () => {
  it("records the set against the derived address, commits, then builds and persists the account", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    installs(REAL)
    const order: string[] = []
    h.recordRecoveryMetadata.mockImplementationOnce(async () => void order.push("record"))
    h.commitSecret.mockImplementationOnce(async () => {
      order.push("commit")
      return 1
    })
    createObsidionAccount.mockImplementationOnce(async () => {
      order.push("account")
      return account
    })
    h.addWebauthnAccount.mockImplementationOnce(async () => void order.push("persist"))
    const { gate } = gateFor()
    await enter(gate)
    expect(order).toEqual(["record", "commit", "account", "persist"])
  })

  it("a commit the store refuses builds no account", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    installs(REAL)
    h.commitSecret.mockResolvedValueOnce(false)
    const { gate } = gateFor()
    await expect(enter(gate)).rejects.toSatisfy(isGateCancelled)
    expect(createObsidionAccount).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("the reuse of a known account takes the same path", async () => {
    h.beginRecovery.mockResolvedValue(unsettled())
    const order: string[] = []
    h.commitSecret.mockImplementationOnce(async () => {
      order.push("commit")
      return 1
    })
    createObsidionAccount.mockImplementationOnce(async () => {
      order.push("account")
      return account
    })
    const { gate } = gateFor()
    await reusePasskeyAccount(wallet, ADDR, undefined, gate)
    expect(order).toEqual(["commit", "account"])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: REAL,
        passkeySet: [REAL],
        l2Address: ADDR,
        isMskRoot: true,
      }),
      expect.any(Function),
    )
  })
})

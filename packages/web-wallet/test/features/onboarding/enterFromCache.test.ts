// @vitest-environment node
/**
 * `/enter` over the session's own key: no ceremony, the record anchors, and the Registry decides
 * between a named account and a nameless one.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"
import { getContractAddress, type Address } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  adoptAccountPasskey: vi.fn(),
  beginRecovery: vi.fn(),
  recoverFromCache: vi.fn(),
  commitSecret: vi.fn(async (): Promise<number | false> => 1),
  recordRecoveryMetadata: vi.fn(),
  rootCredentialId: vi.fn(),
  addWebauthnAccount: vi.fn(),
  readNameOf: vi.fn(),
  previousName: vi.fn(),
  recordedL2: vi.fn(),
}))

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    rpId: "localhost",
    adoptAccountPasskey: h.adoptAccountPasskey,
    beginRecovery: h.beginRecovery,
    recoverFromCache: h.recoverFromCache,
    commitSecret: h.commitSecret,
    sessionHeld: () => true,
    sessionAddress: async () => undefined,
    markRecordsStale: () => {},
    recordRecoveryMetadata: h.recordRecoveryMetadata,
    rootCredentialId: h.rootCredentialId,
    answeredLocally: () => false,
    // A held key answered no route, so a record mismatch is never the certain wrong key.
    mismatchVerdict: () => "not-reproduced",
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
const { deriveBootstrapKey } = await import("@obsidion/front-core")
const msk = Fr.random()
const ACTIVE_FACTORY = `0x${"11".repeat(20)}` as const
const PREVIOUS_FACTORY = `0x${"19".repeat(20)}` as const
const REGISTRY = `0x${"22".repeat(20)}`
const METADATA = `0x${"23".repeat(20)}`
/** The account the resolver predicts for the held key under `factory`. */
const accountUnder = (factory: Address) =>
  predictAccountAddressLocally(factory, deriveBootstrapKey(msk).address)
const ACTIVE_ACCOUNT = accountUnder(ACTIVE_FACTORY)
const generation = (fpcAddress: string, accountFactory: string) => ({
  fpcAddress,
  accountFactory,
  namePortal: `${accountFactory.slice(0, 40)}ee`,
  rollupVersion: "1",
})
const CATALOG = [
  generation(`0x${"0b".repeat(32)}`, ACTIVE_FACTORY),
  generation(`0x${"0a".repeat(32)}`, PREVIOUS_FACTORY),
]
/** The chain the identity resolver really reads: both factories, one registry, one record. */
const reader = {
  readNameOf: async (_registry: string, account: string) =>
    account === ACTIVE_ACCOUNT ? await h.readNameOf() : await h.previousName(),
  readAccountMetadataRegistry: async () => METADATA,
  readUserRecord: async () => ({ l2Address: h.recordedL2(), rollupVersion: 1n }),
  readNamePortalRegistry: async () => REGISTRY,
  readFactoryImplementation: async (factory: string) =>
    getContractAddress({ from: factory as Address, nonce: 1n }),
}
const published = { catalog: CATALOG as unknown[] }
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({
    reader,
    registry: REGISTRY,
    rollupVersion: "1",
    catalog: published.catalog,
  }),
  generationFactories: () => [ACTIVE_FACTORY, PREVIOUS_FACTORY],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
  createOxideL1Reader: () => reader,
}))

const { enterWithPasskey, reusePasskeyAccount } = await import(
  "../../../src/features/onboarding/oxideOnboarding"
)
const { isGateCancelled } = await import("../../../src/features/identity/ceremonyGate")

const ADDR = `0x${"aa".repeat(32)}`
const PUBKEY = "ab".repeat(64)
const account = {
  getAddress: () => ({ toString: () => ADDR }),
  getCompleteAddress: () => ({ toString: () => `${ADDR}:complete` }),
}
/** The address exists only under the held key's master key AND a set holding its signing key. */
const deriveAccountAddress = vi.fn(async (candidate: Fr, passkeys: readonly string[]) => ({
  toString: () =>
    candidate.toString() === msk.toString() && passkeys.includes(PUBKEY) ? ADDR : "0xother",
}))
const wallet = { deriveAccountAddress, createObsidionAccount: async () => account } as never
const config = { rpId: "localhost" } as never
const gate = vi.fn(async () => ({
  signal: new AbortController().signal,
  reach: "unknown" as const,
}))

const held: RecoverPasskeyResult = {
  authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] } as never,
  credentialId: "cred",
  pubkey: PUBKEY,
  candidates: { first: msk },
  preferredSlot: "first",
  hasPersistedSlot: false,
  candidateSource: "webauthn",
  expectedAddress: ADDR,
  authenticatorType: "platform",
}

beforeEach(() => {
  vi.clearAllMocks()
  h.recoverFromCache.mockResolvedValue(held)
  h.recordedL2.mockReturnValue(ADDR)
  h.previousName.mockResolvedValue(`0x${"0".repeat(64)}`)
  published.catalog = CATALOG
})

afterEach(() => vi.unstubAllGlobals())

describe("enterWithPasskey from the session's key", () => {
  it("a zero Registry record is a nameless account, adopted with no ceremony and no gate", async () => {
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    const result = await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed", account })
    expect(gate).not.toHaveBeenCalled()
    expect(h.adoptAccountPasskey).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
    expect(h.commitSecret).toHaveBeenCalledWith(
      expect.objectContaining({ secretKey: msk, authProvider: held.authProvider }),
      expect.any(Function),
    )
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    // The record's address is checked under the record's own signing key.
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, [PUBKEY])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        l2Address: ADDR,
        pubkey: PUBKEY,
        passkeySet: [PUBKEY],
        isMskRoot: true,
      }),
      expect.any(Function),
    )
  })

  it("a held backup key enters under its set and is recorded as a backup with its envelope", async () => {
    const passkeys = ["cd".repeat(64), PUBKEY]
    const backup = { account: `0x${"11".repeat(20)}`, envelope: `01${"00".repeat(61)}` }
    h.recoverFromCache.mockResolvedValue({ ...held, passkeys, backup })
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    const result = await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed", account })
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, passkeys)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ l2Address: ADDR, passkeySet: passkeys, isMskRoot: false, backup }),
      expect.any(Function),
    )
  })

  it("a ceremony's reuse runs under the caller's cancel past the prompt: closed, nothing is written", async () => {
    // No held key, so the gate opens and a ceremony answers; the gate's own attempt stays live, and
    // only the caller's signal is aborted — during the address check, after the prompt.
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    const op = new AbortController()
    deriveAccountAddress.mockImplementationOnce(async () => {
      op.abort()
      return { toString: () => ADDR }
    })
    await expect(reusePasskeyAccount(wallet, ADDR, undefined, gate, op.signal)).rejects.toSatisfy(
      isGateCancelled,
    )
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a held key reused for a known account runs under the caller's cancel: closed, nothing is written", async () => {
    const op = new AbortController()
    deriveAccountAddress.mockImplementationOnce(async () => {
      op.abort()
      return { toString: () => ADDR }
    })
    await expect(reusePasskeyAccount(wallet, ADDR, undefined, gate, op.signal)).rejects.toSatisfy(
      isGateCancelled,
    )
    expect(gate).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a held key recorded under another signing key derives no matching address: refused", async () => {
    h.recoverFromCache.mockResolvedValue({ ...held, pubkey: "cd".repeat(64) })
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/does not match/)
    expect(deriveAccountAddress).toHaveBeenCalledWith(msk, ["cd".repeat(64)])
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("the chooser ignores the held key and runs the ceremony behind the gate", async () => {
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
      chooser: true,
    })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })

  it("a laptop enter on a browser with a record still stays discoverable", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    h.recoverFromCache.mockResolvedValue(undefined)
    h.rootCredentialId.mockResolvedValue("root-a")
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
    })
    // The record is never pinned from the screen: the browser's own chooser lists whatever holds
    // the passkey, and the anchors decide.
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(h.beginRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "root-a" }),
    )
  })

  it("a phone plain enter keeps the pin when the cache is empty", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4) Mobile" })
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
    })
    expect(h.beginRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: undefined }),
    )
  })
})

describe("enterWithPasskey as the arrival probe", () => {
  const LAPTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4) Mobile"
  const nameless = `0x${"0".repeat(64)}`

  // A once-queued answer left by an earlier test must not leak into the next.
  beforeEach(() => h.recoverFromCache.mockReset().mockResolvedValue(held))

  it.each([
    ["laptop", LAPTOP],
    ["phone", PHONE],
  ])(
    "with no held key on a %s it reports ceremony-required before any gate or prompt",
    async (_p, ua) => {
      vi.stubGlobal("navigator", { userAgent: ua })
      h.recoverFromCache.mockResolvedValue(undefined)
      const result = await enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      })
      expect(result).toEqual({ entered: false, reason: "ceremony-required" })
      expect(gate).not.toHaveBeenCalled()
      expect(h.beginRecovery).not.toHaveBeenCalled()
      expect(h.adoptAccountPasskey).not.toHaveBeenCalled()
      expect(h.commitSecret).not.toHaveBeenCalled()
    },
  )

  it("the key source is resolved once: a source that answers first and not again still never reaches the gate", async () => {
    vi.stubGlobal("navigator", { userAgent: LAPTOP })
    h.recoverFromCache.mockResolvedValueOnce(held).mockResolvedValueOnce(undefined)
    h.readNameOf.mockResolvedValue(nameless)
    const result = await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
      cacheOnly: true,
    })
    expect(result).toMatchObject({ entered: false, reason: "unclaimed" })
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(gate).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
  })

  it("restoreCache:false asks the cache for the key in memory only; a miss runs the ceremony", async () => {
    vi.stubGlobal("navigator", { userAgent: LAPTOP })
    h.readNameOf.mockResolvedValue(nameless)
    await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
      restoreCache: false,
    })
    expect(h.recoverFromCache).toHaveBeenCalledWith({ restore: false })
    expect(gate).not.toHaveBeenCalled()

    vi.clearAllMocks()
    h.recoverFromCache.mockResolvedValue(undefined)
    h.beginRecovery.mockResolvedValue(held)
    h.readNameOf.mockResolvedValue(nameless)
    await enterWithPasskey(wallet, config, undefined, {
      contractService: {} as never,
      gate,
      tiers: [],
      restoreCache: false,
    })
    expect(h.recoverFromCache).toHaveBeenCalledWith({ restore: false })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(h.beginRecovery).toHaveBeenCalledTimes(1)
  })

  it("a failure before the commit is untagged; one after it carries the commit", async () => {
    h.readNameOf.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      }),
    ).rejects.not.toHaveProperty("committed")
    expect(h.commitSecret).not.toHaveBeenCalled()

    h.readNameOf.mockResolvedValue(nameless)
    h.addWebauthnAccount.mockRejectedValueOnce(new Error("disk full"))
    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [],
        cacheOnly: true,
      }),
    ).rejects.toMatchObject({ message: "disk full", committed: true })
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })
})

describe("an account the previous factory holds, after the factory roll", () => {
  /** The roll moves the address a key predicts, so the active factory holds nothing for this user. */
  const rolledOver = async () => {
    const { composeWireNameHash } = await import("@obsidion/front-core")
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    h.previousName.mockResolvedValue(composeWireNameHash("alice", "zkmoney.eth"))
  }

  it("the stored session enters the account the previous factory holds, not a new signup", async () => {
    await rolledOver()

    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: [],
    })

    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    expect(gate).not.toHaveBeenCalled()
  })

  it("refuses the name when the record names another L2 address, and adopts nothing", async () => {
    await rolledOver()
    h.recordedL2.mockReturnValue(`0x${"cc".repeat(32)}`)

    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/cannot confirm/)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })
})

describe("evidence the wallet cannot read is never read as a new user", () => {
  it("the stored session refuses when the profile publishes no generation, and adopts nothing", async () => {
    published.catalog = []

    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [],
      }),
    ).rejects.toThrow(/cannot say which account/)
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a cold sign-in refuses when every published generation binds another registry", async () => {
    published.catalog = CATALOG.map((entry) => ({ ...entry, rollupVersion: "6" }))
    h.recoverFromCache.mockResolvedValue({ ...held, expectedAddress: undefined })

    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate,
        tiers: [{ name: "registry", probes: [async () => "anchored" as const] }],
      }),
    ).rejects.toThrow(/cannot say which account/)
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })
})

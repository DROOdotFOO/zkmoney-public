// @vitest-environment node
/**
 * The pinned sign-in behind "find my passkey by tag": `enterWithPasskey` under a credential hint,
 * over the real auth service and the fake authenticator. One assertion pinned to the hinted
 * credential, the same anchors as an open sign-in, a cancel that stops every write wherever it
 * lands, and an `unknown` the glue can tell apart. Plus the lookup glue over the L1 reader.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AnchorTier, CandidateProbe } from "@obsidion/front-core"
import { getContractAddress } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { WebAlphaAuthService } from "../../../src/platform/auth/WebAlphaAuthService"
import { WebPasskeyIdentityMap } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import {
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
} from "../../../src/platform/storage/activeStorage"
import { withWebLock } from "../../../src/platform/storage/webLock"
import { isGateCancelled } from "../../../src/features/identity/ceremonyGate"
import { SessionChangedError } from "../../../src/platform/auth/sessionErrors"
import { FakePasskeyCeremony, MemoryStorage } from "../../support/fakePasskeyCeremony"

const h = vi.hoisted(() => ({
  service: undefined as unknown,
  addWebauthnAccount: vi.fn(),
  readNameOf: vi.fn(),
  readAuthKeys: vi.fn(),
  readAuthKeysCounted: vi.fn(),
  getCode: vi.fn(),
  resolveSignInTagForCommit: vi.fn(),
  storageIdFromSecret: vi.fn(),
  /** The registered L2 address of the account the identity read resolves. */
  readUserRecord: vi.fn(async () => ({ l2Address: ADDR, rollupVersion: 1n })),
}))

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => h.service }))
const FACTORY = `0x${"11".repeat(20)}` as const
const identityReader = {
  readNameOf: (...args: unknown[]) => h.readNameOf(...(args as [])),
  readAccountMetadataRegistry: async () => `0x${"23".repeat(20)}`,
  readUserRecord: () => h.readUserRecord(),
  readNamePortalRegistry: async () => `0x${"22".repeat(20)}`,
  readFactoryImplementation: async () => getContractAddress({ from: FACTORY, nonce: 1n }),
}
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({
    reader: identityReader,
    registry: `0x${"22".repeat(20)}`,
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
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ rpId: "localhost" }) }))
vi.mock("../../../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({
    accountFactory: `0x${"11".repeat(20)}`,
    registry: `0x${"22".repeat(20)}`,
    ensDomain: "zkmoney.eth",
  }),
  requireTupleField: (tuple: Record<string, string>, key: string) => tuple[key],
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveSignInTagForCommit: h.resolveSignInTagForCommit,
}))
vi.mock("../../../src/platform/storage/activeStorage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/platform/storage/activeStorage")>()
  h.storageIdFromSecret.mockImplementation(original.storageIdFromSecret)
  return { ...original, storageIdFromSecret: h.storageIdFromSecret }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
  createOxideL1Reader: () => ({
    readNameOf: h.readNameOf,
    readAuthKeys: h.readAuthKeys,
    readAuthKeysCounted: h.readAuthKeysCounted,
    getCode: h.getCode,
  }),
}))

const { collectOnboardingKeys, enterWithPasskey, isCommittedFailure, PasskeyMismatchError } =
  await import("../../../src/features/onboarding/oxideOnboarding")
const { diagnoseMiss, diagnoseUnknown, lookupPasskeyByTag } = await import(
  "../../../src/features/onboarding/findPasskeyByTag"
)
const {
  composeWireNameHash,
  credentialIdHash,
  credentialIdToMetadata,
  deriveBootstrapKey,
  parseKeyMetadata,
  sealMasterKey,
} = await import("@obsidion/front-core")
const { predictAccountAddressLocally } = await import("@oxide/l1-contracts")

const ADDR = `0x${"aa".repeat(32)}`
const OTHER = `0x${"bb".repeat(32)}`
const ELSEWHERE = `0x${"cc".repeat(32)}`
const config = { rpId: "localhost" } as never
const account = {
  getAddress: () => ({ toString: () => ADDR }),
  getCompleteAddress: () => ({ toString: () => `${ADDR}:complete` }),
}
const anchoring: CandidateProbe = async (_msk, address) =>
  address === ADDR ? "anchored" : "absent"
const registry: AnchorTier[] = [{ name: "registry", probes: [anchoring] }]
const nameOf = (tag: string) => composeWireNameHash(tag, "zkmoney.eth")

type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
/** The L1 account the identity read predicts for a master key under the catalog's factory. */
const accountOf = (secret: Fr) =>
  predictAccountAddressLocally(FACTORY, deriveBootstrapKey(secret).address)
/** The chain's entry for a sign-up key: its raw credential id as metadata. */
const rootKey = (created: Created) => {
  const metadata = credentialIdToMetadata(created.credentialId)
  return { pubkeyHex: created.pubkey, metadata, parsed: parseKeyMetadata(metadata) }
}
/** The chain's entry for a backup key: oxide's prefix over the id's hash, the envelope, then the raw id. */
const backupKey = (created: Created, envelope: Uint8Array) => {
  const metadata = `0x01${credentialIdHash(created.credentialId).slice(2)}${Buffer.from(
    envelope,
  ).toString("hex")}${credentialIdToMetadata(created.credentialId).slice(2)}` as const
  return { pubkeyHex: created.pubkey, metadata, parsed: parseKeyMetadata(metadata) }
}
/** What a tag read hands the sign-in: the account `created`'s master key opens, and its keys. */
const hint = (created: Created, keys = [rootKey(created)]) => ({
  account: accountOf(created.secretKey),
  l2Address: ADDR,
  keys,
})
/** `created`'s master key sealed for `holder`, under the PRF the fake returns for it. */
const sealFor = (ceremony: FakePasskeyCeremony, holder: Created, created: Created) =>
  sealMasterKey({
    masterKey: new Uint8Array(created.secretKey.toBuffer()),
    prfOutput: ceremony.prfFor(holder.credentialId, "first"),
    slot: "first",
    account: accountOf(created.secretKey),
    credentialId: holder.credentialId,
  })

/** A wallet whose address derivation recognises exactly `secret`. */
function walletFor(secret: Fr, over: Record<string, unknown> = {}) {
  return {
    deriveAccountAddress: async (msk: Fr) => ({
      toString: () => (msk.equals(secret) ? ADDR : OTHER),
    }),
    createObsidionAccount: vi.fn(async () => account),
    ...over,
  } as never
}

/** A phone answering with its own passkey; the service under test is the one `getAuthService` hands out. */
function phone() {
  const ceremony = new FakePasskeyCeremony({ route: "local" })
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => "phone",
  })
  h.service = service
  const map = new WebPasskeyIdentityMap(storage, "localhost")
  return { service, ceremony, storage, map }
}

/**
 * A laptop whose own copy answers a this-device request and another device answers the rest;
 * `divergent` makes the local copy return a key the account never used.
 */
function laptop(over: { divergent?: boolean; assertAttachment?: "cross-platform" } = {}) {
  const ceremony = new FakePasskeyCeremony({
    route: "cross-device",
    routeFromRequest: true,
    ...over,
  })
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
  })
  h.service = service
  const map = new WebPasskeyIdentityMap(storage, "localhost")
  return { service, ceremony, storage, map }
}

async function record(service: WebAlphaAuthService, created: Created, l2Address: string) {
  await service.recordRecoveryMetadata({
    credentialId: created.credentialId,
    l2Address,
    pubkey: created.pubkey,
    prfSlot: created.prfSlot,
    isMskRoot: true,
  })
}

/** A session entered with `created`: its record, the committed key, the pointers and the cache. */
async function committed(service: WebAlphaAuthService, created: Created) {
  await record(service, created, ADDR)
  await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
}

/** The tag this browser remembers for a credential, as `usertagFor` reads it from local storage. */
function remember(created: Created, usertag: string) {
  walletStorage.setItem(
    "obsidion.obsidion_web_passkey_identity_map",
    JSON.stringify({
      version: 1,
      entries: {
        [created.credentialId]: {
          credentialId: created.credentialId,
          rpId: "localhost",
          l2Address: ADDR,
          pubkey: created.pubkey,
          isMskRoot: true,
          createdAt: 1,
          usertag,
        },
      },
    }),
  )
}

/** A gate that starts one attempt, as the real hook does on a phone. */
function gateFor() {
  const controller = new AbortController()
  const gate = vi.fn(async () => ({ signal: controller.signal, reach: "unknown" as const }))
  return { gate, controller }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(done: () => boolean) {
  while (!done()) await tick()
}

const nothingAdopted = (wallet: { createObsidionAccount: ReturnType<typeof vi.fn> }) => {
  expect(wallet.createObsidionAccount).not.toHaveBeenCalled()
  expect(h.addWebauthnAccount).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  h.readNameOf.mockResolvedValue(nameOf("alice"))
  // No L1 account for an unhinted sign-in's installed-key read.
  h.getCode.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe("enterWithPasskey under a credential hint", () => {
  it("one assertion pinned to the hinted credential, then the anchors, then the same adoption", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.asserts.length = 0
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toBeDefined()
    expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    expect(getActiveCredentialId()).toBe(a.credentialId)
    expect(service.recordsStale()).toBe(false)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: a.credentialId, pubkey: a.pubkey }),
    )
  })

  it("the pinned request does not depend on the posture the wallet reads", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.asserts.length = 0
    await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
  })

  it("the session's own key never answers a hint naming an account: the ceremony runs pinned to it", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    ceremony.asserts.length = 0
    const { gate } = gateFor()
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice" })
    expect(ceremony.asserts).toEqual([[a.credentialId]])
    expect(gate).toHaveBeenCalledTimes(1)
  })

  it("another credential answering the pinned request is the mismatch refusal, nothing written", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@bob")
    ceremony.opts.assertOverride = () => b.credentialId
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toBeInstanceOf(PasskeyMismatchError)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
  })

  it("a backup passkey among the account's keys opens its envelope and enters as the tag, recorded as a backup", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    const keys = [rootKey(a), backupKey(b, envelope)]
    ceremony.asserts.length = 0
    ceremony.opts.assertOverride = () => b.credentialId
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, keys),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    // The sheet is held to the root's raw id and the backup's appended id.
    expect(ceremony.asserts).toEqual([[a.credentialId, b.credentialId]])
    expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    expect(getActiveCredentialId()).toBe(b.credentialId)
    expect(await map.get(b.credentialId)).toMatchObject({
      pubkey: b.pubkey,
      isMskRoot: false,
      backup: {
        account: accountOf(a.secretKey),
        envelope: `0x${Buffer.from(envelope).toString("hex")}`,
      },
      passkeySet: [a.pubkey, b.pubkey],
    })
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: b.credentialId, pubkey: b.pubkey }),
    )
  })

  it("a backup passkey whose envelope does not open is the envelope refusal, nothing written", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    // Sealed under the root's PRF, not the backup's.
    const envelope = await sealFor(ceremony, a, a)
    ceremony.opts.assertOverride = () => b.credentialId
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
      }),
    ).rejects.toMatchObject({ name: "PasskeyEnvelopeError", reason: "decrypt" })
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("a tag whose account the key does not open enters nothing: unknown, with the evidence", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: { ...hint(a), account: `0x${"99".repeat(20)}` },
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      storedAddressMismatch: false,
    })
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("an unhinted sign-in whose key alone does not open the named account is sent to the tag field", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    // The account holds a second key: under its whole set the address is the registry's, under
    // this key alone another, which is all an unhinted sign-in can derive.
    const wallet = walletFor(Fr.random(), {
      deriveAccountAddress: async (msk: Fr) => ({
        toString: () => (msk.equals(a.secretKey) ? OTHER : ELSEWHERE),
      }),
    })
    const anchorsOther: AnchorTier[] = [
      {
        name: "registry",
        probes: [async (_msk, address) => (address === OTHER ? "anchored" : "absent")],
      },
    ]
    await expect(
      enterWithPasskey(wallet, config, undefined, {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: anchorsOther,
      }),
    ).rejects.toMatchObject({ name: "PasskeySetUnreadError" })
    nothingAdopted(wallet)
    // Pinned to the account's keys, the key is settled by the read: the mismatch stays the identity's.
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: anchorsOther,
        hints: hint(a),
      }),
    ).rejects.toMatchObject({ name: "UnverifiedOxideIdentityError" })
    nothingAdopted(wallet)
  })

  it("a hint that names a key other than this browser's record for the credential is the same refusal", async () => {
    const { service, storage } = phone()
    const a = await service.createPasskey("@alice")
    // The record holds a different key than the one the passkey signs with.
    await new WebPasskeyIdentityMap(storage, "localhost").upsert({
      credentialId: a.credentialId,
      l2Address: ADDR,
      pubkey: "ab".repeat(64),
      isMskRoot: true,
    })
    const wallet = walletFor(a.secretKey)
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toBeInstanceOf(PasskeyMismatchError)
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("the service's other refusals keep their class, and a cancelled attempt reads as the cancel", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    ceremony.opts.prfAtAssert = false
    await expect(
      enterWithPasskey(walletFor(a.secretKey), config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toMatchObject({ name: "NoPrfError" })
    ceremony.opts.prfAtAssert = true
    const { gate, controller } = gateFor()
    controller.abort()
    await expect(
      enterWithPasskey(walletFor(a.secretKey), config, "alice", {
        contractService: {} as never,
        gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toSatisfy(isGateCancelled)
  })

  it("only the selected tag names the claim: a remembered tag for the account is not consulted", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    h.readNameOf.mockResolvedValue(nameOf("bob"))
    remember(a, "bob")
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: false, reason: "confirm" })
  })

  it("no anchor: unknown carries the answering credential and every derived address", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: [],
      hints: hint(a),
    })
    expect(result).toEqual({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      pubkey: a.pubkey,
      addresses: expect.arrayContaining([ADDR, OTHER]),
      observed: expect.objectContaining({ credentialId: a.credentialId }),
      storedAddressMismatch: false,
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.addresses).toHaveLength(2)
    expect(diagnoseUnknown(result, ADDR)).toBe("REGISTRY_UNANCHORED")
    expect(diagnoseUnknown(result, ADDR.toUpperCase())).toBe("REGISTRY_UNANCHORED")
    expect(diagnoseUnknown(result, ELSEWHERE)).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("this browser's record for the credential no longer reproducing is the key mismatch, whatever derives", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await record(service, a, ELSEWHERE)
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    // A phone's own passkey answers as `platform` too; only a laptop's own copy is the certain
    // wrong key, so a phone stays the weaker not-reproduced.
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      storedAddressMismatch: true,
      verdict: "not-reproduced",
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.addresses).toContain(ADDR)
    expect(diagnoseUnknown(result, ADDR)).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
  })

  it("a cancelled stale-record refresh leaves the record and the session it was opened over as they were", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    // The session this browser holds: the one-key record and its address.
    await record(service, a, ELSEWHERE)
    await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 2 ? ADDR : ELSEWHERE,
      }),
    })
    const cancel = new AbortController()
    const commit = service.commitSecret.bind(service)
    vi.spyOn(service, "commitSecret").mockImplementationOnce(async (input, owns) => {
      cancel.abort()
      return commit(input, owns as () => boolean)
    })
    ceremony.opts.assertOverride = () => a.credentialId
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
        signal: cancel.signal,
      }),
    ).rejects.toSatisfy(isGateCancelled)
    expect(await map.get(a.credentialId)).toMatchObject({ l2Address: ELSEWHERE })
    expect((await map.get(a.credentialId))?.passkeySet).toBeUndefined()
    expect(getActiveCredentialId()).toBe(a.credentialId)
    expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    nothingAdopted(wallet)
  })

  it("a build that outlives a newer session persists nothing into it", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const building = deferred<typeof account>()
    const createObsidionAccount = vi
      .fn()
      .mockImplementationOnce(() => building.promise)
      .mockImplementation(async () => account)
    // Either key opens an account the registry names.
    const wallet = {
      deriveAccountAddress: async (msk: Fr) => ({
        toString: () => (msk.equals(a.secretKey) || msk.equals(b.secretKey) ? ADDR : OTHER),
      }),
      createObsidionAccount,
    } as never
    // Nothing cancels the first entry: only the second's commit ends it.
    const enteringA = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    ceremony.opts.assertOverride = () => b.credentialId
    const enteredB = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(b),
    })
    expect(enteredB).toMatchObject({ entered: true, address: ADDR })
    building.resolve(account)
    await expect(enteringA).rejects.toSatisfy(isCommittedFailure)
    expect(createObsidionAccount).toHaveBeenCalledTimes(2)
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: b.credentialId }),
    )
    expect(getActiveCredentialId()).toBe(b.credentialId)
    expect((await service.getSecretKey())?.toString()).toBe(b.secretKey.toString())
  })

  it("a build landing while the newer session's pointers are saved, before its commit returns, persists nothing into it", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const building = deferred<typeof account>()
    const createObsidionAccount = vi
      .fn()
      .mockImplementationOnce(() => building.promise)
      .mockImplementation(async () => account)
    const wallet = {
      deriveAccountAddress: async (msk: Fr) => ({
        toString: () => (msk.equals(a.secretKey) || msk.equals(b.secretKey) ? ADDR : OTHER),
      }),
      createObsidionAccount,
    } as never
    const enteringA = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    // The second session's pointers are saved, and the first build lands before the second's commit
    // has moved the generation.
    let released = false
    const batch = walletStorage.batch.bind(walletStorage)
    const saving = vi.spyOn(walletStorage, "batch").mockImplementation((write) =>
      batch(write).then(async () => {
        if (released || getActiveCredentialId() !== b.credentialId) return
        released = true
        building.resolve(account)
        await tick()
      }),
    )
    try {
      ceremony.opts.assertOverride = () => b.credentialId
      const enteredB = await enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(b),
      })
      expect(enteredB).toMatchObject({ entered: true, address: ADDR })
    } finally {
      saving.mockRestore()
    }
    expect(released).toBe(true)
    await expect(enteringA).rejects.toSatisfy(isCommittedFailure)
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: b.credentialId }),
    )
    expect(getActiveCredentialId()).toBe(b.credentialId)
  })

  it("a newer commit of the same key under a larger set fences the build that preceded it", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    const building = deferred<typeof account>()
    const elsewhere = {
      getAddress: () => ({ toString: () => ELSEWHERE }),
      getCompleteAddress: () => ({ toString: () => `${ELSEWHERE}:complete` }),
    }
    const createObsidionAccount = vi
      .fn()
      .mockImplementationOnce(() => building.promise)
      .mockImplementation(async () => account)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 2 ? ADDR : ELSEWHERE,
      }),
      createObsidionAccount,
    })
    const named: AnchorTier[] = [
      {
        name: "registry",
        probes: [
          async (_msk, address) => ([ADDR, ELSEWHERE].includes(address) ? "anchored" : "absent"),
        ],
      },
    ]
    ceremony.opts.assertOverride = () => a.credentialId
    // The one-key list, while the registry still names the one-key address: the session lands
    // there and its build waits.
    h.readUserRecord.mockResolvedValueOnce({ l2Address: ELSEWHERE, rollupVersion: 1n })
    const first = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: named,
      hints: { ...hint(a), l2Address: ELSEWHERE },
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    // The same key and credential under the chain's two-key list: a newer session, same storage id.
    const second = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: named,
      hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
    })
    expect(second).toMatchObject({ entered: true, address: ADDR })
    building.resolve(elsewhere)
    await expect(first).rejects.toSatisfy(isCommittedFailure)
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: a.credentialId }),
    )
    expect(await map.get(a.credentialId)).toMatchObject({
      l2Address: ADDR,
      passkeySet: [a.pubkey, b.pubkey],
    })
    expect(service.recordsStale()).toBe(true)
  })

  it("a sign-out while the stale record waits on the map's lock: nothing written, nothing built", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    await record(service, a, ELSEWHERE)
    await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
    const createObsidionAccount = vi.fn(async () => account)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 2 ? ADDR : ELSEWHERE,
      }),
      createObsidionAccount,
    })
    const held = deferred<void>()
    const holding = withWebLock("webwallet.passkey-identity-map", () => held.promise)
    const queued = deferred<void>()
    const upsert = WebPasskeyIdentityMap.prototype.upsert
    vi.spyOn(WebPasskeyIdentityMap.prototype, "upsert").mockImplementation(function (
      this: WebPasskeyIdentityMap,
      ...args
    ) {
      queued.resolve()
      return upsert.apply(this, args)
    })
    ceremony.opts.assertOverride = () => a.credentialId
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
    })
    // The commit stood; the record's rewrite is queued behind the lock when the session ends.
    await queued.promise
    service.lockOut()
    held.resolve()
    await holding
    await expect(entering).rejects.toSatisfy(isCommittedFailure)
    expect(await map.get(a.credentialId)).toMatchObject({ l2Address: ELSEWHERE })
    expect((await map.get(a.credentialId))?.passkeySet).toBeUndefined()
    expect(createObsidionAccount).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a backup this browser never recorded moves the live root session's address: the stores are stale, even when the build is cancelled", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    // The live session: the root key's one-key record and address.
    await record(service, a, ELSEWHERE)
    await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
    const building = deferred<typeof account>()
    const createObsidionAccount = vi.fn(() => building.promise)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 2 ? ADDR : ELSEWHERE,
      }),
      createObsidionAccount,
    })
    ceremony.opts.assertOverride = () => b.credentialId
    const cancel = new AbortController()
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
      signal: cancel.signal,
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    // The same key, so the storage id stayed; only the address moved.
    expect(service.recordsStale()).toBe(true)
    cancel.abort()
    building.resolve(account)
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: b.credentialId }),
    )
    expect(await map.get(b.credentialId)).toMatchObject({
      l2Address: ADDR,
      isMskRoot: false,
      passkeySet: [a.pubkey, b.pubkey],
    })
    expect(getActiveCredentialId()).toBe(b.credentialId)
  })

  it("a backup record a later backup left behind enters under the three-key set and is rewritten to it", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const c = await service.createPasskey("@alice")
    const envelopeB = await sealFor(ceremony, b, a)
    const envelopeC = await sealFor(ceremony, c, a)
    await service.recordRecoveryMetadata({
      credentialId: b.credentialId,
      l2Address: ELSEWHERE,
      pubkey: b.pubkey,
      prfSlot: "first",
      isMskRoot: false,
      backup: {
        account: accountOf(a.secretKey),
        envelope: `0x${Buffer.from(envelopeB).toString("hex")}`,
      },
      passkeySet: [a.pubkey, b.pubkey],
    })
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 3 ? ADDR : ELSEWHERE,
      }),
    })
    ceremony.opts.assertOverride = () => b.credentialId
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, [rootKey(a), backupKey(b, envelopeB), backupKey(c, envelopeC)]),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice", address: ADDR })
    expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    expect(await map.get(b.credentialId)).toMatchObject({
      l2Address: ADDR,
      pubkey: b.pubkey,
      isMskRoot: false,
      passkeySet: [a.pubkey, b.pubkey, c.pubkey],
    })
    expect(service.recordsStale()).toBe(true)
  })

  it("a root record the chain moved past, entered over the live backup session at the same address, forces no reload", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    // The root's one-key record, from before the backup was added.
    await record(service, a, ELSEWHERE)
    // The live session: the backup, recorded under the two-key set at the two-key address.
    const passkeys = [a.pubkey, b.pubkey]
    await service.recordRecoveryMetadata({
      credentialId: b.credentialId,
      l2Address: ADDR,
      pubkey: b.pubkey,
      prfSlot: "first",
      isMskRoot: false,
      backup: {
        account: accountOf(a.secretKey),
        envelope: `0x${Buffer.from(envelope).toString("hex")}`,
      },
      passkeySet: passkeys,
    })
    await service.commitSecret({
      secretKey: a.secretKey,
      authProvider: service.providerFor({
        credentialId: b.credentialId,
        pubkeyHex: b.pubkey,
        passkeys,
      }),
    })
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, keys: readonly string[]) => ({
        toString: () => (!msk.equals(a.secretKey) ? OTHER : keys.length === 2 ? ADDR : ELSEWHERE),
      }),
    })
    ceremony.opts.assertOverride = () => a.credentialId
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
    })
    expect(result).toMatchObject({ entered: true, address: ADDR })
    expect(await map.get(a.credentialId)).toMatchObject({ l2Address: ADDR, passkeySet: passkeys })
    // The page's stores were loaded for the address the session already had.
    expect(service.recordsStale()).toBe(false)
  })

  it("a tag the registry names nobody under enters nothing, however the key anchors", async () => {
    const { service, map } = phone()
    const a = await service.createPasskey("@alice")
    h.readNameOf.mockResolvedValue(`0x${"0".repeat(64)}`)
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      storedAddressMismatch: false,
    })
    nothingAdopted(wallet)
    expect(await map.get(a.credentialId)).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
  })

  it("a record the chain is ahead of still picks the key: one that does not reproduce is the key mismatch", async () => {
    const { service, ceremony, map } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, b, a)
    // An address neither set derives from either candidate.
    const nowhere = `0x${"dd".repeat(32)}`
    await record(service, a, nowhere)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async (msk: Fr, passkeys: readonly string[]) => ({
        toString: () =>
          !msk.equals(a.secretKey) ? OTHER : passkeys.length === 2 ? ADDR : ELSEWHERE,
      }),
    })
    ceremony.opts.assertOverride = () => a.credentialId
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a, [rootKey(a), backupKey(b, envelope)]),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      storedAddressMismatch: true,
      verdict: "not-reproduced",
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(diagnoseUnknown(result, ADDR)).toBe("PASSKEY_KEY_MISMATCH")
    expect(await map.get(a.credentialId)).toMatchObject({ l2Address: nowhere })
    expect((await map.get(a.credentialId))?.passkeySet).toBeUndefined()
    nothingAdopted(wallet)
    expect(service.isUnlocked()).toBe(false)
  })

  it("a laptop's own copy returning the wrong key is the certain verdict", async () => {
    const { service } = laptop({ divergent: true })
    const a = await service.createPasskey("@alice")
    await record(service, a, ADDR)
    const wallet = walletFor(a.secretKey)
    // A laptop sign-in admits the local copy, so the browser answers with a `platform` attachment;
    // a bound-slot mismatch from it is the certain wrong key.
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      storedAddressMismatch: true,
      verdict: "wrong-key",
      observed: { credentialId: a.credentialId, attachment: "platform" },
    })
    nothingAdopted(wallet)
  })

  it("with no record, a laptop's own copy returning the wrong key is still named, from the pin's own evidence", async () => {
    const { service } = laptop({ divergent: true })
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    const result = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      observed: { credentialId: a.credentialId, attachment: "platform" },
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    expect(result.storedAddressMismatch).toBe(false)
    // Both slots were evaluated and neither derived the account.
    expect(result.addresses).toHaveLength(2)
    expect(result.addresses).not.toContain(ADDR)
    const pinned = { laptop: true, moreKeys: false }
    expect(diagnoseUnknown(result, ADDR, pinned)).toBe("LOCAL_COPY_WRONG_KEY")
    // Another key on the account could be its root, so the same miss stays the plain mismatch.
    expect(diagnoseUnknown(result, ADDR, { laptop: true, moreKeys: true })).toBe(
      "PASSKEY_KEY_MISMATCH",
    )
    // A phone's own passkey answers as `platform` too; the wrong-key verdict is a laptop's alone.
    expect(diagnoseUnknown(result, ADDR, { laptop: false, moreKeys: false })).toBe(
      "PASSKEY_KEY_MISMATCH",
    )
    // Without the evidence, as the plain path calls it, nothing changes.
    expect(diagnoseUnknown(result, ADDR)).toBe("PASSKEY_KEY_MISMATCH")
    // A one-slot answer proves nothing about the other slot.
    expect(diagnoseUnknown({ ...result, addresses: [result.addresses![0]!] }, ADDR, pinned)).toBe(
      "PASSKEY_KEY_MISMATCH",
    )
    // Another device's answer is that device's, not this computer's copy.
    expect(
      diagnoseUnknown(
        { ...result, observed: { credentialId: a.credentialId, attachment: "cross-platform" } },
        ADDR,
        pinned,
      ),
    ).toBe("PASSKEY_KEY_MISMATCH")
    // A phone-steered answer whose label can't be believed names no class, so it is never this
    // computer's certain wrong key.
    expect(
      diagnoseUnknown({ ...result, observed: { credentialId: a.credentialId } }, ADDR, pinned),
    ).toBe("PASSKEY_KEY_MISMATCH")
    nothingAdopted(wallet)
  })

  it("a cancel while the account is persisted after the commit hands nothing back, on any route", async () => {
    for (const named of [true, false]) {
      const { service } = phone()
      const a = await service.createPasskey("@alice")
      h.readNameOf.mockResolvedValue(named ? nameOf("alice") : `0x${"0".repeat(64)}`)
      const cancel = new AbortController()
      h.addWebauthnAccount.mockImplementationOnce(async () => cancel.abort())
      await expect(
        enterWithPasskey(walletFor(a.secretKey), config, "alice", {
          contractService: {} as never,
          gate: gateFor().gate,
          tiers: registry,
          // A tag pins an account the registry names; a remembered credential enters an unnamed
          // account's signup too.
          hints: named ? hint(a) : { credentialId: a.credentialId },
          signal: cancel.signal,
        }),
      ).rejects.toSatisfy(isGateCancelled)
      // The commit stood; the result that would have entered or resumed a signup did not.
      expect(service.isUnlocked()).toBe(true)
    }
  })

  it("a sign-out while the account is persisted after the commit hands nothing back: the snapshot stays, the key is gone", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    h.addWebauthnAccount.mockImplementationOnce(async () => service.lockOut())
    await expect(
      enterWithPasskey(walletFor(a.secretKey), config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toSatisfy(isCommittedFailure)
    expect(h.addWebauthnAccount).toHaveBeenCalledTimes(1)
    expect(service.isUnlocked()).toBe(false)
  })

  it("the ownership handed back with the account ends as another commit saves its pointers", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@bob")
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    if (!result.entered) throw new Error("not entered")
    expect(result.held()).toBe(true)
    let whileSaving: boolean | undefined
    const batch = walletStorage.batch.bind(walletStorage)
    const saving = vi.spyOn(walletStorage, "batch").mockImplementationOnce((write) =>
      batch(write).then(() => {
        whileSaving = result.held()
      }),
    )
    try {
      await service.commitSecret({ secretKey: b.secretKey, authProvider: b.authProvider })
    } finally {
      saving.mockRestore()
    }
    expect(whileSaving).toBe(false)
    expect(result.held()).toBe(false)
  })

  it("a replacement cancelled as it saved puts the session back, and the sign-in goes on", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@bob")
    const createObsidionAccount = vi.fn(async () => account)
    let bobsCommit: Promise<number | false> | undefined
    let bobOwns = true
    const batch = walletStorage.batch.bind(walletStorage)
    const saving = vi.spyOn(walletStorage, "batch").mockImplementation((write) =>
      batch(write).then(async () => {
        if (!bobsCommit && getActiveCredentialId() === a.credentialId) {
          // Alice's pointers are saved: Bob's commit queues behind her turn before it ends.
          bobsCommit = service.commitSecret(
            { secretKey: b.secretKey, authProvider: b.authProvider },
            () => bobOwns,
          )
          for (let i = 0; i < 3; i++) await tick()
        } else if (getActiveCredentialId() === b.credentialId) {
          // Bob's pointers are saved and his attempt is cancelled: his turn puts Alice's back.
          bobOwns = false
        }
      }),
    )
    try {
      const result = await enterWithPasskey(
        walletFor(a.secretKey, { createObsidionAccount }),
        config,
        "alice",
        { contractService: {} as never, gate: gateFor().gate, tiers: registry, hints: hint(a) },
      )
      expect(result).toMatchObject({ entered: true, address: ADDR })
      if (!result.entered) throw new Error("not entered")
      expect(result.held()).toBe(true)
    } finally {
      saving.mockRestore()
    }
    expect(await bobsCommit).toBe(false)
    expect(getActiveCredentialId()).toBe(a.credentialId)
    expect((await service.getSecretKey())?.equals(a.secretKey)).toBe(true)
    expect(createObsidionAccount).toHaveBeenCalledTimes(1)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: a.credentialId }),
    )
  })

  it("the collected keys are the session pair for its own account, refused for an account the session left", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const b = await service.createPasskey("@bob")
    await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
    const own = { ...account, getAuthProvider: () => a.authProvider } as never
    const keys = await collectOnboardingKeys(own)
    expect(keys.authProvider).toBe(a.authProvider)
    expect(keys.secretKey.equals(a.secretKey)).toBe(true)
    await service.commitSecret({ secretKey: b.secretKey, authProvider: b.authProvider })
    await expect(collectOnboardingKeys(own)).rejects.toBeInstanceOf(SessionChangedError)
  })

  it("a laptop sign-in another device answered (a cross-platform attachment) enters", async () => {
    const { service } = laptop({ assertAttachment: "cross-platform" })
    const a = await service.createPasskey("@alice")
    await record(service, a, ADDR)
    const result = await enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
    })
    expect(result).toMatchObject({ entered: true, handle: "alice" })
  })

  it("an address derivation that fails keeps its own error, not the diagnosis", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await record(service, a, ELSEWHERE)
    const wallet = walletFor(a.secretKey, {
      deriveAccountAddress: async () => {
        throw new Error("pxe down")
      },
    })
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate: gateFor().gate,
        tiers: registry,
        hints: hint(a),
      }),
    ).rejects.toThrow(/pxe down/)
  })

  it("a plain enter's unknown carries the answering credential and its evidence, no verdict", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await enterWithPasskey(walletFor(a.secretKey), config, undefined, {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: [],
      chooser: true,
    })
    expect(result).toMatchObject({
      entered: false,
      reason: "unknown",
      credentialId: a.credentialId,
      pubkey: a.pubkey,
    })
    if (result.entered || result.reason !== "unknown") throw new Error("unreachable")
    // No record was mismatched, so there is no verdict — the tag path diagnoses it instead.
    expect(result.verdict).toBeUndefined()
    expect(result.observed).toBeDefined()
    expect(h.getCode).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("strictTag on the session's own key", () => {
  it("refuses the remembered tag and lands on confirm; the plain entry takes it", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    h.readNameOf.mockResolvedValue(nameOf("bob"))
    remember(a, "bob")
    const wallet = walletFor(a.secretKey)
    const strict = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      strictTag: true,
      signal: new AbortController().signal,
    })
    expect(strict).toMatchObject({ entered: false, reason: "confirm" })
    const plain = await enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
    })
    expect(plain).toMatchObject({ entered: true, handle: "bob" })
  })
})

describe("a cancel ends the hinted sign-in wherever it lands", () => {
  const LOCK = "webwallet.passkey-identity-map"

  it("before the gate: neither the gate nor the prompt starts", async () => {
    const { service, ceremony } = phone()
    const a = await service.createPasskey("@alice")
    const wallet = walletFor(a.secretKey)
    // A credential hint consults the cache first; a cancel during that read reaches no gate.
    const cache = deferred<undefined>()
    vi.spyOn(service, "recoverFromCache").mockReturnValueOnce(cache.promise)
    const cancel = new AbortController()
    const { gate } = gateFor()
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: { credentialId: a.credentialId },
      signal: cancel.signal,
    })
    await tick()
    cancel.abort()
    cache.resolve(undefined)
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    expect(ceremony.asserts).toEqual([])
    // A tag consults no cache: a sign-in already cancelled goes straight to the refusal.
    const ended = new AbortController()
    ended.abort()
    await expect(
      enterWithPasskey(wallet, config, "alice", {
        contractService: {} as never,
        gate,
        tiers: registry,
        hints: hint(a),
        signal: ended.signal,
      }),
    ).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    expect(ceremony.asserts).toEqual([])
    nothingAdopted(wallet)
  })

  it("during the anchor probe: nothing adopted, nothing stored", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const probe = deferred<"anchored">()
    const probing = deferred<void>()
    const tier: AnchorTier[] = [
      {
        name: "registry",
        probes: [
          async () => {
            probing.resolve()
            return probe.promise
          },
        ],
      },
    ]
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: tier,
      hints: hint(a),
      signal: cancel.signal,
    })
    await probing.promise
    cancel.abort()
    probe.resolve("anchored")
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(getActiveStorageId()).toBeNull()
  })

  it("during the name read: nothing adopted", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const name = deferred<string>()
    h.readNameOf.mockImplementationOnce(() => name.promise)
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => h.readNameOf.mock.calls.length === 1)
    cancel.abort()
    name.resolve(nameOf("alice"))
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    nothingAdopted(wallet)
    expect(await service.rootCredentialId()).toBeUndefined()
  })

  it("while the account is being built: the commit stands and the account is persisted; the cancel still ends the entry", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const building = deferred<typeof account>()
    const createObsidionAccount = vi.fn(() => building.promise)
    const wallet = walletFor(a.secretKey, { createObsidionAccount })
    const cancel = new AbortController()
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => createObsidionAccount.mock.calls.length === 1)
    cancel.abort()
    building.resolve(account)
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    // The account is built after the commit, so the session already names it; a reload needs the
    // stored account to keep it.
    expect(await service.rootCredentialId()).toBe(a.credentialId)
    expect(service.isUnlocked()).toBe(true)
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${ADDR}:complete`,
      expect.objectContaining({ credentialId: a.credentialId }),
    )
  })

  it("while the record waits on the identity map's lock: no record written", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const held = deferred<void>()
    const holding = withWebLock(LOCK, () => held.promise)
    const queued = deferred<void>()
    const upsert = WebPasskeyIdentityMap.prototype.upsert
    vi.spyOn(WebPasskeyIdentityMap.prototype, "upsert").mockImplementation(function (
      this: WebPasskeyIdentityMap,
      ...args
    ) {
      queued.resolve()
      return upsert.apply(this, args)
    })
    const cancel = new AbortController()
    const entering = enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await queued.promise
    cancel.abort()
    held.resolve()
    await holding
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(await service.rootCredentialId()).toBeUndefined()
    expect(service.isUnlocked()).toBe(false)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("inside the commit: the record stays, the session does not move, nothing cached", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    const deriving = deferred<string>()
    h.storageIdFromSecret.mockImplementationOnce(() => deriving.promise)
    const cancel = new AbortController()
    const entering = enterWithPasskey(walletFor(a.secretKey), config, "alice", {
      contractService: {} as never,
      gate: gateFor().gate,
      tiers: registry,
      hints: hint(a),
      signal: cancel.signal,
    })
    await until(() => h.storageIdFromSecret.mock.calls.length === 1)
    cancel.abort()
    deriving.resolve("storage-id")
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(await service.rootCredentialId()).toBe(a.credentialId)
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(service.isUnlocked()).toBe(false)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("on the session's own key under a credential hint, with no gate attempt: the session stays as it was", async () => {
    const { service } = phone()
    const a = await service.createPasskey("@alice")
    await committed(service, a)
    const before = {
      storageId: getActiveStorageId(),
      credentialId: getActiveCredentialId(),
      cache: readCachedMsk(),
    }
    const name = deferred<string>()
    h.readNameOf.mockImplementationOnce(() => name.promise)
    const gate = vi.fn(async () => ({
      signal: new AbortController().signal,
      reach: "unknown" as const,
    }))
    const cancel = new AbortController()
    const wallet = walletFor(a.secretKey)
    const entering = enterWithPasskey(wallet, config, "alice", {
      contractService: {} as never,
      gate,
      tiers: registry,
      hints: { credentialId: a.credentialId },
      signal: cancel.signal,
    })
    await until(() => h.readNameOf.mock.calls.length === 1)
    cancel.abort()
    name.resolve(nameOf("alice"))
    await expect(entering).rejects.toSatisfy(isGateCancelled)
    expect(gate).not.toHaveBeenCalled()
    nothingAdopted(wallet)
    expect(getActiveStorageId()).toBe(before.storageId)
    expect(getActiveCredentialId()).toBe(before.credentialId)
    expect(readCachedMsk()).toEqual(before.cache)
  })
})

describe("lookupPasskeyByTag", () => {
  const ACCOUNT = `0x${"44".repeat(20)}`
  const id = (fill: number) => Buffer.alloc(16, fill).toString("base64url")
  const key = (fill: number) => ({
    qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
    qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
  })
  const resolved = () =>
    h.resolveSignInTagForCommit.mockResolvedValue({
      status: "resolved",
      account: ACCOUNT,
      l2Address: ADDR,
      rollupId: "1",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0xeoa",
    })

  it("more keys than the read covers is inconclusive", async () => {
    resolved()
    const eight = Array.from({ length: 8 }, (_, i) => ({
      key: key(0x30 + i),
      metadata: credentialIdToMetadata(id(20 + i)),
    }))
    h.readAuthKeysCounted.mockResolvedValue({ entries: eight, authKeyCount: 9 })
    expect(await lookupPasskeyByTag("alice")).toEqual({
      kind: "inconclusive",
      tag: "alice",
      account: ACCOUNT,
    })
  })

  it("one key: no more keys", async () => {
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [{ key: key(0x10), metadata: credentialIdToMetadata(id(1)) }],
      authKeyCount: 1,
    })
    expect(await lookupPasskeyByTag("alice")).toMatchObject({ kind: "resolved", moreKeys: false })
  })

  it("a second key with no credential id is still a second key", async () => {
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [
        { key: key(0x10), metadata: credentialIdToMetadata(id(1)) },
        { key: key(0x20), metadata: "0x" },
      ],
      authKeyCount: 2,
    })
    expect(await lookupPasskeyByTag("alice")).toMatchObject({
      kind: "resolved",
      keys: [
        expect.objectContaining({ parsed: { kind: "credential-id", credentialId: id(1) } }),
        expect.objectContaining({ parsed: { kind: "unknown" } }),
      ],
      moreKeys: true,
    })
  })

  it("the reader's non-answers pass through, and a read that cannot reach the chain throws", async () => {
    h.resolveSignInTagForCommit.mockResolvedValue({ status: "notFound" })
    expect(await lookupPasskeyByTag("nobody")).toEqual({ kind: "notFound" })
    resolved()
    h.readAuthKeysCounted.mockResolvedValue({ entries: [], authKeyCount: 0 })
    expect(await lookupPasskeyByTag("alice")).toEqual({ kind: "noKeyInstalled", account: ACCOUNT })
    h.readAuthKeysCounted.mockRejectedValue(new Error("rpc down"))
    await expect(lookupPasskeyByTag("alice")).rejects.toThrow(/rpc down/)
  })
})

describe("diagnoseMiss", () => {
  const ACCOUNT = `0x${"55".repeat(20)}`
  const id = (fill: number) => Buffer.alloc(16, fill).toString("base64url")
  const key = (fill: number) => ({
    qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
    qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
  })
  const pubkeyOf = (fill: number) =>
    `${fill.toString(16).padStart(2, "0").repeat(32)}${(fill + 1)
      .toString(16)
      .padStart(2, "0")
      .repeat(32)}`
  const entry = (fill: number, credFill: number) => ({
    key: key(fill),
    metadata: credentialIdToMetadata(id(credFill)),
  })
  const resolve = () =>
    h.resolveSignInTagForCommit.mockResolvedValue({
      status: "resolved",
      account: ACCOUNT,
      l2Address: ADDR,
      rollupId: "1",
      sipaStealthPublicKey: { x: 1n, y: 2n },
      xmtpAddress: "0xeoa",
    })
  const evidence = (
    over: Partial<{ credentialId: string; pubkey: string; addresses: string[] }> = {},
  ) => ({
    credentialId: id(1),
    pubkey: pubkeyOf(0x10),
    addresses: ["0xsomewhere"],
    ...over,
  })

  it("a backup entry names the credential by the hash oxide's prefix carries", async () => {
    resolve()
    const backup = {
      key: key(0x10),
      metadata: `0x01${credentialIdHash(id(1)).slice(2)}${"00".repeat(62)}` as const,
    }
    h.readAuthKeysCounted.mockResolvedValue({ entries: [backup], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence({ addresses: [ADDR] }), "alice")).toBe("REGISTRY_UNANCHORED")
    expect(await diagnoseMiss(evidence(), "alice")).toBe("NOT_REPRODUCED_HERE")
    expect(await diagnoseMiss(evidence({ credentialId: id(2) }), "alice")).toBe("DIFFERENT_PASSKEY")
  })

  it("an entry naming our credential but carrying another key is no match", async () => {
    resolve()
    // metadata is our credential id, but the key differs — id alone is not a match.
    h.readAuthKeysCounted.mockResolvedValue({ entries: [entry(0x20, 1)], authKeyCount: 1 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("DIFFERENT_PASSKEY")
  })

  it("a credential absent from an incomplete set is inconclusive, not a different passkey", async () => {
    resolve()
    // Eight read, nine installed: ours could be the ninth.
    const eight = Array.from({ length: 8 }, (_, i) => entry(0x30 + i, 20 + i))
    h.readAuthKeysCounted.mockResolvedValue({ entries: eight, authKeyCount: 9 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("INCONCLUSIVE")
  })

  it("eight ineligible entries hiding a later eligible one are inconclusive, not unreadable", async () => {
    resolve()
    const ineligible = Array.from({ length: 8 }, () => ({
      key: key(0x10),
      metadata: "0x" as const,
    }))
    h.readAuthKeysCounted.mockResolvedValue({ entries: ineligible, authKeyCount: 9 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("INCONCLUSIVE")
  })

  it("no eligible entry in a complete set is unreadable; an account holding no key has none installed", async () => {
    resolve()
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [{ key: key(0x10), metadata: "0x" as const }],
      authKeyCount: 1,
    })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("unreadable")
    h.readAuthKeysCounted.mockResolvedValue({ entries: [], authKeyCount: 0 })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("noKeyInstalled")
  })

  it("the by-tag non-answers pass through", async () => {
    h.resolveSignInTagForCommit.mockResolvedValue({ status: "notFound" })
    expect(await diagnoseMiss(evidence(), "nobody")).toBe("notFound")
    h.resolveSignInTagForCommit.mockResolvedValue({ status: "staleRollup" })
    expect(await diagnoseMiss(evidence(), "alice")).toBe("staleRollup")
  })
})

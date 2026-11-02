import { Fr } from "@aztec-labs/aztec.js/fields"
// @vitest-environment node
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID } from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"
import {
  type InstalledPasskey,
  PasskeyEnvelopeError,
  StoredAddressMismatchError,
  credentialIdHash,
  credentialIdToMetadata,
  parseKeyMetadata,
  sealMasterKey,
  selectRecoveredMsk,
} from "@obsidion/front-core"
import { provingProgress } from "@obsidion/proving-progress"
import { deriveMskFromPrfOutput } from "@obsidion/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import {
  bytesToBase64Url,
  type DevicePosture,
  type LaptopCreation,
  NoPrfError,
  PhoneRequiredError,
  type PasskeyAssertRequest,
  type PasskeyCeremony,
  type PasskeyRequestScope,
  type UserAgentInfo,
  parseUserAgent,
} from "@obsidion/passkey-web"
import type { BackupCreationDriver } from "../../../src/platform/auth/backupCreation"
import { localRefusalCount, noteLocalRefusal } from "../../../src/platform/auth/localRefusals"
import { statusForAttempt } from "../../../src/platform/auth/passkeyAttemptScope"
import { WebAlphaAuthService, isUnsettled } from "../../../src/platform/auth/WebAlphaAuthService"
import { WebPasskeyIdentityMap } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import {
  clearActiveStorage,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
} from "../../../src/platform/storage/activeStorage"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  type FakeRoute,
  MemoryStorage,
} from "../../support/fakePasskeyCeremony"
import { testWalletDbs } from "../../support/fakeWalletDb"

const h = vi.hoisted(() => ({ noteBackupSignIn: vi.fn() }))
vi.mock("../../../src/features/onboarding/backupSignIn", () => ({
  noteBackupSignIn: h.noteBackupSignIn,
}))

type ServiceOptions = FakeCeremonyOptions & {
  posture?: DevicePosture
  misreportsCrossDevice?: boolean
  trustsAttachmentLabel?: boolean
  userAgent?: () => Promise<UserAgentInfo>
}

function makeService({
  posture = "laptop",
  misreportsCrossDevice = false,
  trustsAttachmentLabel = false,
  userAgent,
  ...fake
}: ServiceOptions = {}) {
  const ceremony = new FakePasskeyCeremony(fake)
  const storage = new MemoryStorage()
  const service = new WebAlphaAuthService({
    storage,
    rpId: "localhost",
    ceremony,
    posture: () => posture,
    misreportsCrossDevice: () => misreportsCrossDevice,
    trustsAttachmentLabel: () => trustsAttachmentLabel,
    ...(userAgent ? { userAgent } : {}),
  })
  return { service, ceremony, storage }
}

/** A laptop whose ceremonies a phone answers over the cross-device route. */
const laptop = (opts: ServiceOptions = {}) =>
  makeService({ posture: "laptop", route: "cross-device", ...opts })
/** A phone using its own passkey. */
const phone = (opts: ServiceOptions = {}) =>
  makeService({ posture: "phone", route: "local", ...opts })

const msk = (bytes: Uint8Array) => deriveMskFromPrfOutput(bytes).toString()

const WINDOWS_HELLO_AAGUID = "08987058-cadc-4b81-b6e1-30de50dcbe96"
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i])

/** Address derivation that recognises exactly one master key under exactly one key set, in order. */
const deriveFor =
  (expected: { secretKey: Fr; pubkey: string }, address: string, passkeys = [expected.pubkey]) =>
  async (candidate: Fr, keys: readonly string[]) =>
    candidate.toString() === expected.secretKey.toString() && sameKeys(keys, passkeys)
      ? address
      : "0xother"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

type Passkey = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
/** The L1 account a tag read names; the envelopes below are bound to it. */
const ACCOUNT = `0x${"11".repeat(20)}` as const
/** The chain's entry for a sign-up key: its raw credential id as metadata. */
const rootKey = (created: Passkey): InstalledPasskey => {
  const metadata = credentialIdToMetadata(created.credentialId)
  return { pubkeyHex: created.pubkey, metadata, parsed: parseKeyMetadata(metadata) }
}
/** The chain's entry for a backup key: oxide's prefix over the id's hash, the envelope, then the raw id. */
const backupKey = (created: Passkey, envelope: Uint8Array): InstalledPasskey => {
  const metadata = `${backupKeyUnnamed(created, envelope).metadata}${credentialIdToMetadata(
    created.credentialId,
  ).slice(2)}` as const
  return { pubkeyHex: created.pubkey, metadata, parsed: parseKeyMetadata(metadata) }
}
/** A backup entry with no appended id: the prefix and the envelope alone. */
const backupKeyUnnamed = (created: Passkey, envelope: Uint8Array): InstalledPasskey => {
  const metadata = `0x01${credentialIdHash(created.credentialId).slice(2)}${Buffer.from(
    envelope,
  ).toString("hex")}` as const
  return { pubkeyHex: created.pubkey, metadata, parsed: parseKeyMetadata(metadata) }
}
/** The same passkey under `credentialId`, as an authenticator with its own id format mints it. */
const rekeyed = (
  ceremony: FakePasskeyCeremony,
  created: Passkey,
  credentialId: string,
): Passkey => {
  ceremony.creds.set(credentialId, ceremony.creds.get(created.credentialId)!)
  ceremony.creds.delete(created.credentialId)
  return { ...created, credentialId }
}
/** What a tag read hands `adoptAccountPasskey`: the account and its listed keys. */
const accountOf = (...keys: InstalledPasskey[]) => ({ account: ACCOUNT, keys })
/** `masterKey` sealed for `holder`, under the PRF the fake returns for it on `route`. */
const sealFor = (
  ceremony: FakePasskeyCeremony,
  holder: Passkey,
  masterKey: Fr,
  slot: PrfSlot = "first",
  route?: FakeRoute,
  account: `0x${string}` = ACCOUNT,
) =>
  sealMasterKey({
    masterKey: new Uint8Array(masterKey.toBuffer()),
    prfOutput: ceremony.prfFor(holder.credentialId, slot, route),
    slot,
    account,
    credentialId: holder.credentialId,
  })
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`

const UNASKED = { code: "passkey.unasked" }

describe("metadata consent challenge", () => {
  it("passes the exact digest to the active credential without PRF or another signing prefix", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xabc")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const challenge = `0x${"42".repeat(32)}` as const
      const result = await service.signMetadataChallenge(challenge)
      const request = ceremony.assertRequests.at(-1)!
      expect(Buffer.from(request.challenge).toString("hex")).toBe(challenge.slice(2))
      expect(request.credentialIds).toEqual([created.credentialId])
      expect(request.prfFirstSalt).toBeUndefined()
      expect(result.webauthn.clientDataJSON.slice(result.webauthn.challengeIndex)).toMatch(
        /^"challenge"/,
      )
      expect(result.webauthn.clientDataJSON.slice(result.webauthn.typeIndex)).toMatch(/^"type"/)
    } finally {
      restore()
    }
  })

  it("discards consent when the account changes during the passkey prompt", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xabc")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const assert = ceremony.assert.bind(ceremony)
      vi.spyOn(ceremony, "assert").mockImplementation(async (request) => {
        const result = await assert(request)
        setActiveStorageId("another-account")
        return result
      })
      await expect(service.signMetadataChallenge(`0x${"42".repeat(32)}`)).rejects.toMatchObject({
        name: "SessionChangedError",
      })
    } finally {
      restore()
    }
  })
})

/**
 * `refuse` names the keys this store rejects writes for; everything else behaves normally. Entries
 * are own enumerable properties, as on a real `Storage`, so key scans see them.
 */
const stubLocalStorage = (refuse: () => readonly string[] = () => []) => {
  const store: Record<string, string> = {}
  Object.defineProperties(store, {
    getItem: { value: (k: string) => (Object.hasOwn(store, k) ? store[k] : null) },
    setItem: {
      value: (k: string, v: string) => {
        if (refuse().includes(k)) throw new Error("QuotaExceededError")
        store[k] = v
      },
    },
    removeItem: { value: (k: string) => void delete store[k] },
  })
  vi.stubGlobal("localStorage", store)
  return () => vi.unstubAllGlobals()
}

/** Fails every wallet-store transaction that writes one of `keys`. */
const refuseWrites = (keys: () => readonly string[]) => {
  testWalletDbs().onApply = (_version, ops) => {
    if (ops.some(([key]) => keys().includes(key))) throw new Error("QuotaExceededError")
  }
}

async function record(
  service: WebAlphaAuthService,
  created: Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>,
  l2Address: string,
) {
  await service.recordRecoveryMetadata({
    credentialId: created.credentialId,
    l2Address,
    pubkey: created.pubkey,
    prfSlot: created.prfSlot,
    isMskRoot: true,
    transports: created.transports,
  })
}

describe("WebAlphaAuthService user handle", () => {
  it("records the handle the passkey was created under", async () => {
    const { service, ceremony, storage } = phone()
    const created = await service.createPasskey("alice")
    await record(service, created, "0xabc")
    const handle = bytesToBase64Url(ceremony.creds.get(created.credentialId)!.handle)
    const map = new WebPasskeyIdentityMap(storage, "localhost")
    expect((await map.get(created.credentialId))?.userHandle).toBe(handle)
  })

  it("records a creation the driver judged a security key as one, beside its platform type", async () => {
    const { service, storage } = laptop(KEY)
    const created = await service.createPasskey("alice")
    await record(service, created, "0xabc")
    const entry = await new WebPasskeyIdentityMap(storage, "localhost").get(created.credentialId)
    expect(entry?.securityKey).toBe(true)
    expect(entry?.authenticatorType).toBeUndefined()

    const synced = phone()
    const other = await synced.service.createPasskey("alice")
    await record(synced.service, other, "0xabc")
    const map = new WebPasskeyIdentityMap(synced.storage, "localhost")
    expect((await map.get(other.credentialId))?.securityKey).toBeUndefined()
  })
})

/** A YubiKey: answers from another device, over USB, and cannot be backed up. */
const KEY: FakeCeremonyOptions = {
  manager: "security-key",
  transports: ["usb"],
  backupEligible: false,
}
/** What a sign-in browser infers for a key: every physical route but `ble`. */
const PHYSICAL = ["usb", "nfc", "smart-card"]
const MAP_KEY = "obsidion_web_passkey_identity_map"

/** Another browser holding the same authenticators: a service over its own storage. */
const freshOver = (
  ceremony: PasskeyCeremony,
  storage: MemoryStorage = new MemoryStorage(),
  posture: DevicePosture = "laptop",
) => new WebAlphaAuthService({ storage, rpId: "localhost", ceremony, posture: () => posture })

const storedEntry = async (storage: MemoryStorage, credentialId: string) =>
  JSON.parse((await storage.getItem(MAP_KEY)) ?? '{"entries":{}}').entries[credentialId]

const signWith = (provider: { createAuthWit: (m: Fr) => Promise<unknown> }) =>
  provider.createAuthWit(Fr.random())

/** A ceremony that can be told to refuse the next assertion the way a browser does. */
function refusable(opts: FakeCeremonyOptions) {
  const inner = new FakePasskeyCeremony({ route: "cross-device", ...opts })
  const state = { refuse: false }
  const requests: PasskeyAssertRequest[] = []
  const ceremony: PasskeyCeremony = {
    create: (request) => inner.create(request),
    assert: async (request) => {
      requests.push(request)
      if (state.refuse)
        throw Object.assign(new Error("no authenticator"), { name: "NotAllowedError" })
      return inner.assert(request)
    },
  }
  return { ceremony, state, last: () => requests.at(-1)! }
}

/** Storage whose identity-map writes can be held or refused. */
class GatedStorage extends MemoryStorage {
  gate?: () => Promise<void>
  override async setItem(key: string, value: string) {
    if (key === MAP_KEY && this.gate) await this.gate()
    return super.setItem(key, value)
  }
}

describe("WebAlphaAuthService signing steering", () => {

  it("a browser that signed in with a key is steered in the same session; a recorded list wins", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const fresh = freshOver(ceremony)
    const recovered = await fresh.recoverPasskey({
      credentialId: created.credentialId,
    })
    await signWith(recovered.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)

    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
      transports: ["usb"],
    })
    await signWith(recovered.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("a synced creation list vetoes a fresh inference, from a signature or a sign-in", async () => {
    const { service, ceremony, storage } = laptop({ transports: ["hybrid"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xacct")
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")

    // Answers shaped like a key's, as a provider from before the backup gate might give.
    ceremony.opts.backupEligible = false
    await signWith(created.authProvider)
    await flush()
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!).not.toHaveProperty("transports")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
  })

  it("a heal the store refuses never fails the signature; the memo still steers", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new GatedStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
    const provider = fresh.providerFor({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
      passkeys: [created.pubkey],
    })
    await signWith(provider)
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
    await signWith(provider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(PHYSICAL)
  })

  it("a clear the store holds or refuses still leaves the next attempt unsteered", async () => {
    const { ceremony, state, last } = refusable(KEY)
    const created = await freshOver(ceremony).createPasskey("@alice")
    const passkey = {
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
      passkeys: [created.pubkey],
    }

    // Refused: the clear never lands, so the stored inference outlives this session.
    const storage = new GatedStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const provider = fresh.providerFor(passkey)
    await signWith(provider)
    await flush()
    storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
    state.refuse = true
    await expect(signWith(provider)).rejects.toMatchObject({ name: "NotAllowedError" })
    await flush()
    state.refuse = false
    await signWith(provider)
    expect(last()).not.toHaveProperty("transports")
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
    // A later session steers on the stale inference once, then suppresses on its own refusal.
    storage.gate = undefined
    const later = freshOver(ceremony, storage)
    const laterProvider = later.providerFor(passkey)
    state.refuse = true
    await expect(signWith(laterProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last().transports).toEqual(PHYSICAL)
    state.refuse = false
    await signWith(laterProvider)
    expect(last()).not.toHaveProperty("transports")

    // Held: the attempt issued before the clear lands is already unsteered.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = new GatedStorage()
    const slowService = freshOver(ceremony, slow)
    await slowService.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    const slowProvider = slowService.providerFor(passkey)
    await signWith(slowProvider)
    await flush()
    slow.gate = () => held
    state.refuse = true
    await expect(signWith(slowProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last().transports).toEqual(PHYSICAL)
    await expect(signWith(slowProvider)).rejects.toMatchObject({ name: "NotAllowedError" })
    expect(last()).not.toHaveProperty("transports")
    release()
    await flush()
    expect((await storedEntry(slow, created.credentialId)).inferredTransports).toBeUndefined()
    // An answer after the clear teaches again, in order behind it.
    state.refuse = false
    await signWith(slowProvider)
    await flush()
    expect((await storedEntry(slow, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })
})

describe("WebAlphaAuthService learns transports from sign-in", () => {
  const recordWithout = (
    service: WebAlphaAuthService,
    created: Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>,
  ) =>
    service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })

  it("a sign-in the PRF gate then refuses still teaches", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await recordWithout(service, created)
    ceremony.opts.prfAtAssert = false
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).rejects.toBeInstanceOf(NoPrfError)
    await flush()
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })

  it("a record written after a key sign-in on a fresh browser carries the inference", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    const storage = new MemoryStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recoverPasskey({ credentialId: created.credentialId })
    await recordWithout(fresh, created)
    expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(PHYSICAL)
  })

  it("a record with a creation list never takes an inference", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xacct")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await recordWithout(service, created)
    const entry = await storedEntry(storage, created.credentialId)
    expect(entry.transports).toEqual(["usb"])
    expect(entry.inferredTransports).toBeUndefined()
    await signWith(created.authProvider)
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("a heal the store refuses never fails the unlock; a refused record write still throws", async () => {
    const restore = stubLocalStorage()
    try {
      const ceremony = new FakePasskeyCeremony({ route: "cross-device", ...KEY })
      const storage = new GatedStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      await recordWithout(service, created)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
      await service.unlock(deriveFor(created, "0xacct"), {})
      expect(service.isUnlocked()).toBe(true)
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
      await expect(recordWithout(service, created)).rejects.toThrow(/Quota/)
    } finally {
      restore()
    }
  })

  it("a clear still in flight does not lose what the unlock after it learns", async () => {
    const restore = stubLocalStorage()
    try {
      const { ceremony, state, last } = refusable(KEY)
      const storage = new GatedStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      await recordWithout(service, created)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const passkey = {
        credentialId: created.credentialId,
        pubkeyHex: created.pubkey,
        passkeys: [created.pubkey],
      }
      const provider = service.providerFor(passkey)
      await signWith(provider)
      await flush()

      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      storage.gate = () => held
      state.refuse = true
      await expect(signWith(provider)).rejects.toMatchObject({ name: "NotAllowedError" })
      state.refuse = false
      service.clear()
      // The unlock completes while the clear still holds the map: its heal is queued, not awaited.
      await service.unlock(deriveFor(created, "0xacct"), {})
      expect(service.isUnlocked()).toBe(true)
      release()
      await flush()
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toEqual(
        PHYSICAL,
      )

      const later = freshOver(ceremony, storage)
      await signWith(later.providerFor(passkey))
      expect(last().transports).toEqual(PHYSICAL)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService learns where a synced passkey answered", () => {
  const answered = async (storage: MemoryStorage, credentialId: string) =>
    (await storedEntry(storage, credentialId))?.answered

  /** A service holding a record for a passkey a phone made over QR. */
  async function recorded(opts: ServiceOptions = {}) {
    const made = makeService({
      posture: "laptop",
      route: "cross-device",
      trustsAttachmentLabel: true,
      ...opts,
    })
    const created = await made.service.createPasskey("@alice")
    await record(made.service, created, "0xacct")
    return { ...made, created }
  }

  it("each signature records where it answered from: QR records remote, this computer records local", async () => {
    const { ceremony, storage, created } = await recorded()
    expect(await answered(storage, created.credentialId)).toBeUndefined()

    await signWith(created.authProvider)
    await flush()
    expect(await answered(storage, created.credentialId)).toBe("remote")

    ceremony.opts.route = "local"
    await signWith(created.authProvider)
    await flush()
    expect(await answered(storage, created.credentialId)).toBe("local")

    ceremony.opts.route = "cross-device"
    await signWith(created.authProvider)
    await flush()
    expect(await answered(storage, created.credentialId)).toBe("remote")
  })

  it("a hardware key records nothing", async () => {
    const { storage, created } = await recorded(KEY)
    await signWith(created.authProvider)
    await flush()
    expect(await answered(storage, created.credentialId)).toBeUndefined()
  })

  it("a local answer is recorded only where the browser's label is believed", async () => {
    for (const opts of [{ trustsAttachmentLabel: false }, { misreportsCrossDevice: true }]) {
      const { ceremony, storage, created } = await recorded(opts)
      ceremony.opts.route = "local"
      await signWith(created.authProvider)
      await flush()
      expect(await answered(storage, created.credentialId)).toBeUndefined()
    }
  })

  it("a phone records nothing", async () => {
    const { storage, created } = await recorded({ posture: "phone", route: "local" })
    await signWith(created.authProvider)
    await flush()
    expect(await answered(storage, created.credentialId)).toBeUndefined()
  })

  it("a cancelled sign-in records nothing, then or when the record is next written", async () => {
    const restore = stubLocalStorage()
    try {
      const { withWebLock } = await import("../../../src/platform/storage/webLock")
      const { service, storage, created } = await recorded()
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const holding = withWebLock("webwallet.passkey-identity-map", () => held)
      const ctrl = new AbortController()
      await service.recoverPasskey({ credentialId: created.credentialId, signal: ctrl.signal })
      ctrl.abort()
      release()
      await holding
      await flush()
      expect(await answered(storage, created.credentialId)).toBeUndefined()

      await record(service, created, "0xacct")
      expect(await answered(storage, created.credentialId)).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("an answer seen by an attempt cancelled afterwards never reaches a later record", async () => {
    const { ceremony, created } = await recorded()
    const storage = new MemoryStorage()
    const fresh = new WebAlphaAuthService({
      storage,
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      trustsAttachmentLabel: () => true,
      misreportsCrossDevice: () => false,
    })
    ceremony.opts.route = "local"
    const ctrl = new AbortController()
    await fresh.recoverPasskey({ credentialId: created.credentialId, signal: ctrl.signal })
    await flush()
    ctrl.abort()

    ceremony.opts.route = "cross-device"
    await fresh.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    expect(await answered(storage, created.credentialId)).toBe("remote")
  })

  it("the key-settling second assertion teaches too", async () => {
    const { ceremony, created } = await recorded()
    const storage = new MemoryStorage()
    const fresh = new WebAlphaAuthService({
      storage,
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      trustsAttachmentLabel: () => true,
      misreportsCrossDevice: () => false,
    })
    const begun = await fresh.beginRecovery({ credentialId: created.credentialId })
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    ceremony.opts.route = "local"
    await begun.settle()
    await flush()
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    expect(await answered(storage, created.credentialId)).toBe("local")
  })

  it("a write the store refuses never fails the signature", async () => {
    const { ceremony, created } = await recorded()
    const storage = new GatedStorage()
    const fresh = freshOver(ceremony, storage)
    await fresh.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      isMskRoot: true,
    })
    storage.gate = () => Promise.reject(new Error("QuotaExceededError"))
    await signWith(
      fresh.providerFor({
        credentialId: created.credentialId,
        pubkeyHex: created.pubkey,
        passkeys: [created.pubkey],
      }),
    )
    await flush()
    expect(await answered(storage, created.credentialId)).toBeUndefined()
  })
})

describe("WebAlphaAuthService.createPasskey", () => {

  it("laptop: waits five minutes, under the signal its caller can end", async () => {
    const { service, ceremony } = laptop()
    const controller = new AbortController()
    await service.createPasskey("@alice", undefined, { signal: controller.signal })
    expect(ceremony.creates[0]!.timeoutMs).toBe(300_000)
    expect(ceremony.creates[0]!.signal).toBe(controller.signal)
  })

  it("laptop: a passkey answered locally is refused before any further prompt", async () => {
    const { service, ceremony } = makeService({ posture: "laptop", route: "local" })
    // A sign-up has no passkey yet: the refusal says where to create one.
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "PhoneRequiredError",
      providerName: undefined,
      message: new PhoneRequiredError({ ceremony: "create" }).message,
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("laptop: with no injected answer, the live browser decides whether a refusal names Windows Hello", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    })
    try {
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony: new FakePasskeyCeremony({ route: "local", aaguid: WINDOWS_HELLO_AAGUID }),
        posture: () => "laptop",
        misreportsCrossDevice: () => false,
      })
      await expect(service.createPasskey("@alice")).rejects.toMatchObject({
        providerName: "Windows Hello",
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("phone: a passkey answered by another device is refused", async () => {
    const { service } = makeService({ posture: "phone", route: "cross-device" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "LocalPasskeyRequiredError",
    })
  })

  describe("on this computer's route", () => {
    const WINDOWS: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm"],
      withdrawn: [],
    }
    /** Windows Chrome, whose label for which device answered is trusted. */
    const held = (opts: FakeCeremonyOptions = {}) => {
      const made = makeService({
        posture: "laptop",
        route: "local",
        aaguid: GPM_AAGUID,
        trustsAttachmentLabel: true,
        ...opts,
      })
      made.service.useLaptopCreation(WINDOWS)
      return made
    }

    it.each([
      ["computer", "this-device", "local", ["client-device", "security-key"], "mac_local"],
      ["1password", "this-device", "local", ["client-device"], "mac_local"],
      ["phone", "phone", "cross-device", ["hybrid", "security-key"], "mac_qr"],
      ["key", "security-key", "cross-device", ["security-key"], "mac_key"],
    ] as const)(
      "the %s option asks for the %s route and writes its route into the handle",
      async (choice, route, answers, hints, context) => {
        const { service, ceremony } = makeService({
          posture: "laptop",
          route: answers,
          aaguid: GPM_AAGUID,
          trustsAttachmentLabel: true,
          userAgent: () => Promise.resolve(parseUserAgent({ userAgent: MAC_CHROME_UA })),
        })
        service.useLaptopCreation(
          {
            local: true,
            os: "macos",
            row: "macChrome",
            managers: ["apple", "gpm", "1password"],
            withdrawn: [],
          },
          choice,
        )
        // Only the request is asserted: what answers it is the driver suite's.
        await service.createPasskey("@alice", undefined, { route }).catch(() => undefined)
        const request = ceremony.creates[0]!
        expect(request.hints).toEqual(hints)
        expect(request.provenance?.context).toBe(context)
      },
    )

    it("takes the snapshot before its first wait, so a later one serves only the next creation", async () => {
      let release!: () => void
      const reading = new Promise<UserAgentInfo>((resolve) => {
        release = () => resolve(parseUserAgent({ userAgent: MAC_CHROME_UA }))
      })
      const { service, ceremony } = makeService({
        posture: "laptop",
        route: "local",
        aaguid: GPM_AAGUID,
        trustsAttachmentLabel: true,
        userAgent: () => reading,
      })
      service.useLaptopCreation(WINDOWS, "1password")
      const first = service.createPasskey("@alice", undefined, { route: "this-device" })
      service.useLaptopCreation(WINDOWS, "computer")
      release()
      await first
      expect(ceremony.creates[0]!.hints).toEqual(["client-device"])
      await service.createPasskey("@alice", undefined, { route: "this-device" })
      expect(ceremony.creates[1]!.hints).toEqual(["client-device", "security-key"])
    })

    it("a cancelled creation leaves nothing held", async () => {
      let release!: () => void
      const reading = new Promise<UserAgentInfo>((resolve) => {
        release = () => resolve(parseUserAgent({ userAgent: MAC_CHROME_UA }))
      })
      const { service, ceremony } = makeService({
        posture: "laptop",
        route: "local",
        aaguid: GPM_AAGUID,
        userAgent: () => reading,
      })
      service.useLaptopCreation(WINDOWS, "1password")
      const controller = new AbortController()
      const creating = service.createPasskey("@alice", undefined, {
        route: "this-device",
        signal: controller.signal,
      })
      controller.abort(new DOMException("the screen left", "AbortError"))
      release()
      await expect(creating).rejects.toMatchObject({ name: "AbortError" })
      await expect(
        service.createPasskey("@alice", undefined, { route: "this-device" }),
      ).rejects.toThrow("laptop creation was not offered")
      expect(ceremony.creates).toHaveLength(0)
    })

    it("a snapshot is consumed by whatever creation follows, whichever route it takes", async () => {
      const { service, ceremony } = held({ route: "cross-device" })
      await service.createPasskey("@alice", undefined, { route: "phone" })
      expect(ceremony.creates[0]!.hints).toEqual(["hybrid", "security-key"])
      await expect(
        service.createPasskey("@alice", undefined, { route: "this-device" }),
      ).rejects.toThrow("laptop creation was not offered")
    })

    it.each([
      ["Safari's row", "macSafari", true],
    ] as const)(
      "an Apple answer with no key is refused with no follow-up, and the next probe on %s keeps 1Password alone",
      async (_, name, trusted) => {
        const managers = ["apple", "1password"] as const
        const row: LaptopCreation = { local: true, os: "macos", row: name, managers, withdrawn: [] }
        const after: LaptopCreation = {
          local: true,
          os: "macos",
          row: name,
          managers: ["1password"],
          withdrawn: [],
        }
        const ceremony = new FakePasskeyCeremony({
          route: "local",
          manager: "icloud",
          aaguid: APPLE_ICLOUD_AAGUID,
          prfAtCreate: false,
          prfAtAssert: false,
        })
        const service = new WebAlphaAuthService({
          storage: new MemoryStorage(),
          rpId: "localhost",
          ceremony,
          posture: () => "laptop",
          trustsAttachmentLabel: () => trusted,
          laptopCreation: async () => row,
        })
        expect(await service.probeLaptopCreation()).toEqual(row)
        service.useLaptopCreation(row)
        await expect(
          service.createPasskey("@alice", undefined, { route: "this-device" }),
        ).rejects.toMatchObject({
          name: "LaptopPasskeyRefusedError",
          kind: "apple",
          appleRefusedHere: true,
          managers: managers.filter((m) => m !== "apple"),
        })
        expect(ceremony.assertRequests).toHaveLength(0)
        expect(await service.probeLaptopCreation()).toEqual(after)
      },
    )

    it("leaves the next probe alone after a withdrawn Apple Passwords is refused", async () => {
      const row: LaptopCreation = {
        local: true,
        os: "macos",
        row: "macChrome",
        managers: ["gpm"],
        withdrawn: ["apple"],
      }
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony: new FakePasskeyCeremony({ route: "local", aaguid: APPLE_ICLOUD_AAGUID }),
        posture: () => "laptop",
        trustsAttachmentLabel: () => true,
        laptopCreation: async () => row,
      })
      service.useLaptopCreation(row)
      await expect(
        service.createPasskey("@alice", undefined, { route: "this-device" }),
      ).rejects.toMatchObject({ kind: "apple", appleRefusedHere: false })
      expect(await service.probeLaptopCreation()).toEqual(row)
    })

    it("under the e2e seam the request still asks this device, with no hints", async () => {
      const ceremony = new FakePasskeyCeremony({ route: "local", aaguid: GPM_AAGUID })
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
        misreportsCrossDevice: () => false,
        trustsAttachmentLabel: () => false,
        laptopHints: null,
      })
      service.useLaptopCreation(WINDOWS)
      const result = await service.createPasskey("@alice", undefined, { route: "this-device" })
      expect(result.prfSlot).toBe("second")
      expect(ceremony.creates[0]!.authenticatorAttachment).toBe("platform")
      expect(ceremony.creates[0]!.hints).toBeUndefined()
    })

    describe("where a script answers the page's passkey creation", () => {
      const WINDOWS_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
      const browser = (brand: string, create: unknown) =>
        vi.stubGlobal("navigator", {
          userAgent: WINDOWS_UA,
          userAgentData: {
            platform: "Windows",
            brands: [{ brand, version: "155" }],
            getHighEntropyValues: async () => ({ platformVersion: "15.0.0" }),
          },
          credentials: { create },
        })
      // The count is kept about the browser, and this suite's environment has no localStorage.
      beforeEach(() => void stubLocalStorage())
      afterEach(() => vi.unstubAllGlobals())

      it("counts an answer from a manager the row does not admit, before the refusal reaches the caller", async () => {
        browser("Google Chrome", async () => null)
        const { service } = held({ aaguid: WINDOWS_HELLO_AAGUID })
        await expect(
          service.createPasskey("@alice", undefined, { route: "this-device" }),
        ).rejects.toMatchObject({ name: "UnsupportedProviderError" })
        expect(localRefusalCount()).toBe(1)
      })

      it("clears the count when the driver accepts the passkey", async () => {
        browser("Google Chrome", async () => null)
        noteLocalRefusal()
        noteLocalRefusal()
        noteLocalRefusal()
        await held().service.createPasskey("@alice", undefined, { route: "this-device" })
        expect(localRefusalCount()).toBe(0)
      })

      it("leaves the count alone for a missing key, for the phone route, and with no extension", async () => {
        browser("Google Chrome", async () => null)
        noteLocalRefusal()
        const silent = held({ prfAtCreate: false, prfAtAssert: false })
        await expect(
          silent.service.createPasskey("@alice", undefined, { route: "this-device" }),
        ).rejects.toMatchObject({ name: "NoPrfError", manager: "gpm" })
        const byPhone = held({ route: "cross-device" })
        await byPhone.service.createPasskey("@alice", undefined, { route: "phone" })
        expect(localRefusalCount()).toBe(1)

        browser("Google Chrome", Object.create)
        const hello = held({ aaguid: WINDOWS_HELLO_AAGUID })
        await expect(
          hello.service.createPasskey("@alice", undefined, { route: "this-device" }),
        ).rejects.toMatchObject({ name: "UnsupportedProviderError" })
        expect(localRefusalCount()).toBe(1)
      })
    })

    it("a browser that never answers a probe does not hold the sheet", async () => {
      vi.useFakeTimers()
      vi.stubGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        userAgentData: {
          platform: "Windows",
          brands: [{ brand: "Google Chrome", version: "155" }],
          getHighEntropyValues: () => new Promise(() => {}),
        },
      })
      try {
        const service = new WebAlphaAuthService({
          storage: new MemoryStorage(),
          rpId: "localhost",
          ceremony: new FakePasskeyCeremony({ route: "local", aaguid: GPM_AAGUID }),
          posture: () => "laptop",
        })
        const probes = Promise.all([service.probePhoneReach(), service.probeLaptopCreation()])
        await vi.advanceTimersByTimeAsync(1000)
        expect(await probes).toEqual(["unknown", { local: false, chromeTip: false }])
      } finally {
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    })
  })

  it("phone: a provider that evaluates one salt only is refused", async () => {
    const { service } = phone({ secondSlot: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "SingleSaltProviderError",
    })
  })

  it("refuses to serialize a signature the witness cannot carry, rather than truncating it", async () => {
    // Every assertion this authenticator gives back carries extension bytes, so no fresh one can
    // rescue the witness either. A truncated witness would fail on chain with nothing to explain it.
    const { service } = laptop({ extensionBytes: 10, extensionsAlways: true })
    const result = await service.createPasskey("@alice")
    await expect(result.authProvider.createAuthWit(Fr.random())).rejects.toThrow(/witness carries/)
  })

  it("no PRF from create nor the chained assertion is a hard stop, and the next attempt is fresh", async () => {
    const { service, ceremony } = laptop({ prfAtCreate: false, prfAtAssert: false })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({ name: "NoPrfError" })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({ name: "NoPrfError" })
    expect(ceremony.creates).toHaveLength(2)
    expect(await service.getSecretKey()).toBeUndefined()
  })

  it("createPasskey after commitSecret derives a fresh MSK and leaves the committed one untouched", async () => {
    const { service, ceremony } = laptop()
    const first = await service.createPasskey("@alice")
    await service.commitSecret({ secretKey: first.secretKey, authProvider: first.authProvider })
    const second = await service.createPasskey("@alice")
    expect(second.credentialId).not.toBe(first.credentialId)
    expect(second.secretKey.toString()).toBe(msk(ceremony.prfFor(second.credentialId, "first")))
    expect((await service.getSecretKey())?.toString()).toBe(first.secretKey.toString())
    expect(await service.getAuthProvider()).toBe(first.authProvider)
  })
})

describe("WebAlphaAuthService on a browser that mislabels a cross-device answer", () => {
  const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"
  it("reads the live user agent when the option is omitted", async () => {
    const safari18 =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    const live = (userAgent: string) => {
      vi.stubGlobal("navigator", { userAgent })
      const ceremony = new FakePasskeyCeremony({
        route: "cross-device",
        manager: "icloud",
        aaguid: ICLOUD,
        transports: ["hybrid", "internal"],
        attachment: "platform",
      })
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      return service.createPasskey("@alice")
    }
    try {
      expect((await live(safari18)).prfSlot).toBe("first")
      await expect(live(chrome)).rejects.toMatchObject({ name: "PhoneRequiredError" })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("WebAlphaAuthService.recoverPasskey", () => {

  it("laptop: a locally answered assertion is admitted, and the recovery alone commits nothing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xabc")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      ceremony.opts.route = "local"
      const recovered = await service.recoverPasskey({ credentialId: created.credentialId })
      expect(recovered.observed?.attachment).toBe("platform")
      expect(recovered.expectedAddress).toBe("0xabc")
      // Nothing moves until the caller anchors and commits the candidate.
      expect(await service.getSecretKey()).toBeUndefined()
      expect(getActiveCredentialId()).toBe(created.credentialId)
    } finally {
      restore()
    }
  })

  it("phone: its own passkey is accepted and no hint is sent", async () => {
    const { service, ceremony } = phone()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const recovered = await service.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.candidates.second?.toString()).toBe(created.secretKey.toString())
    expect(recovered.preferredSlot).toBe("second")
    expect(ceremony.assertRequests.at(-1)!.hints).toBeUndefined()
  })

  it("creates and opens a wallet on a key that reports no backup from the first ceremony", async () => {
    // A real key reports no backup at creation too, and usually returns its key material only on
    // the chained assertion; both are set here so the whole path runs as it would in the field.
    const { service } = laptop({
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
      prfAtCreate: false,
    })
    const restore = stubLocalStorage()
    try {
      const created = await service.createPasskey("@alice")
      expect(created.prfSlot).toBe("first")
      await record(service, created, "0xabc")
      const recovered = await service.recoverPasskey({
        credentialId: created.credentialId,
      })
      expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())

      // "Opens" has to mean the anchored unlock commits it, not just that candidates came back.
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await service.unlock(deriveFor(created, "0xabc"), {})
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("fresh browser (no record): two assertions recover the key, both candidates come back", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    // New service over EMPTY storage — same ceremony (the "synced credential").
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    ceremony.assertRequests = []
    const recovered = await fresh.recoverPasskey({})
    expect(ceremony.assertRequests).toHaveLength(2)
    expect(recovered.pubkey).toBe(created.pubkey)
    expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(recovered.candidates.second).toBeDefined()
    expect(recovered.expectedAddress).toBeUndefined()
    expect(recovered.preferredSlot).toBe("first")
  })
})

describe("WebAlphaAuthService.beginRecovery", () => {
  /** A browser with no record, over the same authenticator the passkey was created on. */
  async function freshBrowser(opts: FakeCeremonyOptions = {}) {
    const { service, ceremony } = laptop(opts)
    const created = await service.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    ceremony.assertRequests = []
    ceremony.asserts = []
    return { fresh, ceremony, created }
  }

  it("settle(): a second assertion over another random challenge recovers the shared key", async () => {
    const { fresh, ceremony, created } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const settled = await begun.settle()
    expect(settled.pubkey).toBe(created.pubkey)
    expect(ceremony.assertRequests).toHaveLength(2)
    const firstAsk = ceremony.assertRequests[0]!
    const second = ceremony.assertRequests[1]!
    expect(second.credentialIds).toEqual([created.credentialId])
    expect(second.prfFirstSalt).toBeUndefined()
    expect(second.prfSecondSalt).toBeUndefined()
    // Two different messages: only the key that signed both is recovered by both.
    expect(Buffer.from(second.challenge).equals(Buffer.from(firstAsk.challenge))).toBe(false)
    // Nothing is held from either assertion: a witness is a third prompt.
    await settled.authProvider.createAuthWit(Fr.random())
    expect(ceremony.assertRequests).toHaveLength(3)
  })

  it("beginRecovery hands the attempt to its assertion, and a cancelled one asks nothing", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const live = new AbortController()
    await fresh.beginRecovery({ discover: true, signal: live.signal })
    expect(ceremony.assertRequests[0]!.signal).toBe(live.signal)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(fresh.beginRecovery({ signal: cancelled.signal })).rejects.toThrow(/abort/i)
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("settle() hands the attempt to the second assertion, and a cancelled one asks nothing", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const live = new AbortController()
    await begun.settle(undefined, live.signal)
    expect(ceremony.assertRequests[1]!.signal).toBe(live.signal)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(begun.settle(undefined, cancelled.signal)).rejects.toThrow(/abort/i)
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("settle(key) refuses a key the signature does not recover to, without a prompt", async () => {
    const { fresh, ceremony } = await freshBrowser()
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const other = await laptop().service.createPasskey("@bob")
    await expect(begun.settle(other.pubkey)).rejects.toThrow(/not a candidate/)
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("a wrong candidate never signs, even for an authenticator that repeats signatures", async () => {
    const { fresh, ceremony, created } = await freshBrowser({ stableAuthenticator: true })
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const wrong = begun.pubkeyCandidates.find((k) => k !== created.pubkey)!
    const settled = await begun.settle(wrong)
    expect(settled.pubkey).toBe(wrong)
    for (let i = 0; i < 2; i++) {
      await expect(settled.authProvider.createAuthWit(Fr.random())).rejects.toMatchObject({
        name: "SignerKeyMismatchError",
      })
    }
    // Each attempt asked the passkey and got the same signature back; neither passed the check.
    expect(ceremony.assertRequests).toHaveLength(3)
  })

  it("the chooser returning a recorded credential settles from the record, and a witness costs a prompt", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    ceremony.assertRequests = []
    const begun = await service.beginRecovery({ discover: true })
    expect(isUnsettled(begun)).toBe(false)
    expect(ceremony.assertRequests).toHaveLength(1)
    if (isUnsettled(begun)) throw new Error("unreachable")
    expect(begun.pubkey).toBe(created.pubkey)
    await begun.authProvider.createAuthWit(Fr.random())
    expect(ceremony.assertRequests).toHaveLength(2)
  })

  it("the recorded passkey asked for, another answering: refused before anything is held", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const other = await ceremony.create({
      rpId: "localhost",
      rpName: "test",
      userName: "@bob",
      prfFirstSalt: new Uint8Array(32),
    })
    const answer = ceremony.assert.bind(ceremony)
    ceremony.assert = (request) => answer({ ...request, credentialIds: [other.credentialId] })
    await expect(
      service.beginRecovery({ credentialId: created.credentialId }),
    ).rejects.toMatchObject(UNASKED)
  })
})

describe("WebAlphaAuthService.unlock", () => {
  it("commits the candidate whose address matches this browser's record, on either slot", async () => {
    const restore = stubLocalStorage()
    try {
      for (const make of [laptop, phone]) {
        const { service } = make()
        const created = await service.createPasskey("@alice")
        await record(service, created, "0xacct")
        await service.commitSecret({
          secretKey: created.secretKey,
          authProvider: created.authProvider,
        })
        service.clear()
        await service.unlock(deriveFor(created, "0xacct"), {})
        expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      }
    } finally {
      restore()
    }
  })

  it("a record naming a key the passkey cannot have signed with is refused", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: "ff".repeat(64),
        prfSlot: created.prfSlot,
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await expect(service.unlock(deriveFor(created, "0xacct"), {})).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("refuses when neither candidate derives the recorded address", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      await expect(service.unlock(async () => "0xnever", {})).rejects.toThrow(/does not match/)
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a passkey that cannot be backed up and matches no record opens nothing", async () => {
    const restore = stubLocalStorage()
    try {
      // At sign-in another device's answer is exempt from the backup gate, so the anchor is the
      // only thing standing between it and a committed key. It has to be enough.
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      ceremony.opts.backupEligible = false
      await expect(service.unlock(async () => "0xnever", {})).rejects.toThrow(/does not match/)
      expect(await service.getSecretKey()).toBeUndefined()
      expect(service.isUnlocked()).toBe(false)
    } finally {
      restore()
    }
  })

  it("an active credential with no record goes to /enter, not to a ceremony", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      setActiveCredentialId("unknown-credential")
      await expect(service.unlock(async () => "0x", {})).rejects.toThrow(/enter with your passkey/)
      expect(ceremony.assertRequests).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it("never falls back to the newest root when the active credential is missing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      setActiveStorageId("storage-of-a")
      await expect(service.unlock(async () => "0xb", {})).rejects.toThrow(/enter with your passkey/)
      expect(ceremony.assertRequests).toHaveLength(0)
      expect(getActiveStorageId()).toBe("storage-of-a")
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("concurrent unlock() calls share one passkey ceremony", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const derive = deriveFor(created, "0xacct")
      const before = ceremony.assertRequests.length
      await Promise.all([
        service.unlock(derive, {}),
        service.unlock(derive, {}),
        service.unlock(derive, {}),
      ])
      expect(ceremony.assertRequests).toHaveLength(before + 1)
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())

      // The shared promise is released, so a later lock can unlock again.
      service.clear()
      await service.unlock(derive, {})
      expect(ceremony.assertRequests).toHaveLength(before + 2)
    } finally {
      restore()
    }
  })

  it("a prompt that outlives a commit in this tab leaves the newer key in place", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      service.clear()
      const assert = ceremony.assert.bind(ceremony)
      let release!: () => void
      vi.spyOn(ceremony, "assert").mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => (release = resolve))
        return assert(request)
      })
      const pending = service.unlock(deriveFor(a, "0xa"), {})
      await flush()
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      await service.commitSecret({ secretKey: b.secretKey, authProvider: b.authProvider })
      release()
      await expect(pending).rejects.toMatchObject({ name: "SessionChangedError" })
      expect((await service.getSecretKey())?.toString()).toBe(b.secretKey.toString())
      expect(readCachedMsk()?.credentialId).toBe(b.credentialId)
    } finally {
      restore()
    }
  })

  it("unlocks the session's passkey, not the newest root on the device", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const a = await service.createPasskey("@alice")
      await record(service, a, "0xa")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      expect(getActiveCredentialId()).toBe(a.credentialId)

      service.clear()
      const b = await service.createPasskey("@bob")
      await record(service, b, "0xb")
      // Bob is now the newest root on the device, but Alice's session is the active one.
      setActiveCredentialId(a.credentialId)
      service.clear()
      await service.unlock(deriveFor(a, "0xa"), {})
      expect((await service.getSecretKey())?.toString()).toBe(a.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("a failed recovery never moves the session passkey", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const a = await service.createPasskey("@alice")
      await service.commitSecret({ secretKey: a.secretKey, authProvider: a.authProvider })
      service.clear()
      const second = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: second.credentialId,
        l2Address: "0xa",
        pubkey: second.pubkey,
        isMskRoot: false,
      })
      await expect(
        service.recoverPasskey({ credentialId: second.credentialId }),
      ).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      expect(getActiveCredentialId()).toBe(a.credentialId)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService key/session management", () => {

  it("getDerivedKey: unknown domain throws pre-unlock; known domain derives 32 bytes post-commit", async () => {
    const { service } = laptop()
    await expect(service.getDerivedKey("nope")).rejects.toThrow(/Unknown derived-key domain/)
    await expect(service.getDerivedKey("pending-store")).rejects.toThrow(/MSK is not available/)
    const created = await service.createPasskey("@alice")
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    const key = await service.getDerivedKey("pending-store")
    expect(key).toHaveLength(32)
    expect(await service.getDerivedKey("pending-store")).toBe(key)
  })

  it("getAuthProvider rebuilds from the persisted MSK-root record after clear()", async () => {
    const { service } = laptop()
    expect(await service.getAuthProvider()).toBeUndefined()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const provider = await service.getAuthProvider()
    expect(provider).toBeDefined()
    const [x, y] = await provider!.getPubkeys()
    expect(Buffer.concat([x, y]).toString("hex")).toBe(created.pubkey)
  })

  it("a signature while locked signs for real, reads no PRF, and leaves the session locked", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xabc")
    service.clear()
    const provider = (await service.getAuthProvider())!
    ceremony.assertRequests = []
    ceremony.opts.route = "local"
    const witness = await provider.createAuthWit(Fr.random())
    expect(witness).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]!.prfFirstSalt).toBeUndefined()
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toBeUndefined()
    expect(await service.getSecretKey()).toBeUndefined()
  })
})

describe("WebAlphaAuthService — one prompt, no picker", () => {

  it("a discoverable recovery names no passkey, so one this browser never recorded may answer", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@bob")
    await record(service, created, "0xabc")
    service.clear()
    const other = await ceremony.create({
      rpId: "localhost",
      rpName: "test",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const asked: unknown[] = []
    const answer = ceremony.assert.bind(ceremony)
    ceremony.assert = (request) => {
      asked.push(request.credentialIds)
      return answer({ ...request, credentialIds: [other.credentialId] })
    }

    const begun = await service.beginRecovery({ discover: true })
    expect(asked).toEqual([undefined])
    expect(begun.credentialId).toBe(other.credentialId)
  })

  it("adoptAccountPasskey: one assertion on the listed credential, key checked against the signature", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    service.clear()
    ceremony.asserts = []

    const adopted = await service.adoptAccountPasskey(accountOf(rootKey(created)))
    expect(ceremony.asserts).toEqual([[created.credentialId]])
    expect(adopted.pubkey).toBe(created.pubkey)
    expect(adopted.candidates.first?.toString()).toBe(created.secretKey.toString())
    expect(adopted.candidates.second).toBeDefined()
    expect(adopted.passkeys).toEqual([created.pubkey])
    expect(adopted.backup).toBeUndefined()

    // The list names the credential under another key: not the one its signature recovers.
    const other = await service.createPasskey("@bob")
    await expect(
      service.adoptAccountPasskey(accountOf({ ...rootKey(created), pubkeyHex: other.pubkey })),
    ).rejects.toMatchObject({ name: "HintedKeyMismatchError" })
    // A credential the list does not name answers: the same refusal.
    ceremony.opts.assertOverride = () => other.credentialId
    await expect(service.adoptAccountPasskey(accountOf(rootKey(created)))).rejects.toMatchObject({
      name: "HintedKeyMismatchError",
    })
  })

  it("adoptAccountPasskey sends a recorded hardware key's transports on a laptop, so the sheet opens on the key", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    await service.adoptAccountPasskey(accountOf(rootKey(created)))
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["usb"])
  })

  it("adoptAccountPasskey sends nothing for a credential with no record, or with only an inferred list", async () => {
    const { service, ceremony, storage } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    service.clear()
    await service.adoptAccountPasskey(accountOf(rootKey(created)))
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()

    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xalice",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    const { WebPasskeyIdentityMap } = await import(
      "../../../src/platform/auth/WebPasskeyIdentityMap"
    )
    await new WebPasskeyIdentityMap(storage, "localhost").setInferredTransports(
      created.credentialId,
      ["usb"],
    )
    service.clear()
    await service.adoptAccountPasskey(accountOf(rootKey(created)))
    // The inference steers signatures (`steeringFor`); the recovery assertion sends only a creation list.
    expect(ceremony.assertRequests.at(-1)!.transports).toBeUndefined()
  })

  it("adoptAccountPasskey names a security key on a laptop only for a credential known to be one", async () => {
    // A recorded hardware key: named, so the sheet keeps its row and a manager's extension stands aside.
    const key = laptop(KEY)
    const created = await key.service.createPasskey("@alice")
    await record(key.service, created, "0xalice")
    key.service.clear()
    await key.service.adoptAccountPasskey(accountOf(rootKey(created)))
    expect(key.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device", "security-key"])

    // A synced record: not named, so the extension may answer from its copy.
    const synced = laptop({ transports: ["hybrid", "internal"] })
    const made = await synced.service.createPasskey("@alice")
    await record(synced.service, made, "0xalice")
    synced.service.clear()
    await synced.service.adoptAccountPasskey(accountOf(rootKey(made)))
    expect(synced.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device"])

    // No record: not named either. The key that answers teaches the session, so the next request names one.
    const unseen = laptop(KEY)
    const fresh = await unseen.service.createPasskey("@alice")
    unseen.service.clear()
    await unseen.service.adoptAccountPasskey(accountOf(rootKey(fresh)))
    expect(unseen.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device"])
    await unseen.service.adoptAccountPasskey(accountOf(rootKey(fresh)))
    expect(unseen.ceremony.assertRequests.at(-1)!.hints).toEqual(["client-device", "security-key"])
  })

  it("adoptAccountPasskey on a phone passes a record's list through, as beginRecovery does", async () => {
    const { service, ceremony } = phone({ transports: ["hybrid", "internal"] })
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    await service.adoptAccountPasskey(accountOf(rootKey(created)))
    expect(ceremony.assertRequests.at(-1)!.transports).toEqual(["hybrid", "internal"])
  })

  it("adoptAccountPasskey honours this browser's record: its address anchors, a record under another key is refused", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, "0xalice")
    service.clear()
    const hint = accountOf(rootKey(created))

    const adopted = await service.adoptAccountPasskey(hint)
    expect(adopted.expectedAddress).toBe("0xalice")
    expect(adopted.preferredSlot).toBe("first")
    expect(adopted.hasPersistedSlot).toBe(true)

    const other = await service.createPasskey("@bob")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xalice",
      pubkey: other.pubkey,
      isMskRoot: true,
    })
    await expect(service.adoptAccountPasskey(hint)).rejects.toMatchObject({
      name: "HintedKeyMismatchError",
    })
  })
})

describe("WebAlphaAuthService backup passkeys", () => {
  const ADDR = `0x${"aa".repeat(32)}`
  beforeEach(() => h.noteBackupSignIn.mockClear())

  it("a backup key's assertion opens its envelope: the sheet names both ids, the master key is the envelope's", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey, "second")
    service.clear()
    ceremony.asserts = []
    ceremony.opts.assertOverride = () => backup.credentialId
    const adopted = await service.adoptAccountPasskey(
      accountOf(rootKey(root), backupKey(backup, envelope)),
    )
    expect(ceremony.asserts).toEqual([[root.credentialId, backup.credentialId]])
    expect(adopted.credentialId).toBe(backup.credentialId)
    expect(adopted.pubkey).toBe(backup.pubkey)
    expect(adopted.candidates.first).toBeUndefined()
    expect(adopted.candidates.second?.toString()).toBe(root.secretKey.toString())
    expect(adopted.passkeys).toEqual([root.pubkey, backup.pubkey])
    expect(adopted.backup).toEqual({ account: ACCOUNT, envelope: hex(envelope) })
    expect(adopted.backupFacts).toEqual({ backupEligible: true })
    expect(h.noteBackupSignIn).not.toHaveBeenCalled()
  })

  it("a root whose raw id begins with 0x01, even shaped like an envelope, is named, alone and beside a backup, and derives from its PRF", async () => {
    const { service, ceremony } = phone()
    const made = await service.createPasskey("@alice")
    // 95 bytes: prefix-shaped, with a well-formed envelope header where a backup's would sit.
    const raw95 = new Uint8Array(95).map((_, i) => (i * 37 + 11) & 0xff)
    raw95[0] = 0x01
    raw95[33] = 0x01
    raw95[34] = 0x00
    const root = rekeyed(ceremony, made, bytesToBase64Url(raw95))
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    service.clear()
    ceremony.asserts = []
    const slot = root.prfSlot ?? "first"
    ceremony.opts.assertOverride = () => root.credentialId
    const alone = await service.adoptAccountPasskey(accountOf(rootKey(root)))
    expect(alone.candidates[slot]?.toString()).toBe(root.secretKey.toString())
    ceremony.opts.assertOverride = () => root.credentialId
    const beside = await service.adoptAccountPasskey(
      accountOf(rootKey(root), backupKey(backup, envelope)),
    )
    expect(ceremony.asserts).toEqual([
      [root.credentialId],
      [root.credentialId, backup.credentialId],
    ])
    expect(beside.credentialId).toBe(root.credentialId)
    expect(beside.candidates[slot]?.toString()).toBe(root.secretKey.toString())
    expect(beside.backup).toBeUndefined()
  })

  it("an assertion without a user handle still signs in, for a named root and a named backup", async () => {
    const { service, ceremony } = phone({ assertHandle: false })
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    service.clear()
    const listed = accountOf(rootKey(root), backupKey(backup, envelope))
    ceremony.opts.assertOverride = () => root.credentialId
    const asRoot = await service.adoptAccountPasskey(listed)
    expect(asRoot.userHandle).toBeUndefined()
    expect(asRoot.candidates[root.prfSlot ?? "first"]?.toString()).toBe(root.secretKey.toString())
    ceremony.opts.assertOverride = () => backup.credentialId
    const asBackup = await service.adoptAccountPasskey(listed)
    expect(asBackup.userHandle).toBeUndefined()
    expect(asBackup.candidates.first?.toString()).toBe(root.secretKey.toString())
  })

  it("a key the chain lists twice is one member of the set", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    service.clear()
    ceremony.opts.assertOverride = () => backup.credentialId
    const adopted = await service.adoptAccountPasskey(
      accountOf(rootKey(root), backupKey(backup, envelope), rootKey(root)),
    )
    expect(adopted.passkeys).toEqual([root.pubkey, backup.pubkey])
  })

  it("a device-bound backup opens on its device, where a device-bound root is refused", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    service.clear()
    ceremony.opts.backupEligible = false
    const keys = accountOf(rootKey(root), backupKey(backup, envelope))
    ceremony.opts.assertOverride = () => backup.credentialId
    const adopted = await service.adoptAccountPasskey(keys)
    expect(adopted.candidates.first?.toString()).toBe(root.secretKey.toString())
    expect(adopted.backupFacts).toEqual({ backupEligible: false })
    ceremony.opts.assertOverride = () => root.credentialId
    await expect(service.adoptAccountPasskey(keys)).rejects.toMatchObject({
      name: "DeviceBoundPasskeyError",
    })
  })

  it("an answer without user verification does not open the envelope: failed, observed", async () => {
    const { service, ceremony } = phone({ userVerified: false })
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    service.clear()
    ceremony.opts.assertOverride = () => backup.credentialId
    const err = await service
      .adoptAccountPasskey(accountOf(rootKey(root), backupKey(backup, envelope)))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PasskeyEnvelopeError)
    expect(err).toMatchObject({
      reason: "unverified",
      observed: { credentialId: backup.credentialId, attachment: "platform" },
    })
    expect(h.noteBackupSignIn).toHaveBeenCalledWith("failed", { backupEligible: true })
  })

  it("an envelope for another account, or sealed under another passkey's PRF, does not open", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    service.clear()
    const elsewhere = await sealFor(
      ceremony,
      backup,
      root.secretKey,
      "first",
      undefined,
      `0x${"22".repeat(20)}`,
    )
    ceremony.opts.assertOverride = () => backup.credentialId
    await expect(
      service.adoptAccountPasskey(accountOf(rootKey(root), backupKey(backup, elsewhere))),
    ).rejects.toMatchObject({ name: "PasskeyEnvelopeError", reason: "decrypt" })
    const rootsPrf = await sealFor(ceremony, root, root.secretKey)
    ceremony.opts.assertOverride = () => backup.credentialId
    await expect(
      service.adoptAccountPasskey(accountOf(rootKey(root), backupKey(backup, rootsPrf))),
    ).rejects.toMatchObject({ name: "PasskeyEnvelopeError", reason: "decrypt" })
    expect(h.noteBackupSignIn).toHaveBeenCalledTimes(2)
  })

  it("a record strictly ahead of the chain's list wins the set; otherwise the list does", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const later = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    const listed = accountOf(rootKey(root), backupKey(backup, envelope))
    ceremony.opts.assertOverride = () => backup.credentialId
    await service.recordRecoveryMetadata({
      credentialId: backup.credentialId,
      l2Address: ADDR,
      pubkey: backup.pubkey,
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: hex(envelope) },
      passkeySet: [root.pubkey, backup.pubkey, later.pubkey],
    })
    const ahead = await service.adoptAccountPasskey(listed)
    expect(ahead.passkeys).toEqual([root.pubkey, backup.pubkey, later.pubkey])
    expect(ahead.staleSet).toBeUndefined()
    // A record of the same size, or one missing a listed key, is not ahead of the chain.
    await service.recordRecoveryMetadata({
      credentialId: backup.credentialId,
      l2Address: ADDR,
      pubkey: backup.pubkey,
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: hex(envelope) },
      passkeySet: [backup.pubkey, later.pubkey],
    })
    ceremony.opts.assertOverride = () => backup.credentialId
    expect((await service.adoptAccountPasskey(listed)).passkeys).toEqual([
      root.pubkey,
      backup.pubkey,
    ])
  })

  it("a record the chain's list is strictly ahead of is stale: it keeps the anchor, the list is the set", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const later = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    const listed = accountOf(rootKey(root), backupKey(backup, envelope))
    await service.recordRecoveryMetadata({
      credentialId: root.credentialId,
      l2Address: ADDR,
      pubkey: root.pubkey,
      isMskRoot: true,
    })
    ceremony.opts.assertOverride = () => root.credentialId
    const stale = await service.adoptAccountPasskey(listed)
    expect(stale.passkeys).toEqual([root.pubkey, backup.pubkey])
    expect(stale.staleSet).toEqual([root.pubkey])
    expect(stale.expectedAddress).toBe(ADDR)
    // A record differing in any other way is neither ahead nor behind: the list is the set, anchored
    // on the record.
    await service.recordRecoveryMetadata({
      credentialId: root.credentialId,
      l2Address: ADDR,
      pubkey: root.pubkey,
      isMskRoot: true,
      passkeySet: [root.pubkey, later.pubkey],
    })
    ceremony.opts.assertOverride = () => root.credentialId
    const differing = await service.adoptAccountPasskey(listed)
    expect(differing.passkeys).toEqual([root.pubkey, backup.pubkey])
    expect(differing.staleSet).toBeUndefined()
    expect(differing.expectedAddress).toBe(ADDR)
  })

  it("a backup record the chain's list is ahead of is stale too: the envelope opens, the list is the set", async () => {
    const { service, ceremony } = phone()
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const later = await service.createPasskey("@alice")
    const envelope = await sealFor(ceremony, backup, root.secretKey)
    const laterEnvelope = await sealFor(ceremony, later, root.secretKey)
    await service.recordRecoveryMetadata({
      credentialId: backup.credentialId,
      l2Address: ADDR,
      pubkey: backup.pubkey,
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: hex(envelope) },
      passkeySet: [root.pubkey, backup.pubkey],
    })
    ceremony.opts.assertOverride = () => backup.credentialId
    const stale = await service.adoptAccountPasskey(
      accountOf(rootKey(root), backupKey(backup, envelope), backupKey(later, laterEnvelope)),
    )
    expect(stale.candidates.first?.toString()).toBe(root.secretKey.toString())
    expect(stale.passkeys).toEqual([root.pubkey, backup.pubkey, later.pubkey])
    expect(stale.staleSet).toEqual([root.pubkey, backup.pubkey])
    expect(stale.expectedAddress).toBe(ADDR)
    expect(stale.backup).toEqual({ account: ACCOUNT, envelope: hex(envelope) })
  })

  it("an unlock on a backup record: a device-bound passkey still opens, a wrong PRF is the failed event, a root record reports nothing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const root = await service.createPasskey("@alice")
      const backup = await service.createPasskey("@alice")
      const passkeys = [root.pubkey, backup.pubkey]
      const derive = deriveFor(root, ADDR, passkeys)
      const recordBackup = (envelope: Uint8Array) =>
        service.recordRecoveryMetadata({
          credentialId: backup.credentialId,
          l2Address: ADDR,
          pubkey: backup.pubkey,
          prfSlot: "first",
          isMskRoot: false,
          backup: { account: ACCOUNT, envelope: hex(envelope) },
          passkeySet: passkeys,
        })
      const session = async () => {
        await service.commitSecret({
          secretKey: root.secretKey,
          authProvider: service.providerFor({
            credentialId: backup.credentialId,
            pubkeyHex: backup.pubkey,
            passkeys,
          }),
        })
        service.clear()
        h.noteBackupSignIn.mockClear()
      }

      await recordBackup(await sealFor(ceremony, backup, root.secretKey))
      await session()
      ceremony.opts.backupEligible = false
      await service.unlock(derive, {})
      expect(service.isUnlocked()).toBe(true)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("succeeded", { backupEligible: false })
      ceremony.opts.backupEligible = true

      // Sealed under the root's PRF: the backup's assertion cannot open it.
      await recordBackup(await sealFor(ceremony, root, root.secretKey))
      await session()
      await expect(service.unlock(derive, {})).rejects.toMatchObject({
        name: "PasskeyEnvelopeError",
        reason: "decrypt",
      })
      expect(service.isUnlocked()).toBe(false)
      expect(h.noteBackupSignIn).toHaveBeenCalledTimes(1)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("failed", { backupEligible: true })

      await service.recordRecoveryMetadata({
        credentialId: root.credentialId,
        l2Address: ADDR,
        pubkey: root.pubkey,
        prfSlot: root.prfSlot,
        isMskRoot: true,
      })
      await service.commitSecret({ secretKey: root.secretKey, authProvider: root.authProvider })
      service.clear()
      h.noteBackupSignIn.mockClear()
      await service.unlock(deriveFor(root, ADDR), {})
      expect(service.isUnlocked()).toBe(true)
      expect(h.noteBackupSignIn).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it("an unlock on a backup record ends in one outcome: a cancel after the envelope opened, a record the key does not reproduce", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const root = await service.createPasskey("@alice")
      const backup = await service.createPasskey("@alice")
      const passkeys = [root.pubkey, backup.pubkey]
      const envelope = await sealFor(ceremony, backup, root.secretKey)
      await service.recordRecoveryMetadata({
        credentialId: backup.credentialId,
        l2Address: ADDR,
        pubkey: backup.pubkey,
        prfSlot: "first",
        isMskRoot: false,
        backup: { account: ACCOUNT, envelope: hex(envelope) },
        passkeySet: passkeys,
      })
      await service.commitSecret({
        secretKey: root.secretKey,
        authProvider: service.providerFor({
          credentialId: backup.credentialId,
          pubkeyHex: backup.pubkey,
          passkeys,
        }),
      })
      service.clear()
      h.noteBackupSignIn.mockClear()
      const cancel = new AbortController()
      const derive = deriveFor(root, ADDR, passkeys)
      const cancelling = async (msk: Fr, keys: readonly string[]) => {
        cancel.abort()
        return derive(msk, keys)
      }
      await expect(service.unlock(cancelling, { signal: cancel.signal })).rejects.toMatchObject({
        name: "AbortError",
      })
      expect(h.noteBackupSignIn).toHaveBeenCalledTimes(1)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("cancelled", { backupEligible: true })
      expect(service.isUnlocked()).toBe(false)

      h.noteBackupSignIn.mockClear()
      await expect(
        service.unlock(deriveFor(root, "0xelsewhere", passkeys), {}),
      ).rejects.toBeInstanceOf(StoredAddressMismatchError)
      expect(h.noteBackupSignIn).toHaveBeenCalledTimes(1)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("failed", { backupEligible: true })
      expect(service.isUnlocked()).toBe(false)
    } finally {
      restore()
    }
  })

  it("an unlock on a backup record cancelled inside the commit is the cancelled outcome", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const root = await service.createPasskey("@alice")
      const backup = await service.createPasskey("@alice")
      const passkeys = [root.pubkey, backup.pubkey]
      const envelope = await sealFor(ceremony, backup, root.secretKey)
      await service.recordRecoveryMetadata({
        credentialId: backup.credentialId,
        l2Address: ADDR,
        pubkey: backup.pubkey,
        prfSlot: "first",
        isMskRoot: false,
        backup: { account: ACCOUNT, envelope: hex(envelope) },
        passkeySet: passkeys,
      })
      await service.commitSecret({
        secretKey: root.secretKey,
        authProvider: service.providerFor({
          credentialId: backup.credentialId,
          pubkeyHex: backup.pubkey,
          passkeys,
        }),
      })
      service.clear()
      h.noteBackupSignIn.mockClear()
      const cancel = new AbortController()
      const inner = service as unknown as {
        commit: (input: unknown, owns?: () => boolean) => Promise<number | false>
      }
      const commit = inner.commit.bind(service)
      vi.spyOn(inner, "commit").mockImplementationOnce(async (input, owns) => {
        cancel.abort()
        return commit(input, owns)
      })
      await expect(
        service.unlock(deriveFor(root, ADDR, passkeys), { signal: cancel.signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(h.noteBackupSignIn).toHaveBeenCalledTimes(1)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("cancelled", { backupEligible: true })
      expect(service.isUnlocked()).toBe(false)
      expect(getActiveCredentialId()).toBe(backup.credentialId)
    } finally {
      restore()
    }
  })

  it("an unlock on a backup record opens the envelope under the record's set and reports the sign-in", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone({ aaguid: GPM_AAGUID })
      const root = await service.createPasskey("@alice")
      const backup = await service.createPasskey("@alice")
      const envelope = await sealFor(ceremony, backup, root.secretKey)
      const passkeys = [root.pubkey, backup.pubkey]
      await service.recordRecoveryMetadata({
        credentialId: backup.credentialId,
        l2Address: ADDR,
        pubkey: backup.pubkey,
        prfSlot: "first",
        prfAaguid: GPM_AAGUID,
        isMskRoot: false,
        backup: { account: ACCOUNT, envelope: hex(envelope) },
        passkeySet: passkeys,
      })
      await service.commitSecret({
        secretKey: root.secretKey,
        authProvider: service.providerFor({
          credentialId: backup.credentialId,
          pubkeyHex: backup.pubkey,
          passkeys,
        }),
      })
      service.clear()
      ceremony.asserts = []
      const derive = vi.fn(deriveFor(root, ADDR, passkeys))
      await service.unlock(derive, {})
      expect(service.isUnlocked()).toBe(true)
      expect(ceremony.asserts).toEqual([[backup.credentialId]])
      expect(derive).toHaveBeenCalledWith(root.secretKey, passkeys)
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("succeeded", {
        backupEligible: true,
        aaguid: GPM_AAGUID,
      })

      service.clear()
      h.noteBackupSignIn.mockClear()
      ceremony.opts.assertOverride = () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      }
      await expect(service.unlock(derive, {})).rejects.toBeDefined()
      expect(h.noteBackupSignIn).toHaveBeenCalledWith("cancelled", { aaguid: GPM_AAGUID })
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService a chosen key", () => {
  const ADDR = `0x${"aa".repeat(32)}`
  const EVERY_ROUTE = ["client-device", "hybrid", "security-key"]

  /** A two-key account on a laptop whose ceremonies the fake answers: a sign-up key and its backup. */
  async function twoKeys(opts: ServiceOptions = {}) {
    const made = laptop(opts)
    const root = await made.service.createPasskey("@alice")
    const backup = await made.service.createPasskey("@alice")
    const envelope = await sealFor(made.ceremony, backup, root.secretKey)
    const keys = accountOf(rootKey(root), backupKey(backup, envelope))
    made.service.clear()
    made.ceremony.assertRequests = []
    return { ...made, root, backup, envelope, keys }
  }

  it("adoptAccountPasskey names only the chosen key, on every route without a record, and still matches it against every key", async () => {
    const { service, ceremony, root, backup, envelope, keys } = await twoKeys()
    ceremony.opts.assertOverride = () => backup.credentialId
    const adopted = await service.adoptAccountPasskey({ ...keys, chosen: backup.credentialId })
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [backup.credentialId],
      hints: EVERY_ROUTE,
    })
    expect(adopted.credentialId).toBe(backup.credentialId)
    expect(adopted.candidates.first?.toString()).toBe(root.secretKey.toString())
    expect(adopted.passkeys).toEqual([root.pubkey, backup.pubkey])
    expect(adopted.backup).toEqual({ account: ACCOUNT, envelope: hex(envelope) })
  })

  it("a chosen key this browser recorded is asked over the routes its record names", async () => {
    const { service, ceremony, root, backup, envelope, keys } = await twoKeys(KEY)
    await service.recordRecoveryMetadata({
      credentialId: backup.credentialId,
      l2Address: ADDR,
      pubkey: backup.pubkey,
      prfSlot: "first",
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: hex(envelope) },
      passkeySet: [root.pubkey, backup.pubkey],
      transports: ["usb"],
    })
    ceremony.opts.assertOverride = () => backup.credentialId
    await service.adoptAccountPasskey({ ...keys, chosen: backup.credentialId })
    expect(ceremony.assertRequests[0]!.hints).toEqual(["security-key"])
  })

  it("a chosen credential the account does not list is refused before any prompt", async () => {
    const { service, ceremony, keys } = await twoKeys()
    await expect(
      service.adoptAccountPasskey({ ...keys, chosen: "not-listed" }),
    ).rejects.toMatchObject({ name: "HintedKeyMismatchError" })
    expect(ceremony.assertRequests).toEqual([])
  })

  it("an answer from a key other than the chosen one is refused", async () => {
    const { service, ceremony, root, backup, keys } = await twoKeys()
    ceremony.opts.assertOverride = () => root.credentialId
    await expect(
      service.adoptAccountPasskey({ ...keys, chosen: backup.credentialId }),
    ).rejects.toMatchObject(UNASKED)
    expect(service.isUnlocked()).toBe(false)
  })

  it("beginRecovery steers a chosen credential by its record, and an unchosen one as before", async () => {
    const { service, ceremony, root } = await twoKeys()
    await service.beginRecovery({ credentialId: root.credentialId, chosen: true })
    await service.beginRecovery({ credentialId: root.credentialId })
    expect(ceremony.assertRequests.map((r) => r.hints)).toEqual([EVERY_ROUTE, ["client-device"]])
  })

  it("unlock with another key moves the stored signer too, so the next reload restores from the cache", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony, storage } = phone()
      const root = await service.createPasskey("@alice")
      const backup = await service.createPasskey("@alice")
      const passkeys = [root.pubkey, backup.pubkey]
      const envelope = await sealFor(ceremony, backup, root.secretKey, "second")
      await service.recordRecoveryMetadata({
        credentialId: root.credentialId,
        l2Address: ADDR,
        pubkey: root.pubkey,
        prfSlot: root.prfSlot,
        isMskRoot: true,
        passkeySet: passkeys,
      })
      await service.recordRecoveryMetadata({
        credentialId: backup.credentialId,
        l2Address: ADDR,
        pubkey: backup.pubkey,
        prfSlot: "second",
        isMskRoot: false,
        backup: { account: ACCOUNT, envelope: hex(envelope) },
        passkeySet: passkeys,
        authenticatorType: "security-key",
      })
      await service.commitSecret({
        secretKey: root.secretKey,
        authProvider: service.providerFor({
          credentialId: root.credentialId,
          pubkeyHex: root.pubkey,
          passkeys,
        }),
      })
      let stored = {
        kind: "webauthn" as const,
        credentialId: root.credentialId,
        pubkey: root.pubkey,
        address: ADDR,
      }
      const write = vi.fn(
        async ({ credentialId, pubkey }: { credentialId: string; pubkey: string }) => {
          stored = { ...stored, credentialId, pubkey }
        },
      )
      service.setSignerWriter(write)
      service.clear()
      await service.unlock(deriveFor(root, ADDR, passkeys), {})
      service.clear()
      await service.unlock(deriveFor(root, ADDR, passkeys), { credentialId: root.credentialId })
      expect(write).not.toHaveBeenCalled()
      expect(getActiveCredentialId()).toBe(root.credentialId)
      service.clear()
      await service.unlock(deriveFor(root, ADDR, passkeys), { credentialId: backup.credentialId })
      expect(write).toHaveBeenCalledWith({
        credentialId: backup.credentialId,
        pubkey: backup.pubkey,
        authenticatorType: "security-key",
      })

      const reloaded = new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "phone",
      })
      reloaded.setAddressDeriver(deriveFor(root, ADDR, passkeys))
      reloaded.setAccountReader(async () => stored)
      const asked = ceremony.assertRequests.length
      expect((await reloaded.getSecretKey())?.toString()).toBe(root.secretKey.toString())
      expect(ceremony.assertRequests.length).toBe(asked)
      expect(getActiveCredentialId()).toBe(backup.credentialId)
    } finally {
      restore()
    }
  })

  /** A phone service holding a two-key wallet's records, its session committed under the sign-up key. */
  async function twoKeySession(backupAddress = ADDR) {
    const made = phone()
    const { service, ceremony } = made
    const root = await service.createPasskey("@alice")
    const backup = await service.createPasskey("@alice")
    const passkeys = [root.pubkey, backup.pubkey]
    const envelope = await sealFor(ceremony, backup, root.secretKey, "second")
    await service.recordRecoveryMetadata({
      credentialId: root.credentialId,
      l2Address: ADDR,
      pubkey: root.pubkey,
      prfSlot: root.prfSlot,
      isMskRoot: true,
      passkeySet: passkeys,
    })
    await service.recordRecoveryMetadata({
      credentialId: backup.credentialId,
      l2Address: backupAddress,
      pubkey: backup.pubkey,
      prfSlot: "second",
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: hex(envelope) },
      passkeySet: passkeys,
    })
    await service.commitSecret({
      secretKey: root.secretKey,
      authProvider: service.providerFor({
        credentialId: root.credentialId,
        pubkeyHex: root.pubkey,
        passkeys,
      }),
    })
    const reload = (signer: { credentialId: string; pubkey: string }) => {
      const fresh = new WebAlphaAuthService({
        storage: made.storage,
        rpId: "localhost",
        ceremony,
        posture: () => "phone",
      })
      fresh.setAddressDeriver(deriveFor(root, ADDR, passkeys))
      fresh.setAccountReader(async () => ({ kind: "webauthn" as const, ...signer, address: ADDR }))
      return fresh
    }
    return { ...made, root, backup, passkeys, reload }
  }

  it("a key recorded under the wallet's address in another case still unlocks and restores", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, root, backup, passkeys, reload } = await twoKeySession(
        `0x${"AA".repeat(32)}`,
      )
      service.clear()
      await service.unlock(deriveFor(root, ADDR, passkeys), { credentialId: backup.credentialId })
      expect(getActiveCredentialId()).toBe(backup.credentialId)
      const fresh = reload({ credentialId: root.credentialId, pubkey: root.pubkey })
      expect((await fresh.getSecretKey())?.toString()).toBe(root.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("a reload after a backup unlock whose signer rewrite never landed still restores from the cache", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony, root, backup, passkeys, reload } = await twoKeySession()
      service.clear()
      // No writer: the stored account still names the sign-up key.
      await service.unlock(deriveFor(root, ADDR, passkeys), { credentialId: backup.credentialId })
      expect(getActiveCredentialId()).toBe(backup.credentialId)
      const asked = ceremony.assertRequests.length
      const fresh = reload({ credentialId: root.credentialId, pubkey: root.pubkey })
      expect((await fresh.getSecretKey())?.toString()).toBe(root.secretKey.toString())
      expect(ceremony.assertRequests.length).toBe(asked)
      expect(getActiveCredentialId()).toBe(backup.credentialId)
    } finally {
      restore()
    }
  })

  it("a stored signer that is a recorded key of another wallet still fails the restore", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, reload } = await twoKeySession()
      const bob = await service.createPasskey("@bob")
      await record(service, bob, "0xbob")
      // The sign-up key's record names a key the cache's record does not.
      const stranger = reload({ credentialId: bob.credentialId, pubkey: bob.pubkey })
      expect(await stranger.getSecretKey()).toBeUndefined()
      expect(getActiveStorageId()).toBeNull()
    } finally {
      restore()
    }
  })

  it("a commit marks the key that opened the wallet; one that did not land marks nothing", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, storage } = phone()
      const created = await service.createPasskey("@alice")
      await record(service, created, ADDR)
      const map = new WebPasskeyIdentityMap(storage, "localhost")
      const usedAt = async () =>
        ((await map.get(created.credentialId)) as { usedAt?: number }).usedAt
      expect(
        await service.commitSecret(
          { secretKey: created.secretKey, authProvider: created.authProvider },
          () => false,
        ),
      ).toBe(false)
      await flush()
      expect(await usedAt()).toBeUndefined()
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      await vi.waitFor(async () => expect(await usedAt()).toBeTypeOf("number"))
    } finally {
      restore()
    }
  })

  it("unlock refuses a key this browser holds no record of for the session's wallet, before any prompt", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = phone()
      const root = await service.createPasskey("@alice")
      const other = await service.createPasskey("@bob")
      await record(service, root, ADDR)
      await record(service, other, "0xbob")
      await service.commitSecret({ secretKey: root.secretKey, authProvider: root.authProvider })
      service.clear()
      ceremony.assertRequests = []
      for (const credentialId of ["unknown", other.credentialId]) {
        await expect(service.unlock(deriveFor(root, ADDR), { credentialId })).rejects.toMatchObject(
          UNASKED,
        )
      }
      expect(ceremony.assertRequests).toEqual([])
      expect(getActiveCredentialId()).toBe(root.credentialId)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService cached key restore", () => {
  const ADDR = `0x${"aa".repeat(32)}`

  /** Pause a restore at address derivation so a commit or sign-out can land first. */
  function hangDerive(answer: (msk: Fr, passkeys: readonly string[]) => string = () => ADDR) {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    return {
      ready,
      derive: (msk: Fr, passkeys: readonly string[]) =>
        new Promise<string>((resolve) => {
          release = () => resolve(answer(msk, passkeys))
          started()
        }),
      release: () => release(),
    }
  }

  /** A session committed with its passkey, and a second instance over the same storage. */
  async function committed(opts: { address?: string } = {}) {
    const restore = stubLocalStorage()
    const { service, ceremony, storage } = laptop()
    const created = await service.createPasskey("@alice")
    await record(service, created, opts.address ?? ADDR)
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    const fresh = new WebAlphaAuthService({
      storage,
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const snapshot = {
      kind: "webauthn" as const,
      credentialId: created.credentialId,
      pubkey: created.pubkey,
      address: ADDR,
    }
    const inject = (
      over: {
        derive?: (msk: Fr, passkeys: readonly string[]) => Promise<string>
        read?: () => Promise<typeof snapshot | null | { kind: "other" }>
      } = {},
    ) => {
      fresh.setAddressDeriver(over.derive ?? deriveFor(created, ADDR))
      fresh.setAccountReader(over.read ?? (async () => snapshot))
    }
    const ceremonies = () => ceremony.assertRequests.length
    return { restore, service, ceremony, storage, created, fresh, inject, snapshot, ceremonies }
  }

  it("a fresh instance restores the key and the record's provider with no ceremony", async () => {
    const { restore, created, fresh, inject, ceremonies } = await committed()
    try {
      const before = ceremonies()
      const derive = vi.fn(deriveFor(created, ADDR))
      inject({ derive })
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      expect(fresh.isUnlocked()).toBe(true)
      const provider = await fresh.getAuthProvider()
      const [x, y] = await provider!.getPubkeys()
      expect(Buffer.concat([x, y]).toString("hex")).toBe(created.pubkey)
      expect(ceremonies()).toBe(before)
      // The cached key is proved under the record's key set: the signing key alone when none was recorded.
      expect(derive).toHaveBeenCalledWith(created.secretKey, [created.pubkey])
    } finally {
      restore()
    }
  })

  it("a signer handed out before the key could be proved stays the session's signer", async () => {
    const { restore, created, fresh, inject, snapshot } = await committed()
    try {
      // The account reader fails once (a database still opening): the first read signs with the
      // record's key and leaves the cache for the next attempt, which proves it.
      let reads = 0
      inject({
        read: async () => {
          if (reads++ === 0) throw new Error("opening")
          return snapshot
        },
      })
      const early = await fresh.getAuthProvider()
      expect(early).toBeDefined()
      expect(fresh.isUnlocked()).toBe(false)
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      expect((await fresh.sessionKeys())!.authProvider).toBe(early)
      expect(await fresh.getAuthProvider()).toBe(early)
    } finally {
      restore()
    }
  })

  it("unlock() takes the proved cache before any ceremony", async () => {
    const { restore, created, fresh, inject, ceremonies } = await committed()
    try {
      const before = ceremonies()
      inject()
      await fresh.unlock(deriveFor(created, ADDR), {})
      expect(fresh.isUnlocked()).toBe(true)
      expect(ceremonies()).toBe(before)
    } finally {
      restore()
    }
  })

  it("restores nothing until the wallet has injected a deriver and a reader", async () => {
    const { restore, fresh } = await committed()
    try {
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(walletStorage.getItem("webwallet.msk")).not.toBeNull()
    } finally {
      restore()
    }
  })

  it.each([
    ["the storage pointer moved", () => setActiveStorageId("someone-else")],
    ["the credential pointer moved", () => setActiveCredentialId("someone-else")],
  ])(
    "%s: the cache is dropped, this tab's own pointers stay, the service stays locked",
    async (_name, disturb) => {
      const { restore, fresh, inject } = await committed()
      try {
        disturb()
        await walletStorage.flush()
        const session = { storageId: getActiveStorageId()!, credentialId: getActiveCredentialId() }
        inject()
        expect(await fresh.getSecretKey()).toBeUndefined()
        expect(walletStorage.getItem("webwallet.msk")).toBeNull()
        expect(getActiveStorageId()).toBe(session.storageId)
        expect(getActiveCredentialId()).toBe(session.credentialId)
      } finally {
        restore()
      }
    },
  )

  it("no record, a record without an address, or a rotated record: dropped and locked", async () => {
    for (const shape of ["missing", "no-address", "rotated", "wrong-rp"] as const) {
      const { restore, fresh, inject, storage, created } = await committed()
      try {
        const { WebPasskeyIdentityMap } = await import(
          "../../../src/platform/auth/WebPasskeyIdentityMap"
        )
        const map = new WebPasskeyIdentityMap(storage, "localhost")
        if (shape === "missing") await map.clear()
        if (shape === "wrong-rp") {
          await new WebPasskeyIdentityMap(storage, "auth.zk.money").upsert({
            credentialId: created.credentialId,
            l2Address: ADDR,
            pubkey: created.pubkey,
            isMskRoot: true,
          })
        }
        if (shape === "no-address") {
          await map.upsert({
            credentialId: created.credentialId,
            l2Address: "",
            pubkey: created.pubkey,
            isMskRoot: true,
          })
        }
        if (shape === "rotated") {
          await map.upsert({
            credentialId: created.credentialId,
            l2Address: ADDR,
            pubkey: created.pubkey,
            isMskRoot: false,
          })
        }
        inject()
        expect(await fresh.getSecretKey()).toBeUndefined()
        expect(walletStorage.getItem("webwallet.msk")).toBeNull()
      } finally {
        restore()
      }
    }
  })

  it("a key that does not re-derive the storage id is dropped", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      const cache = JSON.parse(walletStorage.getItem("webwallet.msk")!)
      cache.msk = Fr.random().toString()
      walletStorage.setItem("webwallet.msk", JSON.stringify(cache))
      await walletStorage.flush()
      inject()
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it.each([
    ["another address", (s: { address: string }) => ({ ...s, address: `0x${"cc".repeat(32)}` })],
    ["another passkey key", (s: { pubkey: string }) => ({ ...s, pubkey: "ff".repeat(64) })],
    ["another credential", (s: { credentialId: string }) => ({ ...s, credentialId: "cred-other" })],
    ["a non-passkey account", () => ({ kind: "other" as const })],
    ["no stored account", () => null],
  ])("a stored account with %s is a mismatch: dropped and locked", async (_name, twist) => {
    const { restore, fresh, inject, snapshot } = await committed()
    try {
      inject({ read: async () => twist(snapshot) as never })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(fresh.isUnlocked()).toBe(false)
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
      expect(getActiveStorageId()).toBeNull()
    } finally {
      restore()
    }
  })

  it("a key deriving another address than the record's is dropped", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      inject({ derive: async () => `0x${"dd".repeat(32)}` })
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("a commit that lands during a restore wins, and the cache reflects it", async () => {
    const { restore, fresh, inject, created, ceremony, storage } = await committed()
    try {
      const hung = hangDerive((msk) => (msk.equals(created.secretKey) ? ADDR : "0xother"))
      inject({ derive: hung.derive })
      const pending = fresh.getSecretKey()
      await hung.ready
      // The user finished a ceremony for another account in this tab meanwhile.
      const other = new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
      })
      const newer = await other.createPasskey("@bob")
      fresh.setAddressDeriver(async () => ADDR)
      await fresh.commitSecret({
        secretKey: newer.secretKey,
        authProvider: fresh.providerFor({
          credentialId: newer.credentialId,
          pubkeyHex: newer.pubkey,
          passkeys: [newer.pubkey],
        }),
      })
      hung.release()
      expect((await pending)?.toString()).toBe(newer.secretKey.toString())
      expect(JSON.parse(walletStorage.getItem("webwallet.msk")!).msk).toBe(
        newer.secretKey.toString(),
      )
    } finally {
      restore()
    }
  })

  it("a sign-out that lands during a restore leaves the service locked", async () => {
    const { restore, fresh, inject } = await committed()
    try {
      const hung = hangDerive()
      inject({ derive: hung.derive })
      const pending = fresh.getSecretKey()
      await hung.ready
      fresh.clear()
      clearActiveStorage()
      hung.release()
      expect(await pending).toBeUndefined()
      expect(fresh.isUnlocked()).toBe(false)
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("lockOut() keeps a cache from restoring until the next commit", async () => {
    const { restore, created, fresh, inject } = await committed()
    try {
      inject()
      fresh.lockOut()
      expect(await fresh.getSecretKey()).toBeUndefined()
      expect(readCachedMsk()).not.toBeNull()
      await fresh.commitSecret({
        secretKey: created.secretKey,
        authProvider: fresh.providerFor({
          credentialId: created.credentialId,
          pubkeyHex: created.pubkey,
          passkeys: [created.pubkey],
        }),
      })
      fresh.clear()
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("clear() then a read restores while the cache exists; without the cache it stays locked", async () => {
    const { restore, service, created } = await committed()
    try {
      service.setAddressDeriver(deriveFor(created, ADDR))
      service.setAccountReader(async () => ({
        kind: "webauthn",
        credentialId: created.credentialId,
        pubkey: created.pubkey,
        address: ADDR,
      }))
      service.clear()
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      const { clearCachedMsk } = await import("../../../src/platform/storage/activeStorage")
      clearCachedMsk()
      await walletStorage.flush()
      service.clear()
      expect(await service.getSecretKey()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a refused pointer write leaves the previous session's pointers in place", async () => {
    let refused: readonly string[] = []
    refuseWrites(() => refused)
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const first = await service.createPasskey("@alice")
      await record(service, first, ADDR)
      await service.commitSecret({
        secretKey: first.secretKey,
        authProvider: first.authProvider,
      })
      const held = { id: getActiveStorageId(), cred: getActiveCredentialId() }

      // The namespace write lands, the credential write does not: the pair must not be left split
      // across two accounts, which would run this key against the other one's records.
      const second = await service.createPasskey("@bob")
      refused = ["webwallet.credentialId"]
      await expect(
        service.commitSecret({
          secretKey: second.secretKey,
          authProvider: second.authProvider,
        }),
      ).rejects.toThrow()
      refused = []

      expect(getActiveStorageId()).toBe(held.id)
      expect(getActiveCredentialId()).toBe(held.cred)
      expect(readCachedMsk()).toMatchObject({ storageId: held.id, credentialId: held.cred })
      // The session that was there is still the one this tab holds.
      expect((await service.getSecretKey())?.toString()).toBe(first.secretKey.toString())
    } finally {
      restore()
    }
  })

  it("a refused key cache fails the commit and stores none of the session", async () => {
    refuseWrites(() => ["webwallet.msk"])
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    await expect(
      service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      }),
    ).rejects.toThrow()
    expect(service.isUnlocked()).toBe(false)
    expect(getActiveStorageId()).toBeNull()
    expect(getActiveCredentialId()).toBeNull()
    expect(readCachedMsk()).toBeNull()
    expect(service.keyCached()).toBe(false)
  })

  it("a demo commit without a passkey caches nothing and drops a passkey session's cache", async () => {
    const restore = stubLocalStorage()
    try {
      const { EcdsaK256AlphaAuthProvider } = await import("@obsidion/sdk")
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect(walletStorage.getItem("webwallet.msk")).not.toBeNull()
      await service.commitSecret({
        secretKey: Fr.random(),
        authProvider: new EcdsaK256AlphaAuthProvider(Buffer.alloc(32, 7)),
      })
      expect(service.isUnlocked()).toBe(true)
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
      expect(getActiveStorageId()).not.toBeNull()
      expect(getActiveCredentialId()).toBeNull()
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService and the account's key set", () => {
  type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
  const ADDR = `0x${"aa".repeat(32)}`
  const OTHER = "cd".repeat(64)
  const BACKUP = { account: `0x${"11".repeat(20)}`, envelope: `01${"00".repeat(61)}` }

  const pubkeyOf = async (provider: { getPubkeys: () => Promise<[Uint8Array, Uint8Array]> }) => {
    const [x, y] = await provider.getPubkeys()
    return Buffer.concat([x, y]).toString("hex")
  }

  /** `created`'s record on `service`, with the fields a set-aware caller writes. */
  const recordWith = (
    service: WebAlphaAuthService,
    created: Created,
    extra: Partial<Parameters<WebAlphaAuthService["recordRecoveryMetadata"]>[0]> = {},
  ) =>
    service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: ADDR,
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
      ...extra,
    })

  /** A second instance over the same storage, with the wallet's deriver and account reader injected. */
  const restorer = (
    base: { ceremony: FakePasskeyCeremony; storage: MemoryStorage },
    created: Created,
    derive: (msk: Fr, passkeys: readonly string[]) => Promise<string>,
  ) => {
    const fresh = freshOver(base.ceremony, base.storage)
    fresh.setAddressDeriver(derive)
    fresh.setAccountReader(async () => ({
      kind: "webauthn",
      credentialId: created.credentialId,
      pubkey: created.pubkey,
      address: ADDR,
    }))
    return fresh
  }

  it("a session opened under a two-key set is recorded with it, and its cache proves under it", async () => {
    const restore = stubLocalStorage()
    try {
      const base = laptop()
      const created = await base.service.createPasskey("@alice")
      const passkeys = [created.pubkey, OTHER]
      const authProvider = base.service.providerFor({
        credentialId: created.credentialId,
        pubkeyHex: created.pubkey,
        passkeys,
      })
      await recordWith(base.service, created, { passkeySet: passkeys })
      await base.service.commitSecret({ secretKey: created.secretKey, authProvider })
      const derive = vi.fn(deriveFor(created, ADDR, passkeys))
      const fresh = restorer(base, created, derive)
      expect((await fresh.getSecretKey())?.toString()).toBe(created.secretKey.toString())
      expect(derive).toHaveBeenCalledWith(created.secretKey, passkeys)
      expect(await pubkeyOf((await fresh.getAuthProvider())!)).toBe(created.pubkey)
      // The key alone derives another address: the record's set is what the cache is proved under.
      const alone = restorer(base, created, deriveFor(created, ADDR))
      expect(await alone.getSecretKey()).toBeUndefined()
      expect(walletStorage.getItem("webwallet.msk")).toBeNull()
    } finally {
      restore()
    }
  })

  it("a signer outside its account's set is refused before it can sign; 0x and case do not matter", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    const hint = { credentialId: created.credentialId, pubkeyHex: created.pubkey }
    expect(() => service.providerFor({ ...hint, passkeys: [OTHER] })).toThrow(/passkey set/)
    const provider = service.providerFor({
      ...hint,
      passkeys: [OTHER, `0x${created.pubkey.toUpperCase()}`],
    })
    expect(await pubkeyOf(provider)).toBe(created.pubkey)
  })

  it("the session signs with its own record's key, not the newest record's", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony, storage } = laptop()
      const alice = await service.createPasskey("@alice")
      await recordWith(service, alice)
      await service.commitSecret({ secretKey: alice.secretKey, authProvider: alice.authProvider })
      // The account's backup passkey, recorded later on this browser.
      const bob = await freshOver(ceremony).createPasskey("@alice")
      await new Promise((resolve) => setTimeout(resolve, 2))
      await recordWith(service, bob, {
        isMskRoot: false,
        backup: BACKUP,
        passkeySet: [alice.pubkey, bob.pubkey],
      })
      const fresh = freshOver(ceremony, storage)
      expect(await pubkeyOf((await fresh.getAuthProvider())!)).toBe(alice.pubkey)
      // With no session open, the newest opening record stands in.
      clearActiveStorage()
      await walletStorage.flush()
      const idle = freshOver(ceremony, storage)
      expect(await pubkeyOf((await idle.getAuthProvider())!)).toBe(bob.pubkey)
    } finally {
      restore()
    }
  })

  /** The next identity-map read waits until `release` is called, then reads for real. */
  const holdNextRead = () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const read = WebPasskeyIdentityMap.prototype.get
    const spy = vi
      .spyOn(WebPasskeyIdentityMap.prototype, "get")
      .mockImplementationOnce(async function (this: WebPasskeyIdentityMap, id: string) {
        await held
        return read.call(this, id)
      })
    return { release, restore: () => spy.mockRestore() }
  }

  it("a record read the backup's commit overtakes does not put the root's signer back", async () => {
    const restore = stubLocalStorage()
    let read: ReturnType<typeof holdNextRead> | undefined
    try {
      const { service, ceremony, storage } = laptop()
      const alice = await service.createPasskey("@alice")
      await recordWith(service, alice)
      await service.commitSecret({ secretKey: alice.secretKey, authProvider: alice.authProvider })
      const bob = await freshOver(ceremony).createPasskey("@alice")
      const passkeys = [alice.pubkey, bob.pubkey]
      await recordWith(service, bob, { isMskRoot: false, backup: BACKUP, passkeySet: passkeys })
      // A locked instance reads the root session's record for its signer; the backup commits meanwhile.
      const fresh = freshOver(ceremony, storage)
      read = holdNextRead()
      const reading = fresh.getAuthProvider()
      await fresh.commitSecret({
        secretKey: alice.secretKey,
        authProvider: fresh.providerFor({
          credentialId: bob.credentialId,
          pubkeyHex: bob.pubkey,
          passkeys,
        }),
      })
      read.release()
      expect(await pubkeyOf((await reading)!)).toBe(bob.pubkey)
      expect(await pubkeyOf((await fresh.getAuthProvider())!)).toBe(bob.pubkey)
    } finally {
      read?.restore()
      restore()
    }
  })

  it("the cache source read across the backup's commit names the backup, not the root it started under", async () => {
    const restore = stubLocalStorage()
    let read: ReturnType<typeof holdNextRead> | undefined
    try {
      const { service, ceremony } = laptop()
      const alice = await service.createPasskey("@alice")
      await recordWith(service, alice)
      await service.commitSecret({ secretKey: alice.secretKey, authProvider: alice.authProvider })
      const bob = await freshOver(ceremony).createPasskey("@alice")
      const passkeys = [alice.pubkey, bob.pubkey]
      await recordWith(service, bob, { isMskRoot: false, backup: BACKUP, passkeySet: passkeys })
      read = holdNextRead()
      const reading = service.recoverFromCache()
      await service.commitSecret({
        secretKey: alice.secretKey,
        authProvider: service.providerFor({
          credentialId: bob.credentialId,
          pubkeyHex: bob.pubkey,
          passkeys,
        }),
      })
      read.release()
      const held = await reading
      expect(held).toMatchObject({
        credentialId: bob.credentialId,
        pubkey: bob.pubkey,
        passkeys,
        backup: BACKUP,
      })
      expect(await pubkeyOf(held!.authProvider)).toBe(bob.pubkey)
    } finally {
      read?.restore()
      restore()
    }
  })

  /** Holds the next session write between its pointers landing and its commit's return. */
  const holdNextPublication = () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const published = new Promise<void>((resolve) => (reached = resolve))
    const batch = walletStorage.batch.bind(walletStorage)
    const spy = vi.spyOn(walletStorage, "batch").mockImplementationOnce((write) =>
      batch(write).then(async () => {
        reached()
        await held
      }),
    )
    return { published, release, restore: () => spy.mockRestore() }
  }

  /** Holds the next session write before its pointers land, so the commit is saving but not saved. */
  const holdNextWrite = () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let reach!: () => void
    const reached = new Promise<void>((resolve) => (reach = resolve))
    const batch = walletStorage.batch.bind(walletStorage)
    const spy = vi.spyOn(walletStorage, "batch").mockImplementationOnce(async (write) => {
      reach()
      await held
      return batch(write)
    })
    return { reached, release, restore: () => spy.mockRestore() }
  }

  /** A root session, and the account's backup recorded on the same browser. */
  const rootWithBackup = async () => {
    const { service, ceremony } = laptop()
    const alice = await service.createPasskey("@alice")
    await recordWith(service, alice)
    await service.commitSecret({ secretKey: alice.secretKey, authProvider: alice.authProvider })
    const bob = await freshOver(ceremony).createPasskey("@alice")
    const passkeys = [alice.pubkey, bob.pubkey]
    await recordWith(service, bob, { isMskRoot: false, backup: BACKUP, passkeySet: passkeys })
    const backupProvider = () =>
      service.providerFor({ credentialId: bob.credentialId, pubkeyHex: bob.pubkey, passkeys })
    return { service, ceremony, alice, bob, passkeys, backupProvider }
  }

  it("a consent prompt asked for while the backup's commit is saving goes to no one", async () => {
    const restore = stubLocalStorage()
    let hold: ReturnType<typeof holdNextWrite> | undefined
    try {
      const { service, ceremony, alice, backupProvider } = await rootWithBackup()
      const provider = backupProvider()
      const asserted = ceremony.assertRequests.length
      hold = holdNextWrite()
      const committing = service.commitSecret({
        secretKey: alice.secretKey,
        authProvider: provider,
      })
      await hold.reached
      expect(getActiveCredentialId()).toBe(alice.credentialId)
      // The root's pointers still stand, and the signer read waits for the backup's commit.
      const asked = service.signMetadataChallenge(`0x${"42".repeat(32)}`)
      hold.release()
      await committing
      await expect(asked).rejects.toMatchObject({ name: "SessionChangedError" })
      expect(ceremony.assertRequests).toHaveLength(asserted)
    } finally {
      hold?.restore()
      restore()
    }
  })

  it("the cache source read while the backup's pointers are saved, before its commit returns, is the backup's", async () => {
    const restore = stubLocalStorage()
    let hold: ReturnType<typeof holdNextPublication> | undefined
    try {
      const { service, alice, bob, passkeys, backupProvider } = await rootWithBackup()
      hold = holdNextPublication()
      const committing = service.commitSecret({
        secretKey: alice.secretKey,
        authProvider: backupProvider(),
      })
      await hold.published
      const cached = service.recoverFromCache()
      // The record lands while the commit's turn is still open.
      await new Promise((resolve) => setTimeout(resolve, 0))
      hold.release()
      await committing
      const held = await cached
      expect(held).toMatchObject({ credentialId: bob.credentialId, pubkey: bob.pubkey, passkeys })
      expect(await pubkeyOf(held!.authProvider)).toBe(bob.pubkey)
    } finally {
      hold?.restore()
      restore()
    }
  })

  /** Alice's root session, and Bob's own account with its own key, ready to commit over it. */
  const twoAccounts = async () => {
    const { service, ceremony } = laptop()
    const alice = await service.createPasskey("@alice")
    await recordWith(service, alice)
    await service.commitSecret({ secretKey: alice.secretKey, authProvider: alice.authProvider })
    const bob = await freshOver(ceremony).createPasskey("@bob")
    await recordWith(service, bob)
    const bobProvider = () =>
      service.providerFor({
        credentialId: bob.credentialId,
        pubkeyHex: bob.pubkey,
        passkeys: [bob.pubkey],
      })
    return { service, alice, bob, bobProvider }
  }

  it("the pair read while another account's pointers are saved is the newcomer's key with the newcomer's signer", async () => {
    const restore = stubLocalStorage()
    let hold: ReturnType<typeof holdNextPublication> | undefined
    try {
      const { service, bob, bobProvider } = await twoAccounts()
      hold = holdNextPublication()
      const committing = service.commitSecret({
        secretKey: bob.secretKey,
        authProvider: bobProvider(),
      })
      await hold.published
      const asked = service.sessionKeys()
      hold.release()
      await committing
      const keys = await asked
      expect(keys!.secretKey.toString()).toBe(bob.secretKey.toString())
      expect(await pubkeyOf(keys!.authProvider)).toBe(bob.pubkey)
    } finally {
      hold?.restore()
      restore()
    }
  })

  it("a session is held until the pointers of another are saved, and never again after", async () => {
    const restore = stubLocalStorage()
    let hold: ReturnType<typeof holdNextPublication> | undefined
    try {
      const { service, alice, bob, bobProvider } = await twoAccounts()
      const generation = await service.commitSecret(
        { secretKey: alice.secretKey, authProvider: alice.authProvider },
        () => true,
      )
      if (generation === false) throw new Error("not committed")
      expect(service.sessionHeld(generation)).toBe(true)
      hold = holdNextPublication()
      const committing = service.commitSecret({
        secretKey: bob.secretKey,
        authProvider: bobProvider(),
      })
      await hold.published
      expect(service.sessionHeld(generation)).toBe(false)
      hold.release()
      await committing
      expect(service.sessionHeld(generation)).toBe(false)
    } finally {
      hold?.release()
      hold?.restore()
      restore()
    }
  })

  it("a recovery carries the record's set and envelope; a fresh browser's settle takes the set it is given", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    const passkeys = [OTHER, created.pubkey]
    const sealed = await sealFor(ceremony, created, created.secretKey)
    const backup = { account: ACCOUNT, envelope: hex(sealed) }
    await recordWith(service, created, {
      isMskRoot: false,
      backup,
      passkeySet: [`0x${OTHER.toUpperCase()}`, created.pubkey],
    })
    service.clear()
    const recovered = await service.recoverPasskey({ credentialId: created.credentialId })
    expect(recovered.passkeys).toEqual(passkeys)
    expect(recovered.backup).toEqual(backup)
    expect(recovered.candidates.first?.toString()).toBe(created.secretKey.toString())
    const hint = accountOf(rootKey(created))
    const hinted = await service.adoptAccountPasskey(hint)
    expect(hinted.passkeys).toEqual(passkeys)
    expect(hinted.backup).toEqual(backup)

    const fresh = freshOver(ceremony)
    const begun = await fresh.beginRecovery({})
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    const withSet = await begun.settle(created.pubkey, undefined, [
      `0x${OTHER.toUpperCase()}`,
      created.pubkey,
    ])
    expect(withSet.passkeys).toEqual(passkeys)
    expect(withSet.backup).toBeUndefined()
    await expect(begun.settle(created.pubkey, undefined, [OTHER])).rejects.toThrow(/passkey set/)
    expect((await begun.settle(created.pubkey)).passkeys).toEqual([created.pubkey])
    expect((await begun.settle()).passkeys).toEqual([created.pubkey])
    expect((await fresh.adoptAccountPasskey(hint)).passkeys).toEqual([created.pubkey])
  })
})

describe("WebAlphaAuthService stale page records", () => {
  type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>
  const commit = (service: WebAlphaAuthService, created: Created) =>
    service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
  /** Leaves a record under `created`'s account, as an earlier session on this browser would. */
  const holdRecords = async (created: Created) => {
    const id = await storageIdFromSecret(new Uint8Array(created.secretKey.toBuffer()))
    walletStorage.setItem(`obsidion.${id}.obsidion_account`, "{}")
  }

  it("committing the active account again leaves them fresh", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await commit(service, created)
      await commit(service, created)
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("switching from one account to another marks them stale", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      await commit(service, await service.createPasskey("@alice"))
      await commit(service, await service.createPasskey("@bob"))
      expect(service.recordsStale()).toBe(true)
    } finally {
      restore()
    }
  })

  it("stays stale through a later commit of the same account", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await holdRecords(created)
      await commit(service, created)
      await commit(service, created)
      expect(service.recordsStale()).toBe(true)
    } finally {
      restore()
    }
  })

  it("shared keys and keys written with no account do not count as held", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      walletStorage.setItem("obsidion.obsidion_web_passkey_identity_map", "{}")
      walletStorage.setItem("obsidion.obsidion_withdrawals", "{}")
      await commit(service, await service.createPasskey("@alice"))
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })

  it("a refused pointer write changes nothing", async () => {
    let refused: readonly string[] = []
    refuseWrites(() => refused)
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      await commit(service, await service.createPasskey("@alice"))
      const second = await service.createPasskey("@bob")
      refused = ["webwallet.credentialId"]
      await expect(commit(service, second)).rejects.toThrow()
      expect(service.recordsStale()).toBe(false)
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService ceremony-free sources", () => {
  const ADDR = `0x${"aa".repeat(32)}`

  it("the cache source is the held key under its record's slot and address, and nothing when locked", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = laptop()
      expect(await service.recoverFromCache()).toBeUndefined()
      const created = await service.createPasskey("@alice")
      await record(service, created, ADDR)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      const before = ceremony.assertRequests.length
      const cached = await service.recoverFromCache()
      expect(cached?.credentialId).toBe(created.credentialId)
      expect(cached?.expectedAddress).toBe(ADDR)
      expect(cached?.candidates[created.prfSlot!]?.toString()).toBe(created.secretKey.toString())
      expect(cached?.authProvider).toBe(created.authProvider)
      expect(ceremony.assertRequests).toHaveLength(before)
      service.clear()
      const { clearCachedMsk } = await import("../../../src/platform/storage/activeStorage")
      clearCachedMsk()
      expect(await service.recoverFromCache()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("the cache source with restore:false consults only the key in memory and never runs the proof", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await record(service, created, ADDR)
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect((await service.recoverFromCache({ restore: false }))?.credentialId).toBe(
        created.credentialId,
      )
      service.clear()
      const proof = vi.spyOn(
        service as unknown as { restoreFromCache: () => Promise<void> },
        "restoreFromCache",
      )
      expect(await service.recoverFromCache({ restore: false })).toBeUndefined()
      expect(proof).not.toHaveBeenCalled()
      // The disk cache is left for the next restoring read.
      expect(readCachedMsk()?.credentialId).toBe(created.credentialId)
    } finally {
      restore()
    }
  })

  it("the cache source needs a record for the bound passkey", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop()
      const created = await service.createPasskey("@alice")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      expect(await service.recoverFromCache()).toBeUndefined()
    } finally {
      restore()
    }
  })
})

describe("the wallet's own checks around the shared ceremony sequence", () => {

  it("a rotated credential is refused before the gates, on recovery and on adoption", async () => {
    // Another device's answer is exempt from the backup gate, so the gate this ordering has to
    // beat is the unreadable-flag one.
    for (const gap of [{ prfAtAssert: false }, { backupEligible: "unknown" as const }]) {
      const { service, ceremony } = laptop()
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: `0x${"aa".repeat(32)}`,
        pubkey: created.pubkey,
        prfSlot: created.prfSlot,
        isMskRoot: false,
      })
      Object.assign(ceremony.opts, gap)
      await expect(
        service.recoverPasskey({ credentialId: created.credentialId }),
      ).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
      await expect(service.adoptAccountPasskey(accountOf(rootKey(created)))).rejects.toMatchObject({
        name: "RotatedCredentialError",
      })
    }
  })
})

/** A laptop over an authenticator that answers each request on the route the request implies. */
function dualRoute(over: FakeCeremonyOptions = {}) {
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
  return { service, ceremony, storage }
}

describe("WebAlphaAuthService laptop recovery", () => {

  it("a laptop admits the local copy, sends no transports even with a hybrid-only record, and observes platform", async () => {
    const { service, ceremony } = dualRoute()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
      transports: ["hybrid"],
    })
    service.clear()
    const recovered = await service.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
    expect(recovered.candidates.second).toBeDefined()
    const request = ceremony.assertRequests.at(-1)!
    expect(request.transports).toBeUndefined()
    expect(request.hints).toEqual(["client-device"])
  })

  it("a key-settling second assertion keeps the first attempt's observation", async () => {
    const { ceremony } = dualRoute()
    const owner = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const created = await owner.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const begun = await fresh.beginRecovery({
      credentialId: created.credentialId,
    })
    if (!isUnsettled(begun)) throw new Error("expected an unsettled recovery")
    expect(begun.observed).toEqual({ credentialId: created.credentialId, attachment: "platform" })
    const settled = await begun.settle()
    expect(settled.observed).toEqual({ credentialId: created.credentialId, attachment: "platform" })
  })

  it("a fresh browser this-device answer has no expected address and never commits unanchored", async () => {
    const { ceremony } = dualRoute()
    const owner = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const created = await owner.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
    })
    const recovered = await fresh.recoverPasskey({
      credentialId: created.credentialId,
    })
    expect(recovered.expectedAddress).toBeUndefined()
    expect(recovered.authenticatorType).toBe("platform")
    await expect(selectRecoveredMsk(recovered, async () => "0xabc")).rejects.toThrow(
      /no stored account address/,
    )
  })
})

describe("WebAlphaAuthService early-refusal observation", () => {
  it("an early no-PRF carries the observation", async () => {
    const { service } = dualRoute({ prfAtAssert: false })
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xa",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    service.clear()
    const err = await service.recoverPasskey({ credentialId: created.credentialId }).catch((e) => e)
    expect(err).toBeInstanceOf(NoPrfError)
    expect((err as { observed?: unknown }).observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
  })

  it("a pinned answer with no PRF carries the observation too", async () => {
    const { service } = dualRoute({ prfAtAssert: false })
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xa",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    service.clear()
    const err = await service.adoptAccountPasskey(accountOf(rootKey(created))).catch((e) => e)
    expect(err).toBeInstanceOf(NoPrfError)
    expect((err as { observed?: unknown }).observed).toEqual({
      credentialId: created.credentialId,
      attachment: "platform",
    })
  })
})

describe("WebAlphaAuthService.unlock — verdicts and flights", () => {

  it("an answer that never evaluated the bound slot is not-reproduced", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = dualRoute({ divergent: true, secondSlot: false })
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        prfSlot: "second",
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const err = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect(err).toBeInstanceOf(StoredAddressMismatchError)
      expect((err as { verdict?: string }).verdict).toBe("not-reproduced")
    } finally {
      restore()
    }
  })

  it("a key's transports learned by a cancelled attempt never reach the record", async () => {
    const restore = stubLocalStorage()
    try {
      const { withWebLock } = await import("../../../src/platform/storage/webLock")
      const { ceremony } = refusable(KEY)
      const storage = new MemoryStorage()
      const service = freshOver(ceremony, storage)
      const created = await service.createPasskey("@alice")
      // A record with no creation list, the shape a sign-in's inference is offered to.
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        isMskRoot: true,
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const holding = withWebLock("webwallet.passkey-identity-map", () => held)
      const ctrl = new AbortController()
      await service.recoverPasskey({ credentialId: created.credentialId, signal: ctrl.signal })
      ctrl.abort()
      release()
      await holding
      await flush()
      expect((await storedEntry(storage, created.credentialId)).inferredTransports).toBeUndefined()
    } finally {
      restore()
    }
  })

  it("a second unlock after its owner aborted starts its own flight", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, ceremony } = dualRoute()
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()

      const assert = ceremony.assert.bind(ceremony)
      let releaseA!: () => void
      vi.spyOn(ceremony, "assert").mockImplementationOnce(async (request) => {
        await new Promise<void>((resolve) => (releaseA = resolve))
        return assert(request)
      })
      const ctrlA = new AbortController()
      const a = service
        .unlock(deriveFor(created, "0xacct"), { signal: ctrlA.signal })
        .catch((e) => e)
      await flush()
      ctrlA.abort()
      await service.unlock(deriveFor(created, "0xacct"))
      expect(service.isUnlocked()).toBe(true)
      releaseA()
      expect(await a).toBeInstanceOf(Error)
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService steered to the phone", () => {
  /**
   * A laptop whose browser's label for which device answered is or is not believed, holding a
   * passkey made on a phone whose copy on this computer answers every sign-in.
   */
  const steering = async (trusted: boolean, fake: FakeCeremonyOptions = {}) => {
    const made = laptop({ trustsAttachmentLabel: trusted, ...fake })
    const created = await made.service.createPasskey("@alice")
    await record(made.service, created, "0xacct")
    made.ceremony.opts.route = "local"
    return { ...made, created }
  }

  it("a trusted browser refuses this computer's answer and names the cross-device routes", async () => {
    const { service, ceremony, created } = await steering(true)
    service.clear()
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId, phone: true }),
    ).rejects.toThrow(PhoneRequiredError)
    expect(ceremony.assertRequests.at(-1)!.hints).toEqual(["hybrid", "security-key"])
  })

  it("an untrusted browser's phone-steered divergent answer is never the certain wrong key", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, created } = await steering(false, { divergent: true })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const local = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect((local as { verdict?: string }).verdict).toBe("wrong-key")
      const steered = await service
        .unlock(deriveFor(created, "0xacct"), { phone: true })
        .catch((e) => e)
      expect((steered as { verdict?: string }).verdict).toBe("not-reproduced")
      expect((steered as { observed?: unknown }).observed).toEqual({
        credentialId: created.credentialId,
      })
    } finally {
      restore()
    }
  })

  it("a record mismatch carries the answer and the record's provider", async () => {
    const restore = stubLocalStorage()
    try {
      const { service, created } = await steering(true, { divergent: true })
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        prfSlot: created.prfSlot,
        prfAaguid: APPLE_ICLOUD_AAGUID,
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const err = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect((err as { observed?: unknown }).observed).toEqual({
        credentialId: created.credentialId,
        attachment: "platform",
        recordAaguid: APPLE_ICLOUD_AAGUID,
      })
    } finally {
      restore()
    }
  })

  it("unlock with the phone commits the key this computer's copy got wrong", async () => {
    const restore = stubLocalStorage()
    try {
      const ceremony = new FakePasskeyCeremony({
        route: "cross-device",
        routeFromRequest: true,
        divergent: true,
      })
      const service = new WebAlphaAuthService({
        storage: new MemoryStorage(),
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
        trustsAttachmentLabel: () => true,
        misreportsCrossDevice: () => false,
      })
      const created = await service.createPasskey("@alice")
      await record(service, created, "0xacct")
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const local = await service.unlock(deriveFor(created, "0xacct")).catch((e) => e)
      expect((local as { verdict?: string }).verdict).toBe("wrong-key")
      await service.unlock(deriveFor(created, "0xacct"), { phone: true })
      expect((await service.getSecretKey())?.toString()).toBe(created.secretKey.toString())
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService attempt scope", () => {
  /** A scope that records what was asked through it, as the tracker's does for one attempt. */
  const scoping = () => {
    const asked: string[] = []
    const own: PasskeyRequestScope = (ceremony) => ({
      create: (request) => {
        asked.push("create")
        return ceremony.create(request)
      },
      assert: (request) => {
        asked.push("assert")
        return ceremony.assert(request)
      },
    })
    return { own, asked }
  }

  it("a creation asks through the attempt its status callback names, chained assertion included", async () => {
    // No key material at creation, so the driver chains an assertion for it.
    const { service } = laptop({ prfAtCreate: false })
    const { own, asked } = scoping()
    await service.createPasskey("@alice", statusForAttempt(own))
    expect(asked).toEqual(["create", "assert"])
  })

  it("a recovery and its second assertion ask through the attempt they were given", async () => {
    const { service } = laptop()
    const created = await service.createPasskey("@alice")
    const fresh = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony: (service as unknown as { ceremony: PasskeyCeremony }).ceremony,
      posture: () => "laptop",
    })
    const { own, asked } = scoping()
    const begun = await fresh.beginRecovery({ credentialId: created.credentialId, own })
    expect(isUnsettled(begun)).toBe(true)
    if (isUnsettled(begun)) await begun.settle()
    expect(asked).toEqual(["assert", "assert"])
  })

  it("an unlock asks through the attempt it was given", async () => {
    const restore = stubLocalStorage()
    try {
      const { service } = laptop(KEY)
      const created = await service.createPasskey("@alice")
      await service.recordRecoveryMetadata({
        credentialId: created.credentialId,
        l2Address: "0xacct",
        pubkey: created.pubkey,
        isMskRoot: true,
      })
      await service.commitSecret({
        secretKey: created.secretKey,
        authProvider: created.authProvider,
      })
      service.clear()
      const { own, asked } = scoping()
      await service.unlock(deriveFor(created, "0xacct"), { own })
      expect(asked).toEqual(["assert"])
    } finally {
      restore()
    }
  })
})

describe("WebAlphaAuthService.createBackupPasskey", () => {
  /** A driver that creates on the fake and keeps what it was told. */
  const recording = () => {
    const seen: Parameters<BackupCreationDriver>[1][] = []
    const driver: BackupCreationDriver = async (c, options) => {
      seen.push(options)
      const created = await c.create({
        rpId: options.rpId,
        rpName: options.rpName,
        userName: options.userName,
        prfFirstSalt: new Uint8Array(32).fill(3),
      })
      return {
        created,
        slot: "first",
        prfOutput: created.prfFirst!,
        securityKey: false,
        facts: { provider: "unknown" },
      }
    }
    return { seen, driver }
  }

  it("runs the driver for this relying party, device and pick, and keeps the passkey's handle", async () => {
    const { service, ceremony, storage } = laptop({
      userAgent: async () => parseUserAgent({ userAgent: MAC_CHROME_UA }),
    })
    const { seen, driver } = recording()
    const observe = () => {}
    const creation = await service.createBackupPasskey(driver, ceremony, {
      userName: "brave-otter-42",
      choice: "phone",
      observe,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      posture: "laptop",
      rpId: "localhost",
      userName: "brave-otter-42",
      choice: "phone",
      observe,
    })
    expect(seen[0].userAgent?.osFamily).toBe("macos")
    expect(await seen[0].challengeForChained()).toHaveLength(32)
    expect(ceremony.creates[0].userName).toBe("brave-otter-42")

    await service.recordRecoveryMetadata({
      credentialId: creation.created.credentialId,
      l2Address: "0xabc",
      pubkey: Buffer.from(creation.created.pubkey).toString("hex"),
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: "00".repeat(62) },
    })
    const handle = bytesToBase64Url(ceremony.creds.get(creation.created.credentialId)!.handle)
    const map = new WebPasskeyIdentityMap(storage, "localhost")
    expect((await map.get(creation.created.credentialId))?.userHandle).toBe(handle)
  })

  it("hands the driver no pick when the caller made none", async () => {
    const { service, ceremony } = laptop()
    const { seen, driver } = recording()
    await service.createBackupPasskey(driver, ceremony, { userName: "brave-otter-42" })
    expect(seen[0]).not.toHaveProperty("choice")
  })

  it("sends nothing once the caller has left", async () => {
    const { service, ceremony } = laptop()
    const driver = vi.fn<BackupCreationDriver>()
    const abort = new AbortController()
    abort.abort()
    await expect(
      service.createBackupPasskey(driver, ceremony, { userName: "x", signal: abort.signal }),
    ).rejects.toThrow()
    expect(driver).not.toHaveBeenCalled()
  })
})

describe("WebAlphaAuthService providerFor", () => {
  it("asks under the signal it reads, and asks nothing once that signal has aborted", async () => {
    const { service, ceremony } = laptop(KEY)
    const created = await service.createPasskey("@alice")
    let signal: AbortSignal | undefined
    const provider = service.providerFor({
      credentialId: created.credentialId,
      pubkeyHex: created.pubkey,
      passkeys: [created.pubkey],
      signal: () => signal,
    })
    const screen = new AbortController()
    signal = screen.signal
    await signWith(provider)
    expect(ceremony.assertRequests.at(-1)!.signal).toBe(screen.signal)

    const asked = ceremony.assertRequests.length
    let started = false
    const onStart = () => void (started = true)
    provingProgress.on("signing-start", onStart)
    screen.abort()
    await expect(signWith(provider)).rejects.toBe(screen.signal.reason)
    provingProgress.off("signing-start", onStart)
    expect(ceremony.assertRequests).toHaveLength(asked)
    expect(started).toBe(false)
  })
})

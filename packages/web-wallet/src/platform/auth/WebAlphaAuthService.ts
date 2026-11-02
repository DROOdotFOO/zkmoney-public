import { Fr } from "@aztec-labs/aztec.js/fields"
import { PASSKEY_RP_NAME } from "@obsidion/core/constants"
import type { SignInRoute } from "@obsidion/core/types"
import {
  DOMAIN_SEPARATORS,
  type InstalledPasskey,
  PasskeyEnvelopeError,
  StoredAddressMismatchError,
  answeringKey,
  candidateCredentialIds,
  deriveKeyFromSecret,
  envelopeSlot,
  selectRecoveredMsk,
  type IStorageAdapter,
  type RecoveredCandidates,
  type WebAuthnData,
  WalletError,
} from "@obsidion/front-core"
import {
  type BackupAddChoice,
  BrowserPasskeyCeremony,
  type CeremonyObserver,
  type DevicePosture,
  LAPTOP_LOCAL_HINTS,
  type LaptopCreation,
  LaptopPasskeyRefusedError,
  type PasskeyAssertResult,
  type PasskeyAttachment,
  type PasskeyCeremony,
  type PasskeyHint,
  type PasskeyRequestScope,
  type PhoneReach,
  type PrfCandidates,
  RotatedCredentialError,
  type SignUpChoice,
  type UserAgentInfo,
  appleKeyAtCreation,
  bytesToBase64Url,
  candidatePubkeys,
  candidatesFrom,
  currentDevicePosture,
  currentLaptopCreation,
  currentMisreportsCrossDevice,
  currentTrustsAttachmentLabel,
  currentPhoneReach,
  currentUserAgentInfoSoon,
  impliedKeyTransports,
  isPasskeyCancelled,
  isPasskeyPolicyError,
  isPhysicalOnly,
  preferredSlot,
  recordPasskeyEnvironment,
  recoverPubkeyFromAssertions,
  runPasskeyAssertion,
  runPasskeyCreation,
  decodeUserHandle,
  withoutManager,
} from "@obsidion/passkey-web"
import type { Address } from "viem"
import { type BackupSignInFacts, noteBackupSignIn } from "../../features/onboarding/backupSignIn"
import type { BackupCreation, BackupCreationDriver } from "./backupCreation"
import { openBackupEnvelope } from "./backupEnvelope"
import {
  clearActiveCredentialId,
  clearActiveStorage,
  clearCachedMsk,
  getActiveCredentialId,
  getActiveStorageId,
  readCachedMsk,
  readCommittedSession,
  readSessionTuple,
  setActiveCredentialId,
  setActiveStorageId,
  storageIdFromSecret,
  withSessionLock,
  writeCachedMsk,
  writeSessionTuple,
  type CachedMsk,
} from "../storage/activeStorage"
import { walletStorage } from "../storage/walletStorage"
import { holdsAccountRecords } from "../storage/WebStorageAdapter"
import {
  type AlphaAuthProvider,
  type AlphaAuthService,
  type CommitSecretInput,
  type FeePayerEntry,
  type PrfSlot,
  type RecoverPasskeyResult,
  type RecoveryMetadata,
  WebAuthnAlphaAuthProvider,
  deriveMskFromPrfOutput,
} from "@obsidion/sdk"
import { countingLocalRefusals } from "./localRefusals"
import { type RetiredSession, retiredSession } from "./retiredSession"
import { scopeOfStatus } from "./passkeyAttemptScope"
import { PASSKEY_ENVIRONMENT_KEY } from "./passkeyEnvironmentKey"
import { NoPasskeySessionError, SessionChangedError } from "./sessionErrors"
import { type SigningSteering, makeWebauthnSignFn } from "./webauthnSigning"
import {
  type PasskeyAnswer,
  type StoredRecoveryMetadata,
  WebPasskeyIdentityMap,
  opensWallet,
} from "./WebPasskeyIdentityMap"

/** The package's PRF candidates as the field elements the wallet's anchors compare. */
const toFrCandidates = (prf: PrfCandidates): RecoverPasskeyResult["candidates"] => ({
  first: prf.first && deriveMskFromPrfOutput(prf.first),
  second: prf.second && deriveMskFromPrfOutput(prf.second),
})

const PROBE_WAIT_MS = 1000

/** `probe`'s answer, or `fallback` when the browser has not given one in time to open the sheet. */
async function answeredInTime<T>(probe: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_WAIT_MS)
  })
  try {
    return await Promise.race([probe, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Which passkey a recovery ceremony asks for; `discover` leaves the browser's list open. `signal`
 * ends the assertion — sheet, queue and retries — wherever it is. `own` is the attempt the requests
 * are reported as.
 */
export type RecoverPasskeyRequest = {
  credentialId?: string
  discover?: boolean
  signal?: AbortSignal
  own?: PasskeyRequestScope
  /** Steer a laptop's prompt to the phone; see `assertForRecovery`. */
  phone?: boolean
  /** The user chose `credentialId` among the account's keys; its hints follow its record. */
  chosen?: boolean
}

/** Which device answered and its class, kept beside a recovery result the plain result drops. */
export type Observation = {
  credentialId: string
  attachment?: PasskeyAttachment
  /** The provider this browser's record names for the credential, when it holds one. */
  recordAaguid?: string
}

/**
 * A recovery result plus the observation the screens read to diagnose a miss, and, when the key
 * opened the wallet through its envelope, the account and envelope its record keeps and the facts
 * the backup sign-in event reports.
 */
export type WebRecoverResult = RecoverPasskeyResult & {
  observed?: Observation
  backup?: RecoveryMetadata["backup"]
  backupFacts?: BackupSignInFacts
  /**
   * The record's key set when the chain's list has moved past it (a backup added on another
   * browser): the record still picks the key, by this set and `expectedAddress`; `passkeys` is the
   * chain's, the entry derives under it, and the record is rewritten to it.
   */
  staleSet?: readonly string[]
  /** The tag a retired rollup's record names for the credential: a hint, never trusted. */
  usertag?: string
}

/**
 * A tag's account and the keys L1 lists for it, for a sign-in pinned to that account: the
 * answering credential is matched against the keys, never trusted. `l2Address` is diagnostic only;
 * the anchors name the address.
 */
export type AccountPasskeys = {
  account: Address
  l2Address?: string
  keys: readonly InstalledPasskey[]
  /** The credential the user chose among `keys`: the prompt names only it. */
  chosen?: string
}

/**
 * What a record-anchored mismatch means for the UI. `wrong-key` is a certain wrong key on this
 * computer — a `this-device` answer whose bound slot was evaluated and still did not derive the
 * recorded address; `not-reproduced` is the weaker "this attempt didn't open it", the copy a re-run
 * or another device may still fix.
 */
export type MismatchVerdict = "wrong-key" | "not-reproduced"

/** An unlock ceremony in flight, with the signal that decides who may join it. */
type UnlockFlight = { promise: Promise<void>; signal?: AbortSignal }

/** What an unlock asks for; see `unlock`. */
type UnlockOptions = {
  signal?: AbortSignal
  own?: PasskeyRequestScope
  phone?: boolean
  credentialId?: string
}

/** What one recovery assertion asks for; see `assertForRecovery`. */
type RecoveryAsk = {
  credentialIds?: string[]
  transports?: readonly string[]
  securityKey?: boolean
  signal?: AbortSignal
  own?: PasskeyRequestScope
  phone?: boolean
  chosen?: { transports?: readonly string[] }
}

/** A `StoredAddressMismatchError` the wallet tagged with which verdict the screens should render. */
export const mismatchVerdictOf = (err: unknown): MismatchVerdict | undefined =>
  err instanceof StoredAddressMismatchError
    ? (err as { verdict?: MismatchVerdict }).verdict
    : undefined

/** The observation an error from a recovery carries, when it carries one. */
export const observedOf = (err: unknown): Observation | undefined =>
  typeof err === "object" && err ? (err as { observed?: Observation }).observed : undefined

/**
 * A recovery whose public key is still one of two. It carries what the anchors need to name the
 * master key, and `settle` finishes it: with the candidate the account confirmed, or with none,
 * which runs the second assertion — one `attempt` can end, sheet and retries included. Only a
 * settled result carries a signer.
 */
export type UnsettledRecovery = RecoveredCandidates & {
  credentialId: string
  /** The two keys the sign-in signature recovers to, as 64-byte `x||y` hex. Exactly one is the passkey's. */
  pubkeyCandidates: readonly string[]
  /** Which device answered the first assertion; a key-settling second one never overwrites it. */
  observed?: Observation
  /** `passkeys` is the account's whole key set when the caller read it beside `pubkey`. */
  settle: (
    pubkey?: string,
    attempt?: AbortSignal,
    passkeys?: readonly string[],
  ) => Promise<WebRecoverResult>
}

export type BeginRecoveryResult = WebRecoverResult | UnsettledRecovery

export const isUnsettled = (result: BeginRecoveryResult): result is UnsettledRecovery =>
  "settle" in result

/** The assertion succeeded, but the hinted key is not one its signature recovers to, or not this browser's record's. */
export class HintedKeyMismatchError extends Error {
  constructor() {
    super("The hinted passkey key does not match the passkey that signed")
    this.name = "HintedKeyMismatchError"
  }
}

const randomChallenge = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)))

/** The stored account as a restore compares it: who signs for it and where it lives. */
export type StoredAccountSnapshot =
  | { kind: "webauthn"; credentialId: string; pubkey: string; address: string }
  | { kind: "other" }

const normalKey = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()
const hexBytes = (hex: string) => new Uint8Array(Buffer.from(normalKey(hex), "hex"))
const sameHex = (a: string, b: string) => normalKey(a) === normalKey(b)
/** The record's key set in the candidate form; a record without one is its key alone. */
const setOf = (record: Pick<RecoveryMetadata, "pubkey" | "passkeySet">): string[] =>
  (record.passkeySet ?? [record.pubkey]).map(normalKey)
const memberOf = (passkeys: readonly string[], pubkey: string) =>
  passkeys.some((key) => sameHex(key, pubkey))
/** Whether `set` holds every key of `subset` and more: a record ahead of the chain's list. */
const strictlyContains = (set: readonly string[], subset: readonly string[]) =>
  set.length > subset.length && subset.every((key) => memberOf(set, key))
/** A record's envelope in the opener's form. */
const envelopeOf = (backup: NonNullable<RecoveryMetadata["backup"]>) => ({
  envelope: hexBytes(backup.envelope),
  account: backup.account as Address,
})
/** What the backup sign-in event may learn: the answer's backup flag and the record's provider. */
const backupFactsOf = (
  assertion: PasskeyAssertResult | undefined,
  record: RecoveryMetadata | undefined,
): BackupSignInFacts => ({
  ...(assertion?.backupEligible !== undefined ? { backupEligible: assertion.backupEligible } : {}),
  ...(record?.prfAaguid ? { aaguid: record.prfAaguid } : {}),
})
/** The wallet's address derivation from a master key and the account's key set. */
export type AddressDeriver = (msk: Fr, passkeys: readonly string[]) => Promise<string>
export type WebAlphaAuthServiceOptions = {
  storage: IStorageAdapter
  /** Production: `"auth.zk.money"` (via related-origins). Dev/e2e: `"localhost"`. */
  rpId: string
  rpName?: string
  ceremony?: PasskeyCeremony
  posture?: () => DevicePosture
  /** Whether the browser labels a cross-device answer as its own; tests fix it, production reads
   * the user agent. */
  misreportsCrossDevice?: () => boolean
  /** Whether the browser reports truthfully which device answered, so a refused sign-up may name
   * it; tests fix it, production reads the user agent. */
  trustsAttachmentLabel?: () => boolean
  /** The browser's claims about itself, written into a new passkey's handle; tests fix it. */
  userAgent?: () => Promise<UserAgentInfo>
  /** `null` sends laptop ceremonies no steering hints (the e2e build's virtual authenticators). */
  laptopHints?: null
  /** Provider ids admitted beyond the measured set; only the e2e build passes any. */
  extraProviders?: readonly string[]
  /** Whether this laptop may create on its own password manager; tests fix it, production reads
   * the browser's claims. */
  laptopCreation?: () => Promise<LaptopCreation>
  /** Hears each saved change of the session pointers: a commit, and a rejected cache's removal. */
  onSessionSaved?: () => void
}

/**
 * Browser `AlphaAuthService`: passkey signing + PRF-derived MSK.
 *
 * The ceremony sequence and every rule in it (which device may answer, which slot binds, the
 * backup, PRF and provider gates) come from `@obsidion/passkey-web`; this service adds what only
 * the wallet knows: its record of the credential, the anchors and the cache.
 *
 * The MSK is held in memory and, once committed with its passkey, cached in the clear in this
 * origin's local storage beside the session pointers (an accepted risk: anyone with the browser
 * profile reads it). A cold session restores it from that cache without a ceremony, but only after
 * the key is proved against the stored account: the wallet injects an address deriver and an
 * account reader, and the cached key must re-derive the storage id, derive the recorded address,
 * and match the stored account's passkey. A cache that fails a check is removed with the pointers
 * and the service stays locked; a check the wallet cannot run yet leaves the cache for the next
 * read. Locked, the session re-derives from the passkey (`beginRecovery` → the caller settles the
 * key, then verifies the address it derives with it → `commitSecret`). `getSecretKey()` returning
 * `undefined` means "locked".
 * Sign-out removes the cache with the pointers.
 */
export class WebAlphaAuthService implements AlphaAuthService {
  private readonly ceremony: PasskeyCeremony
  private readonly identityMap: WebPasskeyIdentityMap
  readonly rpId: string
  private readonly rpName: string
  private readonly posture: () => DevicePosture
  private readonly misreportsCrossDevice: () => boolean
  private readonly trustsAttachmentLabel: () => boolean
  private readonly userAgent: () => Promise<UserAgentInfo>
  private readonly laptopHints: null | undefined
  private readonly extraProviders: readonly string[] | undefined
  private readonly onSessionSaved: () => void
  private readonly probeEnabled: boolean
  private readonly laptopCreation: () => Promise<LaptopCreation>
  /** The gate's answer and the sheet's pick, for the next creation only; `createPasskey` consumes both. */
  private heldCreation?: { creation: LaptopCreation; choice?: SignUpChoice }
  /** Apple Passwords gave no key on this page, so a retry stops offering it here. */
  private appleRefused = false

  private msk?: Fr
  private authProvider?: AlphaAuthProvider
  /** The in-flight unlock and what it is for: a later call joins only when the route matches and the
   *  owner's signal is still live, otherwise it starts its own. */
  private unlocking?: UnlockFlight
  private restoring?: Promise<void>
  /** Set by a sign-out's fence: no restore until the next commit, whatever the store still holds. */
  private restoreSuppressed = false
  /** Advances on every commit and clear, so a restore that awaited across one installs nothing. */
  private epoch = 0
  /** Advances on every sign-out, so a commit that awaited across one installs nothing. */
  private fence = 0
  /** Session writes started, and those not yet settled: a restore that saw either move stands down. */
  private sessionWrites = 0
  private sessionWritesInFlight = 0
  /** Set once a commit moves the session under record stores loaded for another account. */
  private staleRecords = false
  private deriveAddress?: AddressDeriver
  private readAccount?: () => Promise<StoredAccountSnapshot | null>
  private writeSigner?: (signer: WebAuthnData) => Promise<void>
  private readonly derivedKeys = new Map<string, Uint8Array>()

  constructor(options: WebAlphaAuthServiceOptions) {
    this.ceremony = options.ceremony ?? new BrowserPasskeyCeremony()
    this.identityMap = new WebPasskeyIdentityMap(options.storage, options.rpId)
    this.rpId = options.rpId
    this.rpName = options.rpName ?? PASSKEY_RP_NAME
    this.posture = options.posture ?? currentDevicePosture
    this.misreportsCrossDevice = options.misreportsCrossDevice ?? currentMisreportsCrossDevice
    this.trustsAttachmentLabel = options.trustsAttachmentLabel ?? currentTrustsAttachmentLabel
    this.userAgent = options.userAgent ?? currentUserAgentInfoSoon
    this.laptopHints = options.laptopHints
    this.extraProviders = options.extraProviders
    this.probeEnabled = options.laptopHints !== null
    this.laptopCreation = options.laptopCreation ?? (() => currentLaptopCreation(this.posture()))
    this.onSessionSaved = options.onSessionSaved ?? (() => {})
  }

  /**
   * The UI hints for a creation route: a phone opens the sheet on the QR flow, a security key names
   * itself so a manager's extension stands aside. This device takes `creationHintsFor`'s default,
   * which names a key too, except where 1Password was picked: its extension answers only a request
   * that names none. `creationHintsFor` adds the security-key hint where it must. A configuration
   * that sends no hints (the browser tests) keeps sending none.
   */
  private laptopHintsForRoute(
    route?: SignInRoute,
    choice?: SignUpChoice,
  ): readonly PasskeyHint[] | null | undefined {
    if (this.laptopHints === null) return null
    if (route === "phone") return ["hybrid"]
    if (route === "security-key") return ["security-key"]
    if (route === "this-device" && choice === "1password") return LAPTOP_LOCAL_HINTS
    return undefined
  }

  /** The steering a sign-in assertion sends: none, except the e2e build's null (no hints at all). */
  private signInHints(): null | undefined {
    return this.laptopHints === null ? null : undefined
  }

  /** Credential behind each provider, persisted as the session's passkey only once its MSK commits. */
  private readonly providerCredential = new WeakMap<AlphaAuthProvider, string>()

  /**
   * What this session's assertions implied about each credential's authenticator: a hardware
   * key's physical transports, or `refused` after the browser turned down a request steered by
   * that inference. Persisted beside the record where the record has no creation list.
   */
  private readonly implied = new Map<string, readonly string[] | "refused">()

  /** The handle each passkey this session created was created under, base64url, for its record. */
  private readonly createdHandles = new Map<string, string>()

  /** The passkeys this session created that the driver judged security keys, for their records. */
  private readonly createdSecurityKeys = new Set<string>()

  /** Where each credential's passkey answered from this session, and the attempt that saw it. */
  private readonly answers = new Map<string, { where: PasskeyAnswer; owns?: () => boolean }>()

  /** The session's answer for a credential; one seen by an attempt that has since ended is dropped. */
  private answerSeen(credentialId: string): PasskeyAnswer | undefined {
    const seen = this.answers.get(credentialId)
    if (seen?.owns && !seen.owns()) {
      this.answers.delete(credentialId)
      return undefined
    }
    return seen?.where
  }

  /**
   * Where a laptop's prompt was answered from: another device holding a passkey that can be backed
   * up, or this computer where the browser's label can be believed.
   */
  private answerOf(evidence: {
    authenticatorAttachment?: PasskeyAttachment
    backupEligible?: boolean
  }): PasskeyAnswer | undefined {
    if (this.answeredLocally(evidence.authenticatorAttachment)) {
      return this.labelTrusted() ? "local" : undefined
    }
    const elsewhere =
      this.posture() === "laptop" &&
      evidence.authenticatorAttachment === "cross-platform" &&
      evidence.backupEligible === true
    return elsewhere ? "remote" : undefined
  }

  /** Whether this browser's label for which device answered can be believed. */
  private labelTrusted(): boolean {
    return this.trustsAttachmentLabel() && !this.misreportsCrossDevice()
  }

  /**
   * Offer where a passkey last answered from to the record, and keep it for a record written
   * later. A cancelled attempt leaves nothing behind.
   */
  private async learnAnswer(
    evidence: {
      credentialId: string
      authenticatorAttachment?: PasskeyAttachment
      backupEligible?: boolean
    },
    owns?: () => boolean,
  ): Promise<void> {
    const where = this.answerOf(evidence)
    if (!where || (owns && !owns())) return
    await this.identityMap
      .setAnswered(evidence.credentialId, where, owns)
      .catch((err) => console.warn("passkey answer not recorded", err))
    if (owns && !owns()) return
    this.answers.set(evidence.credentialId, { where, owns })
  }

  /**
   * Learn from any assertion this credential answered: where a synced passkey answered from, and a
   * key's transports, are offered to the record. Never awaited by a ceremony: a slow or refused
   * write costs the hint, not the sign-in. `owns` is the assertion's ownership: a cancelled attempt
   * teaches nothing, in session or on disk.
   */
  private async learn(
    evidence: {
      credentialId: string
      authenticatorAttachment?: PasskeyAttachment
      backupEligible?: boolean
    },
    owns?: () => boolean,
  ): Promise<void> {
    await this.learnAnswer(evidence, owns)
    const transports = impliedKeyTransports(evidence)
    if (!transports) return
    if (owns && !owns()) return
    this.implied.set(evidence.credentialId, transports)
    await this.identityMap
      .setInferredTransports(evidence.credentialId, transports, owns)
      .catch((err) => console.warn("passkey transports not recorded", err))
  }

  /**
   * The transports a hardware key is reached over, when this browser knows the credential to be
   * one. A creation list decides by itself: a hardware key's is returned, a synced passkey's
   * nothing, so the local copy can answer. Without one, what this browser inferred, unless the
   * browser refused it.
   */
  private async keyTransports(
    credentialId: string,
  ): Promise<{ transports: readonly string[]; inferred: boolean } | undefined> {
    return this.keyTransportsOf(credentialId, await this.identityMap.get(credentialId))
  }

  /** `keyTransports` over a record already read. */
  private keyTransportsOf(
    credentialId: string,
    record: RecoveryMetadata | undefined,
  ): { transports: readonly string[]; inferred: boolean } | undefined {
    if (record?.transports) {
      return isPhysicalOnly(record.transports)
        ? { transports: record.transports, inferred: false }
        : undefined
    }
    const implied = this.implied.get(credentialId)
    if (implied === "refused") return undefined
    const transports = record?.inferredTransports ?? implied
    return transports ? { transports, inferred: true } : undefined
  }

  /**
   * What steers a prompt named to one credential, from one read of its record: its creation list,
   * whether this browser knows it to be a hardware key (a synced passkey, and a credential it never
   * saw, are not), and, when the user chose it, the transports recorded or inferred for it.
   */
  private async reachOf(
    credentialId: string,
    chosen = false,
  ): Promise<Pick<RecoveryAsk, "transports" | "securityKey" | "chosen">> {
    const record = await this.identityMap.get(credentialId)
    const key = this.keyTransportsOf(credentialId, record)
    const steer = record?.transports ?? key?.transports
    return {
      transports: record?.transports,
      securityKey: key !== undefined,
      ...(chosen ? { chosen: steer ? { transports: steer } : {} } : {}),
    }
  }

  /** Steering for a signature: the sheet opens on the hardware key a credential is known to be. */
  private steeringFor(credentialId: string): SigningSteering {
    return {
      transports: () => this.keyTransports(credentialId),
      learned: (assertion) => void this.learn(assertion),
      refused: () => {
        this.implied.set(credentialId, "refused")
        void this.identityMap
          .setInferredTransports(credentialId, undefined)
          .catch((err) => console.warn("passkey transports not cleared", err))
      },
    }
  }

  /** The wallet's address derivation from a master key and a key set; a cache restore proves the key with it. */
  setAddressDeriver(derive: AddressDeriver): void {
    this.deriveAddress = derive
  }

  /** The stored account's signer and address; a cache restore checks the key against it. */
  setAccountReader(read: () => Promise<StoredAccountSnapshot | null>): void {
    this.readAccount = read
  }

  /** Rewrites the stored account's signer when an unlock moves the session to another key. */
  setSignerWriter(write: (signer: WebAuthnData) => Promise<void>): void {
    this.writeSigner = write
  }

  /**
   * A signing provider for a known passkey inside its account's key set; no ceremony, so its first
   * signature costs a prompt. A key outside the set throws. `signal` is read at each signature and
   * ends its ceremony: once it has aborted, the passkey is not asked.
   */
  providerFor(passkey: {
    credentialId: string
    pubkeyHex: string
    passkeys: readonly string[]
    signal?: () => AbortSignal | undefined
  }): AlphaAuthProvider {
    return this.buildProvider(
      hexBytes(passkey.pubkeyHex),
      passkey.credentialId,
      passkey.passkeys,
      passkey.signal,
    )
  }

  /**
   * The ceremony a caller's requests are reported as. Without a scope they belong to the newest
   * passkey attempt open when each request is made.
   */
  private asking(own?: PasskeyRequestScope): PasskeyCeremony {
    return own ? own(this.ceremony) : this.ceremony
  }

  /**
   * One PRF-reading assertion over `challenge`. On a laptop the browser's own account chooser
   * decides which device answers — this computer's synced copy, a phone over QR, or a security key —
   * so the assertion admits the local copy (`localAllowed`) and sends no transport restriction; a
   * `platform` or a cross-device answer is accepted either way, and the anchors settle it.
   * `securityKey` names a hardware key in the hints, so the sheet keeps that row and a password
   * manager's extension stands aside; for anything else the extension may answer, a Proton Pass
   * wrapper the page's lock kept aside included. `signal` can end it. `phone` steers the sheet to
   * another device, which no kept wrapper sees, and refuses this computer's answer only where the
   * browser's label for it can be believed: elsewhere a phone's answer may carry that label.
   * `chosen` marks the one credential named as the key the user picked.
   */
  private async assertForRecovery(
    posture: DevicePosture,
    challenge: Buffer,
    ask: RecoveryAsk = {},
  ): Promise<PasskeyAssertResult> {
    const {
      credentialIds,
      transports,
      securityKey = false,
      signal,
      own,
      phone = false,
      chosen,
    } = ask
    const localAllowed = posture === "laptop" && !(phone && this.labelTrusted())
    return runPasskeyAssertion(this.asking(own), {
      posture,
      rpId: this.rpId,
      challenge: new Uint8Array(challenge),
      credentialIds,
      transports,
      laptopHints: this.signInHints(),
      misreportsCrossDevice: this.misreportsCrossDevice(),
      localAllowed,
      steerToPhone: phone,
      securityKey,
      ...(chosen ? { chosen } : {}),
      ...(signal ? { signal } : {}),
      observe: async ({ result }) => {
        void this.learn(result, () => !signal?.aborted)
        // Assertions carry no provider id; the creation record does, when this browser made the
        // key. The record waits on Client Hints and never holds the ceremony.
        const known = await this.identityMap.get(result.credentialId)
        void recordPasskeyEnvironment(
          { aaguid: known?.prfAaguid, posture },
          PASSKEY_ENVIRONMENT_KEY,
        )
      },
    })
  }

  /**
   * Which device answered and its class, for a screen diagnosing a miss. A phone-steered answer on
   * a browser whose label can't be believed names no class: it may be the phone's.
   */
  private observationOf(
    assertion: PasskeyAssertResult,
    steered = false,
    record?: RecoveryMetadata,
  ): Observation {
    const attachment =
      steered && !this.labelTrusted() ? undefined : assertion.authenticatorAttachment
    return {
      credentialId: assertion.credentialId,
      attachment,
      ...(record?.prfAaguid ? { recordAaguid: record.prfAaguid } : {}),
    }
  }

  /**
   * This browser's record for the credential, when it opens a wallet with a key inside its own set.
   * A rotated signing credential never opens one; a record naming a key outside its set could not
   * sign for the address it names.
   */
  private async openingRecord(credentialId: string): Promise<RecoveryMetadata | undefined> {
    const record = await this.identityMap.get(credentialId)
    if (record && (!opensWallet(record) || !memberOf(setOf(record), record.pubkey))) {
      throw new RotatedCredentialError()
    }
    return record
  }

  /**
   * Whether this browser can hand a ceremony to a phone. Asked by the screens on laptop posture
   * before the phone explainer; the ceremonies themselves never ask. Off under the e2e seam, whose
   * virtual authenticators report no hybrid transport. A browser that never answers reads as
   * unknown, which keeps the phone's steps.
   */
  async probePhoneReach(): Promise<PhoneReach> {
    if (!this.probeEnabled) return "unknown"
    return answeredInTime(currentPhoneReach(this.posture()), "unknown")
  }

  /**
   * Whether this laptop may create the passkey on its own password manager, and with which. Asked
   * by the gate before the creation sheet; never stored here, so a cancelled attempt leaves nothing.
   * A browser that never answers gets phone creation.
   */
  probeLaptopCreation(): Promise<LaptopCreation> {
    const creation = this.laptopCreation().then((c) =>
      this.appleRefused ? withoutManager(c, "apple") : c,
    )
    return answeredInTime(creation, { local: false, chromeTip: false })
  }

  /** The snapshot the gate decided from and the option picked, for the creation that follows at once. */
  useLaptopCreation(creation: LaptopCreation, choice?: SignUpChoice): void {
    this.heldCreation = { creation, choice }
  }

  /**
   * `passkeys` is the account's key set the signer belongs to; the address derives from it.
   * `opened` is set when the key opened its envelope: the candidate is the master key itself, and
   * the result carries the envelope for the record and the facts for the event. `staleSet` is the
   * record's set when the chain's list has moved past it.
   */
  private recovered({
    assertion,
    candidates,
    pubkey,
    passkeys,
    record,
    steered = false,
    opened,
    staleSet,
  }: {
    assertion: PasskeyAssertResult
    candidates: RecoverPasskeyResult["candidates"]
    pubkey: Uint8Array
    passkeys: readonly string[]
    record?: RecoveryMetadata
    steered?: boolean
    opened?: { backup: NonNullable<RecoveryMetadata["backup"]>; backupFacts: BackupSignInFacts }
    staleSet?: readonly string[]
  }): WebRecoverResult {
    const userHandle = decodeUserHandle(assertion.userHandle)
    const backup = opened?.backup ?? record?.backup
    return {
      authProvider: this.buildProvider(pubkey, assertion.credentialId, passkeys),
      credentialId: assertion.credentialId,
      pubkey: Buffer.from(pubkey).toString("hex"),
      passkeys,
      candidates,
      preferredSlot: preferredSlot(assertion.authenticatorAttachment, record?.prfSlot),
      hasPersistedSlot: record?.prfSlot !== undefined,
      candidateSource: "webauthn",
      expectedAddress: record?.l2Address,
      authenticatorType: record?.authenticatorType ?? "platform",
      ...(userHandle ? { userHandle } : {}),
      ...(backup ? { backup } : {}),
      ...(opened ? { backupFacts: opened.backupFacts } : {}),
      ...(staleSet ? { staleSet } : {}),
      // The device that answered, which the result otherwise drops; a screen reads it to diagnose a
      // miss. On a settled key it names the first assertion, never the salt-free second one.
      observed: this.observationOf(assertion, steered, record),
    }
  }

  /**
   * The master key a backup passkey's assertion opens from `envelope`, as the one candidate in the
   * envelope's slot. A failure to open is reported as the backup sign-in's `failed` and rides the
   * observation like any other refusal.
   */
  private async openedCandidate(
    assertion: PasskeyAssertResult,
    envelope: Uint8Array,
    account: Address,
    record: RecoveryMetadata | undefined,
    steered: boolean,
  ): Promise<{ candidates: RecoverPasskeyResult["candidates"]; backupFacts: BackupSignInFacts }> {
    const backupFacts = backupFactsOf(assertion, record)
    try {
      const slot = envelopeSlot(envelope)
      const msk = await openBackupEnvelope(assertion, {
        envelope,
        account,
        credentialId: assertion.credentialId,
      })
      return { candidates: { [slot]: msk }, backupFacts }
    } catch (err) {
      if (err instanceof PasskeyEnvelopeError) noteBackupSignIn("failed", backupFacts)
      throw this.withObservation(err, assertion, steered, record)
    }
  }

  /**
   * The signer for a key inside `passkeys`, the set its account's address derives from. A key
   * outside the set is refused here: the set-derived address proves the master key, not the
   * signer, so nothing later would catch a provider that cannot sign.
   */
  private buildProvider(
    pubkey: Uint8Array,
    credentialId: string,
    passkeys: readonly string[],
    signalOf?: () => AbortSignal | undefined,
  ): WebAuthnAlphaAuthProvider {
    const buf = Buffer.from(pubkey)
    if (!memberOf(passkeys, buf.toString("hex"))) {
      throw new WalletError("invariant", "the signing key is not in its account's passkey set")
    }
    const signFn = makeWebauthnSignFn(
      this.ceremony,
      this.rpId,
      credentialId,
      pubkey,
      this.steeringFor(credentialId),
    )
    const sign: typeof signFn = signalOf
      ? async (challenge, opts) => {
          const signal = opts?.signal ?? signalOf()
          // Before the signing UI starts, so an aborted request shows nothing.
          signal?.throwIfAborted()
          return signFn(challenge, signal ? { ...opts, signal } : opts)
        }
      : signFn
    const provider = new WebAuthnAlphaAuthProvider(
      buf.subarray(0, 32),
      buf.subarray(32, 64),
      sign,
      passkeys,
    )
    this.providerCredential.set(provider, credentialId)
    return provider
  }

  /**
   * The session's signer: the provider the commit or the cache proof installed, else one built from
   * the session's own record, so a browser holding a root and a backup record for one account signs
   * with the key that opened the session. Only with no session open does the newest opening record
   * stand in. A commit in flight installs its signer before its turn ends, so the answer waits for
   * it; a commit that lands during the record's read installs the signer itself, and a session that
   * moved, or is still moving, during the read is read again.
   */
  async getAuthProvider(): Promise<AlphaAuthProvider | undefined> {
    if (!this.msk) await this.restoreFromCache()
    await this.sessionSettled()
    if (this.authProvider) return this.authProvider
    const epoch = this.epoch
    const credentialId = getActiveCredentialId()
    const record = credentialId
      ? await this.identityMap.get(credentialId)
      : await this.identityMap.getOpeningRecord()
    if (this.sessionMoved(epoch, credentialId)) {
      await this.sessionSettled()
      return this.getAuthProvider()
    }
    if (this.authProvider) return this.authProvider
    if (!record) return undefined
    this.authProvider = this.buildProvider(
      hexBytes(record.pubkey),
      record.credentialId,
      setOf(record),
    )
    return this.authProvider
  }

  /** The key in memory, else the cache's once no session write is in flight: a write still saving suppresses the restore. */
  async getSecretKey(): Promise<Fr | undefined> {
    if (!this.msk) await this.restoreFromCache()
    return this.msk
  }

  /**
   * The key and the signer as one read, for a caller that builds on the pair: a commit or a restore
   * installs the two together, and a commit in flight is waited out, so the pair is one session's.
   * Nothing while locked.
   */
  async sessionKeys(): Promise<{ secretKey: Fr; authProvider: AlphaAuthProvider } | undefined> {
    if (!this.msk) await this.restoreFromCache()
    await this.sessionSettled()
    const { msk: secretKey, authProvider } = this
    return secretKey && authProvider ? { secretKey, authProvider } : undefined
  }

  /** Sign an Oxide metadata digest as the WebAuthn challenge, without a UserOp or personal-sign wrapper. */
  async signMetadataChallenge(challenge: `0x${string}`, opts?: { signal?: AbortSignal }) {
    const storageId = getActiveStorageId()
    const credentialId = getActiveCredentialId()
    const moved = () =>
      getActiveStorageId() !== storageId || getActiveCredentialId() !== credentialId
    const provider = await this.getAuthProvider()
    if (!storageId || !credentialId || !(provider instanceof WebAuthnAlphaAuthProvider))
      throw new NoPasskeySessionError()
    // The signer read waits out a commit in flight: one that replaced the session prompts no one.
    if (moved()) throw new SessionChangedError()
    const result = await provider.signChallenge(Buffer.from(challenge.slice(2), "hex"), opts)
    if (moved()) throw new SessionChangedError()
    const clientDataJSON =
      typeof result.clientDataJSON === "string"
        ? result.clientDataJSON
        : new TextDecoder().decode(result.clientDataJSON)
    return {
      signature: `0x${Buffer.from(result.signature).toString("hex")}`,
      webauthn: {
        authenticatorData: `0x${Buffer.from(result.authenticatorData).toString("hex")}`,
        clientDataJSON,
        challengeIndex: clientDataJSON.indexOf('"challenge"'),
        typeIndex: clientDataJSON.indexOf('"type"'),
      },
    }
  }

  /**
   * Install the cached key without a ceremony, once every check passes. Runs only while locked and
   * only when the wallet has injected a deriver and an account reader; one restore at a time.
   */
  private restoreFromCache(): Promise<void> {
    if (this.msk || this.restoreSuppressed || !this.deriveAddress || !this.readAccount) {
      return Promise.resolve()
    }
    if (!this.restoring) {
      const run = this.runRestore().finally(() => {
        if (this.restoring === run) this.restoring = undefined
      })
      this.restoring = run
    }
    return this.restoring
  }

  private async runRestore(): Promise<void> {
    // Saved values only, and none while a session write is in flight: it may yet fail.
    if (this.sessionWritesInFlight > 0) return
    const { cache, storageId, credentialId } = readCommittedSession()
    if (!cache) return
    const epoch = this.epoch
    const writes = this.sessionWrites
    const proof = await this.proveCache(cache, storageId, credentialId)
    // A commit or a sign-out landed while this restore awaited: it owns the session now.
    if (this.epoch !== epoch) return
    if (this.sessionWritesInFlight > 0 || this.sessionWrites !== writes) return
    if (proof.kind === "unknown") return
    if (proof.kind === "invalid") {
      await this.dropInvalidCache(cache, storageId, credentialId)
      return
    }
    this.msk = proof.msk
    this.derivedKeys.clear()
    // A signer already built from this credential's record stays: an account built on it is the pair's.
    const kept =
      this.authProvider && this.providerCredential.get(this.authProvider) === cache.credentialId
    if (kept) return
    this.authProvider = this.buildProvider(
      hexBytes(proof.record.pubkey),
      cache.credentialId,
      setOf(proof.record),
    )
  }

  /**
   * Drop a cache that failed its proof. When the failed tuple names the active session
   * the whole session goes (the account it points at is not this key's); otherwise only the blob
   * goes. Only the active tab opens the wallet database, so a plain removal is enough — no
   * cross-tab compare-and-remove.
   */
  private async dropInvalidCache(
    cache: CachedMsk,
    storageId: string | null,
    credentialId: string | null,
  ): Promise<void> {
    // Saved before the restore settles, so nothing after it reads the rejected session.
    if (storageId && cache.storageId === storageId && cache.credentialId === credentialId) {
      await walletStorage.batch(() => clearActiveStorage())
      return this.onSessionSaved()
    }
    // A blob for another session, or one with no session at all: the blob goes, nothing else.
    return walletStorage.batch(() => clearCachedMsk())
  }

  /**
   * Whether the cache is this session's key for this browser's account. `unknown` is a check that
   * could not run (the wallet threw), which leaves the cache in place for the next attempt.
   */
  private async proveCache(
    cache: CachedMsk,
    storageId: string | null,
    credentialId: string | null,
  ): Promise<
    { kind: "valid"; msk: Fr; record: RecoveryMetadata } | { kind: "invalid" } | { kind: "unknown" }
  > {
    const { deriveAddress, readAccount } = this
    if (!deriveAddress || !readAccount) return { kind: "unknown" }
    if (!storageId || storageId !== cache.storageId || credentialId !== cache.credentialId) {
      return { kind: "invalid" }
    }
    const record = await this.identityMap.get(cache.credentialId)
    if (!record?.l2Address || !opensWallet(record) || !memberOf(setOf(record), record.pubkey)) {
      return { kind: "invalid" }
    }
    let msk: Fr
    try {
      msk = Fr.fromHexString(cache.msk)
    } catch {
      return { kind: "invalid" }
    }
    if ((await storageIdFromSecret(new Uint8Array(msk.toBuffer()))) !== cache.storageId) {
      return { kind: "invalid" }
    }
    let snapshot: StoredAccountSnapshot | null
    let derived: string
    try {
      snapshot = await readAccount()
      derived = await deriveAddress(msk, setOf(record))
    } catch {
      return { kind: "unknown" }
    }
    if (
      snapshot?.kind !== "webauthn" ||
      !sameHex(derived, record.l2Address) ||
      !sameHex(derived, snapshot.address) ||
      !(await this.signsForWallet(snapshot, cache.credentialId, record))
    ) {
      return { kind: "invalid" }
    }
    return { kind: "valid", msk, record }
  }

  /**
   * Whether the stored account's signer is the cached credential, or another key of its wallet this
   * browser holds an opening record for. An unlock with another key commits the session before it
   * rewrites the stored signer, so a failed rewrite must not cost that session.
   */
  private async signsForWallet(
    signer: { credentialId: string; pubkey: string },
    credentialId: string,
    record: RecoveryMetadata,
  ): Promise<boolean> {
    if (signer.credentialId === credentialId) return sameHex(signer.pubkey, record.pubkey)
    const other = await this.identityMap.get(signer.credentialId)
    return (
      !!other &&
      opensWallet(other) &&
      sameHex(other.pubkey, signer.pubkey) &&
      sameHex(other.l2Address, record.l2Address) &&
      memberOf(setOf(record), other.pubkey)
    )
  }

  async getDerivedKey(domain: string): Promise<Uint8Array> {
    if (DOMAIN_SEPARATORS[domain] === undefined) {
      throw new WalletError("invariant", `Unknown derived-key domain: ${domain}`)
    }
    const hit = this.derivedKeys.get(domain)
    if (hit) return hit
    if (!this.msk) {
      throw new WalletError(
        "invariant",
        "MSK is not available; unlock (recover + commit) before deriving keys",
      )
    }
    const key = await deriveKeyFromSecret(this.msk, domain)
    this.derivedKeys.set(domain, key)
    return key
  }

  async createPasskey(
    accountName: string,
    updateStatus?: (status: string) => void,
    opts?: {
      mode?: "combined" | "platform" | "security-key"
      route?: SignInRoute
      signal?: AbortSignal
    },
  ): Promise<{
    authProvider: AlphaAuthProvider
    credentialId: string
    pubkey: string
    secretKey: Fr
    prfSlot?: PrfSlot
    prfAaguid?: string
    authenticatorType?: "platform" | "security-key"
    transports?: readonly string[]
  }> {
    const posture = this.posture()
    const { creation, choice } = this.heldCreation ?? {}
    this.heldCreation = undefined
    // The gate makes this unreachable: it hands out "this-device" only with a snapshot that allows it.
    if (opts?.route === "this-device" && !creation?.local) {
      throw new WalletError("invariant", "laptop creation was not offered")
    }
    const localCreation =
      opts?.route === "this-device" && creation?.local
        ? {
            managers: creation.managers,
            appleWithdrawn: creation.withdrawn.includes("apple"),
            appleKeyAtCreation: appleKeyAtCreation(creation),
          }
        : undefined
    // The screen's attempt rides on the status callback front-core hands over; see
    // `passkeyAttemptScope`.
    const asking = this.asking(scopeOfStatus(updateStatus))
    updateStatus?.("Creating passkey…")
    const userAgent = await this.userAgent()
    // A screen that left during the read sends no request.
    opts?.signal?.throwIfAborted()
    // The driver's `securityKey` never becomes the record's `authenticatorType`: every record this
    // wallet writes says "platform", since the real class turns on front-core's no-anchor commit
    // branch and the no-backup acknowledgement, which land together with the screen that warns the
    // user. The record keeps the verdict as its own flag, for naming the key.
    const creating = runPasskeyCreation(asking, {
      posture,
      rpId: this.rpId,
      rpName: this.rpName,
      userName: accountName,
      userAgent,
      laptopHints: this.laptopHintsForRoute(opts?.route, choice),
      ...(localCreation ? { localCreation } : {}),
      extraProviders: this.extraProviders,
      misreportsCrossDevice: this.misreportsCrossDevice(),
      attachmentLabelTrusted: this.trustsAttachmentLabel(),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      challengeForChained: async () => {
        updateStatus?.("Reading key material…")
        return new Uint8Array(randomChallenge())
      },
      observe: ({ phase, result }) => {
        // Only the creation response carries the provider id and the route as the browser reported
        // it; a chained assertion must not overwrite them. The record waits on Client Hints and
        // never holds the ceremony.
        if (phase === "created") {
          void recordPasskeyEnvironment(
            {
              aaguid: result.aaguid,
              created: {
                attachment: result.authenticatorAttachment,
                transports: result.transports,
              },
              posture,
            },
            PASSKEY_ENVIRONMENT_KEY,
          )
        }
      },
    })
    const { created, slot, prfOutput, securityKey } = await (localCreation
      ? countingLocalRefusals(creating)
      : creating
    ).catch((err: unknown) => {
      if (err instanceof LaptopPasskeyRefusedError && err.appleRefusedHere) this.appleRefused = true
      throw err
    })
    const secretKey = deriveMskFromPrfOutput(prfOutput)
    const pubkey = Buffer.from(created.pubkey).toString("hex")
    const authProvider = this.buildProvider(created.pubkey, created.credentialId, [pubkey])
    this.createdHandles.set(created.credentialId, bytesToBase64Url(created.userHandle))
    if (securityKey) this.createdSecurityKeys.add(created.credentialId)

    return {
      authProvider,
      credentialId: created.credentialId,
      pubkey,
      secretKey,
      prfSlot: slot,
      prfAaguid: created.aaguid,
      authenticatorType: "platform",
      transports: created.transports,
    }
  }

  /**
   * Create a backup passkey for the signed-in account on `ceremony` and return it with the PRF
   * output the master key is sealed under. `choice` is where the Passkeys sheet's picker said the
   * passkey lives; the driver shapes its request from it. Its handle is kept for its record, as a
   * sign-up passkey's is; nothing else about the credential is recorded until the rotation installs it.
   */
  async createBackupPasskey(
    driver: BackupCreationDriver,
    ceremony: PasskeyCeremony,
    opts: {
      userName: string
      choice?: BackupAddChoice
      observe?: CeremonyObserver
      signal?: AbortSignal
    },
  ): Promise<BackupCreation> {
    const userAgent = await this.userAgent()
    opts.signal?.throwIfAborted()
    const creation = await driver(ceremony, {
      posture: this.posture(),
      rpId: this.rpId,
      rpName: this.rpName,
      userName: opts.userName,
      userAgent,
      extraProviders: this.extraProviders,
      challengeForChained: () => new Uint8Array(randomChallenge()),
      ...(opts.choice ? { choice: opts.choice } : {}),
      ...(opts.observe ? { observe: opts.observe } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    this.createdHandles.set(
      creation.created.credentialId,
      bytesToBase64Url(creation.created.userHandle),
    )
    return creation
  }

  /**
   * The credential this origin opens its wallet with, if one was recorded: the one that opened
   * `l2Address` when given, so a browser with several records never pins another account's.
   */
  async rootCredentialId(l2Address?: string): Promise<string | undefined> {
    return (await this.identityMap.getOpeningRecord(l2Address))?.credentialId
  }

  /** The record this browser opens `l2Address` with: its root credential's, else a backup's. */
  async accountRecord(l2Address: string): Promise<RecoveryMetadata | undefined> {
    return (
      (await this.identityMap.getRootRecord(l2Address)) ??
      (await this.identityMap.getOpeningRecord(l2Address))
    )
  }

  /** The account that pays for `credentialId`'s sponsored batches on the ClaimFPC at `fpc`. */
  async recordFeePayer(credentialId: string, fpc: string, payer: FeePayerEntry): Promise<void> {
    await this.identityMap.setFeePayer(credentialId, fpc, payer)
  }

  /** `stillOwns` is checked under the map's lock, so a cancel that landed while waiting writes nothing. */
  async recordRecoveryMetadata(
    meta: StoredRecoveryMetadata,
    stillOwns?: () => boolean,
  ): Promise<void> {
    const userHandle = meta.userHandle ?? this.createdHandles.get(meta.credentialId)
    const securityKey = meta.securityKey || this.createdSecurityKeys.has(meta.credentialId)
    await this.identityMap.upsert(
      {
        ...meta,
        ...(userHandle ? { userHandle } : {}),
        ...(securityKey ? { securityKey: true } : {}),
      },
      stillOwns,
    )
    const where = this.answerSeen(meta.credentialId)
    if (where) {
      await this.identityMap
        .setAnswered(meta.credentialId, where, stillOwns)
        .catch((err) => console.warn("passkey answer not recorded", err))
    }
    const implied = this.implied.get(meta.credentialId)
    if (!implied || implied === "refused") return
    await this.identityMap
      .setInferredTransports(meta.credentialId, implied, stillOwns)
      .catch((err) => console.warn("passkey transports not recorded", err))
  }

  /**
   * Nothing is held or pointed at until every value the switch needs exists. The pointers go down
   * first, so every write that follows lands under the new session, and the key is installed only
   * once they are there. A store that refuses them refuses everything, so that throws and the
   * previous session stands. The cached key is the one part that may be missing and still leave a
   * usable session: without it a reload asks for the passkey, which the wallet already knows how
   * to do. A commit without a passkey (the demo seed) caches nothing and removes a passkey
   * session's cache and credential pointer. With `stillOwns`: the generation of the session it
   * started (for `sessionHeld`), or false, with nothing written, when the caller's operation
   * ended on the way.
   */
  commitSecret(input: CommitSecretInput): Promise<void>
  commitSecret(input: CommitSecretInput, stillOwns: () => boolean): Promise<number | false>
  async commitSecret(
    input: CommitSecretInput,
    stillOwns?: () => boolean,
  ): Promise<number | false | void> {
    return this.commit(input, stillOwns)
  }

  /** Whether this session's key is cached, so the next reload opens without a passkey prompt. */
  keyCached(): boolean {
    const id = getActiveStorageId()
    return id !== null && readCachedMsk()?.storageId === id
  }

  /**
   * Whether this page's record stores may still hold another account's records: a commit moved
   * the session away from an active one, or onto an account this browser already held records
   * for. The stores load once per page, so only a reload clears it.
   */
  recordsStale(): boolean {
    return this.staleRecords
  }

  /** A commit kept the storage id but moved the session's address: the page's stores hold the old one. */
  markRecordsStale(): void {
    this.staleRecords = true
  }

  /**
   * Whether the session committed as `generation` is still this service's, with no commit saving
   * over it. Work begun under a session asks before writing, so a session that replaced it, or is
   * replacing it, is never written into.
   */
  sessionHeld(generation: number): boolean {
    return this.epoch === generation && this.sessionWritesInFlight === 0
  }

  /** The address this browser's record names for the session's credential; none without a passkey session. */
  async sessionAddress(): Promise<string | undefined> {
    const credentialId = getActiveCredentialId()
    return credentialId ? (await this.identityMap.get(credentialId))?.l2Address : undefined
  }

  /** Whether the session read as `epoch` and `credentialId` has been replaced, or a write is replacing it. */
  private sessionMoved(epoch: number, credentialId: string | null): boolean {
    return (
      this.epoch !== epoch ||
      getActiveCredentialId() !== credentialId ||
      this.sessionWritesInFlight > 0
    )
  }

  /** Resolves once the session write in flight, if any, has finished its turn under the lock. */
  private sessionSettled(): Promise<void> {
    return this.sessionWritesInFlight > 0 ? withSessionLock(async () => {}) : Promise.resolve()
  }

  /** `stillOwns` lets a ceremony that outlived its session (a commit or clear landed while its
   * prompt was open) write nothing. The tuple is written under the session lock, so no other
   * commit or sign-out on this page runs between reading the session it replaces and saving. */
  private async commit(
    input: CommitSecretInput,
    stillOwns?: () => boolean,
  ): Promise<number | false> {
    // Read before the first await: a sign-out during the derivation or the lock wait fences it.
    const fence = this.fence
    const storageId = await storageIdFromSecret(new Uint8Array(input.secretKey.toBuffer()))
    const credentialId = this.providerCredential.get(input.authProvider)
    const committed = await withSessionLock(async () => {
      if (this.fence !== fence) return false
      if (stillOwns && !stillOwns()) return false
      const held = getActiveStorageId()
      const replaced = readSessionTuple()
      // Read before anything is written under the new account, which the sign-in does right after.
      const leavesStale =
        held !== storageId && (held !== null || (await holdsAccountRecords(storageId)))
      // Pointers and cache as one transaction: a rejection leaves the stored session as it was.
      // Restores stand down until this settles, cleanup included.
      this.sessionWrites++
      this.sessionWritesInFlight++
      try {
        await walletStorage.batch(() => {
          setActiveStorageId(storageId)
          if (credentialId) {
            setActiveCredentialId(credentialId)
            writeCachedMsk({ v: 1, storageId, credentialId, msk: input.secretKey.toString() })
          } else {
            clearActiveCredentialId()
            clearCachedMsk()
          }
        })
        // A sign-out queued its removals behind this write; they undo it.
        if (this.fence !== fence) return false
        if (stillOwns && !stillOwns()) {
          // Cancelled while saving. Still inside the session lock, so no newer commit has saved
          // since: put back the session this one replaced. If that fails, nothing restores the
          // cancelled one.
          try {
            await walletStorage.batch(() => writeSessionTuple(replaced))
          } catch (err) {
            this.clear()
            this.restoreSuppressed = true
            throw err
          }
          return false
        }

        if (leavesStale) this.staleRecords = true
        this.onSessionSaved()
        this.epoch++
        this.restoreSuppressed = false
        this.msk = input.secretKey
        this.authProvider = input.authProvider
        this.derivedKeys.clear()
        return this.epoch
      } finally {
        this.sessionWritesInFlight--
      }
    })
    // The sign-in screens mark the key that last opened the wallet here.
    if (committed !== false && credentialId) {
      void this.identityMap
        .setUsed(credentialId)
        .catch((err) => console.warn("passkey use not recorded", err))
    }
    return committed
  }

  isUnlocked(): boolean {
    return this.msk !== undefined
  }

  /**
   * Warm-session unlock: re-derive the MSK from the session's passkey (one assertion), verify the
   * candidate against this browser's own record with `deriveAddress`, and commit it. The local
   * identity map + OPFS PXE store already hold the account, so — unlike /enter's cross-device
   * recovery — no L1 lookup or L2 re-register is needed; only the in-memory MSK was lost to the
   * refresh. Bound to this tab's session credential: a session with no record for it goes through
   * /enter, never to whichever root is newest on the device. No-op when already unlocked, and a
   * cache that proves out now costs no ceremony. A session that changed while the prompt was open
   * (a commit or sign-out here, a logout or account switch elsewhere) keeps the result out:
   * `SessionChangedError`, and whoever changed it owns the tab. `credentialId` is the key the user
   * chose, the session's or another of its set; this browser must hold its record for the same
   * wallet, and the session moves to it.
   */
  async unlock(deriveAddress: AddressDeriver, options: UnlockOptions = {}): Promise<void> {
    await this.restoreFromCache()
    if (this.msk) return
    // Concurrent callers share one ceremony. The unlock gate, a `/link` claim and a re-tapped
    // button can all land within the same window, and a second passkey request while the first is up
    // is exactly what the browser rejects with "A request is already pending." A later call joins the
    // flight only while its owner's signal is still live; an owner that has gone away starts its own.
    // The shared ceremony is the flight owner's, so its attempt is the one the requests are
    // reported as.
    const current = this.unlocking
    if (current && !current.signal?.aborted) return current.promise
    const flight: UnlockFlight = {
      signal: options.signal,
      promise: this.runUnlock(deriveAddress, options).finally(() => {
        if (this.unlocking === flight) this.unlocking = undefined
      }),
    }
    this.unlocking = flight
    return flight.promise
  }

  private async runUnlock(deriveAddress: AddressDeriver, options: UnlockOptions): Promise<void> {
    const { signal, own, phone, credentialId: asked } = options
    const storageId = getActiveStorageId()
    const sessionId = getActiveCredentialId()
    const epoch = this.epoch
    const session = sessionId ? await this.identityMap.get(sessionId) : undefined
    if (!storageId || !sessionId || !session?.l2Address) throw new NoPasskeySessionError()
    const credentialId = asked ?? sessionId
    const record =
      credentialId === sessionId ? session : await this.sameWalletRecord(session, credentialId)
    const stillOwns = () => this.epoch === epoch && !signal?.aborted
    signal?.throwIfAborted()
    // A backup record's unlock is one backup sign-in event, whatever ends it: a failure to open is
    // reported where the envelope is opened, every other end here.
    const backupFacts = record.backup ? backupFactsOf(undefined, record) : undefined
    let recovered: WebRecoverResult | undefined
    try {
      recovered = await this.recoverPasskey({
        credentialId,
        signal,
        ...(own ? { own } : {}),
        ...(phone ? { phone } : {}),
        ...(asked ? { chosen: true } : {}),
      })
      // The sheet was held to the asked credential; only its own record's answer may unlock it.
      if (
        recovered.credentialId !== credentialId ||
        recovered.expectedAddress !== record.l2Address
      ) {
        throw new WalletError("passkey.unasked")
      }
      let msk: Fr
      try {
        msk = await selectRecoveredMsk(recovered, (candidate) =>
          deriveAddress(candidate, recovered!.passkeys ?? [recovered!.pubkey]),
        )
      } catch (err) {
        throw this.tagRecordMismatch(err, recovered)
      }
      signal?.throwIfAborted()
      const committed = await this.commit(
        { secretKey: msk, authProvider: recovered.authProvider },
        stillOwns,
      )
      if (!committed) {
        // A cancel that landed inside the commit is the cancel, not a lost session.
        signal?.throwIfAborted()
        throw new SessionChangedError()
      }
      // The stored signer follows the session. Already committed: if this write fails, the restore
      // still accepts the stored key as another of the wallet's.
      if (credentialId !== sessionId) {
        await withSessionLock(async () => {
          if (!this.sessionHeld(committed)) return
          await this.writeSigner?.({
            credentialId,
            pubkey: record.pubkey,
            authenticatorType: record.authenticatorType ?? "platform",
          })
        }).catch((err) => console.warn("stored signer not moved", err))
      }
    } catch (err) {
      if (backupFacts && !(err instanceof PasskeyEnvelopeError)) {
        const facts = recovered?.backupFacts ?? backupFacts
        if (isPasskeyCancelled(err)) noteBackupSignIn("cancelled", facts)
        else if (isPasskeyPolicyError(err)) noteBackupSignIn("refused", facts)
        else noteBackupSignIn("failed", facts)
      }
      throw err
    }
    if (backupFacts) noteBackupSignIn("succeeded", recovered.backupFacts ?? backupFacts)
  }

  /**
   * `credentialId`'s record when it opens the session's wallet: the same address, and a key in both
   * its own set and the session's.
   */
  private async sameWalletRecord(
    session: RecoveryMetadata,
    credentialId: string,
  ): Promise<RecoveryMetadata> {
    const record = await this.identityMap.get(credentialId)
    if (
      !record ||
      !sameHex(record.l2Address, session.l2Address) ||
      !opensWallet(record) ||
      !memberOf(setOf(record), record.pubkey) ||
      !memberOf(setOf(session), record.pubkey)
    ) {
      throw new WalletError("passkey.unasked")
    }
    return record
  }

  /**
   * Which verdict a mismatch against this browser's record is. `wrong-key` — a certain wrong key on
   * this computer — needs this computer's own copy to have answered (a `platform` attachment) and the
   * record's bound slot to have been evaluated: `selectRecoveredMsk` skips an absent candidate and
   * throws the same mismatch, so a one-slot answer proves nothing. Anything else is the weaker
   * `not-reproduced`.
   */
  mismatchVerdict(recovered: WebRecoverResult): MismatchVerdict {
    const boundSlotEvaluated =
      recovered.hasPersistedSlot && recovered.candidates[recovered.preferredSlot] !== undefined
    return this.answeredLocally(recovered.observed?.attachment) && boundSlotEvaluated
      ? "wrong-key"
      : "not-reproduced"
  }

  /** Whether this computer's own copy answered: a `platform` attachment on a laptop, not another device. */
  answeredLocally(attachment: PasskeyAttachment | undefined): boolean {
    return this.posture() === "laptop" && attachment === "platform"
  }

  /**
   * A mismatch against a record we hold: decide the verdict and tag the error so the screen renders
   * the right card. Any other error passes through untouched.
   */
  private tagRecordMismatch(err: unknown, recovered: WebRecoverResult): unknown {
    if (!(err instanceof StoredAddressMismatchError)) return err
    return Object.assign(err, {
      verdict: this.mismatchVerdict(recovered),
      observed: recovered.observed,
    })
  }

  /** Attach which device answered to an early refusal so the screen can diagnose it. */
  private withObservation(
    err: unknown,
    assertion: PasskeyAssertResult,
    steered = false,
    record?: RecoveryMetadata,
  ): unknown {
    const observed = this.observationOf(assertion, steered, record)
    return typeof err === "object" && err ? Object.assign(err, { observed }) : err
  }

  /**
   * One assertion reads both PRF slots. Nothing is committed here: the caller derives each
   * candidate's address and lets an anchor pick (`selectRecoveredMsk`, or the onboarding resolver
   * on a fresh browser). This browser's own record is checked before the package's gates: a rotated
   * credential is refused whatever its assertion carried.
   *
   * With a record for the credential the result is settled: the record names the key. With no
   * record the result is unsettled: the signature recovers to two keys, and `settle` takes the one
   * a caller can name (a record elsewhere, the L1 account's installed key) or runs a second
   * assertion over another random challenge, which only one of the two keys can also have signed.
   */
  async beginRecovery(request?: string | RecoverPasskeyRequest): Promise<BeginRecoveryResult> {
    const posture = this.posture()
    const asked = typeof request === "string" ? { credentialId: request } : request
    // A recorded passkey is named to the authenticator, so the browser never asks the user to pick
    // one. A discoverable request, and a fresh device (no record), leave the list open, so the
    // browser's sheet offers every passkey for the relying party.
    const rootId = asked?.discover
      ? undefined
      : asked?.credentialId ?? (await this.identityMap.getOpeningRecord())?.credentialId
    // The record for that credential, when this browser holds one: what it says about reaching the
    // authenticator is what steers the sheet. A credential this browser never saw sends nothing.
    const assertion = await this.assertForRecovery(posture, randomChallenge(), {
      ...(rootId
        ? { credentialIds: [rootId], ...(await this.reachOf(rootId, asked?.chosen)) }
        : {}),
      signal: asked?.signal,
      own: asked?.own,
      phone: asked?.phone,
    })
    // The sheet was held to the named credential; an answer from any other is not the session's.
    if (rootId && assertion.credentialId !== rootId) throw new WalletError("passkey.unasked")
    const record = await this.openingRecord(assertion.credentialId)
    const steered = asked?.phone === true
    if (record?.backup) {
      // The record's envelope names the key; the backup gate does not apply to a key that opens one.
      const pubkeyCandidates = await candidatePubkeys(assertion)
      if (!pubkeyCandidates.includes(normalKey(record.pubkey))) throw new RotatedCredentialError()
      const { account, envelope } = envelopeOf(record.backup)
      const opened = await this.openedCandidate(assertion, envelope, account, record, steered)
      return this.recovered({
        assertion,
        candidates: opened.candidates,
        pubkey: hexBytes(record.pubkey),
        passkeys: setOf(record),
        record,
        steered,
        opened: { backup: record.backup, backupFacts: opened.backupFacts },
      })
    }
    let candidates: RecoverPasskeyResult["candidates"]
    try {
      candidates = toFrCandidates(candidatesFrom(assertion))
    } catch (err) {
      // The observation rides the error so the screen can diagnose the miss.
      throw this.withObservation(err, assertion, steered, record)
    }

    const pubkeyCandidates = await candidatePubkeys(assertion)
    if (record) {
      // A record whose key the signature cannot have come from is another credential's.
      if (!pubkeyCandidates.includes(normalKey(record.pubkey))) throw new RotatedCredentialError()
      return this.recovered({
        assertion,
        candidates,
        pubkey: hexBytes(record.pubkey),
        passkeys: setOf(record),
        record,
        steered,
      })
    }

    return {
      candidates,
      preferredSlot: preferredSlot(assertion.authenticatorAttachment, undefined),
      expectedAddress: undefined,
      candidateSource: "webauthn",
      authenticatorType: "platform",
      credentialId: assertion.credentialId,
      pubkeyCandidates,
      observed: this.observationOf(assertion, steered),
      settle: async (pubkey?: string, attempt?: AbortSignal, passkeys?: readonly string[]) => {
        if (pubkey !== undefined) {
          const wanted = normalKey(pubkey)
          if (!pubkeyCandidates.includes(wanted)) {
            throw new WalletError(
              "invariant",
              "That key is not a candidate of this sign-in's signature",
            )
          }
          const set = passkeys ? passkeys.map(normalKey) : [wanted]
          return this.recovered({
            assertion,
            candidates,
            pubkey: hexBytes(wanted),
            passkeys: set,
            steered,
          })
        }
        // The second assertion signs another random challenge, so the two signatures share exactly
        // one recovered key. It sends no salts and is deliberately left unsteered and unchecked: a
        // laptop holding a synced copy answers it on the spot, where demanding the phone a second
        // time refuses an answer that was never going to be wrong.
        const second = await this.asking(asked?.own).assert({
          rpId: this.rpId,
          challenge: new Uint8Array(randomChallenge()),
          credentialIds: [assertion.credentialId],
          ...(attempt ? { signal: attempt } : {}),
        })
        void this.learnAnswer(second, () => !attempt?.aborted)
        const recoveredKey = await recoverPubkeyFromAssertions(assertion, second)
        const own = Buffer.from(recoveredKey).toString("hex")
        return this.recovered({
          assertion,
          candidates,
          pubkey: recoveredKey,
          passkeys: [own],
          steered,
        })
      },
    }
  }

  /** `beginRecovery`, settled by the second assertion when the key is not known. */
  async recoverPasskey(request?: string | RecoverPasskeyRequest): Promise<WebRecoverResult> {
    const begun = await this.beginRecovery(request)
    return isUnsettled(begun) ? begun.settle() : begun
  }

  /**
   * A sign-in by tag: one assertion against the account's installed keys. The answering credential
   * must name one of them, and its signature must carry that key, before anything is committed; a
   * key named by its raw credential id derives the master key from the PRF, one named by the hash
   * oxide's prefix carries opens its envelope. The sheet is held to the credential ids the keys
   * name (a root's raw id, a backup's id behind its envelope), so a passkey the browser cannot
   * list still answers. A record this browser holds for the credential outranks the hint, and its
   * set outranks the chain's list when the record is strictly ahead of it; a record the list is
   * strictly ahead of is stale. A `chosen` credential is the only one named, and is still matched
   * against every key.
   */
  async adoptAccountPasskey(
    hint: AccountPasskeys & { signal?: AbortSignal; own?: PasskeyRequestScope; phone?: boolean },
  ): Promise<WebRecoverResult> {
    const posture = this.posture()
    const { account, keys, chosen } = hint
    const rawIds = candidateCredentialIds(keys)
    if (chosen !== undefined && !rawIds.includes(chosen)) throw new HintedKeyMismatchError()
    const named = chosen !== undefined ? [chosen] : rawIds
    // Steering from this browser's record applies when exactly one credential is named.
    const pinned = named.length === 1 ? named[0] : undefined
    const assertion = await this.assertForRecovery(posture, randomChallenge(), {
      ...(named.length > 0 ? { credentialIds: named } : {}),
      ...(pinned ? await this.reachOf(pinned, chosen !== undefined) : {}),
      signal: hint.signal,
      own: hint.own,
      phone: hint.phone,
    })
    if (chosen !== undefined && assertion.credentialId !== chosen) {
      throw new WalletError("passkey.unasked")
    }
    const record = await this.openingRecord(assertion.credentialId)
    const steered = hint.phone === true
    const answer = answeringKey(keys, assertion.credentialId)
    if (!answer) throw new HintedKeyMismatchError()
    const wanted = normalKey(answer.key.pubkeyHex)
    if (!(await candidatePubkeys(assertion)).includes(wanted)) throw new HintedKeyMismatchError()
    // This browser's own record for the credential outranks the hint.
    if (record && !sameHex(record.pubkey, wanted)) throw new HintedKeyMismatchError()
    const pubkey = hexBytes(wanted)
    // L1 may list a key twice; the set holds it once.
    const listed = [...new Set(keys.map((k) => normalKey(k.pubkeyHex)))]
    const recorded = record ? setOf(record) : undefined
    const passkeys = recorded && strictlyContains(recorded, listed) ? recorded : listed
    const staleSet = recorded && strictlyContains(listed, recorded) ? recorded : undefined
    if (answer.by === "raw" || answer.key.parsed.kind !== "envelope-prefixed") {
      let candidates: RecoverPasskeyResult["candidates"]
      try {
        candidates = toFrCandidates(candidatesFrom(assertion))
      } catch (err) {
        throw this.withObservation(err, assertion, steered, record)
      }
      return this.recovered({ assertion, candidates, pubkey, passkeys, record, steered, staleSet })
    }
    const envelope = answer.key.parsed.envelope
    const opened = await this.openedCandidate(assertion, envelope, account, record, steered)
    return this.recovered({
      assertion,
      candidates: opened.candidates,
      pubkey,
      passkeys,
      record,
      steered,
      opened: {
        backup: { account, envelope: `0x${Buffer.from(envelope).toString("hex")}` },
        backupFacts: opened.backupFacts,
      },
      staleSet,
    })
  }

  /**
   * A recovery result from the key this session already holds (restored or freshly committed),
   * under the passkey it is bound to, when that passkey has a record here. One candidate, the
   * record's address as its anchor; nothing when locked or unbound. `restore: false` consults only
   * the key already in memory: a caller answering a tap must not start the cache proof, which reads
   * the account and derives its address, on the way to the prompt. With no session on this rollup,
   * the key a retired rollup's session cached answers instead.
   */
  async recoverFromCache(options?: { restore?: boolean }): Promise<WebRecoverResult | undefined> {
    if (!this.msk && options?.restore !== false) await this.restoreFromCache()
    // One session's key, signer and credential, taken before the record's read: a session that
    // moved, or is still moving, during the read is read again.
    const { msk, authProvider, epoch } = this
    const credentialId = getActiveCredentialId()
    if (!msk && options?.restore !== false && !this.restoreSuppressed) {
      const retired = retiredSession()
      if (retired && this.sessionWritesInFlight === 0) return this.retiredRecovery(retired)
    }
    if (!msk || !authProvider || !credentialId) return undefined
    const record = await this.openingRecord(credentialId)
    if (this.sessionMoved(epoch, credentialId)) {
      await this.sessionSettled()
      return this.recoverFromCache(options)
    }
    if (!record?.l2Address) return undefined
    const slot = record.prfSlot ?? "first"
    return {
      authProvider,
      credentialId,
      pubkey: record.pubkey,
      passkeys: setOf(record),
      candidates: { [slot]: msk },
      preferredSlot: slot,
      hasPersistedSlot: false,
      candidateSource: "webauthn",
      expectedAddress: record.l2Address,
      authenticatorType: record.authenticatorType ?? "platform",
      ...(record.backup ? { backup: record.backup } : {}),
    }
  }

  /**
   * The retired session's key as a recovery result. No `expectedAddress`: the address it recorded
   * is the retired rollup's, so the sign-in's anchors on this rollup name the account.
   */
  private retiredRecovery({ credentialId, msk, record }: RetiredSession): WebRecoverResult {
    const slot = record.prfSlot ?? "first"
    return {
      authProvider: this.buildProvider(hexBytes(record.pubkey), credentialId, setOf(record)),
      credentialId,
      pubkey: record.pubkey,
      passkeys: setOf(record),
      candidates: { [slot]: msk },
      preferredSlot: slot,
      hasPersistedSlot: false,
      candidateSource: "webauthn",
      authenticatorType: record.authenticatorType ?? "platform",
      ...(record.backup ? { backup: record.backup } : {}),
      ...(record.usertag ? { usertag: record.usertag } : {}),
    }
  }

  /** Drop the key from memory. A cache that still exists restores it on the next read. */
  clear(): void {
    this.epoch++
    this.msk = undefined
    this.authProvider = undefined
    this.restoring = undefined
    this.derivedKeys.clear()
  }

  /**
   * A sign-out's fence, at once: the key is gone from memory and no cache restores it until the
   * next commit, so the tuple's removal can follow under the lock without a read slipping between.
   */
  lockOut(): void {
    this.clear()
    this.fence++
    this.restoreSuppressed = true
  }
}

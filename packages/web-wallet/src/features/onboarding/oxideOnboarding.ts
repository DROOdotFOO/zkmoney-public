import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { withSessionLock } from "../../platform/storage/activeStorage"
/**
 * Web glue for the onboarding rails, over shared front-core primitives
 * (`startOxideRegistrationSession`, `resolveTagViaRegistry`): the gasless L1 NameClaim
 * (account-service), the ClaimFPC eligibility witness every sponsored rail batches its
 * subscription with, and the returning-user recovery flows (reuse a passkey for a new
 * tag; fresh-device enter via on-chain lookup). Fresh passkey-account creation runs
 * through front-core's `createAccount`.
 *
 * Onboarding's account-service gate accepts a synthetic keyId against an `IS_TEST_MODE`
 * deployment (sandbox, the e2e); a real deployment still needs a credential provider wired
 * into `claimTag`'s `AccountServiceClient` before its gated routes will pass (tracked
 * alongside the registration-by-deposit rewrite — see docs/proposals/registration-fee-plan.md).
 */
import { forgetDepositAdmission, refundedEntry } from "../identity/admission"
import { assertEarnedQuote } from "./earnedQuote"
import {
  assertRegistrationRefunded,
  assertRegistrationUnfunded,
  reopenRefundedDeposit,
} from "./registrationQuoteRecovery"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { toBytes, toHex, type Hex, type PublicClient } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import {
  AccountServiceClient,
  AccountStorage,
  composeWireNameHash,
  matchWireNameHash,
  createOxideL1Reader,
  resolveStoredCredentialId,
  createRegistrationSipaDeriver,
  deriveBootstrapKey,
  metadataMigrationBinding,
  pubkeyToR1KeyArg,
  readInstalledPasskeyKey,
  requireVerifiedIdentity,
  resolveOxideIdentity,
  resolveRecoveredMsk,
  startOxideRegistrationSession,
  StoredAddressMismatchError,
  type AnchorTier,
  type BootstrapKeyProvider,
  NameClaimStore,
  type PendingRegistrationRecord,
  type NameTakenReason,
  type OxideL1Reader,
  type OxideRegistrationSessionDeps,
  type RecoveredCandidates,
  UnverifiedOxideIdentityError,
  type ResolvedMsk,
  type OxideRegistrationStage,
  type OxideSignDeps,
  goldenTicketCoverage,
} from "@obsidion/front-core"
import { activeWithdrawalFee } from "../withdraw/withdrawalFee"
import { SANDBOX_REGISTRATION_BENEFICIARY_ID } from "@obsidion/core/constants"
import type { NameClaimResponse, RegistrationSchedule } from "@obsidion/core/types"
import { makeRegistrationDepositSeeder, seededRegistrationSalt } from "./registrationDepositSeed"
import {
  claimTerms,
  readRegistrationSchedule,
  resolveBeneficiary,
  saveRegistrationTerms,
  wireTermsFundLink,
  wireTermsFundTicket,
  type RegistrationTerms,
} from "./registrationTerms"
import { linkIdentity } from "../paylink/linkIdentity"
import {
  archiveReplacedRegistration,
  forgetReplacedRegistration,
  getPendingStore,
} from "./webRegistration"
import { updateTicketSignup, type TicketSignupStash } from "../paylink/claimStash"
import { redeemGoldenTicketForLink } from "./goldenTicket"
import { rememberRegistrationPayload } from "../broadcasts/broadcasts"
import type {
  ContractService,
  ObsidionWallet,
  ObsidionAccount,
  AlphaAuthProvider,
  NameClaimWitness,
  OxideAccountBinding,
  PrfSlot,
  RecoverPasskeyResult,
} from "@obsidion/sdk"
import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import type { WebWalletConfig } from "../../config/env"
import {
  AmbiguousPasskeyError,
  PasskeyPolicyError,
  type PasskeyRequestScope,
  currentDevicePosture,
} from "@obsidion/passkey-web"
import { GateCancelledError, type CeremonyGate } from "../identity/ceremonyGate"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import {
  type AccountPasskeys,
  type BeginRecoveryResult,
  HintedKeyMismatchError,
  type MismatchVerdict,
  type Observation,
  type UnsettledRecovery,
  type WebRecoverResult,
  isUnsettled,
} from "../../platform/auth/WebAlphaAuthService"
import { usertagFor } from "../../platform/auth/WebPasskeyIdentityMap"
import { noteBackupSignIn } from "./backupSignIn"
import { bootstrapKeyProvider, enterTiers, requireResolved } from "./recoveryProbes"
import { generationAddresses } from "./generationAddresses"
import { generationFactories, loadOxideGenerations } from "./oxideGenerations"
import { resolveTagForCommit } from "../contacts/registryResolution"

import { nameGrantToken } from "./nameGrant"
import { attributeInboundInvite } from "../invite/inboundInvite"
export { nameGrantToken, stashInboundNameGrant } from "./nameGrant"

export type ClaimStatus = "reserved" | "claimed"

export type EnterResult =
  | {
      entered: true
      handle: string
      address: string
      account: ObsidionAccount
      /** Whether the session the account was saved under is still this page's: a sign-out or a
       *  newer commit since ends it, and nothing after installs the account. */
      held: () => boolean
    }
  /** The passkey's predicted account has no Registry record: a nameless account, or onboarding
   *  died before the claim. The caller decides — nameless re-entry needs the recovered account
   *  and the bootstrap key for the admission check. */
  | {
      entered: false
      reason: "unclaimed"
      account: ObsidionAccount
      held: () => boolean
      bootstrap: PrivateKeyAccount
      /** The wire domain a claimed tag hashes under, to name a reservation the caller finds. */
      ensDomain: string
      /** The tag this credential claimed on this browser; tried before `userHandle`. */
      usertag?: string
      /** The name the passkey carries, to name that reservation without asking. */
      userHandle?: string
    }
  /** Claim found; the plaintext tag is needed to name it (hash-only on-chain). */
  | {
      entered: false
      reason: "confirm"
      claim: EnteredClaim
      account: ObsidionAccount
      held: () => boolean
    }
  /** A `cacheOnly` entry that no ceremony-free source answered: nothing was asked or written. */
  | { entered: false; reason: "ceremony-required" }
  /** No anchor named either candidate key. Nothing was committed or written. Under a credential
   *  hint the result also says which credential answered and what each candidate derived, or that
   *  this browser's own record for the credential no longer reproduces from the passkey, so the
   *  caller can name the failure. */
  | {
      entered: false
      reason: "unknown"
      credentialId?: string
      /** The settled signing key, so a tag diagnosis can match this attempt against the account. */
      pubkey?: string
      addresses?: string[]
      /** Which device answered and its class, for the screen's diagnosis. */
      observed?: Observation
      storedAddressMismatch?: boolean
      /** Present only when a record was mismatched: a certain wrong key here, or the weaker miss. */
      verdict?: MismatchVerdict
      /** The retired-rollup list failed to load, so no account was ruled out. */
      catalogIncomplete?: boolean
    }

/** The recovered on-chain claim, pending a plaintext tag to name it. */
export interface EnteredClaim {
  nameHash: string
  address: string
  ensDomain: string
}

/**
 * Key material the L1 claim + FPC subscribe steps need, gathered after
 * `createAccount` (or a recovery flow here) has committed the MSK.
 */
export interface OnboardingKeys {
  account: ObsidionAccount
  secretKey: Fr
  authProvider: AlphaAuthProvider
  /** 0x-prefixed 64-byte (x‖y) passkey R1 pubkey. */
  pubkeyHex: string
}

function bigintTo32(value: bigint): Uint8Array {
  return toBytes(toHex(value, { size: 32 }))
}

function pubkeyHexFrom(x: Buffer, y: Buffer): string {
  return `0x${Buffer.concat([x, y]).toString("hex")}`
}

/** Persist the account so a reload's session can unlock it. */
async function persistAccount(account: ObsidionAccount, credentialId: string, pubkey: string) {
  await AccountStorage.get().addWebauthnAccount(
    "Account 1",
    account.getCompleteAddress().toString(),
    {
      credentialId,
      pubkey,
      authenticatorType: "platform",
    },
  )
}

/**
 * Adopt a resolved candidate: record the breadcrumb against `derived`, the address the anchors
 * named, commit the MSK, then build the account on this wallet and persist its record — the shared
 * tail of every recovery flow. Only called with a candidate an anchor named. The record precedes
 * the commit so a failure after it still leaves a record the next unlock verifies against; a stale
 * record (one the chain's list moved past) is the exception, rewritten only once the session has
 * switched, since the session it was opened over proves its cache against it until then.
 * `beforeCommit` runs once the record exists and before storage moves to the new account: the last
 * moment the previous account's records can be closed where they live. The account is built only
 * after the commit, because building it installs its signer on the wallet's account for that
 * address: two keys of one account derive one address, so a backup sign-in on a browser whose root
 * session is live would otherwise re-sign the live account before the switch and leave it so when
 * the attempt is cancelled or fails. A failure past the commit is reported as committed. The
 * attempt's cancel and the caller's `stillOwns` make one ownership predicate, asked before every
 * write up to the commit and by each store under its own lock: a cancel that landed on the way
 * ends in the cancel, and nothing is written after it. Past the commit the session names this
 * account, so its record and snapshot are finished whatever the attempt did; the commit's
 * generation is the ownership from then on, asked under the session lock — where a commit
 * publishes its tuple and moves the generation in one turn — as the record is rewritten, before
 * the account is built, and as its snapshot is saved: a newer commit or a sign-out since ends the
 * work as `SessionChangedError`, with nothing written into the session that replaced it, and a
 * commit cancelled as it saved is waited out, the session put back, the work going on.
 * The build itself is not fenced: an account a newer session outran may still be registered and
 * cached on the wallet; only what names the session is. The caller gets the account with `held`,
 * the ownership it was saved under, for whatever it hands on.
 */
async function adoptRecoveredAccount(
  wallet: ObsidionWallet,
  recovered: WebRecoverResult,
  msk: Fr,
  slot: PrfSlot,
  derived: string,
  attempt: AbortSignal,
  beforeCommit?: () => Promise<void>,
  stillOwns?: () => boolean,
): Promise<{ account: ObsidionAccount; held: () => boolean }> {
  const auth = getAuthService()
  const owns = () => !attempt.aborted && (stillOwns === undefined || stillOwns())
  const ended = () => !owns()
  if (ended()) throw new GateCancelledError()
  const writeRecord = (stillOwns?: () => boolean) =>
    auth.recordRecoveryMetadata(
      {
        credentialId: recovered.credentialId,
        l2Address: derived,
        pubkey: recovered.pubkey,
        prfSlot: slot,
        isMskRoot: recovered.backup === undefined,
        ...(recovered.backup ? { backup: recovered.backup } : {}),
        passkeySet: recovered.passkeys ?? [recovered.pubkey],
        authenticatorType: "platform",
        transports: recovered.transports,
      },
      stillOwns,
    )
  const staleRecord = recovered.staleSet !== undefined
  if (!staleRecord) {
    await writeRecord(owns)
    if (ended()) throw new GateCancelledError()
  }
  await beforeCommit?.()
  // The session switches here; a cancel that landed during the awaits above must not switch it.
  if (ended()) throw new GateCancelledError()
  // The address the page's stores were loaded for, read while that session is still the one.
  const before = await auth.sessionAddress()
  const input = { secretKey: msk, authProvider: recovered.authProvider }
  const generation = await auth.commitSecret(input, owns)
  if (generation === false) throw new GateCancelledError()
  if (recovered.backupFacts) noteBackupSignIn("succeeded", recovered.backupFacts)
  // The address moved under the same key: the page's stores still hold the old one. The session's
  // own address is the evidence; the incoming record's stands in only when there was no session.
  const from = before ?? recovered.expectedAddress
  if (from !== undefined && from.toLowerCase() !== derived.toLowerCase()) auth.markRecordsStale()
  const held = () => auth.sessionHeld(generation)
  try {
    // A commit saving over this session is waited out: one cancelled as it saved put the session
    // back, and the work goes on.
    await withSessionLock(async () => {
      if (!held()) throw new SessionChangedError()
      if (staleRecord) await writeRecord(held)
      if (!held()) throw new SessionChangedError()
    })
    const account = await wallet.createObsidionAccount(msk, recovered.authProvider)
    await withSessionLock(async () => {
      if (!held()) throw new SessionChangedError()
      await persistAccount(account, recovered.credentialId, recovered.pubkey)
      // A sign-out that landed during the save owns the session: the snapshot stays, the account
      // reaches no caller.
      if (!held()) throw new SessionChangedError()
    })
    return { account, held }
  } catch (err) {
    throw markCommitted(err)
  }
}

/**
 * The session had already switched when this error was thrown: a screen must not read it as an
 * arrival failure, and a switch to the same account moves no storage id that could tell it so.
 */
export const isCommittedFailure = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { committed?: boolean }).committed === true

const markCommitted = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? Object.assign(err, { committed: true }) : err

/** `derive` computed once per key, and every address it produced, in derivation order. */
function collectingDeriver(derive: (msk: Fr) => Promise<string>) {
  const derived = new Map<string, Promise<string>>()
  const addresses: string[] = []
  return {
    addresses,
    derive: (msk: Fr) => {
      const key = msk.toString()
      let pending = derived.get(key)
      if (!pending) {
        pending = derive(msk).then((address) => {
          addresses.push(address)
          return address
        })
        derived.set(key, pending)
      }
      return pending
    },
  }
}

/** `deriveAccountAddress` bound to the wallet and the account's key set, in the string form every anchor compares. */
const deriveAddressWith =
  (wallet: ObsidionWallet, passkeys: readonly string[]) => async (msk: Fr) =>
    (await wallet.deriveAccountAddress(msk, passkeys)).toString()

/** The key set a settled recovery derives with: the account's when it was read, else the signer alone. */
const keySetOf = (recovered: RecoverPasskeyResult): readonly string[] =>
  recovered.passkeys ?? [recovered.pubkey]

/**
 * Gather the key material the claim + FPC steps need. Call right after
 * `createAccount` — `getAuthService()` is the same singleton it drove,
 * so the MSK / auth provider are already committed. The pair is the session's, so the account
 * must be too: one built for a session since replaced is refused as `SessionChangedError`.
 */
export async function collectOnboardingKeys(account: ObsidionAccount): Promise<OnboardingKeys> {
  const keys = await getAuthService().sessionKeys()
  if (!keys) throw new Error("wallet is locked — cannot continue onboarding")
  if (account.getAuthProvider() !== keys.authProvider) throw new SessionChangedError()
  const { secretKey, authProvider } = keys
  const [x, y] = await authProvider.getPubkeys()
  return { account, secretKey, authProvider, pubkeyHex: pubkeyHexFrom(x, y) }
}

export async function getClaimStatus(handle: string): Promise<ClaimStatus> {
  const resolution = await resolveTagForCommit(handle)
  // Unclaimed names are reserved for whoever typed them; a claimed one (incl. a
  // stale-rollup record) routes to /enter, where the passkey proves ownership.
  return resolution.status === "notFound" ? "reserved" : "claimed"
}

/**
 * The tag cannot be claimed, and why. The reason decides where the user goes next, so it survives
 * as far as the copy rather than collapsing into one failure.
 */
export class NameTakenError extends Error {
  constructor(readonly reason: NameTakenReason, readonly handle: string) {
    super(`@${handle} is already taken`)
    this.name = "NameTakenError"
  }
}

/** The asserted passkey derives a different account than the one the claim was started with. */
export class PasskeyMismatchError extends PasskeyPolicyError {
  constructor() {
    super("that isn't the passkey this claim was started with")
    this.name = "PasskeyMismatchError"
  }
}

/**
 * The passkey's account holds more keys than the sign-in could read, so its address cannot be
 * derived; the tag-first sign-in reads the set in full.
 */
export class PasskeySetUnreadError extends Error {
  constructor() {
    super(
      "This passkey's account has more passkeys than this sign-in could read. Sign in with your @tag.",
    )
    this.name = "PasskeySetUnreadError"
  }
}

/**
 * Which existing passkey to enter with: the credential to assert with. `discover` leaves the
 * browser's list open instead of naming a credential; `chooser` bypasses the cache so the user
 * picking a different passkey is never answered by a saved key.
 */
export interface PasskeyHints {
  credentialId?: string
  discover?: boolean
  chooser?: boolean
}

/**
 * Which passkey a ceremony asks for: a tag's account and its keys, a known credential, or the open
 * chooser. `discover` runs a discoverable ceremony (no credential pinned); `chooser` bypasses the
 * cache so no saved key answers; `phone` steers a laptop's prompt to the phone and bypasses the
 * cache the same way. `chosen` marks `credentialId` as the key the user picked among the account's.
 */
export type CeremonyRequest = {
  account?: AccountPasskeys
  credentialId?: string
  chosen?: boolean
  discover?: boolean
  chooser?: boolean
  phone?: boolean
}

/**
 * Where the key comes from, decided without a ceremony: the key this session already holds, or a
 * ceremony described by `request`.
 */
export type KeySource =
  | { kind: "cache"; result: WebRecoverResult }
  | { kind: "ceremony-required"; request: CeremonyRequest }

/**
 * `restore: false` consults only a key already in memory: a call answering a tap must not start
 * the cache proof on the way to the prompt.
 */
export async function resolveKeySource(
  hints?: CeremonyRequest,
  options?: { restore?: boolean },
): Promise<KeySource> {
  const request: CeremonyRequest = { ...hints }
  // The chooser and the phone are the user asking for another passkey or device, and a tag names
  // an account the answering key must prove it opens: no cached source may answer for them.
  if (request.chooser || request.phone || request.account) {
    return { kind: "ceremony-required", request }
  }
  const service = getAuthService()
  const cached = await service.recoverFromCache(
    options?.restore === false ? { restore: false } : undefined,
  )
  if (cached && heldKeyAnswers(cached, request)) return { kind: "cache", result: cached }
  return { kind: "ceremony-required", request }
}

/** Whether the key this session holds is the credential `request` names, or any key when it names none. */
function heldKeyAnswers(cached: WebRecoverResult, request: CeremonyRequest): boolean {
  return !request.credentialId || cached.credentialId === request.credentialId
}

/**
 * The recovery `request` describes; unsettled when this browser holds no record for the passkey.
 * `signal`, when the gate handed one out, ends the prompt on the attempt's cancel.
 */
async function ceremonyFor(
  request: CeremonyRequest,
  signal: AbortSignal | undefined,
  own?: PasskeyRequestScope,
): Promise<BeginRecoveryResult> {
  const cancel = {
    ...(signal ? { signal } : {}),
    ...(own ? { own } : {}),
    ...(request.phone ? { phone: true } : {}),
  }
  if (request.discover) return getAuthService().beginRecovery({ discover: true, ...cancel })
  return request.account
    ? await getAuthService().adoptAccountPasskey({ ...request.account, ...cancel })
    : await getAuthService().beginRecovery({
        credentialId: request.credentialId,
        ...(request.chosen ? { chosen: true } : {}),
        ...cancel,
      })
}

/** A gate that hands out no attempt signal (the tests' stand-ins) gets one that never cancels. */
const attemptFrom = (signal: AbortSignal | undefined): AbortSignal =>
  signal ?? new AbortController().signal

/**
 * The ceremony `request` describes, after the screen's gate, with the attempt the gate started.
 * `cancel` is the caller's: checked before the gate opens an attempt and again before the prompt,
 * so a cancel during the reads that precede it starts nothing. A cancel past that point is the
 * screen's to hand to the gate, whose attempt the ceremony runs under; every write behind the
 * prompt asks the caller's cancel as well, through the ownership predicate each flow builds.
 */
async function ceremonyPath(
  request: CeremonyRequest,
  gate: CeremonyGate,
  cancel?: AbortSignal,
  own?: PasskeyRequestScope,
) {
  if (cancel?.aborted) throw new GateCancelledError()
  const { signal } = await gate()
  if (cancel?.aborted) throw new GateCancelledError()
  const attempt = attemptFrom(signal)
  try {
    return { recovered: await ceremonyFor(request, signal, own), attempt }
  } catch (err) {
    // A cancel mid-prompt comes back as the browser's abort; it is reported as the cancel.
    throwIfCancelled(attempt)
    throw err
  }
}

/**
 * Key material for `hints`: a ceremony-free source when one answers, else the gate and a ceremony. A
 * ceremony-free source runs under the caller's `cancel` as its attempt, so closing the screen ends
 * its adoption the way it ends a prompt's.
 */
async function keyMaterial(
  hints: CeremonyRequest | undefined,
  gate: CeremonyGate,
  cancel?: AbortSignal,
  own?: PasskeyRequestScope,
): Promise<{ recovered: BeginRecoveryResult; attempt?: AbortSignal }> {
  const source = await resolveKeySource(hints)
  if (source.kind !== "ceremony-required") return { recovered: source.result, attempt: cancel }
  return ceremonyPath(source.request, gate, cancel, own)
}

const throwIfCancelled = (attempt: AbortSignal) => {
  if (attempt.aborted) throw new GateCancelledError()
}

/** How long a sign-in waits for the L1 accounts to name the passkey's key before asking the passkey again. */
const INSTALLED_KEY_BUDGET_MS = 5_000

type BudgetOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "read-failed"; error: unknown }
  | { kind: "cancelled" }

/**
 * `read` bounded by `ms` and by every signal in `cancels`. Whatever ends the wait also aborts the
 * signal `read` was given, so it starts no further step, and releases the timer and listeners.
 */
async function withinBudget<T>(
  read: (stop: AbortSignal) => Promise<T>,
  ms: number,
  cancels: readonly AbortSignal[],
): Promise<BudgetOutcome<T>> {
  if (cancels.some((signal) => signal.aborted)) return { kind: "cancelled" }
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => stop.abort()
  try {
    const ended = new Promise<BudgetOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), ms)
      stop.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true })
      for (const signal of cancels) signal.addEventListener("abort", onAbort, { once: true })
    })
    const answered = read(stop.signal).then(
      (value): BudgetOutcome<T> => ({ kind: "value", value }),
      (error): BudgetOutcome<T> => ({ kind: "read-failed", error }),
    )
    return await Promise.race([answered, ended])
  } finally {
    clearTimeout(timer)
    for (const signal of cancels) signal.removeEventListener("abort", onAbort)
    stop.abort()
  }
}

/** A signing key the L1 read settled, with every key of the account that installed it. */
interface InstalledKey {
  pubkeyHex: string
  passkeys: readonly string[]
}

/**
 * The key the L1 accounts of `recovered`'s master keys installed, when they name exactly one of its
 * two possible keys within the budget, with that account's whole key set; `undefined` when none
 * does, or the read times out or fails, and the passkey is asked again. Several holding accounts
 * end the attempt as ambiguous, and a holding account whose set could not be read in full ends it
 * as unread, both before any second prompt. A cancel is reported by the caller's own check.
 */
async function installedKeyFor(
  recovered: UnsettledRecovery,
  l1: OxideL1Reader,
  registry: Hex,
  accountFactories: readonly Hex[],
  cancels: readonly AbortSignal[],
): Promise<InstalledKey | undefined> {
  const masterKeys = [recovered.candidates.first, recovered.candidates.second].filter(
    (msk): msk is Fr => msk !== undefined,
  )
  const outcome = await withinBudget(
    (stop) =>
      readInstalledPasskeyKey(masterKeys, recovered.pubkeyCandidates, {
        reader: l1,
        registry,
        accountFactories,
        stop,
      }),
    INSTALLED_KEY_BUDGET_MS,
    cancels,
  )
  if (outcome.kind === "value") {
    const read = outcome.value
    if (read.kind === "found") return { pubkeyHex: read.pubkeyHex, passkeys: read.passkeys }
    if (read.kind === "ambiguous") throw new AmbiguousPasskeyError()
    if (read.kind === "incomplete") throw new PasskeySetUnreadError()
    return undefined
  }
  // The error's text can carry the RPC URL, so only its class is logged.
  if (outcome.kind === "timeout") {
    console.warn("[oxideOnboarding] installed passkey key: timeout; asking the passkey again")
  } else if (outcome.kind === "read-failed") {
    const name = outcome.error instanceof Error ? outcome.error.name : "unknown"
    console.warn(
      `[oxideOnboarding] installed passkey key: read-failed (${name}); asking the passkey again`,
    )
  }
  return undefined
}

/**
 * Settle a recovery's public key before the master key is resolved: the address depends on both,
 * so the key comes first. `installed`, the key the sign-in's L1 accounts installed at registration
 * with that account's key set, settles without a prompt; otherwise the passkey is asked a second
 * time, behind the gate so the user taps before a prompt that would otherwise open seconds after
 * the last one. The attempt's cancel is checked before every step this adds; nothing here writes.
 */
async function settleRecovery(
  recovered: BeginRecoveryResult,
  gate: CeremonyGate,
  attempt: AbortSignal = attemptFrom(undefined),
  installed?: InstalledKey,
): Promise<WebRecoverResult> {
  if (!isUnsettled(recovered)) return recovered
  throwIfCancelled(attempt)
  if (installed) return recovered.settle(installed.pubkeyHex, undefined, installed.passkeys)
  await gate({ again: attempt })
  throwIfCancelled(attempt)
  let settled: WebRecoverResult
  try {
    settled = await recovered.settle(undefined, attempt)
  } catch (err) {
    // A cancel mid-prompt comes back as the browser's abort; it is reported as the cancel.
    throwIfCancelled(attempt)
    throw err
  }
  throwIfCancelled(attempt)
  return settled
}

async function keysFor(
  account: ObsidionAccount,
  recovered: RecoverPasskeyResult,
  secretKey: Fr,
  active?: () => boolean,
): Promise<OnboardingKeys> {
  // The commit has landed and the session has switched, but the keys are only now handed to the
  // caller. A scope cancelled, or a session replaced, in that window (a modal closed, the gate
  // cancelled, a newer commit), before or during the key read, stops here, so no sweep or pending
  // step runs against a session the user walked away from.
  if (active && !active()) throw new GateCancelledError()
  const [x, y] = await recovered.authProvider.getPubkeys()
  if (active && !active()) throw new GateCancelledError()
  return {
    account,
    secretKey,
    authProvider: recovered.authProvider,
    pubkeyHex: pubkeyHexFrom(x, y),
  }
}

/**
 * What a sign-in is pinned to: a tag's account and its keys, or a credential this browser remembers.
 * `chosen`: the user picked this credential among its account's keys.
 */
export type SignInHints = AccountPasskeys | { credentialId: string; chosen?: boolean }

const isAccountHints = (hints: SignInHints): hints is AccountPasskeys => "keys" in hints

/**
 * The request a sign-in makes: pinned to the hinted account or credential on any posture, else
 * discoverable on a laptop (its own account chooser lists whatever holds the passkey — this
 * computer, a phone, a key) or for the chooser, else the phone's own pin straight to the biometric.
 */
function signInRequest(options: {
  chooser?: boolean
  hints?: SignInHints
  phone?: boolean
}): CeremonyRequest | undefined {
  const phone = options.phone ? { phone: true } : {}
  if (options.hints) {
    if (isAccountHints(options.hints)) return { account: options.hints, ...phone }
    const { credentialId, chosen } = options.hints
    return { credentialId, ...(chosen ? { chosen } : {}), ...phone }
  }
  if (options.chooser || currentDevicePosture() === "laptop") {
    return { discover: true, ...(options.chooser ? { chooser: true } : {}), ...phone }
  }
  return undefined
}

/**
 * A sign-in's key material, or undefined for a `cacheOnly` call that no ceremony-free source
 * answered. The key source is resolved once, and `cacheOnly` is judged on that one resolution,
 * where a ceremony would otherwise start — so a source that changes under the call can never reach
 * the gate. A hinted key the signature does not carry is the mismatch refusal; every other failure
 * keeps its class.
 */
async function enterKeyMaterial(options: {
  gate: CeremonyGate
  chooser?: boolean
  phone?: boolean
  hints?: SignInHints
  signal?: AbortSignal
  cacheOnly?: boolean
  restoreCache?: boolean
  own?: PasskeyRequestScope
}): Promise<{ recovered: BeginRecoveryResult; attempt?: AbortSignal } | undefined> {
  const request = signInRequest(options)
  try {
    const source = await resolveKeySource(request, { restore: options.restoreCache })
    if (source.kind !== "ceremony-required") {
      return { recovered: source.result, attempt: options.signal }
    }
    if (options.cacheOnly) return undefined
    return await ceremonyPath(source.request, options.gate, options.signal, options.own)
  } catch (err) {
    if (err instanceof HintedKeyMismatchError) throw new PasskeyMismatchError()
    throw err
  }
}

/** The candidate that derives `address`, if either does. A failed derivation propagates. */
async function candidateDeriving(
  recovered: RecoveredCandidates,
  address: string,
  deriveAddress: (msk: Fr) => Promise<string>,
): Promise<{ msk: Fr; slot: PrfSlot } | undefined> {
  const wanted = address.toLowerCase()
  for (const slot of ["first", "second"] as const) {
    const msk = recovered.candidates[slot]
    if (msk && (await deriveAddress(msk)).toLowerCase() === wanted) return { msk, slot }
  }
  return undefined
}

/**
 * Reuse an EXISTING passkey for an account this browser already knows the address of (a pending
 * registration's `l2Address`, or a nameless identity's) instead of minting a fresh credential.
 * Both candidate keys are derived and the one that reproduces `expectedL2Address` is adopted; when
 * neither does, `PasskeyMismatchError` is thrown having mutated nothing. `signal` is the caller's
 * cancel — a closed sheet — and ends the adoption anywhere before the commit, prompt or no prompt;
 * past the commit the account is still built and saved, and the keys reach only a scope still open
 * over the session that saved them.
 */
export async function reusePasskeyAccount(
  wallet: ObsidionWallet,
  expectedL2Address: string,
  hints: PasskeyHints | undefined,
  gate: CeremonyGate,
  signal?: AbortSignal,
  own?: PasskeyRequestScope,
): Promise<OnboardingKeys> {
  const { recovered, attempt } = await keyMaterial(hints, gate, signal, own)
  // The attempt owns the prompt; the caller's cancel owns everything after it.
  const owns = () => !attempt?.aborted && !signal?.aborted
  const settled = await settleRecovery(recovered, gate, attempt)
  if (!owns()) throw new GateCancelledError()
  const deriver = collectingDeriver(deriveAddressWith(wallet, keySetOf(settled)))
  const picked = await candidateDeriving(settled, expectedL2Address, deriver.derive)
  if (!picked) throw new PasskeyMismatchError()
  const { account, held } = await adoptRecoveredAccount(
    wallet,
    settled,
    picked.msk,
    picked.slot,
    await deriver.derive(picked.msk),
    attemptFrom(attempt),
    undefined,
    owns,
  )
  return keysFor(account, settled, picked.msk, () => owns() && held())
}

/**
 * `custody` means onboarding may complete: the registration is confirmed on-chain. The deferred
 * setup recovers the claim witness from the Registry's `NameClaimed` log, never from this session.
 * `pending` is resumable, never a failure — the durable record carries the state, and the UI shows
 * in-progress copy.
 */
export type ClaimTagOutcome =
  | { kind: "custody"; confirmed: true; oxideAccount: string }
  /** `claim` is the fresh NameClaim (+ optional fee waiver) the deposit screen renders — in memory
   *  only, same as the session result it comes from; a resumed record has no claim to show. */
  | {
      kind: "pending"
      oxideAccount: string
      claim: NameClaimResponse
      /** The network paused paylink tickets before this signup's was redeemed; `claim.terms` say
       *  whether one redeemed earlier still priced it. */
      ticketUnavailable?: true
      /** The stashed link funds the signed deposit: its claim on Home pays the registration. */
      depositLink?: LinkDeposit
    }

/**
 * The bootstrap-key request-auth provider for `/domain/sign` (front-core `BootstrapKeyProvider`,
 * PR #1174): the wallet's own bootstrap key signs the request's `clientDataHash` directly.
 */
function bootstrapProviderFor(masterSecret: OnboardingKeys["secretKey"]): BootstrapKeyProvider {
  return bootstrapKeyProvider(deriveBootstrapKey(masterSecret))
}

export function accountServiceFor(
  config: WebWalletConfig,
  keys: Pick<OnboardingKeys, "secretKey">,
  handle?: string,
): AccountServiceClient {
  // The bootstrap key names the subject in test mode too, so the sandbox binds claims (and earned
  // entitlements) to the same subject production does.
  return new AccountServiceClient(config.accountServiceUrl, {
    testMode: config.accountServiceTestMode,
    // Sandbox testMode skips the HTTP gate; the bootstrap subject still names the ticket owner
    // and the NameClaim's keyId, so the ticket's entitlement prices the claim.
    bootstrapProvider: bootstrapProviderFor(keys.secretKey),
    grantToken: handle ? nameGrantToken(handle) : undefined,
  })
}

/** The current account's passkey credential id, or a loud failure — registration installs the r1 key
 *  through the sweep and cannot without it. */
async function requireCredentialId(): Promise<string> {
  const credentialId = await resolveStoredCredentialId()
  if (!credentialId) {
    throw new Error(
      "no passkey credential id for the current account — cannot install the r1 key on registration",
    )
  }
  return credentialId
}

/** What deriving this wallet's registration address needs; the session and recovery share it. */
export async function registrationAddressDeps(
  handle: string,
  secretKey: Fr,
  l2Address: Hex,
  config: WebWalletConfig,
  networkId: string,
  l1Client?: PublicClient,
) {
  const { tuple, env, publicClient: envClient } = await oxideEnvFor(config)
  const publicClient = l1Client ?? envClient
  return {
    tag: handle,
    env,
    masterSecret: secretKey,
    l2Address,
    accountService: accountServiceFor(config, { secretKey }, handle),
    beneficiary: await resolveBeneficiary(config, Number(SANDBOX_REGISTRATION_BENEFICIARY_ID)),
    // Read live at derivation: the committed fee must be exactly what the controller checks at
    // sweep, and signed terms (when the claim carries them) take precedence over this schedule.
    scheduleFee: () => readRegistrationSchedule(config).then((schedule) => schedule.fee),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
    }),
    seedSipaDeposit: makeRegistrationDepositSeeder({
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
      networkId,
    }),
  }
}

/** Assemble the deposit-driven registration session deps (shared by claimTag + the retry sign deps). */
async function registrationSessionDeps(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  networkId: string,
  onStage?: (stage: OxideRegistrationStage) => void,
): Promise<OxideRegistrationSessionDeps> {
  const l2Address = keys.account.getAddress().toString() as Hex
  return {
    ...(await registrationAddressDeps(handle, keys.secretKey, l2Address, config, networkId)),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(),
    pendingStore: getPendingStore(),
    onStage,
  }
}

/**
 * The link's note covers the ticket burn on the advertised ticket schedule and the executor's fee, with no prover tip:
 * registration does not need one, so gas never fails a link here. An unadvertised schedule prices
 * nothing, and nothing is spent on a guess.
 */
export function linkCoversTicketBurn(
  amount: bigint,
  advertised: RegistrationSchedule | undefined,
  withdrawalFee: bigint,
): boolean {
  if (!advertised) return false
  return goldenTicketCoverage(amount, advertised, 0n, withdrawalFee).covers
}

/** How a ticket-funded signup's redemption went before its claim was signed. */
export type TicketRedemption = "none" | "redeemed" | "unavailable"

/** The registration session's stages, plus a ticket signup's proof and the NameClaim after it. */
export type SignupStage = OxideRegistrationStage | "ticket_prove" | "reserve"

export const isRegistrationStage = (stage: SignupStage): stage is OxideRegistrationStage =>
  stage === "derive" || stage === "claim" || stage === "broadcast"

/**
 * A ticket-funded signup (the visitor chose to receive the link into a new account on a network
 * that issues tickets) redeems its golden ticket first, so the claim below quotes the ticket
 * schedule. Every refusal fails closed before the ticket is spent: a missing PXE, a note below the
 * threshold or one that cannot cover the registration burn all surface here, never as a paid quote
 * the link was meant to cover. A network that paused tickets is reported instead: the claim is
 * signed anyway, and the wizard keeps the ticket path only if a ticket redeemed earlier still
 * priced it. The ticket is the one the hosting wizard hands in: a marker another page left in the
 * tab never reaches this signup.
 */
export async function redeemLinkedGoldenTicket(
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet: ObsidionWallet | undefined,
  ticket: TicketSignupStash | null,
  onProving?: () => void,
): Promise<TicketRedemption> {
  if (!ticket) return "none"
  if (!wallet) throw new Error("wallet is still starting, try again in a moment")
  const outcome = await redeemGoldenTicketForLink({
    wallet,
    accountService: accountServiceFor(config, keys),
    secretKey: keys.secretKey,
    fragment: ticket.fragment,
    covers: async (amount, advertised) =>
      linkCoversTicketBurn(amount, advertised, await activeWithdrawalFee()),
    onProving,
  })
  if (outcome.amount !== undefined) updateTicketSignup({ amount: outcome.amount.toString() })
  switch (outcome.status) {
    case "unavailable":
      return "unavailable"
    case "below_threshold":
      throw new Error("this payment is below the amount that waives the tag price")
    case "cannot_cover":
      throw new Error("this payment cannot cover the account deposit")
  }
  return "redeemed"
}

/**
 * What a registration checkpoint makes durable beside its record: the quote, and the link whose
 * ticket the quote honours. A reopen finds the registration this link funds by that identity, and
 * never proves or claims again for it.
 */
export function checkpointRegistrationTerms(
  account: string,
  tag: string,
  claim: NameClaimResponse,
  opts: {
    earnedExpected: boolean
    ticket: TicketSignupStash | null
    /** The link, when its note covers these terms' deposit (`linkCoversDeposit`). */
    depositLink?: LinkDeposit
  },
): RegistrationTerms {
  const ticket = opts.ticket && wireTermsFundTicket(claim.terms) ? opts.ticket : null
  return {
    account,
    tag,
    ...claimTerms(claim),
    ...(opts.earnedExpected ? { earnedExpected: true } : {}),
    ...(ticket
      ? {
          paylinkFunded: true,
          paylinkId: linkIdentity(ticket.fragment),
          ...(ticket.amount !== undefined ? { paylinkAmount: ticket.amount } : {}),
          ...(ticket.senderTag ? { paylinkSender: ticket.senderTag } : {}),
          ...(ticket.proverTip !== undefined ? { proverTip: ticket.proverTip } : {}),
          ...(ticket.speed !== undefined ? { speed: ticket.speed } : {}),
        }
      : opts.depositLink
      ? {
          paylinkFunded: true,
          paylinkId: linkIdentity(opts.depositLink.fragment),
          paylinkDeposit: true,
          paylinkAmount: opts.depositLink.amount.toString(),
          ...(opts.depositLink.senderTag ? { paylinkSender: opts.depositLink.senderTag } : {}),
          proverTip: opts.depositLink.proverTip.toString(),
          ...(opts.depositLink.speed ? { speed: opts.depositLink.speed } : {}),
        }
      : {}),
  }
}

/** A link with no ticket for this signup, which pays the name's own deposit when it covers it. */
export interface LinkDeposit {
  fragment: string
  /** The note, base units. */
  amount: bigint
  /** The prover tip the split committed, base units, and the speed with it. */
  proverTip: bigint
  speed?: "standard" | "faster"
  /** The link creator's verified tag. */
  senderTag?: string
}

/**
 * The note covers the signed deposit, the executor's fee and the committed prover tip with something
 * left: the rule a ticket's burn is held to. Unpriced terms or an unread fee cover nothing.
 */
export async function linkCoversDeposit(
  link: LinkDeposit,
  terms: NameClaimResponse["terms"],
): Promise<boolean> {
  if (!terms || !wireTermsFundLink(terms)) return false
  const withdrawalFee = await activeWithdrawalFee().catch(() => undefined)
  if (withdrawalFee === undefined) return false
  const schedule = { fee: BigInt(terms.fee), min: BigInt(terms.minDeposit) }
  return goldenTicketCoverage(link.amount, schedule, link.proverTip, withdrawalFee).covers
}

export async function claimTag(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  wallet: ObsidionWallet,
  onStage?: (stage: SignupStage) => void,
  requireEarnedQuote = false,
  refundedRecord?: PendingRegistrationRecord,
  replacedRecord?: PendingRegistrationRecord,
  ticket: TicketSignupStash | null = null,
  linkDeposit?: LinkDeposit,
): Promise<ClaimTagOutcome> {
  let ticketUnavailable = false
  let entry: PendingRegistrationRecord["refundedEntry"]
  if (refundedRecord) {
    if (
      handle !== refundedRecord.tag ||
      keys.account.getAddress().toString() !== refundedRecord.l2Address
    ) {
      throw new Error("Use the original wallet to restart this registration.")
    }
    const refund = await assertRegistrationRefunded(refundedRecord, config)
    entry = refundedEntry(refundedRecord, refund)
  }
  // Settled before anything registers: account-service refuses an invitee who already is.
  await attributeInboundInvite(accountServiceFor(config, keys))
  const deps = await registrationSessionDeps(handle, keys, config, wallet.networkId, onStage)
  // Entry rides on the replacement record from its checkpoint: the receipt a sign-out clears cannot
  // be rebuilt from an address that holds nothing, and a session that dies after the checkpoint
  // must not lose it.
  if (entry) deps.refundedEntry = entry
  const prior = refundedRecord ?? replacedRecord
  if (prior) {
    // The checkpoint overwrites the old record; a deposit reaching its address later is recovered
    // off this copy, kept even when the name is refused before anything derives. The old address
    // spent the account's one-shot broadcast only if it recorded one, or inherited that: a refund
    // moves L1 funds and says nothing about it.
    await archiveReplacedRegistration(prior)
    deps.replaced = {
      sipaAddress: prior.sipaAddress,
      refunded: refundedRecord !== undefined,
      broadcastSpent: prior.broadcast || prior.replaced?.broadcastSpent === true,
    }
  }
  // The address commits the fee, so a quote that only lowered the minimum re-derives the old
  // address: the session re-enters that record under the corrected quote instead of replacing it.
  const sameAddress = (sipaAddress: string) =>
    prior !== undefined && sipaAddress.toLowerCase() === prior.sipaAddress.toLowerCase()
  if (refundedRecord) {
    const derive = deps.deriveRegistrationSipa
    deps.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      await assertRegistrationRefunded(refundedRecord, config)
      const reentry = sameAddress(result.sipaAddress)
      if (
        args.owner.toLowerCase() !== refundedRecord.account.toLowerCase() ||
        (reentry && (refundedRecord.fee === undefined || args.fee !== BigInt(refundedRecord.fee)))
      ) {
        throw new Error("The earned quote did not produce a new address for this wallet.")
      }
      if (reentry) {
        // The refund emptied the address the deposit receipt vouches for; entry stays on the record.
        if (entry && !refundedRecord.refundedEntry) {
          await getPendingStore().upsert(refundedRecord.account, { refundedEntry: entry })
        }
        forgetDepositAdmission(refundedRecord)
        forgetReplacedRegistration(refundedRecord.sipaAddress)
        await reopenRefundedDeposit(refundedRecord)
      }
      return result
    }
  }
  if (replacedRecord && !refundedRecord) {
    const derive = deps.deriveRegistrationSipa
    deps.deriveRegistrationSipa = async (args) => {
      const result = await derive(args)
      // A deposit landing at the old address during the quote fetch would be stranded once the
      // checkpoint overwrites its record. Re-check emptiness here, right before that write: a
      // funded old address aborts the replace and keeps its recoverable record instead.
      await assertRegistrationUnfunded(replacedRecord, config)
      if (sameAddress(result.sipaAddress)) forgetReplacedRegistration(replacedRecord.sipaAddress)
      return result
    }
  }
  let quoted: NameClaimResponse | undefined
  let depositLink: LinkDeposit | undefined
  const accountService = deps.accountService
  deps.accountService = {
    signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
      // The session checks the name and account on L1 before requesting terms. Redeeming here
      // avoids spending a ticket on an account that already owns a name or on a taken name.
      ticketUnavailable =
        (await redeemLinkedGoldenTicket(keys, config, wallet, ticket, () =>
          onStage?.("ticket_prove"),
        )) === "unavailable"
      if (ticket) onStage?.("reserve")
      const claim = await accountService.signDomain(...args)
      if (requireEarnedQuote || refundedRecord) assertEarnedQuote(claim.terms)
      if (linkDeposit && (await linkCoversDeposit(linkDeposit, claim.terms)))
        depositLink = linkDeposit
      quoted = claim
      return claim
    },
  }
  // The quote goes durable with the record: a session that dies past its checkpoint leaves a
  // record whose stored terms would otherwise still price the address it replaced.
  deps.onCheckpoint = async (record) => {
    if (!quoted) return
    await saveRegistrationTerms(
      checkpointRegistrationTerms(record.account, handle, quoted, {
        earnedExpected: requireEarnedQuote,
        ticket,
        depositLink,
      }),
    )
  }
  const result = await startOxideRegistrationSession(deps)
  switch (result.status) {
    case "taken":
      throw new NameTakenError(result.reason, handle)
    case "already_registered":
      throw new Error(
        result.name
          ? `this passkey already claimed ${result.name} — use Enter instead`
          : "this passkey already claimed another tag — use Enter to recover it",
      )
    case "registered":
      return { kind: "custody", confirmed: true, oxideAccount: result.oxideAccount }
    // awaiting_deposit: the deposit address is derived + the claim is in hand; the sender must fund
    // it before the name registers. Presented as pending — the onboarding screen's deposit panel
    // shows the address + claim, and the detection loop confirms once the relayer sweeps.
    case "awaiting_deposit": {
      // A manual sweep needs the claim cached, and this session's own broadcast may never cache it.
      if (prior) {
        await NameClaimStore.get().put({
          address: prior.l2Address,
          handle,
          nameHash: prior.nameHash,
          signature: result.claim.signature,
          nonce: result.claim.nonce,
          deadline: result.claim.deadline,
          terms: result.claim.terms,
        })
      }
      // The sheet that shows the address owes its broadcast; the first attempt reuses this payload.
      if (result.broadcastOwed) rememberRegistrationPayload(result.sipaAddress, result.payload)
      return {
        kind: "pending",
        oxideAccount: result.oxideAccount,
        claim: result.claim,
        ...(ticketUnavailable ? { ticketUnavailable: true as const } : {}),
        ...(depositLink ? { depositLink } : {}),
      }
    }
  }
}

/**
 * What rebuilding a registration's broadcast needs: re-derive the SIPA, re-request the claim,
 * re-sign the consent. The bootstrap key gates `/domain/sign` directly, so this arms on any
 * deployment with an unlocked wallet.
 */
export async function buildRetrySignDeps(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  networkId: string,
): Promise<OxideSignDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return {
    masterSecret: keys.secretKey,
    accountService: accountServiceFor(config, keys, handle),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
    }),
    seedSipaDeposit: makeRegistrationDepositSeeder({
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
      networkId,
    }),
    seededSipaSalt: seededRegistrationSalt,
  }
}

/**
 * What both ClaimFPC gates rest on: the name the L1 side commits to, the bootstrap key that
 * CREATE2-derives the OxideAccount holding it, and that key's signature over this L2 address. The
 * signature never leaves the device, and every part re-derives from the master secret.
 */
export async function buildOxideAccountBinding(
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  nameHash: Hex,
): Promise<OxideAccountBinding> {
  return metadataMigrationBinding(
    keys.secretKey,
    keys.account.getAddress().toString() as Hex,
    nameHash,
  )
}

/**
 * The NameClaim gate's eligibility witness: the binding above plus the REAL NameClaim the domain
 * owner signed.
 *
 * `nameHash` is what the signature actually covers, so a recovered claim passes the value from the
 * Registry's `NameClaimed` log rather than recomposing it — recovery then needs no plaintext tag,
 * and a stale `handle` can't silently produce a node the signature doesn't match.
 */
export async function buildClaimSubscribeWitness(
  handle: string,
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  claim: Pick<NameClaimResponse, "signature" | "nonce" | "deadline">,
  config: WebWalletConfig,
  nameHash?: Hex,
): Promise<NameClaimWitness> {
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  const node = nameHash ?? composeWireNameHash(handle, ensDomain)
  return {
    ...(await buildOxideAccountBinding(keys, node)),
    nonce: bigintTo32(BigInt(claim.nonce)),
    deadline: bigintTo32(BigInt(claim.deadline)),
    claimSig: toBytes(claim.signature).slice(0, 64),
  }
}

/**
 * Returning user, passkey-first: assert the passkey, settle its signing key (the key the L1 account
 * installed at registration, when it names one; otherwise a second assertion), derive both
 * candidate master keys, and let the anchors say which one is the account — this browser's record
 * if it has one, else the outside records in `enterTiers`. A resolved claim
 * re-registers the account and rebuilds the local records a browser-data wipe destroyed. Only the
 * tag's HASH lives on-chain, so the plaintext still needs a source: a `handle` from the claim
 * link enters directly when its hash matches; otherwise the caller confirms. No anchor →
 * `unknown`, with nothing committed or written.
 *
 * `hints` names either a remembered credential, which pins the ceremony to it on any posture, or
 * the tag's L1 account with its keys: the sheet is then held to the credential ids the keys name
 * (a root's raw id, a backup's id behind its envelope). Either way the answering key is checked
 * against the signature, never trusted, and the anchors decide as always. `strictTag` (implied by
 * `hints`) lets only `handle` name the claim.
 * `cacheOnly` enters from a ceremony-free source or reports `ceremony-required` before any gate or
 * prompt; `restoreCache: false` keeps a tap-driven entry from starting the cache proof on its way to
 * the prompt. `signal` is the caller's cancel: with the gate's attempt it is checked before the
 * prompt, after the anchors, after the name read, and before every write, so nothing is committed
 * after a cancel.
 */
export async function enterWithPasskey(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  handle: string | undefined,
  options: {
    contractService: ContractService
    tiers?: AnchorTier[]
    grantToken?: string
    gate: CeremonyGate
    chooser?: boolean
    /** Steer a laptop's prompt to the phone, the wrong-key card's way on. */
    phone?: boolean
    hints?: SignInHints
    strictTag?: boolean
    signal?: AbortSignal
    cacheOnly?: boolean
    restoreCache?: boolean
    /** The attempt this sign-in runs as, so its requests are reported as that attempt's. */
    own?: PasskeyRequestScope
  },
): Promise<EnterResult> {
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  const l1 = createOxideL1Reader(l1PublicClient(config))
  const strict = options.strictTag || options.hints !== undefined
  // Started before the prompt, so the assertion still opens inside the click's activation window,
  // and awaited before the first account prediction.
  const generationsRead = loadOxideGenerations(wallet, options.contractService, config)
  void generationsRead.catch(() => undefined)

  const material = await enterKeyMaterial(options)
  if (!material) return { entered: false, reason: "ceremony-required" }
  const { recovered: begun, attempt } = material
  const active = () => !options.signal?.aborted && !attempt?.aborted
  const throwIfEnded = () => {
    if (!active()) throw new GateCancelledError()
  }

  // A hinted sign-in arrives with its key settled; otherwise the key is settled before any
  // candidate is derived, because the address depends on it.
  const generations = await generationsRead
  let installedKey: InstalledKey | undefined
  if (isUnsettled(begun)) {
    throwIfEnded()
    const cancels = [options.signal, attempt].filter((s): s is AbortSignal => s !== undefined)
    installedKey = await installedKeyFor(
      begun,
      l1,
      generations.registry,
      generationFactories(generations),
      cancels,
    )
    throwIfEnded()
  }
  const recovered = await settleRecovery(begun, options.gate, attemptFrom(attempt), installedKey)
  throwIfEnded()
  const deriver = collectingDeriver(deriveAddressWith(wallet, keySetOf(recovered)))
  const addressesFor = generationAddresses(config, recovered.pubkey)
  // A record the chain's list has moved past still picks the key, by the set it was written with;
  // the entry then derives under the chain's set and rewrites the record to it.
  const anchorDerive = recovered.staleSet
    ? deriveAddressWith(wallet, recovered.staleSet)
    : deriver.derive
  const { observed } = recovered
  const auth = getAuthService()
  let resolved: ResolvedMsk
  let storedAddressMismatch = false
  let verdict: MismatchVerdict | undefined
  try {
    const grantToken = handle ? options.grantToken : undefined
    const grant =
      grantToken && handle
        ? { nameHash: composeWireNameHash(handle, ensDomain), token: grantToken }
        : undefined
    resolved = await resolveRecoveredMsk(
      recovered,
      anchorDerive,
      options.tiers ?? enterTiers(config, generations, grant, addressesFor),
    )
  } catch (err) {
    // This browser's own record for the credential no longer reproduces from the passkey.
    if (!(err instanceof StoredAddressMismatchError)) throw err
    verdict = auth.mismatchVerdict(recovered)
    // The plain path shows the card from the thrown error; the hinted path from the result.
    if (!options.hints) throw Object.assign(err, { verdict, observed })
    resolved = { kind: "unknown" }
    storedAddressMismatch = true
  }
  throwIfEnded()
  const evidence = () => ({
    credentialId: recovered.credentialId,
    pubkey: recovered.pubkey,
    addresses: deriver.addresses,
    observed,
    ...(generations.catalogIncomplete ? { catalogIncomplete: true } : {}),
  })
  if (resolved.kind === "unknown") {
    if (!options.hints) return { entered: false, reason: "unknown", ...evidence() }
    return { entered: false, reason: "unknown", ...evidence(), storedAddressMismatch, verdict }
  }
  const { msk, slot } = requireResolved(resolved)
  const cancel = attemptFrom(attempt)
  // Read before `adoptRecoveredAccount` rewrites the credential's breadcrumb.
  const remembered = strict
    ? undefined
    : usertagFor(config.rpId, recovered.credentialId) ?? recovered.usertag

  const derived = await deriver.derive(msk)
  let identity: ReturnType<typeof requireVerifiedIdentity>
  try {
    identity = requireVerifiedIdentity(
      await resolveOxideIdentity(
        generations,
        deriveBootstrapKey(msk).address,
        derived,
        addressesFor(msk, derived),
      ),
    )
  } catch (err) {
    // The key was settled by the passkey, not by the account's key set: an account with more keys
    // derives an address the key alone cannot, so the tag-first sign-in is the way in.
    const setUnread = isUnsettled(begun) && installedKey === undefined
    if (err instanceof UnverifiedOxideIdentityError && setUnread) throw new PasskeySetUnreadError()
    throw err
  }
  throwIfEnded()
  // A tag named the account: the key must open that account and no other. Nothing is written for
  // an account the registry does not name, or for any account but the one the tag resolved to; the
  // name the registry holds for it now is the claim's, confirmed below when it is not the tag.
  const pinned = options.hints && isAccountHints(options.hints) ? options.hints.account : undefined
  if (pinned && (!identity || identity.account.toLowerCase() !== pinned.toLowerCase())) {
    return { entered: false, reason: "unknown", ...evidence(), storedAddressMismatch, verdict }
  }
  const adopt = async () => {
    const adopted = await adoptRecoveredAccount(
      wallet,
      recovered,
      msk,
      slot,
      derived,
      cancel,
      undefined,
      active,
    )
    // The commit stands, but a scope that ended while the account was persisted hands nothing back:
    // no result reaches a screen the user left.
    throwIfEnded()
    return adopted
  }
  if (!identity) {
    return {
      entered: false,
      reason: "unclaimed",
      ...(await adopt()),
      bootstrap: deriveBootstrapKey(msk),
      ensDomain,
      ...(remembered ? { usertag: remembered } : {}),
      ...(recovered.userHandle ? { userHandle: recovered.userHandle } : {}),
    }
  }

  const { account, held } = await adopt()
  const claim: EnteredClaim = {
    nameHash: identity.nameHash.toLowerCase(),
    address: account.getAddress().toString(),
    ensDomain,
  }
  // Naming the claim: the caller-supplied handle (from the claim link), the tag this credential
  // claimed on this browser, or the name the passkey itself carries, each verified against the
  // on-chain nameHash — none that matches confirms manually.
  const carried = strict ? undefined : recovered.userHandle
  const matched =
    (handle && tagMatches(claim, handle)) ||
    (remembered && tagMatches(claim, remembered)) ||
    (carried && tagMatches(claim, carried)) ||
    null
  if (matched) {
    return { entered: true, handle: matched, address: claim.address, account, held }
  }
  return { entered: false, reason: "confirm", claim, account, held }
}

/** The bare form of `handle` that hashes to the entered claim's node; null when none does. */
export function tagMatches(entered: EnteredClaim, handle: string): string | null {
  return matchWireNameHash(handle, entered.ensDomain, entered.nameHash as Hex)
}

/** The bare form of `handle` that hashes to any of `nameHashes`; null when none does. */
export function reservedTagMatch(
  nameHashes: readonly Hex[],
  ensDomain: string,
  handle: string,
): string | null {
  for (const nameHash of nameHashes) {
    const matched = matchWireNameHash(handle, ensDomain, nameHash)
    if (matched) return matched
  }
  return null
}

export function confirmTag(
  entered: EnteredClaim,
  handle: string,
): { handle: string; address: string } {
  const matched = tagMatches(entered, handle)
  if (!matched) throw new Error(`@${handle} is not the tag this passkey claimed`)
  // The matched form is what re-hashes to the claim on every later detection tick.
  return { handle: matched, address: entered.address }
}

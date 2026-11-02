/**
 * Web glue for the optimistic-registration machine: the durable pending store over wallet
 * storage, the credential-free boot detection tick, the foreground poll loop that keeps
 * ticking while a record is open, the presentation gate that keeps an unconfirmed tag rendering as
 * claiming-in-progress until a confirmation write settles the identity, and the one-shot notice a
 * lost name owes the user. Detection needs no PXE, no unlock, and no credential — a read-only
 * account-service client plus public RPC.
 */
import { useSyncExternalStore } from "react"
import {
  NameClaimStore,
  PendingRegistrationStore,
  SIPADepositStore,
  matchWireNameHash,
  createOxideL1Reader,
  createRegistrationDepositReader,
  isRegistrationEscalated,
  isTerminalRegistrationPhase,
  deploymentSipaRoute,
  legacyStore,
  registrationUiState,
  resumeOxideRegistration,
  type NameClaimRecord,
  type OxideResumeDeps,
  type OxideResumeOutcome,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type RegistrationScheduleAnswer,
  type ResumeOptions,
  type Sourced,
} from "@obsidion/front-core"
import { OxideSipaIntent, readNameClaimLog } from "@obsidion/sdk"
import { loadRegistrationTerms, scheduleSource, signedSchedule } from "./registrationTerms"
import { claimPublishesAddress } from "../paylink/ticketContinuation"
import type { Address, Hex, PublicClient } from "viem"

import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { fireOnboardingEvent } from "../../lib/analytics"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { walletStorage } from "../../platform/storage/walletStorage"
import {
  confirmWalletIdentity,
  loadWalletIdentity,
  retractPendingWalletIdentity,
  type WalletIdentity,
} from "../identity/walletIdentity"
import { syncRegistrationRail } from "./registrationRailSync"
import { oweRegistrationBroadcast, rememberRegistrationPayload } from "../broadcasts/broadcasts"

export function getPendingStore(): PendingRegistrationStore {
  return PendingRegistrationStore.get(webStorage)
}

/** Keeps the deposit rail in step with the records between ticks: a manual sweep stamps the record first. */
export function watchRegistrationRail(): () => void {
  const store = getPendingStore()
  return store.onListChanged(() => {
    void syncRegistrationRail(store.list()).catch(warnRailSync)
  })
}

/**
 * The pending registration behind a rail-tracked SIPA, if this deposit funds a name claim. The
 * deposit rail's exit surface routes on this: a registration SIPA's create2 binds the registration
 * intent (registration implementation, non-resweepable), so only the registration sweep can ever
 * move it — the plain deposit sweep fails its address parity check by construction.
 */
export function registrationRecordForSipa(sipaAddress: string): PendingRegistrationRecord | null {
  const needle = sipaAddress.toLowerCase()
  const match = (r: PendingRegistrationRecord) => r.sipaAddress.toLowerCase() === needle
  return getPendingStore().list().find(match) ?? replacedRegistrations().find(match) ?? null
}

/**
 * The schedule a registration SIPA's sweep is priced against, for the SIPA deposit lane. Only the
 * amounts the claim was signed on count, and only while they still name the fee the address
 * committed to, since one priced otherwise cannot register that address.
 *
 * Undefined for an address this wallet never registered, which the lane classifies as a plain
 * deposit. Unsweepable for a closed record, and for a live one whose terms moved off the committed
 * fee: neither can be registered at the fee its address commits to, so recovery is the only exit
 * left. Null only while a live record's terms are simply missing — the floor is this wallet's to
 * know, so the lane holds rather than classifying against a floor it does not have.
 */
export function registrationScheduleForSipa(sipaAddress: string): RegistrationScheduleAnswer {
  const record = registrationRecordForSipa(sipaAddress)
  if (!record) return undefined
  if (isTerminalRegistrationPhase(record.phase)) return "unsweepable"
  const amounts = signedSchedule(loadRegistrationTerms(record.account, record.tag))
  if (!amounts) return null
  if (record.fee !== undefined && amounts.fee !== BigInt(record.fee)) return "unsweepable"
  return amounts
}

const REPLACED_KEY = "webwallet.registration.replaced"

/**
 * Registrations the earned quote replaced. A deposit reaching a replaced address can only be
 * recovered, and recovery re-derives the address from the record the replacement overwrote, so
 * that record is kept here, closed: its claim cannot be re-issued at the fee its address commits
 * to, so no sweep registers it.
 */
export function archiveReplacedRegistration(record: PendingRegistrationRecord): Promise<void> {
  const key = record.sipaAddress.toLowerCase()
  const kept = replacedRegistrations().filter((r) => r.sipaAddress.toLowerCase() !== key)
  const closed: PendingRegistrationRecord = {
    ...record,
    phase: "failed_terminal",
    endTime: Date.now(),
  }
  return walletStorage.commitItem(REPLACED_KEY, JSON.stringify([closed, ...kept]))
}

/** An address the session re-entered is live again; its archived copy has nothing left to serve. */
export function forgetReplacedRegistration(sipaAddress: string): void {
  const key = sipaAddress.toLowerCase()
  const kept = replacedRegistrations().filter((r) => r.sipaAddress.toLowerCase() !== key)
  walletStorage.setItem(REPLACED_KEY, JSON.stringify(kept))
}

function decodeReplaced(raw: string | null): PendingRegistrationRecord[] {
  try {
    return raw ? (JSON.parse(raw) as PendingRegistrationRecord[]) : []
  } catch {
    return []
  }
}

export function replacedRegistrations(): PendingRegistrationRecord[] {
  return decodeReplaced(walletStorage.getItem(REPLACED_KEY))
}

/** The replaced registrations, read again on every write. */
export function replacedRegistrationRecords(): ReadonlyStore<Sourced<PendingRegistrationRecord[]>> {
  return legacyStore(
    {
      read: replacedRegistrations,
      subscribe: (onChange) =>
        walletStorage.onCommit((ops) => {
          if (ops.some(([key]) => key === REPLACED_KEY)) onChange()
        }),
    },
    [],
  )
}

/**
 * Whether one registration's stored terms still price an open record. The tick reads a record's
 * floor from them, so dropping them while the record is open prices its deposit off the chain's
 * standard schedule and an earned deposit never funds.
 */
export function registrationTermsAreInUse(account: string, tag: string): boolean {
  return getPendingStore()
    .list()
    .some(
      (r) =>
        r.account.toLowerCase() === account.toLowerCase() &&
        r.tag.toLowerCase() === tag.toLowerCase() &&
        !isTerminalRegistrationPhase(r.phase) &&
        loadRegistrationTerms(r.account, r.tag) !== null,
    )
}

function getNameClaimStore(): NameClaimStore {
  return NameClaimStore.get(webStorage)
}

// ── Detection settle signal ────────────────────────────────────────────────────
//
// Detection's identity writes notify nothing.
// Every path out of the boot tick — including a failed one — signals here so the presentation gate
// re-reads the identity instead of holding a render from before the tick.

const settleListeners = new Set<() => void>()

/** Fires on every path out of a detection tick, including a failed one. */
export function onDetectionSettled(listener: () => void): () => void {
  settleListeners.add(listener)
  return () => settleListeners.delete(listener)
}

function markDetectionSettled(): void {
  for (const listener of [...settleListeners]) listener()
}

// ── Detection deps + tick ──────────────────────────────────────────────────────

/** Maps an on-chain nameHash back to a locally-known plaintext tag (adoption gate). */
export async function resolveLocalTag(
  nameHash: Hex,
  config: WebWalletConfig,
): Promise<string | null> {
  const identity = loadWalletIdentity()
  if (!identity) return null
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  return matchWireNameHash(identity.handle, ensDomain, nameHash)
}

/** The resume machine's deps plus the L1 client a confirmed tick reuses for the NameClaim cache. */
export interface WebDetectionDeps extends OxideResumeDeps {
  publicClient: PublicClient
}

export async function buildWebDetectionDeps(
  config: WebWalletConfig,
  extras: Pick<OxideResumeDeps, "getSignDeps"> = {},
): Promise<WebDetectionDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return {
    env,
    l1: createOxideL1Reader(publicClient),
    publicClient,
    deposits: createRegistrationDepositReader({
      publicClient,
      registrationRoute: deploymentSipaRoute(tuple, OxideSipaIntent.Registration),
      registry: requireTupleField(tuple, "registry") as `0x${string}`,
      // Resolved from the registry, not the manifest: an absent or stale pin makes front-core
      // fall back to the registry, whose controller-era build has no schedule immutables.
      registrationController: await scheduleSource(config, publicClient as never),
      store: SIPADepositStore.get(webStorage),
      // The record holds no bearer material; the saved terms carry the signed amounts. The record
      // names the tag those terms priced, which one device's shared account cannot.
      termsFor: (account: string) => {
        const amounts = signedSchedule(
          loadRegistrationTerms(account, getPendingStore().get(account)?.tag),
        )
        const committedFee = getPendingStore().get(account)?.fee
        return amounts && (committedFee === undefined || amounts.fee === BigInt(committedFee))
          ? { fee: amounts.fee, minDeposit: amounts.min }
          : undefined
      },
    }),
    pendingStore: getPendingStore(),
    resolveLocalTag: (nameHash) => resolveLocalTag(nameHash, config),
    // Owing is a ledger write; the ledger proves it once the wallet is up. A ticket's claim on this
    // tab publishes the address itself, so it only keeps the fresh payload for that claim.
    oweBroadcast: async (record, owed) => {
      if (!claimPublishesAddress(record)) return oweRegistrationBroadcast(record, owed)
      if (owed?.payload) rememberRegistrationPayload(record.sipaAddress, owed.payload)
    },
    // The boot tick passes no extras and stays unlock-free; the wallet-bound loop and the pending
    // step's forced retry supply the sign deps a spent-rail renewal needs.
    ...extras,
  }
}

/**
 * One detection tick + the identity consequences: a lost race retracts a pending identity (a
 * lost name is never presented as owned), a confirm settles it. Marks the presentation gate
 * settled whatever the outcome — including a failed tick, which must not pin pending copy
 * forever on a network blip.
 */
export async function runDetectionTick(
  deps: WebDetectionDeps,
  opts: ResumeOptions = {},
): Promise<OxideResumeOutcome> {
  // The tick closes a confirming record, and a terminal record is invisible to current() — so the
  // account has to be in hand before it runs.
  const selected = opts.expectedRecord
    ? deps.pendingStore.get(opts.expectedRecord.account)
    : deps.pendingStore.current()
  const account = selected?.account
  try {
    const outcome = await resumeOxideRegistration(deps, opts)
    const identity = loadWalletIdentity()
    if (
      !opts.expectedRecord ||
      (selected &&
        identity?.handle === selected.tag &&
        identity.address.toLowerCase() === selected.l2Address.toLowerCase())
    )
      applyIdentityOutcome(outcome)
    if (outcome === "confirmed" && account) {
      const record = getPendingStore().get(account)
      if (record) applyConfirmedSideEffects(deps, record)
    }
    await syncRegistrationRail(getPendingStore().list()).catch(warnRailSync)
    return outcome
  } finally {
    markDetectionSettled()
  }
}

function warnRailSync(err: unknown): void {
  console.warn("[webRegistration] registration rail write failed; next tick retries:", err)
}

/**
 * What a confirmation owes beyond settling the identity: the funnel event and the NameClaim cache
 * the first sponsored batch subscribes with. Both are best-effort — identity settlement is
 * authoritative, and a missing cache entry costs only a recovery log scan at subscribe time.
 */
function applyConfirmedSideEffects(
  deps: WebDetectionDeps,
  record: PendingRegistrationRecord,
): void {
  // Deposit → confirmed comes from the durable record, so it survives the reload that a per-tab
  // analytics session does not. `fundedAt` is the closest custody marker in the deposit model.
  if (record.fundedAt !== undefined) {
    fireOnboardingEvent("onboarding_tag_claimed", {
      custody_to_confirmed_ms: Date.now() - record.fundedAt,
    })
  }
  void cacheNameClaimFromLog(deps.publicClient, deps.env.registry, record).catch(warnCacheFailure)
}

/** The subject of a cache write: which account to read the log from, and who to file it under. */
export interface ConfirmedClaimSubject {
  account: string
  tag: string
  l2Address: string
}

function warnCacheFailure(err: unknown): void {
  console.warn("[webRegistration] NameClaim cache write failed:", err)
}

/**
 * Cache the `NameClaimed` entry the Registry actually holds, keyed by L2 account, and return the
 * record (null when the Registry logged nothing for the account). Never the domain signer's
 * response: a reissued signature carries a different nonce/deadline than the one on chain, and
 * the cache's whole contract is that every entry is the on-chain artifact.
 */
export async function cacheNameClaimFromLog(
  publicClient: PublicClient,
  registry: Address,
  subject: ConfirmedClaimSubject,
): Promise<NameClaimRecord | null> {
  const log = await readNameClaimLog(publicClient, registry, subject.account as Address)
  if (!log) return null
  const record: NameClaimRecord = {
    address: subject.l2Address,
    handle: subject.tag,
    nameHash: log.nameHash,
    signature: log.signature,
    nonce: log.nonce,
    deadline: log.deadline,
  }
  await getNameClaimStore().put(record)
  return record
}

/**
 * The same cache write for a session that saw confirmation itself — a precheck that found the name
 * already ours, or a sponsor 409 disambiguated to our own account. Fire-and-forget by construction:
 * a missing entry costs the first sponsored batch one log scan, so it must never sit in front of
 * the flow that produced it.
 */
export function cacheConfirmedNameClaim(
  config: WebWalletConfig,
  subject: ConfirmedClaimSubject,
): void {
  void (async () => {
    const tuple = await getOxideTuple(config)
    const registry = requireTupleField(tuple, "registry") as Address
    await cacheNameClaimFromLog(l1PublicClient(config), registry, subject)
  })().catch(warnCacheFailure)
}

export function applyIdentityOutcome(outcome: OxideResumeOutcome): void {
  const identity = loadWalletIdentity()
  if (outcome === "needs_recovery" && identity?.pending && identity.handle) {
    markRecoveryNotice(identity.handle)
  }
  if (outcome === "taken" || outcome === "failed" || outcome === "needs_recovery") {
    retractPendingWalletIdentity()
  }
  if (outcome === "confirmed") confirmWalletIdentity()
}

/**
 * The identity lives under its own key, written after the record closes. A session that died
 * between the two — or another tab that closed the record — leaves a pending identity whose record
 * is already terminal, and a terminal record is invisible to `current()`. Boot resolves that pair
 * before the gate settles: the durable recovery marker or a matching failed close retracts the
 * identity, a matching confirmed close settles it. What it cannot resolve stays pending, and the
 * gate stays shut.
 */
function reconcilePendingIdentity(store: PendingRegistrationStore): void {
  const identity = loadWalletIdentity()
  if (!identity?.pending) return
  // A live record belongs to the tick; deciding it from an older closed one would settle the
  // wrong registration.
  if (store.current()) return
  if (walletStorage.getItem(RECOVERY_NOTICE_KEY) === identity.handle) {
    retractPendingWalletIdentity()
    return
  }
  const record = store
    .list()
    .find(
      (r) =>
        r.tag === identity.handle && r.l2Address.toLowerCase() === identity.address.toLowerCase(),
    )
  if (!record) return
  if (record.phase === "confirmed") confirmWalletIdentity()
  else retractPendingWalletIdentity()
}

/** The non-deferrable boot tick — mounted on app load, before and independent of unlock. */
export async function runBootDetection(config: WebWalletConfig): Promise<OxideResumeOutcome> {
  // No record → nothing to detect; settle the gate without building RPC deps.
  const store = getPendingStore()
  await store.load()
  reconcilePendingIdentity(store)
  // A record another tab or an earlier page closed may have left its bell row running.
  await syncRegistrationRail(store.list()).catch(warnRailSync)
  if (!store.current()) {
    markDetectionSettled()
    return "idle"
  }
  // The deps build makes its own network calls; a failure there must settle the gate too, or a
  // boot-time blip pins the pending presentation for the whole session.
  let deps: WebDetectionDeps
  try {
    deps = await buildWebDetectionDeps(config)
  } catch (err) {
    markDetectionSettled()
    throw err
  }
  return runDetectionTick(deps)
}

// ── Foreground detection loop ───

const FAST_POLL_MS = 5_000
const SLOW_POLL_MS = 45_000
const POLL_JITTER_MS = 10_000
const GRACE_MS = FAST_POLL_MS

/**
 * Foreground poll while a record is open. The band follows the record's STATE, not its age: a
 * record with custody (or a seen receipt) is what the user is actively waiting on — confirmation
 * is the deposit-address gate — so it stays fast until the machine itself asks for room (the
 * `nextAttemptAt` floor carries every backoff, e.g. web's no-re-sign 30s) or escalates. Slow is
 * for records the fast cadence cannot help: escalated, another chain's, or never-submitted ones
 * whose only path forward is a user action. Idles when no record is open and re-arms via the
 * store listener when one appears — that listener also fires the first tick, so custody →
 * confirmed is observed within the fast cadence rather than one interval late. A hidden tab arms
 * nothing; returning to visible ticks and restarts the cadence. Sign deps come only through
 * `buildDeps`; each tick is single-flight. The boot tick stays separate — it owns the no-record settle. A
 * record younger than the grace window is left alone: its own foreground session is still settling
 * the bundle POST.
 */
export function startDetectionLoop(
  config: WebWalletConfig,
  overrides: {
    buildDeps?: () => Promise<WebDetectionDeps>
    tick?: (deps: WebDetectionDeps) => Promise<OxideResumeOutcome>
  } = {},
): () => void {
  const buildDeps = overrides.buildDeps ?? (() => buildWebDetectionDeps(config))
  const tickOnce = overrides.tick ?? ((deps: WebDetectionDeps) => runDetectionTick(deps))
  let disposed = false
  let inFlight = false
  let visible = document.visibilityState !== "hidden"
  let timer: ReturnType<typeof setTimeout> | null = null
  let deps: Promise<WebDetectionDeps> | null = null

  const tick = async () => {
    if (disposed) return
    if (inFlight) {
      schedule()
      return
    }
    // No record: nothing to detect (the load-time list emit lands here too) — the listener
    // re-arms on the next change. Too fresh: the foreground session is still settling the POST.
    const record = getPendingStore().current()
    if (!record || Date.now() - record.startTime < GRACE_MS) {
      schedule()
      return
    }
    inFlight = true
    try {
      deps ??= buildDeps()
      await tickOnce(await deps)
    } catch (err) {
      deps = null
      console.warn("[webRegistration] detection tick failed:", err)
    } finally {
      inFlight = false
    }
    schedule()
  }

  const schedule = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    // Hidden tabs poll nothing: a tick that finished after the tab went away would otherwise re-arm
    // behind the visibility handler that just disarmed it. Returning visible ticks and re-arms.
    if (!visible) return
    const record = getPendingStore().current()
    if (!record) return // the store listener re-arms when a record appears
    // Slow predicates first — a wrong-chain record can be custody-proven, and its tick returns
    // "pending" without stamping a backoff, so the fast rule would otherwise spin on it.
    const slow =
      record.l1ChainId !== config.l1ChainId ||
      isRegistrationEscalated(record) ||
      !hasCustody(record)
    const base = slow ? SLOW_POLL_MS : FAST_POLL_MS
    // The record's own backoff is a floor: a tick that failed against a struggling dependency
    // asks for more room than the state-keyed cadence would give it.
    const requested = Math.max(base, (record.nextAttemptAt ?? 0) - Date.now())
    timer = setTimeout(() => void tick(), requested + Math.random() * POLL_JITTER_MS)
  }

  // Ticking (not merely scheduling) on a list change is what makes custody → confirmed prompt:
  // the promotion write fires the listener, and the tick's own grace/single-flight guards absorb
  // the too-fresh and already-running cases.
  const unsubscribe = getPendingStore().onListChanged(() => void tick())
  const onVisibility = () => {
    visible = document.visibilityState !== "hidden"
    if (visible) void tick()
    else if (timer) clearTimeout(timer)
  }
  document.addEventListener("visibilitychange", onVisibility)
  schedule()

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    unsubscribe()
    document.removeEventListener("visibilitychange", onVisibility)
  }
}

// ── Live-record discovery ──────────────────────────────────────────────────────

/** The name is coming: an L1 deposit landed at the SIPA (funded) or the relayer already swept it. */
export function hasCustody(record: PendingRegistrationRecord): boolean {
  return record.fundedAt !== undefined || record.sweptAt !== undefined
}

/** The deposit left the address for the portal: only the registry read is still to come. */
export function registrationSwept(
  record: Pick<PendingRegistrationRecord, "sweptAt" | "sweepTxHash">,
): boolean {
  return record.sweptAt !== undefined || record.sweepTxHash !== undefined
}

// ── Tag presentation gate ──────────────────────────────────────────────────────

/**
 * True while the identity must render as claiming-in-progress. The pending marker is the whole
 * gate, and only a confirmation write clears it — so a record that closed while the identity update
 * was lost, or a boot that cannot resolve the pair, keeps the tag surfaces (and the deposit
 * derivation behind them) shut rather than presenting a name the chain may have refused.
 */
export function isTagPresentationPending(identity: WalletIdentity | null): boolean {
  return identity?.pending === true
}

function subscribeRegistration(onChange: () => void): () => void {
  const offSettle = onDetectionSettled(onChange)
  const offList = getPendingStore().onListChanged(onChange)
  return () => {
    offSettle()
    offList()
  }
}

/** Render-level gate for home/deposit tag surfaces; also gates DepositScreen's mount effects. */
export function useTagPresentationPending(): boolean {
  return useSyncExternalStore(subscribeRegistration, () =>
    isTagPresentationPending(loadWalletIdentity()),
  )
}

/**
 * True once the open record is past the silent-retry bounds. Background ticks are detection-only
 * from here, so the claiming copy must stop reading as "any moment now" and steer to the pending
 * step's manual retry.
 */
export function useRegistrationEscalated(): boolean {
  return useSyncExternalStore(
    subscribeRegistration,
    () => registrationUiState(getPendingStore().current()) === "escalated",
  )
}

/**
 * True for an open record whose address the relayer never heard about and whose background driver
 * has stopped re-sending it. Only the pending step's forced retry publishes it now, so no surface
 * may ask for a deposit at it: money sent there is not swept until the claim is published.
 */
export function useRegistrationPublishStalled(record: PendingRegistrationRecord | null): boolean {
  const escalated = useRegistrationEscalated()
  return record !== null && !record.broadcast && escalated
}

/**
 * Whether a surface may show the record's address. Until its broadcast lands nothing sweeps a deposit
 * there. A record whose predecessor spent the rail is never broadcast; only a manual sweep registers it.
 */
export function registrationAddressPublished(record: PendingRegistrationRecord): boolean {
  return record.broadcast || record.replaced?.broadcastSpent === true
}

// ── Logout gate ────────────────────────────────────────────────────────────────

/**
 * Whether a claim for this wallet on this chain is still being driven. Logout is refused while one
 * is; an escalated record has stopped retrying on its own and no longer holds the user.
 */
export function logoutBlockedByRegistration(
  records: readonly PendingRegistrationRecord[],
  identity: WalletIdentity | null,
  l1ChainId: number,
  nowMs: number = Date.now(),
): boolean {
  if (!identity) return false
  const address = identity.address.toLowerCase()
  return records.some(
    (r) =>
      !isTerminalRegistrationPhase(r.phase) &&
      r.l2Address.toLowerCase() === address &&
      r.l1ChainId === l1ChainId &&
      !isRegistrationEscalated(r, nowMs),
  )
}

export function isLogoutBlockedByRegistration(): boolean {
  return logoutBlockedByRegistration(
    getPendingStore().list(),
    loadWalletIdentity(),
    getConfig().l1ChainId,
  )
}

// ── Lost-race notice ───────────────────────────────────────────────────────────

/** A lost name the user has not been told about: which tag went, and which steer to offer.
 *  `recovery` means the account holds a different name — steer to enter, never to a new claim. */
export interface LostRegistrationNotice {
  kind: "taken" | "failed" | "recovery"
  tag: string
}

const RECOVERY_NOTICE_KEY = "webwallet.registration.recovery"
const NOTICE_ACK_KEY = "webwallet.registration.noticeAck"

/**
 * `needs_recovery` closes the record `confirmed`, so it is invisible to `latestFailed()` and the
 * lost tag is only knowable from the identity about to be retracted. Never overwritten — the first
 * outcome is the one that lost the name.
 */
function markRecoveryNotice(tag: string): void {
  if (walletStorage.getItem(RECOVERY_NOTICE_KEY)) return
  walletStorage.setItem(RECOVERY_NOTICE_KEY, tag)
}

/**
 * Which terminal EVENT a notice came from. The account alone is not it: the account is
 * deterministic, so a later failure under the same account (a different tag, a different close)
 * would inherit the earlier acknowledgement and never be shown.
 */
function noticeEventId(record: PendingRegistrationRecord): string {
  return `${record.account.toLowerCase()}:${record.endTime ?? record.startTime}:${record.phase}`
}

/**
 * The lost outcome still owed to the user. Retraction wipes the identity but leaves the record, so
 * the steer survives the reload that a lost race otherwise sends the user through as a stranger.
 */
export function lostRegistrationNotice(): LostRegistrationNotice | null {
  const recoveryTag = walletStorage.getItem(RECOVERY_NOTICE_KEY)
  if (recoveryTag) return { kind: "recovery", tag: recoveryTag }
  const failed = getPendingStore().latestFailed()
  if (!failed || noticeEventId(failed) === walletStorage.getItem(NOTICE_ACK_KEY)) return null
  return { kind: failed.phase === "failed_taken" ? "taken" : "failed", tag: failed.tag }
}

/**
 * One-shot: the notice renders until the user takes it in. Acknowledges the notice that was
 * actually shown — same precedence as the query — so a recovery dismissal cannot also swallow an
 * unrelated failed record. A later loss is a different event and surfaces its own.
 */
export function acknowledgeLostRegistration(): void {
  if (walletStorage.getItem(RECOVERY_NOTICE_KEY)) {
    walletStorage.removeItem(RECOVERY_NOTICE_KEY)
    return
  }
  const failed = getPendingStore().latestFailed()
  if (failed) walletStorage.setItem(NOTICE_ACK_KEY, noticeEventId(failed))
}

/**
 * The user gave up on the open claim. Closing the record is what reopens the tag surfaces: while
 * it stays open the deposit gate stays shut. The pending identity goes with it — the name may yet
 * land on chain, and a name the wallet no longer tracks must never be presented as owned.
 *
 * Refused (`false`) while the op may still land: a stamped attempt or a promoted hash means the
 * bundler could hold it, and closing the record would discard the only watcher for a name about to
 * become the user's. Those settle to confirmed or failed on their own, and both have a flow.
 */
export async function abandonPendingRegistration(account?: string): Promise<boolean> {
  const record = account ? getPendingStore().get(account) : getPendingStore().current()
  if (!record) return true
  if (hasCustody(record)) return false
  const closed = await getPendingStore().close(record.account, "failed_terminal")
  const identity = loadWalletIdentity()
  if (
    !account ||
    (identity?.handle === record.tag &&
      identity.address.toLowerCase() === record.l2Address.toLowerCase())
  )
    retractPendingWalletIdentity()
  // The user chose this exit, so it is not also reported back to them as a loss.
  walletStorage.setItem(NOTICE_ACK_KEY, noticeEventId(closed))
  return true
}

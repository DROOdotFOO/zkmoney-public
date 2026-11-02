import { sha256 } from "@noble/hashes/sha2"
import { isDemoMode } from "../dev/demoFlag"
import { deviceStorage } from "../platform/storage/rollupStorage"
import { firstInTab, landingAttribution } from "./trafficSource"

/** Every event the web wallet emits, grouped by funnel. */
export type AnalyticsEvent =
  // ── PXE boot ──
  | "pxe_boot_completed"
  | "pxe_boot_failed"
  // The default node booted on its own word because L1 gave no usable identity (`call`: which
  // read failed). `profile_rollup_skew`: the profile's rollupVersion differs from the pinned one,
  // which refuses boot.
  // Neither carries a URL or a raw error.
  | "node_identity_unverified"
  | "profile_rollup_skew"
  // Per-tx phase timings (sync/sim/enclave/witgen/proving), from the sdk benchmark registry.
  | "tx_timing"
  // Screen-action failures, reported by useAsyncAction for any named action.
  | "action_failed"
  // A Predicate verdict blocked a flow (`flow` prop only — never the address).
  | "screening_blocked"
  // Contact-send funnel (ULT-497/ULT-734): per-step drop-off (contact → amount → send) plus one
  // event per settled transfer with confirm-to-mine duration and the amount range. The per-phase
  // breakdown (sim/enclave/witgen/proving) rides tx_timing.
  | "send_contact_selected"
  | "send_amount_confirmed"
  | "send_submitted"
  // ── Paylink-create funnel (ULT-734) ── Per-step drop-off: screen → amount confirmed → create
  // clicked. Success rides the /paylink-events `created` stage; the gap between submitted and
  // created is the failure rate.
  | "paylink_create_opened"
  | "paylink_create_amount_confirmed"
  | "paylink_create_submitted"
  // A visitor with no account, on a link that can pay its own way out: which way they took it.
  | "paylink_visitor_chose"
  // A ticket signup that went on without its ticket: the network paused them under it.
  | "paylink_ticket_paused"
  // ── Pay-a-request funnel (ULT-734) ── `source` prop separates contact requests (XMTP row) from
  // request links. Amount ranges only; an any-amount link reports "any".
  | "request_created"
  | "request_opened"
  | "request_paid"
  | "request_declined"
  // ── Proving outcomes ── `proving_cancelled` = an accepted user cancellation or leaving an
  // unfinished attempt before handoff; `proving_abandoned` = page teardown during that attempt.
  // Normal background handoffs, completion, and failures end tracking without either event.
  // Both carry `flow` and the coarse `stage`; `retry_clicked` carries `flow`.
  // `proving_leave_prompted` = the browser's leave prompt was raised over a running proof; it
  // carries `flow`. Whether the user then left shows as a `proving_abandoned`, if any.
  | "proving_cancelled"
  | "proving_abandoned"
  | "proving_leave_prompted"
  | "retry_clicked"
  // ── Withdraw funnel (ULT-503) ── The screen emits the first three; the last two ride the
  // persisted record's own timestamps via the phase reporter in `withdrawFunnel.ts`, so an L1
  // wait that outlives the tab still reports on the next mount. `l1_wait_ms` is the headline.
  | "withdraw_opened"
  | "withdraw_confirmed"
  | "withdraw_submitted"
  | "withdraw_finalization_ready"
  | "withdraw_finalized"
  // Self-finalize: the user broadcast the portal call themselves instead of waiting on the relayer.
  | "withdrawal_self_finalized"
  | "withdrawal_swap_executed"
  | "withdrawal_swap_recovered"
  // ── SIPA deposit funnel (ULT-502) ── `deposit_address_shown` fires when an address becomes
  // visible (`pooled` separates a landed pool entry from an address still publishing); the resolve
  // pair times the address's resolve and the publish pair the sponsored broadcast behind it. Stage
  // laps ride deposit_resolve_stage. No event ever carries the address.
  | "deposit_sheet_opened"
  | "deposit_address_shown"
  | "address_resolve_started"
  | "deposit_resolve_stage"
  | "address_resolve_succeeded"
  | "address_resolve_failed"
  | "address_published"
  | "address_publish_failed"
  // The address was shown before any rail could pay for its broadcast (`reason` is the
  // registration's pending state); the sync loop sends it later.
  | "address_publish_deferred"
  | "deposit_funded"
  | "deposit_swept"
  | "deposit_self_swept"
  | "deposit_recovered"
  // The registration terms the user accepted, and whether they chose to pay the deposit.
  | "registration_terms_accepted"
  // ── Find my passkey by tag ── The L1 read found the tag's credential (`more_keys`: the account
  // holds more than the one pinned). Every other by-tag outcome is an action_failed with its own
  // code under action `enter:by-tag`.
  | "passkey_by_tag_lookup_resolved"
  // ── Passkeys ── One per passkey attempt, in the closed vocabulary `@obsidion/passkey-web` owns.
  | "passkey_ceremony"
  // One per backup passkey add attempt and per backup passkey sign-in (lib/backupPasskeyTelemetry.ts).
  | "backup_passkey_add"
  | "backup_passkey_sign_in"

/**
 * The onboarding stream (docs/analytics/signup-funnel-events.md): sent on the signup platform
 * whatever the consent answer, with no identifier. zkmoney-api's ONBOARDING_EVENT_PROPS holds
 * each event's closed props.
 */
export type OnboardingEvent =
  // A visitor with no account opened a signup, login, payment-link or request page (`page`), once
  // per tab.
  | "landing_viewed"
  // The signup screen, once per tab.
  | "onboarding_started"
  // The login screen once per tab, then each login's outcome (`method`; `code` on a failure).
  | "login_opened"
  | "login_succeeded"
  | "login_failed"
  // Each "Create Account" click (`attempt` 1 or 2+), and the claim server's drawn tag (`shuffle` on a
  // re-roll).
  | "onboarding_create_attempted"
  | "onboarding_tag_drawn"
  // A signup step (`step` draw, account or claim) ended without its result. Passkey failures are
  // passkey_ceremony's.
  | "onboarding_failed"
  // The Choose your name sheet: opened (`screen`), and the route taken to claim a name (`route`).
  // onboarding_handle_checked carries the sheet's availability verdict.
  | "name_sheet_opened"
  | "name_route_chosen"
  | "onboarding_handle_checked"
  // The passkey exists; `route` is how its tag was got.
  | "onboarding_account_created"
  // `tag_claimed` means CONFIRMED on the Registry. A submitted op fires it from the detection tick
  // with custody_to_confirmed_ms from the durable record, so it never needs cross-session pairing.
  | "onboarding_tag_claimed"
  | "onboarding_oxide_stage"
  // The ticket proof's phases (wasm, witness, backend, proof) and the device class.
  | "golden_ticket_proof"
  // `named` separates tag-claiming completions from nameless wallets, which skip the tag events.
  | "onboarding_completed"
  // A finished signup leaving for the wallet, once per account.
  | "wallet_entered"
  // The registration deposit: shown → funded → swept, plus the lapse of a quote that ran out
  // unfunded. No event carries an address or an amount.
  // The deposit screen opened while the registration is unpaid.
  | "registration_deposit_opened"
  | "registration_deposit_shown"
  | "registration_deposit_funded"
  | "registration_deposit_swept"
  | "registration_lapsed"
  // A registered user changing tag (features/onboarding/tagChangeFunnel.ts).
  | "tag_change_opened"
  | "tag_change_route_chosen"
  | "tag_change_confirmed"
  | "tag_change_funded"
  | "tag_change_registered"
  | "tag_change_abandoned"
  // The in-app browser card (features/identity/inAppCardTelemetry.ts): its first display per page
  // load per moment, and each control tapped.
  | "onboarding_in_app_shown"
  | "onboarding_in_app_exit"

export type AnalyticsProps = Record<string, string | number | boolean | undefined>

/** Absent URL (dev/e2e) disables analytics entirely: fireEvent no-ops. */
export const analyticsUrl = (import.meta.env.VITE_ZKMONEY_API_URL as string | undefined)?.replace(
  /\/$/,
  "",
)

/** Build identity, so a funnel regression can be pinned to a deploy. "dev" for un-baked builds. */
export const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "dev"

/**
 * Opt-in consent gate. Fails closed: until App.tsx binds the config-backed getter AND the user has
 * granted consent (local config `analyticsConsent`), no event leaves the device. Three things do not
 * pass through it: an onboarding event and a passkey result the signup flow opened, which carry no
 * identifier (see `fireSignupEvent`), and a report the user submits by hand, which is its own
 * consent.
 */
let consentGranted: () => boolean = () => false

export function bindAnalyticsConsent(getter: () => boolean) {
  consentGranted = getter
}

/** Demo mode (`?demo`) reads false regardless of consent: fixture-driven UI reviews and recordings must never pollute real metrics. */
export function analyticsEnabled(): boolean {
  return !!analyticsUrl && !isDemoMode() && consentGranted()
}

/**
 * Consent disclosure. Paylink events carry amount ranges and a hashed link identifier (derived from
 * the link's tagging public key), so it may not promise that amounts are never sent — "anonymized
 * link identifier" is the honest phrasing. It names the onboarding counts, which no answer turns off.
 */
export const ANALYTICS_CONSENT_COPY =
  "Share anonymous data on how you use the wallet — like timings and paylink activity shown in amount ranges (e.g., “under $50”) linked to an anonymized ID. Exact amounts, addresses, or tags are never shared. Signup and login steps are always counted, with no ID. You can update this anytime in settings."

const BASE_ID_KEY = "zkm_bid"
/** Storage keys of the pre-base independent random ids; unread now, deleted when the base is minted. */
const LEGACY_ID_KEYS = ["zkm_sid", "zkm_rid"]

const baseIdMemory: { id?: string } = {}

/**
 * Base metrics identifier (ULT-740). Strictly local: it never leaves the device and no backend,
 * Postgres table, or PostHog project ever sees it. Both wire ids derive from it one-way, so the
 * server cannot link the event stream to the error-report stream — but a user who reveals the base
 * id to support lets support recompute both derivations and join their two histories on purpose.
 *
 * Storage that throws (cookie blocking, private mode, quota) degrades to an in-memory id held for
 * the page's lifetime. The memory cache is what keeps the degraded id STABLE: a fresh id per call
 * would make every event look like a new device, silently inflating funnel and retention counts —
 * worse than dropping the events. And an id lookup must never break the wallet action that fired
 * the event, hence the swallowed catch.
 */
function baseId(): string {
  try {
    let id = deviceStorage.getItem(BASE_ID_KEY)
    if (!id) {
      id = baseIdMemory.id ?? crypto.randomUUID()
      deviceStorage.setItem(BASE_ID_KEY, id)
      for (const key of LEGACY_ID_KEYS) deviceStorage.removeItem(key)
    }
    return (baseIdMemory.id = id)
  } catch {
    return (baseIdMemory.id ??= crypto.randomUUID())
  }
}

const SID_DOMAIN = "zkm.sid.v1"
const RID_DOMAIN = "zkm.rid.v1"

/**
 * SHA-256(`domain:base`) rendered as a UUID, so the wire shape matches the `session_id` strings the
 * backend and PostHog store. The derivation is a public contract — support tooling recomputes it
 * from a user-revealed base id (ULT-741) — pinned against drift by test vectors.
 */
function deriveId(domain: string, base: string): string {
  const bytes = sha256(new TextEncoder().encode(`${domain}:${base}`)).slice(0, 16)
  // RFC 9562 §4.2 version/variant bits, as crypto.randomUUID() sets them: derived ids stay
  // indistinguishable from random v4 UUIDs and valid under any strict uuid parsing downstream.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`
}

let derived: { base: string; sid: string; rid: string } | undefined

function derivedIds(): { sid: string; rid: string } {
  const base = baseId()
  if (derived?.base !== base) {
    derived = { base, sid: deriveId(SID_DOMAIN, base), rid: deriveId(RID_DOMAIN, base) }
  }
  return derived
}

/**
 * Anonymous per-device analytics id: the base id's `sid` derivation. Stable as long as the base
 * persists (so cross-session funnels and retention are computable; wiped with site data), never
 * derived from account material, UUID-shaped so the `session_id` wire field and server schema are
 * untouched.
 */
export function sessionId(): string {
  return derivedIds().sid
}

/**
 * Separate wire id for error reports, so a report can never join the analytics history. Reports
 * bypass the analytics consent gate and may quote raw tags or addresses in free text — under the
 * analytics id, one report would de-anonymize the device's entire event stream. Domain separation
 * keeps the two derivations unlinkable server-side; reports still correlate with each other
 * (debugging needs that), just never with `/events` rows.
 */
export function reportId(): string {
  return derivedIds().rid
}

/**
 * The raw base id, for display and copy only (Settings → Support ID, ULT-741). Revealing it to
 * support is the user's deliberate act of joining their event and error-report histories — support
 * recomputes both derivations from it. Code must never put this value on the wire.
 */
export function baseMetricsId(): string {
  return baseId()
}

/** Coarse breakpoint bucket stamped on every event — mobile/tablet/desktop split, nothing finer. */
export function viewportBucket(): "sm" | "md" | "lg" {
  const w = window.innerWidth
  return w <= 640 ? "sm" : w <= 1080 ? "md" : "lg"
}

/** Fire-and-forget POST; keepalive survives page unload. Analytics must never break the app. */
function postJson(path: string, body: Record<string, unknown>): void {
  try {
    void fetch(`${analyticsUrl}${path}`, {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {})
  } catch {
    // Never let analytics break the app.
  }
}

/** The same POST with the cookie left off, for a ping that must carry nothing identifying. */
function postWithoutCookies(path: string, body: Record<string, unknown>): void {
  try {
    void fetch(`${analyticsUrl}${path}`, {
      method: "POST",
      keepalive: true,
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {})
  } catch {
    // Never let analytics break the app.
  }
}

const SIGNUP_PLATFORM = "web-signup"

/** The attempt flows the signup wizard opens. A result carrying one of these is a signup result. */
const SIGNUP_FLOWS: ReadonlySet<string> = new Set(["onboarding"])

/** Events sent on the signup platform, whatever the consent answer. */
export type SignupEvent = { event: "passkey_ceremony" | OnboardingEvent; props?: AnalyticsProps }

/**
 * An event the signup flow sends before it can ask for consent, on the footing the campaign's
 * pings have always used: no session id, no viewport, no cookie, and no consent answer consulted.
 * The build version rides along and the API keeps it off the export.
 */
export function fireSignupEvent({ event, props }: SignupEvent): void {
  try {
    if (!analyticsUrl || isDemoMode()) return
    postWithoutCookies("/events", {
      event,
      platform: SIGNUP_PLATFORM,
      app_version: appVersion,
      props,
    })
  } catch {
    // Optional analytics must never break the wallet action that fired it.
  }
}

/** The acquisition steps: each carries the landing's `channel` and `source`. */
export const ATTRIBUTED_EVENTS: ReadonlySet<OnboardingEvent> = new Set<OnboardingEvent>([
  "landing_viewed",
  "onboarding_started",
  "onboarding_create_attempted",
  "onboarding_failed",
  "onboarding_account_created",
  "onboarding_completed",
  "wallet_entered",
  "login_opened",
  "login_succeeded",
  "login_failed",
])

export type LandingPage = "signup" | "login" | "paylink" | "request_link" | "pay_page"

/** The first page a visitor with no account sees in a tab. */
export function reportLanding(page: LandingPage): void {
  if (firstInTab("landing_viewed")) fireOnboardingEvent("landing_viewed", { page })
}

export function fireOnboardingEvent(event: OnboardingEvent, props?: AnalyticsProps): void {
  fireSignupEvent({
    event,
    props: ATTRIBUTED_EVENTS.has(event) ? { ...props, ...landingAttribution() } : props,
  })
}

/**
 * Fire-and-forget POST to the self-hosted zkmoney-api events table.
 * Explicit allowlisted events only — no autocapture, no identify.
 */
export function fireEvent(event: AnalyticsEvent, props?: AnalyticsProps) {
  try {
    // A passkey result the signup flow opened takes the identifier-free channel instead.
    if (
      event === "passkey_ceremony" &&
      typeof props?.flow === "string" &&
      SIGNUP_FLOWS.has(props.flow)
    ) {
      return fireSignupEvent({ event, props })
    }
    if (!analyticsEnabled()) return
    postJson("/events", {
      event,
      session_id: sessionId(),
      platform: "web",
      app_version: appVersion,
      props: { viewport: viewportBucket(), ...props },
    })
  } catch {
    // Optional analytics must never break the wallet action that fired it.
  }
}

/** Ascending ladder; anything at or above the last threshold clamps to ">=1k". */
const AMOUNT_BUCKETS: [bigint, AmountRange][] = [
  [5n, "<5"],
  [10n, "<10"],
  [50n, "<50"],
  [100n, "<100"],
  [500n, "<500"],
  [1000n, "<1k"],
]

export type AmountRange = "<5" | "<10" | "<50" | "<100" | "<500" | "<1k" | ">=1k"

/** Compares in atomic units — an exact amount never becomes a float and never leaves the device. */
export function amountBucket(amount: bigint, decimals: number): AmountRange {
  const scale = 10n ** BigInt(decimals)
  for (const [threshold, label] of AMOUNT_BUCKETS) if (amount < threshold * scale) return label
  return ">=1k"
}

/** Bucket for a display-unit USD amount; 0 means an any-amount request link. */
export function requestAmountBucket(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "any"
  return amountBucket(BigInt(Math.floor(amount)), 0)
}

const PAYLINK_PH_DOMAIN = "zkm/paylink-analytics/v3\0"

export type PaylinkFlavor = "direct" | "email" | "zk"

const ROLLUP_ADDRESS_BYTES = 20
const SECRET_BYTES = 32

/**
 * Funnel join key, client stage. Creator and claimant both hold the link's secret (it rides the
 * bearer fragment and never appears on-chain), so both derive the same value — and only link
 * holders can. The secret already separates flavors, since flavor is an input to its derivation;
 * the rollup address is mixed in because the same secret could recur across networks. This stage
 * keeps the secret off the wire; the server's pepper breaks the stored pid back to this hash.
 */
export async function paylinkPh(input: {
  /** Active network's rollup address, `0x` + 40 hex. */
  rollupAddress: string
  /** The link's escrow secret, a 32-byte field. */
  secret: { toBuffer(): Uint8Array }
}): Promise<string> {
  const addr = input.rollupAddress.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error("malformed rollup address")
  const keyBytes = input.secret.toBuffer()
  if (keyBytes.length !== SECRET_BYTES) {
    throw new Error("paylink secret must be a 32-byte field")
  }
  const prefix = new TextEncoder().encode(PAYLINK_PH_DOMAIN)
  const bytes = new Uint8Array(prefix.length + ROLLUP_ADDRESS_BYTES + SECRET_BYTES)
  bytes.set(prefix)
  for (let i = 0; i < ROLLUP_ADDRESS_BYTES; i++) {
    bytes[prefix.length + i] = parseInt(addr.slice(2 + 2 * i, 4 + 2 * i), 16)
  }
  bytes.set(keyBytes, prefix.length + ROLLUP_ADDRESS_BYTES)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A range, or `unknown` when this device could not read the amount — never a guessed range. */
export type PaylinkAmountBucket = AmountRange | "unknown"

export function paylinkAmountBucket(
  amount: bigint | undefined,
  decimals: number,
): PaylinkAmountBucket {
  return amount === undefined ? "unknown" : amountBucket(amount, decimals)
}

export interface PaylinkEvent {
  // `link_opened` is the funnel top: any /link mount by a link holder, claimed or not. `claimed`
  // is the escrow spent on L2, into an account or to Ethereum; the L1 payout is not part of it.
  stage: "created" | "link_opened" | "claimed" | "refunded"
  flavor: PaylinkFlavor
  amount_bucket: PaylinkAmountBucket
  paylink_ph: string
}

/**
 * Paylink events take their own route: fireEvent posts to /events, whose lenient table has no
 * peppered pid column, so a paylink hash landing there would be chain-joinable. No session id —
 * the pid is the only join, deliberately.
 */
export function firePaylinkEvent(event: PaylinkEvent) {
  try {
    if (!analyticsEnabled()) return
    postJson("/paylink-events", { ...event, app_version: appVersion })
  } catch {
    // Same guarantee as fireEvent.
  }
}

/** ms since the last call, or since creation: one call reads elapsed time, repeated calls lap a pipeline. */
export function lapTimer(): () => number {
  let last = performance.now()
  return () => {
    const now = performance.now()
    const ms = Math.round(now - last)
    last = now
    return ms
  }
}

/**
 * Closed set of failure labels. Error text never reaches the backend: onboarding messages
 * interpolate wire names and account addresses (`Registry resolves <tag>.zk.money to 0x…`), and
 * publishing those would link a plaintext tag to its account — the pairing the on-chain design
 * avoids by storing only the tag hash. Matching reads the message; only the label is ever emitted,
 * so a message that matches nothing degrades to "unknown" rather than leaking.
 */
export type FailureCode =
  | "tag_taken"
  | "tag_mismatch"
  | "signin_cancelled"
  | "signin_timeout"
  | "popup_blocked"
  | "wallet_locked"
  | "wallet_not_ready"
  | "passkey_no_key_material"
  | "passkey_incomplete_creation"
  | "state_lost"
  | "userop_timeout"
  | "userop_reverted"
  | "registry_mismatch"
  | "key_not_installed"
  | "contract_missing"
  | "user_not_registered"
  | "reservation_lapsed"
  | "deposit_below_minimum"
  | "admission_unreachable"
  | "passkey_wrong_device"
  | "passkey_device_bound"
  | "passkey_no_wallet"
  | "passkey_unsupported_provider"
  | "passkey_phone_unreachable"
  // The sign-in prompt closed without a passkey: a deliberate cancel and a "no passkeys" sheet
  // are counted together, since the wallet cannot tell them apart.
  | "passkey_prompt_closed"
  // Find my passkey by tag, one per terminal outcome (findPasskeyByTag.ts BY_TAG_FAILURE_CODES).
  | "bytag_tag_not_found"
  | "bytag_stale_rollup"
  | "bytag_no_key_installed"
  | "bytag_key_unreadable"
  | "bytag_lookup_failed"
  | "bytag_not_reproduced_here"
  | "bytag_different_passkey"
  | "bytag_inconclusive"
  | "bytag_local_copy_wrong_key"
  | "passkey_not_on_device"
  | "passkey_wrong_credential"
  | "registry_unanchored"
  | "passkey_key_mismatch"
  // A backup passkey answered, but its envelope did not open.
  | "backup_envelope_failed"
  | "unknown"

/** The wallet's own refusals that are not the policy's, by their stable error names. */
const WALLET_FAILURE_CODES: Record<string, FailureCode> = {
  PasskeyEnvelopeError: "backup_envelope_failed",
}

/** The passkey policy's refusals, by their stable error names. */
const POLICY_REFUSAL_CODES: Record<string, FailureCode> = {
  PhoneRequiredError: "passkey_wrong_device",
  LocalPasskeyRequiredError: "passkey_wrong_device",
  SecurityKeyRequiredError: "passkey_wrong_device",
  DeviceBoundPasskeyError: "passkey_device_bound",
  NoPrfError: "passkey_no_key_material",
  IncompleteCreationError: "passkey_incomplete_creation",
  SecurityKeyNoPrfError: "passkey_no_key_material",
  SingleSaltProviderError: "passkey_no_key_material",
  UnsupportedProviderError: "passkey_unsupported_provider",
  LaptopPasskeyRefusedError: "passkey_unsupported_provider",
  PhoneUnreachableError: "passkey_phone_unreachable",
  RotatedCredentialError: "passkey_no_wallet",
  NoWalletForPasskeyError: "passkey_no_wallet",
  AmbiguousPasskeyError: "passkey_no_wallet",
  PasskeyMismatchError: "passkey_no_wallet",
}

const FAILURE_PATTERNS: [RegExp, FailureCode][] = [
  [/is already taken/, "tag_taken"],
  [/is not the tag this passkey claimed/, "tag_mismatch"],
  [/sign-in was cancelled/, "signin_cancelled"],
  [/sign-in timed out/, "signin_timeout"],
  [/popup was blocked/, "popup_blocked"],
  [/wallet is locked/, "wallet_locked"],
  [/wallet not ready/, "wallet_not_ready"],
  [/returned no key material/, "passkey_no_key_material"],
  [/state lost|without claim artifacts/, "state_lost"],
  [/not included within/, "userop_timeout"],
  [/reverted on-chain/, "userop_reverted"],
  [/Registry resolves/, "registry_mismatch"],
  [/no r1 key was installed/, "key_not_installed"],
  [/not found on-chain|not registered in PXE/, "contract_missing"],
  [/UserNotFound|User not found/, "user_not_registered"],
  [/no account for this session/, "wallet_locked"],
  [/reservation (has )?(expired|lapsed)/i, "reservation_lapsed"],
  [/below the (registration )?minimum|minimum deposit/i, "deposit_below_minimum"],
  [/admission (check |verify )?(unreachable|failed)/i, "admission_unreachable"],
]

export function failureCode(error: unknown): FailureCode {
  if (error instanceof Error && POLICY_REFUSAL_CODES[error.name]) {
    return POLICY_REFUSAL_CODES[error.name]!
  }
  if (error instanceof Error && WALLET_FAILURE_CODES[error.name]) {
    return WALLET_FAILURE_CODES[error.name]!
  }
  const message = error instanceof Error ? error.message : String(error)
  for (const [pattern, code] of FAILURE_PATTERNS) if (pattern.test(message)) return code
  return "unknown"
}

/**
 * Plain inputs to `passkey_ceremony` values: environment, route, backup flag, error classification,
 * counters and report env. Every function returns only vocabulary members, and never copies an
 * error message, an id or a version string. The one exception is the report env, which names an
 * `other` provider by its AAGUID.
 */

import {
  type PasskeyAnswerEvidence,
  type PasskeyRequestSignal,
  isEvictedRequestError,
  isNoCredentialError,
  isUnsupportedAlgorithmError,
  isWedgedTabError,
} from "../ceremony/passkeyCeremony.js"
import type { DevicePosture } from "../browser/devicePosture.js"
import type { PhoneReach } from "../browser/passkeyCapabilities.js"
import type { LaptopRefusalKind } from "../refusals/passkeyErrors.js"
import { providerSlugFor } from "../rules/passkeyProviders.js"
import {
  PASSKEY_BROWSER_FAMILIES,
  PASSKEY_CANCEL_REASONS,
  PASSKEY_ERROR_NAMES,
  PASSKEY_FAILURE_REASONS,
  PASSKEY_MAJOR_MAX,
  PASSKEY_MAJOR_MIN,
  PASSKEY_OS_FAMILIES,
  PASSKEY_PROVIDERS,
  PASSKEY_REFUSAL_REASONS,
  type PasskeyAttempt,
  type PasskeyBackupEligible,
  type PasskeyBrowser,
  type PasskeyCancelReason,
  type PasskeyDeviceClass,
  type PasskeyElapsed,
  type PasskeyErrorName,
  type PasskeyFailureReason,
  type PasskeyOs,
  type PasskeyPhoneReach,
  type PasskeyPrompts,
  type PasskeyProvider,
  type PasskeyRefusalReason,
  type PasskeyRoute,
} from "./passkeyTelemetryVocabulary.js"
import { impliedKeyTransports, isSecurityKey } from "../rules/slotRule.js"
import type { UserAgentInfo } from "../browser/userAgentInfo.js"

const listed = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  (values as readonly unknown[]).includes(value) ? (value as T) : fallback

export type PasskeyEnvironmentProps = {
  device_class: PasskeyDeviceClass
  os: PasskeyOs
  os_major?: number
  browser: PasskeyBrowser
  browser_major?: number
}

/** The leading number of a dotted version, when it is in range. */
function majorOf(version: string): number | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(version)
  const major = match ? Number(match[1]) : NaN
  return major >= PASSKEY_MAJOR_MIN && major <= PASSKEY_MAJOR_MAX ? major : undefined
}

/**
 * Only a version that means something: iOS from the user agent (a claim), and macOS, Windows and
 * Android from Client Hints. Their user-agent versions are frozen, and Windows hints number 11 from
 * 13 and 10 from 1.
 */
function osMajorFor(os: PasskeyOs, userAgent: UserAgentInfo): number | undefined {
  const major = majorOf(userAgent.osVersionReported)
  if (major === undefined) return undefined
  if (os === "ios") return major
  if (!userAgent.osVersionFromHints) return undefined
  if (os === "macos" || os === "android") return major
  if (os === "windows") return major >= 13 ? 11 : major <= 10 ? 10 : undefined
  return undefined
}

export function passkeyEnvironmentPropsFor(input: {
  posture: DevicePosture
  userAgent: UserAgentInfo
}): PasskeyEnvironmentProps {
  const os = listed(PASSKEY_OS_FAMILIES, input.userAgent.osFamily satisfies PasskeyOs, "unknown")
  const osMajor = osMajorFor(os, input.userAgent)
  const browserMajor = majorOf(input.userAgent.browserVersionReported)
  return {
    device_class: input.posture === "phone" ? "phone" : "laptop",
    os,
    ...(osMajor === undefined ? {} : { os_major: osMajor }),
    browser: listed(
      PASSKEY_BROWSER_FAMILIES,
      input.userAgent.browserFamily satisfies PasskeyBrowser,
      "unknown",
    ),
    ...(browserMajor === undefined ? {} : { browser_major: browserMajor }),
  }
}

/**
 * How an answered request was reached, read with the policy's own helpers. Missing or conflicting
 * evidence is `unknown`, and a request that names `hybrid` is never a security key.
 */
export function passkeyRouteFor(
  kind: PasskeyRequestSignal["kind"],
  evidence: PasskeyAnswerEvidence | undefined,
): PasskeyRoute {
  const authenticatorAttachment = evidence?.authenticatorAttachment
  const transports = evidence?.transports
  const hybrid = transports?.includes("hybrid") === true
  if (kind === "create") {
    if (isSecurityKey({ authenticatorAttachment, transports, attestedAaguid: evidence?.aaguid })) {
      return "security_key"
    }
    if (authenticatorAttachment === "platform") return "same_device"
    return authenticatorAttachment === "cross-platform" && hybrid ? "phone_qr" : "unknown"
  }
  if (authenticatorAttachment === "platform") return "same_device"
  if (authenticatorAttachment !== "cross-platform") return "unknown"
  const backupEligible = evidence?.backupEligible
  if (impliedKeyTransports({ authenticatorAttachment, backupEligible })) {
    return hybrid ? "unknown" : "security_key"
  }
  return backupEligible === true ? "phone_qr" : "unknown"
}

export const backupEligibleFor = (
  evidence: PasskeyAnswerEvidence | undefined,
): PasskeyBackupEligible =>
  evidence?.backupEligible === true ? "yes" : evidence?.backupEligible === false ? "no" : "unknown"

export type PasskeyClassification =
  | { outcome: "cancelled"; reason: PasskeyCancelReason }
  | { outcome: "refused"; reason: PasskeyRefusalReason }
  | { outcome: "failed"; reason: PasskeyFailureReason }

/** A front's own error test and what a match means. */
export type PasskeyErrorPredicate = {
  test: (error: unknown) => boolean
  classification: PasskeyClassification
}

export type PasskeyErrorContext = {
  /** Some request in the action reached `issued`. */
  issued: boolean
  /** Some request in the action reached `answered`. */
  answered: boolean
  /** The front's error names, tried after the policy's. */
  extraNames?: Readonly<Record<string, PasskeyClassification>>
  /** The front's error tests, tried after its names. */
  extraPredicates?: readonly PasskeyErrorPredicate[]
}

const POLICY_REFUSALS: Readonly<Record<string, PasskeyRefusalReason>> = {
  SecurityKeyRequiredError: "security_key_required",
  PhoneRequiredError: "phone_required",
  LocalPasskeyRequiredError: "local_passkey_required",
  DeviceBoundPasskeyError: "not_synced",
  SecurityKeyNoPrfError: "security_key_no_prf",
  IncompleteCreationError: "incomplete_creation",
  NoPrfError: "no_prf",
  SingleSaltProviderError: "single_salt_provider",
  UnsupportedProviderError: "provider_not_supported",
  NoWalletForPasskeyError: "no_wallet_for_passkey",
  PhoneUnreachableError: "phone_unreachable",
  RotatedCredentialError: "rotated_credential",
  AmbiguousPasskeyError: "ambiguous_passkey",
  RelatedOriginPasskeyError: "related_origin",
}

/** `LaptopPasskeyRefusedError` carries its reason in `kind`; an unknown kind counts as unnamed. */
const LAPTOP_REFUSALS: Readonly<Record<LaptopRefusalKind, PasskeyRefusalReason>> = {
  "apple": "apple_below_floor",
  "unnamed": "provider_unnamed",
  "not-local": "local_route_mismatch",
}

function laptopRefusalReason(error: unknown): PasskeyRefusalReason {
  const kind = (error as { kind?: unknown } | null)?.kind
  return (typeof kind === "string" && lookup(LAPTOP_REFUSALS, kind)) || "provider_unnamed"
}

const CEREMONY_FAILURES: readonly PasskeyErrorPredicate[] = [
  {
    test: (error) => isWedgedTabError(error) || isEvictedRequestError(error),
    classification: { outcome: "failed", reason: "request_stuck" },
  },
  {
    test: isNoCredentialError,
    classification: { outcome: "failed", reason: "no_credential_returned" },
  },
  {
    test: isUnsupportedAlgorithmError,
    classification: { outcome: "failed", reason: "unsupported_algorithm" },
  },
]

const DOM_EXCEPTIONS: Readonly<Record<string, PasskeyClassification>> = {
  NotAllowedError: { outcome: "cancelled", reason: "prompt_closed" },
  AbortError: { outcome: "cancelled", reason: "prompt_aborted" },
  InvalidStateError: { outcome: "failed", reason: "invalid_state" },
  SecurityError: { outcome: "failed", reason: "security_error" },
  NotSupportedError: { outcome: "failed", reason: "not_supported" },
  ConstraintError: { outcome: "failed", reason: "constraint" },
}

const REASONS: Readonly<Record<PasskeyClassification["outcome"], readonly string[]>> = {
  cancelled: PASSKEY_CANCEL_REASONS,
  refused: PASSKEY_REFUSAL_REASONS,
  failed: PASSKEY_FAILURE_REASONS,
}

/** A fresh copy holding only a listed outcome and one of its reasons. */
export function checkedPasskeyClassification(
  value: PasskeyClassification | undefined,
): PasskeyClassification | undefined {
  if (!value || !Object.hasOwn(REASONS, value.outcome)) return undefined
  if (!REASONS[value.outcome].includes(value.reason)) return undefined
  return { outcome: value.outcome, reason: value.reason } as PasskeyClassification
}

const lookup = <T>(table: Readonly<Record<string, T>> | undefined, name: string | undefined) =>
  table && name !== undefined && Object.hasOwn(table, name) ? table[name] : undefined

function nameOf(error: unknown): string | undefined {
  try {
    const name = (error as { name?: unknown } | null | undefined)?.name
    return typeof name === "string" ? name : undefined
  } catch {
    return undefined
  }
}

function passes(predicate: PasskeyErrorPredicate, error: unknown): boolean {
  try {
    return predicate.test(error) === true
  } catch {
    return false
  }
}

/**
 * What a thrown value means; the first match wins: a policy refusal, the front's names and tests,
 * the ceremony's own failures, the browser's exception names. Anything else fails `after_prompt` or
 * `request_failed` by how far the action got, and is `undefined` when no request was issued.
 */
export function classifyPasskeyError(
  error: unknown,
  context: PasskeyErrorContext,
): PasskeyClassification | undefined {
  const name = nameOf(error)
  if (name === "LaptopPasskeyRefusedError") {
    return { outcome: "refused", reason: laptopRefusalReason(error) }
  }
  const refusal = lookup(POLICY_REFUSALS, name)
  if (refusal) return { outcome: "refused", reason: refusal }
  const named = checkedPasskeyClassification(lookup(context.extraNames, name))
  if (named) return named
  for (const predicate of [...(context.extraPredicates ?? []), ...CEREMONY_FAILURES]) {
    const matched = passes(predicate, error)
      ? checkedPasskeyClassification(predicate.classification)
      : undefined
    if (matched) return matched
  }
  const dom = lookup(DOM_EXCEPTIONS, name)
  if (dom) return { ...dom }
  if (context.answered) return { outcome: "failed", reason: "after_prompt" }
  if (context.issued) return { outcome: "failed", reason: "request_failed" }
  return undefined
}

/** The thrown value's name as the vocabulary lists it; `other` for a non-object or an unlisted name. */
export function passkeyErrorNameFor(error: unknown): PasskeyErrorName {
  if (typeof error !== "object" || error === null) return "other"
  return listed(PASSKEY_ERROR_NAMES, nameOf(error), "other")
}

export function elapsedBucketFor(ms: number): PasskeyElapsed {
  if (ms < 1_000) return "under_1s"
  if (ms < 10_000) return "1_10s"
  if (ms < 60_000) return "10_60s"
  return "over_60s"
}

const PHONE_REACH_VALUES: Readonly<Record<PhoneReach, PasskeyPhoneReach | undefined>> = {
  "ok": "ok",
  "no-hybrid": "no_hybrid",
  "unknown": "unknown",
  "below-floor": undefined,
}

/** The check's answer as sent; a below-floor browser is refused, and its reason already says so. */
export const phoneReachFor = (reach: PhoneReach): PasskeyPhoneReach | undefined =>
  Object.hasOwn(PHONE_REACH_VALUES, reach) ? PHONE_REACH_VALUES[reach] : undefined

export const promptsBucketFor = (count: number): PasskeyPrompts =>
  count >= 2 ? "2+" : count >= 1 ? "1" : "0"

export const attemptBucketFor = (count: number): PasskeyAttempt =>
  count >= 3 ? "3+" : count >= 2 ? "2" : "1"

/** The environment and the provider of the credential the latest request targeted. */
export type PasskeyTelemetrySnapshot = {
  posture: DevicePosture
  userAgent: UserAgentInfo
  provider: PasskeyProvider
  aaguid?: string
}

/** The `env` object an error report carries. */
export type PasskeyReportEnv = PasskeyEnvironmentProps & {
  provider: PasskeyProvider
  aaguid?: string
}

/** Names an `other` provider by its AAGUID, the only way triage can tell which one it was. */
export function passkeyReportEnvFor(snapshot: PasskeyTelemetrySnapshot): PasskeyReportEnv {
  const provider = listed(PASSKEY_PROVIDERS, snapshot.provider, "unknown")
  const aaguid = snapshot.aaguid?.toLowerCase()
  return {
    ...passkeyEnvironmentPropsFor(snapshot),
    provider,
    ...(provider === "other" && providerSlugFor(aaguid) === "other" ? { aaguid } : {}),
  }
}

import type { PrfSlot } from "@obsidion/core/types"
import type {
  PasskeyAnswerEvidence,
  PasskeyAssertResult,
  PasskeyAttachment,
  PasskeyCreateResult,
  PasskeyHint,
} from "../ceremony/passkeyCeremony.js"
import { preferredSlot } from "./evidence.js"
import { providerAllowed, providerNameFor, providerSlugFor } from "./passkeyProviders.js"
import type { PasskeyProvider } from "../telemetry/passkeyTelemetryVocabulary.js"
import { type OsFamily, type UserAgentInfo, windowsReleaseFromHints } from "../browser/userAgentInfo.js"

/**
 * Which passkeys may become a backup passkey. A backup's PRF opens an envelope holding the master
 * key, so it only has to give the same PRF back to the same manager later. The first passkey's
 * backup-flag, route and slot gates do not apply: a device-bound or laptop-local backup is fine.
 * What does apply is a PRF on this device, carried by a response that says the user was verified.
 */

export type BackupCandidateProvider = "windows_hello" | "proton_pass" | "samsung_pass"

/**
 * A manager admitted only after a create-then-get measurement of the wallet's backup request passes,
 * and only for an answer from this device's own manager on the OS families that measurement covers.
 */
export type BackupCandidate = { osFamilies: readonly OsFamily[]; measured: boolean }

export type BackupCandidates = Readonly<Record<BackupCandidateProvider, BackupCandidate>>

/** Set a candidate's `measured` to true once its measurement passes. */
export const BACKUP_CANDIDATES: BackupCandidates = {
  // Measured in Chrome 155 on Windows 11 (2026-10-23): its hardware authenticator returned the PRF
  // at creation, user-verified, and a read naming the passkey returned the same value.
  windows_hello: { osFamilies: ["windows"], measured: true },
  // Measured with its browser extension in Chrome 155 on macOS 26.4.1 and its Android app in Chrome
  // 155 on Android 16 (2026-10-22), admitted everywhere but iOS, where its app returns no PRF.
  proton_pass: {
    osFamilies: ["macos", "windows", "linux", "chromeos", "android", "unknown"],
    measured: true,
  },
  // Measured in Chrome 155 on Android 17, a Galaxy SM-F971B (2026-10-22): PRF on the read after
  // creation, and the same pair on a read naming the passkey.
  samsung_pass: { osFamilies: ["android"], measured: true },
}

/** This device's own manager, then a security key; never another phone over QR. */
export const BACKUP_CREATION_HINTS: readonly PasskeyHint[] = ["client-device", "security-key"]

const WINDOWS_10_BACKUP_WARNING =
  "On Windows 10, Windows Hello can't hold a backup passkey. Use a security key, Google Password " +
  "Manager in Chrome, or 1Password."

/**
 * The line an add screen shows before the passkey window opens where Client Hints say Windows 10,
 * whose Windows Hello returns no key material and cannot be hidden from the window. Nothing while
 * Windows Hello is not an admitted candidate, since the provider gate refuses it anyway.
 */
export function windowsHelloBackupWarning(
  info: Pick<UserAgentInfo, "osFamily" | "osVersionReported" | "osVersionFromHints">,
  options: Pick<BackupAdmissionOptions, "candidates"> = {},
): string | undefined {
  if (windowsReleaseFromHints(info) !== "10") return undefined
  const candidates = options.candidates ?? BACKUP_CANDIDATES
  return candidates.windows_hello.measured ? WINDOWS_10_BACKUP_WARNING : undefined
}

export type BackupAnswer = {
  /** The id the creation reported; an absent or all-zero id passes, as for the first passkey. */
  aaguid: string | undefined
  securityKey: boolean
  attachment: PasskeyAttachment | undefined
  /** The requesting browser's OS. */
  osFamily: OsFamily
}

export type BackupAdmissionOptions = {
  /** Provider ids admitted beyond the measured set; a test seam, and empty in production. */
  extraProviders?: readonly string[]
  /** A test seam; production reads `BACKUP_CANDIDATES`. */
  candidates?: BackupCandidates
}

/** Whether the provider that answered may hold a backup passkey. */
export function backupProviderAllowed(
  answer: BackupAnswer,
  options: BackupAdmissionOptions = {},
): boolean {
  const slug = providerSlugFor(answer.aaguid)
  // A security key passes unless its id names a passkey manager; `other` covers some that do.
  if (answer.securityKey) return slug === "yubikey" || providerNameFor(answer.aaguid) === undefined
  if (providerAllowed(answer.aaguid, false, options.extraProviders)) return true
  const candidates = options.candidates ?? BACKUP_CANDIDATES
  if (!Object.hasOwn(candidates, slug)) return false
  const candidate = candidates[slug as BackupCandidateProvider]
  return (
    candidate.measured &&
    answer.attachment === "platform" &&
    candidate.osFamilies.includes(answer.osFamily)
  )
}

const prf32 = (out: Uint8Array | undefined): Uint8Array | undefined =>
  out?.length === 32 ? out : undefined

/**
 * The slot a backup binds to and its value: the route's preferred slot when it holds one, else the
 * other. A one-salt provider is fine here, since the envelope records the slot it used.
 */
export function backupPrfFrom(response: {
  authenticatorAttachment?: PasskeyAttachment
  prfFirst?: Uint8Array
  prfSecond?: Uint8Array
}): { slot: PrfSlot; prfOutput: Uint8Array } | undefined {
  const preferred = preferredSlot(response.authenticatorAttachment)
  const other: PrfSlot = preferred === "first" ? "second" : "first"
  for (const slot of [preferred, other]) {
    const prfOutput = prf32(slot === "first" ? response.prfFirst : response.prfSecond)
    if (prfOutput) return { slot, prfOutput }
  }
  return undefined
}

const UNNAMED: ReadonlySet<PasskeyProvider> = new Set(["unknown", "not_reported"])

/**
 * Whether a backup was saved by the first passkey's manager, for copy that says so. Undefined when
 * either id says nothing. Never true for a security key: two keys of one model share an id.
 */
export function sameBackupManager(
  rootAaguid: string | undefined,
  backup: { aaguid: string | undefined; securityKey: boolean },
): boolean | undefined {
  if (backup.securityKey) return false
  const root = providerSlugFor(rootAaguid)
  const added = providerSlugFor(backup.aaguid)
  if (UNNAMED.has(root) || UNNAMED.has(added)) return undefined
  if (root === "other" && added === "other") {
    return rootAaguid!.toLowerCase() === backup.aaguid!.toLowerCase()
  }
  return root === added
}

/** What backup passkey telemetry reports about the key; never key material. */
export type BackupPasskeyFacts = {
  provider: PasskeyProvider
  /** The lowercased id, only when `provider` is `other`. */
  aaguid?: string
  /** Absent when the backup flag could not be read. */
  deviceBound?: boolean
  /** Creation only: the creation itself returned a PRF. */
  prfAtCreate?: boolean
}

function providerFacts(
  aaguid: string | undefined,
): Pick<BackupPasskeyFacts, "provider" | "aaguid"> {
  const provider = providerSlugFor(aaguid)
  return provider === "other" ? { provider, aaguid: aaguid!.toLowerCase() } : { provider }
}

const deviceBoundFact = (backupEligible: boolean | undefined) =>
  backupEligible === undefined ? {} : { deviceBound: !backupEligible }

/** Facts from a backup's creation, read from the id as attested so zeros read `not_reported`. */
export function backupCreationFacts(created: PasskeyCreateResult): BackupPasskeyFacts {
  return {
    ...providerFacts(created.attestedAaguid),
    ...deviceBoundFact(created.backupEligible),
    prfAtCreate: Boolean(prf32(created.prfFirst) ?? prf32(created.prfSecond)),
  }
}

/** Facts from a creation the browser answered but the wallet could not decode, so no PRF is known. */
export function backupAnswerFacts(
  evidence: Pick<PasskeyAnswerEvidence, "aaguid" | "backupEligible">,
): BackupPasskeyFacts {
  return { ...providerFacts(evidence.aaguid), ...deviceBoundFact(evidence.backupEligible) }
}

/**
 * Facts from a backup sign-in. An assertion carries no provider id, so the provider is the one this
 * browser recorded for the key, if any.
 */
export function backupSignInFacts(
  assertion: Pick<PasskeyAssertResult, "backupEligible">,
  known: { aaguid?: string } = {},
): BackupPasskeyFacts {
  return { ...providerFacts(known.aaguid), ...deviceBoundFact(assertion.backupEligible) }
}

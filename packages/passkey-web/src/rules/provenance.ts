import type { PasskeyAttachment, PasskeyHint } from "../ceremony/passkeyCeremony.js"
import {
  type Chip,
  type CreationContext,
  type HandleOsVersion,
  MAX_VERSION_COMPONENT,
  UNKNOWN_PROVENANCE,
  type UserHandleProvenance,
} from "../ceremony/userHandle.js"
import type { DevicePosture } from "../browser/devicePosture.js"
import type { PasskeyMadeOn } from "../telemetry/passkeyTelemetryVocabulary.js"
import type { UserAgentInfo } from "../browser/userAgentInfo.js"

/**
 * What the creating page writes into a passkey's handle, from what it knows before the prompt
 * opens: the posture, the authenticator class the request asks for, the steer it sends, and the
 * browser's claims about its OS and chip. Nothing here reads the answer.
 */

export type CreationProvenanceInput = {
  posture: DevicePosture
  /** The browser's claims; absent reads as an unknown OS. */
  userAgent?: UserAgentInfo
  /** The authenticator class the create request asks for; `platform` on a laptop is the local route. */
  requested?: PasskeyAttachment
  /** The caller's steer as given: `undefined` the default, `null` suppressed, a list a named route. */
  laptopHints?: readonly PasskeyHint[] | null
}

type LaptopRoute = "local" | "qr" | "key"

/**
 * The route a laptop asked for. Its own class is the local route whatever the steer; otherwise a
 * steer of exactly the security key names the key, the default or a phone steer names QR, and a
 * suppressed steer names nothing: it was removed before the chosen route could be read.
 */
function laptopRouteFor(
  requested: PasskeyAttachment | undefined,
  laptopHints: readonly PasskeyHint[] | null | undefined,
): LaptopRoute | undefined {
  if (requested === "platform") return "local"
  if (laptopHints === null) return undefined
  if (laptopHints?.length === 1 && laptopHints[0] === "security-key") return "key"
  return "qr"
}

const LAPTOP_CONTEXTS: Readonly<
  Record<"mac" | "windows" | "other", Readonly<Record<LaptopRoute, CreationContext>>>
> = {
  mac: { local: "mac_local", qr: "mac_qr", key: "mac_key" },
  windows: { local: "windows_local", qr: "windows_qr", key: "windows_key" },
  other: { local: "laptop_other_local", qr: "laptop_other_qr", key: "laptop_other_key" },
}

const STRICT_VERSION = /^\d+(\.\d+){0,2}$/

/**
 * A version as the handle can carry it: one to three whole numbers, each at most 254. A component
 * the browser left out is unknown; a component above the byte, or any other shape, makes all three
 * unknown.
 */
export function handleOsVersionFor(reported: string): HandleOsVersion {
  if (!STRICT_VERSION.test(reported)) return {}
  const [major, minor, patch] = reported.split(".").map(Number)
  if ([major, minor, patch].some((part) => part !== undefined && part > MAX_VERSION_COMPONENT))
    return {}
  return {
    ...(major !== undefined ? { major } : {}),
    ...(minor !== undefined ? { minor } : {}),
    ...(patch !== undefined ? { patch } : {}),
  }
}

const chipFor = (architecture: string | undefined): Chip =>
  architecture === "arm" || architecture === "x86" ? architecture : "unknown"

/**
 * The version and chip only where the browser's claims came from Client Hints: the user-agent
 * string's version is frozen on a Mac and wrong on an iPhone, and only Chromium reports a chip.
 */
function ownClaimsFor(
  userAgent: UserAgentInfo | undefined,
): Pick<UserHandleProvenance, "osVersion" | "chip"> {
  return {
    osVersion: userAgent?.osVersionFromHints ? handleOsVersionFor(userAgent.osVersionReported) : {},
    chip: chipFor(userAgent?.architectureReported),
  }
}

/**
 * The provenance a creation writes. A phone asks for its own passkey, so its OS, version and chip
 * are the device's own; a laptop's local route is the same; a laptop asking for another device
 * writes that route and no version, since the other device is the one making the passkey.
 */
export function creationProvenanceFor(input: CreationProvenanceInput): UserHandleProvenance {
  const os = input.userAgent?.osFamily ?? "unknown"
  if (input.posture === "phone") {
    const context: CreationContext =
      os === "ios" ? "ios_browser" : os === "android" ? "android_browser" : "phone_other"
    return { context, ...ownClaimsFor(input.userAgent) }
  }
  const route = laptopRouteFor(input.requested, input.laptopHints)
  if (!route) return UNKNOWN_PROVENANCE
  const context =
    LAPTOP_CONTEXTS[os === "macos" ? "mac" : os === "windows" ? "windows" : "other"][route]
  return route === "local"
    ? { context, ...ownClaimsFor(input.userAgent) }
    : { context, osVersion: {}, chip: "unknown" }
}

/** The telemetry value for a handle's provenance: its context, or `unknown` where it carries none. */
export const madeOnFor = (provenance: UserHandleProvenance | undefined): PasskeyMadeOn =>
  provenance?.context ?? "unknown"

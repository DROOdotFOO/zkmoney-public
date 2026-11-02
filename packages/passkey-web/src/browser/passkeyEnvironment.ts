import type { PasskeyAttachment } from "../ceremony/passkeyCeremony.js"
import type { DevicePosture } from "./devicePosture.js"
import { UNKNOWN, currentUserAgentInfo, type UserAgentInfo } from "./userAgentInfo.js"

/**
 * What surrounded the last passkey ceremony: the provider's self-reported id, the class the
 * browser reported on a creation, the OS and browser as they report themselves, and whether the
 * visitor was taken for a phone or a laptop. Kept device-locally under a key the consumer names,
 * for a later reporting step; never sent from here, and never holding a credential id, key
 * material, or an address.
 */
export type PasskeyEnvironment = {
  aaguid: string
  /**
   * As the browser reported them on the creation, before any correction, and kept across the
   * assertion records that follow; records from before these fields carry none.
   */
  attachment?: PasskeyAttachment | typeof UNKNOWN
  transports?: readonly string[]
  osFamily: UserAgentInfo["osFamily"]
  osVersionReported: string
  browserFamily: UserAgentInfo["browserFamily"]
  browserVersionReported: string
  posture: DevicePosture
}

export type PasskeyEnvironmentEvidence = {
  aaguid?: string
  /** Only a creation supplies these; an assertion carries neither. */
  created?: { attachment?: PasskeyAttachment; transports?: readonly string[] }
  posture: DevicePosture
  userAgent: UserAgentInfo
}

const store = () => (typeof localStorage === "undefined" ? undefined : localStorage)

export function buildPasskeyEnvironment(evidence: PasskeyEnvironmentEvidence): PasskeyEnvironment {
  return {
    aaguid: evidence.aaguid ?? UNKNOWN,
    ...(evidence.created
      ? {
          attachment: evidence.created.attachment ?? UNKNOWN,
          transports: evidence.created.transports,
        }
      : {}),
    osFamily: evidence.userAgent.osFamily,
    osVersionReported: evidence.userAgent.osVersionReported,
    browserFamily: evidence.userAgent.browserFamily,
    browserVersionReported: evidence.userAgent.browserVersionReported,
    posture: evidence.posture,
  }
}

/**
 * Replaces the record under `storageKey`. An assertion keeps the creation's fields as long as it
 * does not name a different provider, so a key signing in after an Apple creation does not wear
 * the creation's transports. Never throws: a full or blocked store only loses it.
 */
export async function recordPasskeyEnvironment(
  input: Omit<PasskeyEnvironmentEvidence, "userAgent">,
  storageKey: string,
): Promise<void> {
  try {
    const record = buildPasskeyEnvironment({ ...input, userAgent: await currentUserAgentInfo() })
    const previous = input.created ? null : lastPasskeyEnvironment(storageKey)
    const sameProvider =
      previous !== null &&
      (record.aaguid === UNKNOWN ||
        previous.aaguid === UNKNOWN ||
        record.aaguid === previous.aaguid)
    if (previous && sameProvider) {
      if (previous.attachment !== undefined) record.attachment = previous.attachment
      if (previous.transports !== undefined) record.transports = previous.transports
    }
    store()?.setItem(storageKey, JSON.stringify(record))
  } catch {
    // Collection is best-effort by design.
  }
}

export function lastPasskeyEnvironment(storageKey: string): PasskeyEnvironment | null {
  try {
    const raw = store()?.getItem(storageKey)
    return raw ? (JSON.parse(raw) as PasskeyEnvironment) : null
  } catch {
    return null
  }
}

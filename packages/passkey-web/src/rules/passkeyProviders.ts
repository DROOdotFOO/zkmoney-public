import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  YUBIKEY_5_NFC_AAGUID,
  YUBIKEY_5_SERIES_AAGUID,
  YUBIKEY_5_SERIES_NFC_AAGUID,
  YUBIKEY_5_USB_A_AAGUID,
  YUBIKEY_5_USB_C_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import type { LocalManager } from "./laptopCreation.js"
import type { PasskeyProvider } from "../telemetry/passkeyTelemetryVocabulary.js"

/**
 * Which passkey providers may create a wallet, and what to call the ones that may not.
 *
 * Only providers measured on the routes the wallet uses are admitted, and every other reported id
 * is refused at creation even when it returns key material:
 * how an unmeasured provider derives that material is unknown, and a wallet bound to it may be one
 * no other browser can ever reproduce. A security key is checked against the key set and a phone
 * passkey against the managers, so a class and an id that contradict each other are refused too.
 *
 * An absent or all-zero id passes either check. iCloud reports zeros on iOS and Chromium zeros
 * every security key's, so refusing a missing id would refuse two of the providers we support. The
 * id is self-reported under `attestation: "none"` and is steering, never a security control; the
 * backup, PRF and route gates are what actually defend the account.
 */
export const PASSKEY_MANAGER_AAGUIDS: ReadonlySet<string> = new Set([
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
])

/** The id Chromium's virtual authenticators report, which the wallet's browser-test build admits. */
export const CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID = "01020304-0506-0708-0102-030405060708"

/** The name a refusal gives Windows' own passkey store; its copy is about Windows' prompt. */
export const WINDOWS_HELLO = "Windows Hello"

/** The name a refusal gives Proton Pass; its iPhone app has copy of its own. */
export const PROTON_PASS = "Proton Pass"

/**
 * The providers a refusal might have to name, and the slug telemetry counts each under.
 * Best-effort: an id absent here yields generic copy rather than an invented name.
 */
const PROVIDERS: Readonly<Record<string, { name: string; slug: PasskeyProvider }>> = {
  "adce0002-35bc-c60a-648b-0b25f1f05503": { name: "Chrome", slug: "chrome_profile" },
  // Chromium's profile store on any build without Google branding, named for the commonest one.
  "b5397666-4885-aa6b-cebf-e52262a439a2": { name: "Brave", slug: "other" },
  [APPLE_ICLOUD_AAGUID]: { name: "iCloud Keychain", slug: "icloud_keychain" },
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": {
    name: "iCloud Keychain (managed)",
    slug: "icloud_keychain",
  },
  [GPM_AAGUID]: { name: "Google Password Manager", slug: "google_password_manager" },
  "08987058-cadc-4b81-b6e1-30de50dcbe96": { name: WINDOWS_HELLO, slug: "windows_hello" },
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": { name: WINDOWS_HELLO, slug: "windows_hello" },
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": { name: WINDOWS_HELLO, slug: "windows_hello" },
  [ONEPASSWORD_AAGUID]: { name: "1Password", slug: "1password" },
  "d548826e-79b4-db40-a3d8-11116f7e8349": { name: "Bitwarden", slug: "bitwarden" },
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": { name: "NordPass", slug: "nordpass" },
  [YUBIKEY_5_USB_A_AAGUID]: { name: "YubiKey 5 USB-A", slug: "yubikey" },
  [YUBIKEY_5_USB_C_AAGUID]: { name: "YubiKey 5 USB-C", slug: "yubikey" },
  [YUBIKEY_5_NFC_AAGUID]: { name: "YubiKey 5 NFC", slug: "yubikey" },
  [YUBIKEY_5_SERIES_NFC_AAGUID]: { name: "YubiKey 5 NFC", slug: "yubikey" },
  [YUBIKEY_5_SERIES_AAGUID]: { name: "YubiKey 5 series", slug: "yubikey" },
  "f8a011f3-8c0a-4d15-8006-17111f9edc7d": { name: "Security Key by Yubico", slug: "yubikey" },
  "531126d6-e717-415c-9320-3d9aa6981239": { name: "Dashlane", slug: "dashlane" },
  "50726f74-6f6e-5061-7373-50726f746f6e": { name: PROTON_PASS, slug: "proton_pass" },
  "53414d53-554e-4700-0000-000000000000": { name: "Samsung Pass", slug: "samsung_pass" },
}

/**
 * A provider's name for a refusal message; undefined where naming one would be a guess. Every
 * Yubico id is admitted, so an unlisted one is still named for what it is.
 */
export function providerNameFor(aaguid: string | undefined): string | undefined {
  if (!aaguid) return undefined
  const id = aaguid.toLowerCase()
  if (id === ZERO_AAGUID) return undefined
  if (Object.hasOwn(PROVIDERS, id)) return PROVIDERS[id]!.name
  return SECURITY_KEY_AAGUIDS.has(id) ? "YubiKey" : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The telemetry slug for a reported AAGUID. All zeros is a provider that did not report itself;
 * no id, the stored `unknown` sentinel, or anything that is not a UUID says nothing at all.
 */
export function providerSlugFor(aaguid: string | undefined): PasskeyProvider {
  if (typeof aaguid !== "string") return "unknown"
  const id = aaguid.toLowerCase()
  if (id === ZERO_AAGUID) return "not_reported"
  if (!UUID.test(id)) return "unknown"
  if (SECURITY_KEY_AAGUIDS.has(id)) return "yubikey"
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id]!.slug : "other"
}

/**
 * Which refusal a rejected id deserves. The class decides the gate, but the copy follows the id:
 * a browser that named a security key while withholding its transports is classed as a phone, and
 * telling that user which managers work sends them nowhere. They are holding a key, so the key's
 * wording is the one that helps.
 */
export function refusalKindFor(
  aaguid: string | undefined,
  securityKey: boolean,
): "manager" | "security-key" {
  if (securityKey) return "security-key"
  return aaguid && SECURITY_KEY_AAGUIDS.has(aaguid.toLowerCase()) ? "security-key" : "manager"
}

/**
 * Whether a reported id may create a wallet, judged against the class that answered. `extra`
 * admits ids beyond the measured set and exists for the browser-test build, whose virtual
 * authenticator reports a fixed id; production passes none.
 */
export function providerAllowed(
  aaguid: string | undefined,
  securityKey: boolean,
  extra: readonly string[] = [],
): boolean {
  if (!aaguid) return true
  const id = aaguid.toLowerCase()
  if (id === ZERO_AAGUID) return true
  const measured = securityKey ? SECURITY_KEY_AAGUIDS : PASSKEY_MANAGER_AAGUIDS
  if (measured.has(id)) return true
  return extra.some((allowed) => allowed.toLowerCase() === id)
}

/** The id each manager a laptop may create on reports. */
export const LOCAL_MANAGER_AAGUIDS: Readonly<Record<LocalManager, string>> = {
  "apple": APPLE_ICLOUD_AAGUID,
  "gpm": GPM_AAGUID,
  "1password": ONEPASSWORD_AAGUID,
}

/** What the copy calls each of them, with what Google Password Manager needs first. */
export const LOCAL_MANAGER_NAMES: Readonly<Record<LocalManager, string>> = {
  "apple": "Apple Passwords",
  "gpm": "Google Password Manager (sign in to Chrome first)",
  "1password": "1Password",
}

/** "Apple Passwords or Google Password Manager (sign in to Chrome first)", for a sentence. */
export function localManagersClause(managers: readonly LocalManager[]): string {
  const names = managers.map((m) => LOCAL_MANAGER_NAMES[m])
  if (names.length <= 1) return names[0] ?? "a supported password manager"
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`
}

/** The manager a laptop may create on that reports this id, when one does. */
export function localManagerFor(aaguid: string | undefined): LocalManager | undefined {
  const id = aaguid?.toLowerCase()
  return (Object.keys(LOCAL_MANAGER_AAGUIDS) as LocalManager[]).find(
    (m) => LOCAL_MANAGER_AAGUIDS[m] === id,
  )
}

export type LocalProviderVerdict = "admitted" | "apple" | "unnamed" | "unsupported"

/**
 * Whether a laptop's own passkey may create a wallet, judged after `providerAllowed` admitted the
 * id. Unlike the provider gate, this one is an allowlist and refuses a missing id: on this route
 * a zero id can be a manager whose local cell no other device reproduces, and nothing else
 * defends the binding. `managers` is the row's list; `extra` is the browser-test seam.
 */
export function localProviderVerdict(
  aaguid: string | undefined,
  managers: readonly LocalManager[],
  extra: readonly string[] = [],
): LocalProviderVerdict {
  if (!aaguid) return "unnamed"
  const id = aaguid.toLowerCase()
  if (id === ZERO_AAGUID) return "unnamed"
  if (extra.some((allowed) => allowed.toLowerCase() === id)) return "admitted"
  const manager = localManagerFor(id)
  if (manager && managers.includes(manager)) return "admitted"
  return manager === "apple" ? "apple" : "unsupported"
}

import { ZERO_AAGUID } from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"
import type {
  PasskeyAttachment,
  PasskeyHint,
  PasskeyResidentKey,
} from "../ceremony/passkeyCeremony.js"
import type { DevicePosture } from "../browser/devicePosture.js"
import type { LocalManager } from "./laptopCreation.js"
import { providerNameFor } from "./passkeyProviders.js"
import {
  LaptopPasskeyRefusedError,
  LocalPasskeyRequiredError,
  PhoneRequiredError,
  SecurityKeyRequiredError,
} from "../refusals/passkeyErrors.js"

export type { PrfSlot }

/** Local reads land the account's value in `second`, cross-device reads in `first` (the route table). */
export const slotForAttachment = (attachment: PasskeyAttachment): PrfSlot =>
  attachment === "platform" ? "second" : "first"

/** How a roaming hardware key is reached. A phone over QR reports `hybrid` instead. */
const PHYSICAL_TRANSPORTS: readonly string[] = ["usb", "nfc", "ble", "smart-card"]

/** A non-empty list naming only physical transports: the shape a hardware key's creation reports. */
export const isPhysicalOnly = (transports: readonly string[] | undefined): boolean =>
  Boolean(transports?.length) && transports!.every((t) => PHYSICAL_TRANSPORTS.includes(t))

/**
 * A security key: another device's authenticator that the browser says is reached only over a
 * physical transport, or one it lists no transports for while attesting an all-zero provider id.
 * The second shape is what Chrome reports for a Trezor under "none" attestation — a compatibility
 * heuristic bounded by the browsers measured, not a guarantee the spec gives. Everything else is
 * treated as a phone — a list naming a transport this code does not know, no list at all, an empty
 * list beside a reported id, or a local answer — so a key the browser described poorly meets the
 * backup gate and is refused rather than quietly exempted.
 */
export function isSecurityKey(response: {
  authenticatorAttachment?: PasskeyAttachment
  // Required key, possibly-undefined value: only a creation response carries transports, and an
  // assertion passed here would silently answer "not a key" on a route that holds one.
  transports: readonly string[] | undefined
  /** The id as attested, zeros included; `aaguid` drops zeros and cannot tell them from absent. */
  attestedAaguid?: string
}): boolean {
  if (response.authenticatorAttachment !== "cross-platform") return false
  if (isPhysicalOnly(response.transports)) return true
  return response.transports?.length === 0 && response.attestedAaguid === ZERO_AAGUID
}

/**
 * What a consumer key is asked over when nothing was recorded for it. Never `ble`: Chrome reads
 * it as the phone route and opens its picker again.
 */
const IMPLIED_KEY_TRANSPORTS: readonly string[] = ["usb", "nfc", "smart-card"]

/**
 * The transports an assertion implies for its authenticator, when it implies any. An assertion
 * names none, but creation admits only a synced passkey or a security key, so another device's
 * answer that cannot be backed up is a key.
 */
export function impliedKeyTransports(evidence: {
  authenticatorAttachment?: PasskeyAttachment
  backupEligible?: boolean
}): readonly string[] | undefined {
  const key =
    evidence.authenticatorAttachment === "cross-platform" && evidence.backupEligible === false
  return key ? IMPLIED_KEY_TRANSPORTS : undefined
}

/**
 * The class a creation must be answered by. A laptop is sent to another device, unless the
 * consumer opened the laptop's own route (`local`), where only its own passkey will do. A phone
 * keeps its own passkey. A security key answering anywhere is held to what it is — hardware held
 * against the phone is not the delegation to another phone the rule exists to prevent.
 */
const expectedAtCreation = (
  posture: DevicePosture,
  securityKey: boolean,
  local: boolean,
): PasskeyAttachment => {
  if (securityKey) return "cross-platform"
  if (posture !== "laptop") return "platform"
  return local ? "platform" : "cross-platform"
}

/**
 * The route rule for a creation, applied to the create response and again to the chained assertion
 * that follows it. Both are held to the same class, so a ceremony cannot start as one thing and
 * finish as another; the assertion carries no transports of its own, so `securityKey` is the class
 * the creation established.
 *
 * An unreported attachment refuses on either posture. Nothing downstream may pick a slot from a
 * route the browser declined to name.
 *
 * `providerName` is what answered, for a laptop refusal to name; it is dropped unless the browser
 * reported this device, since an unreported answer says nothing about where the passkey went.
 * `localManagers` marks the laptop's own route and names the managers its refusals offer: there a
 * `cross-platform` answer that is not a key can only be an extension relabelling an in-page
 * answer, whose salts were never hashed by the browser. `advice` follows a laptop's refusal on the
 * phone and key routes.
 */
export function checkCreationRoute(
  posture: DevicePosture,
  attachment: PasskeyAttachment | undefined,
  securityKey: boolean,
  providerName?: string,
  localManagers?: readonly LocalManager[],
  advice?: string,
): void {
  const local = localManagers !== undefined
  if (attachment === expectedAtCreation(posture, securityKey, local)) return
  // Each refusal names the device this ceremony was already using: the key it started on, this
  // phone's own passkey, the phone a laptop is waiting for, or the managers its own route admits.
  if (securityKey) throw new SecurityKeyRequiredError()
  if (posture === "phone") throw new LocalPasskeyRequiredError()
  if (localManagers) {
    if (attachment === "cross-platform") {
      throw new LaptopPasskeyRefusedError("not-local", localManagers)
    }
    throw new PhoneRequiredError({ localManagers })
  }
  throw new PhoneRequiredError({
    ceremony: "create",
    providerName: attachment === "platform" ? providerName : undefined,
    advice,
  })
}

/** The route rule for a sign-in: a laptop still needs another device, a phone takes any answer. */
export function checkAssertionRoute(
  posture: DevicePosture,
  attachment: PasskeyAttachment | undefined,
  localAllowed = false,
): void {
  if (posture !== "laptop") return
  if (attachment === "cross-platform") return
  // The device's own passkey is admitted only when the caller opted in; an unreported attachment
  // is refused either way, so nothing downstream picks a slot from a route the browser did not name.
  if (localAllowed && attachment === "platform") return
  throw new PhoneRequiredError()
}

/**
 * The class a creation asks the browser for. A laptop asks for another device outright, or for
 * its own on the local route. A phone asks for nothing, so its sheet can offer both its own
 * passkey and a security key; the route check above is what holds the answer to one of those two.
 */
export const requestedAttachment = (
  posture: DevicePosture,
  local = false,
): PasskeyAttachment | undefined => {
  if (posture !== "laptop") return undefined
  return local ? "platform" : "cross-platform"
}

const LAPTOP_CREATION_WAIT_MS = 300_000

/**
 * The timeout a creation request names. A laptop sending the user to a phone gets five minutes:
 * fetching it, scanning the QR code and unlocking it outlasts the ceremony's default. A phone, and
 * a laptop creating on its own manager, name none and keep that default.
 */
export const creationTimeoutMs = (posture: DevicePosture, local = false): number | undefined =>
  posture === "laptop" && !local ? LAPTOP_CREATION_WAIT_MS : undefined

/** The device's own authenticator, as a transport list names it. */
const LOCAL_TRANSPORT = "internal"

/** Every route a laptop accepts: a phone over QR, or a hardware key on any physical transport. */
const CROSS_DEVICE_TRANSPORTS: readonly string[] = ["hybrid", ...PHYSICAL_TRANSPORTS]

/**
 * The transports a ceremony may offer for a recorded credential. When the local route is not
 * allowed a laptop never offers the device's own: the route rule refuses an answer from it, so the
 * copy synced to this computer would sit at the top of the browser's list as a dead end. A record
 * that names nothing else — no transports at all, or only `internal` — falls back to the
 * cross-device set rather than to nothing, because an empty list is what lets the browser hand the
 * ceremony to that synced copy anyway. With `localAllowed`, a laptop sends only a physical-only
 * list — a hardware key's, which names no synced copy to hide — and otherwise no restriction: a
 * synced passkey's record can name only `hybrid`, and sending it would exclude `internal` and hide
 * the very copy the user picked. Transaction signing applies the same rule.
 */
export function offerableTransports(
  posture: DevicePosture,
  transports?: readonly string[],
  localAllowed = false,
): readonly string[] | undefined {
  if (posture !== "laptop") return transports?.length ? transports : undefined
  if (localAllowed) return isPhysicalOnly(transports) ? transports : undefined
  const offered = transports?.filter((t) => t !== LOCAL_TRANSPORT) ?? []
  return offered.length ? offered : CROSS_DEVICE_TRANSPORTS
}

/**
 * Name a security key after the route the consumer asked for. A password manager's browser
 * extension reads a request's hints to decide whether to take it over, and 1Password's stands aside
 * only when a security key is named; otherwise it answers a laptop's QR route from its synced copy,
 * which the route rule then refuses. The browser opens its sheet on the first hint, so the
 * consumer's route still comes first.
 */
const namingSecurityKey = (hints: readonly PasskeyHint[]): readonly PasskeyHint[] =>
  hints.includes("security-key") ? hints : [...hints, "security-key"]

/** The two classes a phone creation admits, named so its sheet opens on them rather than on QR. */
const PHONE_CREATION_HINTS: readonly PasskeyHint[] = ["client-device", "security-key"]

/** A laptop creation whose consumer names no route: the phone over QR first, then a key. */
export const LAPTOP_CREATION_HINTS: readonly PasskeyHint[] = ["hybrid", "security-key"]

/**
 * Steering to this computer that names no security key, so a password manager's extension may
 * answer: a local sign-in's, which names one beside it only for a credential the consumer knows to
 * be a hardware key, and a local creation's when the consumer wants the extension.
 */
export const LAPTOP_LOCAL_HINTS: readonly PasskeyHint[] = ["client-device"]

/** A local creation whose consumer names no hints: this computer first, then a security key. */
export const LAPTOP_LOCAL_CREATION_HINTS: readonly PasskeyHint[] = ["client-device", "security-key"]

/**
 * Steering for a creation. A laptop leads with the route its consumer names, the phone when it
 * names none, and always names a security key. On its own route (`local`) it sends the consumer's
 * hints as given, else this computer and a security key, so 1Password's extension stands aside for
 * the browser's own managers; a consumer that wants the extension passes `client-device` alone.
 * `null` sends nothing. A phone names its own passkey and a security key — the two classes the
 * route rule admits — and never `hybrid`, which it would refuse. Steering is advisory: the route
 * rule is what enforces this.
 */
export function creationHintsFor(
  posture: DevicePosture,
  laptopHints?: readonly PasskeyHint[] | null,
  local = false,
): readonly PasskeyHint[] | undefined {
  if (posture !== "laptop") return PHONE_CREATION_HINTS
  if (laptopHints === null) return undefined
  if (local) return laptopHints?.length ? laptopHints : LAPTOP_LOCAL_CREATION_HINTS
  return laptopHints?.length ? namingSecurityKey(laptopHints) : LAPTOP_CREATION_HINTS
}

/**
 * Whether a creation may leave the passkey unstored. A laptop creation that names a security key
 * asks `"preferred"`: a Ledger stores no passkey and refuses a creation that demands one, while a
 * YubiKey, a Trezor, a phone and a password manager store theirs whatever is asked. A phone's
 * hints name a key too, but a Ledger is admitted from a laptop only, and a laptop route that names
 * no key is a manager's: both keep `"required"`.
 */
export function residentKeyFor(
  posture: DevicePosture,
  hints: readonly PasskeyHint[] | undefined,
): PasskeyResidentKey {
  return posture === "laptop" && hints?.includes("security-key") ? "preferred" : "required"
}

/** The two routes a laptop sign-in accepts when the device's own copy is not admitted. */
const LAPTOP_SIGN_IN_HINTS: readonly PasskeyHint[] = ["hybrid", "security-key"]

/** Every route a laptop sign-in admitting its own copy accepts, this computer first. */
export const EVERY_SIGN_IN_ROUTE: readonly PasskeyHint[] = [
  "client-device",
  "hybrid",
  "security-key",
]

/**
 * The routes a chosen key's recorded transports name, in `EVERY_SIGN_IN_ROUTE` order: a record's
 * list is sorted, and `hybrid` first would open a synced passkey's sheet on the QR code. Every
 * route when nothing is recorded, or nothing recorded names a route.
 */
export function chosenKeyHints(transports?: readonly string[]): readonly PasskeyHint[] {
  const routes = new Set((transports ?? []).map(routeOf))
  const named = EVERY_SIGN_IN_ROUTE.filter((hint) => routes.has(hint))
  return named.length ? named : EVERY_SIGN_IN_ROUTE
}

const routeOf = (transport: string): PasskeyHint | undefined => {
  if (transport === LOCAL_TRANSPORT) return "client-device"
  if (transport === "hybrid") return "hybrid"
  return PHYSICAL_TRANSPORTS.includes(transport) ? "security-key" : undefined
}

/**
 * Steering for a sign-in. Without `localAllowed` a laptop names the two cross-device routes it
 * accepts, because `checkAssertionRoute` refuses a local answer there — both, since `hybrid` alone
 * risks a sheet that hides the security-key option. With `localAllowed` it opens on this computer,
 * naming a security key only when `securityKey` says the credential is one. A key the user chose
 * (`chosen`) is the request's only credential, so its hints name the routes its record names, and
 * every route when this browser has no record: one class must not hide the others. A consumer's
 * own hints still win, and `null` still sends none.
 *
 * A phone sends none. Its sign-in legitimately accepts another phone over QR, so steering there
 * would push those users off the route they need.
 */
export function signInHintsFor(
  posture: DevicePosture,
  laptopHints?: readonly PasskeyHint[] | null,
  localAllowed = false,
  securityKey = false,
  chosen?: { transports?: readonly string[] },
): readonly PasskeyHint[] | undefined {
  if (posture !== "laptop" || laptopHints === null) return undefined
  if (laptopHints?.length) return namingSecurityKey(laptopHints)
  if (!localAllowed) return LAPTOP_SIGN_IN_HINTS
  if (chosen) return chosenKeyHints(chosen.transports)
  return securityKey ? namingSecurityKey(LAPTOP_LOCAL_HINTS) : LAPTOP_LOCAL_HINTS
}

/** One of an account's keys, as a sign-in names it. */
export type AccountKey = {
  credentialId: string
  /** Opens the wallet through its envelope; the sign-up key derives it. */
  backup: boolean
  /** The provider this browser recorded for the key, when it holds a record. */
  aaguid?: string
  /** When this browser last opened the wallet with the key. */
  usedAt?: number
}

/**
 * One option of a sign-in's key choice. `provider` is set only where this browser knows it;
 * `lastUsed` marks the key this browser last opened the wallet with.
 */
export type SignInKeyChoice = {
  credentialId: string
  label: string
  provider?: string
  lastUsed?: true
}

/**
 * The keys a sign-in asks the user to choose between before any prompt, sign-up key first; none
 * when the account has one key to ask for. Naming every key leaves the browser to pick a route,
 * and on a Mac that is the sign-up key's local manager, behind which a backup is only reached
 * through Cancel. The chain says which key is a backup, not which provider holds it. Either key
 * opens the same wallet, so the guide is the one this browser last used, not the role.
 */
export function signInKeyChoices(keys: readonly AccountKey[]): SignInKeyChoice[] | undefined {
  // L1 may list a key twice; its first entry stands.
  const byId = new Map<string, AccountKey>()
  for (const key of keys) if (!byId.has(key.credentialId)) byId.set(key.credentialId, key)
  const unique = [...byId.values()]
  if (unique.length < 2) return undefined
  const lastUsed = unique.reduce<AccountKey | undefined>(
    (latest, k) => (k.usedAt !== undefined && k.usedAt > (latest?.usedAt ?? -1) ? k : latest),
    undefined,
  )
  const choice = (key: AccountKey, label: string): SignInKeyChoice => {
    const provider = providerNameFor(key.aaguid)
    return {
      credentialId: key.credentialId,
      label,
      ...(provider ? { provider } : {}),
      ...(key === lastUsed ? { lastUsed: true as const } : {}),
    }
  }
  const backups = unique.filter((k) => k.backup)
  return [
    ...unique.filter((k) => !k.backup).map((k) => choice(k, "Sign-up passkey")),
    ...backups.map((k, i) =>
      choice(k, backups.length > 1 ? `Backup passkey ${i + 1}` : "Backup passkey"),
    ),
  ]
}

import type { LocalManager } from "../rules/laptopCreation.js"
import { PROTON_PASS, WINDOWS_HELLO, localManagersClause } from "../rules/passkeyProviders.js"
import {
  MACOS_APPLE_PRF_FLOOR,
  type UserAgentInfo,
  windowsReleaseFromHints,
} from "../browser/userAgentInfo.js"

/**
 * Typed refusals from the passkey policy. Each carries a plain-language message the screens can
 * show as-is and a stable `name` the screens and tests can branch on.
 */

import { IOS_FLOOR_COPY, MAC_BROWSER_FLOOR_COPY } from "./refusalCopy.js"

/** Every refusal the passkey policy raises; a screen stays put and offers a retry on one. */
export class PasskeyPolicyError extends Error {}

/**
 * The managers the laptop's own route admits, carried by a refusal raised on that route so its
 * copy names those and the phone instead of the phone-route list.
 */
export type LocalRouteOptions = { localManagers?: readonly LocalManager[] }

/** A line added after the message, saying how to keep what answered out of the next attempt. */
type Advice = { advice?: string }

const withAdvice = (message: string, advice?: string): string =>
  advice ? `${message} ${advice}` : message

/** "Try again and choose X or Y, or use your phone instead."; with no manager left, the phone. */
const tryAgainLocally = (managers: readonly LocalManager[]): string =>
  managers.length
    ? `Try again and choose ${localManagersClause(managers)}, or use your phone instead.`
    : "Use your phone instead."

/**
 * A ceremony that began on a security key was answered by something else. Sending this user to a
 * phone or a QR code would be wrong twice over: they are holding the right device, and on a phone
 * that route is refused anyway.
 */
export class SecurityKeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super("Use the same security key you started with, and keep it in place until it finishes.")
    this.name = "SecurityKeyRequiredError"
  }
}

/**
 * A laptop ceremony answered from the laptop's own passkey instead of another device. A sign-up
 * whose answering provider is known names it, so the retry can get past that provider's offer; an
 * unnamed sign-up is told where to create the passkey, since it has none yet.
 */
export class PhoneRequiredError extends PasskeyPolicyError {
  readonly providerName?: string

  constructor(
    options: { providerName?: string; ceremony?: "create" | "sign-in" } & LocalRouteOptions &
      Advice = {},
  ) {
    super(
      withAdvice(
        options.localManagers
          ? "The browser didn't say where that passkey was saved. " +
              tryAgainLocally(options.localManagers)
          : phoneRequiredMessage(options.providerName, options.ceremony ?? "sign-in"),
        options.advice,
      ),
    )
    this.providerName = options.providerName
    this.name = "PhoneRequiredError"
  }
}

function phoneRequiredMessage(
  providerName: string | undefined,
  ceremony: "create" | "sign-in",
): string {
  if (providerName === WINDOWS_HELLO) {
    return (
      "Windows Hello saved this passkey on this computer, but a sign-up here needs a phone over a " +
      "QR code, or a security key. When you try again and Windows offers to save it with Windows " +
      "Hello, choose another way to save it, then pick your phone or a security key."
    )
  }
  // "This device", not "this computer": a phone in desktop mode also counts as a laptop.
  if (providerName) {
    return (
      `${providerName} saved this passkey on this device, but a sign-up here needs a phone over a ` +
      `QR code, or a security key. When you try again, skip ${providerName}'s offer on this ` +
      "device. If a QR code appears, scan it with your phone. Or use your security key."
    )
  }
  if (ceremony === "create") {
    return (
      "To sign up on this computer, create your passkey on your phone or a security key. When you " +
      "try again, skip any offer from a password manager on this computer. If a QR code appears, " +
      "scan it with your phone. Or use your security key."
    )
  }
  return "Scan the QR code with the phone that holds your passkey, or plug in your security key."
}

/** A phone creation was handed to another phone over QR instead of answering on this device. */
export class LocalPasskeyRequiredError extends PasskeyPolicyError {
  constructor() {
    super(
      "Use this phone's own passkey, or a security key you can plug in or tap — not another phone.",
    )
    this.name = "LocalPasskeyRequiredError"
  }
}

/** The passkey is device-bound (or its backup flag could not be read), so no other device could ever open the wallet. */
export class DeviceBoundPasskeyError extends PasskeyPolicyError {
  constructor(options: LocalRouteOptions = {}) {
    super(
      "This passkey can't be backed up, so it can't protect a wallet. " +
        (options.localManagers
          ? tryAgainLocally(options.localManagers)
          : "Try again with a passkey manager that syncs, such as iCloud Keychain or Google " +
            "Password Manager."),
    )
    this.name = "DeviceBoundPasskeyError"
  }
}

/**
 * A laptop's own passkey the local route cannot keep: saved in Apple Passwords where it gives no
 * key or is not admitted (`apple`), by a manager that withheld its id (`unnamed`), or not by a
 * manager on this computer at all (`not-local`, an extension relabelling its in-page answer).
 * Each names the managers the row admits and the phone.
 */
export type LaptopRefusalKind = "apple" | "unnamed" | "not-local"

export class LaptopPasskeyRefusedError extends PasskeyPolicyError {
  /**
   * Apple Passwords refused on this computer, rather than withdrawn from the row: the card leads
   * with the phone and links the docs entry that explains it.
   */
  readonly appleRefusedHere: boolean

  constructor(
    readonly kind: LaptopRefusalKind,
    readonly managers: readonly LocalManager[] = [],
    options: { appleWithdrawn?: boolean } = {},
  ) {
    super(
      `${laptopRefusalLead(kind, options.appleWithdrawn === true)} ${tryAgainLocally(managers)}`,
    )
    this.name = "LaptopPasskeyRefusedError"
    this.appleRefusedHere = kind === "apple" && options.appleWithdrawn !== true
  }
}

function laptopRefusalLead(kind: LaptopRefusalKind, appleWithdrawn: boolean): string {
  if (kind === "apple") {
    return appleWithdrawn
      ? "Apple Passwords isn't available for a wallet on this browser yet."
      : `Apple Passwords can't protect a wallet on macOS before ${MACOS_APPLE_PRF_FLOOR}. Update ` +
          "macOS to use it."
  }
  if (kind === "unnamed") {
    return "zk.money couldn't tell which passkey manager saved this one, so it can't use it."
  }
  return (
    "The passkey wasn't saved by a password manager on this computer, so zk.money can't use it " +
    "from here."
  )
}

/**
 * A security key answered but returned no key material, on either ceremony. Its own refusal rather
 * than `NoPrfError`, whose advice — pick a different provider in the sheet — means nothing to
 * someone holding a key. Known causes: iOS below 26.4, where a key's key material is unavailable
 * to the browser at all; a YubiKey Bio, which returns nothing; and an Android below the Play
 * Services floor. None is detectable before the credential is written.
 */
export class SecurityKeyNoPrfError extends PasskeyPolicyError {
  constructor() {
    super(
      "Your security key answered, but this device couldn't get the key material a wallet needs. " +
        "On iPhone this needs iOS 26.4 or later, and fingerprint keys aren't supported yet.",
    )
    this.name = "SecurityKeyNoPrfError"
  }
}

/**
 * A creation that could not be finished from what came back: a laptop creation the browser
 * mislabelled, without key material or a backup flag, that is not followed up (`mislabelled`),
 * a follow-up answered by a different passkey than the one just made (`other-credential`), or
 * one on this computer's route, without key material, in a browser whose label for where the
 * answer came from can't be trusted (`unverified`); see the creation driver. Its own refusal: the
 * provider is fine, so neither `NoPrfError` nor `PhoneUnreachableError` tells the truth.
 */
export class IncompleteCreationError extends PasskeyPolicyError {
  constructor(readonly kind: "mislabelled" | "other-credential" | "unverified" = "mislabelled") {
    super(
      kind === "mislabelled"
        ? "This browser didn't return everything the wallet needs from your phone. Update Safari " +
            "or use Chrome, then try again."
        : kind === "unverified"
        ? "Browser passkey creation unavailable, please use your mobile instead."
        : "This browser didn't return everything the wallet needs from your new passkey. Try " +
          "again, or use your phone.",
    )
    this.name = "IncompleteCreationError"
  }
}

/** The provider returned no PRF output at creation nor on the follow-up assertion. */
export class NoPrfError extends PasskeyPolicyError {
  /** The laptop manager a creation's answer named; a sign-in names none. */
  readonly manager?: LocalManager

  constructor(options: { manager?: LocalManager } & LocalRouteOptions = {}) {
    super(
      "This passkey provider can't create a wallet key. " +
        (options.localManagers
          ? tryAgainLocally(options.localManagers)
          : "Try again and pick a different passkey provider in the browser's sheet."),
    )
    this.name = "NoPrfError"
    this.manager = options.manager
  }
}

/**
 * The creation response reported a provider outside the measured set. `keyOfferable` names a
 * security key among the alternatives; every sheet the wallet opens can offer one.
 */
export class UnsupportedProviderError extends PasskeyPolicyError {
  readonly providerName?: string

  constructor(
    readonly kind: "manager" | "security-key",
    options: { providerName?: string; keyOfferable?: boolean } & LocalRouteOptions & Advice = {},
  ) {
    super(withAdvice(unsupportedProviderMessage(kind, options), options.advice))
    this.providerName = options.providerName
    this.name = "UnsupportedProviderError"
  }
}

function unsupportedProviderMessage(
  kind: "manager" | "security-key",
  options: { providerName?: string; keyOfferable?: boolean } & LocalRouteOptions,
): string {
  if (kind === "security-key") {
    const lead = "Only YubiKey 5 series, Trezor and Ledger security keys can protect a wallet today."
    if (options.localManagers) return `${lead} ${tryAgainLocally(options.localManagers)}`
    return `${lead} Try again with iCloud Keychain, Google Password Manager, or 1Password.`
  }
  const lead = `${options.providerName ?? "This passkey manager"} can't protect a wallet yet.`
  if (options.localManagers) return `${lead} ${tryAgainLocally(options.localManagers)}`
  return (
    `${lead} Try again with iCloud Keychain, Google Password Manager, or 1Password` +
    `${options.keyOfferable ? ", or a YubiKey 5, Trezor or Ledger security key" : ""}.`
  )
}

/** The provider evaluated only one of the two salts, and not the one this route binds to. */
export class SingleSaltProviderError extends PasskeyPolicyError {
  constructor(options: LocalRouteOptions = {}) {
    super(
      "This passkey provider returned only part of the key material the wallet needs. " +
        (options.localManagers
          ? tryAgainLocally(options.localManagers)
          : "Try again with a different passkey provider."),
    )
    this.name = "SingleSaltProviderError"
  }
}

/** Why a passkey could not become a backup passkey. */
export const BACKUP_REFUSAL_KINDS = [
  "provider",
  "no-prf",
  "key-no-prf",
  "unverified",
  "other-credential",
] as const
export type BackupRefusalKind = (typeof BACKUP_REFUSAL_KINDS)[number]

/** A passkey that cannot be a backup passkey. Screens may branch on `kind` for their own copy. */
export class BackupPasskeyRefusedError extends PasskeyPolicyError {
  readonly providerName?: string

  constructor(
    readonly kind: BackupRefusalKind,
    options: {
      providerName?: string
      userAgent?: UserAgentInfo
      /** A manager this device admits answered from another one; it is told the route, not that it never can. */
      overQr?: boolean
    } = {},
  ) {
    super(backupRefusalMessage(kind, options.providerName, options.userAgent, options.overQr))
    this.providerName = options.providerName
    this.name = "BackupPasskeyRefusedError"
  }
}

/** Windows Hello returns key material only on Windows 11 with the February 2026 update or later. */
function windowsHelloNoPrfMessage(userAgent: UserAgentInfo | undefined): string {
  const lead =
    userAgent && windowsReleaseFromHints(userAgent) === "10"
      ? "Windows Hello on Windows 10 can't make a backup passkey. Try again with a security key, " +
        "Google Password Manager in Chrome, or 1Password."
      : "Windows Hello on this PC didn't give the key a backup needs. It needs Windows 11 with the " +
        "February 2026 update or later. Open Settings > Windows Update, install updates, restart, " +
        "and try again. Or use a security key, Google Password Manager in Chrome, or 1Password."
  return (
    `${lead} If Windows kept a zk.money passkey from this attempt, remove it in Settings > ` +
    "Accounts > Passkeys."
  )
}

function backupRefusalMessage(
  kind: BackupRefusalKind,
  providerName: string | undefined,
  userAgent: UserAgentInfo | undefined,
  overQr: boolean | undefined,
): string {
  switch (kind) {
    case "provider":
      if (providerName === PROTON_PASS && userAgent?.osFamily === "ios") {
        return (
          "Proton Pass's iPhone app can't make a backup passkey: it doesn't return the key a " +
          "backup needs. Try again with iCloud Keychain or 1Password. If Proton Pass kept a " +
          "zk.money passkey from this attempt, delete it in the app."
        )
      }
      if (overQr) {
        return (
          `${providerName ?? "This passkey manager"} can't hold a backup passkey from a phone ` +
          "over QR. Try again with iCloud Keychain, Google Password Manager, or 1Password on " +
          "your phone."
        )
      }
      return (
        `${providerName ?? "This passkey manager"} can't hold a backup passkey yet. Try again ` +
        "with iCloud Keychain, Google Password Manager, 1Password, or a security key."
      )
    case "no-prf":
      if (providerName === WINDOWS_HELLO) return windowsHelloNoPrfMessage(userAgent)
      return (
        `${providerName ?? "This passkey manager"} can't make a backup key on this device. Try ` +
        "again with a different passkey manager, or a security key."
      )
    case "key-no-prf":
      return (
        "Your security key answered, but this device couldn't get the key material a backup " +
        "needs. Try another security key, or this device's passkey manager."
      )
    case "unverified":
      return (
        "The passkey was saved without checking it was you, so it can't be a backup. Try again " +
        "and unlock with your face, fingerprint, or PIN when asked."
      )
    case "other-credential":
      return "A different passkey answered than the one just made. Try again and pick the new one."
  }
}

/** Neither candidate key was named by any anchor: nothing was written. */
export class NoWalletForPasskeyError extends PasskeyPolicyError {
  constructor() {
    super(
      "No wallet was found for this passkey. Open zk.money on the device you signed up on, or " +
        "contact support.",
    )
    this.name = "NoWalletForPasskeyError"
  }
}

/** This browser is below the floor for creating a wallet passkey on a phone. */
export class PhoneUnreachableError extends PasskeyPolicyError {
  constructor() {
    super(MAC_BROWSER_FLOOR_COPY)
    this.name = "PhoneUnreachableError"
  }
}

/** This browser's record says the credential's key was rotated: its PRF never reproduces the account key. */
export class RotatedCredentialError extends PasskeyPolicyError {
  constructor() {
    super(
      "This passkey's key changed, so it no longer opens the wallet. Sign in with the passkey you " +
        "created the wallet with.",
    )
    this.name = "RotatedCredentialError"
  }
}

/** More than one candidate key was anchored: nothing was written. */
export class AmbiguousPasskeyError extends PasskeyPolicyError {
  constructor() {
    super("This passkey matches more than one wallet. Contact support before continuing.")
    this.name = "AmbiguousPasskeyError"
  }
}

/** The browser refused a request for a passkey that belongs to another zk.money site. */
export class RelatedOriginPasskeyError extends PasskeyPolicyError {
  /** Bitwarden's extension sent the refusal. */
  readonly bitwarden: boolean

  constructor(
    cause?: unknown,
    options: { iosBelowFloor?: boolean; bitwarden?: boolean } & Advice = {},
  ) {
    super(
      withAdvice(
        options.iosBelowFloor
          ? IOS_FLOOR_COPY
          : "A browser extension, such as a password manager, may have blocked the passkey request on this site. " +
              "Turn off the extension's passkey option for this site, or use another browser, then try again. " +
              "If it still fails, contact support.",
        options.advice,
      ),
      { cause },
    )
    this.bitwarden = options.bitwarden ?? false
    this.name = "RelatedOriginPasskeyError"
  }
}

export function isPasskeyPolicyError(err: unknown): err is PasskeyPolicyError {
  return err instanceof PasskeyPolicyError
}

const EXTENSION_SCRIPT_RE = /(?:chrome|moz|safari-web)-extension:\/\//

/** A password manager's extension answered the request and failed with a plain `Error` of its own. */
export function isExtensionPasskeyError(err: unknown): boolean {
  try {
    const { name, message, stack } = err as { name?: unknown; message?: unknown; stack?: unknown }
    if (name !== "Error" || typeof stack !== "string") return false
    return EXTENSION_SCRIPT_RE.test(
      typeof message === "string" ? stack.replace(message, "") : stack,
    )
  } catch {
    return false
  }
}

/** The browser's passkey prompt was closed, or timed out, before it answered. Nothing was signed. */
export function isPasskeyCancelled(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === "NotAllowedError" || name === "AbortError"
}

/**
 * Errors thrown after the browser returned a credential: whatever the prompt saved is still there.
 * A side table rather than a property, since the browser's and an extension's errors are not ours.
 */
const written = new WeakSet<object>()

export function markPasskeyWritten<T>(err: T): T {
  if (typeof err === "object" && err !== null) written.add(err)
  return err
}

/** Whether a passkey was written before this error, or before the error it carries as `cause`. */
export function passkeyWritten(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  if (written.has(err)) return true
  const cause = (err as { cause?: unknown }).cause
  return typeof cause === "object" && cause !== null && written.has(cause)
}

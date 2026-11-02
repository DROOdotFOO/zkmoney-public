import type { SignInRoute } from "@obsidion/core/types"
import type { LaptopCreation, LocalManager } from "../rules/laptopCreation.js"
import type { PhoneReach } from "../browser/passkeyCapabilities.js"
import type { PasskeyExtension } from "../telemetry/passkeyTelemetryVocabulary.js"
import { PHONE_STEPS_COPY, SIGN_UP_SHEET_COPY, SUPPORTED_NAMES } from "../refusals/refusalCopy.js"
import type { OsFamily, UserAgentInfo } from "../browser/userAgentInfo.js"

/** Where the user says the passkey will live. */
export type SignUpChoice = "1password" | "computer" | "phone" | "key" | "phone-or-key"

export type KeyWarning = typeof SIGN_UP_SHEET_COPY.keyWarning

export type SignUpOption = {
  id: SignUpChoice
  label: string
  description: string
  advice: readonly string[]
  /** On every option that can reach a key, which keeps the only copy. */
  keyWarning?: KeyWarning
  /** The managers behind this option; an early pick is re-checked against it. */
  supported: readonly string[]
}

/**
 * Why the sheet re-opens after a creation ended with nothing made: the browser's prompt closed, or
 * the browser refused before a prompt could open, once or twice in a row.
 */
export type SheetReopen = "unfinished" | "blocked" | "blocked-again"

export type SignUpSheetLine = {
  kind: "unfinished" | "blocked" | "steered" | "install-extension"
  text: string
}

export type SignUpOptions = {
  options: readonly SignUpOption[]
  selected: SignUpChoice
  line?: SignUpSheetLine
  /** Shown while the chosen option runs, where a script zk.money cannot use answers the page. */
  warning?: string
}

export type SignUpOptionsInput = {
  creation: LaptopCreation
  reach: PhoneReach
  /** Which extension's script answers the page's creation. */
  extension: PasskeyExtension
  /** Refusals on this computer are past the limit while an extension answers. */
  refusedOften: boolean
  /** See `ignoresHintsFor`. */
  ignoresHints: boolean
  /** The user agent's, since a phone-only row has none. */
  os: OsFamily
  /** The option a re-open or an earlier pick asks for. */
  preferred?: SignUpChoice
  /** Set when the sheet re-opens after a creation ended with nothing made. */
  reopened?: SheetReopen
}

const ROUTES: Readonly<Record<SignUpChoice, SignInRoute>> = {
  "1password": "this-device",
  "computer": "this-device",
  "phone": "phone",
  "phone-or-key": "phone",
  "key": "security-key",
}

/** The route an option asks for. The merged option asks for another device. */
export const routeForChoice = (choice: SignUpChoice): SignInRoute => ROUTES[choice]

/**
 * Whether the browser's prompt ignores the request's hints, so phone and key are one option: Safari
 * and Firefox always, and every browser on Windows, where a request to another device goes to
 * Windows' own dialog, which lists both devices whatever was asked.
 */
export const ignoresHintsFor = (ua: UserAgentInfo): boolean =>
  ua.browserFamily === "safari" || ua.browserFamily === "firefox" || ua.osFamily === "windows"

/** Where a preference lands, first offered wins. */
const FALLBACK: Readonly<Record<SignUpChoice, readonly SignUpChoice[]>> = {
  "phone": ["phone", "phone-or-key", "key"],
  "phone-or-key": ["phone-or-key", "phone", "key"],
  "key": ["key", "phone-or-key"],
  "1password": ["1password", "computer"],
  "computer": ["computer", "1password"],
}

const names = (managers: readonly LocalManager[]) => managers.map((m) => SUPPORTED_NAMES[m])
/** "A", "A or B", "A, B or C". */
const either = (xs: readonly string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`

const MANAGER_NAMES: readonly string[] = Object.values(SUPPORTED_NAMES)
const ALL_SUPPORTED = PHONE_STEPS_COPY.supported.providers
/** A phone creation admits every manager; a key is only the key. */
const PHONE_SUPPORTED = ALL_SUPPORTED.filter((p) => MANAGER_NAMES.includes(p))
const KEY_SUPPORTED = ALL_SUPPORTED.filter((p) => !MANAGER_NAMES.includes(p))

const lines = (...xs: (string | false | undefined)[]): string[] =>
  xs.filter((x): x is string => typeof x === "string")

/**
 * The laptop sign-up sheet's picker: where the new passkey may live, in a fixed order (this
 * computer's own first, then another device, the key last), the option it opens on, and at most one
 * line above it. "This computer" names a security key in its hints so 1Password's extension stands
 * aside; "1Password" names none so it answers, and is offered only where the script answering the
 * page is 1Password's. Where the browser ignores hints, phone and key are one option.
 */
export function signUpOptionsFor(input: SignUpOptionsInput): SignUpOptions {
  const { creation, reach, extension, refusedOften, ignoresHints, os, preferred, reopened } = input
  const copy = SIGN_UP_SHEET_COPY
  const localCopy = PHONE_STEPS_COPY.local
  const row = creation.local ? creation : undefined
  const own = row?.managers.filter((m) => m !== "1password") ?? []
  const mac = row?.os === "macos"
  const listsOnePassword = row?.managers.includes("1password") ?? false
  const onePasswordAlone = row !== undefined && own.length === 0
  const script = extension !== "none"
  // A script the page cannot use: any pop-up it opens must be closed.
  const unsupported = extension === "bitwarden" || extension === "other"
  // A row whose extension surface is withdrawn offers 1Password through the Mac's window alone, as
  // a Mac with no extension does; off a Mac its app gives no key.
  const viaExtension = extension === "1password" && !row?.extensionWithdrawn
  // With no 1Password option beside it, This Mac reaches 1Password through the Mac's window.
  const macOnePassword = mac && listsOnePassword && !viaExtension
  const macWindow = macOnePassword && onePasswordAlone
  const offersOnePassword = viaExtension && listsOnePassword
  const phone = reach === "no-hybrid" ? undefined : ignoresHints ? "phone-or-key" : "phone"
  const computerLabel = mac ? copy.computer.macLabel : copy.computer.label
  const crossDevice = script && PHONE_STEPS_COPY.extension
  const windows = os === "windows"

  const options: SignUpOption[] = []
  if (offersOnePassword) {
    options.push({
      id: "1password",
      label: copy.onePassword.label,
      description: copy.onePassword.description,
      advice: [],
      supported: names(["1password"]),
    })
  }
  if (own.length > 0) {
    const managers = names(macOnePassword ? [...own, "1password"] : own)
    options.push({
      id: "computer",
      label: computerLabel,
      description: `${copy.computer.savedIn} ${either(managers)}`,
      advice: lines(
        script ? localCopy.extension : listsOnePassword && !mac && localCopy.installExtension,
        refusedOften && localCopy.refusedOften,
      ),
      supported: managers,
    })
  } else if (macWindow) {
    options.push({
      id: "computer",
      label: computerLabel,
      description: copy.computer.macWindow,
      advice: lines(
        localCopy.pickOnePassword,
        phone && localCopy.noOnePasswordHere,
        unsupported && localCopy.extension,
      ),
      supported: names(["1password"]),
    })
  }
  if (phone === "phone") {
    options.push({
      id: "phone",
      label: copy.phone.label,
      description: copy.phone.description,
      advice: lines(crossDevice),
      supported: PHONE_SUPPORTED,
    })
  } else if (phone === "phone-or-key") {
    options.push({
      id: "phone-or-key",
      label: copy.phoneOrKey.label,
      description: copy.phoneOrKey.description,
      advice: lines(windows && copy.phoneOrKey.windows, crossDevice),
      keyWarning: copy.keyWarning,
      supported: ALL_SUPPORTED,
    })
  }
  if (phone !== "phone-or-key") {
    const noPhone =
      phone === undefined &&
      (options.length === 0 ? PHONE_STEPS_COPY.noPhone.caption : copy.key.noPhone)
    options.push({
      id: "key",
      label: copy.key.label,
      description: copy.key.description,
      advice: lines(noPhone, crossDevice),
      keyWarning: copy.keyWarning,
      supported: KEY_SUPPORTED,
    })
  }

  const first = (choices: readonly SignUpChoice[]) =>
    choices.find((c) => options.some((o) => o.id === c))
  const anotherDevice = first(["phone", "phone-or-key"]) ?? "key"
  // A manager this row can't use keeps answering on this computer: lead elsewhere, unless the
  // user asked for another device or the last creation ended with nothing made.
  const steer =
    refusedOften &&
    row !== undefined &&
    !reopened &&
    (preferred === undefined || preferred === "computer" || preferred === "1password")
  const selected: SignUpChoice = steer
    ? own.length > 0
      ? "computer"
      : anotherDevice
    : (preferred && first(FALLBACK[preferred])) ??
      (offersOnePassword ? "1password" : own.length > 0 ? "computer" : anotherDevice)

  // The re-open line follows the option the sheet opens on, not the one asked for, and offers the
  // phone only where the sheet has one to offer.
  const line: SignUpSheetLine | undefined =
    reopened === "unfinished"
    ? {
        kind: "unfinished",
        text:
          routeForChoice(selected) === "this-device" && first(["phone", "phone-or-key"])
            ? localCopy.unfinished
            : localCopy.unfinishedElsewhere,
      }
    : reopened
    ? {
        kind: "blocked",
        text: reopened === "blocked" ? localCopy.blocked : localCopy.blockedAgain,
      }
    : steer && selected !== "computer"
    ? { kind: "steered", text: localCopy.steered[selected === "key" ? "key" : "phone"] }
    : onePasswordAlone && !mac && !script
    ? { kind: "install-extension", text: localCopy.installExtension }
    : undefined
  return {
    options,
    selected,
    ...(line ? { line } : {}),
    ...(unsupported ? { warning: copy.extensionWarning } : {}),
  }
}

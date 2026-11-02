import type { PhoneReach } from "../browser/passkeyCapabilities.js"
import type { PasskeyExtension } from "../telemetry/passkeyTelemetryVocabulary.js"
import { BACKUP_ADD_SHEET_COPY, PHONE_STEPS_COPY, SIGN_UP_SHEET_COPY } from "../refusals/refusalCopy.js"
import type { OsFamily } from "../browser/userAgentInfo.js"

/** Where the user says the backup passkey will live. */
export type BackupAddChoice = "1password" | "proton" | "computer" | "phone" | "phone-or-key" | "key"

export type BackupKeyWarning = typeof BACKUP_ADD_SHEET_COPY.keyWarning

export type BackupAddOption = {
  id: BackupAddChoice
  label: string
  description: string
  advice: readonly string[]
  /** On every option that can reach a key, which keeps the only copy of the backup. */
  keyWarning?: BackupKeyWarning
}

export type BackupAddOptionsInput = {
  reach: PhoneReach
  /** Which extension's script answers the page's creation. */
  extension: PasskeyExtension
  /** Whether the page-start lock kept Proton Pass's creation wrapper. */
  protonKept: boolean
  /** See `ignoresHintsFor`. */
  ignoresHints: boolean
  os: OsFamily
}

export type BackupAddOptions = {
  options: readonly BackupAddOption[]
  selected: BackupAddChoice
}

const lines = (...xs: (string | false | undefined)[]): string[] =>
  xs.filter((x): x is string => typeof x === "string")

/**
 * The Passkeys sheet's picker for a backup passkey, and the option it opens on. This computer is
 * always offered: a backup has no route rule, admission reads the answer.
 */
export function backupAddOptionsFor(input: BackupAddOptionsInput): BackupAddOptions {
  const { reach, extension, protonKept, ignoresHints, os } = input
  const copy = SIGN_UP_SHEET_COPY
  const own = BACKUP_ADD_SHEET_COPY
  const script = extension !== "none"
  const onePassword = extension === "1password"
  const phone = reach === "no-hybrid" ? undefined : ignoresHints ? "phone-or-key" : "phone"
  const crossDevice = script && PHONE_STEPS_COPY.extension

  const options: BackupAddOption[] = []
  if (onePassword) {
    options.push({
      id: "1password",
      label: copy.onePassword.label,
      description: own.onePassword.description,
      advice: [],
    })
  }
  if (protonKept) {
    options.push({
      id: "proton",
      label: own.proton.label,
      description: own.proton.description,
      advice: [],
    })
  }
  options.push({
    id: "computer",
    label: os === "macos" ? copy.computer.macLabel : copy.computer.label,
    description: own.computer.description,
    advice: lines(script && PHONE_STEPS_COPY.local.extension),
  })
  if (phone === "phone") {
    options.push({
      id: "phone",
      label: copy.phone.label,
      description: copy.phone.description,
      advice: lines(own.phone.managers, crossDevice),
    })
  } else if (phone === "phone-or-key") {
    options.push({
      id: "phone-or-key",
      label: copy.phoneOrKey.label,
      description: copy.phoneOrKey.description,
      advice: lines(own.phone.managers, os === "windows" && copy.phoneOrKey.windows, crossDevice),
      keyWarning: own.keyWarning,
    })
  }
  if (phone !== "phone-or-key") {
    options.push({
      id: "key",
      label: copy.key.label,
      description: copy.key.description,
      advice: lines(phone === undefined && copy.key.noPhone, crossDevice),
      keyWarning: own.keyWarning,
    })
  }
  return { options, selected: onePassword ? "1password" : protonKept ? "proton" : "computer" }
}

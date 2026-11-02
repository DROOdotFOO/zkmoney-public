/**
 * The page-start lock on the browser's own passkey functions: `nativeLockScript()` is the inline
 * script the wallet puts at the top of `<head>`, `nativeLockFor()` reads what it recorded, and
 * `keptPasskeyApiFor()` reads the extension wrapper it kept aside while restoring.
 */

import {
  PASSKEY_NATIVE_LOCKS,
  type PasskeyNativeLock,
} from "../telemetry/passkeyTelemetryVocabulary.js"

/** The browser's own method prints `function NAME() { [native code] }`, whitespace aside. */
export const NATIVE_PRINT_PATTERN = "^function NAME\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$"

export function printsNative(name: string, source: string): boolean {
  return new RegExp(NATIVE_PRINT_PATTERN.replace("NAME", name)).test(source.trim())
}

/** The `globalThis` slot the inline script writes its per-function record to. */
export const NATIVE_LOCK_KEY = "__zkMoneyNativeLock"

/** The `globalThis` slot holding the wrappers the lock kept aside: `{ create?, get? }`, frozen. */
export const KEPT_PASSKEY_API_KEY = "__zkMoneyKeptPasskeyApi"

export type NativeLockCall = "create" | "get"

/**
 * Proton Pass's bridge message names, which its minified Chromium wrappers still print. A
 * restored wrapper carrying the name's marker is kept so the ceremony can route to it: Proton
 * falls through to the browser's own function whenever it cannot answer, which no other
 * measured extension does.
 */
export const KEPT_WRAPPER_MARKERS: Readonly<Record<NativeLockCall, string>> = {
  create: "PASSKEY_CREATE",
  get: "PASSKEY_GET",
}

/** A kept wrapper, called as the browser's own method is. */
export type KeptPasskeyApi = (
  options?: CredentialCreationOptions | CredentialRequestOptions,
) => Promise<Credential | null>

export type NativeLockScope = {
  navigator?: { credentials?: object }
  PublicKeyCredential?: object
  [key: string]: unknown
}

export type NativeLockRecord = Partial<Record<string, PasskeyNativeLock>>

/**
 * Freezes `create`, `get` and the `PublicKeyCredential` probes in place while they are still the
 * browser's own, so a wrapper assigned later cannot replace them. A wrapper already assigned over
 * the prototype's method (Bitwarden's and Proton Pass's page scripts run before any page script on
 * Chromium) is replaced by that method, frozen, when it is still the browser's own and the wrapper
 * is configurable. A replaced wrapper whose source carries the name's marker is kept under
 * `keptKey`, a frozen prototype-free slot published on every page, empty or not, so no later
 * script can plant one. Stringified into the page by `nativeLockScript()`: nothing from this
 * module, no helper, nothing that needs strict mode, and the names are a literal here for that
 * reason.
 */
export function lockNativePasskeyApi(
  scope: NativeLockScope,
  pattern: string,
  key: string,
  keptKey: string,
  markers: Record<string, string>,
): NativeLockRecord {
  const record: NativeLockRecord = {}
  const kept: Record<string, unknown> = Object.create(null)
  try {
    const credentials = scope.navigator && scope.navigator.credentials
    // The instance never owns create or get, so an own value there is a script's. The constructor
    // owns its probes, and its parent Credential carries some of the same names.
    const targets: [object | undefined, string[], boolean][] = [
      [credentials, ["create", "get"], false],
      [
        scope.PublicKeyCredential,
        [
          "isUserVerifyingPlatformAuthenticatorAvailable",
          "isConditionalMediationAvailable",
          "getClientCapabilities",
        ],
        true,
      ],
    ]
    const supported = !!credentials && !!scope.PublicKeyCredential
    const native = (name: string, value: unknown) =>
      typeof value === "function" &&
      new RegExp(pattern.replace("NAME", name)).test(Function.prototype.toString.call(value).trim())
    for (const target of targets) {
      const container = target[0]
      const ownIsTheirs = target[2]
      for (const name of target[1]) {
        if (!supported || !container) {
          record[name] = "unsupported"
          continue
        }
        try {
          const own = Object.getOwnPropertyDescriptor(container, name)
          let accessor = own !== undefined && !("value" in own)
          let inherited: PropertyDescriptor | undefined
          let proto = Object.getPrototypeOf(container)
          while (proto) {
            const found = Object.getOwnPropertyDescriptor(proto, name)
            if (found) {
              if (!("value" in found)) accessor = true
              if (!inherited) inherited = found
            }
            proto = Object.getPrototypeOf(proto)
          }
          // An accessor anywhere on the chain is another script's (1Password's) and stays.
          if (accessor) {
            record[name] = "skipped_accessor"
            continue
          }
          const desc = own || inherited
          if (!desc) continue
          // An own value that is not the prototype's is a script's, whatever it prints (Firefox's
          // exportFunction prints as a named native). The prototype's method goes back over it
          // where it still can.
          if (!ownIsTheirs && own && inherited && inherited.value !== own.value) {
            if (own.configurable && native(name, inherited.value)) {
              Object.defineProperty(container, name, {
                value: inherited.value,
                writable: false,
                configurable: false,
                enumerable: inherited.enumerable,
              })
              record[name] = "restored"
              // Reading the source is best effort: a value that cannot be read is simply not kept.
              try {
                const marker = markers[name]
                if (
                  marker &&
                  new RegExp("\\b" + marker + "\\b").test(
                    Function.prototype.toString.call(own.value),
                  )
                )
                  kept[name] = own.value
              } catch (_error) {
                // Not kept.
              }
            } else {
              record[name] = "lost_race"
            }
            continue
          }
          if (typeof desc.value !== "function") continue
          if (!native(name, desc.value)) {
            record[name] = "lost_race"
            continue
          }
          Object.defineProperty(container, name, {
            value: desc.value,
            writable: false,
            configurable: false,
            enumerable: desc.enumerable,
          })
          record[name] = "applied"
        } catch (_error) {
          record[name] = "lost_race"
        }
      }
    }
  } catch (_error) {
    // The lock never breaks page load.
  }
  // Each slot is published on its own: one refused definition never costs the other.
  try {
    Object.defineProperty(scope, key, {
      value: Object.freeze(record),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch (_error) {
    // Nothing to record it on.
  }
  try {
    Object.defineProperty(scope, keptKey, {
      value: Object.freeze(kept),
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch (_error) {
    // Nothing kept.
  }
  return record
}

/** The inline script: the lock function's own source, run against the page's globals. */
export function nativeLockScript(): string {
  const pattern = JSON.stringify(NATIVE_PRINT_PATTERN)
  const key = JSON.stringify(NATIVE_LOCK_KEY)
  const keptKey = JSON.stringify(KEPT_PASSKEY_API_KEY)
  const markers = JSON.stringify(KEPT_WRAPPER_MARKERS)
  return `(${lockNativePasskeyApi.toString()})(globalThis, ${pattern}, ${key}, ${keptKey}, ${markers})`
}

/**
 * The wrapper the inline script kept aside for `create` or `get`; nothing where the slot is
 * missing, inherited, or holds anything but an own function for the call.
 */
export function keptPasskeyApiFor(call: NativeLockCall): KeptPasskeyApi | undefined {
  try {
    const slot = Object.getOwnPropertyDescriptor(globalThis, KEPT_PASSKEY_API_KEY)
    const kept = slot && "value" in slot ? slot.value : undefined
    if (!kept || typeof kept !== "object") return undefined
    const entry = Object.getOwnPropertyDescriptor(kept, call)
    const value = entry && "value" in entry ? entry.value : undefined
    return typeof value === "function" ? (value as KeptPasskeyApi) : undefined
  } catch {
    return undefined
  }
}

/** What the inline script recorded for `create` or `get`; nothing where the page has no record. */
export function nativeLockFor(call: NativeLockCall): PasskeyNativeLock | undefined {
  try {
    const record = (globalThis as Record<string, unknown>)[NATIVE_LOCK_KEY]
    const value =
      record && typeof record === "object" ? (record as Record<string, unknown>)[call] : undefined
    return (PASSKEY_NATIVE_LOCKS as readonly unknown[]).includes(value)
      ? (value as PasskeyNativeLock)
      : undefined
  } catch {
    return undefined
  }
}

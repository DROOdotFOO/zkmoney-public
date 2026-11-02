import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  YUBIKEY_5_NFC_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import type { PasskeyCreateResult } from "../../src/ceremony/passkeyCeremony.js"
import {
  BACKUP_CANDIDATES,
  BACKUP_CREATION_HINTS,
  type BackupAnswer,
  type BackupCandidates,
  backupAnswerFacts,
  backupCreationFacts,
  backupPrfFrom,
  backupProviderAllowed,
  backupSignInFacts,
  sameBackupManager,
  windowsHelloBackupWarning,
} from "../../src/rules/backupAdmission.js"
import { BackupPasskeyRefusedError } from "../../src/refusals/passkeyErrors.js"
import { type OsFamily, parseUserAgent } from "../../src/browser/userAgentInfo.js"
import { PROTON_PASS as PROTON_PASS_NAME, WINDOWS_HELLO } from "../../src/rules/passkeyProviders.js"

const ICLOUD_MANAGED = "dd4ec289-e01d-41c9-bb89-70fa845d4bf2"
const WINDOWS_HELLO_IDS = [
  "08987058-cadc-4b81-b6e1-30de50dcbe96",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
]
const PROTON_PASS = "50726f74-6f6e-5061-7373-50726f746f6e"
const SAMSUNG_PASS = "53414d53-554e-4700-0000-000000000000"
const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"
const DASHLANE = "531126d6-e717-415c-9320-3d9aa6981239"
const CHROME_PROFILE = "adce0002-35bc-c60a-648b-0b25f1f05503"
const BRAVE = "b5397666-4885-aa6b-cebf-e52262a439a2"
const UNLISTED = "abcdef12-3456-4789-abcd-ef1234567890"

const OS_FAMILIES: readonly OsFamily[] = [
  "ios",
  "macos",
  "android",
  "windows",
  "linux",
  "chromeos",
  "unknown",
]

const answer = (
  aaguid: string | undefined,
  overrides: Partial<BackupAnswer> = {},
): BackupAnswer => ({
  aaguid,
  securityKey: false,
  attachment: "platform",
  osFamily: "macos",
  ...overrides,
})

const prf = (fill: number, length = 32) => new Uint8Array(length).fill(fill)

const created = (overrides: Partial<PasskeyCreateResult> = {}): PasskeyCreateResult => ({
  credentialId: "cred",
  pubkey: new Uint8Array(64),
  transports: undefined,
  userHandle: new Uint8Array(0),
  ...overrides,
})

describe("backupProviderAllowed", () => {
  it("admits the first passkey's managers on any OS, and an absent or all-zero id", () => {
    for (const osFamily of OS_FAMILIES) {
      for (const id of [APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID]) {
        expect(backupProviderAllowed(answer(id, { osFamily }))).toBe(true)
        expect(backupProviderAllowed(answer(id, { osFamily, attachment: "cross-platform" }))).toBe(
          true,
        )
      }
    }
    for (const securityKey of [false, true]) {
      expect(backupProviderAllowed(answer(undefined, { securityKey }))).toBe(true)
      expect(backupProviderAllowed(answer(ZERO_AAGUID, { securityKey }))).toBe(true)
    }
  })

  it("admits any security key whose id names no manager", () => {
    const key = { securityKey: true, attachment: "cross-platform" as const }
    expect(backupProviderAllowed(answer(YUBIKEY_5_NFC_AAGUID, key))).toBe(true)
    expect(backupProviderAllowed(answer(UNLISTED, key))).toBe(true)
    expect(backupProviderAllowed(answer("not-a-uuid", key))).toBe(true)
    expect(backupProviderAllowed(answer("constructor", key))).toBe(true)
    expect(backupProviderAllowed(answer(APPLE_ICLOUD_AAGUID, key))).toBe(false)
    expect(backupProviderAllowed(answer(WINDOWS_HELLO_IDS[0], key))).toBe(false)
    // Counted as `other`, but named: Chromium's profile store on builds without Google branding.
    expect(backupProviderAllowed(answer(BRAVE, key))).toBe(false)
  })

  it("refuses a security key's id on an answer that is not a key", () => {
    expect(backupProviderAllowed(answer(YUBIKEY_5_NFC_AAGUID))).toBe(false)
  })

  const SHIPPED: [string, readonly string[], readonly OsFamily[]][] = [
    ["Windows Hello", WINDOWS_HELLO_IDS, ["windows"]],
    ["Proton Pass", [PROTON_PASS], OS_FAMILIES.filter((osFamily) => osFamily !== "ios")],
    ["Samsung Pass", [SAMSUNG_PASS], ["android"]],
  ]
  it.each(SHIPPED)(
    "admits %s with the shipped table only from this device's manager on the OS it was measured on",
    (_, ids, families) => {
      for (const id of ids) {
        for (const osFamily of OS_FAMILIES) {
          const allowed = (attachment: BackupAnswer["attachment"]) =>
            backupProviderAllowed(answer(id, { osFamily, attachment }))
          expect(allowed("platform")).toBe(families.includes(osFamily))
          expect(allowed("cross-platform")).toBe(false)
          expect(allowed(undefined)).toBe(false)
        }
      }
    },
  )

  it("refuses an unmeasured candidate, and unmeasured managers", () => {
    const unmeasured: BackupCandidates = {
      ...BACKUP_CANDIDATES,
      windows_hello: { ...BACKUP_CANDIDATES.windows_hello, measured: false },
    }
    for (const osFamily of OS_FAMILIES) {
      for (const id of WINDOWS_HELLO_IDS) {
        expect(backupProviderAllowed(answer(id, { osFamily }), { candidates: unmeasured })).toBe(
          false,
        )
      }
    }
    // The first passkey's gate refuses managed iCloud, so a backup does too.
    for (const id of [ICLOUD_MANAGED, BITWARDEN, DASHLANE, CHROME_PROFILE, UNLISTED]) {
      expect(backupProviderAllowed(answer(id))).toBe(false)
    }
  })

  it("admits an extra id for the browser-test build", () => {
    expect(backupProviderAllowed(answer(UNLISTED), { extraProviders: [UNLISTED] })).toBe(true)
  })
})

describe("BACKUP_CREATION_HINTS", () => {
  it("never names another phone", () => {
    expect(BACKUP_CREATION_HINTS).not.toContain("hybrid")
  })
})

describe("backupPrfFrom", () => {
  it("takes the route's slot when it holds a value, else the other one", () => {
    expect(
      backupPrfFrom({ authenticatorAttachment: "platform", prfFirst: prf(1), prfSecond: prf(2) }),
    ).toEqual({ slot: "second", prfOutput: prf(2) })
    expect(
      backupPrfFrom({
        authenticatorAttachment: "cross-platform",
        prfFirst: prf(1),
        prfSecond: prf(2),
      }),
    ).toEqual({ slot: "first", prfOutput: prf(1) })
    expect(backupPrfFrom({ authenticatorAttachment: "platform", prfFirst: prf(1) })).toEqual({
      slot: "first",
      prfOutput: prf(1),
    })
    expect(backupPrfFrom({ prfSecond: prf(2) })).toEqual({ slot: "second", prfOutput: prf(2) })
  })

  it("reads anything but 32 bytes as nothing", () => {
    expect(backupPrfFrom({ authenticatorAttachment: "platform" })).toBeUndefined()
    expect(
      backupPrfFrom({
        authenticatorAttachment: "platform",
        prfFirst: prf(1, 16),
        prfSecond: prf(2, 33),
      }),
    ).toBeUndefined()
  })
})

describe("sameBackupManager", () => {
  const backup = (aaguid: string | undefined, securityKey = false) => ({ aaguid, securityKey })

  it("compares managers by provider", () => {
    expect(sameBackupManager(APPLE_ICLOUD_AAGUID, backup(ICLOUD_MANAGED))).toBe(true)
    expect(sameBackupManager(APPLE_ICLOUD_AAGUID, backup(APPLE_ICLOUD_AAGUID))).toBe(true)
    expect(sameBackupManager(APPLE_ICLOUD_AAGUID, backup(GPM_AAGUID))).toBe(false)
  })

  it("is never true for a security key", () => {
    expect(sameBackupManager(YUBIKEY_5_NFC_AAGUID, backup(YUBIKEY_5_NFC_AAGUID, true))).toBe(false)
    expect(sameBackupManager(APPLE_ICLOUD_AAGUID, backup(undefined, true))).toBe(false)
  })

  it("is unknown when either id says nothing", () => {
    for (const unnamed of [undefined, ZERO_AAGUID, "unknown"]) {
      expect(sameBackupManager(unnamed, backup(APPLE_ICLOUD_AAGUID))).toBeUndefined()
      expect(sameBackupManager(APPLE_ICLOUD_AAGUID, backup(unnamed))).toBeUndefined()
    }
  })

  it("compares two unlisted ids by the id itself", () => {
    expect(sameBackupManager(UNLISTED, backup(UNLISTED.toUpperCase()))).toBe(true)
    expect(sameBackupManager(UNLISTED, backup("99999999-2222-3333-4444-555555555555"))).toBe(false)
  })
})

describe("backupCreationFacts", () => {
  it("reads the backup flag as device-bound, and leaves it out when unread", () => {
    expect(backupCreationFacts(created({ backupEligible: false })).deviceBound).toBe(true)
    expect(backupCreationFacts(created({ backupEligible: true })).deviceBound).toBe(false)
    expect(backupCreationFacts(created())).not.toHaveProperty("deviceBound")
  })

  it("says whether the creation returned a PRF in either slot", () => {
    expect(backupCreationFacts(created({ prfFirst: prf(1) })).prfAtCreate).toBe(true)
    expect(backupCreationFacts(created({ prfSecond: prf(1) })).prfAtCreate).toBe(true)
    expect(backupCreationFacts(created({ prfFirst: prf(1, 16) })).prfAtCreate).toBe(false)
    expect(backupCreationFacts(created()).prfAtCreate).toBe(false)
  })

  it("names the provider from the attested id, with the id itself only for an unlisted one", () => {
    expect(backupCreationFacts(created({ attestedAaguid: APPLE_ICLOUD_AAGUID }))).toMatchObject({
      provider: "icloud_keychain",
    })
    expect(
      backupCreationFacts(created({ attestedAaguid: APPLE_ICLOUD_AAGUID })),
    ).not.toHaveProperty("aaguid")
    expect(backupCreationFacts(created({ attestedAaguid: ZERO_AAGUID })).provider).toBe(
      "not_reported",
    )
    // The reported id drops zeros; only the attested one tells them from no attested data.
    expect(backupCreationFacts(created({ aaguid: APPLE_ICLOUD_AAGUID })).provider).toBe("unknown")
    expect(backupCreationFacts(created({ attestedAaguid: UNLISTED.toUpperCase() }))).toMatchObject({
      provider: "other",
      aaguid: UNLISTED,
    })
  })
})

describe("backupAnswerFacts", () => {
  it("names the provider and the backup flag the browser reported, and never a PRF-at-create fact", () => {
    expect(backupAnswerFacts({ aaguid: APPLE_ICLOUD_AAGUID, backupEligible: true })).toEqual({
      provider: "icloud_keychain",
      deviceBound: false,
    })
    expect(backupAnswerFacts({ aaguid: ZERO_AAGUID })).toEqual({ provider: "not_reported" })
    expect(backupAnswerFacts({})).toEqual({ provider: "unknown" })
  })
})

describe("backupSignInFacts", () => {
  it("names no provider without a record, and never a PRF-at-create fact", () => {
    expect(backupSignInFacts({ backupEligible: false })).toEqual({
      provider: "unknown",
      deviceBound: true,
    })
  })

  it("names the provider this browser recorded for the key", () => {
    expect(backupSignInFacts({ backupEligible: true }, { aaguid: APPLE_ICLOUD_AAGUID })).toEqual({
      provider: "icloud_keychain",
      deviceBound: false,
    })
    expect(backupSignInFacts({}, { aaguid: UNLISTED })).toEqual({
      provider: "other",
      aaguid: UNLISTED,
    })
  })
})

describe("BackupPasskeyRefusedError", () => {
  const iphone = parseUserAgent({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, " +
      "like Gecko) CriOS/155.0.8059.37 Mobile/15E148 Safari/604.1",
  })
  const windowsChrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/155.0.0.0 Safari/537.36"
  const windows = (platformVersion?: string) =>
    parseUserAgent({
      userAgent: windowsChrome,
      ...(platformVersion ? { userAgentData: { platform: "Windows", platformVersion } } : {}),
    })

  it("says Proton Pass's iPhone app can't make one, and nothing of the sort elsewhere", () => {
    const proton = (userAgent: ReturnType<typeof parseUserAgent>) =>
      new BackupPasskeyRefusedError("provider", { providerName: PROTON_PASS_NAME, userAgent })
        .message
    const elsewhere = new BackupPasskeyRefusedError("provider", { providerName: PROTON_PASS_NAME })
    expect(proton(iphone)).not.toBe(elsewhere.message)
    expect(proton(windows())).toBe(elsewhere.message)
  })

  it("tells Windows Hello on Windows 10 to use another manager, and otherwise to update", () => {
    const hello = (userAgent?: ReturnType<typeof parseUserAgent>) =>
      new BackupPasskeyRefusedError("no-prf", { providerName: WINDOWS_HELLO, userAgent }).message
    const update = hello()
    expect(hello(windows("10.0.0"))).not.toBe(update)
    for (const userAgent of [windows("19.0.0"), windows()]) {
      expect(hello(userAgent)).toBe(update)
    }
  })
})

describe("windowsHelloBackupWarning", () => {
  const WINDOWS_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/155.0.0.0 Safari/537.36"
  const brands = {
    chrome: [{ brand: "Google Chrome", version: "155" }],
    edge: [{ brand: "Microsoft Edge", version: "155" }],
    brave: [{ brand: "Brave", version: "155" }],
  }
  const hinted = (
    platformVersion: string,
    platform = "Windows",
    brandSet: readonly { brand: string; version: string }[] = brands.chrome,
  ) =>
    parseUserAgent({
      userAgent: WINDOWS_UA,
      userAgentData: { platform, platformVersion, brands: brandSet },
    })

  it("gives the line on Windows 10 hints, whichever Chromium asks", () => {
    for (const brandSet of Object.values(brands)) {
      expect(windowsHelloBackupWarning(hinted("10.0.0", "Windows", brandSet))).toBeDefined()
    }
    expect(windowsHelloBackupWarning(hinted("1.0.0"))).toBeDefined()
  })

  it("gives nothing on Windows 11, an unreadable version, or no hints", () => {
    for (const version of ["13.0.0", "19.0.0", "0.3.0", ""]) {
      expect(windowsHelloBackupWarning(hinted(version))).toBeUndefined()
    }
    expect(windowsHelloBackupWarning(parseUserAgent({ userAgent: WINDOWS_UA }))).toBeUndefined()
  })

  it("gives nothing on another platform, even under a Windows user-agent string", () => {
    expect(windowsHelloBackupWarning(hinted("6.1.0", "Linux"))).toBeUndefined()
    const mac = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform: "macOS", platformVersion: "15.0.0" },
    })
    expect(windowsHelloBackupWarning(mac)).toBeUndefined()
    const android = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/155.0.0.0 Mobile Safari/537.36",
      userAgentData: { platform: "Android", platformVersion: "16.0.0" },
    })
    expect(windowsHelloBackupWarning(android)).toBeUndefined()
  })

  it("gives nothing while Windows Hello is not a measured candidate", () => {
    const candidates: BackupCandidates = {
      ...BACKUP_CANDIDATES,
      windows_hello: { ...BACKUP_CANDIDATES.windows_hello, measured: false },
    }
    expect(windowsHelloBackupWarning(hinted("10.0.0"), { candidates })).toBeUndefined()
  })
})

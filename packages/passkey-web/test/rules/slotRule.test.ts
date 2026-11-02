import { APPLE_ICLOUD_AAGUID, YUBIKEY_5_NFC_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import { PhoneRequiredError } from "../../src/refusals/passkeyErrors.js"
import { providerNameFor } from "../../src/rules/passkeyProviders.js"
import {
  EVERY_SIGN_IN_ROUTE,
  checkAssertionRoute,
  checkCreationRoute,
  chosenKeyHints,
  creationHintsFor,
  creationTimeoutMs,
  offerableTransports,
  impliedKeyTransports,
  isPhysicalOnly,
  isSecurityKey,
  requestedAttachment,
  residentKeyFor,
  signInHintsFor,
  signInKeyChoices,
  slotForAttachment,
} from "../../src/rules/slotRule.js"

const SIGN_UP = new PhoneRequiredError({ ceremony: "create" }).message

describe("the slot rule", () => {
  it("binds a local answer to second and a cross-device answer to first", () => {
    expect(slotForAttachment("platform")).toBe("second")
    expect(slotForAttachment("cross-platform")).toBe("first")
  })

  it("asks a laptop for a phone's, and asks a phone for nothing so its sheet can offer a key", () => {
    expect(requestedAttachment("laptop")).toBe("cross-platform")
    expect(requestedAttachment("phone")).toBeUndefined()
  })

  it("gives a laptop creation five minutes, and names no timeout for a phone", () => {
    expect(creationTimeoutMs("laptop")).toBe(300_000)
    expect(creationTimeoutMs("phone")).toBeUndefined()
  })
})

describe("telling a security key from a phone", () => {
  it("takes another device answering over physical transports only", () => {
    for (const transports of [["usb"], ["nfc", "usb"], ["ble"], ["smart-card"]]) {
      expect(isSecurityKey({ authenticatorAttachment: "cross-platform", transports })).toBe(true)
    }
  })

  it("treats anything less certain as a phone, so the backup gate still applies", () => {
    const notKeys = [
      ["hybrid"],
      ["usb", "hybrid"],
      ["usb", "internal"],
      // A transport this code has never heard of says nothing about how the answer arrived.
      ["usb", "something-new"],
      [],
    ]
    for (const transports of notKeys) {
      expect(isSecurityKey({ authenticatorAttachment: "cross-platform", transports })).toBe(false)
    }
    expect(
      isSecurityKey({ authenticatorAttachment: "cross-platform", transports: undefined }),
    ).toBe(false)
    expect(isSecurityKey({ authenticatorAttachment: "platform", transports: ["usb"] })).toBe(false)
  })

  it("takes another device listing no transports when the attested id is all zeros", () => {
    expect(
      isSecurityKey({
        authenticatorAttachment: "cross-platform",
        transports: [],
        attestedAaguid: ZERO_AAGUID,
      }),
    ).toBe(true)
  })

  it("keeps an empty list a phone when any id was reported, or none was attested", () => {
    for (const attestedAaguid of [YUBIKEY_5_NFC_AAGUID, undefined]) {
      expect(
        isSecurityKey({
          authenticatorAttachment: "cross-platform",
          transports: [],
          attestedAaguid,
        }),
      ).toBe(false)
    }
  })

  it("lets a zero id override neither the list nor the attachment", () => {
    for (const transports of [["hybrid"], undefined]) {
      expect(
        isSecurityKey({
          authenticatorAttachment: "cross-platform",
          transports,
          attestedAaguid: ZERO_AAGUID,
        }),
      ).toBe(false)
    }
    expect(
      isSecurityKey({
        authenticatorAttachment: "platform",
        transports: [],
        attestedAaguid: ZERO_AAGUID,
      }),
    ).toBe(false)
  })

  it("a recorded list is physical only when every entry is a physical transport", () => {
    expect(isPhysicalOnly(["usb"])).toBe(true)
    expect(isPhysicalOnly(["usb", "nfc"])).toBe(true)
    expect(isPhysicalOnly([])).toBe(false)
  })
})

describe("what an assertion implies about its authenticator", () => {
  it("another device that cannot be backed up is a key, asked over every physical route but ble", () => {
    expect(
      impliedKeyTransports({ authenticatorAttachment: "cross-platform", backupEligible: false }),
    ).toEqual(["usb", "nfc", "smart-card"])
  })

  it("implies nothing for a synced passkey, a local answer, or an unreadable flag", () => {
    expect(
      impliedKeyTransports({ authenticatorAttachment: "cross-platform", backupEligible: true }),
    ).toBeUndefined()
    expect(
      impliedKeyTransports({ authenticatorAttachment: "platform", backupEligible: false }),
    ).toBeUndefined()
    expect(impliedKeyTransports({ authenticatorAttachment: "cross-platform" })).toBeUndefined()
    expect(impliedKeyTransports({ backupEligible: false })).toBeUndefined()
  })
})

describe("the transports a ceremony offers", () => {
  it("a laptop drops the device's own, which the route rule would refuse anyway", () => {
    expect(offerableTransports("laptop", ["hybrid", "internal"])).toEqual(["hybrid"])
    expect(offerableTransports("laptop", ["usb", "nfc"])).toEqual(["usb", "nfc"])
  })

  it("a phone keeps its own, the only answer it accepts", () => {
    expect(offerableTransports("phone", ["hybrid", "internal"])).toEqual(["hybrid", "internal"])
  })

  it("a laptop record naming nothing else falls back to the cross-device set", () => {
    const crossDevice = ["hybrid", "usb", "nfc", "ble", "smart-card"]
    expect(offerableTransports("laptop", ["internal"])).toEqual(crossDevice)
    expect(offerableTransports("laptop", undefined)).toEqual(crossDevice)
  })

  it("a phone with no recorded transports sends nothing", () => {
    expect(offerableTransports("phone", [])).toBeUndefined()
  })

  it("with the local route allowed, a laptop sends no restriction — even a hybrid-only record can't hide the local copy", () => {
    expect(offerableTransports("laptop", ["hybrid"], true)).toBeUndefined()
    expect(offerableTransports("laptop", [], true)).toBeUndefined()
  })

  it("with the local route allowed, a hardware key's physical-only list still opens the prompt on the key", () => {
    expect(offerableTransports("laptop", ["usb"], true)).toEqual(["usb"])
    // One non-physical entry makes it a list that could hide the local copy.
    expect(offerableTransports("laptop", ["usb", "hybrid"], true)).toBeUndefined()
  })
})

describe("the creation route rule", () => {
  it("a laptop needs another device, whatever class answered", () => {
    for (const securityKey of [true, false]) {
      expect(() => checkCreationRoute("laptop", "cross-platform", securityKey)).not.toThrow()
    }
    // Each refusal names the device the ceremony was already using.
    expect(() => checkCreationRoute("laptop", "platform", false)).toThrow(
      expect.objectContaining({ name: "PhoneRequiredError" }),
    )
    expect(() => checkCreationRoute("laptop", "platform", true)).toThrow(
      expect.objectContaining({ name: "SecurityKeyRequiredError" }),
    )
  })

  it("a phone takes its own passkey, or a security key, and refuses another phone", () => {
    expect(() => checkCreationRoute("phone", "platform", false)).not.toThrow()
    expect(() => checkCreationRoute("phone", "cross-platform", true)).not.toThrow()
    // Another phone over QR: cross-platform, but not a key.
    expect(() => checkCreationRoute("phone", "cross-platform", false)).toThrow(
      expect.objectContaining({ name: "LocalPasskeyRequiredError" }),
    )
  })

  it("holds a chained answer to the class the creation admitted", () => {
    // A key creation whose chained assertion comes back local is sent back to the key, never to a
    // QR code that a phone creation would refuse anyway.
    expect(() => checkCreationRoute("phone", "platform", true)).toThrow(
      expect.objectContaining({ name: "SecurityKeyRequiredError" }),
    )
  })

  it("refuses an unreported attachment on either posture, even for a key", () => {
    for (const posture of ["phone", "laptop"] as const) {
      for (const securityKey of [true, false]) {
        expect(() => checkCreationRoute(posture, undefined, securityKey)).toThrow(
          expect.objectContaining({ name: expect.stringMatching(/RequiredError$/) }),
        )
      }
    }
  })

  it("names what answered a laptop only when the browser reported this device", () => {
    expect(() => checkCreationRoute("laptop", "platform", false, "Bitwarden")).toThrow(
      expect.objectContaining({ name: "PhoneRequiredError", providerName: "Bitwarden" }),
    )
    // An unreported answer says nothing about the device, so the name is dropped and the sign-up
    // wording says where to create the passkey.
    expect(() => checkCreationRoute("laptop", undefined, false, "Bitwarden")).toThrow(
      expect.objectContaining({
        name: "PhoneRequiredError",
        providerName: undefined,
        message: SIGN_UP,
      }),
    )
  })

  it("ends a laptop's refusal with the advice it is given, and only then", () => {
    const advice = "Add this site to the manager's excluded domains."
    const named = new PhoneRequiredError({ providerName: "Bitwarden" }).message
    expect(() =>
      checkCreationRoute("laptop", "platform", false, "Bitwarden", undefined, advice),
    ).toThrow(expect.objectContaining({ message: `${named} ${advice}` }))
    expect(() => checkCreationRoute("laptop", "platform", false, "Bitwarden")).toThrow(
      expect.objectContaining({ message: named }),
    )
  })
})

describe("the assertion route rule", () => {
  it("a laptop still needs another device", () => {
    expect(() => checkAssertionRoute("laptop", "cross-platform")).not.toThrow()
    for (const attachment of ["platform", undefined] as const) {
      // A sign-in carries no provider id, so it never names one.
      expect(() => checkAssertionRoute("laptop", attachment)).toThrow(
        expect.objectContaining({
          name: "PhoneRequiredError",
          providerName: undefined,
          message: new PhoneRequiredError().message,
        }),
      )
    }
  })

  it("a phone takes any answer, including one whose attachment went unreported", () => {
    for (const attachment of ["platform", "cross-platform", undefined] as const) {
      expect(() => checkAssertionRoute("phone", attachment)).not.toThrow()
    }
  })

  it("with the local route allowed, a laptop admits its own passkey but still fails closed on an unnamed route", () => {
    expect(() => checkAssertionRoute("laptop", "platform", true)).not.toThrow()
    expect(() => checkAssertionRoute("laptop", "cross-platform", true)).not.toThrow()
    // An unreported attachment is refused even with the opt-in: nothing may pick a slot from it.
    expect(() => checkAssertionRoute("laptop", undefined, true)).toThrow(
      expect.objectContaining({ name: "PhoneRequiredError" }),
    )
  })
})

describe("the laptop's own route", () => {
  const managers = ["apple", "gpm"] as const

  it("asks for this device, keeps the default timeout, and steers to it, then to a key", () => {
    expect(requestedAttachment("laptop", true)).toBe("platform")
    expect(requestedAttachment("phone", true)).toBeUndefined()
    expect(creationTimeoutMs("laptop", true)).toBeUndefined()
    // The key is named so 1Password's extension stands aside.
    expect(creationHintsFor("laptop", undefined, true)).toEqual(["client-device", "security-key"])
    // The consumer's hints go as given: `client-device` alone lets the extension answer.
    expect(creationHintsFor("laptop", ["client-device"], true)).toEqual(["client-device"])
    expect(creationHintsFor("laptop", null, true)).toBeUndefined()
  })

  it("admits the laptop's own passkey, or a security key", () => {
    expect(() => checkCreationRoute("laptop", "platform", false, undefined, managers)).not.toThrow()
    expect(() =>
      checkCreationRoute("laptop", "cross-platform", true, undefined, managers),
    ).not.toThrow()
  })

  it("refuses another device's answer that is not a key, naming the managers", () => {
    expect(() =>
      checkCreationRoute("laptop", "cross-platform", false, undefined, managers),
    ).toThrow(
      expect.objectContaining({ name: "LaptopPasskeyRefusedError", kind: "not-local", managers }),
    )
  })

  it("refuses an unreported attachment with copy that names the managers, not the phone route", () => {
    expect(() => checkCreationRoute("laptop", undefined, false, undefined, managers)).toThrow(
      expect.objectContaining({
        name: "PhoneRequiredError",
        message: expect.stringContaining("Google Password Manager"),
      }),
    )
  })
})

describe("hints", () => {
  it("a phone creation names its two admitted classes, whatever the consumer asked for", () => {
    // Never hybrid: the route rule would refuse what it would open.
    expect(creationHintsFor("phone")).toEqual(["client-device", "security-key"])
    expect(creationHintsFor("phone", ["hybrid"])).toEqual(["client-device", "security-key"])
    expect(creationHintsFor("phone", null)).toEqual(["client-device", "security-key"])
  })

  it("a laptop creation opens on the phone when no route is named, and null sends nothing", () => {
    expect(creationHintsFor("laptop")).toEqual(["hybrid", "security-key"])
    expect(creationHintsFor("laptop", [])).toEqual(["hybrid", "security-key"])
    expect(creationHintsFor("laptop", null)).toBeUndefined()
  })

  it("a laptop always names a security key, after the route it was asked for", () => {
    // A password manager's extension takes the request over unless a security key is named.
    expect(creationHintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
    expect(creationHintsFor("laptop", ["security-key"])).toEqual(["security-key"])
    expect(creationHintsFor("laptop", ["security-key", "hybrid"])).toEqual([
      "security-key",
      "hybrid",
    ])
    expect(signInHintsFor("laptop", ["hybrid"])).toEqual(["hybrid", "security-key"])
  })

  it("a laptop creation that names a security key may leave the passkey unstored", () => {
    // Every laptop route but 1Password's names a key, so each admits a Ledger.
    expect(residentKeyFor("laptop", creationHintsFor("laptop"))).toBe("preferred")
    // A manager's route, the hint-free build, and a phone (whose hints name a key too) require one.
    expect(residentKeyFor("laptop", creationHintsFor("laptop", ["client-device"], true))).toBe(
      "required",
    )
    expect(residentKeyFor("laptop", creationHintsFor("laptop", null))).toBe("required")
    expect(residentKeyFor("phone", creationHintsFor("phone"))).toBe("required")
  })

  it("a laptop sign-in names both routes it accepts, since a local answer is refused anyway", () => {
    // Both, never hybrid alone: a sheet that honours hybrid may drop the security-key row.
    expect(signInHintsFor("laptop")).toEqual(["hybrid", "security-key"])
  })

  it("a laptop sign-in that admits its own copy opens on this computer, naming a security key only for one", () => {
    // No security key named: a manager's extension may answer for a synced passkey.
    expect(signInHintsFor("laptop", undefined, true)).toEqual(["client-device"])
    // A credential known to be a hardware key names one, so the extension stands aside.
    expect(signInHintsFor("laptop", undefined, true, true)).toEqual([
      "client-device",
      "security-key",
    ])
    // A consumer's own hints still win, even with the local route open.
    expect(signInHintsFor("laptop", ["hybrid"], true)).toEqual(["hybrid", "security-key"])
    // Suppression still wins too.
    expect(signInHintsFor("laptop", null, true)).toBeUndefined()
  })

  it("a phone sign-in sends none: another phone over QR is an answer it accepts", () => {
    expect(signInHintsFor("phone")).toBeUndefined()
    expect(signInHintsFor("phone", ["hybrid"])).toBeUndefined()
    expect(signInHintsFor("phone", null)).toBeUndefined()
  })
})

describe("a chosen key's hints", () => {
  it("name every route when this browser has no record, this computer first", () => {
    expect(chosenKeyHints()).toEqual(EVERY_SIGN_IN_ROUTE)
    // A list naming nothing this rule knows says nothing either.
    expect(chosenKeyHints(["carrier-pigeon"])).toEqual(EVERY_SIGN_IN_ROUTE)
  })

  it("name the routes a record names, in route order rather than the record's sorted order", () => {
    // A synced passkey's sorted list leads with hybrid; its sheet must still open on this computer.
    expect(chosenKeyHints(["hybrid", "internal"])).toEqual(["client-device", "hybrid"])
    expect(chosenKeyHints(["internal"])).toEqual(["client-device"])
    expect(chosenKeyHints(["hybrid"])).toEqual(["hybrid"])
    // A hardware key's goes straight to the key: no local sheet to cancel first.
    expect(chosenKeyHints(["nfc", "usb"])).toEqual(["security-key"])
    expect(chosenKeyHints(["hybrid", "usb"])).toEqual(["hybrid", "security-key"])
  })

  it("apply on a laptop's local route only, under a consumer's own hints and its suppression", () => {
    const chosen = { transports: ["usb"] }
    expect(signInHintsFor("laptop", undefined, true, false, chosen)).toEqual(["security-key"])
    // A chosen key with no record names a key even where `securityKey` is false.
    expect(signInHintsFor("laptop", undefined, true, false, {})).toEqual(EVERY_SIGN_IN_ROUTE)
    // Steered to the phone, the cross-device pair stands.
    expect(signInHintsFor("laptop", undefined, false, false, chosen)).toEqual([
      "hybrid",
      "security-key",
    ])
    expect(signInHintsFor("laptop", ["hybrid"], true, false, chosen)).toEqual([
      "hybrid",
      "security-key",
    ])
    expect(signInHintsFor("laptop", null, true, false, chosen)).toBeUndefined()
    expect(signInHintsFor("phone", undefined, true, false, chosen)).toBeUndefined()
  })
})

describe("the sign-in key choice", () => {
  const signUp = { credentialId: "root", backup: false }
  const backup = { credentialId: "spare", backup: true }

  it("is not offered for an account with one key to ask for", () => {
    expect(signInKeyChoices([])).toBeUndefined()
    expect(signInKeyChoices([signUp])).toBeUndefined()
    // L1 may list a key twice; it is still one key.
    expect(signInKeyChoices([signUp, { ...signUp }])).toBeUndefined()
  })

  it("lists the sign-up key first, then the backup, whatever the chain's order", () => {
    expect(signInKeyChoices([backup, signUp])?.map((c) => c.credentialId)).toEqual([
      "root",
      "spare",
    ])
  })

  it("names the provider only where this browser recorded one it can name", () => {
    expect(
      signInKeyChoices([
        { ...signUp, aaguid: APPLE_ICLOUD_AAGUID },
        { ...backup, aaguid: YUBIKEY_5_NFC_AAGUID },
      ]),
    ).toMatchObject([
      { credentialId: "root", provider: providerNameFor(APPLE_ICLOUD_AAGUID) },
      { credentialId: "spare", provider: providerNameFor(YUBIKEY_5_NFC_AAGUID) },
    ])
    // An all-zero id is a provider that did not report itself: nothing to name.
    expect(signInKeyChoices([signUp, { ...backup, aaguid: ZERO_AAGUID }])?.[1]).toEqual({
      credentialId: "spare",
      label: expect.any(String),
    })
  })

  it("marks the key this browser last opened the wallet with, and keeps the sign-up key first", () => {
    const choices = signInKeyChoices([
      { ...signUp, usedAt: 100 },
      { ...backup, usedAt: 200 },
    ])
    expect(choices?.map((c) => [c.credentialId, c.lastUsed])).toEqual([
      ["root", undefined],
      ["spare", true],
    ])
    // Only one key carries a time: it is the last used.
    expect(signInKeyChoices([{ ...signUp, usedAt: 5 }, backup])?.[0]?.lastUsed).toBe(true)
    // No time on any key, as on a fresh device: nothing is marked.
    expect(signInKeyChoices([signUp, backup])?.some((c) => c.lastUsed)).toBe(false)
  })

  it("numbers the backups when there is more than one", () => {
    const second = { credentialId: "spare-2", backup: true }
    const labels = signInKeyChoices([signUp, backup, second])?.map((c) => c.label) ?? []
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
  })
})

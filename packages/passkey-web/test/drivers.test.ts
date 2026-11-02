/** The creation and assertion sequences at the driver level, over the fake ceremony. */
import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  YUBIKEY_5_USB_A_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToBase64Url, bytesToHex } from "../src/ceremony/bytes.js"
import {
  type PasskeyCreateRequest,
  type PasskeyHint,
  isBlockedPromptError,
  recordRequestHeld,
} from "../src/ceremony/passkeyCeremony.js"
import { UNKNOWN_PROVENANCE } from "../src/ceremony/userHandle.js"
import type { DevicePosture } from "../src/browser/devicePosture.js"
import { type LocalManager, WITHDRAWN, laptopCreationFor } from "../src/rules/laptopCreation.js"
import {
  type ObservedCeremony,
  type PasskeyCreationOptions,
  runPasskeyAssertion,
  renamePasskey,
  runPasskeyCreation,
} from "../src/drivers.js"
import { prfSalts } from "../src/derivation.js"
import { candidatesFrom } from "../src/rules/evidence.js"
import { type UserAgentInfo, parseUserAgent } from "../src/browser/userAgentInfo.js"
import {
  PhoneRequiredError,
  RelatedOriginPasskeyError,
  UnsupportedProviderError,
  passkeyWritten,
} from "../src/refusals/passkeyErrors.js"
import { bitwardenLineFor } from "../src/refusals/refusalCopy.js"
import { trustsAttachmentLabel } from "../src/browser/passkeyCapabilities.js"
import {
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  WINDOWS_HELLO,
} from "../src/rules/passkeyProviders.js"
import { passkeyRouteFor } from "../src/telemetry/passkeyTelemetry.js"
import { hmac } from "@noble/hashes/hmac"
import { sha256 as nobleSha256 } from "@noble/hashes/sha256"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  contextualiseLocal,
  fakePrf,
} from "./support/fakePasskeyCeremony.js"

/** Outside the measured set, and unknown to the name table, so a refusal cannot name it. */
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
/** Also outside the set, but the table knows it, so a refusal says which manager answered. */
const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"

const CHALLENGE = new Uint8Array(32).fill(9)

function create(
  posture: DevicePosture,
  fake: FakeCeremonyOptions,
  extra: {
    observe?: (event: ObservedCeremony) => void | Promise<void>
    misreportsCrossDevice?: boolean
    attachmentLabelTrusted?: boolean
    signal?: AbortSignal
    userAgent?: UserAgentInfo
    laptopHints?: readonly PasskeyHint[] | null
    localCreation?: PasskeyCreationOptions["localCreation"]
    extraProviders?: readonly string[]
  } = {},
) {
  const ceremony = new FakePasskeyCeremony(fake)
  const run = runPasskeyCreation(ceremony, {
    posture,
    rpId: "localhost",
    rpName: "zk.money",
    userName: "@alice",
    challengeForChained: () => CHALLENGE,
    // Every local row but Firefox's Mac row is on a browser whose label is trusted.
    ...(extra.localCreation ? { attachmentLabelTrusted: true } : {}),
    ...extra,
  })
  return { ceremony, run }
}

const named = (name: string) => expect.objectContaining({ name })
/** What a handle carries when the page claims nothing about its own OS. */
const NO_CLAIMS = { osVersion: {}, chip: "unknown" } as const

describe("runPasskeyCreation on the laptop's own route", () => {
  type Local = { managers: readonly LocalManager[]; appleWithdrawn?: boolean }
  const macChrome: Local = { managers: ["apple", "gpm"] }
  const belowFloor: Local = { managers: ["gpm"] }
  const local = (fake: FakeCeremonyOptions, localCreation: Local = macChrome, laptopHints?: null) =>
    create(
      "laptop",
      { route: "local", ...fake },
      {
        localCreation,
        ...(laptopHints === null ? { laptopHints: null } : {}),
      },
    )

  it("asks for this device with the local steering and the default timeout, and binds second", async () => {
    const { ceremony, run } = local({ manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID })
    const result = await run
    expect(result.slot).toBe("second")
    expect(result.securityKey).toBe(false)
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "second")),
    )
    // A key named after this computer, so 1Password's extension stands aside; no kept wrapper
    // answers the account's own passkey either.
    expect(ceremony.creates[0]).toMatchObject({
      authenticatorAttachment: "platform",
      hints: ["client-device", "security-key"],
    })
    expect(ceremony.creates[0]!.extensionAllowed).toBeUndefined()
    expect(ceremony.creates[0]!.timeoutMs).toBeUndefined()
  })

  it("admits each manager on the row, and the browser-test id through the extra list", async () => {
    expect((await local({ manager: "gpm", aaguid: GPM_AAGUID }, belowFloor).run).slot).toBe(
      "second",
    )
    expect(
      (
        await local(
          { manager: "1password", aaguid: ONEPASSWORD_AAGUID },
          { managers: ["1password"] },
        ).run
      ).slot,
    ).toBe("second")
    const virtual = create(
      "laptop",
      { route: "local", aaguid: CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID },
      { localCreation: belowFloor, extraProviders: [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID] },
    )
    expect((await virtual.run).slot).toBe("second")
  })

  it("sends the consumer's hints as given, and none under the browser-test seam", async () => {
    const given = create(
      "laptop",
      { route: "local", aaguid: GPM_AAGUID },
      {
        localCreation: macChrome,
        laptopHints: ["client-device"],
      },
    )
    await given.run
    expect(given.ceremony.creates[0]!.hints).toEqual(["client-device"])
    const seam = local({ aaguid: GPM_AAGUID }, belowFloor, null)
    await seam.run
    expect(seam.ceremony.creates[0]!.hints).toBeUndefined()
    expect(seam.ceremony.creates[0]!.authenticatorAttachment).toBe("platform")
  })

  it("keeps the follow-up prompt on this device with the creation's hints, pinned to the passkey just made", async () => {
    const { ceremony, run } = local({ manager: "gpm", aaguid: GPM_AAGUID, prfAtCreate: false })
    const result = await run
    expect(result.slot).toBe("second")
    expect(result.chained).toBeDefined()
    expect(ceremony.assertRequests[0]).toMatchObject({
      hints: ["client-device", "security-key"],
      credentialIds: [result.created.credentialId],
    })
    const given = create(
      "laptop",
      { route: "local", aaguid: GPM_AAGUID, prfAtCreate: false },
      { localCreation: macChrome, laptopHints: ["client-device"] },
    )
    await given.run
    expect(given.ceremony.assertRequests[0]!.hints).toEqual(["client-device"])
    const seam = local({ aaguid: GPM_AAGUID, prfAtCreate: false }, belowFloor, null)
    await seam.run
    expect(seam.ceremony.assertRequests[0]!.hints).toBeUndefined()
  })

  it("refuses Apple where the row leaves it out, as refused here or as withdrawn", async () => {
    const floor = local({ manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID }, belowFloor)
    await expect(floor.run).rejects.toThrow(
      expect.objectContaining({
        name: "LaptopPasskeyRefusedError",
        kind: "apple",
        appleRefusedHere: true,
      }),
    )
    // The row refuses an Apple answer before any key material is read.
    const noPrf = local(
      { manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false, prfAtAssert: false },
      belowFloor,
    )
    await expect(noPrf.run).rejects.toThrow(expect.objectContaining({ kind: "apple" }))
    expect(noPrf.ceremony.assertRequests).toHaveLength(0)
    const withdrawn = create(
      "laptop",
      { route: "local", aaguid: APPLE_ICLOUD_AAGUID },
      { localCreation: { managers: ["gpm"], appleWithdrawn: true } },
    )
    await expect(withdrawn.run).rejects.toThrow(
      expect.objectContaining({ kind: "apple", appleRefusedHere: false }),
    )
  })

  it("refuses an Apple answer with no key as Apple, and keeps NoPrfError for another manager", async () => {
    const safariRow: Local = { managers: ["apple", "1password"] }
    const apple = local(
      { manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false, prfAtAssert: false },
      safariRow,
    )
    await expect(apple.run).rejects.toThrow(
      expect.objectContaining({
        name: "LaptopPasskeyRefusedError",
        kind: "apple",
        managers: ["1password"],
        appleRefusedHere: true,
      }),
    )
    const alone = local(
      { manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false, prfAtAssert: false },
      { managers: ["apple"] },
    )
    await expect(alone.run).rejects.toThrow(
      expect.objectContaining({ kind: "apple", managers: [] }),
    )
    const onePassword = local(
      { manager: "1password", aaguid: ONEPASSWORD_AAGUID, prfAtCreate: false, prfAtAssert: false },
      safariRow,
    )
    await expect(onePassword.run).rejects.toThrow(
      expect.objectContaining({ name: "NoPrfError", manager: "1password" }),
    )
  })

  it("refuses a missing or all-zero id", async () => {
    for (const aaguid of [undefined, ZERO_AAGUID]) {
      const { ceremony, run } = local({ aaguid })
      await expect(run).rejects.toThrow(
        expect.objectContaining({ name: "LaptopPasskeyRefusedError", kind: "unnamed" }),
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    }
  })

  describe("Firefox's Mac row: Apple Passwords and 1Password, behind a label that is not trusted", () => {
    const firefox = (
      fake: FakeCeremonyOptions,
      managers: LocalManager[] = ["apple", "1password"],
    ) =>
      create(
        "laptop",
        { route: "local", ...fake },
        { localCreation: { managers }, attachmentLabelTrusted: false },
      )

    it("binds an Apple or a 1Password answer that brings its key, from the local slot", async () => {
      const answers = [
        { manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID },
        { manager: "1password", aaguid: ONEPASSWORD_AAGUID },
      ] as const
      for (const answer of answers) {
        const { ceremony, run } = firefox(answer)
        const result = await run
        expect(result.slot).toBe("second")
        expect(bytesToHex(result.prfOutput)).toBe(
          bytesToHex(ceremony.prfFor(result.created.credentialId, "second")),
        )
        expect(ceremony.assertRequests).toHaveLength(0)
      }
    })

    it("treats a trusted label on a browser that mislabels cross-device answers as untrusted", async () => {
      const { ceremony, run } = create(
        "laptop",
        {
          route: "local",
          manager: "icloud",
          aaguid: APPLE_ICLOUD_AAGUID,
          prfAtCreate: false,
          divergent: true,
        },
        {
          localCreation: { managers: ["apple", "1password"] },
          attachmentLabelTrusted: true,
          misreportsCrossDevice: true,
        },
      )
      await expect(run).rejects.toThrow(
        expect.objectContaining({ kind: "apple", managers: ["1password"] }),
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    })

    it("refuses a 1Password answer without its key, with no follow-up", async () => {
      const { ceremony, run } = firefox({
        manager: "1password",
        aaguid: ONEPASSWORD_AAGUID,
        prfAtCreate: false,
      })
      await expect(run).rejects.toThrow(
        expect.objectContaining({ name: "IncompleteCreationError", kind: "unverified" }),
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    })

    it("lets a security key's follow-up run, pinned to the key", async () => {
      const { ceremony, run } = create(
        "laptop",
        {
          route: "cross-device",
          aaguid: YUBIKEY_5_USB_A_AAGUID,
          transports: ["usb"],
          prfAtCreate: false,
        },
        { localCreation: { managers: ["apple", "1password"] }, attachmentLabelTrusted: false },
      )
      const result = await run
      expect(result.securityKey).toBe(true)
      expect(ceremony.assertRequests[0]).toMatchObject({ transports: ["usb"] })
    })

    it("a trusted label keeps the follow-up for the same Apple answer on Chromium's row", async () => {
      const { ceremony, run } = create(
        "laptop",
        { route: "local", manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false },
        { localCreation: { managers: ["apple", "gpm"] }, attachmentLabelTrusted: true },
      )
      expect((await run).chained).toBeDefined()
      expect(ceremony.assertRequests).toHaveLength(1)
    })
  })

  describe("Safari's row: Apple must bring its key with the creation", () => {
    const safari = (fake: FakeCeremonyOptions) =>
      create(
        "laptop",
        { route: "local", prfAtCreate: false, ...fake },
        { localCreation: { managers: ["apple", "1password"], appleKeyAtCreation: true } },
      )

    it("never asks again for an Apple answer without its key: the Apple refusal, nothing bound", async () => {
      const { ceremony, run } = safari({
        manager: "icloud",
        aaguid: APPLE_ICLOUD_AAGUID,
        divergent: true,
      })
      await expect(run).rejects.toThrow(
        expect.objectContaining({ kind: "apple", managers: ["1password"] }),
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    })

    it("still asks again for 1Password's answer, and binds an Apple answer that brings its key", async () => {
      const onePassword = safari({ manager: "1password", aaguid: ONEPASSWORD_AAGUID })
      expect((await onePassword.run).chained).toBeDefined()
      const apple = safari({ manager: "icloud", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: true })
      expect((await apple.run).slot).toBe("second")
      expect(apple.ceremony.assertRequests).toHaveLength(0)
    })
  })

  describe("Firefox's Windows and Linux rows: 1Password alone, behind a trusted label", () => {
    /** The driver's options as the wallet builds them from the row, once a gate admits it. */
    const firefox = (userAgent: string, fake: FakeCeremonyOptions) => {
      const ua = parseUserAgent({ userAgent })
      const admitted = { ...WITHDRAWN, windowsFirefox: [], linuxFirefox: [] }
      const creation = laptopCreationFor(ua, admitted)
      if (!creation.local) throw new Error("no local row")
      return create(
        "laptop",
        { route: "local", ...fake },
        {
          userAgent: ua,
          localCreation: { managers: creation.managers },
          attachmentLabelTrusted: trustsAttachmentLabel(ua),
        },
      )
    }
    const onePassword = { manager: "1password", aaguid: ONEPASSWORD_AAGUID } as const

    for (const [os, userAgent, context] of [
      [
        "Windows",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0",
        "windows_local",
      ],
      [
        "Linux",
        "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
        "laptop_other_local",
      ],
    ] as const) {
      describe(os, () => {
        it("binds 1Password's answer that brings its key, written as this computer's", async () => {
          const { ceremony, run } = firefox(userAgent, onePassword)
          const result = await run
          expect(result.slot).toBe("second")
          expect(ceremony.assertRequests).toHaveLength(0)
          expect(ceremony.creates[0]!.provenance).toEqual({ context, ...NO_CLAIMS })
          expect(passkeyRouteFor("create", result.created)).toBe("same_device")
        })

        it("refuses another provider's id", async () => {
          const windowsHello = "08987058-cadc-4b81-b6e1-30de50dcbe96"
          for (const aaguid of [GPM_AAGUID, BITWARDEN, windowsHello]) {
            await expect(firefox(userAgent, { aaguid }).run).rejects.toThrow(
              named("UnsupportedProviderError"),
            )
          }
        })

        it("binds the follow-up's key for the same passkey, and refuses a follow-up with none", async () => {
          const later = firefox(userAgent, { ...onePassword, prfAtCreate: false })
          const result = await later.run
          expect(result.chained?.credentialId).toBe(result.created.credentialId)
          expect(bytesToHex(result.prfOutput)).toBe(
            bytesToHex(later.ceremony.prfFor(result.created.credentialId, "second")),
          )
          const none = firefox(userAgent, {
            ...onePassword,
            prfAtCreate: false,
            prfAtAssert: false,
          })
          await expect(none.run).rejects.toMatchObject({ name: "NoPrfError", manager: "1password" })
          expect(none.ceremony.asserts).toHaveLength(1)
        })
      })
    }
  })

  it("refuses a manager a gate withdrew, and the unmeasured ones, with the local-route copy", async () => {
    const withdrawn = local({ manager: "gpm", aaguid: GPM_AAGUID }, { managers: ["apple"] })
    await expect(withdrawn.run).rejects.toThrow(
      expect.objectContaining({
        name: "UnsupportedProviderError",
        providerName: "Google Password Manager",
        message: expect.stringContaining("Apple Passwords, or use your phone instead"),
      }),
    )
    const hello = local({ aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96" })
    await expect(hello.run).rejects.toThrow(
      expect.objectContaining({
        name: "UnsupportedProviderError",
        providerName: "Windows Hello",
        message: expect.stringContaining("or use your phone instead"),
      }),
    )
    // A security key's id on this device's own answer is the contradiction the phone route
    // refuses too, with the row's managers named in place of the phone route's list.
    const keyId = local({ manager: "security-key", aaguid: YUBIKEY_5_USB_A_AAGUID })
    await expect(keyId.run).rejects.toThrow(
      expect.objectContaining({
        name: "UnsupportedProviderError",
        kind: "security-key",
        message: expect.stringContaining("Google Password Manager (sign in to Chrome first)"),
      }),
    )
  })

  it("keeps the backup and key-material gates, with the local-route copy", async () => {
    const bound = local({ manager: "gpm", aaguid: GPM_AAGUID, backupEligible: false })
    await expect(bound.run).rejects.toThrow(
      expect.objectContaining({
        name: "DeviceBoundPasskeyError",
        message: expect.stringContaining("or use your phone instead"),
      }),
    )
    const single = local({ manager: "gpm", aaguid: GPM_AAGUID, secondSlot: false })
    await expect(single.run).rejects.toThrow(
      expect.objectContaining({
        name: "SingleSaltProviderError",
        message: expect.stringContaining("or use your phone instead"),
      }),
    )
    const none = local({
      manager: "gpm",
      aaguid: GPM_AAGUID,
      prfAtCreate: false,
      prfAtAssert: false,
    })
    await expect(none.run).rejects.toThrow(
      expect.objectContaining({
        name: "NoPrfError",
        message: expect.stringContaining("or use your phone instead"),
      }),
    )
  })

  it("refuses another device's answer that is not a key, and an unreported one", async () => {
    for (const transports of [["hybrid", "internal"], undefined]) {
      const { ceremony, run } = create(
        "laptop",
        { route: "cross-device", aaguid: GPM_AAGUID, transports },
        { localCreation: macChrome },
      )
      await expect(run).rejects.toThrow(
        expect.objectContaining({ name: "LaptopPasskeyRefusedError", kind: "not-local" }),
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    }
    // Safari's row: a phone's Apple answer without its key, refused before any follow-up.
    const phoneApple = create(
      "laptop",
      {
        route: "cross-device",
        aaguid: APPLE_ICLOUD_AAGUID,
        transports: ["hybrid", "internal"],
        prfAtCreate: false,
      },
      { localCreation: { managers: ["apple", "1password"] } },
    )
    await expect(phoneApple.run).rejects.toThrow(
      expect.objectContaining({ name: "LaptopPasskeyRefusedError", kind: "not-local" }),
    )
    expect(phoneApple.ceremony.assertRequests).toHaveLength(0)
    const unreported = local({ attachment: null, aaguid: GPM_AAGUID })
    await expect(unreported.run).rejects.toThrow(
      expect.objectContaining({
        name: "PhoneRequiredError",
        message: expect.stringContaining("or use your phone instead"),
      }),
    )
  })

  it("refuses a follow-up answered by another device, though its hints name a key", async () => {
    const { ceremony, run } = create(
      "laptop",
      {
        route: "local",
        aaguid: GPM_AAGUID,
        prfAtCreate: false,
        assertAttachment: "cross-platform",
      },
      { localCreation: macChrome },
    )
    await expect(run).rejects.toThrow(
      expect.objectContaining({ name: "LaptopPasskeyRefusedError", kind: "not-local" }),
    )
    expect(ceremony.assertRequests[0]!.hints).toEqual(["client-device", "security-key"])
  })
})

describe("the follow-up prompt must answer with the passkey just made", () => {
  /** A ceremony holding a second passkey, which the follow-up will wrongly answer with. */
  async function withStrayPasskey(route: "local" | "cross-device", posture: DevicePosture) {
    let stray = ""
    const ceremony = new FakePasskeyCeremony({
      route,
      aaguid: GPM_AAGUID,
      prfAtCreate: false,
      assertOverride: () => stray,
    })
    stray = (
      await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@bob",
        ...(await prfSalts()),
      })
    ).credentialId
    const run = runPasskeyCreation(ceremony, {
      posture,
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      challengeForChained: () => CHALLENGE,
      ...(route === "local" && posture === "laptop"
        ? { localCreation: { managers: ["gpm"] } }
        : {}),
    })
    return { ceremony, run, stray }
  }

  it("refuses on every route, and signals only the passkey the creation wrote", async () => {
    let signalled: { credentialId: string }[] = []
    const original = (globalThis as Record<string, unknown>).PublicKeyCredential
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
      signalUnknownCredential: (options: { rpId: string; credentialId: string }) => {
        signalled.push(options)
        return Promise.resolve()
      },
    }
    try {
      for (const [route, posture] of [
        ["local", "laptop"],
        ["local", "phone"],
        ["cross-device", "laptop"],
      ] as const) {
        signalled = []
        const { ceremony, run, stray } = await withStrayPasskey(route, posture)
        await expect(run).rejects.toThrow(named("IncompleteCreationError"))
        const made = [...ceremony.creds.keys()].find((id) => id !== stray)!
        expect(signalled).toEqual([{ rpId: "localhost", credentialId: made }])
      }
    } finally {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = original
    }
  })
})

describe("runPasskeyCreation", () => {
  it("laptop: a phone's answer with both slots binds first", async () => {
    const { ceremony, run } = create("laptop", { route: "cross-device" })
    const result = await run
    expect(result.slot).toBe("first")
    expect(result.chained).toBeUndefined()
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
    expect(ceremony.creates[0]).toMatchObject({ authenticatorAttachment: "cross-platform" })
    // Opens on the phone, and names a key so a password manager's extension stands aside.
    expect(ceremony.creates[0]!.hints).toEqual(["hybrid", "security-key"])
    expect(ceremony.creates[0]!.prfSecondSalt).toHaveLength(32)
  })

  it("lets a laptop route that names a key leave the passkey unstored, and nothing else", async () => {
    const residentKey = async (
      posture: "laptop" | "phone",
      over: Partial<PasskeyCreationOptions> = {},
    ) => {
      const fake = create(posture, { route: posture === "laptop" ? "cross-device" : "local" }, over)
      await fake.run
      return fake.ceremony.creates[0]!.residentKey
    }
    expect(await residentKey("laptop")).toBe("preferred")
    expect(await residentKey("laptop", { laptopHints: ["security-key"] })).toBe("preferred")
    // The phone names a key too, but keeps the requirement; the hint-free build sends no hints.
    expect(await residentKey("phone")).toBe("required")
    expect(await residentKey("laptop", { laptopHints: null })).toBe("required")
  })

  it("phone: its own answer with both slots binds second, asking for no class and hinting both", async () => {
    const { ceremony, run } = create("phone", { route: "local" })
    const result = await run
    expect(result.slot).toBe("second")
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "second")),
    )
    // No class demanded, so the sheet can offer a key; the hints name the two it may answer with.
    expect(ceremony.creates[0]!.authenticatorAttachment).toBeUndefined()
    expect(ceremony.creates[0]!.hints).toEqual(["client-device", "security-key"])
  })

  it("gives a laptop's phone five minutes to answer, and names no timeout on a phone", async () => {
    const laptop = create("laptop", { route: "cross-device" })
    await laptop.run
    expect(laptop.ceremony.creates[0]!.timeoutMs).toBe(300_000)
    const phone = create("phone", { route: "local" })
    await phone.run
    expect(phone.ceremony.creates[0]!.timeoutMs).toBeUndefined()
  })

  it("hands the caller's signal to the creation and to its follow-up prompt", async () => {
    const controller = new AbortController()
    const { ceremony, run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false },
      { signal: controller.signal },
    )
    await run
    expect(ceremony.creates[0]!.signal).toBe(controller.signal)
    expect(ceremony.assertRequests[0]!.signal).toBe(controller.signal)
  })

  it("phone: a chained assertion answered by another device is refused", async () => {
    const { ceremony, run } = create("phone", {
      route: "local",
      prfAtCreate: false,
      assertAttachment: "cross-platform",
    })
    await expect(run).rejects.toThrow(named("LocalPasskeyRequiredError"))
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("waits for the observer on the chained phase before checking its route", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const observing = new Promise<void>((resolve) => (entered = resolve))
    const { run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false, assertAttachment: "platform" },
      {
        observe: async (event) => {
          if (event.phase !== "chained") return
          entered()
          await gate
        },
      },
    )
    let settled = false
    run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await observing
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("incomplete creation chains an assertion for the same credential with the caller's challenge", async () => {
    const phases: string[] = []
    const { ceremony, run } = create(
      "laptop",
      { route: "cross-device", prfAtCreate: false, createAuthData: false },
      { observe: async (event) => void phases.push(event.phase) },
    )
    const result = await run
    expect(result.chained).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      challenge: CHALLENGE,
    })
    // Asked over the same routes as the creation.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["hybrid", "security-key"])
    expect(ceremony.assertRequests[0]!.prfSecondSalt).toHaveLength(32)
    expect(phases).toEqual(["created", "chained"])
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  it("a security key's chained assertion goes back to the key, never to the phone sheet", async () => {
    const { ceremony, run } = create("laptop", {
      route: "cross-device",
      manager: "security-key",
      transports: ["usb"],
      backupEligible: false,
      aaguid: YUBIKEY_5_USB_A_AAGUID,
      prfAtCreate: false,
    })
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.chained).toBeDefined()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      hints: ["security-key"],
      transports: ["usb"],
    })
  })

  it("an unmeasured manager is refused by name before the chained assertion", async () => {
    const { ceremony, run } = create("laptop", {
      route: "cross-device",
      aaguid: BITWARDEN,
      prfAtCreate: false,
    })
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      kind: "manager",
      providerName: "Bitwarden",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("refuses an unmeasured manager it cannot name, without inventing one", async () => {
    const { run } = create("laptop", { route: "cross-device", aaguid: UNMEASURED })
    await expect(run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      providerName: undefined,
    })
  })

  it("offers a security key as the alternative", async () => {
    const keyOffered = new UnsupportedProviderError("manager", {
      providerName: "Bitwarden",
      keyOfferable: true,
    }).message
    const { run } = create("laptop", { route: "cross-device", aaguid: BITWARDEN })
    await expect(run).rejects.toMatchObject({ message: keyOffered })
  })

  it("admits a measured manager, an absent id, and one the caller lists", async () => {
    const measured = await create("laptop", { route: "cross-device", aaguid: GPM_AAGUID }).run
    expect(measured.created.aaguid).toBe(GPM_AAGUID)
    const absent = await create("laptop", { route: "cross-device" }).run
    expect(absent.created.aaguid).toBeUndefined()
    const listed = await runPasskeyCreation(
      new FakePasskeyCeremony({ route: "cross-device", aaguid: UNMEASURED }),
      {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        extraProviders: [UNMEASURED],
        challengeForChained: () => CHALLENGE,
      },
    )
    expect(listed.created.aaguid).toBe(UNMEASURED)
  })

  it("a passkey that cannot be backed up, or whose flags stay unreadable, is refused after the chain", async () => {
    const bound = create("laptop", { route: "cross-device", backupEligible: false })
    await expect(bound.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    const unknown = create("laptop", { route: "cross-device", backupEligible: "unknown" })
    await expect(unknown.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    expect(unknown.ceremony.assertRequests).toHaveLength(1)
  })

  it("the observer sees the raw result, and is awaited, before a refusal is thrown", async () => {
    const seen: ObservedCeremony[] = []
    let settled = false
    const { run } = create(
      "laptop",
      { route: "local", aaguid: UNMEASURED },
      {
        observe: async (event) => {
          seen.push(event)
          await new Promise((resolve) => setTimeout(resolve, 5))
          settled = true
        },
      },
    )
    await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    expect(settled).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.phase).toBe("created")
    expect((seen[0]!.result as { aaguid?: string }).aaguid).toBe(UNMEASURED)
  })

  it("a laptop sends no hints when the consumer's null asks for none", async () => {
    const quiet = new FakePasskeyCeremony({ route: "cross-device", prfAtCreate: false })
    await runPasskeyCreation(quiet, {
      posture: "laptop",
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      laptopHints: null,
      challengeForChained: () => CHALLENGE,
    })
    expect(quiet.creates[0]!.hints).toBeUndefined()
    expect(quiet.assertRequests[0]!.hints).toBeUndefined()
  })

  it("asks for a handle that says where the request was made: the page's OS, and the route it asked for", async () => {
    const chromeMac = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      userAgentData: {
        platform: "macOS",
        platformVersion: "26.4.1",
        architecture: "arm",
        brands: [],
      },
    })
    const chromeAndroid = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
      userAgentData: {
        platform: "Android",
        platformVersion: "15.0.0",
        architecture: "arm",
        brands: [],
      },
    })
    const cases = [
      // A laptop asking for a phone claims the route only: the phone is not this device.
      [
        create("laptop", { route: "cross-device" }, { userAgent: chromeMac }),
        { context: "mac_qr", ...NO_CLAIMS },
      ],
      [
        create("laptop", { route: "cross-device" }, { userAgent: chromeMac, laptopHints: null }),
        UNKNOWN_PROVENANCE,
      ],
      [
        create("phone", { route: "local" }, { userAgent: chromeAndroid }),
        { context: "android_browser", osVersion: { major: 15, minor: 0, patch: 0 }, chip: "arm" },
      ],
      [create("phone", { route: "local" }), { context: "phone_other", ...NO_CLAIMS }],
    ] as const
    for (const [{ ceremony, run }, provenance] of cases) {
      await run
      expect(ceremony.creates[0]!.provenance).toEqual(provenance)
    }
  })
})

describe("a browser that mislabels a cross-device answer", () => {
  /** iCloud Keychain on the phone, reached over QR, labelled as the laptop's own. */
  const applePhone = (over: FakeCeremonyOptions = {}): FakeCeremonyOptions => ({
    route: "cross-device",
    manager: "icloud",
    aaguid: APPLE_ICLOUD_AAGUID,
    transports: ["hybrid", "internal"],
    attachment: "platform",
    ...over,
  })
  const on = { misreportsCrossDevice: true }

  it.each([
    ["Apple's answer", {}],
    ["Apple's answer with no label", { attachment: null }],
    ["1Password on the phone", { manager: "1password", aaguid: ONEPASSWORD_AAGUID }],
    ["Google Password Manager on the phone", { manager: "gpm", aaguid: GPM_AAGUID }],
  ] as const)(
    "laptop: reads %s as another device and binds the cell a Chrome QR read reproduces",
    async (_, over) => {
      const { ceremony, run } = create("laptop", applePhone(over), on)
      const result = await run
      expect(result.slot).toBe("first")
      expect(result.securityKey).toBe(false)
      expect(result.created.authenticatorAttachment).toBe("cross-platform")
      expect(ceremony.assertRequests).toHaveLength(0)
      expect(bytesToHex(result.prfOutput)).toBe(
        bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
      )
    },
  )

  it("laptop: a corrected answer missing key material or flags is refused, never followed up", async () => {
    const noPrf = create("laptop", applePhone({ prfAtCreate: false }), on)
    await expect(noPrf.run).rejects.toThrow(named("IncompleteCreationError"))
    expect(noPrf.ceremony.assertRequests).toHaveLength(0)
    const noFlags = create("laptop", applePhone({ backupEligible: "unknown" }), on)
    await expect(noFlags.run).rejects.toThrow(named("IncompleteCreationError"))
    expect(noFlags.ceremony.assertRequests).toHaveLength(0)
  })

  it("laptop: a correctly labelled Apple answer keeps the follow-up path", async () => {
    const { ceremony, run } = create(
      "laptop",
      applePhone({ attachment: "cross-platform", prfAtCreate: false }),
      on,
    )
    const result = await run
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
    // And that follow-up is never corrected: a mislabelled one is refused as before.
    const chained = create(
      "laptop",
      applePhone({
        attachment: "cross-platform",
        prfAtCreate: false,
        assertAttachment: "platform",
      }),
      on,
    )
    await expect(chained.run).rejects.toThrow(named("PhoneRequiredError"))
    expect(chained.ceremony.assertRequests).toHaveLength(1)
  })

  it("laptop: the transports must include the phone route, whatever the id says", async () => {
    // A key's transports, or a browser that attests nothing about the credential.
    for (const transports of [undefined, ["internal"], ["usb"]]) {
      const { run } = create("laptop", applePhone({ route: "local", transports }), on)
      await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    }
  })

  it("laptop: a local manager answer under an admitted id passes the gate and binds a cell no QR read reproduces", async () => {
    // Transports list what the credential can be reached over, not which route answered, and the
    // id is self-reported. Pinned as the accepted limit of the gate, not as a behaviour to keep.
    const local = [
      { manager: "1password", aaguid: APPLE_ICLOUD_AAGUID },
      { manager: "gpm", aaguid: APPLE_ICLOUD_AAGUID },
      { manager: "1password", aaguid: ONEPASSWORD_AAGUID },
      { manager: "gpm", aaguid: GPM_AAGUID },
    ] as const
    for (const over of local) {
      const answer = applePhone({ ...over, route: "local", transports: ["internal", "hybrid"] })
      const { run, ceremony } = create("laptop", answer, on)
      const result = await run
      expect(result.slot).toBe("first")
      const id = result.created.credentialId
      const bound = bytesToHex(result.prfOutput)
      expect(bytesToHex(ceremony.prfFor(id, "first", "cross-device"))).not.toBe(bound)
      expect(bytesToHex(ceremony.prfFor(id, "second", "cross-device"))).not.toBe(bound)
    }
  })

  it("laptop: without the flag the mislabel is refused as before", async () => {
    await expect(create("laptop", applePhone()).run).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("laptop: an absent, zero or unmeasured id is not corrected", async () => {
    for (const aaguid of [undefined, ZERO_AAGUID, BITWARDEN]) {
      const { run } = create("laptop", applePhone({ aaguid }), on)
      await expect(run).rejects.toThrow(named("PhoneRequiredError"))
    }
  })

  it("laptop: a security key is never corrected", async () => {
    const key = (over: FakeCeremonyOptions = {}) => ({
      route: "cross-device" as const,
      manager: "security-key" as const,
      transports: ["usb"],
      backupEligible: false as const,
      aaguid: YUBIKEY_5_USB_A_AAGUID,
      ...over,
    })
    await expect(create("laptop", key({ attachment: "platform" }), on).run).rejects.toThrow(
      named("PhoneRequiredError"),
    )
    // Labelled correctly, a key still chains and is held to its own class there, flag or not.
    const mixed = create("laptop", key({ prfAtCreate: false, assertAttachment: "platform" }), on)
    await expect(mixed.run).rejects.toThrow(named("SecurityKeyRequiredError"))
  })

  it("phone: nothing changes", async () => {
    const local = await create("phone", { route: "local", aaguid: APPLE_ICLOUD_AAGUID }, on).run
    expect(local.slot).toBe("second")
    expect(local.created.authenticatorAttachment).toBe("platform")
    await expect(create("phone", { route: "cross-device" }, on).run).rejects.toThrow(
      named("LocalPasskeyRequiredError"),
    )
  })

  it("the observer's object keeps the reported label; the returned one is corrected", async () => {
    const seen: ObservedCeremony[] = []
    const { run } = create("laptop", applePhone(), {
      ...on,
      observe: (event) => void seen.push(event),
    })
    const result = await run
    expect(seen).toHaveLength(1)
    expect(seen[0]!.result.authenticatorAttachment).toBe("platform")
    expect(result.created.authenticatorAttachment).toBe("cross-platform")
  })
})

describe("naming what answered a refused laptop sign-up", () => {
  const WINDOWS_HELLO_AAGUIDS = [
    "08987058-cadc-4b81-b6e1-30de50dcbe96",
    "9ddd1817-af5a-4672-a2b9-3e3dd95000a9",
    "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
  ]
  const trusted = { attachmentLabelTrusted: true }
  // A sign-up with no name to give says where to create the passkey.
  const unnamed = new PhoneRequiredError({ ceremony: "create" }).message

  it.each([
    [BITWARDEN, "Bitwarden"],
    ...WINDOWS_HELLO_AAGUIDS.map((aaguid) => [aaguid, WINDOWS_HELLO]),
    // A desktop-mode Android phone counts as a laptop, and its local answer is on the phone.
    [GPM_AAGUID, "Google Password Manager"],
  ])("names the manager that answered on this device: %s", async (aaguid, providerName) => {
    const { ceremony, run } = create("laptop", { route: "local", aaguid }, trusted)
    await expect(run).rejects.toMatchObject({ name: "PhoneRequiredError", providerName })
    expect(ceremony.assertRequests).toHaveLength(0)
  })

  it("names nothing it cannot identify", async () => {
    for (const aaguid of [UNMEASURED, ZERO_AAGUID, undefined]) {
      const { run } = create("laptop", { route: "local", aaguid }, trusted)
      await expect(run).rejects.toMatchObject({ providerName: undefined, message: unnamed })
    }
  })

  it("names nothing unless the browser's label is trusted", async () => {
    for (const extra of [
      {},
      { attachmentLabelTrusted: false },
      { ...trusted, misreportsCrossDevice: true },
    ]) {
      const { run } = create("laptop", { route: "local", aaguid: BITWARDEN }, extra)
      await expect(run).rejects.toMatchObject({ providerName: undefined })
    }
  })

  it("names nothing when the browser did not say which device answered", async () => {
    const { run } = create(
      "laptop",
      { route: "local", aaguid: BITWARDEN, attachment: null },
      trusted,
    )
    await expect(run).rejects.toMatchObject({ name: "PhoneRequiredError", providerName: undefined })
  })

  it("names nothing for a security key's id labelled as this device", async () => {
    const { run } = create(
      "laptop",
      { route: "local", manager: "security-key", aaguid: YUBIKEY_5_USB_A_AAGUID },
      trusted,
    )
    await expect(run).rejects.toMatchObject({ providerName: undefined })
  })

  it("names nothing for the follow-up prompt, which names the credential and not the device", async () => {
    for (const [manager, aaguid] of [
      ["icloud", APPLE_ICLOUD_AAGUID],
      ["gpm", GPM_AAGUID],
      ["1password", ONEPASSWORD_AAGUID],
    ] as const) {
      const { ceremony, run } = create(
        "laptop",
        {
          route: "cross-device",
          manager,
          aaguid,
          prfAtCreate: false,
          assertAttachment: "platform",
        },
        trusted,
      )
      await expect(run).rejects.toMatchObject({
        name: "PhoneRequiredError",
        providerName: undefined,
      })
      expect(ceremony.assertRequests).toHaveLength(1)
    }
  })
})

describe("the line a Bitwarden answer's refusal adds on a laptop", () => {
  const line = bitwardenLineFor("wallet.test.zk.money")
  const DASHLANE = "531126d6-e717-415c-9320-3d9aa6981239"
  const trusted = { attachmentLabelTrusted: true }
  const macChrome = { managers: ["apple", "gpm"] as const }
  const refusal = (run: Promise<unknown>): Promise<Error> =>
    run.then(
      () => {
        throw new Error("expected a refusal")
      },
      (err: Error) => err,
    )
  /** A creation answered by a script, as an extension's is, or by the browser's own prompt. */
  const answering = (extension: boolean) =>
    vi.stubGlobal("navigator", {
      credentials: { create: extension ? async () => null : Object.create },
    })

  beforeEach(() => {
    vi.stubGlobal("location", { hostname: "wallet.test.zk.money" })
    answering(true)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("ends the phone and key routes' refusal with it", async () => {
    for (const laptopHints of [undefined, ["security-key"] as const]) {
      const err = await refusal(
        create("laptop", { route: "local", aaguid: BITWARDEN }, { ...trusted, laptopHints }).run,
      )
      expect(err).toMatchObject({ name: "PhoneRequiredError", providerName: "Bitwarden" })
      expect(err.message).toContain(line)
    }
  })

  it("follows the id where the browser's label is untrusted and no manager is named", async () => {
    const err = await refusal(
      create("laptop", { route: "local", aaguid: BITWARDEN }, { attachmentLabelTrusted: false })
        .run,
    )
    expect(err).toMatchObject({ name: "PhoneRequiredError", providerName: undefined })
    expect(err.message).toContain(line)
  })

  it("ends the provider refusal with it on this computer's route and off it", async () => {
    for (const [route, extra] of [
      ["local", { localCreation: macChrome }],
      ["cross-device", {}],
    ] as const) {
      const err = await refusal(create("laptop", { route, aaguid: BITWARDEN }, extra).run)
      expect(err.name).toBe("UnsupportedProviderError")
      expect(err.message).toContain(line)
    }
  })

  it("ends Bitwarden's refusal of a related origin with it, though nothing was created", async () => {
    const browserError = new Error("'rp.id' cannot be used with the current origin")
    const refusedBy = (posture: DevicePosture, bitwarden: boolean) => {
      const ceremony = new FakePasskeyCeremony({ route: "local" })
      ceremony.create = async () => {
        throw new RelatedOriginPasskeyError(browserError, { bitwarden })
      }
      return refusal(
        runPasskeyCreation(ceremony, {
          posture,
          rpId: "auth.zk.money",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => CHALLENGE,
        }),
      )
    }
    const onLaptop = await refusedBy("laptop", true)
    expect(onLaptop).toBeInstanceOf(RelatedOriginPasskeyError)
    expect(onLaptop.message).toContain(line)
    expect(onLaptop.cause).toBe(browserError)
    expect(passkeyWritten(onLaptop)).toBe(false)
    expect((await refusedBy("phone", true)).message).not.toContain(line)
    expect((await refusedBy("laptop", false)).message).not.toContain(line)
    answering(false)
    expect((await refusedBy("laptop", true)).message).not.toContain(line)
  })

  it("is not added on a phone", async () => {
    const err = await refusal(create("phone", { route: "local", aaguid: BITWARDEN }).run)
    expect(err.name).toBe("UnsupportedProviderError")
    expect(err.message).not.toContain(line)
  })

  it.each([
    ["no extension answers the page's creation", BITWARDEN, false],
    ["another manager's id answered", DASHLANE, true],
  ])("is not added where %s", async (_, aaguid, extension) => {
    answering(extension)
    for (const [extra, name] of [
      [trusted, "PhoneRequiredError"],
      [{ localCreation: macChrome }, "UnsupportedProviderError"],
    ] as const) {
      const err = await refusal(create("laptop", { route: "local", aaguid }, extra).run)
      expect(err.name).toBe(name)
      expect(err.message).not.toContain(line)
    }
  })
})

describe("the fake's security key", () => {
  it("applies the browser's contextualisation once on either route, and nothing of its own", () => {
    // Asserted against the primitives, not against the fake's own table: every other key test
    // compares the driver's output to `prfFor`, which reads that table, so a wrong model would
    // agree with itself. This is the only statement of how a hardware key derives.
    const secret = new Uint8Array(32).fill(3)
    const salt = new Uint8Array(32).fill(4)
    const once = hmac(nobleSha256, secret, contextualiseLocal(salt))
    for (const route of ["local", "cross-device"] as const) {
      expect(fakePrf(secret, salt, "security-key", route)).toEqual(once)
    }
  })
})

describe("security keys at creation", () => {
  /** A roaming key: another device's answer over physical transports, and no backup by design. */
  const key = (over: FakeCeremonyOptions = {}) => ({
    route: "cross-device" as const,
    manager: "security-key" as const,
    transports: ["usb"],
    backupEligible: false as const,
    ...over,
  })

  it("skips the backup gate, chains for the PRF a key withholds, and binds first", async () => {
    const { ceremony, run } = create("laptop", key({ prfAtCreate: false }))
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  // Firmware that evaluates key material at creation skips the chain: the driver branches on the
  // evidence being complete, never on the class.
  it.each(["laptop", "phone"] as const)(
    "%s: needs no chained assertion when the key answers at creation",
    async (posture) => {
      const { ceremony, run } = create(posture, key({ transports: ["nfc", "usb"] }))
      const result = await run
      expect(result.securityKey).toBe(true)
      expect(result.slot).toBe("first")
      expect(ceremony.assertRequests).toHaveLength(0)
    },
  )

  it("a phone over QR is not a key, so its backup flag still decides", async () => {
    const viaPhone = { route: "cross-device" as const, transports: ["hybrid", "internal"] }
    const ok = await create("laptop", { ...viaPhone, backupEligible: true }).run
    expect(ok.securityKey).toBe(false)
    expect(ok.slot).toBe("first")
    for (const transports of [["hybrid", "internal"], ["usb", "something-new"], undefined]) {
      const { run } = create("laptop", {
        route: "cross-device",
        transports,
        backupEligible: false,
      })
      await expect(run).rejects.toThrow(named("DeviceBoundPasskeyError"))
    }
  })

  describe("a key the browser lists no transports for", () => {
    /** Chrome's shape for a Trezor, and for a Ledger: an empty list and an id attested as zeros. */
    const trezor = (over: FakeCeremonyOptions = {}) =>
      key({ transports: [], aaguid: ZERO_AAGUID, ...over })

    it("is a key on the zero id: admitted, binding first, asked again without transports", async () => {
      const complete = create("laptop", trezor())
      const atCreate = await complete.run
      expect(atCreate.securityKey).toBe(true)
      expect(complete.ceremony.assertRequests).toHaveLength(0)
      expect(atCreate.slot).toBe("first")
      expect(atCreate.created.aaguid).toBeUndefined()
      expect(atCreate.created.attestedAaguid).toBe(ZERO_AAGUID)

      // A Ledger: no PRF at creation, and a passkey it did not store, so the creation must have
      // allowed one and the follow-up must name it.
      const { ceremony, run } = create("laptop", trezor({ prfAtCreate: false }))
      const chained = await run
      expect(chained.securityKey).toBe(true)
      expect(chained.slot).toBe("first")
      expect(ceremony.creates[0]!.residentKey).toBe("preferred")
      expect(ceremony.assertRequests).toHaveLength(1)
      expect(ceremony.assertRequests[0]).toMatchObject({
        credentialIds: [chained.created.credentialId],
        hints: ["security-key"],
      })
      expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    })

    it("stays refused when nothing was attested, or when any id was reported", async () => {
      const unattested = create(
        "laptop",
        trezor({ backupEligible: "unknown", createAuthData: false }),
      )
      await expect(unattested.run).rejects.toThrow(named("DeviceBoundPasskeyError"))
      for (const aaguid of [APPLE_ICLOUD_AAGUID, GPM_AAGUID]) {
        const { run } = create("laptop", trezor({ aaguid }))
        await expect(run).rejects.toThrow(named("DeviceBoundPasskeyError"))
      }
      // A key's own id on an empty list is a phone to the class, so the manager gate refuses it.
      const yubikey = create("laptop", trezor({ aaguid: YUBIKEY_5_USB_A_AAGUID }))
      await expect(yubikey.run).rejects.toThrow(named("UnsupportedProviderError"))
    })

    it("gets the key's refusal when it returns no PRF on either ceremony", async () => {
      const { run } = create("laptop", trezor({ prfAtCreate: false, prfAtAssert: false }))
      await expect(run).rejects.toThrow(named("SecurityKeyNoPrfError"))
    })
  })

  describe("asking the authenticator to take back the credential a failed creation wrote", () => {
    let signalled: { rpId: string; credentialId: string }[]
    let original: unknown

    beforeEach(() => {
      signalled = []
      original = (globalThis as Record<string, unknown>).PublicKeyCredential
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
        signalUnknownCredential: (options: { rpId: string; credentialId: string }) => {
          signalled.push(options)
          return Promise.resolve()
        },
      }
    })

    afterEach(() => {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = original
    })

    /** One ask, for the id the ceremony actually minted, not merely some string. */
    const askedFor = (ceremony: FakePasskeyCeremony) => [
      { rpId: "localhost", credentialId: [...ceremony.creds.keys()][0]! },
    ]

    it("asks once on every refusal, with exactly the id that creation just wrote", async () => {
      // Deleting is irreversible. Each refusal is named, so a case that starts failing for a new
      // reason cannot pass by accident.
      const onThisComputer = { localCreation: { managers: ["gpm"] as const } }
      const refused: [FakeCeremonyOptions, DevicePosture, string, Parameters<typeof create>[2]?][] =
        [
          [key({ prfAtCreate: false, prfAtAssert: false }), "phone", "SecurityKeyNoPrfError"],
          // This computer's route: the manager the row leaves out, one that withheld its id, another
          // device answering, and an unsupported one.
          [
            { route: "local", aaguid: APPLE_ICLOUD_AAGUID },
            "laptop",
            "LaptopPasskeyRefusedError",
            onThisComputer,
          ],
          [{ route: "local" }, "laptop", "LaptopPasskeyRefusedError", onThisComputer],
          [
            { route: "cross-device", aaguid: GPM_AAGUID, transports: ["hybrid"] },
            "laptop",
            "LaptopPasskeyRefusedError",
            onThisComputer,
          ],
          [
            { route: "local", aaguid: BITWARDEN },
            "laptop",
            "UnsupportedProviderError",
            onThisComputer,
          ],
          [{ route: "local", prfAtCreate: false, prfAtAssert: false }, "phone", "NoPrfError"],
          [{ route: "local", secondSlot: false }, "phone", "SingleSaltProviderError"],
          [
            key({ backupEligible: "unknown", createAuthData: false }),
            "laptop",
            "DeviceBoundPasskeyError",
          ],
          [{ route: "local", aaguid: BITWARDEN }, "phone", "UnsupportedProviderError"],
          // An unsupported security key, not just an unsupported manager.
          [key({ aaguid: BITWARDEN }), "phone", "UnsupportedProviderError"],
          [{ route: "cross-device" }, "phone", "LocalPasskeyRequiredError"],
          [
            key({ assertAttachment: "platform", prfAtCreate: false }),
            "phone",
            "SecurityKeyRequiredError",
          ],
          [{ route: "local" }, "laptop", "PhoneRequiredError"],
          // A phone's answer the laptop mislabelled, corrected, then incomplete.
          [
            {
              route: "cross-device",
              manager: "icloud",
              aaguid: APPLE_ICLOUD_AAGUID,
              transports: ["hybrid", "internal"],
              attachment: "platform",
              prfAtCreate: false,
            },
            "laptop",
            "IncompleteCreationError",
            { misreportsCrossDevice: true },
          ],
        ]
      // Built and awaited one at a time: a batch started up front leaves rejections unhandled.
      for (const [fake, posture, name, extra] of refused) {
        signalled = []
        const { ceremony, run } = create(posture, fake, extra)
        const err: unknown = await run.then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(err, name).toEqual(named(name))
        expect(passkeyWritten(err), name).toBe(true)
        expect(signalled, name).toEqual(askedFor(ceremony))
      }
    })

    it("asks when the follow-up prompt fails, and throws that prompt's own error", async () => {
      const thrown = new DOMException("Dismissed", "NotAllowedError")
      const { ceremony, run } = create("laptop", {
        route: "cross-device",
        prfAtCreate: false,
        assertOverride: () => {
          throw thrown
        },
      })
      await expect(run).rejects.toBe(thrown)
      expect(passkeyWritten(thrown)).toBe(true)
      expect(signalled).toEqual(askedFor(ceremony))
    })

    it("asks when the caller's own code fails after the credential was written", async () => {
      const boom = new Error("observer")
      const onCreated = create(
        "laptop",
        { route: "cross-device" },
        {
          observe: ({ phase }) => {
            if (phase === "created") throw boom
          },
        },
      )
      await expect(onCreated.run).rejects.toBe(boom)
      expect(passkeyWritten(boom)).toBe(true)
      expect(signalled).toEqual(askedFor(onCreated.ceremony))

      signalled = []
      const onChained = create(
        "laptop",
        { route: "cross-device", prfAtCreate: false },
        {
          observe: ({ phase }) => {
            if (phase === "chained") throw boom
          },
        },
      )
      await expect(onChained.run).rejects.toBe(boom)
      expect(signalled).toEqual(askedFor(onChained.ceremony))

      // A challenge that rejects with a bare string: nothing to mark, and still one ask.
      signalled = []
      const ceremony = new FakePasskeyCeremony({ route: "cross-device", prfAtCreate: false })
      await expect(
        runPasskeyCreation(ceremony, {
          posture: "laptop",
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => Promise.reject("offline"),
        }),
      ).rejects.toBe("offline")
      expect(signalled).toEqual(askedFor(ceremony))
    })

    it("asks, and returns no keys, when the caller ended a creation the browser still answered", async () => {
      // The fake answers whatever its signal says, as a browser that ignores an abort does.
      const before = new AbortController()
      before.abort()
      const late = create("laptop", { route: "cross-device" }, { signal: before.signal })
      await expect(late.run).rejects.toBe(before.signal.reason)
      expect(signalled).toEqual(askedFor(late.ceremony))

      signalled = []
      const during = new AbortController()
      const observed = create(
        "laptop",
        { route: "cross-device" },
        { signal: during.signal, observe: () => during.abort() },
      )
      await expect(observed.run).rejects.toThrow(named("AbortError"))
      expect(signalled).toEqual(askedFor(observed.ceremony))
    })

    it("a refusal before any prompt reaches the caller as the ceremony's own error, hold and all", async () => {
      const onThisComputer = {
        localCreation: { managers: ["gpm"] as const },
        attachmentLabelTrusted: true,
      }
      for (const [posture, extra, attachment] of [
        ["laptop", {}, "cross-platform"],
        ["laptop", onThisComputer, "platform"],
        ["phone", {}, undefined],
      ] as const) {
        const refused = new DOMException("Dismissed", "NotAllowedError")
        recordRequestHeld(refused, 40)
        const ceremony = new FakePasskeyCeremony({})
        let asked: PasskeyCreateRequest | undefined
        ceremony.create = async (request) => {
          asked = request
          throw refused
        }
        await expect(
          runPasskeyCreation(ceremony, {
            posture,
            rpId: "localhost",
            rpName: "zk.money",
            userName: "@alice",
            challengeForChained: () => CHALLENGE,
            ...extra,
          }),
        ).rejects.toBe(refused)
        expect(asked?.authenticatorAttachment).toBe(attachment)
        expect(isBlockedPromptError(refused)).toBe(true)
        expect(signalled).toEqual([])
      }
    })

    it("asks for nothing when a creation succeeds, never answered, or on a sign-in", async () => {
      await create("phone", key()).run
      await create("phone", { route: "local" }).run
      await create("laptop", key({ prfAtCreate: false })).run
      // The browser gave no credential back, so there is no id to name.
      const unanswered = new FakePasskeyCeremony({ route: "cross-device" })
      unanswered.create = async () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      }
      await expect(
        runPasskeyCreation(unanswered, {
          posture: "laptop",
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => CHALLENGE,
        }),
      ).rejects.toThrow(named("NotAllowedError"))
      // And a sign-in that fails its own route check never reaches this code at all.
      const signIn = create("laptop", { route: "cross-device" })
      const made = await signIn.run
      signIn.ceremony.opts.route = "local"
      await expect(
        runPasskeyAssertion(signIn.ceremony, {
          posture: "laptop",
          rpId: "localhost",
          challenge: CHALLENGE,
          credentialIds: [made.created.credentialId],
        }),
      ).rejects.toThrow(named("PhoneRequiredError"))
      expect(signalled).toHaveLength(0)
    })

    it.each([
      ["the browser has no way to ask", {}],
      ["the ask is rejected", { signalUnknownCredential: () => Promise.reject(new Error("nope")) }],
    ])("still refuses when %s", async (_, api) => {
      ;(globalThis as Record<string, unknown>).PublicKeyCredential = api
      const { run } = create("phone", key({ prfAtCreate: false, prfAtAssert: false }))
      await expect(run).rejects.toThrow(named("SecurityKeyNoPrfError"))
    })

    it("is made from one place in the package, called only by the creation drivers", () => {
      const src = join(dirname(fileURLToPath(import.meta.url)), "../src")
      const read = (file: string) => readFileSync(join(src, file), "utf8")
      const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) =>
        file.endsWith(".ts"),
      )
      expect(files.filter((file) => read(file).includes("signalUnknownCredential"))).toEqual([
        "drivers.ts",
      ])
      const drivers = read("drivers.ts")
      expect(drivers.match(/signalUnknownCredential\(/g)).toHaveLength(1)
      // The definition, one call in each creation driver's catch, and the backup driver's call for
      // a creation the browser saved but the wallet could not read.
      expect(drivers.match(/forgetCredential\(/g)).toHaveLength(4)
    })
  })

  it("a phone accepts a key, binding first through the chained assertion a key needs", async () => {
    const { ceremony, run } = create("phone", key({ prfAtCreate: false }))
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
  })

  it("refuses a creation whose attachment the browser never reported, on either posture", async () => {
    for (const posture of ["phone", "laptop"] as const) {
      const { run } = create(posture, key({ attachment: null }))
      await expect(run).rejects.toThrow(
        expect.objectContaining({ name: expect.stringMatching(/RequiredError$/) }),
      )
    }
    // And the same on the chained half, where the class is already known to be a key.
    const chained = create("phone", key({ prfAtCreate: false, assertAttachment: null }))
    await expect(chained.run).rejects.toThrow(named("SecurityKeyRequiredError"))
  })

  it.each([
    ["reporting a manager's id", key({ aaguid: GPM_AAGUID })],
    // Classed as a phone, so the backup gate applied; the orphan is still on the key.
    [
      "whose transports were withheld",
      { route: "cross-device", aaguid: YUBIKEY_5_USB_A_AAGUID, backupEligible: true },
    ],
  ] as const)("refuses a key %s with the key's own refusal", async (_, fake) => {
    await expect(create("laptop", fake).run).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      kind: "security-key",
    })
  })
})

describe("renamePasskey", () => {
  type Details = { rpId: string; userId: string; name: string; displayName: string }
  const HANDLE = new Uint8Array([0x61, 0x00, 0x01, 0x02])
  let original: unknown

  beforeEach(() => {
    original = (globalThis as Record<string, unknown>).PublicKeyCredential
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = original
  })

  it("relabels the passkey under its handle with the new name", () => {
    const sent: Details[] = []
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
      signalCurrentUserDetails: (details: Details) => {
        sent.push(details)
        return Promise.resolve()
      },
    }
    renamePasskey("localhost", HANDLE, "niall")
    expect(sent).toEqual([
      { rpId: "localhost", userId: bytesToBase64Url(HANDLE), name: "niall", displayName: "niall" },
    ])
  })

  it("never throws: no call, a rejected call, or a call that throws", async () => {
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = {}
    expect(() => renamePasskey("localhost", HANDLE, "niall")).not.toThrow()
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
      signalCurrentUserDetails: () => Promise.reject(new Error("nope")),
    }
    expect(() => renamePasskey("localhost", HANDLE, "niall")).not.toThrow()
    ;(globalThis as Record<string, unknown>).PublicKeyCredential = {
      signalCurrentUserDetails: () => {
        throw new Error("nope")
      },
    }
    expect(() => renamePasskey("localhost", HANDLE, "niall")).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})

describe("the written mark", () => {
  const rejection = async (run: Promise<unknown>): Promise<unknown> => {
    try {
      await run
    } catch (err) {
      return err
    }
    throw new Error("expected a rejection")
  }

  it("marks nothing on the assertion side: the driver's refusal, or the one read from its result", async () => {
    const assertion = async (posture: DevicePosture, fake: FakeCeremonyOptions) => {
      const ceremony = new FakePasskeyCeremony(fake)
      const created = await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      return runPasskeyAssertion(ceremony, {
        posture,
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
      })
    }
    const local = await rejection(assertion("laptop", { route: "local" }))
    expect(local).toMatchObject({ name: "PhoneRequiredError" })
    expect(passkeyWritten(local)).toBe(false)

    const raw = await assertion("phone", { route: "local", backupEligible: false })
    let bound: unknown
    try {
      candidatesFrom(raw)
    } catch (err) {
      bound = err
    }
    expect(bound).toMatchObject({ name: "DeviceBoundPasskeyError" })
    expect(passkeyWritten(bound)).toBe(false)
  })
})

describe("runPasskeyAssertion", () => {
  async function assertion(posture: DevicePosture, fake: FakeCeremonyOptions) {
    const ceremony = new FakePasskeyCeremony(fake)
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const phases: string[] = []
    const result = runPasskeyAssertion(ceremony, {
      posture,
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      observe: (event) => void phases.push(event.phase),
    })
    return { ceremony, created, result, phases }
  }

  it("phone: another device's answer is returned and yields both candidates", async () => {
    const { ceremony, created, result, phases } = await assertion("phone", {
      route: "cross-device",
    })
    const raw = await result
    expect(phases).toEqual(["asserted"])
    const candidates = candidatesFrom(raw)
    expect(bytesToHex(candidates.first!)).toBe(
      bytesToHex(ceremony.prfFor(created.credentialId, "first")),
    )
    expect(bytesToHex(candidates.second!)).toBe(
      bytesToHex(ceremony.prfFor(created.credentialId, "second")),
    )
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [created.credentialId],
      challenge: CHALLENGE,
    })
    expect(ceremony.assertRequests[0]!.hints).toBeUndefined()
  })

  it("the caller's signal reaches the ceremony", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const controller = new AbortController()
    await runPasskeyAssertion(ceremony, {
      posture: "phone",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      signal: controller.signal,
    })
    expect(ceremony.assertRequests[0]!.signal).toBe(controller.signal)
  })

  it("laptop: the record's transports reach the ceremony, minus the device's own", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid", "internal"],
    })
    expect(ceremony.assertRequests[0]!.transports).toEqual(["hybrid"])
  })

  it("laptop: a chosen key's request names its recorded routes, and every route without a record", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const ask = (chosen?: { transports?: readonly string[] }) =>
      runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
        localAllowed: true,
        ...(chosen ? { chosen } : {}),
      })
    await ask({ transports: ["usb"] })
    await ask({})
    await ask()
    expect(ceremony.assertRequests.map((r) => r.hints)).toEqual([
      ["security-key"],
      ["client-device", "hybrid", "security-key"],
      ["client-device"],
    ])
  })

  it("laptop: a credential with no recorded transports names the cross-device routes", async () => {
    const { ceremony, result } = await assertion("laptop", { route: "cross-device" })
    await result
    expect(ceremony.assertRequests[0]!.transports).toEqual([
      "hybrid",
      "usb",
      "nfc",
      "ble",
      "smart-card",
    ])
  })

  it("laptop: a local answer is refused, after the observer saw it", async () => {
    const { result, phases } = await assertion("laptop", { route: "local" })
    // A sign-in keeps its own wording: its passkey already lives on a phone or a key.
    await expect(result).rejects.toMatchObject({
      name: "PhoneRequiredError",
      message: new PhoneRequiredError().message,
    })
    expect(phases).toEqual(["asserted"])
  })

  it("laptop: with the local route allowed, its own answer passes; a hybrid-only record sends no transports", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const raw = await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid"],
      localAllowed: true,
    })
    expect(raw.authenticatorAttachment).toBe("platform")
    // The bound slot for a local answer, so the anchors have a candidate to check.
    expect(candidatesFrom(raw).second).toBeDefined()
    // No restriction: a hybrid-only record must not exclude the device's own copy.
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    // No security key named, so a manager's extension may answer for the synced copy.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["client-device"])
  })

  it("laptop: the local route with suppressed hints sends neither hints nor transports and still passes", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    const created = await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    const raw = await runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      credentialIds: [created.credentialId],
      transports: ["hybrid"],
      laptopHints: null,
      localAllowed: true,
    })
    expect(candidatesFrom(raw).second).toBeDefined()
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    expect(ceremony.assertRequests[0]!.hints).toBeUndefined()
  })

  describe("steered to the phone", () => {
    async function steered(fake: FakeCeremonyOptions, localAllowed: boolean) {
      const ceremony = new FakePasskeyCeremony(fake)
      const created = await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      const result = runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
        transports: ["internal", "hybrid"],
        localAllowed,
        steerToPhone: true,
      })
      return { ceremony, result }
    }

    it("sends the cross-device hints and drops this device's transport", async () => {
      const { ceremony, result } = await steered({ route: "cross-device" }, true)
      await result
      expect(ceremony.assertRequests[0]!.hints).toEqual(["hybrid", "security-key"])
      expect(ceremony.assertRequests[0]!.transports).toEqual(["hybrid"])
    })

    it("still admits this device's answer where the local route is allowed", async () => {
      const { result } = await steered({ route: "local" }, true)
      expect((await result).authenticatorAttachment).toBe("platform")
    })

    it("refuses this device's answer where it is not", async () => {
      const { result } = await steered({ route: "local" }, false)
      await expect(result).rejects.toThrow(named("PhoneRequiredError"))
    })
  })

  it("waits for the observer before checking the route", async () => {
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const observing = new Promise<void>((resolve) => (entered = resolve))
    const result = runPasskeyAssertion(ceremony, {
      posture: "laptop",
      rpId: "localhost",
      challenge: CHALLENGE,
      observe: () => {
        entered()
        return gate
      },
    })
    let settled = false
    result.then(
      () => (settled = true),
      () => (settled = true),
    )
    await observing
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await expect(result).rejects.toThrow(named("PhoneRequiredError"))
  })

  it("an observer that throws ends the assertion with its own error", async () => {
    const observerDown = new Error("observer down")
    const ceremony = new FakePasskeyCeremony({ route: "local" })
    await ceremony.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    })
    await expect(
      runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge: CHALLENGE,
        observe: () => Promise.reject(observerDown),
      }),
    ).rejects.toBe(observerDown)
  })

  it("laptop: a phone's answer is returned raw for the caller's own gates", async () => {
    const { ceremony, result } = await assertion("laptop", {
      route: "cross-device",
      backupEligible: false,
    })
    const raw = await result
    expect(raw.backupEligible).toBe(false)
    // Both routes named, since a laptop sign-in refuses a local answer either way.
    expect(ceremony.assertRequests[0]!.hints).toEqual(["hybrid", "security-key"])
    // Another device answered: a security key, or a phone passkey no anchor will match.
    expect(candidatesFrom(raw).first).toBeDefined()
  })

  describe("on a browser that mislabels a cross-device answer", () => {
    async function mislabelled(posture: DevicePosture, fake: FakeCeremonyOptions, flag = true) {
      const ceremony = new FakePasskeyCeremony(fake)
      const created = await ceremony.create({
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      const seen: ObservedCeremony[] = []
      const result = runPasskeyAssertion(ceremony, {
        posture,
        rpId: "localhost",
        challenge: CHALLENGE,
        credentialIds: [created.credentialId],
        misreportsCrossDevice: flag,
        observe: (event) => void seen.push(event),
      })
      return { ceremony, created, result, seen }
    }

    it("laptop: a phone's answer labelled as the laptop's own is returned as another device's", async () => {
      const { ceremony, created, result, seen } = await mislabelled("laptop", {
        route: "cross-device",
        attachment: "platform",
      })
      const raw = await result
      expect(raw.authenticatorAttachment).toBe("cross-platform")
      expect(seen[0]!.result.authenticatorAttachment).toBe("platform")
      expect(bytesToHex(candidatesFrom(raw).first!)).toBe(
        bytesToHex(ceremony.prfFor(created.credentialId, "first")),
      )
    })

    it("laptop: this device's own answer is admitted too, for the caller's anchors to judge", async () => {
      const { result } = await mislabelled("laptop", { route: "local" })
      const raw = await result
      expect(raw.authenticatorAttachment).toBe("cross-platform")
      expect(candidatesFrom(raw).second).toBeDefined()
      // Even one that cannot be backed up: the corrected label exempts it from the backup gate, as
      // any other device's answer is, and the anchors decide what it opens.
      const bound = await mislabelled("laptop", { route: "local", backupEligible: false })
      expect(candidatesFrom(await bound.result).first).toBeDefined()
    })

    it("phone: nothing changes", async () => {
      const { result } = await mislabelled("phone", { route: "local" })
      expect((await result).authenticatorAttachment).toBe("platform")
    })
  })
})

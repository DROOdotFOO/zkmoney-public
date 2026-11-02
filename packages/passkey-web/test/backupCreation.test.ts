/** The backup passkey creation sequence, over the fake ceremony. */
import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  YUBIKEY_5_USB_A_AAGUID,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { bytesToHex } from "../src/ceremony/bytes.js"
import type { PasskeyHint } from "../src/ceremony/passkeyCeremony.js"
import { decodeUserHandleProvenance } from "../src/ceremony/userHandle.js"
import type { BackupAddChoice } from "../src/options/backupAddOptions.js"
import {
  BACKUP_CANDIDATES,
  BACKUP_CREATION_HINTS,
  type BackupCandidates,
} from "../src/rules/backupAdmission.js"
import type { DevicePosture } from "../src/browser/devicePosture.js"
import {
  type BackupPasskeyCreationOptions,
  type ObservedCeremony,
  runBackupPasskeyCreation,
} from "../src/drivers.js"
import {
  BackupPasskeyRefusedError,
  markPasskeyWritten,
  passkeyWritten,
} from "../src/refusals/passkeyErrors.js"
import { LAPTOP_CREATION_HINTS, LAPTOP_LOCAL_HINTS } from "../src/rules/slotRule.js"
import { providerNameFor } from "../src/rules/passkeyProviders.js"
import { parseUserAgent } from "../src/browser/userAgentInfo.js"
import { FakePasskeyCeremony, type FakeCeremonyOptions } from "./support/fakePasskeyCeremony.js"

const WINDOWS_HELLO = "08987058-cadc-4b81-b6e1-30de50dcbe96"
const BRAVE = "b5397666-4885-aa6b-cebf-e52262a439a2"
const PROTON_PASS = "50726f74-6f6e-5061-7373-50726f746f6e"
const CHALLENGE = new Uint8Array(32).fill(9)

const MAC = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/130.0.0.0 Safari/537.36",
})
const WINDOWS = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/130.0.0.0 Safari/537.36",
})

const IPHONE = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like " +
    "Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
})

const key = (over: FakeCeremonyOptions = {}): FakeCeremonyOptions => ({
  route: "cross-device",
  manager: "security-key",
  transports: ["usb"],
  backupEligible: false,
  aaguid: YUBIKEY_5_USB_A_AAGUID,
  ...over,
})

function backup(
  fake: FakeCeremonyOptions | FakePasskeyCeremony,
  extra: Partial<BackupPasskeyCreationOptions> & { posture?: DevicePosture } = {},
) {
  const ceremony = fake instanceof FakePasskeyCeremony ? fake : new FakePasskeyCeremony(fake)
  const run = runBackupPasskeyCreation(ceremony, {
    posture: "laptop",
    rpId: "localhost",
    rpName: "zk.money",
    userName: "@alice",
    userAgent: MAC,
    challengeForChained: () => CHALLENGE,
    ...extra,
  })
  return { ceremony, run }
}

const refused = (kind: string) =>
  expect.objectContaining({ name: "BackupPasskeyRefusedError", kind })

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

describe("runBackupPasskeyCreation", () => {
  it("binds a laptop's own iCloud passkey in one prompt, on the second slot", async () => {
    const { ceremony, run } = backup({ route: "local", aaguid: APPLE_ICLOUD_AAGUID })
    const result = await run
    expect(ceremony.assertRequests).toHaveLength(0)
    expect(result.slot).toBe("second")
    expect(result.securityKey).toBe(false)
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "second")),
    )
    expect(result.facts).toEqual({
      provider: "icloud_keychain",
      deviceBound: false,
      prfAtCreate: true,
    })
    expect(signalled).toEqual([])
  })

  it("asks a key without PRF at creation again as a key, and binds first", async () => {
    const { ceremony, run } = backup(key({ prfAtCreate: false }))
    const result = await run
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      hints: ["security-key"],
      transports: ["usb"],
    })
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(result.chained).toBeDefined()
    expect(bytesToHex(result.prfOutput)).toBe(
      bytesToHex(ceremony.prfFor(result.created.credentialId, "first")),
    )
  })

  it("takes a key the browser lists no transports for on its zero id, and asks it again pinned", async () => {
    const { ceremony, run } = backup(
      key({ transports: [], aaguid: ZERO_AAGUID, prfAtCreate: false }),
    )
    const result = await run
    expect(result.securityKey).toBe(true)
    expect(result.slot).toBe("first")
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(ceremony.assertRequests[0]).toMatchObject({
      credentialIds: [result.created.credentialId],
      hints: ["security-key"],
    })
    expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
  })

  it("keeps an empty list a manager's when it carries an id, or when nothing was attested", async () => {
    const manager = await backup({
      route: "cross-device",
      manager: "gpm",
      aaguid: GPM_AAGUID,
      transports: [],
      backupEligible: false,
    }).run
    expect(manager.securityKey).toBe(false)
    const unnamed = await backup(key({ transports: [], aaguid: undefined })).run
    expect(unnamed.securityKey).toBe(false)
  })

  it("admits a device-bound local passkey, and a one-salt provider on the slot it filled", async () => {
    const bound = await backup({ route: "local", aaguid: GPM_AAGUID, backupEligible: false }).run
    expect(bound.slot).toBe("second")

    const oneSalt = await backup({ route: "local", aaguid: ONEPASSWORD_AAGUID, secondSlot: false })
      .run
    expect(oneSalt.slot).toBe("first")
  })

  it("chains for a passkey that returned no PRF at creation, steering a laptop to this device", async () => {
    const { ceremony, run } = backup({
      route: "local",
      aaguid: APPLE_ICLOUD_AAGUID,
      prfAtCreate: false,
    })
    await run
    expect(ceremony.assertRequests[0]!.hints).toEqual(BACKUP_CREATION_HINTS)

    const phone = backup(
      { route: "local", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false },
      { posture: "phone" },
    )
    await phone.run
    expect(phone.ceremony.assertRequests[0]!.hints).toBeUndefined()
  })

  it("lets a laptop's key leave the passkey unstored; a phone's must store it", async () => {
    const laptop = backup({ route: "local", aaguid: APPLE_ICLOUD_AAGUID })
    await laptop.run
    expect(laptop.ceremony.creates[0]!.residentKey).toBe("preferred")

    const phone = backup(
      { route: "local", aaguid: APPLE_ICLOUD_AAGUID },
      { posture: "phone", userAgent: IPHONE },
    )
    await phone.run
    expect(phone.ceremony.creates[0]!.residentKey).toBe("required")
  })

  describe("the settings picker's choice", () => {
    const FIVE_MINUTES = 300_000
    type Shape = {
      hints: readonly PasskeyHint[]
      extensionAllowed: true | undefined
      timeoutMs: number | undefined
      context: string
    }
    const SHAPES: Record<BackupAddChoice, Shape> = {
      "computer": {
        hints: BACKUP_CREATION_HINTS,
        extensionAllowed: undefined,
        timeoutMs: undefined,
        context: "mac_local",
      },
      "1password": {
        hints: LAPTOP_LOCAL_HINTS,
        extensionAllowed: undefined,
        timeoutMs: undefined,
        context: "mac_local",
      },
      "proton": {
        hints: LAPTOP_LOCAL_HINTS,
        extensionAllowed: true,
        timeoutMs: undefined,
        context: "mac_local",
      },
      "phone": {
        hints: LAPTOP_CREATION_HINTS,
        extensionAllowed: undefined,
        timeoutMs: FIVE_MINUTES,
        context: "mac_qr",
      },
      "phone-or-key": {
        hints: LAPTOP_CREATION_HINTS,
        extensionAllowed: undefined,
        timeoutMs: FIVE_MINUTES,
        context: "mac_qr",
      },
      "key": {
        hints: ["security-key"],
        extensionAllowed: undefined,
        timeoutMs: FIVE_MINUTES,
        context: "mac_key",
      },
    }
    /** An answer each pick admits: a key for the key, a phone over QR for the phone, else local. */
    const answering = (choice: BackupAddChoice, over: FakeCeremonyOptions = {}) =>
      choice === "key"
        ? key(over)
        : choice === "phone" || choice === "phone-or-key"
        ? { route: "cross-device" as const, manager: "gpm" as const, aaguid: GPM_AAGUID, ...over }
        : { route: "local" as const, aaguid: APPLE_ICLOUD_AAGUID, ...over }

    it.each(Object.keys(SHAPES) as BackupAddChoice[])(
      "%s sends its hints, deadline and extension flag, and writes its route into the handle",
      async (choice) => {
        const { ceremony, run } = backup(answering(choice), { choice })
        const made = await run
        const request = ceremony.creates[0]!
        expect(request.authenticatorAttachment).toBeUndefined()
        expect(request.hints).toEqual(SHAPES[choice].hints)
        expect(request.extensionAllowed).toBe(SHAPES[choice].extensionAllowed)
        expect(request.timeoutMs).toBe(SHAPES[choice].timeoutMs)
        expect(decodeUserHandleProvenance(made.created.userHandle)?.context).toBe(
          SHAPES[choice].context,
        )
      },
    )

    it("asks the manager that made a passkey without PRF again with the pick's steer", async () => {
      const { ceremony, run } = backup(answering("phone", { prfAtCreate: false }), {
        choice: "phone",
      })
      const made = await run
      expect(ceremony.assertRequests).toHaveLength(1)
      expect(ceremony.assertRequests[0]).toMatchObject({
        credentialIds: [made.created.credentialId],
        hints: SHAPES.phone.hints,
      })
      expect(ceremony.assertRequests[0]!.transports).toBeUndefined()
    })

    it("admits a phone's Google Password Manager over QR, and refuses Proton Pass there naming the route", async () => {
      const gpm = await backup(answering("phone"), { choice: "phone" }).run
      expect(gpm.slot).toBe("first")

      const { run } = backup(
        { route: "cross-device", manager: "gpm", aaguid: PROTON_PASS },
        { choice: "phone" },
      )
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as Error).message).toBe(
        new BackupPasskeyRefusedError("provider", {
          providerName: providerNameFor(PROTON_PASS),
          overQr: true,
        }).message,
      )
    })

    it("a candidate refused on this device keeps the message that names no route", async () => {
      const { run } = backup({ route: "local", aaguid: WINDOWS_HELLO }, { choice: "computer" })
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as Error).message).toBe(
        new BackupPasskeyRefusedError("provider", { providerName: providerNameFor(WINDOWS_HELLO) })
          .message,
      )
    })

    it("a key reported without transports is refused without naming a route", async () => {
      const { run } = backup(key({ transports: [] }), { choice: "phone" })
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as Error).message).toBe(
        new BackupPasskeyRefusedError("provider", {
          providerName: providerNameFor(YUBIKEY_5_USB_A_AAGUID),
        }).message,
      )
    })
  })

  describe("refuses", () => {
    it("an unmeasured candidate, naming it, with the credential forgotten", async () => {
      const candidates: BackupCandidates = {
        ...BACKUP_CANDIDATES,
        windows_hello: { ...BACKUP_CANDIDATES.windows_hello, measured: false },
      }
      const { ceremony, run } = backup(
        { route: "local", aaguid: WINDOWS_HELLO },
        { userAgent: WINDOWS, candidates },
      )
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as BackupPasskeyRefusedError).providerName).toBe(providerNameFor(WINDOWS_HELLO))
      expect(passkeyWritten(error)).toBe(true)
      const made = [...ceremony.creds.keys()][0]!
      expect(signalled).toEqual([{ rpId: "localhost", credentialId: made }])
    })

    it("Proton Pass on an iPhone in its own words, with no second prompt", async () => {
      const { ceremony, run } = backup(
        { route: "local", aaguid: PROTON_PASS, prfAtCreate: false },
        { posture: "phone", userAgent: IPHONE },
      )
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as Error).message).toBe(
        new BackupPasskeyRefusedError("provider", {
          providerName: providerNameFor(PROTON_PASS),
          userAgent: IPHONE,
        }).message,
      )
      expect(ceremony.assertRequests).toHaveLength(0)
    })

    it("Windows Hello that returns no PRF, naming it", async () => {
      const { run } = backup(
        { route: "local", aaguid: WINDOWS_HELLO, prfAtCreate: false, prfAtAssert: false },
        { userAgent: WINDOWS },
      )
      const error = await run.catch((e: unknown) => e)
      expect(error).toEqual(refused("no-prf"))
      expect((error as BackupPasskeyRefusedError).providerName).toBe(providerNameFor(WINDOWS_HELLO))
    })

    it("nothing for a measured candidate on the OS it covers, and it elsewhere", async () => {
      const onWindows = backup({ route: "local", aaguid: WINDOWS_HELLO }, { userAgent: WINDOWS })
      expect((await onWindows.run).slot).toBe("second")
      const onMac = backup({ route: "local", aaguid: WINDOWS_HELLO }, { userAgent: MAC })
      await expect(onMac.run).rejects.toThrow(refused("provider"))
    })

    it("a PRF at creation without user verification, with no second prompt", async () => {
      for (const fake of [
        { userVerified: false },
        { backupEligible: "unknown" as const },
      ] satisfies FakeCeremonyOptions[]) {
        const { ceremony, run } = backup({ route: "local", aaguid: APPLE_ICLOUD_AAGUID, ...fake })
        await expect(run).rejects.toThrow(refused("unverified"))
        expect(ceremony.assertRequests).toHaveLength(0)
      }
    })

    it("a chained PRF without user verification after a verified creation", async () => {
      const ceremony = new FakePasskeyCeremony(key({ prfAtCreate: false }))
      const { run } = backup(ceremony, {
        observe: (event) => {
          if (event.phase === "created") ceremony.opts.userVerified = false
        },
      })
      await expect(run).rejects.toThrow(refused("unverified"))
    })

    it("a security key whose id names a manager, even one counted as other", async () => {
      const error = await backup(key({ aaguid: BRAVE })).run.catch((e: unknown) => e)
      expect(error).toEqual(refused("provider"))
      expect((error as BackupPasskeyRefusedError).providerName).toBe("Brave")
    })

    it("a passkey with no PRF at all, and a key with none in its own words", async () => {
      await expect(
        backup({
          route: "local",
          aaguid: APPLE_ICLOUD_AAGUID,
          prfAtCreate: false,
          prfAtAssert: false,
        }).run,
      ).rejects.toThrow(refused("no-prf"))
      await expect(backup(key({ prfAtCreate: false, prfAtAssert: false })).run).rejects.toThrow(
        refused("key-no-prf"),
      )
    })

    it("a chained assertion another passkey answered", async () => {
      const ceremony = new FakePasskeyCeremony({ route: "local", prfAtCreate: false })
      const stray = (
        await ceremony.create({
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@bob",
          prfFirstSalt: new Uint8Array(32),
        })
      ).credentialId
      ceremony.opts.assertOverride = () => stray
      const { run } = backup(ceremony)
      await expect(run).rejects.toThrow(refused("other-credential"))
      const made = [...ceremony.creds.keys()].find((id) => id !== stray)!
      expect(signalled).toEqual([{ rpId: "localhost", credentialId: made }])
    })
  })

  it("rethrows a dismissed follow-up prompt as it came, with the credential forgotten", async () => {
    const dismissed = new DOMException("Dismissed", "NotAllowedError")
    const ceremony = new FakePasskeyCeremony(key({ prfAtCreate: false }))
    ceremony.opts.assertOverride = () => {
      throw dismissed
    }
    const error = await backup(ceremony).run.catch((e: unknown) => e)
    expect(error).toBe(dismissed)
    expect(passkeyWritten(error)).toBe(true)
    expect(signalled).toHaveLength(1)
  })

  it("reads user verification from the response that carried the PRF", async () => {
    const ceremony = new FakePasskeyCeremony(key({ prfAtCreate: false, userVerified: false }))
    const result = await backup(ceremony, {
      observe: (event) => {
        if (event.phase === "created") ceremony.opts.userVerified = true
      },
    }).run
    expect(result.created.userVerified).toBe(false)
    expect(result.chained?.userVerified).toBe(true)
  })

  it("forgets only the passkey each creation saved but the wallet could not read", async () => {
    // One error object for every failure, as an extension that caches its error would throw.
    const unreadable = markPasskeyWritten(new Error("not ES256"))
    const ceremony = new FakePasskeyCeremony({ route: "local", aaguid: APPLE_ICLOUD_AAGUID })
    for (const id of ["cred-a", "cred-b"]) {
      ceremony.create = (request) => {
        request.onWritten?.(id)
        return Promise.reject(unreadable)
      }
      await expect(backup(ceremony).run).rejects.toBe(unreadable)
    }
    ceremony.create = () => Promise.reject(unreadable)
    await expect(backup(ceremony).run).rejects.toBe(unreadable)
    expect(signalled).toEqual([
      { rpId: "localhost", credentialId: "cred-a" },
      { rpId: "localhost", credentialId: "cred-b" },
    ])
  })

  it("lets the observer hear the creation and the follow-up before any refusal", async () => {
    const heard: ObservedCeremony["phase"][] = []
    const { run } = backup(
      { route: "local", aaguid: APPLE_ICLOUD_AAGUID, prfAtCreate: false, prfAtAssert: false },
      { observe: (event) => void heard.push(event.phase) },
    )
    await expect(run).rejects.toThrow(refused("no-prf"))
    expect(heard).toEqual(["created", "chained"])
  })

  it("returns nothing for a creation its caller ended while the answer came in", async () => {
    const controller = new AbortController()
    const { run } = backup(
      { route: "local", aaguid: APPLE_ICLOUD_AAGUID },
      {
        signal: controller.signal,
        observe: () => controller.abort(new DOMException("left", "AbortError")),
      },
    )
    await expect(run).rejects.toThrow(/left/)
    expect(signalled).toHaveLength(1)
  })
})

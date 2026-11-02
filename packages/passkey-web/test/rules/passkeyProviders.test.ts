import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import {
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  LOCAL_MANAGER_NAMES,
  PASSKEY_MANAGER_AAGUIDS,
  PROTON_PASS,
  WINDOWS_HELLO as WINDOWS_HELLO_NAME,
  localManagerFor,
  localManagersClause,
  localProviderVerdict,
  providerAllowed,
  providerNameFor,
  providerSlugFor,
  refusalKindFor,
} from "../../src/rules/passkeyProviders.js"

const BRAVE = "b5397666-4885-aa6b-cebf-e52262a439a2"
const WINDOWS_HELLO = "08987058-cadc-4b81-b6e1-30de50dcbe96"
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
const A_KEY = [...SECURITY_KEY_AAGUIDS][0]!

describe("localProviderVerdict", () => {
  it("admits a manager on the row, by its id, whatever its case", () => {
    expect(localProviderVerdict(GPM_AAGUID.toUpperCase(), ["apple", "gpm"])).toBe("admitted")
  })

  it("refuses a missing or all-zero id, unlike the provider gate", () => {
    expect(localProviderVerdict(undefined, ["apple", "gpm"])).toBe("unnamed")
    expect(localProviderVerdict(ZERO_AAGUID, ["apple", "gpm"])).toBe("unnamed")
  })

  it("names Apple when the row leaves it out, and anything else as unsupported", () => {
    expect(localProviderVerdict(APPLE_ICLOUD_AAGUID, ["gpm"])).toBe("apple")
    expect(localProviderVerdict(GPM_AAGUID, ["apple"])).toBe("unsupported")
    expect(localProviderVerdict(WINDOWS_HELLO, ["gpm"])).toBe("unsupported")
  })

  it("admits the browser-test id through the extra list", () => {
    expect(localProviderVerdict(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, ["gpm"])).toBe("unsupported")
    expect(
      localProviderVerdict(
        CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
        ["gpm"],
        [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID],
      ),
    ).toBe("admitted")
  })
})

describe("localManagerFor", () => {
  it("names the manager an id belongs to, whatever its case, and none for any other id", () => {
    expect(localManagerFor(ONEPASSWORD_AAGUID)).toBe("1password")
    expect(localManagerFor(GPM_AAGUID.toUpperCase())).toBe("gpm")
    expect(localManagerFor(APPLE_ICLOUD_AAGUID)).toBe("apple")
    expect(localManagerFor(undefined)).toBeUndefined()
    expect(localManagerFor(A_KEY)).toBeUndefined()
  })
})

describe("localManagersClause", () => {
  it("names the managers in order", () => {
    const managers = ["apple", "gpm", "1password"] as const
    const clause = localManagersClause(managers)
    const at = managers.map((m) => clause.indexOf(LOCAL_MANAGER_NAMES[m]))
    expect(at).not.toContain(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(localManagersClause(["gpm"])).toBe(LOCAL_MANAGER_NAMES.gpm)
    expect(localManagersClause([])).not.toBe("")
  })
})

describe("providerAllowed", () => {
  it("admits every measured manager to a phone passkey", () => {
    for (const id of [APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID]) {
      expect(providerAllowed(id, false)).toBe(true)
    }
    expect(providerAllowed(APPLE_ICLOUD_AAGUID.toUpperCase(), false)).toBe(true)
  })

  it("admits every measured security key to a key", () => {
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerAllowed(id, true)).toBe(true)
  })

  it("admits an absent or all-zero id to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(undefined, securityKey)).toBe(true)
      expect(providerAllowed(ZERO_AAGUID, securityKey)).toBe(true)
    }
  })

  it("refuses an id that contradicts the class that answered", () => {
    // A manager id on a hardware key, or a key's id on a phone passkey: one of the two is lying.
    expect(providerAllowed(GPM_AAGUID, true)).toBe(false)
    expect(providerAllowed(A_KEY, false)).toBe(false)
  })

  it("refuses an unmeasured provider to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(UNMEASURED, securityKey)).toBe(false)
    }
  })

  it("admits an id the caller lists on top of the measured set", () => {
    const extra = [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID]
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false)).toBe(false)
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false, extra)).toBe(true)
    expect(providerAllowed(UNMEASURED, false, extra)).toBe(false)
    // Ids arrive from a parser that emits lowercase, but a caller's list is hand-written.
    expect(providerAllowed(UNMEASURED, false, [UNMEASURED.toUpperCase()])).toBe(true)
  })
})

describe("refusalKindFor", () => {
  it("follows the class when the class is certain", () => {
    expect(refusalKindFor(undefined, true)).toBe("security-key")
    expect(refusalKindFor(UNMEASURED, false)).toBe("manager")
  })

  it("follows the id when a key was named but its transports were withheld", () => {
    // Classed as a phone (no transports) but the orphan is on the key, so the key's advice wins.
    expect(refusalKindFor(A_KEY, false)).toBe("security-key")
    expect(refusalKindFor(A_KEY.toUpperCase(), false)).toBe("security-key")
  })
})

describe("providerNameFor", () => {
  it("never invents a name for an id it does not know, nor for zeros", () => {
    expect(providerNameFor(UNMEASURED)).toBeUndefined()
    expect(providerNameFor(ZERO_AAGUID)).toBeUndefined()
    expect(providerNameFor(undefined)).toBeUndefined()
    expect(providerNameFor("constructor")).toBeUndefined()
  })

  it("can name everything it admits", () => {
    for (const id of [...PASSKEY_MANAGER_AAGUIDS, ...SECURITY_KEY_AAGUIDS]) {
      expect(providerNameFor(id)).toBeTruthy()
    }
  })

  it("gives Windows Hello and Proton Pass the names their refusal copy keys on", () => {
    expect(providerNameFor(WINDOWS_HELLO)).toBe(WINDOWS_HELLO_NAME)
    expect(providerNameFor("50726f74-6f6e-5061-7373-50726f746f6e")).toBe(PROTON_PASS)
  })
})

describe("providerSlugFor", () => {
  it("counts each named provider under its slug", () => {
    expect(providerSlugFor(APPLE_ICLOUD_AAGUID.toUpperCase())).toBe("icloud_keychain")
  })

  it("counts every measured security key as a YubiKey", () => {
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerSlugFor(id)).toBe("yubikey")
  })

  it("tells a provider that did not report itself from one that said nothing", () => {
    expect(providerSlugFor(ZERO_AAGUID)).toBe("not_reported")
    expect(providerSlugFor(undefined)).toBe("unknown")
    expect(providerSlugFor("unknown")).toBe("unknown")
  })

  it("counts an id it cannot name, or names without a slug, as another provider", () => {
    expect(providerSlugFor(UNMEASURED)).toBe("other")
    expect(providerSlugFor(BRAVE)).toBe("other")
  })
})

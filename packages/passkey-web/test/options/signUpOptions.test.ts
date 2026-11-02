// @vitest-environment node
/** The laptop sign-up sheet's options, built from each browser's own row. */
import { describe, expect, it } from "vitest"
import {
  type LaptopCreation,
  type LocalCreation,
  type Withdrawn,
  WITHDRAWN,
  laptopCreationFor,
  withoutManager,
} from "../../src/rules/laptopCreation.js"
import type { PhoneReach } from "../../src/browser/passkeyCapabilities.js"
import type { PasskeyExtension } from "../../src/telemetry/passkeyTelemetryVocabulary.js"
import {
  PHONE_STEPS_COPY,
  SIGN_UP_SHEET_COPY,
  SUPPORTED_NAMES,
} from "../../src/refusals/refusalCopy.js"
import {
  type SignUpChoice,
  type SignUpOptions,
  type SignUpOptionsInput,
  ignoresHintsFor,
  routeForChoice,
  signUpOptionsFor,
} from "../../src/options/signUpOptions.js"
import { type UserAgentInfo, parseUserAgent } from "../../src/browser/userAgentInfo.js"

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0"
const LINUX_FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0"

const chrome = { brand: "Google Chrome", version: "155" }
const edge = { brand: "Microsoft Edge", version: "155" }
const brave = { brand: "Brave", version: "155" }

/** A Chromium answering Client Hints. */
const hinted = (
  userAgent: string,
  platform: string,
  platformVersion: string,
  brand: { brand: string; version: string },
) =>
  parseUserAgent({
    userAgent,
    userAgentData: {
      platform,
      platformVersion,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

const safari = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`,
  })
const macFirefox = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })

const UA = {
  chromeOs: parseUserAgent({ userAgent: CROS_UA, userAgentData: { platformVersion: "6.1.0" } }),
  macChrome: hinted(MAC_CHROME_UA, "macOS", "26.4.1", chrome),
  macEdge: hinted(MAC_CHROME_UA, "macOS", "26.4.1", edge),
  macBraveOld: hinted(MAC_CHROME_UA, "macOS", "14.6", brave),
  macSafari: safari("26.4"),
  macSafariOld: safari("26.0"),
  macFirefox: macFirefox("153.0"),
  macFirefoxOld: macFirefox("139.0"),
  windowsChrome: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", chrome),
  /** Windows Chrome without Client Hints: phone creation, still on Windows. */
  windowsChromeUnhinted: parseUserAgent({ userAgent: WINDOWS_CHROME_UA }),
  windowsEdge: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", edge),
  windowsBrave: hinted(WINDOWS_CHROME_UA, "Windows", "15.0.0", brave),
  windowsFirefox: parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
  linuxChrome: hinted(LINUX_CHROME_UA, "Linux", "", chrome),
  linuxEdge: hinted(LINUX_CHROME_UA, "Linux", "", edge),
  linuxFirefox: parseUserAgent({ userAgent: LINUX_FIREFOX_UA }),
}

/** The Firefox rows as they read once a gate admits them. */
const FIREFOX_ADMITTED: Withdrawn = { ...WITHDRAWN, windowsFirefox: [], linuxFirefox: [] }

const appleRefused = (ua: UserAgentInfo): LaptopCreation =>
  withoutManager(laptopCreationFor(ua, FIREFOX_ADMITTED), "apple")

/** The sheet for a browser as it reads itself, with its own row unless one is given. */
function sheet(ua: UserAgentInfo, input: Partial<SignUpOptionsInput> = {}): SignUpOptions {
  return signUpOptionsFor({
    creation: laptopCreationFor(ua, FIREFOX_ADMITTED),
    reach: "ok",
    extension: "none",
    refusedOften: false,
    ignoresHints: ignoresHintsFor(ua),
    os: ua.osFamily,
    ...input,
  })
}

const ids = (s: SignUpOptions) => s.options.map((o) => o.id)
const option = (s: SignUpOptions, id: SignUpChoice) => {
  const found = s.options.find((o) => o.id === id)
  if (!found) throw new Error(`no ${id} in ${ids(s).join(", ")}`)
  return found
}

const L = PHONE_STEPS_COPY.local
const C = SIGN_UP_SHEET_COPY
const { "apple": ICLOUD, "gpm": GPM, "1password": ONE_PASSWORD } = SUPPORTED_NAMES
const KEY = PHONE_STEPS_COPY.supported.providers.filter(
  (p) => !Object.values(SUPPORTED_NAMES).includes(p),
)

type Row = {
  name: string
  ua: UserAgentInfo
  creation?: LaptopCreation
  extension: PasskeyExtension
  options: SignUpChoice[]
  selected: SignUpChoice
  line?: "install-extension"
}

/** The options table, with no refusals past the limit. */
const both = (
  name: string,
  ua: UserAgentInfo,
  without: Omit<Row, "name" | "ua" | "extension">,
  withExtension: Omit<Row, "name" | "ua" | "extension">,
  creation?: LaptopCreation,
): Row[] => [
  { name, ua, extension: "none", ...without, ...(creation ? { creation } : {}) },
  { name, ua, extension: "1password", ...withExtension, ...(creation ? { creation } : {}) },
]

const TABLE: Row[] = [
  ...both(
    "ChromeOS Chrome",
    UA.chromeOs,
    { options: ["phone", "key"], selected: "phone" },
    { options: ["phone", "key"], selected: "phone" },
  ),
  ...[UA.macSafariOld, UA.macFirefoxOld].flatMap((ua) =>
    both(
      `Mac ${ua.browserFamily} below its label floor`,
      ua,
      { options: ["phone-or-key"], selected: "phone-or-key" },
      { options: ["phone-or-key"], selected: "phone-or-key" },
    ),
  ),
  ...[UA.windowsFirefox, UA.linuxFirefox].flatMap((ua) =>
    both(
      `${ua.osFamily} Firefox`,
      ua,
      { options: ["phone-or-key"], selected: "phone-or-key", line: "install-extension" },
      { options: ["1password", "phone-or-key"], selected: "1password" },
    ),
  ),
  ...both(
    `${UA.windowsEdge.osFamily} ${UA.windowsEdge.browserFamily}`,
    UA.windowsEdge,
    { options: ["phone-or-key"], selected: "phone-or-key", line: "install-extension" },
    { options: ["1password", "phone-or-key"], selected: "1password" },
  ),
  ...both(
    "Windows Chrome without Client Hints",
    UA.windowsChromeUnhinted,
    { options: ["phone-or-key"], selected: "phone-or-key" },
    { options: ["phone-or-key"], selected: "phone-or-key" },
  ),
  ...both(
    "linux edge",
    UA.linuxEdge,
    { options: ["phone", "key"], selected: "phone", line: "install-extension" },
    { options: ["1password", "phone", "key"], selected: "1password" },
  ),
  ...both(
    "windows chrome",
    UA.windowsChrome,
    { options: ["computer", "phone-or-key"], selected: "computer" },
    { options: ["1password", "computer", "phone-or-key"], selected: "1password" },
  ),
  ...[UA.linuxChrome, UA.macChrome, UA.macEdge].flatMap((ua) =>
    both(
      `${ua.osFamily} ${ua.browserFamily}`,
      ua,
      { options: ["computer", "phone", "key"], selected: "computer" },
      { options: ["1password", "computer", "phone", "key"], selected: "1password" },
    ),
  ),
  ...both(
    "Mac Chrome after an Apple refusal",
    UA.macChrome,
    { options: ["computer", "phone", "key"], selected: "computer" },
    { options: ["1password", "computer", "phone", "key"], selected: "1password" },
    appleRefused(UA.macChrome),
  ),
  ...both(
    "Mac Brave below macOS 15",
    UA.macBraveOld,
    { options: ["computer", "phone", "key"], selected: "phone" },
    { options: ["1password", "phone", "key"], selected: "1password" },
  ),
  ...both(
    "Mac Edge after an Apple refusal",
    UA.macEdge,
    { options: ["computer", "phone", "key"], selected: "phone" },
    { options: ["1password", "phone", "key"], selected: "1password" },
    appleRefused(UA.macEdge),
  ),
  ...both(
    "Mac Safari 26.4",
    UA.macSafari,
    { options: ["computer", "phone-or-key"], selected: "computer" },
    { options: ["1password", "computer", "phone-or-key"], selected: "1password" },
  ),
  ...both(
    "Mac Safari after an Apple refusal",
    UA.macSafari,
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    { options: ["1password", "phone-or-key"], selected: "1password" },
    appleRefused(UA.macSafari),
  ),
  ...both(
    "Mac Firefox 153",
    UA.macFirefox,
    { options: ["computer", "phone-or-key"], selected: "computer" },
    { options: ["computer", "phone-or-key"], selected: "computer" },
  ),
  ...both(
    "Mac Firefox after an Apple refusal",
    UA.macFirefox,
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    { options: ["computer", "phone-or-key"], selected: "phone-or-key" },
    appleRefused(UA.macFirefox),
  ),
]

const rowSheet = (row: Row, reach: PhoneReach) =>
  sheet(row.ua, {
    extension: row.extension,
    reach,
    ...(row.creation ? { creation: row.creation } : {}),
  })

describe("signUpOptionsFor", () => {
  it.each(TABLE)("$name, extension $extension: $options, opens on $selected", (row) => {
    const s = rowSheet(row, "ok")
    expect(ids(s)).toEqual(row.options)
    expect(s.selected).toBe(row.selected)
    expect(s.line?.kind).toBe(row.line)
    const unknown = rowSheet(row, "unknown")
    expect(ids(unknown)).toEqual(row.options)
    expect(unknown.selected).toBe(row.selected)
  })

  it.each(TABLE)("$name, extension $extension: no phone drops the phone and keeps a key", (row) => {
    const noPhone = (id: SignUpChoice): SignUpChoice[] =>
      id === "phone" ? [] : id === "phone-or-key" ? ["key"] : [id]
    const s = rowSheet(row, "no-hybrid")
    expect(ids(s)).toEqual(row.options.flatMap(noPhone))
    expect(s.selected).toBe(noPhone(row.selected)[0] ?? "key")
  })

  it("splits 1Password from this computer's own managers", () => {
    expect(option(sheet(UA.macChrome, { extension: "1password" }), "computer")).toMatchObject({
      label: C.computer.macLabel,
      supported: [ICLOUD, GPM],
    })
    expect(option(sheet(UA.windowsChrome), "computer")).toMatchObject({
      label: C.computer.label,
      supported: [GPM],
    })
  })

  it("names 1Password under This Mac where no 1Password option stands beside it", () => {
    const rows = [
      sheet(UA.macSafari),
      sheet(UA.macFirefox),
      sheet(UA.macFirefox, { extension: "1password" }),
    ]
    for (const s of rows) {
      expect(option(s, "computer").supported).toEqual([ICLOUD, ONE_PASSWORD])
    }
    expect(option(sheet(UA.macChrome), "computer").supported).toEqual([ICLOUD, GPM, ONE_PASSWORD])
    expect(option(sheet(UA.macSafari, { extension: "1password" }), "computer").supported).toEqual([
      ICLOUD,
    ])
  })

  it("names only the managers left after an Apple refusal", () => {
    const chromeRow = sheet(UA.macChrome, { creation: appleRefused(UA.macChrome) })
    expect(option(chromeRow, "computer").supported).toEqual([GPM, ONE_PASSWORD])
  })

  it("offers a Mac with 1Password alone the Mac's passkey window where no extension answers it", () => {
    const rows = [
      sheet(UA.macBraveOld),
      sheet(UA.macEdge, { creation: appleRefused(UA.macEdge) }),
      sheet(UA.macSafari, { creation: appleRefused(UA.macSafari) }),
      sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox) }),
      sheet(UA.macFirefox, { creation: appleRefused(UA.macFirefox), extension: "1password" }),
    ]
    for (const s of rows) {
      expect(option(s, "computer")).toMatchObject({
        description: C.computer.macWindow,
        advice: [L.pickOnePassword, L.noOnePasswordHere],
        supported: ["1Password"],
      })
    }
    const noPhone = sheet(UA.macSafari, {
      creation: appleRefused(UA.macSafari),
      reach: "no-hybrid",
    })
    expect(option(noPhone, "computer").advice).toEqual([L.pickOnePassword])
  })

  it("offers 1Password on Firefox's Mac row through the Mac's window alone until its extension is lifted", () => {
    const lifted = { ...(laptopCreationFor(UA.macFirefox) as LocalCreation) }
    delete lifted.extensionWithdrawn
    expect(ids(sheet(UA.macFirefox, { creation: lifted, extension: "1password" }))).toEqual([
      "1password",
      "computer",
      "phone-or-key",
    ])
  })

  it("gives this computer the extension advice, or off a Mac the install advice", () => {
    expect(option(sheet(UA.macChrome), "computer").advice).toEqual([])
    expect(option(sheet(UA.windowsChrome), "computer").advice).toEqual([L.installExtension])
    expect(option(sheet(UA.macChrome, { extension: "1password" }), "computer").advice).toEqual([
      L.extension,
    ])
  })

  describe("past the refusal limit", () => {
    const over = { extension: "1password" as const, refusedOften: true }

    it("opens on this computer where the row has its own manager, with the refused-often advice", () => {
      for (const ua of [UA.windowsChrome, UA.macChrome, UA.macSafari, UA.macFirefox]) {
        const s = sheet(ua, over)
        expect(s.selected).toBe("computer")
        expect(option(s, "computer").advice).toEqual([L.extension, L.refusedOften])
        expect(s.line).toBeUndefined()
      }
    })

    it("opens on the phone, or the key with no phone, where 1Password is the row's only manager", () => {
      const steeredPhone = { kind: "steered", text: L.steered.phone }
      const steeredKey = { kind: "steered", text: L.steered.key }
      for (const preferred of [undefined, "1password", "computer"] as const) {
        const input = { ...over, ...(preferred ? { preferred } : {}) }
        expect(sheet(UA.linuxEdge, input)).toMatchObject({ selected: "phone", line: steeredPhone })
        for (const ua of [UA.windowsEdge, UA.windowsFirefox]) {
          expect(sheet(ua, input)).toMatchObject({ selected: "phone-or-key", line: steeredPhone })
        }
        for (const ua of [UA.linuxEdge, UA.windowsEdge, UA.windowsFirefox]) {
          expect(sheet(ua, { ...input, reach: "no-hybrid" })).toMatchObject({
            selected: "key",
            line: steeredKey,
          })
        }
      }
    })

    it("keeps 1Password after a creation that made nothing, with its line and no steering", () => {
      const lines = {
        "unfinished": L.unfinished,
        "blocked": L.blocked,
        "blocked-again": L.blockedAgain,
      }
      for (const ua of [UA.windowsEdge, UA.windowsFirefox]) {
        for (const reopened of ["unfinished", "blocked", "blocked-again"] as const) {
          expect(sheet(ua, { ...over, preferred: "1password", reopened })).toEqual(
            expect.objectContaining({
              selected: "1password",
              line: {
                kind: reopened === "unfinished" ? "unfinished" : "blocked",
                text: lines[reopened],
              },
            }),
          )
        }
      }
    })

    it("keeps a phone or key preference, with no steered line", () => {
      const kept: [UserAgentInfo, SignUpChoice][] = [
        [UA.linuxEdge, "phone"],
        [UA.linuxEdge, "key"],
        [UA.windowsEdge, "phone-or-key"],
        [UA.windowsChrome, "phone-or-key"],
        [UA.macChrome, "phone"],
        [UA.windowsFirefox, "phone-or-key"],
      ]
      for (const [ua, preferred] of kept) {
        const s = sheet(ua, { ...over, preferred })
        expect(s.selected).toBe(preferred)
        expect(s.line).toBeUndefined()
      }
    })

    it("steers nothing on a row with no local creation", () => {
      const s = sheet(UA.chromeOs, over)
      expect(s.selected).toBe("phone")
      expect(s.line).toBeUndefined()
    })
  })

  describe("a preferred option", () => {
    it("lands on its nearest offered option", () => {
      const cases: [UserAgentInfo, Partial<SignUpOptionsInput>, SignUpChoice][] = [
        [UA.windowsFirefox, { preferred: "phone" }, "phone-or-key"],
        [UA.linuxChrome, { preferred: "phone-or-key" }, "phone"],
        [UA.macSafari, { preferred: "key" }, "phone-or-key"],
        [UA.windowsChrome, { preferred: "1password" }, "computer"],
        [UA.windowsChrome, { preferred: "key" }, "phone-or-key"],
        [UA.linuxChrome, { preferred: "key" }, "key"],
        [UA.windowsEdge, { preferred: "phone" }, "phone-or-key"],
        [UA.windowsBrave, { preferred: "key" }, "phone-or-key"],
        [UA.macChrome, { preferred: "computer", extension: "1password" }, "computer"],
      ]
      for (const [ua, input, selected] of cases) expect(sheet(ua, input).selected).toBe(selected)
      expect(
        sheet(UA.macSafari, {
          creation: appleRefused(UA.macSafari),
          extension: "1password",
          preferred: "computer",
        }).selected,
      ).toBe("1password")
    })

    it("lands a lost phone on the key, not on this computer", () => {
      expect(sheet(UA.windowsChrome, { reach: "no-hybrid", preferred: "phone" }).selected).toBe(
        "key",
      )
      expect(sheet(UA.macSafari, { reach: "no-hybrid", preferred: "phone-or-key" }).selected).toBe(
        "key",
      )
    })

    it("falls through to the defaults when nothing local is left", () => {
      expect(sheet(UA.windowsEdge, { preferred: "computer" }).selected).toBe("phone-or-key")
      expect(sheet(UA.linuxEdge, { preferred: "computer" }).selected).toBe("phone")
      expect(sheet(UA.chromeOs, { preferred: "1password" }).selected).toBe("phone")
    })
  })

  it("lists exactly what each option saves in", () => {
    const supported = (s: SignUpOptions, id: SignUpChoice) => option(s, id).supported
    const linuxChrome = sheet(UA.linuxChrome, { extension: "1password" })
    expect(supported(linuxChrome, "computer")).toEqual([GPM])
    expect(supported(linuxChrome, "1password")).toEqual([ONE_PASSWORD])
    expect(supported(linuxChrome, "phone")).toEqual([ICLOUD, GPM, ONE_PASSWORD])
    expect(supported(linuxChrome, "key")).toEqual(KEY)
    expect(supported(sheet(UA.windowsFirefox), "phone-or-key")).toEqual([
      ICLOUD,
      GPM,
      ONE_PASSWORD,
      ...KEY,
    ])
  })

  describe("the key with no phone", () => {
    it("says only that this computer can't reach a phone while local options remain", () => {
      for (const ua of [UA.windowsChrome, UA.macSafari]) {
        const key = option(sheet(ua, { reach: "no-hybrid" }), "key")
        expect(key.advice).toEqual([C.key.noPhone])
      }
    })

    it("carries the full caption where it is the only option", () => {
      for (const ua of [UA.chromeOs, UA.macSafariOld, UA.windowsEdge, UA.windowsFirefox]) {
        expect(option(sheet(ua, { reach: "no-hybrid" }), "key").advice).toEqual([
          PHONE_STEPS_COPY.noPhone.caption,
        ])
      }
    })
  })

  it("names Windows' own choices on the merged option", () => {
    for (const ua of [
      UA.windowsChrome,
      UA.windowsChromeUnhinted,
      UA.windowsEdge,
      UA.windowsBrave,
      UA.windowsFirefox,
    ]) {
      expect(option(sheet(ua), "phone-or-key").advice).toEqual([C.phoneOrKey.windows])
    }
    expect(option(sheet(UA.linuxFirefox), "phone-or-key").advice).toEqual([])
  })

  it("tells every cross-device option to pass on an extension's pop-up", () => {
    const s = sheet(UA.linuxChrome, { extension: "1password" })
    expect(option(s, "phone").advice).toEqual([PHONE_STEPS_COPY.extension])
    expect(option(s, "key").advice).toEqual([PHONE_STEPS_COPY.extension])
    for (const ua of [UA.windowsChrome, UA.windowsFirefox]) {
      expect(option(sheet(ua, { extension: "1password" }), "phone-or-key").advice).toEqual([
        C.phoneOrKey.windows,
        PHONE_STEPS_COPY.extension,
      ])
    }
  })

  it("warns about keys wherever a key can be picked", () => {
    const chromium = sheet(UA.macChrome, { extension: "1password" })
    expect(option(chromium, "key").keyWarning).toEqual(C.keyWarning)
    for (const id of ["1password", "computer", "phone"] as const) {
      expect(option(chromium, id).keyWarning).toBeUndefined()
    }
    expect(option(sheet(UA.macSafari), "phone-or-key").keyWarning).toEqual(C.keyWarning)
  })

  it("the 1Password option carries no advice, whatever else is offered", () => {
    expect(option(sheet(UA.macChrome, { extension: "1password" }), "1password").advice).toEqual([])
  })

  describe("a script that is not 1Password's", () => {
    const classes = ["bitwarden", "other"] as const

    it("offers no 1Password option, keeps the dismiss line and drops the install line", () => {
      for (const extension of classes) {
        const chrome = sheet(UA.macChrome, { extension })
        expect(ids(chrome)).toEqual(["computer", "phone", "key"])
        expect(chrome.selected).toBe("computer")
        expect(option(chrome, "computer")).toMatchObject({
          supported: [ICLOUD, GPM, ONE_PASSWORD],
          advice: [L.extension],
        })
        const edge = sheet(UA.windowsEdge, { extension })
        expect(ids(edge)).toEqual(["phone-or-key"])
        expect(edge.line).toBeUndefined()
        expect(option(edge, "phone-or-key").advice).toEqual([
          C.phoneOrKey.windows,
          PHONE_STEPS_COPY.extension,
        ])
        const linuxEdge = sheet(UA.linuxEdge, { extension })
        expect(ids(linuxEdge)).toEqual(["phone", "key"])
        expect(linuxEdge.line).toBeUndefined()
        expect(option(linuxEdge, "phone").advice).toEqual([PHONE_STEPS_COPY.extension])
        expect(option(sheet(UA.windowsChrome, { extension }), "computer").advice).toEqual([
          L.extension,
        ])
      }
    })

    it("keeps a phone or key preference on every class", () => {
      for (const extension of ["none", "1password", "bitwarden", "other"] as const) {
        expect(sheet(UA.macChrome, { extension, preferred: "phone" }).selected).toBe("phone")
        expect(sheet(UA.macChrome, { extension, preferred: "key" }).selected).toBe("key")
        expect(sheet(UA.linuxEdge, { extension, preferred: "key" }).selected).toBe("key")
        expect(sheet(UA.windowsEdge, { extension, preferred: "key" }).selected).toBe("phone-or-key")
        expect(sheet(UA.macFirefox, { extension, preferred: "phone" }).selected).toBe(
          "phone-or-key",
        )
      }
    })

    it("adds the dismiss line to the Mac's window option", () => {
      for (const extension of classes) {
        const creation = appleRefused(UA.macFirefox)
        expect(option(sheet(UA.macFirefox, { creation, extension }), "computer").advice).toEqual([
          L.pickOnePassword,
          L.noOnePasswordHere,
          L.extension,
        ])
        const noPhone = sheet(UA.macFirefox, { creation, extension, reach: "no-hybrid" })
        expect(option(noPhone, "computer").advice).toEqual([L.pickOnePassword, L.extension])
      }
    })

    it("carries the warning for the running sheet, and nothing else does", () => {
      for (const extension of classes) {
        expect(sheet(UA.macChrome, { extension }).warning).toBe(C.extensionWarning)
        expect(sheet(UA.windowsEdge, { extension }).warning).toBe(C.extensionWarning)
      }
      for (const extension of ["none", "1password"] as const) {
        expect(sheet(UA.macChrome, { extension })).not.toHaveProperty("warning")
        expect(sheet(UA.windowsEdge, { extension })).not.toHaveProperty("warning")
      }
    })
  })

  describe("the re-open line", () => {
    const unfinished = { reopened: "unfinished" } as const

    it("says setup didn't finish, offering the phone only where the sheet opens on this computer", () => {
      for (const preferred of ["computer", undefined] as const) {
        expect(sheet(UA.windowsChrome, { ...unfinished, preferred })).toMatchObject({
          selected: "computer",
          line: { kind: "unfinished", text: L.unfinished },
        })
      }
      expect(
        sheet(UA.windowsChrome, { ...unfinished, extension: "1password", preferred: "1password" }),
      ).toMatchObject({ selected: "1password", line: { kind: "unfinished", text: L.unfinished } })
      for (const preferred of ["phone", "key"] as const) {
        expect(sheet(UA.macChrome, { ...unfinished, preferred })).toMatchObject({
          selected: preferred,
          line: { kind: "unfinished", text: L.unfinishedElsewhere },
        })
      }
      for (const ua of [UA.windowsChrome, UA.windowsEdge]) {
        expect(sheet(ua, { ...unfinished, preferred: "phone-or-key" })).toMatchObject({
          selected: "phone-or-key",
          line: { kind: "unfinished", text: L.unfinishedElsewhere },
        })
      }
    })

    it("offers the phone only where the sheet has one", () => {
      const noPhone = { ...unfinished, reach: "no-hybrid" } as const
      for (const [ua, input, selected] of [
        [UA.windowsChrome, { preferred: "computer" }, "computer"],
        [UA.windowsEdge, { extension: "1password", preferred: "1password" }, "1password"],
        [UA.macChrome, { extension: "1password" }, "1password"],
      ] as const) {
        expect(sheet(ua, { ...noPhone, ...input })).toMatchObject({
          selected,
          line: { kind: "unfinished", text: L.unfinishedElsewhere },
        })
      }
    })

    it("follows the option the sheet falls to, not the one asked for", () => {
      // 1Password's extension gone, or a computer pick on a row with nothing local.
      for (const preferred of ["1password", "computer"] as const) {
        expect(sheet(UA.windowsEdge, { ...unfinished, preferred })).toMatchObject({
          selected: "phone-or-key",
          line: { kind: "unfinished", text: L.unfinishedElsewhere },
        })
      }
      expect(
        sheet(UA.windowsChrome, { ...unfinished, preferred: "phone", reach: "no-hybrid" }),
      ).toMatchObject({
        selected: "key",
        line: { kind: "unfinished", text: L.unfinishedElsewhere },
      })
    })

    it("says the prompt never opened, and on the second time in a row to try another browser", () => {
      for (const [ua, preferred, selected] of [
        [UA.macChrome, "phone", "phone"],
        [UA.macChrome, "key", "key"],
        [UA.windowsChrome, "computer", "computer"],
        [UA.windowsChrome, "phone", "phone-or-key"],
        [UA.windowsEdge, "phone", "phone-or-key"],
      ] as const) {
        expect(sheet(ua, { reopened: "blocked", preferred })).toMatchObject({
          selected,
          line: { kind: "blocked", text: L.blocked },
        })
        expect(sheet(ua, { reopened: "blocked-again", preferred })).toMatchObject({
          selected,
          line: { kind: "blocked", text: L.blockedAgain },
        })
      }
    })

    it("wins over the install line", () => {
      for (const reopened of ["unfinished", "blocked"] as const) {
        const s = sheet(UA.windowsEdge, { reopened })
        expect(s.selected).toBe("phone-or-key")
        expect(s.line?.kind).toBe(reopened)
      }
    })
  })
})

describe("routeForChoice", () => {
  it("sends this computer's options locally, the phone's to a phone, the key to a key", () => {
    expect(routeForChoice("computer")).toBe("this-device")
    expect(routeForChoice("1password")).toBe("this-device")
    expect(routeForChoice("phone")).toBe("phone")
    expect(routeForChoice("phone-or-key")).toBe("phone")
    expect(routeForChoice("key")).toBe("security-key")
  })
})

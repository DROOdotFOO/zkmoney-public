import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "true"))

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({
    title,
    onClick,
    testId,
  }: {
    title: string
    onClick?: () => void
    testId?: string
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {title}
    </button>
  ),
  IconCircle: () => null,
  RowChevron: () => null,
  GlassCircleButton: ({
    onClick,
    ariaLabel,
    testId,
    children,
  }: {
    onClick?: () => void
    ariaLabel?: string
    testId?: string
    children: React.ReactNode
  }) => (
    <button aria-label={ariaLabel} data-testid={testId} onClick={onClick}>
      {children}
    </button>
  ),
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
  SettingsRow: ({
    className,
    label,
    description,
    trailing,
  }: {
    className?: string
    label: string
    description?: React.ReactNode
    trailing?: React.ReactNode
  }) => (
    <div className={className}>
      <span data-label>{label}</span>
      {description && <span data-description>{description}</span>}
      {trailing}
    </div>
  ),
}))

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
/** What this page reads of the browser: the extension on `create`, the kept wrapper, the device. */
const page = vi.hoisted(() => ({
  extension: "none" as string,
  kept: undefined as unknown,
  posture: "laptop" as string,
  userAgent: "",
}))
vi.mock("@obsidion/passkey-web", async (importOriginal) => {
  const original = await importOriginal<typeof import("@obsidion/passkey-web")>()
  return {
    ...original,
    passkeyExtensionFor: () => page.extension,
    keptPasskeyApiFor: () => page.kept,
    currentDevicePosture: () => page.posture,
    currentUserAgentInfoSync: () => original.parseUserAgent({ userAgent: page.userAgent }),
  }
})

const h = vi.hoisted(() => ({
  readAuthKeysCounted: vi.fn(),
  resolveOxideIdentity: vi.fn(),
  sessionKeys: vi.fn(),
  probePhoneReach: vi.fn(),
  addInputs: [] as unknown[],
  refresh: vi.fn(),
  allowance: { status: "loading", scope: "s" } as unknown,
  deps: undefined as unknown,
  flowDeps: undefined as unknown,
  facts: undefined as unknown,
  factsRefresh: vi.fn(),
  depsFailures: 0,
  depsBuilt: 0,
  identity: null as { address: string; handle?: string } | null,
  authenticators: {} as Record<string, AuthenticatorRecord | undefined>,
  contractService: {},
  obsidionWallet: {},
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: h.contractService }),
  createOxideL1Reader: () => ({ readAuthKeysCounted: h.readAuthKeysCounted }),
  resolveOxideIdentity: h.resolveOxideIdentity,
  deriveBootstrapKey: () => ({ address: BOOTSTRAP }),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => h.identity,
}))
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => GENERATIONS,
}))
vi.mock("../../../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/auth/WebPasskeyIdentityMap")>()),
  authenticatorFor: (pubkeyHex: string) => h.authenticators[pubkeyHex],
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ sessionKeys: h.sessionKeys, probePhoneReach: h.probePhoneReach }),
}))
vi.mock("../../../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: h.allowance, refresh: h.refresh }),
}))
vi.mock("../../../src/features/backupPasskey/backupPasskeyRuntime", () => ({
  buildBackupAddDeps: async (input: unknown) => {
    h.addInputs.push(input)
    return h.deps
  },
  buildBackupFlowDeps: async () => {
    h.depsBuilt++
    if (h.depsFailures > 0) {
      h.depsFailures--
      throw new Error("locked")
    }
    return h.flowDeps
  },
}))
vi.mock("../../../src/features/backupPasskey/backupPasskeyFacts", () => ({
  useBackupEntryFacts: () => ({ facts: h.facts, refresh: h.factsRefresh }),
}))

import { BACKUP_ROTATION_STORAGE_KEY, credentialIdToMetadata } from "@obsidion/front-core"
import { SIGN_UP_SHEET_COPY } from "@obsidion/passkey-web"
import {
  getBackupRotationStore,
  resetBackupRotationStoreForTests,
} from "../../../src/features/backupPasskey/backupRotationStore"
import type { AuthenticatorRecord } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import {
  OWNER,
  createdRecord,
  makeBackupAddDeps,
  makeFlowDeps,
  sent,
  signedRecord,
} from "../../support/backupAdd"
import { openTestSession } from "../../support/session"
const { PasskeysModal } = await import("../../../src/ui/PasskeysModal")

const BOOTSTRAP = `0x${"b0".repeat(20)}`
const L2_ADDRESS = `0x${"12".repeat(32)}`
const GENERATIONS = { kind: "generations" }
type Key = { qx: `0x${string}`; qy: `0x${string}` }
const key = (fill: number): Key => ({
  qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
  qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
})
const providerFor = (k: Key) => ({
  getPubkeys: async () => [Buffer.from(k.qx.slice(2), "hex"), Buffer.from(k.qy.slice(2), "hex")],
})
const ROOT_KEY = key(0x10)
const hexOf = (k: Key) => `${k.qx.slice(2)}${k.qy.slice(2)}`
const ICLOUD = { prfAaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd" }
const UNREPORTED = { prfAaguid: "00000000-0000-0000-0000-000000000000" }
const ROOT_METADATA = credentialIdToMetadata("root-credential-id-000001")
const ready = {
  status: "ready",
  scope: "s",
  read: {},
  state: { kind: "available", available: 10 },
  refreshing: false,
}
const DAI = 10n ** 18n
const FACTS = {
  routeLive: true,
  balance: 10n * DAI,
  fundingAmount: 2n * DAI,
  chunk: { kind: "fits" },
  plan: true,
  moves: 2,
  withdrawalInFlight: false,
  openLink: false,
  historicBalance: false,
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const onAction = vi.fn()

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<PasskeysModal onClose={onClose} onAction={onAction} />)
  })
  await flush(2)
}

const text = () => container.textContent ?? ""
const entry = () => container.querySelector<HTMLButtonElement>('[data-testid="backup-add"]')
const entryLine = () => container.querySelector('[data-testid="backup-entry-line"]')?.textContent
const windowsLine = () =>
  container.querySelector('[data-testid="backup-windows10-line"]')?.textContent
const panel = () => container.querySelector('[data-testid="backup-panel"]')
const ahead = () => container.querySelector('[data-testid="backup-add-ahead"]')?.textContent
const AHEAD =
  "You'll use two passkeys: first save the new backup, then approve it with the passkey you signed in with."
const approveButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="backup-approve"]')
const choice = () => container.querySelector<HTMLButtonElement>('[data-testid="backup-add-choice"]')
const chosen = () => choice()?.querySelector(".ww-choice__text b")?.textContent
const advice = () => container.querySelector('[data-testid="backup-add-advice"]')?.textContent
const keyWarning = () => container.querySelector('[data-testid="phone-steps-key-warning"]')
const lastAddInput = () => h.addInputs.at(-1) as { owner?: string; choice?: string } | undefined
/** Opens the picker's list and names its options in order. */
const openChoices = async () => {
  await press("backup-add-choice")
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="backup-add-option-"]')].map(
    (el) => el.dataset.testid!.slice("backup-add-option-".length),
  )
}

function listKeys(count: number) {
  h.readAuthKeysCounted.mockResolvedValue({
    entries: Array.from({ length: count }, (_, i) => ({
      key: i === 0 ? ROOT_KEY : key(0x20 + i),
      metadata: ROOT_METADATA,
    })),
    authKeyCount: count,
  })
}

beforeEach(() => {
  openTestSession({ wallet: h.obsidionWallet })
  localStorage.clear()
  resetBackupRotationStoreForTests()
  page.extension = "none"
  page.kept = undefined
  page.posture = "laptop"
  page.userAgent = MAC_CHROME_UA
  h.probePhoneReach.mockReset()
  h.probePhoneReach.mockResolvedValue("ok")
  h.addInputs.length = 0
  h.authenticators = {}
  h.identity = { address: L2_ADDRESS, handle: "brave-otter-42" }
  h.sessionKeys.mockResolvedValue({ secretKey: {}, authProvider: providerFor(ROOT_KEY) })
  h.depsFailures = 0
  h.depsBuilt = 0
  h.allowance = ready
  h.facts = FACTS
  h.factsRefresh.mockReset()
  h.resolveOxideIdentity.mockResolvedValue({
    kind: "verified",
    identity: { account: OWNER, nameHash: "0x", generations: [] },
  })
  listKeys(1)
  h.deps = makeBackupAddDeps({
    store: getBackupRotationStore(),
    seal: async () => new Uint8Array(62).fill(1),
  }).deps
  h.flowDeps = makeFlowDeps({ store: getBackupRotationStore() }).deps
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

const rowTitles = () =>
  [...container.querySelectorAll(".ww-passkeys__row [data-label]")].map((el) => el.textContent)
const rowRoles = () =>
  [...container.querySelectorAll(".ww-passkeys__row")].map(
    (row) => row.querySelector("[data-description]")?.textContent,
  )
const press = (testId: string) =>
  act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click())
const nameInput = () => container.querySelector<HTMLInputElement>('[data-testid="passkey-name"]')!
const typeName = (value: string) => {
  const el = nameInput()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("the Passkeys modal's key list", () => {
  it("keeps the role as the name where no manager is known", async () => {
    listKeys(2)
    h.authenticators = { [hexOf(key(0x21))]: UNREPORTED }
    await mount()
    expect(rowTitles()).toEqual(["Sign-up", "Sign-up"])
    expect(rowRoles()).toEqual([undefined, undefined])
  })

  it("calls a hardware key no table names a security key", async () => {
    listKeys(4)
    h.authenticators = {
      [hexOf(ROOT_KEY)]: { ...UNREPORTED, transports: [], securityKey: true },
      [hexOf(key(0x21))]: { transports: ["usb"] },
      [hexOf(key(0x22))]: { inferredTransports: ["usb", "nfc"] },
      [hexOf(key(0x23))]: { authenticatorType: "security-key" },
    }
    await mount()
    expect(rowTitles()).toEqual(["Security key", "Security key", "Security key", "Security key"])
    expect(rowRoles()).toEqual(["Sign-up", "Sign-up", "Sign-up", "Sign-up"])
  })

  it("renames a key on this browser, and an empty name goes back to the manager", async () => {
    h.authenticators = { [hexOf(ROOT_KEY)]: ICLOUD }
    await mount()
    await press("passkey-rename")
    typeName("  Work   laptop ")
    await press("passkey-name-save")
    expect(rowTitles()).toEqual(["Work laptop"])
    expect(rowRoles()).toEqual(["Sign-up"])
    expect(JSON.parse(localStorage.getItem("webwallet.passkey-names")!)).toEqual({
      [hexOf(ROOT_KEY)]: "Work laptop",
    })

    await act(async () => root.unmount())
    container.remove()
    await mount()
    expect(rowTitles()).toEqual(["Work laptop"])

    await press("passkey-rename")
    expect(nameInput().value).toBe("Work laptop")
    typeName("")
    await act(async () => {
      nameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    expect(rowTitles()).toEqual(["iCloud Keychain"])
    expect(localStorage.getItem("webwallet.passkey-names")).toBe("{}")
  })
})

describe("the Passkeys modal's backup picker", () => {
  it("merges the phone and the key where the browser ignores hints, with the Windows prompt advice", async () => {
    page.userAgent = WINDOWS_CHROME_UA
    await mount()
    expect(chosen()).toBe(SIGN_UP_SHEET_COPY.computer.label)
    expect(await openChoices()).toEqual(["computer", "phone-or-key"])
    await press("backup-add-option-phone-or-key")
    expect(advice()).toContain(SIGN_UP_SHEET_COPY.phoneOrKey.windows)
    expect(keyWarning()).not.toBeNull()
  })

  it("shows no picker on a phone, asks no probe, and sends no pick", async () => {
    page.posture = "phone"
    await mount()
    expect(choice()).toBeNull()
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(entry()?.disabled).toBe(false)
    expect(ahead()).toBe(AHEAD)
    await act(async () => entry()!.click())
    await flush(3)
    expect(lastAddInput()).not.toHaveProperty("choice")
  })

  it("a ready entry waits on the phone probe; a blocked one keeps its reason and action", async () => {
    let answer: (reach: string) => void = () => {}
    h.probePhoneReach.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    await mount()
    expect(entry()?.disabled).toBe(true)
    expect(entryLine()).toBe("Checking…")
    expect(choice()).toBeNull()
    expect(ahead()).toBeUndefined()
    await act(async () => answer("ok"))
    expect(entry()?.disabled).toBe(false)
    expect(entryLine()).toBeUndefined()
    expect(choice()).not.toBeNull()
    expect(ahead()).toBe(AHEAD)

    await act(async () => root.unmount())
    container.remove()
    h.probePhoneReach.mockReturnValue(new Promise(() => {}))
    h.allowance = { status: "unavailable", scope: "s", error: new Error("rpc") }
    await mount()
    expect(entryLine()).toBe("Could not check, try again")
    expect(container.querySelector('[data-testid="backup-entry-retry"]')).not.toBeNull()
    expect(choice()).toBeNull()
    expect(ahead()).toBeUndefined()
  })

  it("drops the phone when it can't be reached, and the probe's answer after the sheet closed", async () => {
    h.probePhoneReach.mockResolvedValue("no-hybrid")
    await mount()
    expect(await openChoices()).toEqual(["computer", "key"])
    await act(async () => root.unmount())
    container.remove()

    let answer: (reach: string) => void = () => {}
    h.probePhoneReach.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    await mount()
    await act(async () => root.unmount())
    container.remove()
    answer("ok")
    await flush()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    await mount()
  })

  it("holds the picker while the add runs, and closing the sheet ends the creation", async () => {
    const seen: { signal?: AbortSignal } = {}
    h.deps = makeBackupAddDeps({
      store: getBackupRotationStore(),
      driver: (_, options) => {
        seen.signal = options.signal
        return new Promise(() => {})
      },
    }).deps
    await mount()
    await act(async () => entry()!.click())
    await flush(2)
    expect(choice()?.disabled).toBe(true)
    expect(entry()?.disabled).toBe(true)
    expect(seen.signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    container.remove()
    expect(seen.signal?.aborted).toBe(true)
    await mount()
  })
})

describe("the Passkeys modal's add entry", () => {
  it("shows nothing of the add on a two-key account", async () => {
    listKeys(2)
    await mount()
    expect(entry()).toBeNull()
    expect(text()).not.toContain("Google Password Manager")
  })

  it("asks for the first passkey when the session signs with a key the account does not list", async () => {
    h.sessionKeys.mockResolvedValue({ secretKey: {}, authProvider: providerFor(key(0x40)) })
    await mount()
    expect(entry()?.disabled).toBe(true)
    expect(entryLine()).toBe("Use your first passkey to add a backup")
  })

  it("sends the user to sponsored transactions when the account has no subscription", async () => {
    h.allowance = { ...ready, state: { kind: "not-subscribed", maxTx: 10, renews: true } }
    await mount()
    expect(entry()?.disabled).toBe(true)
    expect(entryLine()).toBe("Sponsored transactions are not set up")
    const action = container.querySelector<HTMLButtonElement>('[data-testid="backup-entry-action"]')
    expect(action?.textContent).toBe("Sponsored transactions")
    await act(async () => action!.click())
    expect(onAction).toHaveBeenCalledWith("sponsorship")
  })

  it("says it is checking while a read is pending, and to try again when one failed", async () => {
    h.allowance = { status: "loading", scope: "s" }
    await mount()
    expect(entry()?.disabled).toBe(true)
    expect(entryLine()).toBe("Checking…")
    await act(async () => root.unmount())
    container.remove()
    h.allowance = { status: "unavailable", scope: "s", error: new Error("rpc") }
    await mount()
    expect(entryLine()).toBe("Could not check, try again")
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-entry-retry"]')
    await act(async () => retry!.click())
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it("pressing the entry creates the backup and shows the pending panel at the approval step", async () => {
    await mount()
    await act(async () => entry()!.click())
    await flush(3)
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Approve with your current passkey",
    )
    expect(container.querySelector(".ww-backup__detail")?.textContent).toBe(
      "Use the passkey you signed in with. Only a passkey already on your account can add a new one.",
    )
    expect(approveButton()?.textContent).toBe("Approve with your current passkey")
    expect((await getBackupRotationStore().get(OWNER))?.phase).toBe("created")
    expect(lastAddInput()).toMatchObject({ owner: OWNER, choice: "computer" })
  })

  it("a failure after the passkey was created says the passkey stays on the device", async () => {
    h.deps = makeBackupAddDeps({
      store: getBackupRotationStore(),
      seal: async () => {
        throw new Error("seal broke")
      },
    }).deps
    await mount()
    await act(async () => entry()!.click())
    await flush(3)
    expect(panel()).toBeNull()
    expect(text()).toContain("Could not check, try again")
    expect(text()).toContain("stays on your device but does not open this account")
    expect(await getBackupRotationStore().get(OWNER)).toBeNull()
  })

  it("an attempt abandoned by closing the modal while its record is being written saves nothing", async () => {
    const write = webStorage.setItem.bind(webStorage)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(webStorage, "setItem").mockImplementationOnce(async (key, value) => {
      await held
      return write(key, value)
    })
    await mount()
    await act(async () => entry()!.click())
    await flush(3)
    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    container.remove()
    release()
    await flush(3)
    expect(await getBackupRotationStore().get(OWNER)).toBeNull()
    expect(JSON.parse((await webStorage.getItem(BACKUP_ROTATION_STORAGE_KEY)) ?? "{}")).toEqual({})
    spy.mockRestore()
    await mount()
    expect(entry()?.disabled).toBe(false)
  })

  it("a failed creation keeps the entry and says why", async () => {
    h.deps = makeBackupAddDeps({
      store: getBackupRotationStore(),
      driver: async () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      },
    }).deps
    await mount()
    await act(async () => entry()!.click())
    await flush(3)
    expect(panel()).toBeNull()
    expect(entry()?.disabled).toBe(false)
    expect(text()).toContain("The passkey request was closed or timed out.")
  })

  it("shows a pending record even once the account lists two keys, with no new entry", async () => {
    listKeys(2)
    await getBackupRotationStore().put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
  })

  describe("on a Windows Chrome", () => {
    const WINDOWS_CHROME =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/155.0.0.0 Safari/537.36"
    const LINE =
      "On Windows 10, Windows Hello can't hold a backup passkey. Use a security key, Google Password " +
      "Manager in Chrome, or 1Password."

    function hints(read: () => Promise<{ platformVersion?: string }>) {
      Object.defineProperty(navigator, "userAgent", { value: WINDOWS_CHROME, configurable: true })
      Object.defineProperty(navigator, "userAgentData", {
        value: {
          platform: "Windows",
          brands: [{ brand: "Google Chrome", version: "155" }],
          getHighEntropyValues: read,
        },
        configurable: true,
      })
    }

    afterEach(() => {
      delete (navigator as { userAgent?: unknown }).userAgent
      delete (navigator as { userAgentData?: unknown }).userAgentData
    })

    it("holds the row at checking until the hints settle, then opens it with the line", async () => {
      let release: (value: { platformVersion: string }) => void = () => {}
      hints(() => new Promise((resolve) => (release = resolve)))
      await mount()
      expect(entry()?.disabled).toBe(true)
      expect(entryLine()).toBe("Checking…")
      expect(windowsLine()).toBeUndefined()
      release({ platformVersion: "10.0.0" })
      await flush()
      expect(entry()?.disabled).toBe(false)
      expect(entryLine()).toBeUndefined()
      expect(windowsLine()).toBe(LINE)
    })

    it("shows no line on Windows 11, and none when the hints read fails", async () => {
      hints(async () => ({ platformVersion: "19.0.0" }))
      await mount()
      expect(windowsLine()).toBeUndefined()
      expect(entry()?.disabled).toBe(false)
      await act(async () => root.unmount())
      container.remove()
      hints(async () => {
        throw new Error("denied")
      })
      await mount()
      expect(windowsLine()).toBeUndefined()
      expect(entry()?.disabled).toBe(false)
    })
  })

  it("shows the pending panel when the account's keys cannot be read", async () => {
    h.readAuthKeysCounted.mockRejectedValue(new Error("rpc"))
    await getBackupRotationStore().put(createdRecord())
    await mount()
    await flush(2)
    expect(text()).toContain("Couldn't read the account's keys.")
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
    expect(approveButton()?.textContent).toBe("Approve with your current passkey")
  })

  it("shows the pending panel when the account does not verify", async () => {
    h.resolveOxideIdentity.mockResolvedValue({ kind: "unverified" })
    await getBackupRotationStore().put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
  })

  it("blocks the add while the saved records cannot be read, and reads again on request", async () => {
    resetBackupRotationStoreForTests()
    const read = vi.spyOn(webStorage, "getItem").mockRejectedValueOnce(new Error("locked"))
    h.deps = makeBackupAddDeps({ store: getBackupRotationStore() }).deps
    await mount()
    await flush(2)
    expect(entry()).toBeNull()
    expect(panel()).toBeNull()
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-store-retry"]')
    expect(retry?.textContent).toBe("Try again")
    await act(async () => retry!.click())
    await flush(2)
    expect(entry()?.disabled).toBe(false)
    read.mockRestore()
  })

  it("acts on no record while the account read is still out", async () => {
    let settle: (identity: unknown) => void = () => {}
    h.resolveOxideIdentity.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const other = `0x${"22".repeat(20)}`
    await getBackupRotationStore().put(signedRecord({ owner: other, phase: "funded", ...sent(1) }))
    await mount()
    await flush(3)
    expect(text()).toContain("Loading")
    expect(panel()).toBeNull()
    expect(h.depsBuilt).toBe(0)
    expect((await getBackupRotationStore().get(other))?.phase).toBe("funded")
    settle({ kind: "verified", identity: { account: OWNER, nameHash: "0x", generations: [] } })
    await flush(3)
    expect(panel()).toBeNull()
    expect(entry()?.disabled).toBe(false)
    expect(h.depsBuilt).toBe(0)
    expect((await getBackupRotationStore().get(other))?.phase).toBe("funded")
  })

  it("treats an identity read that could not conclude as a failed read, with a retry", async () => {
    h.resolveOxideIdentity.mockResolvedValueOnce({ kind: "inconclusive" })
    await mount()
    await flush(2)
    expect(text()).toContain("Couldn't read the account's keys.")
    expect(text()).not.toContain("not registered yet")
    expect(entry()).toBeNull()
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="keys-retry"]')
    await act(async () => retry!.click())
    await flush(3)
    expect(entry()?.disabled).toBe(false)
  })

  it("names an account not registered yet under the entry", async () => {
    h.resolveOxideIdentity.mockResolvedValue({ kind: "unverified" })
    await mount()
    await flush(2)
    expect(text()).not.toContain("Couldn't read the account's keys.")
    expect(entry()?.disabled).toBe(true)
    expect(entryLine()).toBe("This account is not registered yet")
  })

  it("offers a retry when the pending record's dependencies cannot be built", async () => {
    h.depsFailures = 1
    await getBackupRotationStore().put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).toBeNull()
    expect(text()).toContain("Could not check, try again")
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-deps-retry"]')
    await act(async () => retry!.click())
    await flush(2)
    expect(panel()).not.toBeNull()
  })

  it("cancelling the attempt brings the entry back with the leftover-passkey line", async () => {
    await getBackupRotationStore().put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).not.toBeNull()
    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")
    await act(async () => cancel!.click())
    await flush(2)
    expect(panel()).toBeNull()
    expect(container.querySelector('[data-testid="backup-cancelled"]')?.textContent).toContain(
      "stays on your device but does not open this account",
    )
    expect(entry()).not.toBeNull()
  })
})

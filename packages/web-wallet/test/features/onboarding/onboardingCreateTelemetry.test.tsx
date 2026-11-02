/**
 * The signup wizard's passkey attempts over the real ceremony gate: a create cancelled mid-request
 * stays the user's cancel even when the next attempt finishes first, and each way out of the
 * wizard marks the attempt it ends before the gate goes.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID } from "@obsidion/core/constants"
import {
  CHROME_REFUSAL_COPY,
  EXTENSION_ADVICE_COPY,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PHONE_STEPS_COPY,
  PhoneRequiredError,
  SIGN_UP_SHEET_COPY,
  UnsupportedProviderError,
  markPasskeyWritten,
  recordRequestHeld,
  type LaptopCreation,
  type SignUpChoice,
} from "@obsidion/passkey-web"
import { OnboardingScreen } from "../../../src/features/onboarding/OnboardingScreen"
import { LOCAL_REFUSAL_LIMIT, noteLocalRefusal } from "../../../src/platform/auth/localRefusals"
import { scopeOfStatus } from "../../../src/platform/auth/passkeyAttemptScope"
import { getPendingStore } from "../../../src/features/onboarding/webRegistration"
import { __resetPasskeyTelemetryForTests } from "../../../src/lib/passkeyTelemetry"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "../../support/passkeyTelemetryHarness"
import { nativeCreate, onePasswordCreate, otherCreate } from "../../support/passkeyExtensionStubs"
import { nameClaim, resetRegistrationStores } from "../../support/registrationFixtures"

vi.setConfig({ testTimeout: 30_000 })

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}`

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  fireEvent: vi.fn(),
  getClaimStatus: vi.fn(),
  claimTag: vi.fn(),
  createAccount: vi.fn(),
  collectOnboardingKeys: vi.fn(),
  probePhoneReach: vi.fn(),
  probeLaptopCreation: vi.fn(),
  useLaptopCreation: vi.fn(),
  hasRootBreadcrumb: true,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  // The create's own arguments, past the wallet and auth service it runs over.
  createAccount: (_deps: unknown, ...args: unknown[]) => h.createAccount(...args),
  useContractServiceContext: () => ({ contractService: { service: true } }),
  useConfigValue: () => ({ value: true, setValue: vi.fn() }),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({
    network: "testnet",
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    rpId: "localhost",
    rpName: "zk.money",
    l1Chain: { name: "Sepolia" },
  }),
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  fireOnboardingEvent: h.fireEvent,
  reportLanding: vi.fn(),
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A saved identity only counts as onboarded beside this browser's root-passkey breadcrumb, and an
// app's browser is told before any request only where there is none.
vi.mock("../../../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/auth/WebPasskeyIdentityMap")>()),
  hasOpeningBreadcrumb: () => h.hasRootBreadcrumb,
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: null, walletName: null, connect: vi.fn() }),
  getL1Clients: vi.fn(),
}))
vi.mock("../../../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => {
  const auth = () => ({
    probePhoneReach: h.probePhoneReach,
    probeLaptopCreation: h.probeLaptopCreation,
    useLaptopCreation: h.useLaptopCreation,
    recoverFromCache: async () => undefined,
    clear: () => {},
    lockOut: () => {},
  })
  return { getAuthService: auth, peekAuthService: auth }
})
// The DS drags in liquid-glass optics jsdom can't render; these tests are about wiring.
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
    isDisabled,
  }: {
    title: string
    testId?: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button data-testid={testId} disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  GradientSpinner: () => <span>spinner</span>,
  Icon: () => null,
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Spinner: () => null,
  TopNavIconButton: ({
    onClick,
    ariaLabel,
    testId,
    disabled,
  }: {
    onClick?: () => void
    ariaLabel?: string
    testId?: string
    disabled?: boolean
  }) => (
    <button aria-label={ariaLabel} data-testid={testId} disabled={disabled} onClick={onClick}>
      x
    </button>
  ),
}))
vi.mock("../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
// The invitation page stays behind the sheets, so its button can start a claim while one runs.
vi.mock("../../../src/features/onboarding/steps/InvitationStep", () => ({
  InvitationStep: ({ onUnlock }: { onUnlock: (handle: string) => void }) => (
    <button onClick={() => onUnlock("taga")}>landing-signin</button>
  ),
}))
vi.mock("../../../src/features/onboarding/steps/ClaimTagModal", () => ({
  ClaimTagModal: ({ onClose }: { onClose: () => void }) => (
    <div>
      claim-modal
      <button onClick={onClose}>close-claim</button>
    </div>
  ),
  AllSetModal: () => <div>all-set</div>,
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/oxideOnboarding")>()),
  getClaimStatus: h.getClaimStatus,
  claimTag: h.claimTag,
  collectOnboardingKeys: h.collectOnboardingKeys,
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ registry: "0x00000000000000000000000000000000000000e4" }),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))

const fakeAccount = { getAddress: () => ({ toString: () => L2_ADDRESS }) }
const fakeKeys = {
  account: fakeAccount,
  secretKey: { toString: () => `0x${"11".repeat(32)}` },
  authProvider: {},
  pubkeyHex: `0x${"22".repeat(64)}`,
}
const CUSTODY = {
  kind: "custody",
  confirmed: true,
  oxideAccount: ACCOUNT,
  claim: nameClaim(),
}

let container: HTMLDivElement
let root: Root
let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>

const events = () => passkeyEvents(h.fireEvent)
const buttons = () => Array.from(container.querySelectorAll("button"))
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const press = async (find: () => HTMLElement | undefined | null) => {
  await act(async () => find()!.click())
  await flush()
}
const pressLabel = (label: string) => press(() => buttons().find((b) => b.textContent === label))
const deposit = () => press(() => buttons().find((b) => b.textContent?.startsWith("Deposit")))
const continueAtSteps = () => press(() => byTestId("phone-steps-continue"))
/** The option the sheet has picked. */
const choice = () => byTestId("phone-steps")?.dataset.choice
/** Opens the sheet's dropdown and picks `id`. */
const pick = async (id: SignUpChoice) => {
  await press(() => byTestId("phone-steps-choice"))
  await press(() => byTestId(`phone-steps-option-${id}`))
}
/** The options the sheet's dropdown offers, opened and closed again on the one already picked. */
const offered = async () => {
  await press(() => byTestId("phone-steps-choice"))
  const ids = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((o) =>
    o.dataset.testid?.replace("phone-steps-option-", ""),
  )
  await press(() => container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]'))
  return ids
}
/** The sheet's X, its only way out: there is no Cancel. */
const closeButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
const closeSheet = () => press(closeButton)

const PHONE_ONLY: LaptopCreation = { local: false, chromeTip: false }
const MAC: LaptopCreation = {
  local: true,
  os: "macos",
  row: "macChrome",
  managers: ["apple", "gpm"],
  withdrawn: [],
}
const WINDOWS: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsChrome",
  managers: ["gpm", "1password"],
  withdrawn: [],
}
const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const GPM_ANSWER = {
  authenticatorAttachment: "platform",
  backupEligible: true,
  aaguid: GPM_AAGUID,
} as const
const APPLE_ANSWER = { ...GPM_ANSWER, aaguid: APPLE_ICLOUD_AAGUID } as const
const ONEPASSWORD_ANSWER = { ...GPM_ANSWER, aaguid: ONEPASSWORD_AAGUID } as const

async function render(path = "/claim/taga") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/claim/:handle?" element={<OnboardingScreen />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

/** The next create asks the browser once through the tracker and waits for the test. */
function heldCreate() {
  const held: { request?: HeldRequest } = {}
  h.createAccount.mockImplementationOnce(async () => {
    held.request = harness.request("create")
    await held.request.settled
    return fakeAccount
  })
  return held
}

/** From the landing, through the terms and the phone steps, to a create waiting on its request. */
async function toCreateRequest() {
  const held = heldCreate()
  await pressLabel("landing-signin")
  await deposit()
  await continueAtSteps()
  expect(held.request).toBeDefined()
  return held.request!
}

const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => void openTestSession({ wallet: { wallet: true } }))
afterEach(closeSession)

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  resetRegistrationStores()
  await getPendingStore().load()
  // A fresh page load's tracker: attempt numbers and once-per-page events start over.
  __resetPasskeyTelemetryForTests()
  harness = await passkeyTelemetryHarness()
  h.getClaimStatus.mockResolvedValue("reserved")
  h.collectOnboardingKeys.mockResolvedValue(fakeKeys)
  h.claimTag.mockResolvedValue(CUSTODY)
  h.probePhoneReach.mockResolvedValue("unknown")
  h.probeLaptopCreation.mockResolvedValue(PHONE_ONLY)
  h.hasRootBreadcrumb = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await render()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  // An attempt a test left open ends with its page, before the next test counts anything.
  pageHide()
})

describe("signup create step — passkey telemetry", () => {
  it("a create cancelled mid-request stays the user's cancel when the next create finishes first", async () => {
    const first = await toCreateRequest()
    await closeSheet()

    const second = heldCreate()
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await act(async () => second.request!.answer())
    await flush()

    await act(async () => first.reject(new DOMException("closed", "NotAllowedError")))
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        attempt: "2",
      }),
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        credential_created: "no",
        attempt: "1",
      }),
    ])
  })

  it("closing during the create's request ends the signal that request runs under", async () => {
    let signal: AbortSignal | undefined
    h.createAccount.mockImplementationOnce(async (...args: unknown[]) => {
      signal = (args[5] as { signal?: AbortSignal }).signal
      await harness.request("create").settled
      return fakeAccount
    })
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    expect(signal?.aborted).toBe(false)
    await closeSheet()
    expect(signal?.aborted).toBe(true)
  })

  it("leaving while the create's request is open reports no failed create, whatever it then throws", async () => {
    // Not the abort itself: a browser that answers anyway can fail in its own way.
    h.createAccount.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_, reject) => {
          const { signal } = args[5] as { signal: AbortSignal }
          signal.addEventListener("abort", () => reject(new Error("unreadable answer")))
        }),
    )
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await act(async () => root.unmount())
    root = createRoot(container)
    await flush()
    expect(h.fireEvent.mock.calls.filter(([e]) => e === "action_failed")).toEqual([])
  })

  it("closing the claim modal says nothing for the create a second attempt replaced", async () => {
    const earlier = heldCreate()
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    expect(earlier.request).toBeDefined()
    // The landing behind the sheet starts the terms again; this create finishes and its claim fails.
    await pressLabel("landing-signin")
    h.claimTag.mockRejectedValueOnce(new Error("down"))
    const later = heldCreate()
    await deposit()
    await continueAtSteps()
    await act(async () => later.request!.answer())
    await flush()
    expect(container.textContent).toContain("claim-modal")
    h.fireEvent.mockClear()

    act(() => {
      buttons()
        .find((b) => b.textContent === "close-claim")!
        .click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("keeps a cancelled create's chained assertion out of the retry that replaced it", async () => {
    let chain!: () => void
    const chained = new Promise<void>((resolve) => (chain = resolve))
    // A creation whose provider answers no key material, so the driver asks a second time — here
    // only once the retry has begun.
    h.createAccount.mockImplementationOnce(
      async (_import: boolean, _type: unknown, status: (value: string) => void) => {
        const own = scopeOfStatus(status)
        await harness.answered("create", own)
        await chained
        await harness.answered("assert", own)
        return fakeAccount
      },
    )
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await closeSheet()

    // The retry holds at its phone steps and asks the browser for nothing.
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    chain()
    await flush()

    // Both prompts are the cancelled creation's, which the browser answered in the end.
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        prompts: "2+",
        attempt: "1",
      }),
    ])
  })

  it("closing the terms sheet while an earlier create still waits on its request is the user's cancel", async () => {
    await toCreateRequest()
    // The landing behind the sheet opens the terms again over the waiting create.
    await pressLabel("landing-signin")
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("leaving while the gate probes, or at its phone steps, sends nothing", async () => {
    h.probePhoneReach.mockImplementationOnce(() => new Promise(() => {}))
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).toBeNull()
    await act(async () => root.unmount())

    root = createRoot(container)
    await render()
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    act(() => pageHide())
    await flush()
    expect(events()).toEqual([])
  })

  it("a second create at the gate replaces the first quietly, and the user's cancel still lands", async () => {
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    // The landing behind the sheet starts a second create; its gate ends the first one's wait.
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    expect(events()).toEqual([])

    act(() => {
      closeButton()!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "0",
      }),
    ])
  })

  it("a laptop create past the phone steps carries the phone check", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    const held = await toCreateRequest()
    await act(async () => held.answer())
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "succeeded", phone_reach: "ok" }),
    ])
  })
})

/**
 * A laptop allowed to create on its own password manager: the sheet opens on this computer, the
 * answer names the manager, and every way back from a refusal or a closed prompt is the sheet.
 */
describe("signup create on this computer — passkey telemetry", () => {
  const createRoute = (call: number) =>
    (h.createAccount.mock.calls[call]?.[5] as { route?: string } | undefined)?.route
  /** The next create asks once, is answered as `evidence` says, then fails as `error` says. */
  const refusedCreate = (evidence: object, error: () => unknown) =>
    h.createAccount.mockImplementationOnce(async () => {
      const request = harness.request("create")
      request.answer(evidence as never)
      await request.settled
      throw error()
    })
  /** The next create's prompt closes with nothing made. */
  const closedCreate = () =>
    h.createAccount.mockImplementationOnce(async () => {
      const request = harness.request("create")
      request.reject(new DOMException("closed", "NotAllowedError"))
      await request.settled
    })
  /** The sheet, opened on one of this computer's options. */
  const toLocalSheet = async (opens: SignUpChoice = "computer") => {
    await pressLabel("landing-signin")
    await deposit()
    expect(choice()).toBe(opens)
  }

  beforeEach(() => {
    // A create a failed test never reached must not answer the next test's.
    h.createAccount.mockReset()
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(MAC)
  })

  describe("the warning while the creation runs", () => {
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const install = (value: unknown) =>
      Object.defineProperty(navigator, "credentials", { value, configurable: true })
    const warning = () => byTestId("phone-steps-extension-warning")
    const refusal = () =>
      markPasskeyWritten(
        new UnsupportedProviderError("manager", {
          providerName: "Bitwarden",
          localManagers: ["apple", "gpm"],
        }),
      )
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it("shows over the spinner from the first running render, until the passkey exists", async () => {
      install({ create: otherCreate() })
      const held = heldCreate()
      await toLocalSheet()
      expect(warning()).toBeNull()
      await act(async () => byTestId("phone-steps-continue")!.click())
      expect(warning()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
      expect(warning()?.getAttribute("role")).toBe("alert")
      expect(byTestId("phone-steps-loading") ?? byTestId("phone-steps")).toBeNull()
      h.claimTag.mockImplementationOnce(() => new Promise(() => {}))
      await act(async () => held.request!.answer(GPM_ANSWER))
      await flush()
      expect(container.textContent).toContain("Preparing deposit address…")
      expect(warning()).toBeNull()
    })

    it("is gone on the refusal card and back on the retry's run", async () => {
      install({ create: otherCreate() })
      refusedCreate(GPM_ANSWER, refusal)
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("UnsupportedProviderError")
      expect(warning()).toBeNull()
      heldCreate()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("computer")
      await continueAtSteps()
      expect(warning()?.textContent).toBe(SIGN_UP_SHEET_COPY.extensionWarning)
    })

    it("is in the first busy render, not added after it", async () => {
      install({ create: otherCreate() })
      heldCreate()
      await toLocalSheet()
      // Each record is one commit: the spinner must arrive with its warning, never grow one later.
      const commits: boolean[] = []
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue
            const spinner =
              node.matches(".ww-invite-spinner") || !!node.querySelector(".ww-invite-spinner")
            const alert =
              node.matches(".ww-phone-steps__warning") ||
              !!node.querySelector(".ww-phone-steps__warning")
            if (spinner) commits.push(alert)
            else if (alert) commits.push(false)
          }
        }
      })
      observer.observe(container, { childList: true, subtree: true })
      await act(async () => byTestId("phone-steps-continue")!.click())
      await flush()
      observer.disconnect()
      expect(commits).toEqual([true])
    })

    it("is off on the retry's run once the script is gone", async () => {
      install({ create: otherCreate() })
      refusedCreate(GPM_ANSWER, refusal)
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("create-refused")).not.toBeNull()
      install({ create: nativeCreate })
      heldCreate()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("computer")
      await continueAtSteps()
      expect(
        byTestId("phone-steps-loading") ?? container.querySelector(".ww-invite-spinner"),
      ).not.toBeNull()
      expect(warning()).toBeNull()
    })

    it("stays off with 1Password's script, and with none", async () => {
      for (const create of [onePasswordCreate(), nativeCreate]) {
        install({ create })
        heldCreate()
        await toLocalSheet()
        await continueAtSteps()
        expect(
          byTestId("phone-steps-loading") ?? container.querySelector(".ww-invite-spinner"),
        ).not.toBeNull()
        expect(warning()).toBeNull()
        await act(async () => root.unmount())
        root = createRoot(container)
        await render()
      }
    })
  })

  it("creates on this computer and reports the manager that answered", async () => {
    const held = heldCreate()
    await toLocalSheet()
    await continueAtSteps()
    expect(h.useLaptopCreation).toHaveBeenCalledWith(MAC, "computer")
    expect(createRoute(0)).toBe("this-device")
    await act(async () => held.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        route: "same_device",
        provider: "google_password_manager",
        phone_reach: "ok",
        credential_created: "yes",
      }),
    ])
  })

  it.each([
    ["the Chrome tip", "windowsEdgeBrave", "windows", "gpm", true],
    ["no Chrome tip", "macSafari", "macos", undefined, false],
  ] as const)(
    "a row with 1Password alone that opened on the phone, with %s, points at Chrome only where the sheet did",
    async (_, row, os, chromeTip, named) => {
      h.probeLaptopCreation.mockResolvedValue({
        local: true,
        os,
        row,
        managers: ["1password"],
        withdrawn: [],
        ...(chromeTip ? { chromeTip } : {}),
      })
      refusedCreate(GPM_ANSWER, () =>
        markPasskeyWritten(
          new PhoneRequiredError({ providerName: "Windows Hello", ceremony: "create" }),
        ),
      )
      await pressLabel("landing-signin")
      await deposit()
      expect(choice()).toBe("phone")
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("PhoneRequiredError")
      expect(byTestId("passkey-chrome-advice")?.textContent ?? null).toBe(
        named ? CHROME_REFUSAL_COPY : null,
      )
    },
  )

  it("an Apple answer refused here gets a card that leads with the phone and back to the sheet", async () => {
    refusedCreate(APPLE_ANSWER, () =>
      markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"])),
    )
    await toLocalSheet()
    await continueAtSteps()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "refused",
        reason: "apple_below_floor",
        provider: "icloud_keychain",
        credential_created: "yes",
      }),
    ])
    const card = byTestId("create-refused")!
    expect(card.dataset.reason).toBe("LaptopPasskeyRefusedError")
    expect(byTestId("passkey-apple-floor")).not.toBeNull()
    expect(byTestId("passkey-chrome-advice")).toBeNull()
    expect(byTestId("passkey-leftover")).not.toBeNull()
    expect(byTestId("passkey-phone")!.className).not.toContain("ww-invite-pill")
    expect(byTestId("create-retry")!.className).toContain("ww-invite-pill")
    // Try again: the sheet, on this computer, not the browser's prompt.
    const next = heldCreate()
    await press(() => byTestId("create-retry"))
    expect(byTestId("create-refused")).toBeNull()
    expect(choice()).toBe("computer")
    expect(byTestId("phone-steps-unfinished")).toBeNull()
    expect(h.createAccount).toHaveBeenCalledTimes(1)
    await continueAtSteps()
    expect(createRoute(1)).toBe("this-device")
    await act(async () => next.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toContainEqual(
      expect.objectContaining({ ceremony: "create", outcome: "succeeded" }),
    )
  })

  it.each(["macSafari"] as const)(
    "an Apple answer with no key on %s: Try again opens This Mac, now 1Password through the Mac's window",
    async (row) => {
      const managers = ["apple", "1password"] as const
      const before: LaptopCreation = { local: true, os: "macos", row, managers, withdrawn: [] }
      const after: LaptopCreation = {
        local: true,
        os: "macos",
        row,
        managers: ["1password"],
        withdrawn: [],
      }
      // The service stops offering Apple Passwords once it was refused on this page.
      let refused = false
      h.probeLaptopCreation.mockImplementation(async () => (refused ? after : before))
      refusedCreate(APPLE_ANSWER, () => {
        refused = true
        return markPasskeyWritten(
          new LaptopPasskeyRefusedError(
            "apple",
            managers.filter((m) => m !== "apple"),
          ),
        )
      })
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("LaptopPasskeyRefusedError")
      expect(byTestId("passkey-apple-floor")).not.toBeNull()
      expect(byTestId("passkey-phone")!.className).not.toContain("ww-invite-pill")
      expect(byTestId("create-refused")!.textContent).not.toMatch(/choose Apple Passwords/)
      heldCreate()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("computer")
      // The probe dropped Apple Passwords, so the option it opens on no longer names it.
      expect(byTestId("phone-steps-choice")!.textContent).not.toContain("iCloud Keychain")
      await continueAtSteps()
      expect(h.useLaptopCreation).toHaveBeenLastCalledWith(after, "computer")
      expect(createRoute(1)).toBe("this-device")
    },
  )

  describe("the 1Password advice", () => {
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const install = (value: unknown) =>
      Object.defineProperty(navigator, "credentials", { value, configurable: true })
    const advice = () => byTestId("passkey-extension-advice")
    /** The refusal as the creation driver raises it: naming the manager that answered. */
    const noKey = (manager: "1password" | "gpm" = "1password") =>
      markPasskeyWritten(new NoPrfError({ localManagers: ["gpm", "1password"], manager }))
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it.each([
      [
        "says to install the extension where another manager's script answers",
        { create: otherCreate() },
        "computer",
        "install",
      ],
    ] as const)("on a Windows row that admits 1Password, %s", async (_n, calls, opens, wording) => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install(calls)
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet(opens)
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()?.textContent).toBe(EXTENSION_ADVICE_COPY[wording])
      expect(byTestId("passkey-leftover")).not.toBeNull()
      expect(byTestId("passkey-phone")).not.toBeNull()
    })

    it("retries This computer's refusal on 1Password, whose option the pop-up answers", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install({ create: onePasswordCreate() })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet("1password")
      await pick("computer")
      await continueAtSteps()
      expect(advice()?.textContent).toBe(EXTENSION_ADVICE_COPY.use)
      heldCreate()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("1password")
    })

    it("stays off when another manager answered without key material, and for another refusal", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install({ create: onePasswordCreate() })
      refusedCreate(GPM_ANSWER, () => noKey("gpm"))
      await toLocalSheet("1password")
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      refusedCreate(ONEPASSWORD_ANSWER, () =>
        markPasskeyWritten(new LaptopPasskeyRefusedError("unnamed", ["gpm", "1password"])),
      )
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("1password")
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("LaptopPasskeyRefusedError")
      expect(advice()).toBeNull()
    })

    it("stays off on a Mac row, and on a Windows row that does not admit 1Password", async () => {
      install({ create: onePasswordCreate() })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      h.probeLaptopCreation.mockResolvedValue({
        ...WINDOWS,
        managers: ["gpm"],
        withdrawn: ["1password"],
      })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await press(() => byTestId("create-retry"))
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()
    })
  })

  describe("once a manager the row cannot use kept answering", () => {
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const ONEPASSWORD_ONLY: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsEdgeBrave",
      managers: ["1password"],
      withdrawn: [],
      chromeTip: "gpm",
    }
    const otherManager = () =>
      markPasskeyWritten(
        new UnsupportedProviderError("manager", {
          providerName: "Bitwarden",
          localManagers: ["1password"],
        }),
      )
    beforeEach(() => {
      h.probeLaptopCreation.mockResolvedValue(ONEPASSWORD_ONLY)
      Object.defineProperty(navigator, "credentials", {
        value: { create: onePasswordCreate() },
        configurable: true,
      })
    })
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it("on a row with 1Password alone, the card's Try again opens the sheet on the phone", async () => {
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet("1password")
      await continueAtSteps()
      expect(byTestId("create-refused")!.dataset.reason).toBe("UnsupportedProviderError")
      for (let i = 0; i <= LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      const next = heldCreate()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("phone")
      expect(byTestId("phone-steps-steered")!.textContent).toBe(
        PHONE_STEPS_COPY.local.steered.phone,
      )
      // 1Password is still a pick away.
      expect(await offered()).toEqual(["1password", "phone", "key"])
      await continueAtSteps()
      expect(createRoute(1)).toBe("phone")
      await act(async () => next.request!.answer())
      await flush()
    })

    it("on a row with this computer's own manager, Try again keeps it and says why", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet("1password")
      await continueAtSteps()
      for (let i = 0; i <= LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("computer")
      expect(byTestId("phone-steps-steered")).toBeNull()
      expect(byTestId("phone-steps-advice")!.textContent).toContain(
        PHONE_STEPS_COPY.local.refusedOften,
      )
    })

    it("over the limit, the card's phone exit and a closed phone prompt keep the phone", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      for (let i = 0; i <= LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet("computer")
      await continueAtSteps()
      await press(() => byTestId("passkey-phone"))
      expect(choice()).toBe("phone")
      expect(byTestId("phone-steps-steered")).toBeNull()
      closedCreate()
      await continueAtSteps()
      expect(createRoute(1)).toBe("phone")
      expect(choice()).toBe("phone")
      expect(byTestId("phone-steps-unfinished")!.textContent).toBe(
        PHONE_STEPS_COPY.local.unfinishedElsewhere,
      )
      expect(byTestId("phone-steps-steered")).toBeNull()
    })

    it("at the limit, Try again still opens on 1Password", async () => {
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet("1password")
      await continueAtSteps()
      for (let i = 0; i < LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("1password")
      expect(byTestId("phone-steps-steered")).toBeNull()
    })

    it("a closed 1Password prompt re-opens on 1Password, saying so, past the limit too", async () => {
      for (let i = 0; i <= LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      closedCreate()
      await toLocalSheet("phone")
      await pick("1password")
      await continueAtSteps()
      expect(h.useLaptopCreation).toHaveBeenLastCalledWith(ONEPASSWORD_ONLY, "1password")
      expect(createRoute(0)).toBe("this-device")
      expect(choice()).toBe("1password")
      expect(byTestId("phone-steps-unfinished")).not.toBeNull()
      expect(byTestId("phone-steps-steered")).toBeNull()
    })

    it("an extension that appears after the sheet opened moves nothing", async () => {
      Object.defineProperty(navigator, "credentials", {
        value: { create: nativeCreate },
        configurable: true,
      })
      await toLocalSheet("phone")
      Object.defineProperty(navigator, "credentials", {
        value: { create: onePasswordCreate() },
        configurable: true,
      })
      expect(await offered()).toEqual(["phone", "key"])
      expect(choice()).toBe("phone")
    })
  })

  it("the refusal's phone exit re-opens the sheet on the phone, with this computer a pick away", async () => {
    refusedCreate(APPLE_ANSWER, () =>
      markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"])),
    )
    await toLocalSheet()
    await continueAtSteps()
    const next = heldCreate()
    await press(() => byTestId("passkey-phone"))
    expect(choice()).toBe("phone")
    expect(await offered()).toEqual(["computer", "phone", "key"])
    await continueAtSteps()
    expect(createRoute(1)).toBe("phone")
    await act(async () => next.request!.answer())
    await flush()
    expect(events()).toHaveLength(2)
  })

  it("a prompt closed on this computer with nothing made re-opens the sheet, saying so", async () => {
    closedCreate()
    await toLocalSheet()
    await continueAtSteps()
    // No card, no error line: the sheet again, on this computer, with the unfinished line.
    expect(byTestId("create-refused")).toBeNull()
    expect(container.textContent).not.toContain("Nothing was created")
    expect(choice()).toBe("computer")
    expect(byTestId("phone-steps-unfinished")!.textContent).toBe(PHONE_STEPS_COPY.local.unfinished)
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "create", reason: "prompt_closed", prompts: "1" }),
    ])
    // The next pick is a new attempt.
    const next = heldCreate()
    await continueAtSteps()
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    await act(async () => next.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toHaveLength(2)
    expect(events()[1]).toMatchObject({ outcome: "succeeded", attempt: "2" })
  })

  it.each([["key", "security-key"]] as const)(
    "a closed prompt on the %s route goes back to it, saying setup didn't finish, with no error",
    async (picked, route) => {
      closedCreate()
      await toLocalSheet()
      await pick(picked)
      await continueAtSteps()
      expect(createRoute(0)).toBe(route)
      expect(container.querySelector(".ww-invite-modal-error")).toBeNull()
      expect(choice()).toBe(picked)
      // Another device is already the choice, so the line does not offer the phone.
      const line = byTestId("phone-steps-unfinished")!
      expect(line.textContent).toBe(PHONE_STEPS_COPY.local.unfinishedElsewhere)
      expect(line.getAttribute("role")).toBe("alert")
      expect(byTestId("create-refused")).toBeNull()
    },
  )

  it.each(["no-hybrid"] as const)(
    "a refused key attempt's Try again re-opens on the key, with this computer a pick away (reach %s)",
    async (reach) => {
      h.probePhoneReach.mockResolvedValue(reach)
      refusedCreate({ authenticatorAttachment: "cross-platform", backupEligible: false }, () =>
        markPasskeyWritten(new NoPrfError()),
      )
      await toLocalSheet()
      await pick("key")
      expect(choice()).toBe("key")
      await continueAtSteps()
      expect(createRoute(0)).toBe("security-key")
      expect(byTestId("create-refused")).not.toBeNull()
      expect(byTestId("passkey-phone")).toBeNull()
      await press(() => byTestId("create-retry"))
      expect(choice()).toBe("key")
      await pick("computer")
      expect(choice()).toBe("computer")
    },
  )

  it("a key answering under This computer is reported as a security key", async () => {
    const held = heldCreate()
    await toLocalSheet()
    await continueAtSteps()
    expect(createRoute(0)).toBe("this-device")
    await act(async () =>
      held.request!.answer({
        authenticatorAttachment: "cross-platform",
        backupEligible: false,
        transports: ["usb"],
      }),
    )
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "succeeded", route: "security_key" }),
    ])
  })

  describe("the picked option's advice, on Windows Chrome", () => {
    const advice = () => byTestId("phone-steps-advice")!
    let ua: { mockRestore: () => void }
    beforeEach(() => {
      ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_CHROME_UA)
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
    })
    afterEach(() => {
      ua.mockRestore()
    })

    it("links the supported passkeys under Continue, with no tip to open", async () => {
      await toLocalSheet()
      expect(byTestId("phone-steps-supported")).toBeNull()
      expect(byTestId("phone-steps-chrome-tip")).toBeNull()
      const docs = byTestId("phone-steps-docs") as HTMLAnchorElement
      expect(docs.textContent).toBe(PHONE_STEPS_COPY.local.docs.label)
      expect(docs.href).toContain(`/docs/passkeys#${PHONE_STEPS_COPY.local.docs.anchor}`)
    })

    it("replaces the advice in its live region as the pick changes, leaving focus on the picker", async () => {
      await toLocalSheet()
      expect(advice().getAttribute("aria-live")).toBe("polite")
      expect(advice().textContent).toBe(PHONE_STEPS_COPY.local.installExtension)
      expect(byTestId("phone-steps-key-warning")).toBeNull()
      await pick("phone-or-key")
      expect(advice().textContent).toBe(SIGN_UP_SHEET_COPY.phoneOrKey.windows)
      expect(document.activeElement).toBe(byTestId("phone-steps-choice"))
      // The key warning is a line of its own, outside the live region.
      const warning = byTestId("phone-steps-key-warning")!
      expect(advice().contains(warning)).toBe(false)
      expect(warning.textContent).toContain(SIGN_UP_SHEET_COPY.keyWarning.note)
    })

    it("Escape closes the key warning's tip and nothing else", async () => {
      await toLocalSheet()
      await pick("phone-or-key")
      const row = byTestId("phone-steps-key-warning")!
      const label = row.querySelector("button")!
      await act(async () => label.click())
      expect(row.dataset.open).toBeDefined()
      label.focus()
      await act(async () => {
        label.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      await flush()
      expect(row.dataset.open).toBeUndefined()
      expect(document.activeElement).toBe(label)
      expect(byTestId("phone-steps")).not.toBeNull()
      expect(closeButton()).not.toBeNull()
    })
  })

  /**
   * Windows refuses a request at once while another passkey dialog is open, in any browser: a
   * NotAllowedError back within a second of the request means no prompt opened.
   */
  describe("a request refused before any prompt could open", () => {
    const refusedAtOnce = () => {
      const refused = new DOMException("blocked", "NotAllowedError")
      recordRequestHeld(refused, 200)
      return refused
    }
    /** The next create's request is refused at once. */
    const blockedCreate = () =>
      h.createAccount.mockImplementationOnce(async () => {
        const request = harness.request("create")
        request.reject(refusedAtOnce())
        await request.settled
      })
    const line = () => byTestId("phone-steps-blocked")

    it("re-opens the sheet where it was, saying to close other passkey windows, with no card", async () => {
      blockedCreate()
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("create-refused")).toBeNull()
      expect(container.querySelector(".ww-invite-modal-error")).toBeNull()
      expect(choice()).toBe("computer")
      expect(byTestId("phone-steps-unfinished")).toBeNull()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
      expect(line()!.getAttribute("role")).toBe("alert")
      // Telemetry reads it as any closed prompt: the hold is the row's elapsed bucket, nothing more.
      expect(events()).toEqual([
        expect.objectContaining({
          ceremony: "create",
          outcome: "cancelled",
          reason: "prompt_closed",
          credential_created: "no",
          prompts: "1",
          elapsed: "under_1s",
        }),
      ])
      // The next pick is a new attempt.
      const next = heldCreate()
      await continueAtSteps()
      expect(h.createAccount).toHaveBeenCalledTimes(2)
      await act(async () => next.request!.answer(GPM_ANSWER))
      await flush()
      expect(events()[1]).toMatchObject({ outcome: "succeeded", attempt: "2" })
    })

    it("says to try another browser from the second refusal in a row, until a prompt opens", async () => {
      blockedCreate()
      await toLocalSheet()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
      blockedCreate()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blockedAgain)
      blockedCreate()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blockedAgain)
      // A prompt that opened and closed ends the run: the next refusal is a first again.
      closedCreate()
      await continueAtSteps()
      expect(line()).toBeNull()
      expect(byTestId("phone-steps-unfinished")!.textContent).toBe(
        PHONE_STEPS_COPY.local.unfinished,
      )
      blockedCreate()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
    })

    it("closing the sheet between two such refusals ends the run", async () => {
      blockedCreate()
      await toLocalSheet()
      await continueAtSteps()
      await closeSheet()
      blockedCreate()
      await toLocalSheet()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
    })

    it("a refusal that reaches an attempt the user already closed counts for nothing", async () => {
      const held = heldCreate()
      await toLocalSheet()
      await continueAtSteps()
      await closeSheet()
      await act(async () => held.request!.reject(refusedAtOnce()))
      await flush()
      blockedCreate()
      await toLocalSheet()
      await continueAtSteps()
      expect(line()!.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
    })

    it("a refusal after the passkey was made lands on the card, whatever its speed", async () => {
      refusedCreate(GPM_ANSWER, () => markPasskeyWritten(refusedAtOnce()))
      await toLocalSheet()
      await continueAtSteps()
      expect(byTestId("phone-steps")).toBeNull()
      expect(byTestId("create-refused")!.dataset.reason).toBe("NotAllowedError")
      expect(byTestId("passkey-leftover")).not.toBeNull()
    })
  })

  /** Windows' own passkey window offers the phone and a key whatever is asked, in every browser. */
  describe("the sheet on Windows", () => {
    const EDGE_BRAVE_ROW: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsEdgeBrave",
      managers: ["1password"],
      withdrawn: [],
      chromeTip: "gpm",
    }
    let ua: { mockRestore: () => void }
    beforeEach(() => {
      ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_CHROME_UA)
    })
    afterEach(() => {
      ua.mockRestore()
    })

    it("Edge and Brave, with nothing local, get the one phone-or-key option, with the Windows line", async () => {
      h.probeLaptopCreation.mockResolvedValue(EDGE_BRAVE_ROW)
      heldCreate()
      await pressLabel("landing-signin")
      await deposit()
      expect(choice()).toBe("phone-or-key")
      expect(byTestId("phone-steps-choice")).toBeNull()
      expect(byTestId("phone-steps-advice")!.textContent).toContain(
        SIGN_UP_SHEET_COPY.phoneOrKey.windows,
      )
      await continueAtSteps()
      expect(createRoute(0)).toBe("phone")
      expect(h.useLaptopCreation).toHaveBeenLastCalledWith(EDGE_BRAVE_ROW, "phone-or-key")
    })
  })
})

/** Windows and Linux Firefox sign up in 1Password through its extension, or on another device. */
describe("signup create in Firefox on Windows", () => {
  const FIREFOX_ROW: LaptopCreation = {
    local: true,
    os: "windows",
    row: "windowsFirefox",
    managers: ["1password"],
    withdrawn: [],
    chromeTip: "gpm",
  }
  const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
  let ua: { mockRestore: () => void }
  beforeEach(() => {
    h.createAccount.mockReset()
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_FIREFOX_UA)
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(FIREFOX_ROW)
  })
  afterEach(() => {
    ua.mockRestore()
    if (credentials) Object.defineProperty(navigator, "credentials", credentials)
    else delete (navigator as { credentials?: unknown }).credentials
  })
  const createRoute = () =>
    (h.createAccount.mock.calls[0]?.[5] as { route?: string } | undefined)?.route

  it("with no extension, offers one card and says how to add 1Password", async () => {
    heldCreate()
    await pressLabel("landing-signin")
    await deposit()
    expect(choice()).toBe("phone-or-key")
    expect(byTestId("phone-steps-choice")).toBeNull()
    expect(byTestId("phone-steps")!.textContent).not.toContain(SIGN_UP_SHEET_COPY.pickerLabel)
    const install = byTestId("phone-steps-install-extension")!
    expect(install.textContent).toBe(PHONE_STEPS_COPY.local.installExtension)
    // The Chrome line speaks to the same user, so it sits just above.
    const chrome = byTestId("phone-steps-chrome-tip")!
    const { lead, gpm } = PHONE_STEPS_COPY.chromeTip
    expect(chrome.querySelector("strong")!.textContent).toBe(lead)
    expect(chrome.textContent).toBe(`${lead} ${gpm}`)
    expect(chrome.compareDocumentPosition(install) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    await continueAtSteps()
    expect(createRoute()).toBe("phone")
    expect(h.useLaptopCreation).toHaveBeenLastCalledWith(FIREFOX_ROW, "phone-or-key")
  })
})

/**
 * The campaign hand-off as it ships: a silent attempt on mount, and the terms sheet's Deposit
 * spending a prompt when the bridge material was not enough. A run that asks nothing reports
 * nothing — a prompt-free success is no ceremony.
 */
describe("signup create in an app's built-in browser", () => {
  it("a create the user closed shows nothing when it then fails as not supported", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
      )
    try {
      const held = heldCreate()
      await pressLabel("landing-signin")
      // A phone has no steps to pass: Deposit asks the browser.
      await deposit()
      expect(held.request).toBeDefined()
      await closeSheet()
      await act(async () => held.request!.reject(new DOMException("late", "NotSupportedError")))
      await flush()
      expect(byTestId("create-refused")).toBeNull()
      expect(h.fireEvent.mock.calls.filter(([e]) => e === "action_failed")).toEqual([])
    } finally {
      ua.mockRestore()
    }
  })
})

/** Saving endpoints reloads the page, so the pill waits out "Unlock access" wherever it renders. */
describe("the endpoints hold", () => {
  const renderEmbedded = async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/claim/taga"]}>
          <Routes>
            <Route path="/claim/:handle?" element={<OnboardingScreen embedded />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    await flush()
  }

  it.each([true])(
    "holds while Unlock access reads the claim status (embedded: %s)",
    async (embedded) => {
      if (embedded) await renderEmbedded()
      const { endpointsHeld } = await import("../../../src/ui/endpointsHold")
      let settle!: (status: string) => void
      h.getClaimStatus.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)))
      expect(endpointsHeld()).toBe(false)
      await pressLabel("landing-signin")
      expect(endpointsHeld()).toBe(true)
      await act(async () => settle("claimed"))
      await flush()
      expect(endpointsHeld()).toBe(false)
    },
  )
})

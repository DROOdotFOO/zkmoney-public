/**
 * /enter under the phone policy: a refusal from the passkey policy, a passkey no anchor names, a
 * prompt that closed without one, and any other failure all keep the user on the screen with the
 * reason and a retry. Only the user's own cancel falls through to /claim.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { namehash } from "viem/ens"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { onePasswordCreate, otherCreate } from "../../support/passkeyExtensionStubs"
import { setActiveCredentialId } from "../../../src/platform/storage/activeStorage"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "../../support/passkeyTelemetryHarness"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  enterWithPasskey: vi.fn(),
  diagnoseMiss: vi.fn(),
  /** The payment link waiting in this browser, if any. */
  claimStash: undefined as string | undefined,
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  saveWalletIdentity: vi.fn(),
  getConfig: vi.fn(),
  reservedNameHashes: vi.fn(),
  nameGrantToken: vi.fn(),
  boundNameGrantOwner: vi.fn(),
  confirmTag: vi.fn(),
  /** What the confirm modal stand-in submits; its seed when unset. */
  typedTag: undefined as string | undefined,
  /** What the auth service reports; `undefined` stands for no service built yet. */
  recordsStale: false as boolean | undefined,
  /** What the browser says about reaching a phone. */
  reach: "unknown" as "ok" | "no-hybrid" | "below-floor" | "unknown",
  lookup: vi.fn(),
  getOxideTuple: vi.fn(async () => ({})),
  recoverFromCache: vi.fn(async () => undefined),
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: {} }),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: h.getConfig,
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", async () => {
  const { matchWireNameHash } = await import("@obsidion/front-core")
  return {
    enterWithPasskey: h.enterWithPasskey,
    nameGrantToken: h.nameGrantToken,
    confirmTag: h.confirmTag,
    isCommittedFailure: (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { committed?: boolean }).committed === true,
    // The real matching, without the module that drags the Aztec stack in.
    reservedTagMatch: (hashes: `0x${string}`[], ensDomain: string, handle: string) =>
      hashes.map((hash) => matchWireNameHash(handle, ensDomain, hash)).find(Boolean) ?? null,
    // The class the screen matches by instanceof; the real one drags the Aztec stack in.
    PasskeyMismatchError: class PasskeyMismatchError extends Error {
      name = "PasskeyMismatchError"
    },
    PasskeySetUnreadError: class PasskeySetUnreadError extends Error {
      name = "PasskeySetUnreadError"
    },
  }
})
vi.mock("../../../src/features/onboarding/findPasskeyByTag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/findPasskeyByTag")>()),
  diagnoseMiss: h.diagnoseMiss,
  lookupPasskeyByTag: h.lookup,
}))
vi.mock("../../../src/config/oxideTuple", () => ({ getOxideTuple: h.getOxideTuple }))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveSignInTag: vi.fn(),
  resolveSignInTagForCommit: vi.fn(),
}))
vi.mock("../../../src/features/onboarding/recoveryProbes", () => ({
  reservedNameHashes: h.reservedNameHashes,
  boundNameGrantOwner: h.boundNameGrantOwner,
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: async () => h.reach,
    recoverFromCache: h.recoverFromCache,
  }),
  peekAuthService: () =>
    h.recordsStale === undefined ? undefined : { recordsStale: () => h.recordsStale },
}))
vi.mock("../../../src/features/identity/walletIdentity", async (importOriginal) => ({
  // The session's own identity view.
  ...(await importOriginal<typeof import("../../../src/features/identity/walletIdentity")>()),
  saveWalletIdentity: h.saveWalletIdentity,
  loadWalletIdentity: () => null,
}))
vi.mock("../../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  // The session's feed reads the rest.
  ...(await importOriginal<typeof import("../../../src/features/onboarding/webRegistration")>()),
  getPendingStore: () => ({ list: () => [], load: async () => {}, onListChanged: () => () => {} }),
}))
vi.mock("../../../src/features/paylink/claimStash", () => ({ peekClaimStash: () => h.claimStash }))
vi.mock("../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (f: string) => `id:${f}`,
}))
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({ decodeLink: vi.fn() }))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  fireOnboardingEvent: vi.fn(),
  reportLanding: vi.fn(),
  failureCode: (e: unknown) => (e instanceof Error ? e.name : "err"),
}))
vi.mock("../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
// The sign-in cancel sits on this body and is handed the exit as the function itself.
vi.mock("../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingSpinnerBody: ({
    label,
    cancelLabel,
    onCancel,
  }: {
    label: string
    cancelLabel?: string
    onCancel?: () => void
  }) => (
    <div>
      {label}
      <button data-testid="spinner-cancel" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  ),
}))
// The card's two roles: the start role's actions and the confirm step's way back are what the
// screen wires, so the stand-in exposes them; the real card has its own suite.
vi.mock("../../../src/features/onboarding/steps/ConfirmTagModal", () => ({
  ConfirmTagModal: ({
    initialHandle,
    error,
    submitTitle,
    start,
    onConfirm,
    onShowPasskeys,
    onBack,
    onClose,
  }: {
    initialHandle?: string
    error?: string
    submitTitle?: string
    start?: import("../../../src/features/onboarding/steps/ConfirmTagModal").SignInStart
    onConfirm: (handle: string) => void
    onShowPasskeys?: () => void
    onBack?: () => void
    onClose: () => void
  }) => {
    if (start) {
      const live = start.prepared === "ready" && !start.busy
      return (
        <div data-testid="sign-in-start" data-prepared={start.prepared}>
          {start.candidates.map((c) => (
            <button
              key={c.credentialId}
              data-testid="sign-in-account"
              data-tag={c.usertag}
              disabled={!live}
              onClick={() => start.onCandidate(c)}
            />
          ))}
          {start.notice && <p data-testid={`by-tag-${start.notice.kind}`}>{start.notice.tag}</p>}
          <button
            data-testid="sign-in-login"
            disabled={!(start.submitReady && live)}
            onClick={() => onConfirm(start.value)}
          />
          <button data-testid="sign-in-show-passkeys" disabled={!live} onClick={onShowPasskeys} />
          <button data-testid="sign-in-close" onClick={onClose} />
        </div>
      )
    }
    return (
      <div
        data-testid="confirm-tag"
        data-handle={initialHandle}
        data-title={submitTitle ?? "Login"}
      >
        {error && <p data-testid="confirm-tag-error">{error}</p>}
        <button data-testid="confirm-back" onClick={onBack} />
        <button data-testid="confirm-tag-close" onClick={onClose} />
        <button
          data-testid="confirm-tag-submit"
          onClick={() => onConfirm(h.typedTag ?? initialHandle ?? "")}
        />
      </div>
    )
  },
}))
vi.mock("../../../src/features/onboarding/steps/InvitationStep", () => ({
  InvitationStep: () => null,
}))
// The backdrop behind the modals mounts the boot splash, whose fade timer outlives the file.
vi.mock("../../../src/features/onboarding/steps/CreateWalletStep", () => ({
  CreateWalletStep: () => null,
}))
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
  }: {
    title: string
    testId?: string
    onClick?: () => void
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

// The module registry is reset per test, so the errors come from the same registry as the screen:
// `isPasskeyPolicyError` is an `instanceof` check.
const policyErrors = () => import("@obsidion/passkey-web")

type Entry = { pathname: string; search?: string; state?: unknown }

/**
 * The page as the active tab leaves it: its wallet up, and the anonymous session open. Every
 * session the screen's sign-in opens reads the same wallet.
 */
async function openPage() {
  const { activateTab } = await import("../../../src/platform/storage/activeTab")
  const { startPageWallet } = await import("../../../src/platform/wallet")
  const { namespaceOf, switchSession } = await import("../../../src/platform/session")
  activateTab()
  const target = { kind: "pxe", identity: {}, bootStartedAt: 0, attempts: 1 } as never
  const wallet = startPageWallet(
    {} as never,
    target,
    async () => ({ wallet: true, node: {} } as never),
  )
  wallet.demand()
  await vi.waitFor(() => expect(wallet.get().status).toBe("ready"))
  switchSession(namespaceOf(null))
}

async function render(path: string | Entry = "/enter") {
  const { EnterAppScreen } = await import("../../../src/features/onboarding/EnterAppScreen")
  await openPage()
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path as string]}>
        <EnterAppScreen />
      </MemoryRouter>,
    )
  })
  await flush()
}

type EnterOptions = {
  gate: () => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  chooser?: boolean
  own?: import("@obsidion/passkey-web").PasskeyRequestScope
}
/** An entry that waits at the gate the way the real one does, then answers `result`. */
const gatedEntry = (result: unknown) =>
  h.enterWithPasskey.mockImplementationOnce(
    async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
      await options.gate()
      return result
    },
  )
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const leaveAssign = vi.fn()
/** The browser's address for `path`, as the screen and its refusal card read it. */
const addressed = (path: string) => {
  const url = new URL(path, "https://wallet.test")
  const { origin, host, href, pathname, search, hash } = url
  return { assign: leaveAssign, origin, host, href, pathname, search, hash }
}
/** The screen exited to where signing in starts. */
const leftForSignInStart = () =>
  h.navigate.mock.calls.some((call) => (call as unknown[])[0] === "/claim")

const L2 = `0x${"ac".repeat(32)}`
/** @alice read off L1: her account and its one installed key. */
const FOUND_ALICE = {
  kind: "resolved",
  tag: "alice",
  account: `0x${"11".repeat(20)}`,
  l2Address: L2,
  keys: [
    {
      pubkeyHex: "ab".repeat(64),
      metadata: `0x${"07".repeat(16)}`,
      parsed: { kind: "credential-id", credentialId: "cred-alice" },
    },
  ],
  moreKeys: false,
}
/** A recovered account with no registered name. */
const nameless = (address = L2) => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => address }) },
  held: () => true,
  bootstrap: {
    address: "0xE0A0000000000000000000000000000000000001",
    signMessage: async () => "0xsig",
  },
  ensDomain: "zk.money",
})

const refused = () => container.querySelector<HTMLElement>('[data-testid="enter-refused"]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="enter-retry"]')!
const screen = () => byTestId("sign-in-start")
const click = async (id: string) => {
  await act(async () => byTestId(id)!.click())
  await flush()
}
/** A probe that finds no cached key, so the screen shows. */
const needsCeremony = () =>
  h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "ceremony-required" })

beforeEach(() => {
  vi.resetModules()
  h.navigate.mockClear()
  h.enterWithPasskey.mockReset()
  h.lookup.mockReset().mockResolvedValue({ kind: "notFound" })
  h.getOxideTuple.mockReset().mockResolvedValue({})
  h.recoverFromCache.mockReset().mockResolvedValue(undefined)
  h.diagnoseMiss.mockReset()
  h.showReportableError.mockClear()
  h.fireEvent.mockClear()
  h.saveWalletIdentity.mockClear()
  h.reservedNameHashes.mockReset().mockResolvedValue([])
  h.nameGrantToken.mockReset().mockReturnValue(undefined)
  h.boundNameGrantOwner.mockReset().mockResolvedValue(false)
  h.confirmTag.mockReset()
  h.typedTag = undefined
  h.claimStash = undefined
  h.recordsStale = false
  h.reach = "unknown"
  h.getConfig.mockReturnValue({
    rpId: "localhost",
    campaignUrl: "https://launch.test.invalid",
    accountServiceTestMode: false,
  })
  leaveAssign.mockClear()
  vi.stubGlobal("location", addressed("/enter"))
  localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("EnterAppScreen refusals", () => {
  it("a phone-required refusal stays on /enter with the reason and a retry", async () => {
    const { PhoneRequiredError, DeviceBoundPasskeyError } = await policyErrors()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await render()
    expect(container.textContent).toContain("Use your phone")
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")
    expect(leftForSignInStart()).toBe(false)
    // Not an error to report, but a failed entry the funnel counts.
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "PhoneRequiredError",
    })

    h.enterWithPasskey.mockRejectedValueOnce(new DeviceBoundPasskeyError())
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("can't be backed up")
    expect(refused()?.dataset.reason).toBe("DeviceBoundPasskeyError")
    expect(leftForSignInStart()).toBe(false)
  })

  it("a passkey no anchor names on an incomplete catalog gets a retry, not no wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      catalogIncomplete: true,
    })
    await render()
    expect(refused()?.dataset.reason).toBe("error")
    expect(container.textContent).not.toContain("No wallet was found")
    expect(leftForSignInStart()).toBe(false)
  })

  describe("a laptop refused for want of key material", () => {
    const WINDOWS_CHROME_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
    const LINUX_CHROME_UA =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const install = (value: unknown) =>
      Object.defineProperty(navigator, "credentials", { value, configurable: true })
    let ua: { mockRestore: () => void } | undefined
    const asBrowser = (userAgent: string) => {
      ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    }
    const advice = () => byTestId("passkey-extension-advice")
    /** The refusal as the auth service throws it once an assertion ran: with what answered. */
    const noPrf = async (attachment?: "platform" | "cross-platform") => {
      const { NoPrfError } = await policyErrors()
      const e = new NoPrfError()
      return attachment ? Object.assign(e, { observed: { credentialId: "id", attachment } }) : e
    }
    afterEach(() => {
      ua?.mockRestore()
      ua = undefined
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it.each([
      [
        "names the extension's pop-up where 1Password's script answers",
        { create: onePasswordCreate() },
        "use",
      ],
      [
        "says to install the extension where another manager's script answers",
        { create: otherCreate() },
        "install",
      ],
    ] as const)("on Windows, where this computer answered, %s", async (_n, calls, wording) => {
      const { EXTENSION_ADVICE_COPY } = await policyErrors()
      asBrowser(WINDOWS_CHROME_UA)
      install(calls)
      h.enterWithPasskey.mockRejectedValueOnce(await noPrf("platform"))
      await render()
      expect(refused()?.dataset.reason).toBe("NoPrfError")
      expect(advice()?.textContent).toBe(EXTENSION_ADVICE_COPY[wording])
      expect(retry()).not.toBeNull()
    })

    it("gets no advice on Windows when another device answered, when nothing says what answered, or for another refusal", async () => {
      const { DeviceBoundPasskeyError } = await policyErrors()
      asBrowser(WINDOWS_CHROME_UA)
      install({ get: async () => null })
      h.enterWithPasskey.mockRejectedValueOnce(await noPrf("cross-platform"))
      await render()
      expect(refused()?.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      h.enterWithPasskey.mockRejectedValueOnce(await noPrf())
      await act(async () => retry().click())
      await flush()
      expect(refused()?.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      h.enterWithPasskey.mockRejectedValueOnce(
        Object.assign(new DeviceBoundPasskeyError(), {
          observed: { credentialId: "id", attachment: "platform" },
        }),
      )
      await act(async () => retry().click())
      await flush()
      expect(refused()?.dataset.reason).toBe("DeviceBoundPasskeyError")
      expect(advice()).toBeNull()
    })

    it.each([["Linux", LINUX_CHROME_UA]])(
      "gets no advice on %s, which has no Windows passkey window",
      async (_n, userAgent) => {
        asBrowser(userAgent)
        install({ get: async () => null })
        h.enterWithPasskey.mockRejectedValueOnce(await noPrf("platform"))
        await render()
        expect(refused()?.dataset.reason).toBe("NoPrfError")
        expect(advice()).toBeNull()
      },
    )
  })

  it("a cancel while the identity is saved leaves the hint unwritten and navigates nowhere", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: true,
      handle: "alice",
      address: L2,
      account: {},
      held: () => true,
    })
    let release!: () => void
    h.saveWalletIdentity.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    await render()
    expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()

    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    expect(leftForSignInStart()).toBe(true)
    // The save asks this before writing the passkey hint under the map lock.
    const owns = h.saveWalletIdentity.mock.calls[0][1] as () => boolean
    expect(owns()).toBe(false)

    await act(async () => release())
    await flush()
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
  })

  it("a nameless account with no reservation is sent to finish signing up, not into the wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(leftForSignInStart()).toBe(false)

    await act(async () => byTestId("enter-continue")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a nameless account that is a stashed link's unfinished signup goes back to that link", async () => {
    const { saveTicketSignupAccount } = await import(
      "../../../src/features/paylink/ticketSignupAccount"
    )
    h.claimStash = "paylink-frag"
    saveTicketSignupAccount("localhost", "id:paylink-frag", {
      credentialId: "cred",
      l2Address: L2,
      tag: "river",
    })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(h.navigate).toHaveBeenCalledWith("/link#paylink-frag", { replace: true })
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
    localStorage.clear()
  })

  it("a stashed link's signup for another account leaves the nameless card", async () => {
    const { saveTicketSignupAccount } = await import(
      "../../../src/features/paylink/ticketSignupAccount"
    )
    h.claimStash = "paylink-frag"
    saveTicketSignupAccount("localhost", "id:paylink-frag", {
      credentialId: "cred",
      l2Address: `0x${"bd".repeat(32)}`,
      tag: "river",
    })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(h.navigate).not.toHaveBeenCalledWith("/link#paylink-frag", { replace: true })
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    localStorage.clear()
  })

  it("a nameless account's card offers another passkey, which opens the chooser again", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    expect(byTestId("enter-cancel")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: true,
      handle: "alice",
      address: L2,
      account: {},
      held: () => true,
    })
    await act(async () => byTestId("enter-show-passkeys")!.click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(refused()).toBeNull()
  })

  it("an arrival read that could not answer shows the screen, unreported, and keeps the user off /claim", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it("an account-service lookup that timed out on the chooser is the network refusal, not a closed prompt", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(retry()).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "passkey_prompt_closed",
    })
  })

  it("the screen owns the tap: Show passkeys opens the chooser at once, with no sheet between", async () => {
    needsCeremony()
    await render()
    expect(screen()).not.toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(refused()).toBeNull()

    gatedEntry({ entered: false, reason: "unknown" })
    await click("sign-in-show-passkeys")
    expect(screen()).toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(leftForSignInStart()).toBe(false)
  })

  it("Cancel on the screen returns to /claim with nothing reported", async () => {
    needsCeremony()
    await render()
    await click("sign-in-close")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
    expect(refused()).toBeNull()
    expect(leftForSignInStart()).toBe(true)
  })

  it("?choose=1 skips the probe and its Show passkeys asks the browser to list every passkey", async () => {
    await render("/enter?choose=1")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
    h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ chooser: true, restoreCache: false }),
    )
  })

  it.each([
    ["NotAllowedError", () => new DOMException("closed", "NotAllowedError")],
    ["AbortError", () => new DOMException("closed", "AbortError")],
    ["no credential", () => new Error("Passkey assertion returned no credential")],
  ])(
    "a chooser closed with %s stays here with Back to the screen, nothing reported",
    async (_name, closed) => {
      needsCeremony()
      await render()
      h.enterWithPasskey.mockRejectedValueOnce(closed())
      await click("sign-in-show-passkeys")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(refused()?.dataset.reason).toBe("PasskeyNotOfferedError")
      expect(container.textContent).toContain("Your passkey wasn't offered")
      // The screen is where the user tries again, so no retry; a laptop's closed prompt gets no
      // cause list — the browser's own chooser is the guidance there.
      expect(retry()).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(byTestId("passkey-causes")).toBeNull()
      expect(leftForSignInStart()).toBe(false)
      expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
        action: "enter",
        code: "passkey_prompt_closed",
      })

      await click("enter-back")
      expect(refused()).toBeNull()
      expect(screen()).not.toBeNull()
      await click("sign-in-close")
      expect(leftForSignInStart()).toBe(true)
    },
  )

  it("a passkey no anchor names offers Back to the screen and the cancel, no retry", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "unknown" })
    await render()
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(retry()).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    await click("enter-back")
    expect(screen()).not.toBeNull()
    // Back re-prepares: the manifest and the cache proof, no prompt.
    expect(h.getOxideTuple).toHaveBeenCalledTimes(1)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
  })

  it("Cancel sign-in past the prompt ends the attempt as well as the screen", async () => {
    let attempt: AbortSignal | undefined
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        attempt = (await options.gate()).signal
        await new Promise(() => {})
      },
    )
    await click("sign-in-show-passkeys")
    expect(attempt?.aborted).toBe(false)
    await click("spinner-cancel")
    expect(attempt?.aborted).toBe(true)
    expect(leftForSignInStart()).toBe(true)
  })
})

describe("EnterAppScreen miss diagnosis", () => {
  const unknownMiss = () =>
    gatedEntry({
      entered: false,
      reason: "unknown",
      credentialId: "cred-a",
      pubkey: "ab".repeat(64),
      addresses: ["0xelsewhere"],
      observed: { credentialId: "cred-a", attachment: "platform" },
    })

  it("a miss card offers Back to the screen, not a retry; the screen is where the next try starts", async () => {
    needsCeremony()
    await render()
    unknownMiss()
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    await click("enter-back")
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    gatedEntry({ entered: false, reason: "unknown" })
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(3)
  })

  it.each(["DIFFERENT_PASSKEY", "INCONCLUSIVE", "NOT_REPRODUCED_HERE"])(
    "a %s verdict offers Back and the cancel, no retry, and its text names only those",
    async (diagnosis) => {
      h.diagnoseMiss.mockResolvedValue(diagnosis)
      needsCeremony()
      await render("/enter?handle=alice")
      unknownMiss()
      await click("sign-in-show-passkeys")
      expect(refused()).not.toBeNull()
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(refused()!.textContent).not.toMatch(/try again/i)
      expect(refused()!.textContent).toMatch(/Go back/)
    },
  )

  it("a record-anchored wrong-key mismatch shows the certain card with Show passkeys and no retry", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        throw Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key" })
      },
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await click("enter-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(3)
    expect(h.enterWithPasskey.mock.calls.at(-1)![3]).toMatchObject({ chooser: true })
  })

  describe("on a Mac", () => {
    const MAC_CHROME =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/155.0.0.0 Safari/537.36"
    let ua: { mockRestore: () => void } | undefined
    beforeEach(() => {
      ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_CHROME)
    })
    afterEach(() => ua?.mockRestore())

    const PLATFORM = { credentialId: "id", attachment: "platform" }
    const phoneOf = (call: number) =>
      (h.enterWithPasskey.mock.calls[call]![3] as { phone?: boolean }).phone
    const wrongKeyEntry = async (observed: object = PLATFORM) => {
      const { StoredAddressMismatchError } = await import("@obsidion/front-core")
      h.enterWithPasskey.mockImplementationOnce(
        async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
          await options.gate()
          throw Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key", observed })
        },
      )
    }

    it("a record-anchored wrong key leads with the phone; Show passkeys stays beside it", async () => {
      needsCeremony()
      await render()
      await wrongKeyEntry()
      await click("sign-in-show-passkeys")
      expect(container.textContent).toContain("until you sign out or this browser clears its data")
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-show-passkeys")).not.toBeNull()
      h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
      await click("enter-phone")
      expect(phoneOf(2)).toBe(true)
      // The phone offered nothing: its card keeps a retry that stays on the phone.
      expect(refused()?.dataset.reason).toBe("PasskeyNotOfferedError")
      h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
      await act(async () => retry().click())
      await flush()
      expect(phoneOf(3)).toBe(true)
      expect(byTestId("enter-retry")).not.toBeNull()
    })

    it("no wallet for this computer's answer leads with the phone; another device's does not", async () => {
      needsCeremony()
      await render()
      gatedEntry({ entered: false, reason: "unknown", observed: PLATFORM })
      await click("sign-in-show-passkeys")
      expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
      expect(byTestId("enter-phone")).not.toBeNull()
      expect(byTestId("enter-show-passkeys")).not.toBeNull()
      expect(byTestId("passkey-mac-update")).not.toBeNull()

      gatedEntry({ entered: false, reason: "unknown", observed: PLATFORM })
      await click("enter-phone")
      expect(phoneOf(2)).toBe(true)
      expect(byTestId("enter-phone")).not.toBeNull()

      gatedEntry({
        entered: false,
        reason: "unknown",
        observed: { credentialId: "id", attachment: "cross-platform" },
      })
      await click("enter-show-passkeys")
      expect(phoneOf(3)).toBeUndefined()
      expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
      expect(byTestId("enter-phone")).toBeNull()
      expect(byTestId("passkey-mac-update")).toBeNull()
    })
  })

  it("a not-reproduced record mismatch keeps its retry", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        throw Object.assign(new StoredAddressMismatchError(), { verdict: "not-reproduced" })
      },
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-show-passkeys")).toBeNull()
  })

  it("leaving the screen ends the attempt behind the prompt", async () => {
    let attempt: AbortSignal | undefined
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        attempt = (await options.gate()).signal
        await new Promise(() => {})
      },
    )
    await click("sign-in-show-passkeys")
    expect(attempt?.aborted).toBe(false)
    act(() => root.unmount())
    expect(attempt?.aborted).toBe(true)
    root = createRoot(container)
  })

  it("a cancel during the diagnosis shows no card and reports nothing", async () => {
    let answer!: (diagnosis: string) => void
    h.diagnoseMiss.mockReturnValueOnce(new Promise<string>((resolve) => (answer = resolve)))
    needsCeremony()
    await render("/enter?handle=alice")
    unknownMiss()
    await click("sign-in-show-passkeys")
    expect(h.diagnoseMiss).toHaveBeenCalledTimes(1)
    await click("spinner-cancel")
    h.fireEvent.mockClear()
    await act(async () => answer("DIFFERENT_PASSKEY"))
    await flush()
    expect(refused()).toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })
})

/**
 * A nameless account account-service holds a claim for: the signup continues as the tag the claim
 * names, confirmed on the same step a registered account uses.
 */
describe("EnterAppScreen reservation", () => {
  const hashOf = (tag: string) => namehash(`${tag}.zk.money`)
  const confirmStep = () => byTestId("confirm-tag")
  /** A promise and the functions that settle it. */
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it("a nameless key with a claim confirms its tag; the card then resumes that signup", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    expect(h.reservedNameHashes.mock.calls[0]![0].address).toBe(nameless().bootstrap.address)
    expect(confirmStep()?.dataset.title).toBe("Continue signing up")
    expect(leftForSignInStart()).toBe(false)

    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    // The tag matched: the card says the signup never finished, and its way on picks it back up.
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(refused()?.textContent).toContain("@cris")
    expect(h.navigate).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
  })

  it("the reserved card's Back returns to the screen and forgets the reservation", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(byTestId("enter-retry")).toBeNull()

    await click("enter-back")
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()

    // A registered passkey's confirm step is its claim's, not the forgotten reservation's.
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await click("sign-in-show-passkeys")
    expect(confirmStep()?.dataset.title).toBe("Login")
    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    h.typedTag = "alice"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).toHaveBeenCalledTimes(1)
  })

  it("a tag the link already carries that names the claim skips the step, not the card", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render("/enter?handle=cris")
    expect(confirmStep()).toBeNull()
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(h.navigate).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("a link's tag that names no claim is only the step's seed", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render("/enter?handle=alice")
    expect(confirmStep()?.dataset.handle).toBe("alice")
    expect(leftForSignInStart()).toBe(false)
  })

  it("a tag that names none of the claims is refused on the step; decorated forms still match", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()

    h.typedTag = "bob"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(byTestId("confirm-tag-error")?.textContent).toContain("@bob")
    expect(h.navigate).not.toHaveBeenCalled()

    h.typedTag = "cris.zk.money"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("account-service test mode checks the reservation but never confirms, keeping today's outcome", async () => {
    h.getConfig.mockReturnValue({
      rpId: "localhost",
      campaignUrl: "",
      accountServiceTestMode: true,
    })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValue(new Error("unreachable"))
    await render()
    // Test mode files every claim under one shared keyId, so it names no one and never confirms a
    // typed tag; a lookup it cannot answer yields to today's outcome rather than a network card.
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
  })

  it("a lookup that fails after the commit is the network refusal; retry asks again, not the passkey", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    await render("/enter?choose=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    // The account is committed: the way on is the signup it holds, never the screen.
    expect(byTestId("enter-back")).toBeNull()
    expect(byTestId("enter-continue")).not.toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "passkey_prompt_closed",
    })
    expect(leftForSignInStart()).toBe(false)

    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await act(async () => retry().click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(2)
    expect(confirmStep()).not.toBeNull()
  })

  it("the committed refusal's way on continues the signup rather than starting one", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValueOnce(new Error("offline"))
    await render()
    await act(async () => byTestId("enter-continue")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("closing the reserved step continues the signup, where the reserved tag is not refused", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    await act(async () => byTestId("confirm-tag-close")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a sign-in failure before any commit retries the sign-in, not the signup", async () => {
    await render("/enter?choose=1")
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-continue")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("Cancel sign-in during the lookup hands back, and its late answer does nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    expect(leftForSignInStart()).toBe(true)
    h.navigate.mockClear()

    await act(async () => pending.resolve([hashOf("cris")]))
    await flush()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(confirmStep()).toBeNull()
    expect(refused()).toBeNull()
  })

  it("a failed lookup answering after Cancel sign-in reports nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    await act(async () => pending.reject(new Error("offline")))
    await flush()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
  })

  it("Cancel sign-in during the retry's lookup leaves nothing behind either", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValueOnce(new Error("offline"))
    await render()
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await act(async () => retry().click())
    await flush()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    h.navigate.mockClear()
    await act(async () => pending.resolve([hashOf("cris")]))
    await flush()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(confirmStep()).toBeNull()
  })

  it("from a reservation to a registered passkey: the registered tag enters the wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    h.typedTag = "bob"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(byTestId("confirm-tag-error")).not.toBeNull()

    // Back to the screen; its Show passkeys asks the browser again, and the registered passkey answers.
    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    expect(byTestId("sign-in-start")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(confirmStep()?.dataset.title).toBe("Login")
    expect(byTestId("confirm-tag-error")).toBeNull()

    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    h.typedTag = "alice"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).toHaveBeenCalledTimes(1)
    expect(h.saveWalletIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "alice", address: L2 }),
      expect.any(Function),
    )
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(leftForSignInStart()).toBe(false)
  })

  it("from a registered passkey to a reservation: the reserved tag resumes, saving no identity", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await render()
    expect(confirmStep()?.dataset.title).toBe("Login")

    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(confirmStep()?.dataset.title).toBe("Continue signing up")

    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })
})

/** The confirmation the entry screen offers, and the way out of it: Back to the screen, then its Show passkeys. */
describe("EnterAppScreen chooser", () => {
  const dismissed = () => new DOMException("closed", "NotAllowedError")
  const lastChooser = () => {
    const calls = h.enterWithPasskey.mock.calls
    return (calls[calls.length - 1][3] as { chooser?: boolean }).chooser
  }
  /** An entry that recovers an account and asks the user to confirm its tag. */
  const confirms = () =>
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })

  it("keeps asking the browser when a refusal on that attempt is retried", async () => {
    const { PhoneRequiredError } = await policyErrors()
    confirms()
    await render()

    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")

    h.enterWithPasskey.mockRejectedValueOnce(dismissed())
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    // The retry inherits the intent: resolving the cache would land back on the confirmation.
    expect(lastChooser()).toBe(true)
  })
})

/**
 * Recovery can commit an account other than the one this tab holds, which moves the storage
 * pointer under record stores that are already loaded. The document is replaced when it does.
 */
describe("EnterAppScreen account switch", () => {
  const assign = vi.fn()
  /** A recovery that commits `id`; `stale` is what the auth service then reports. */
  const commits = (id: string, result: unknown = nameless(), stale = false) =>
    h.enterWithPasskey.mockImplementationOnce(async () => {
      await walletStorage.commitItem("webwallet.storageId", id)
      h.recordsStale = stale
      return result
    })
  /** A recovery that names its account, the one outcome that reaches the wallet. */
  const named = { entered: true, handle: "alice", address: L2, account: {}, held: () => true }

  beforeEach(async () => {
    assign.mockClear()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
  })
  afterEach(() => vi.unstubAllGlobals())

  it("continues in place when recovery finds the account the tab already held", async () => {
    commits("storage-a", named)
    await render()
    expect(assign).not.toHaveBeenCalled()
    expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
  })

  it("replaces the document before the reservation lookup when a different account is committed", async () => {
    commits("storage-b")
    await render()
    expect(assign).toHaveBeenCalledWith("/enter")
    // Nothing after the switch runs against the previous account's loaded records.
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it.each([
    ["a cancel", Object.assign(new Error("cancelled"), { name: "GateCancelledError" })],
    ["a failure", new Error("rpc down")],
  ])(
    "%s that lands after a different account was committed still replaces the document",
    async (_label, error) => {
      h.enterWithPasskey.mockImplementationOnce(async () => {
        await walletStorage.commitItem("webwallet.storageId", "storage-b")
        throw error
      })
      await render()
      // The commit stands and moved the pointer under this document's stores: it must go, and
      // nothing is shown or navigated in it first.
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(refused()).toBeNull()
      expect(leftForSignInStart()).toBe(false)
      expect(h.showReportableError).not.toHaveBeenCalled()
    },
  )

  it("carries the tag and the onward destination across, and drops the chooser flags", async () => {
    await render({
      pathname: "/enter",
      search: "?handle=alice&choose=1&avoid=cred-x",
      state: { next: "/request#gift" },
    })
    commits("storage-b")
    await click("sign-in-show-passkeys")
    expect(assign).toHaveBeenCalledWith("/enter?handle=alice&next=%2Frequest%23gift")
  })

  it.each([
    "https://evil.test/steal",
    "//evil.test/steal",
    "/\\evil.test/steal",
    "/\n/evil.test/steal",
    "/\r/evil.test/steal",
    "/\t/evil.test/steal",
    "/a/..//evil.test/steal",
    "/%2e//evil.test/steal",
  ])("refuses an onward destination that leaves this wallet (%s)", async (next) => {
    commits("storage-b")
    await render({ pathname: "/enter", state: { next } })
    expect(assign).toHaveBeenCalledWith("/enter")
  })

  it("the reloaded document still finishes at the carried destination", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    commits("storage-b", named)
    await render({ pathname: "/enter", search: "?next=%2Frequest%23gift" })
    expect(assign).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/request#gift", { replace: true })
  })

  it("a nameless account that switched accounts reloads first, then its reservation resumes on the carried tag", async () => {
    commits("storage-b")
    await render("/enter?handle=cris")
    expect(assign).toHaveBeenCalledWith("/enter?handle=cris")
    // Nothing is asked of account-service against the previous account's loaded records.
    expect(h.reservedNameHashes).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    commits("storage-b")
    h.reservedNameHashes.mockResolvedValueOnce([namehash("cris.zk.money")])
    await render("/enter?handle=cris")
    expect(assign).toHaveBeenCalledTimes(1)
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("a carried destination that leaves this wallet is not followed", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    commits("storage-b", named)
    await render({ pathname: "/enter", search: "?next=https%3A%2F%2Fevil.test%2Fsteal" })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  describe("signed out, as after a logout", () => {
    beforeEach(() => walletStorage.commitRemove("webwallet.storageId"))

    it("replaces the document before the reservation lookup when the account's records are stale", async () => {
      commits("storage-b", nameless(), true)
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(h.reservedNameHashes).not.toHaveBeenCalled()
      expect(refused()).toBeNull()
      expect(leftForSignInStart()).toBe(false)
    })

    it("replaces the document before a named account reaches the wallet", async () => {
      commits("storage-b", named, true)
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    })

    it("replaces the document before asking which tag to confirm", async () => {
      commits(
        "storage-b",
        {
          entered: false,
          reason: "confirm",
          claim: {},
          account: { getAddress: () => ({ toString: () => L2 }) },
          held: () => true,
        },
        true,
      )
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(byTestId("show-passkeys")).toBeNull()
    })

    it("still replaces the document when the result lands after the user cancelled", async () => {
      let land!: () => void
      h.enterWithPasskey.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (land = resolve))
        await walletStorage.commitItem("webwallet.storageId", "storage-b")
        h.recordsStale = true
        return named
      })
      await render()
      await act(async () => byTestId("spinner-cancel")!.click())
      await flush()
      await act(async () => land())
      await flush()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    })

    it("continues in place on a browser that never held the account", async () => {
      commits("storage-b", named)
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    })

    it("sends a nameless key to finish signing up, in place", async () => {
      commits("storage-b")
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    })

    it("treats a page with no auth service as fresh", async () => {
      h.recordsStale = undefined
      h.enterWithPasskey.mockImplementationOnce(async () => {
        await walletStorage.commitItem("webwallet.storageId", "storage-b")
        return named
      })
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
    })
  })

  it("replaces the document when an earlier commit on this page left the records stale", async () => {
    // A remount after an attempt that committed and then failed: the same account, already active.
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    commits("storage-b", named, true)
    await render()
    expect(assign).toHaveBeenCalledWith("/enter")
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
  })
})

/** A browser that can't run passkeys, most often an app's own: the card and its way out. */
describe("EnterAppScreen in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    // Chrome itself: a browser the in-app rule misses, so a request runs and can fail there.
    androidChrome:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
    // An app's web view on the System WebView, with `wv` stripped: only its Chrome major tells.
    androidChromeStale:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    iosInstagram:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
  }
  const unsupported = () =>
    new DOMException("Error connecting to Web Authentication service", "NotSupportedError")
  const closed = () => new DOMException("closed", "NotAllowedError")
  const failures = () =>
    h.fireEvent.mock.calls.filter(([event]) => event === "action_failed").map(([, props]) => props)

  const notice = () => byTestId("enter-in-app-notice")
  const MAP_KEY = "obsidion.obsidion_web_passkey_identity_map"
  /** This browser's root passkey record for an account, with the tag it claimed if any. */
  const remember = (credentialId: string, usertag?: string) => {
    const raw = walletStorage.getItem(MAP_KEY)
    const map = raw ? JSON.parse(raw) : { version: 1, entries: {} }
    map.entries[credentialId] = {
      credentialId,
      rpId: "localhost",
      l2Address: L2,
      pubkey: `0x${"AB".repeat(64)}`,
      isMskRoot: true,
      createdAt: 1,
      ...(usertag ? { usertag } : {}),
    }
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
  }

  let ua: { mockRestore: () => void } | undefined
  /** The page at `path`, in a browser with this user agent, once the arrival probe has settled. */
  const open = async (userAgent: string, path = "/enter?handle=alice") => {
    ua?.mockRestore()
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    vi.stubGlobal("location", addressed(path))
    needsCeremony()
    await render(path)
    h.fireEvent.mockClear()
  }
  /**
   * The sign-in screen at `path`. In an app's browser with no passkey record here the card is the
   * end, so those cases record one.
   */
  const arrive = async (userAgent: string, path = "/enter?handle=alice") => {
    await open(userAgent, path)
    expect(screen()).not.toBeNull()
    h.fireEvent.mockClear()
  }
  /** The same, with @alice's passkey read off L1 so Login is the pinned sign-in. */
  const arriveFound = async (userAgent: string) => {
    h.lookup.mockResolvedValue(FOUND_ALICE)
    await arrive(userAgent)
    expect(byTestId("sign-in-login")!.hasAttribute("disabled")).toBe(false)
  }

  afterEach(() => {
    ua?.mockRestore()
    ua = undefined
  })

  it("with no passkey record here, an iPhone app's browser gets the card instead of the screen", async () => {
    await open(UA.iosInstagram)
    expect(container.textContent).toContain("Passkeys don't work in this app's browser")
    expect(screen()).toBeNull()
    expect(byTestId("sign-in-show-passkeys")).toBeNull()
    // The way out keeps the arrival tag; only the cache-only probe asked anything.
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      "x-safari-https://wallet.test/enter?handle=alice",
    )
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("passkey-report")).not.toBeNull()
  })

  it("Cancel sign-in on the card leaves as it does from the screen", async () => {
    await open(UA.iosInstagram)
    await click("enter-cancel")
    expect(leftForSignInStart()).toBe(true)
  })

  const PLAY = "https://play.google.com/store/apps/details?id=com.android.chrome"

  it("a stale Chrome with no brands shows the in-app card plus the update line", async () => {
    await open(UA.androidChromeStale)
    expect(container.textContent).toContain("Passkeys don't work in this app's browser")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toContain("intent://")
    expect(byTestId("update-chrome-maybe")!.getAttribute("href")).toBe(PLAY)
  })

  it.each([
    ["a remembered account", () => remember("cred-bob", "bob")],
    ["a nameless account", () => remember("cred-nameless")],
    ["the credential the session was entered with", () => setActiveCredentialId("cred-held")],
  ])("%s means a passkey worked here: the screen, with no card", async (_name, seed) => {
    seed()
    await open(UA.iosInstagram)
    expect(notice()).toBeNull()
    expect(screen()).not.toBeNull()
  })

  it("a remembered account the screen hides still counts", async () => {
    remember("cred-avoid", "bob")
    await open(UA.iosInstagram, "/enter?choose=1&avoid=cred-avoid")
    expect(notice()).toBeNull()
    expect(screen()).not.toBeNull()
  })

  it("?choose=1 skips the arrival probe and meets the same gate", async () => {
    await open(UA.iosInstagram, "/enter?choose=1")
    expect(notice()).not.toBeNull()
    expect(h.enterWithPasskey).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(container)
    setActiveCredentialId("cred-held")
    await open(UA.iosInstagram, "/enter?choose=1")
    expect(notice()).toBeNull()
    expect(screen()).not.toBeNull()
  })

  it("Show passkeys refused as not supported shows the card with Chrome, a retry and the exits", async () => {
    await arrive(UA.androidChrome)
    const error = unsupported()
    h.enterWithPasskey.mockRejectedValueOnce(error)
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(container.textContent).toContain("open it in your phone's browser")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      "intent://wallet.test/enter?handle=alice#Intent;scheme=https;package=com.android.chrome;end",
    )
    expect(retry().className).toContain("ww-invite-pill")
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([
      { action: "enter", code: error instanceof Error ? error.name : "err" },
    ])

    h.enterWithPasskey.mockRejectedValueOnce(unsupported())
    await click("enter-retry")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(3)
  })

  it("with a root record here, Show passkeys in an iPhone app browser, which closes at once, shows the card without a retry", async () => {
    remember("cred-bob", "bob")
    await arrive(UA.iosInstagram)
    h.enterWithPasskey.mockRejectedValueOnce(closed())
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("InAppBrowser")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      "x-safari-https://wallet.test/enter?handle=alice",
    )
    expect(container.querySelector('[data-testid="enter-retry"]')).toBeNull()
    expect(byTestId("passkey-causes")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(failures()).toEqual([{ action: "enter", code: "passkey_prompt_closed" }])
  })

  it("the pinned sign-in shows the same cards, with its own events", async () => {
    await arriveFound(UA.androidChrome)
    const error = unsupported()
    h.enterWithPasskey.mockRejectedValueOnce(error)
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([
      { action: "enter:by-tag", code: error instanceof Error ? error.name : "err" },
    ])

    await act(async () => root.unmount())
    root = createRoot(container)
    remember("cred-bob", "bob")
    await arriveFound(UA.iosX)
    h.enterWithPasskey.mockRejectedValueOnce(closed())
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("InAppBrowser")
    expect(failures()).toEqual([{ action: "enter:by-tag", code: "passkey_not_on_device" }])
  })

  it("a payment link waiting in this browser asks for the link again instead of a button", async () => {
    h.claimStash = "paylink-frag"
    await arrive(UA.androidChrome)
    h.enterWithPasskey.mockRejectedValueOnce(unsupported())
    await click("sign-in-show-passkeys")
    expect(byTestId("open-in-browser")?.dataset.escape).toBe("reopen")
    expect(byTestId("open-in-browser-link")).toBeNull()
  })

  it("an abort in an iPhone app browser is still the closed prompt", async () => {
    remember("cred-bob", "bob")
    await arrive(UA.iosX)
    h.enterWithPasskey.mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("PasskeyNotOfferedError")
  })

  it("a not-supported failure after the passkey committed keeps the re-probe card", async () => {
    await arrive(UA.androidChrome)
    h.enterWithPasskey.mockRejectedValueOnce(Object.assign(unsupported(), { committed: true }))
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("open-in-browser")).toBeNull()
    expect(h.showReportableError).toHaveBeenCalledTimes(1)
  })

  it("any other failure still shows the network card and the report", async () => {
    await arrive(UA.androidChrome)
    h.enterWithPasskey.mockRejectedValueOnce(new Error("boom"))
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(h.showReportableError).toHaveBeenCalledTimes(1)
  })
})

/** One `passkey_ceremony` per sign-in, classified from what `enterWithPasskey` returned or threw. */
describe("EnterAppScreen passkey telemetry", () => {
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  const OTHER_L2 = `0x${"bd".repeat(32)}`
  const ENTERED = {
    entered: true,
    handle: "alice",
    address: L2,
    account: {},
    held: (): boolean => true,
  }
  const events = () => passkeyEvents(h.fireEvent)

  beforeEach(async () => {
    harness = await passkeyTelemetryHarness()
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
  })

  /** A sign-in that asks through its own scope once past the gate and waits for the test. */
  const heldEntry = (result: unknown = { entered: false, reason: "unknown" }) => {
    const entry: { request?: HeldRequest } = {}
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        const { signal } = await options.gate()
        entry.request = harness.request("assert", signal, options.own)
        await entry.request.settled
        return result
      },
    )
    return entry
  }
  /** A sign-in whose one request is answered at once, then ends in `outcome`. */
  const answeredEntry = (outcome: () => unknown) =>
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        await harness.answered("assert", options.own)
        return outcome()
      },
    )

  /** The screen, reached through an arrival probe that found no cached key. */
  const toScreen = async (path = "/enter") => {
    needsCeremony()
    await render(path)
    expect(screen()).not.toBeNull()
    h.fireEvent.mockClear()
  }

  /** The screen with @alice's passkey read off L1, so Login is the pinned sign-in. */
  const toFoundPasskey = async () => {
    h.lookup.mockResolvedValue(FOUND_ALICE)
    await toScreen("/enter?handle=alice")
    expect(byTestId("sign-in-login")!.hasAttribute("disabled")).toBe(false)
  }

  it("an arrival probe that restores a cached key reports nothing: it asked for nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(ENTERED)
    await render()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(events()).toEqual([])
  })

  it("an arrival probe that needs a prompt reports nothing and shows the screen", async () => {
    await toScreen()
    expect(events()).toEqual([])
  })

  it("an arrival probe refused by this browser's record reports the refusal with no prompt", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.enterWithPasskey.mockRejectedValueOnce(new StoredAddressMismatchError())
    await render()
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "refused",
        reason: "passkey_mismatch",
        prompts: "0",
      }),
    ])
  })

  it.each([
    ["an entered account", ENTERED, { outcome: "succeeded" }],
    [
      "a tag to confirm",
      { entered: false, reason: "confirm", claim: {}, account: {}, held: (): boolean => true },
      { outcome: "succeeded" },
    ],
    [
      "no wallet for the passkey",
      { entered: false, reason: "unknown" },
      { outcome: "refused", reason: "no_wallet_for_passkey" },
    ],
  ])("Show passkeys ending in %s reports it", async (_name, result, expected) => {
    await toScreen()
    answeredEntry(() => result)
    await click("sign-in-show-passkeys")
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("a nameless account succeeds, and the refusal after it sends no passkey event", async () => {
    await toScreen()
    answeredEntry(() => nameless())
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    expect(events()).toEqual([expect.objectContaining({ outcome: "succeeded" })])
  })

  it.each([
    [
      "a record the registry could not confirm",
      { entered: false, reason: "unknown", addresses: [L2] },
      { outcome: "failed", reason: "registry_unconfirmed" },
    ],
    [
      "a key that is not the tag's",
      { entered: false, reason: "unknown", addresses: [OTHER_L2] },
      { outcome: "refused", reason: "passkey_mismatch" },
    ],
  ])("a pinned sign-in ending in %s reports it", async (_name, result, expected) => {
    await toFoundPasskey()
    answeredEntry(() => result)
    await click("sign-in-login")
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("a pinned sign-in the wrong passkey answered reads as a passkey mismatch", async () => {
    const { PasskeyMismatchError } = await import(
      "../../../src/features/onboarding/oxideOnboarding"
    )
    await toFoundPasskey()
    answeredEntry(() => {
      throw new PasskeyMismatchError()
    })
    await click("sign-in-login")
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch" }),
    ])
  })

  it("Cancel sign-in during the request sends one cancel, and nothing once the screen and page go", async () => {
    await toScreen()
    const entry = heldEntry()
    await click("sign-in-show-passkeys")
    expect(entry.request).toBeDefined()
    await click("spinner-cancel")
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("leaving the screen during the request sends nothing, then or when the page goes", async () => {
    await toScreen()
    const entry = heldEntry()
    await click("sign-in-show-passkeys")
    expect(entry.request).toBeDefined()
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("the refusal card's retry is a fresh attempt, counted as this page's second", async () => {
    await toFoundPasskey()
    answeredEntry(() => ({ entered: false, reason: "unknown", addresses: [L2] }))
    await click("sign-in-login")
    answeredEntry(() => ENTERED)
    await click("enter-retry")
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "registry_unconfirmed", attempt: "1" }),
      expect.objectContaining({ outcome: "succeeded", prompts: "1", attempt: "2" }),
    ])
  })

  it("a sign-in that replaces the document has reported before it does", async () => {
    const assign = vi.fn()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
    try {
      await toScreen()
      answeredEntry(async () => {
        await walletStorage.commitItem("webwallet.storageId", "storage-b")
        return ENTERED
      })
      await click("sign-in-show-passkeys")
      expect(assign).toHaveBeenCalledWith("/enter")
      const sent = h.fireEvent.mock.calls.findIndex(([name]) => name === "passkey_ceremony")
      expect(events()).toEqual([expect.objectContaining({ outcome: "succeeded" })])
      expect(h.fireEvent.mock.invocationCallOrder[sent]).toBeLessThan(
        assign.mock.invocationCallOrder[0]!,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * The sign-in screen on /enter: the arrival probe that shows it only when a ceremony is needed, the
 * tag field that resolves as it is typed, the remembered accounts one click each, Login pinned to
 * what resolved, Show passkeys for the browser's full chooser, every failure on its own card with
 * Back to the screen, one analytics event per outcome with the real code table, and a cancel that
 * ends the operation down to the writes that follow entry.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { testWalletDbs } from "../../support/fakeWalletDb"
import type { SignInStart } from "../../../src/features/onboarding/steps/ConfirmTagModal"

vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  enterWithPasskey: vi.fn(),
  confirmTag: vi.fn(),
  lookup: vi.fn(),
  probe: vi.fn(),
  getOxideTuple: vi.fn(async () => ({})),
  recoverFromCache: vi.fn(async () => undefined),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  getConfig: vi.fn(),
  reservedNameHashes: vi.fn(),
  nameGrantToken: vi.fn(),
  boundNameGrantOwner: vi.fn(),
  claimTag: vi.fn(),
  collectOnboardingKeys: vi.fn(async () => ({})),
  saveTerms: vi.fn(),
  bridge: null as unknown,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: { service: true } }),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: h.getConfig,
}))
vi.mock("../../../src/config/oxideTuple", () => ({ getOxideTuple: h.getOxideTuple }))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveSignInTag: vi.fn(),
  resolveSignInTagForCommit: vi.fn(),
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", async () => {
  const { matchWireNameHash } = await import("@obsidion/front-core")
  return {
    enterWithPasskey: h.enterWithPasskey,
    nameGrantToken: h.nameGrantToken,
    confirmTag: h.confirmTag,
    claimTag: h.claimTag,
    collectOnboardingKeys: h.collectOnboardingKeys,
    checkpointRegistrationTerms: (account: string, tag: string, claim: { deadline: string }) => ({
      account,
      tag,
      deadline: Number(claim.deadline),
    }),
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
      constructor() {
        super("that isn't the passkey this claim was started with")
      }
    },
    PasskeySetUnreadError: class PasskeySetUnreadError extends Error {
      name = "PasskeySetUnreadError"
      constructor() {
        super("this passkey's account holds more keys than the sign-in could read")
      }
    },
  }
})
vi.mock("../../../src/features/onboarding/recoveryProbes", () => ({
  reservedNameHashes: h.reservedNameHashes,
  boundNameGrantOwner: h.boundNameGrantOwner,
}))
vi.mock("../../../src/features/onboarding/registrationTerms", () => ({
  saveRegistrationTerms: h.saveTerms,
}))
// The lookup is the only stand-in: the diagnosis and the code table are the real ones.
vi.mock("../../../src/features/onboarding/findPasskeyByTag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/findPasskeyByTag")>()),
  lookupPasskeyByTag: h.lookup,
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: async () => "unknown",
    recoverFromCache: h.recoverFromCache,
  }),
  peekAuthService: () => undefined,
}))
vi.mock("../../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  // The session's feed reads the rest.
  ...(await importOriginal<typeof import("../../../src/features/onboarding/webRegistration")>()),
  getPendingStore: () => ({
    list: () => [],
    get: () => null,
    load: async () => {},
    onListChanged: () => () => {},
  }),
}))
vi.mock("../../../src/features/paylink/claimStash", () => ({ peekClaimStash: () => undefined }))
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({ decodeLink: vi.fn() }))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
// `failureCode` stays real, so the codes asserted below are the ones that reach the wire.
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))
vi.mock("../../../src/features/onboarding/nameAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/nameAvailability")>()),
  probeNameAvailability: h.probe,
}))
vi.mock("../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../src/platform/desktopBridge", () => ({ getDesktopL1Bridge: () => h.bridge }))
vi.mock("../../../src/ui/EndpointsModal", () => ({
  EndpointsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="endpoints-modal">
      <button data-testid="endpoints-close" onClick={onClose} />
    </div>
  ),
}))
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
    <div data-testid="spinner">
      {label}
      <button data-testid="spinner-cancel" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  ),
}))
// The card's two roles, with the start role's wiring exposed; the real card has its own suite.
vi.mock("../../../src/features/onboarding/steps/ConfirmTagModal", () => ({
  ConfirmTagModal: ({
    initialHandle,
    start,
    onConfirm,
    onShowPasskeys,
    onBack,
    onClose,
  }: {
    initialHandle?: string
    start?: SignInStart
    onConfirm: (handle: string) => void
    onShowPasskeys?: () => void
    onBack?: () => void
    onClose: () => void
  }) => {
    if (!start) {
      return (
        <div data-testid="confirm-tag" data-handle={initialHandle}>
          <button data-testid="confirm-tag-submit" onClick={() => onConfirm(initialHandle ?? "")} />
          <button data-testid="confirm-back" onClick={onBack} />
          <button data-testid="confirm-tag-close" onClick={onClose} />
        </div>
      )
    }
    const live = start.prepared === "ready" && !start.busy
    return (
      <form
        data-testid="sign-in-start"
        data-prepared={start.prepared}
        data-resolving={String(start.resolving)}
        data-chooser-first={String(start.chooserFirst)}
        onSubmit={(e) => {
          e.preventDefault()
          if (start.submitReady && live) onConfirm(start.value)
        }}
      >
        {start.candidates.map((candidate) => (
          <React.Fragment key={candidate.credentialId}>
            <button
              type="button"
              data-testid="sign-in-account"
              data-tag={candidate.usertag}
              data-keyed={String(start.keyed.has(candidate.credentialId))}
              disabled={!live}
              onClick={() => start.onCandidate(candidate)}
            />
            {start.rowKeys?.credentialId === candidate.credentialId && (
              <div
                data-testid="row-keys"
                data-reading={String(!!start.rowKeys.reading)}
                data-failed={String(!!start.rowKeys.failed)}
              >
                {start.rowKeys.choices.map((c) => (
                  <button
                    key={c.credentialId}
                    type="button"
                    data-testid="row-key"
                    data-label={c.label}
                    data-last-used={String(!!c.lastUsed)}
                    disabled={!live}
                    onClick={() => start.onRowKey(c.credentialId)}
                  />
                ))}
                <button type="button" data-testid="row-keys-again" onClick={start.onRowKeysAgain} />
              </div>
            )}
          </React.Fragment>
        ))}
        <input
          aria-label="Your tag"
          value={start.value}
          onChange={(e) => start.onTagChange(e.target.value)}
          onBlur={start.onTagBlur}
        />
        {start.notice && <p data-testid={`by-tag-${start.notice.kind}`}>{start.notice.tag}</p>}
        {start.notice?.kind === "listed" && (
          <button
            type="button"
            data-testid="by-tag-different-passkey"
            disabled={start.busy}
            onClick={start.onDifferentPasskey}
          />
        )}
        {start.prepared === "failed" && (
          <button
            type="button"
            data-testid="sign-in-prepare-again"
            onClick={start.onPrepareAgain}
          />
        )}
        {start.submitReady &&
          start.tagKeys?.map((c) => (
            <button
              key={c.credentialId}
              type="button"
              data-testid="tag-key"
              data-label={c.label}
              data-last-used={String(!!c.lastUsed)}
              disabled={!live}
              onClick={() => start.onTagKey(c.credentialId)}
            />
          ))}
        <button
          type="button"
          data-testid="sign-in-login"
          disabled={!(start.submitReady && live)}
          onClick={() => onConfirm(start.value)}
        />
        <button
          type="button"
          data-testid="sign-in-show-passkeys"
          disabled={!live}
          onClick={onShowPasskeys}
        />
        <button type="button" data-testid="sign-in-close" onClick={onClose} />
        {start.onEndpoints && (
          <button type="button" data-testid="sign-in-endpoints" onClick={start.onEndpoints} />
        )}
      </form>
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
    isDisabled,
    isLoading,
    onClick,
  }: {
    title: string
    testId?: string
    isDisabled?: boolean
    isLoading?: boolean
    onClick?: () => void
  }) => (
    <button type="button" data-testid={testId} disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Icon: () => <i />,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

const policyErrors = () => import("@obsidion/passkey-web")

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

async function render(path = "/enter", strictMode = false) {
  const { EnterAppScreen } = await import("../../../src/features/onboarding/EnterAppScreen")
  await openPage()
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <EnterAppScreen />
    </MemoryRouter>
  )
  await act(async () => {
    root.render(strictMode ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  })
  await flush()
}

type EnterOptions = {
  gate: () => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  hints?: { account: string; l2Address?: string; keys: unknown[] } | { credentialId: string }
  strictTag?: boolean
  signal?: AbortSignal
  chooser?: boolean
  phone?: boolean
  cacheOnly?: boolean
  restoreCache?: boolean
}
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = async (id: string) => {
  await act(async () => byTestId(id)!.click())
  await flush()
}
const refused = () => byTestId("enter-refused")
const screen = () => byTestId("sign-in-start")
const login = () => byTestId("sign-in-login") as HTMLButtonElement
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')!
const type = async (value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
  await flush()
}
/** Leaving the field runs a pending read at once — the way a Login click blurs it. */
const blur = async () => {
  await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
  await flush()
}
const submitField = async () => {
  await act(async () =>
    screen()!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
  await flush()
}
const navigatedTo = (route: string) =>
  h.navigate.mock.calls.some((call) => (call as unknown[])[0] === route)
const leaveAssign = vi.fn()
const leftForClaim = () => navigatedTo("/claim")
const lastOptions = () => {
  const calls = h.enterWithPasskey.mock.calls
  return calls[calls.length - 1][3] as EnterOptions
}
/** Every action_failed emitted, as (action, code) pairs, plus the resolved lookups. */
const failures = () =>
  h.fireEvent.mock.calls
    .filter((c) => c[0] === "action_failed")
    .map((c) => [(c[1] as { action: string }).action, (c[1] as { code: string }).code])
const resolvedEvents = () =>
  h.fireEvent.mock.calls.filter((c) => c[0] === "passkey_by_tag_lookup_resolved")

const L2 = `0x${"ac".repeat(32)}`
const OTHER = `0x${"bd".repeat(32)}`
const ACCOUNT = `0x${"11".repeat(20)}`
const CANDIDATE = { credentialId: "cred-alice", pubkeyHex: "ab".repeat(64) }
/** @alice's one installed key, as the L1 read lists it. */
const KEYS = [
  {
    pubkeyHex: CANDIDATE.pubkeyHex,
    metadata: `0x${"07".repeat(16)}`,
    parsed: { kind: "credential-id" as const, credentialId: CANDIDATE.credentialId },
  },
]
/** What Login pins: the tag's account and its keys. */
const FOUND = { account: ACCOUNT, l2Address: L2, keys: KEYS }
/** What a remembered row pins: its credential. */
const ROW = { credentialId: CANDIDATE.credentialId }
const closed = () => new DOMException("closed", "NotAllowedError")
const named = (handle = "alice") => ({
  entered: true,
  handle,
  address: L2,
  account: {},
  held: () => true,
})
const needsCeremony = () =>
  h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "ceremony-required" })
const resolvedLookup = (tag = "alice", moreKeys = false) =>
  h.lookup.mockResolvedValueOnce({
    kind: "resolved",
    tag,
    account: ACCOUNT,
    l2Address: L2,
    keys: KEYS,
    moreKeys,
  })
const nameless = () => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => L2 }) },
  held: () => true,
  bootstrap: {
    address: "0xE0A0000000000000000000000000000000000001",
    signMessage: async () => "0xsig",
  },
  ensDomain: "zk.money",
})

const MAP_KEY = "obsidion.obsidion_web_passkey_identity_map"
/** This browser's root record for an account, with the tag it claimed. */
function remember(credentialId: string, usertag: string, createdAt = 1, l2Address = L2) {
  const raw = walletStorage.getItem(MAP_KEY)
  const map = raw ? JSON.parse(raw) : { version: 1, entries: {} }
  map.entries[credentialId] = {
    credentialId,
    rpId: "localhost",
    l2Address,
    pubkey: `0x${"AB".repeat(64)}`,
    isMskRoot: true,
    createdAt,
    usertag,
  }
  walletStorage.setItem(MAP_KEY, JSON.stringify(map))
}

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1"
const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
const onPhone = () =>
  Object.defineProperty(navigator, "userAgent", { value: IOS, configurable: true })

/** A probe that finds no cached key, so the screen shows. */
async function arrive(path = "/enter", strictMode = false) {
  needsCeremony()
  await render(path, strictMode)
  expect(screen()).not.toBeNull()
}

/** The whole way to the Login tap: the screen, the arrival tag resolved. */
async function reachFound(path = "/enter?handle=alice") {
  resolvedLookup()
  await arrive(path)
  expect(login().disabled).toBe(false)
}

beforeEach(() => {
  vi.resetModules()
  leaveAssign.mockClear()
  vi.stubGlobal("location", { assign: leaveAssign, origin: "https://wallet.test" })
  h.navigate.mockClear()
  h.enterWithPasskey.mockReset()
  h.confirmTag.mockReset()
  h.lookup.mockReset().mockResolvedValue({ kind: "notFound" })
  h.probe.mockReset().mockResolvedValue({ status: "unknown", grantValid: false, grantBound: false })
  h.getOxideTuple.mockReset().mockResolvedValue({})
  h.recoverFromCache.mockReset().mockResolvedValue(undefined)
  h.showReportableError.mockClear()
  h.fireEvent.mockClear()
  h.reservedNameHashes.mockReset().mockResolvedValue([])
  h.nameGrantToken.mockReset().mockReturnValue(undefined)
  h.boundNameGrantOwner.mockReset().mockResolvedValue(false)
  h.claimTag.mockReset().mockResolvedValue({
    kind: "pending",
    oxideAccount: "0xacc0000000000000000000000000000000000001",
    claim: { deadline: "4102444800" },
    startBroadcast: vi.fn(async () => true),
  })
  h.saveTerms.mockClear()
  h.bridge = null
  h.getConfig.mockReturnValue({
    rpId: "localhost",
    campaignUrl: "https://launch.test.invalid",
    accountServiceTestMode: false,
  })
  localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Object.defineProperty(navigator, "userAgent", userAgent)
  vi.unstubAllGlobals()
})

describe("the arrival", () => {
  it("probes the ceremony-free sources first; with none the screen shows, prepared, with no prompt", async () => {
    await arrive()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(lastOptions().restoreCache).toBeUndefined()
    // The probe fetched the manifest and made the one cache proof: nothing more to prepare.
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.getOxideTuple).not.toHaveBeenCalled()
    expect(login().disabled).toBe(true)
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", false)
    expect(refused()).toBeNull()
  })

  it.each([["phone", onPhone]])(
    "a cached key enters with no screen and no prompt on a %s",
    async (_p, posture) => {
      posture()
      h.enterWithPasskey.mockResolvedValueOnce(named())
      await render()
      expect(screen()).toBeNull()
      expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    },
  )

  it("the arrival handle seeds the field and resolves it once; Login is then one click", async () => {
    resolvedLookup()
    await arrive("/enter?handle=Alice")
    expect(input().value).toBe("alice")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(h.lookup).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ resolveTag: expect.any(Function) }),
    )
    expect(login().disabled).toBe(false)
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-login")
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({
        hints: FOUND,
        restoreCache: false,
        signal: expect.any(AbortSignal),
      }),
    )
    expect(resolvedEvents()).toEqual([["passkey_by_tag_lookup_resolved", { more_keys: false }]])
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("hot cache with the post-switch reload's handle enters silently; the tag is never read", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await render("/enter?handle=bob&strict=1")
    expect(lastOptions().strictTag).toBe(true)
    expect(h.lookup).not.toHaveBeenCalled()
    expect(screen()).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a read that failed before anything was asked or written shows the screen, which prepares itself", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    expect(screen()).not.toBeNull()
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.getOxideTuple).toHaveBeenCalledTimes(1)
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([["enter", "unknown"]])
    expect(navigatedTo("/claim")).toBe(false)
  })

  it("a write that failed after the probe committed shows its own card: Retry re-probes, Cancel, no signup", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { committed: true }),
    )
    await render()
    expect(screen()).toBeNull()
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("enter-back")).toBeNull()
    expect(byTestId("enter-continue")).toBeNull()
    expect(h.showReportableError).toHaveBeenCalledTimes(1)
    needsCeremony()
    await click("enter-retry")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(screen()).not.toBeNull()
  })

  it("?choose=1 skips the probe, prepares the screen and leads with Show passkeys", async () => {
    let warm!: (value: object) => void
    h.getOxideTuple.mockReturnValueOnce(new Promise<object>((r) => (warm = r)))
    await render("/enter?choose=1")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
    expect(screen()!.dataset.prepared).toBe("pending")
    expect(screen()!.dataset.chooserFirst).toBe("true")
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", true)
    await act(async () => warm({}))
    await flush()
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    // Preparation completing opened nothing.
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("the actions wait for a held cache proof too, and a failed preparation offers only a re-prepare", async () => {
    let proved!: (value: undefined) => void
    h.recoverFromCache.mockReturnValueOnce(new Promise<undefined>((r) => (proved = r)))
    remember("cred-alice", "alice")
    await render("/enter?choose=1")
    expect(screen()!.dataset.prepared).toBe("pending")
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", true)
    await act(async () => proved(undefined))
    await flush()
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", false)

    act(() => root.unmount())
    root = createRoot(container)
    h.getOxideTuple.mockRejectedValueOnce(new Error("offline"))
    await render("/enter?choose=1")
    expect(screen()!.dataset.prepared).toBe("failed")
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", true)
    await click("sign-in-prepare-again")
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("a cancelled probe whose read ends needing a ceremony shows no screen and reads nothing", async () => {
    let release!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await render("/enter?handle=alice")
    await click("spinner-cancel")
    await act(async () => release({ entered: false, reason: "ceremony-required" }))
    await flush()
    expect(screen()).toBeNull()
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it("under StrictMode the chooser arrival seeds the handle on the replay, and it resolves", async () => {
    resolvedLookup()
    resolvedLookup()
    await render("/enter?choose=1&handle=alice", true)
    expect(input().value).toBe("alice")
    expect(h.lookup).toHaveBeenCalledTimes(2)
    expect(login().disabled).toBe(false)
  })

  it("under StrictMode only the replayed probe shows the screen", async () => {
    const { GateCancelledError } = await import("../../../src/features/identity/ceremonyGate")
    h.enterWithPasskey.mockImplementation(async (_w, _c, _h, options: EnterOptions) => {
      await new Promise((r) => setTimeout(r, 0))
      if (options.signal?.aborted) throw new GateCancelledError()
      return { entered: false, reason: "ceremony-required" }
    })
    await render("/enter", true)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    const [first, second] = h.enterWithPasskey.mock.calls.map((c) => (c[3] as EnterOptions).signal!)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(container.querySelectorAll('[data-testid="sign-in-start"]')).toHaveLength(1)
  })
})

describe("the field", () => {
  it("a pause in typing reads the tag; Login enables only while the field still holds the resolved tag", async () => {
    await arrive()
    resolvedLookup("bob")
    await type("@Bob")
    expect(h.lookup).not.toHaveBeenCalled()
    await blur()
    expect(h.lookup).toHaveBeenCalledWith("bob", expect.anything())
    expect(login().disabled).toBe(false)
    await type("bobb")
    // The edit disables Login at once, before any read.
    expect(login().disabled).toBe(true)
    expect(h.lookup).toHaveBeenCalledTimes(1)
    resolvedLookup("bobb")
    await blur()
    expect(h.lookup).toHaveBeenLastCalledWith("bobb", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("Enter submits only once the tag resolved, and then pins exactly once", async () => {
    await arrive()
    await type("bob")
    await submitField()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    resolvedLookup("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await submitField()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("bob")
  })

  it("a tag the list shows is not read: the notice names the row, Login stays off, an edit reads again", async () => {
    remember("cred-alice", "alice")
    await arrive()
    await type("@Alice")
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(byTestId("by-tag-listed")?.textContent).toBe("alice")
    expect(login().disabled).toBe(true)
    expect(failures()).toEqual([])
    // Leaving the field again asks nothing; the row is live.
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", false)

    resolvedLookup("alicia")
    await type("alicia")
    await blur()
    expect(byTestId("by-tag-listed")).toBeNull()
    expect(h.lookup).toHaveBeenCalledWith("alicia", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("an invalid tag runs no read", async () => {
    await arrive()
    await type("a b")
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(login().disabled).toBe(true)
  })

  it("an account with more keys than the read covers is inconclusive: Login stays off, with its own code", async () => {
    await arrive()
    h.lookup.mockResolvedValueOnce({ kind: "inconclusive", tag: "alice", account: ACCOUNT })
    await type("alice")
    await blur()
    expect(byTestId("by-tag-inconclusive")?.textContent).toBe("alice")
    expect(login().disabled).toBe(true)
    expect(refused()).toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_inconclusive"])
  })

  it("a listed tag's way in with a different passkey reads the tag; Login then pins the account's keys", async () => {
    remember("cred-alice", "alice")
    await arrive()
    await type("alice")
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    resolvedLookup("alice")
    await click("by-tag-different-passkey")
    expect(h.lookup).toHaveBeenCalledWith("alice", expect.anything())
    expect(byTestId("by-tag-listed")).toBeNull()
    expect(login().disabled).toBe(false)
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-login")
    expect(lastOptions().hints).toEqual(FOUND)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it.each([["notFound", "bytag_tag_not_found"]] as const)(
    "%s stays inline with the field editable and Show passkeys live",
    async (kind, code) => {
      await arrive()
      h.lookup.mockResolvedValueOnce({ kind, account: `0x${"11".repeat(20)}`, complete: true })
      await type("alice")
      await blur()
      expect(byTestId(`by-tag-${kind}`)?.textContent).toBe("alice")
      expect(login().disabled).toBe(true)
      expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", false)
      expect(refused()).toBeNull()
      expect(failures().at(-1)).toEqual(["enter:by-tag", code])
      // Editing clears the notice; the next read is the new tag's.
      await type("bob")
      expect(byTestId(`by-tag-${kind}`)).toBeNull()
    },
  )

  it("a pause in typing reads the tag without leaving the field", async () => {
    const { RESOLVE_DEBOUNCE_MS } = await import("../../../src/features/onboarding/EnterAppScreen")
    await arrive()
    resolvedLookup("bob")
    await type("bob")
    expect(h.lookup).not.toHaveBeenCalled()
    await act(async () => new Promise((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 20)))
    await flush()
    expect(h.lookup).toHaveBeenCalledWith("bob", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("a read that could not reach the network says so inline and reports nothing; leaving the field asks again", async () => {
    await arrive()
    h.lookup.mockRejectedValueOnce(new Error("rpc down"))
    await type("alice")
    await blur()
    expect(byTestId("by-tag-lookupFailed")).not.toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_lookup_failed"])
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    resolvedLookup("alice")
    await blur()
    expect(h.lookup).toHaveBeenCalledTimes(2)
    expect(byTestId("by-tag-lookupFailed")).toBeNull()
    expect(login().disabled).toBe(false)
  })

  it.each([
    ["reserved", "reserved", "true"],
    ["blocked-reserved", "reserved", "true"],
  ])(
    "a tag the network has no account for, with the name %s, reads as %s",
    async (status, kind, chooserFirst) => {
      h.probe.mockResolvedValue({ status, grantValid: false, grantBound: false })
      await arrive()
      await type("alice")
      await blur()
      expect(byTestId(`by-tag-${kind}`)?.textContent).toBe("alice")
      expect(screen()!.dataset.chooserFirst).toBe(chooserFirst)
      expect(screen()!.dataset.resolving).toBe("false")
    },
  )

  it("only the current read lands: an older answer neither repopulates the field nor overwrites a newer notice", async () => {
    await arrive()
    let releaseA!: (value: unknown) => void
    h.lookup.mockReturnValueOnce(new Promise((r) => (releaseA = r)))
    await type("alice")
    await blur()
    expect(screen()!.dataset.resolving).toBe("true")
    h.lookup.mockResolvedValueOnce({ kind: "notFound" })
    await type("alicex")
    await blur()
    expect(byTestId("by-tag-notFound")?.textContent).toBe("alicex")
    await act(async () =>
      releaseA({ kind: "resolved", tag: "alice", account: ACCOUNT, l2Address: L2, keys: KEYS }),
    )
    await flush()
    expect(login().disabled).toBe(true)
    expect(byTestId("by-tag-notFound")).not.toBeNull()
  })

  it("a blur after a resolved tag reads nothing again, so the click that blurred the field lands", async () => {
    await reachFound()
    await blur()
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(login().disabled).toBe(false)
  })
})

describe("the remembered accounts", () => {
  it("a row's miss on both slots is the plain mismatch, never the wrong-key card: no read proved the key sole", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: "cred-alice",
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: "cred-alice", attachment: "platform" },
    })
    await click("sign-in-account")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("Back forgets the row's tag: Show passkeys then runs the open chooser unnamed", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockRejectedValueOnce(closed())
    await click("sign-in-account")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("alice")
    await click("enter-back")
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a row signs in on one click, pinned to its record, with no read", async () => {
    remember("cred-alice", "alice")
    await arrive()
    expect(byTestId("sign-in-account")?.dataset.tag).toBe("alice")
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-account")
    expect(h.lookup).not.toHaveBeenCalled()
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({ hints: ROW, restoreCache: false }),
    )
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("every remembered account is listed, newest first; ?avoid hides one", async () => {
    remember("cred-a", "alice", 1, `0x${"a1".repeat(32)}`)
    remember("cred-b", "bob", 2, `0x${"b2".repeat(32)}`)
    remember("cred-c", "carol", 3, `0x${"c3".repeat(32)}`)
    await render("/enter?choose=1&avoid=cred-b")
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="sign-in-account"]'),
        (row) => (row as HTMLElement).dataset.tag,
      ),
    ).toEqual(["carol", "alice"])
  })

  it("a read that lands after a row click changes nothing, and the pinned entry settles", async () => {
    remember("cred-alice", "alice")
    await arrive()
    let release!: (value: unknown) => void
    h.lookup.mockReturnValueOnce(new Promise((r) => (release = r)))
    await type("zed")
    await blur()
    let finish!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (finish = r)))
    await click("sign-in-account")
    const signal = lastOptions().signal!
    await act(async () =>
      release({ kind: "resolved", tag: "zed", account: ACCOUNT, l2Address: L2, keys: KEYS }),
    )
    await flush()
    expect(signal.aborted).toBe(false)
    await act(async () => finish(named()))
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("the key choice", () => {
  const SPARE = { credentialId: "cred-spare", pubkeyHex: "cd".repeat(64) }
  /** @alice's sign-up key and the backup oxide's prefix names. */
  const TWO_KEYS = [
    ...KEYS,
    {
      pubkeyHex: SPARE.pubkeyHex,
      metadata: `0x01${"09".repeat(100)}`,
      parsed: {
        kind: "envelope-prefixed" as const,
        credentialIdHash: `0x${"09".repeat(32)}`,
        envelope: new Uint8Array(62),
        credentialId: SPARE.credentialId,
      },
    },
  ]
  const TWO_FOUND = { account: ACCOUNT, l2Address: L2, keys: TWO_KEYS }
  const twoKeyLookup = () =>
    h.lookup.mockResolvedValueOnce({
      kind: "resolved",
      tag: "alice",
      account: ACCOUNT,
      l2Address: L2,
      keys: TWO_KEYS,
      moreKeys: true,
    })
  const labels = (id: string) =>
    Array.from(
      container.querySelectorAll(`[data-testid="${id}"]`),
      (b) => (b as HTMLElement).dataset.label,
    )
  const keyButton = (id: string, label: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${id}"][data-label="${label}"]`)!
  const choose = async (id: string, label: string) => {
    await act(async () => keyButton(id, label).click())
    await flush()
  }
  /** @alice's root record with both keys in its set, and, when `spare`, the backup's record too. */
  function rememberWallet(spare: boolean) {
    remember("cred-alice", "alice")
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    map.entries["cred-alice"].passkeySet = [KEYS[0]!.pubkeyHex, SPARE.pubkeyHex]
    if (spare) {
      map.entries[SPARE.credentialId] = {
        credentialId: SPARE.credentialId,
        rpId: "localhost",
        l2Address: L2,
        pubkey: SPARE.pubkeyHex,
        isMskRoot: false,
        backup: { account: ACCOUNT, envelope: `0x${"00".repeat(62)}` },
        passkeySet: [KEYS[0]!.pubkeyHex, SPARE.pubkeyHex],
        createdAt: 2,
      }
    }
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
  }

  it("a tag whose account lists a backup asks which key before any prompt; the backup's names it alone", async () => {
    await arrive()
    twoKeyLookup()
    await type("alice")
    await blur()
    expect(labels("tag-key")).toEqual(["Sign-up passkey", "Backup passkey"])
    // Only the arrival probe has run: no prompt opened on the read.
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    // Enter in the field signs in with neither.
    await submitField()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await choose("tag-key", "Backup passkey")
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({ hints: { ...TWO_FOUND, chosen: SPARE.credentialId } }),
    )
    expect(resolvedEvents().at(-1)?.[1]).toEqual({ more_keys: true })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a tag with two backups numbers them, and the second's option names it alone", async () => {
    const THIRD = "cred-third"
    const THREE_KEYS = [
      ...TWO_KEYS,
      {
        pubkeyHex: "ef".repeat(64),
        metadata: `0x01${"0a".repeat(100)}`,
        parsed: {
          kind: "envelope-prefixed" as const,
          credentialIdHash: `0x${"0a".repeat(32)}`,
          envelope: new Uint8Array(62),
          credentialId: THIRD,
        },
      },
    ]
    await arrive()
    h.lookup.mockResolvedValueOnce({
      kind: "resolved",
      tag: "alice",
      account: ACCOUNT,
      l2Address: L2,
      keys: THREE_KEYS,
      moreKeys: true,
    })
    await type("alice")
    await blur()
    expect(labels("tag-key")).toEqual(["Sign-up passkey", "Backup passkey 1", "Backup passkey 2"])
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await choose("tag-key", "Backup passkey 2")
    expect(lastOptions().hints).toEqual({
      account: ACCOUNT,
      l2Address: L2,
      keys: THREE_KEYS,
      chosen: THIRD,
    })
  })

  it("a one-key tag offers no choice: Login pins the account's keys as before", async () => {
    await reachFound()
    expect(byTestId("tag-key")).toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-login")
    expect(lastOptions().hints).toEqual(FOUND)
  })

  it("a remembered row whose backup this browser recorded opens its keys with no read; each pins its record", async () => {
    rememberWallet(true)
    await arrive()
    expect(byTestId("sign-in-account")?.dataset.keyed).toBe("true")
    await click("sign-in-account")
    expect(labels("row-key")).toEqual(["Sign-up passkey", "Backup passkey"])
    expect(h.lookup).not.toHaveBeenCalled()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    // A second tap closes the list.
    await click("sign-in-account")
    expect(byTestId("row-keys")).toBeNull()
    await click("sign-in-account")
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await choose("row-key", "Backup passkey")
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({
        hints: { credentialId: SPARE.credentialId, chosen: true },
        restoreCache: false,
      }),
    )
  })

  it("a row whose backup this browser has no record of reads the tag, then names the chain's key", async () => {
    rememberWallet(false)
    await arrive()
    h.lookup.mockResolvedValueOnce({ kind: "notFound" })
    await click("sign-in-account")
    expect(h.lookup).toHaveBeenCalledWith("alice", expect.anything())
    expect(byTestId("row-keys")?.dataset.failed).toBe("true")
    twoKeyLookup()
    await click("row-keys-again")
    expect(labels("row-key")).toEqual(["Sign-up passkey", "Backup passkey"])
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await choose("row-key", "Backup passkey")
    expect(lastOptions().hints).toEqual({ ...TWO_FOUND, chosen: SPARE.credentialId })
  })

  it("a wallet this browser remembers under both keys is one row, offering both", async () => {
    rememberWallet(true)
    // A sign-in with the backup saved the tag on its record too.
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    map.entries[SPARE.credentialId].usertag = "alice"
    map.entries[SPARE.credentialId].createdAt = 5
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
    await arrive()
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="sign-in-account"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dataset.keyed).toBe("true")
    await click("sign-in-account")
    expect(labels("row-key")).toEqual(["Sign-up passkey", "Backup passkey"])
  })

  it("?avoid hides the failed key's record, and the wallet's other record still lists it", async () => {
    rememberWallet(true)
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    map.entries[SPARE.credentialId].usertag = "alice"
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
    await render("/enter?choose=1&avoid=cred-alice")
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="sign-in-account"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dataset.tag).toBe("alice")
  })

  it("a remembered wallet's row is the record naming the most keys", async () => {
    rememberWallet(true)
    // The sign-up key's record predates the backup: its set is the key alone.
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    delete map.entries["cred-alice"].passkeySet
    map.entries[SPARE.credentialId].usertag = "alice"
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
    await arrive()
    const rows = container.querySelectorAll<HTMLElement>('[data-testid="sign-in-account"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dataset.keyed).toBe("true")
  })

  it("points at the key this browser last opened the wallet with, under the row and for a typed tag", async () => {
    rememberWallet(true)
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    map.entries["cred-alice"].usedAt = 100
    map.entries[SPARE.credentialId].usedAt = 200
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
    const lastUsed = (id: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`), (b) => [
        b.dataset.label,
        b.dataset.lastUsed,
      ])
    await arrive()
    await click("sign-in-account")
    expect(lastUsed("row-key")).toEqual([
      ["Sign-up passkey", "false"],
      ["Backup passkey", "true"],
    ])
    // The same account typed by tag, as its L1 read lists it.
    twoKeyLookup()
    await type("alice")
    await blur()
    await click("by-tag-different-passkey")
    expect(lastUsed("tag-key")).toEqual([
      ["Sign-up passkey", "false"],
      ["Backup passkey", "true"],
    ])
  })

  it("shows one account's keys at a time: selecting a row clears the tag, typing a tag leaves the row", async () => {
    rememberWallet(true)
    await arrive()
    await type("bob")
    await click("sign-in-account")
    expect(input().value).toBe("")
    expect(labels("row-key")).toEqual(["Sign-up passkey", "Backup passkey"])
    await type("carol")
    expect(byTestId("row-keys")).toBeNull()
    expect(input().value).toBe("carol")
  })

  it("?pick opens the named row's keys with no arrival probe", async () => {
    rememberWallet(true)
    await render("/enter?pick=cred-alice")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
    expect(labels("row-key")).toEqual(["Sign-up passkey", "Backup passkey"])
  })

  it("?pick opens the wallet's shown row when the picked record is not the one the list keeps", async () => {
    // A third key: the sign-up key's record names two, a later backup's names all three.
    remember("cred-alice", "alice")
    const map = JSON.parse(walletStorage.getItem(MAP_KEY)!)
    const third = "ef".repeat(64)
    map.entries["cred-alice"].passkeySet = [KEYS[0]!.pubkeyHex, SPARE.pubkeyHex]
    map.entries["cred-third"] = {
      credentialId: "cred-third",
      rpId: "localhost",
      l2Address: L2,
      pubkey: third,
      isMskRoot: false,
      backup: { account: ACCOUNT, envelope: `0x${"00".repeat(62)}` },
      passkeySet: [KEYS[0]!.pubkeyHex, SPARE.pubkeyHex, third],
      usertag: "alice",
      createdAt: 3,
    }
    walletStorage.setItem(MAP_KEY, JSON.stringify(map))
    h.lookup.mockReturnValueOnce(new Promise(() => {}))
    await render("/enter?pick=cred-alice")
    expect(container.querySelectorAll('[data-testid="sign-in-account"]')).toHaveLength(1)
    // The kept row is open; its unrecorded key is being read from the chain.
    expect(byTestId("row-keys")?.dataset.reading).toBe("true")
    expect(h.lookup).toHaveBeenCalledWith("alice", expect.anything())
  })

  it("a ?pick entry that switched accounts reloads without pick, so the next document enters from the cache", async () => {
    const assign = vi.fn()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
    rememberWallet(true)
    await render("/enter?pick=cred-alice")
    h.enterWithPasskey.mockImplementationOnce(async () => {
      await walletStorage.commitItem("webwallet.storageId", "storage-b")
      return named()
    })
    await choose("row-key", "Backup passkey")
    expect(assign).toHaveBeenCalledWith("/enter?handle=alice&strict=1")
  })
})

describe("the accounts from earlier rollups", () => {
  /** A root record another rollup's database remembers. */
  function rememberOn(version: string, credentialId: string, usertag: string, createdAt = 1) {
    const db = testWalletDbs().db(version)
    const raw = db.state.get(MAP_KEY)
    const map = raw ? JSON.parse(raw) : { version: 1, entries: {} }
    map.entries[credentialId] = {
      credentialId,
      rpId: "localhost",
      l2Address: L2,
      pubkey: `0x${"CD".repeat(64)}`,
      isMskRoot: true,
      createdAt,
      usertag,
    }
    db.state.set(MAP_KEY, JSON.stringify(map))
  }
  const persistent = async () => {
    await closeWalletStore()
    await openWalletStore(sandboxProfile().shared.rollupVersion, { persistent: true })
  }
  const tags = () =>
    Array.from(
      container.querySelectorAll('[data-testid="sign-in-account"]'),
      (row) => (row as HTMLElement).dataset.tag,
    )

  it("are listed after this rollup's own, which win a duplicate", async () => {
    await persistent()
    remember("cred-alice", "alice")
    rememberOn("1000000001", "cred-alice", "alice-before")
    rememberOn("1000000001", "cred-bob", "bob", 5)
    await arrive()
    expect(tags()).toEqual(["alice", "bob"])
  })

  it("pin a tapped row's passkey, as this rollup's rows do", async () => {
    await persistent()
    rememberOn("1000000001", "cred-bob", "bob")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await click("sign-in-account")
    expect(h.lookup).not.toHaveBeenCalled()
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "bob",
      expect.objectContaining({ hints: { credentialId: "cred-bob" } }),
    )
    expect(walletStorage.getItem(MAP_KEY)).toBeNull()
  })

  it("are not read from a store that is not persistent", async () => {
    rememberOn("1000000001", "cred-bob", "bob")
    const list = vi.spyOn(testWalletDbs(), "list")
    try {
      await arrive()
      expect(tags()).toEqual([])
      expect(list).not.toHaveBeenCalled()
    } finally {
      list.mockRestore()
    }
  })
})

describe("Show passkeys and the cancels", () => {

  it("a passkey whose account holds more keys than the sign-in could read is sent to the tag field, no retry", async () => {
    const { PasskeySetUnreadError } = await import(
      "../../../src/features/onboarding/oxideOnboarding"
    )
    await arrive()
    h.enterWithPasskey.mockRejectedValueOnce(new PasskeySetUnreadError())
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("PasskeySetUnreadError")
    expect(container.textContent).toContain("more passkeys than this sign-in could read")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-type-tag")).not.toBeNull()
    await click("enter-type-tag")
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
  })
})

describe("the endpoint editor", () => {
  it("opens beside the screen; closing it keeps the screen, with no sign-in and no cancel", async () => {
    await arrive()
    await click("sign-in-endpoints")
    expect(byTestId("endpoints-modal")).not.toBeNull()
    expect(screen()).not.toBeNull()
    expect(screen()!.contains(byTestId("endpoints-modal"))).toBe(false)
    await click("endpoints-close")
    expect(byTestId("endpoints-modal")).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()
    expect(leftForClaim()).toBe(false)
  })

  it("is offered under the desktop bridge too", async () => {
    h.bridge = { l1SubmitPath: "/desktop/l1-submit" }
    await arrive()
    await click("sign-in-endpoints")
    expect(byTestId("endpoints-modal")).not.toBeNull()
  })

  it("a running sign-in holds the endpoints pill; the screen and a refusal card do not", async () => {
    await reachFound()
    const { endpointsHeld } = await import("../../../src/ui/endpointsHold")
    expect(endpointsHeld()).toBe(false)
    let refuse!: (err: unknown) => void
    h.enterWithPasskey.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject)),
    )
    await click("sign-in-login")
    expect(byTestId("spinner")).not.toBeNull()
    expect(endpointsHeld()).toBe(true)
    await act(async () => refuse(closed()))
    await flush()
    expect(refused()).not.toBeNull()
    expect(endpointsHeld()).toBe(false)
  })

  it("the second prompt's approve step holds the endpoints pill too", async () => {
    await reachFound()
    const { endpointsHeld } = await import("../../../src/ui/endpointsHold")
    h.enterWithPasskey.mockImplementationOnce(async (_w, _c, _h, options: EnterOptions) => {
      const { signal } = await options.gate()
      const again = options.gate as (o: { again: AbortSignal }) => Promise<unknown>
      await again({ again: signal })
      await new Promise(() => {})
    })
    await click("sign-in-login")
    expect(byTestId("approve-again")).not.toBeNull()
    expect(endpointsHeld()).toBe(true)
  })
})

describe("the pinned sign-in", () => {
  it("a write that failed after the pinned answer committed shows the re-probe card, no Back", async () => {
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { committed: true }),
    )
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(lastOptions().cacheOnly).toBe(true)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a typed tag is the one the pinned entry names, not the URL's", async () => {
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await click("sign-in-login")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("bob")
  })

  it("a reservation the pinned entry's tag names is picked back up at once, never under the URL's", async () => {
    const { namehash } = await import("viem/ens")
    const { loadWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([
      namehash("alice.zk.money"),
      namehash("bob.zk.money"),
    ])
    await click("sign-in-login")
    // The claim server replays the claim; the record, its terms and the pending identity are
    // written here, and the wallet opens on the deposit screen.
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(h.claimTag.mock.calls[0]![0]).toBe("bob")
    expect(h.saveTerms).toHaveBeenCalledWith(expect.objectContaining({ tag: "bob" }))
    expect(loadWalletIdentity()).toMatchObject({ handle: "bob", address: L2, pending: true })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(refused()).toBeNull()
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)
  })

  it("a reservation the passkey's own name matches is picked back up with nothing typed", async () => {
    const { namehash } = await import("viem/ens")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(h.claimTag.mock.calls[0]![0]).toBe("carol")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a reservation found for a session since replaced is neither replayed nor kept", async () => {
    const { namehash } = await import("viem/ens")
    const { loadWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      ...nameless(),
      userHandle: "carol",
      held: () => false,
    })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(h.saveTerms).not.toHaveBeenCalled()
    expect(loadWalletIdentity()).toBeNull()
    expect(refused()).toBeNull()
    expect(navigatedTo("/")).toBe(false)
  })

  it("a claim replayed for a session replaced meanwhile is kept nowhere and enters nothing", async () => {
    const { namehash } = await import("viem/ens")
    const { loadWalletIdentity } = await import("../../../src/features/identity/walletIdentity")
    await arrive()
    let held = true
    h.enterWithPasskey.mockResolvedValueOnce({
      ...nameless(),
      userHandle: "carol",
      held: () => held,
    })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    const outcome = await h.claimTag.getMockImplementation()!()
    h.claimTag.mockImplementationOnce(async () => {
      held = false
      return outcome
    })
    await click("sign-in-show-passkeys")
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(h.saveTerms).not.toHaveBeenCalled()
    expect(loadWalletIdentity()).toBeNull()
    expect(refused()).toBeNull()
    expect(navigatedTo("/")).toBe(false)
  })

  it("the passkey's own name names the reservation when the arrival tag names none", async () => {
    // The arrival tag rode a sign-in link (?handle), which names a tag, not necessarily the one
    // the user reserved. It hashes to no held reservation; the passkey's own
    // name, which does, still names it, the way the registered path already falls through to it.
    const { namehash } = await import("viem/ens")
    await arrive("/enter?handle=alice")
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(h.claimTag.mock.calls[0]?.[0]).toBe("carol")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a reserved recovery that commits reloads carrying the passkey's name", async () => {
    // The unclaimed recovery adopts and switches the session, so the screen reloads to shed the
    // stale record stores; the passkey's own name must ride that reload, or the re-entry (recovered
    // from the cache, which carries no name) lands on the confirm-tag modal instead of the wallet.
    const { setActiveStorageId } = await import("../../../src/platform/storage/activeStorage")
    const { walletStorage } = await import("../../../src/platform/storage/walletStorage")
    setActiveStorageId("storage-a")
    await walletStorage.flush()
    await arrive()
    h.enterWithPasskey.mockImplementationOnce(async () => {
      setActiveStorageId("storage-b")
      await walletStorage.flush()
      return { ...nameless(), userHandle: "carol" }
    })
    await click("sign-in-show-passkeys")
    expect(leaveAssign).toHaveBeenCalled()
    expect(leaveAssign.mock.calls.at(-1)?.[0]).toContain("named=carol")
    expect(leaveAssign.mock.calls.at(-1)?.[0]).not.toContain("handle=")
  })

  it("the name this browser remembers beats the passkey's own", async () => {
    const { namehash } = await import("viem/ens")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      ...nameless(),
      usertag: "niall",
      userHandle: "eager-lips",
    })
    h.reservedNameHashes.mockResolvedValueOnce([
      namehash("eager-lips.zk.money"),
      namehash("niall.zk.money"),
    ])
    await click("sign-in-show-passkeys")
    expect(h.claimTag.mock.calls[0]?.[0]).toBe("niall")
  })

  it("after the reload, the passkey's name still names its reservation", async () => {
    const { namehash } = await import("viem/ens")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([namehash("eager-lips.zk.money")])
    await render("/enter?named=eager-lips")
    expect(h.claimTag.mock.calls[0]?.[0]).toBe("eager-lips")
  })

  it("after the reload, a passkey name that names nothing never fills the tag", async () => {
    const { namehash } = await import("viem/ens")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([namehash("dave.zk.money")])
    await render("/enter?named=eager-lips")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("")
  })

  it("a reservation whose claim cannot be replayed keeps the card whose way on is the signup", async () => {
    const { namehash } = await import("viem/ens")
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([namehash("bob.zk.money")])
    h.claimTag.mockRejectedValueOnce(new Error("claim ledger unavailable"))
    await click("sign-in-login")
    expect(byTestId("enter-refused")?.textContent).toContain("@bob")
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/bob?resume=1", { replace: true })
  })

  it("returns the bound grant's passkey to its unfinished claim", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.boundNameGrantOwner.mockResolvedValue(true)
    h.enterWithPasskey.mockResolvedValueOnce(nameless())

    await click("sign-in-login")

    expect(lastOptions()).toMatchObject({ grantToken: "bound-token" })
    expect(h.boundNameGrantOwner).toHaveBeenCalledWith(
      expect.any(String),
      "bound-token",
      expect.objectContaining({ address: nameless().bootstrap.address }),
      expect.any(Object),
    )
    expect(h.navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("keeps a different passkey out of the bound grant's signup", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())

    await click("sign-in-login")

    expect(refused()?.dataset.reason).toBe("DifferentPasskeyError")
    expect(container.textContent).toContain("cannot continue @alice's grant")
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("retries a bound grant owner-check outage without another passkey prompt", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.boundNameGrantOwner.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true)

    await click("sign-in-login")

    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-passkey")).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)

    const attempts = h.enterWithPasskey.mock.calls.length
    await click("enter-retry")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(attempts)
    expect(h.boundNameGrantOwner).toHaveBeenCalledTimes(2)
    expect(h.navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
  })

  it("a pinned entry whose reservation lookup timed out is the network card, with Back", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("error")
    expect(failures()).not.toContainEqual(["enter:by-tag", "passkey_not_on_device"])
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
  })

  it("a pinned key mismatch offers Back and the cancel, with no retry", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(container.textContent).toContain("Go back and check the tag")
    // The way to the registered passkey is named: the phone over QR, or the key.
    expect(container.textContent).toContain("scan the QR code")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("on a laptop, this computer's copy of the account's one key missing on both slots is the wrong-key card, with its own code", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: CANDIDATE.credentialId, attachment: "platform" },
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(container.textContent).toContain("scan the QR code")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_local_copy_wrong_key"])
  })

  it.each([["that closed", closed]])(
    "a pinned prompt %s names the device with no retry; Back returns to a blank screen",
    async (_name, missing) => {
      onPhone()
      await reachFound()
      h.enterWithPasskey.mockRejectedValueOnce(missing())
      await click("sign-in-login")
      expect(refused()?.dataset.reason).toBe("PasskeyNotOnDeviceError")
      expect(container.textContent).toContain("asked for @alice's passkey")
      expect(container.textContent).toContain("open zk.money in your phone's default browser")
      // The card's whole text, causes included, points at what the card offers: Back, then the screen.
      expect(container.textContent).not.toMatch(/in the prompt/i)
      expect(container.textContent).toContain("Wait, then go back and try again")
      expect(container.textContent).toContain("Go back and check the tag")
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_not_on_device"])
      expect(h.showReportableError).not.toHaveBeenCalled()

      await click("enter-back")
      expect(refused()).toBeNull()
      expect(screen()).not.toBeNull()
      expect(input().value).toBe("")
      // No reseed and no read: the arrival handle was consumed on the first showing.
      expect(h.lookup).toHaveBeenCalledTimes(1)
      expect(h.navigate).not.toHaveBeenCalled()
    },
  )

  it("an unconfirmed record keeps a retry that pins again with no second read", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, L2],
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("RegistryUnanchoredError")
    expect(container.textContent).toContain("couldn't be confirmed")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "registry_unanchored"])

    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(lastOptions().hints).toEqual(FOUND)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a stored record that no longer reproduces is the same key mismatch", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [L2],
      storedAddressMismatch: true,
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("a stored record that no longer reproduces keeps its verdict: the weaker one keeps its retry", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
      storedAddressMismatch: true,
      verdict: "not-reproduced",
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-show-passkeys")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("a certain wrong key offers Show passkeys and no retry; Show passkeys runs the chooser", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
      storedAddressMismatch: true,
      verdict: "wrong-key",
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-show-passkeys")
    expect(lastOptions()).toMatchObject({ chooser: true, restoreCache: false })
  })

  describe("on a Mac", () => {
    const MAC_CHROME =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/155.0.0.0 Safari/537.36"
    const onMac = () =>
      Object.defineProperty(navigator, "userAgent", { value: MAC_CHROME, configurable: true })
    const localCopyMiss = () => ({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: CANDIDATE.credentialId, attachment: "platform" },
    })

    it("this computer's wrong key leads with the phone, which pins the same passkey again", async () => {
      onMac()
      await reachFound()
      h.enterWithPasskey.mockResolvedValueOnce(localCopyMiss())
      await click("sign-in-login")
      expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
      expect(container.textContent).toContain("until you sign out or this browser clears its data")
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-show-passkeys")).not.toBeNull()
      h.enterWithPasskey.mockResolvedValueOnce(named())
      await click("enter-phone")
      expect(lastOptions()).toMatchObject({ hints: FOUND, phone: true })
    })

    it("a key mismatch suggests a macOS update for this computer's answer, not another device's", async () => {
      const update = () => byTestId("passkey-mac-update")
      for (const [attachment, shown] of [
        ["platform", true],
        ["cross-platform", false],
      ] as const) {
        onMac()
        resolvedLookup("alice", true)
        await arrive("/enter?handle=alice")
        h.enterWithPasskey.mockResolvedValueOnce({
          ...localCopyMiss(),
          observed: { credentialId: CANDIDATE.credentialId, attachment },
        })
        await click("sign-in-login")
        expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
        expect(update() !== null).toBe(shown)
        act(() => root.unmount())
        root = createRoot(container)
      }
    })
  })

  it("a policy refusal on the pinned path keeps its retry and Back", async () => {
    const { PhoneRequiredError } = await policyErrors()
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_wrong_device"])
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(lastOptions().hints).toEqual(FOUND)
  })

  it("a backup passkey whose envelope did not open on the pinned path keeps its retry and Back", async () => {
    const { PasskeyEnvelopeError } = await import("@obsidion/front-core")
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(new PasskeyEnvelopeError("unverified"))
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyEnvelopeError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "backup_envelope_failed"])
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(lastOptions().hints).toEqual(FOUND)
  })

  it("a passkey that answered but is not the tag's keeps its row, Back, and is counted as the wrong credential", async () => {
    await reachFound()
    const { PasskeyMismatchError } = await import(
      "../../../src/features/onboarding/oxideOnboarding"
    )
    h.enterWithPasskey.mockRejectedValueOnce(new PasskeyMismatchError())
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyMismatchError")
    expect(container.textContent).toContain("opens a different account")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_wrong_credential"])
  })

  it("a confirm result shows the confirm step defaulting to the selected tag", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await click("sign-in-login")
    expect(screen()).toBeNull()
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("alice")

    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    await click("confirm-tag-submit")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("closing the confirm modal after a pinned entry cancels through the shared cancel", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await click("sign-in-login")
    const signal = lastOptions().signal!
    await click("confirm-tag-close")
    expect(signal.aborted).toBe(true)
    expect(leftForClaim()).toBe(true)
  })

  it("Back ends the pinned attempt behind its prompt and returns to the screen", async () => {
    await reachFound()
    let attempt: AbortSignal | undefined
    h.enterWithPasskey.mockImplementationOnce(async (_w, _c, _h, options: EnterOptions) => {
      attempt = (await options.gate()).signal
      throw closed()
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyNotOnDeviceError")
    await click("enter-back")
    expect(attempt?.aborted).toBe(true)
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("Back from the confirm step returns to the screen; a row still enters from the matching cache", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await click("sign-in-account")
    expect(byTestId("confirm-tag")).not.toBeNull()
    await click("confirm-back")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    // The hinted path carries no chooser flag: a cache for this credential may answer, with no prompt.
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-account")
    expect(lastOptions().chooser).toBeUndefined()
    expect(lastOptions().hints).toEqual(ROW)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("the completion writes", () => {
  const CREDENTIAL = "cred-alice"

  async function seedSession() {
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../../../src/platform/storage/activeStorage"
    )
    setActiveStorageId("storage-a")
    setActiveCredentialId(CREDENTIAL)
    walletStorage.setItem(
      MAP_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          [CREDENTIAL]: {
            credentialId: CREDENTIAL,
            rpId: "localhost",
            l2Address: L2,
            pubkey: "ab".repeat(64),
            isMskRoot: true,
            createdAt: 1,
          },
        },
      }),
    )
  }

  it("an entry reported after a cancel writes no identity and navigates nowhere", async () => {
    await seedSession()
    const { usertagFor } = await import("../../../src/platform/auth/WebPasskeyIdentityMap")
    let release!: (value: unknown) => void
    await reachFound()
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await click("sign-in-login")
    await click("spinner-cancel")
    expect(leftForClaim()).toBe(true)
    await act(async () => release(named()))
    await flush()
    // The account it names is committed; the identity record, the passkey hint and the move into
    // the wallet were still the attempt's, and stop at its cancel.
    expect(walletStorage.getItem("webwallet.identity")).toBeNull()
    expect(usertagFor("localhost", CREDENTIAL)).toBeUndefined()
    expect(navigatedTo("/")).toBe(false)
  })

  it("an entry whose session was replaced while its account was saved installs nothing and navigates nowhere", async () => {
    await seedSession()
    const { usertagFor } = await import("../../../src/platform/auth/WebPasskeyIdentityMap")
    await reachFound()
    // The sign-in reports an account whose session a sign-out or a newer commit has since replaced.
    h.enterWithPasskey.mockResolvedValueOnce({ ...named(), held: () => false })
    await click("sign-in-login")
    await flush()
    expect(walletStorage.getItem("webwallet.identity")).toBeNull()
    expect(usertagFor("localhost", CREDENTIAL)).toBeUndefined()
    expect(navigatedTo("/")).toBe(false)
  })
})

describe("the reload guard", () => {
  const assign = vi.fn()
  const switchesTo = (id: string, result: unknown) =>
    h.enterWithPasskey.mockImplementationOnce(async () => {
      await walletStorage.commitItem("webwallet.storageId", id)
      return result
    })

  beforeEach(async () => {
    assign.mockClear()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
  })

  it("a pinned entry that switched accounts reloads with the selected tag and strict=1, keeping next", async () => {
    await arrive("/enter?handle=alice&next=%2Frequest%23gift")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    switchesTo("storage-b", named("bob"))
    await click("sign-in-login")
    expect(assign).toHaveBeenCalledWith("/enter?handle=bob&strict=1&next=%2Frequest%23gift")
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("the strict remount probes for a strict entry under a signal, and a wrong remembered tag confirms", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
      held: () => true,
    })
    await render("/enter?handle=bob&strict=1")
    expect(lastOptions().strictTag).toBe(true)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(lastOptions().signal).toBeInstanceOf(AbortSignal)
    expect(lastOptions().hints).toBeUndefined()
    expect(assign).not.toHaveBeenCalled()
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("bob")
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("a cancel during the remounted probe aborts it, and an uncommitted answer after it shows nothing", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    let release!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await render("/enter?handle=bob&strict=1")
    const signal = lastOptions().signal!
    await click("spinner-cancel")
    expect(signal.aborted).toBe(true)
    expect(leftForClaim()).toBe(true)
    await act(async () => release({ entered: false, reason: "unknown" }))
    await flush()
    expect(refused()).toBeNull()
    expect(screen()).toBeNull()
    expect(failures()).toEqual([])
  })

  it("under StrictMode only the replayed arrival enters", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    const { GateCancelledError } = await import("../../../src/features/identity/ceremonyGate")
    // Screen wiring only: the stand-in ends the first arrival the way the real gate does when the
    // replay starts its own attempt (the gate's own suite pins that).
    h.enterWithPasskey.mockImplementation(async (_w, _c, _h, options: EnterOptions) => {
      await new Promise((r) => setTimeout(r, 0))
      if (options.signal?.aborted) throw new GateCancelledError()
      return named("bob")
    })
    await render("/enter?handle=bob&strict=1", true)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    const [first, second] = h.enterWithPasskey.mock.calls.map((c) => (c[3] as EnterOptions).signal!)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(h.navigate.mock.calls.filter((c) => c[0] === "/")).toHaveLength(1)
    expect(JSON.parse(walletStorage.getItem("webwallet.identity")!)).toMatchObject({
      handle: "bob",
    })
  })
})

describe("the code table", () => {
  it("the by-tag codes are distinct; the annotation pins each to FailureCode at typecheck", async () => {
    const { BY_TAG_FAILURE_CODES } = await import(
      "../../../src/features/onboarding/findPasskeyByTag"
    )
    type FailureCode = import("../../../src/lib/analytics").FailureCode
    const codes: FailureCode[] = [...Object.values(BY_TAG_FAILURE_CODES), "passkey_prompt_closed"]
    expect(new Set(codes).size).toBe(codes.length)
  })
})

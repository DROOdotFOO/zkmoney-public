/**
 * The unlock gate: no ceremony starts before the wallet exists (it is what verifies the recovered
 * key); on every posture the locked pane is a single unlock button that opens the browser's own
 * prompt, with no probe. A refusal renders in place with its exits; a browser without a record for
 * the active passkey, or an unlock with no session, goes to /enter.
 */
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTH_TYPE } from "@obsidion/sdk"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { InMemoryStorageAdapter } from "../../support/memoryStorage"
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

/** A wallet whose derivation depends on `this` and takes the passkey set, like the real one. */
class FakeWallet {
  readonly tag = "wallet"
  async deriveAccountAddress(msk: { toString(): string }, passkeys: readonly string[]) {
    return { toString: () => `${this.tag}:${msk.toString()}:${passkeys.join(",")}` }
  }
}

type Derive = (msk: { toString(): string }, passkeys: readonly string[]) => Promise<string>

const h = vi.hoisted(() => ({
  unlock: vi.fn(
    async (_derive: Derive, _opts?: { signal?: AbortSignal; own?: PasskeyRequestScope }) => {},
  ),
  probePhoneReach: vi.fn(async () => "unknown"),
  suggestedRoute: vi.fn(async (_credentialId?: string) => "this-device"),
  clear: vi.fn(),
  retryUnlock: vi.fn(async () => {}),
  unlockError: "locked",
  wallet: undefined as unknown,
  assign: vi.fn(),
  fireEvent: vi.fn(),
}))

vi.mock("../../../src/platform/auth/useAuthenticator", () => {
  const auth = () => ({
    unlock: h.unlock,
    probePhoneReach: h.probePhoneReach,
    suggestedRoute: h.suggestedRoute,
    clear: h.clear,
    lockOut: h.clear,
  })
  return { getAuthService: auth, peekAuthService: auth }
})
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => ({ rpId: "localhost" }),
}))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: h.fireEvent, failureCode: () => "err" }))

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
  Icon: () => <i />,
  IconCircle: () => <i />,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

/**
 * The page's wallet when the test has one, and a stored account that is locked: its unlock fails
 * with `h.unlockError`, and each retry runs `h.retryUnlock` first.
 */
async function openLockedSession() {
  const { AccountStorage, resource } = await import("@obsidion/front-core")
  const { openTestSession } = await import("../../support/session")
  const accounts = AccountStorage.get(new InMemoryStorageAdapter())
  await accounts.setAccount({
    name: "Account 1",
    completeAddress: "0xacct",
    signKeyConfig: {
      type: AUTH_TYPE.WEB_AUTHN,
      webauthnData: { credentialId: "cred", pubkey: "p" },
    },
  })
  const session = openTestSession({ wallet: h.wallet })
  let builds = 0
  const account = resource("account", { from: [], backoff: "manual" }, async () => {
    if (builds++ > 0) await h.retryUnlock()
    throw new Error(h.unlockError)
  })
  Object.defineProperty(session, "account", { configurable: true, value: account })
}

async function render(entry: string | { pathname: string; state: unknown } = "/") {
  const { UnlockGate } = await import("../../../src/features/identity/UnlockGate")
  await openLockedSession()
  const gate = (
    <UnlockGate>
      <span>wallet surface</span>
    </UnlockGate>
  )
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={gate} />
          <Route path="/contacts/:tag/send" element={gate} />
          <Route path="/enter" element={<div>enter route</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

/** This browser's record for the active passkey, the way a commit leaves it. */
async function seedRecord(credentialId = "cred") {
  const { setActiveCredentialId, setActiveStorageId } = await import(
    "../../../src/platform/storage/activeStorage"
  )
  setActiveStorageId("aaa")
  setActiveCredentialId(credentialId)
  walletStorage.setItem(
    "obsidion.obsidion_web_passkey_identity_map",
    JSON.stringify({
      version: 1,
      entries: { cred: { credentialId: "cred", rpId: "localhost", l2Address: "0xabc" } },
    }),
  )
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const unlockButton = () =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Unlock with passkey"),
  )!
const tapUnlock = async () => {
  await act(async () => unlockButton().click())
  await flush()
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  h.unlock.mockReset()
  h.probePhoneReach.mockReset().mockResolvedValue("unknown")
  h.suggestedRoute.mockReset().mockResolvedValue("this-device")
  h.clear.mockClear()
  h.retryUnlock.mockClear()
  h.unlockError = "locked"
  h.assign.mockClear()
  h.fireEvent.mockClear()
  h.wallet = undefined
  Object.defineProperty(window, "location", { value: { assign: h.assign }, writable: true })
  await seedRecord()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("UnlockGate", () => {
  it("shows the splash and starts no ceremony until the wallet exists", async () => {
    await render()
    expect(container.textContent).toContain("Loading zk.money")
    expect(unlockButton()).toBeUndefined()
    expect(h.unlock).not.toHaveBeenCalled()
  })

  it("on a laptop the pane holds the ceremony until Unlock is tapped, then unlocks through a closure over the wallet", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(unlockButton()).toBeDefined()
    // The browser's own prompt decides which device answers, so nothing is probed first.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(h.unlock).not.toHaveBeenCalled()

    await tapUnlock()
    expect(h.unlock).toHaveBeenCalledTimes(1)
    const [derive, opts] = h.unlock.mock.calls[0]! as [Derive, { signal: AbortSignal }]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    // Called detached from the wallet, the way the service calls it, with the record's key.
    await expect(derive({ toString: () => "msk" }, ["ab"])).resolves.toBe("wallet:msk:ab")
    expect(h.retryUnlock).toHaveBeenCalledTimes(1)
  })

  describe("a wallet with a backup", () => {
    const ROOT = "aa".repeat(64)
    const SPARE = "bb".repeat(64)
    /** The session's root record with both keys in its set, and, when `spare`, the backup's record. */
    function seedWallet(spare: boolean, session = "cred") {
      const entries: Record<string, unknown> = {
        cred: {
          credentialId: "cred",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: ROOT,
          isMskRoot: true,
          passkeySet: [ROOT, SPARE],
        },
      }
      if (spare) {
        entries.spare = {
          credentialId: "spare",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: SPARE,
          isMskRoot: false,
          backup: { account: `0x${"11".repeat(20)}`, envelope: `0x${"00".repeat(62)}` },
          passkeySet: [ROOT, SPARE],
        }
      }
      walletStorage.setItem(
        "obsidion.obsidion_web_passkey_identity_map",
        JSON.stringify({ version: 1, entries }),
      )
      return session
    }
    const otherKey = () => byTestId("unlock-other-key") as HTMLButtonElement | null
    const card = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="unlock-keys"] button[aria-label="${label}"]`,
      )
    const backupCard = () => card("Unlock with the backup passkey")

    it("offers the backup this browser recorded and unlocks with that key alone; its refusal offers the other key", async () => {
      const { PhoneRequiredError } = await import("@obsidion/passkey-web")
      seedWallet(true)
      h.wallet = new FakeWallet()
      h.unlock
        .mockRejectedValueOnce(new PhoneRequiredError())
        .mockRejectedValueOnce(new PhoneRequiredError())
      await render()
      // The wallet's keys as cards in place of the unlock button; the session's key was last used.
      expect(unlockButton()).toBeUndefined()
      expect(
        Array.from(container.querySelectorAll('[data-testid="unlock-keys"] button'), (b) =>
          b.getAttribute("aria-label"),
        ),
      ).toEqual([
        "Unlock with the sign-up passkey, last used on this browser",
        "Unlock with the backup passkey",
      ])
      expect(otherKey()).toBeNull()
      expect(byTestId("unlock-choose-passkey")?.textContent).toBe("Use a different passkey")
      await act(async () => backupCard()!.click())
      await flush()
      expect(h.unlock.mock.calls[0]![1]).toMatchObject({ credentialId: "spare" })
      // The refusal's retry asks the same key; its alternative is the key that did not fail.
      const alternatives = () =>
        Array.from(
          container.querySelectorAll('[data-testid="unlock-other-key"]'),
          (b) => b.textContent,
        )
      expect(alternatives()).toEqual(["Use your sign-up passkey"])
      await act(async () => byTestId("unlock-retry")!.click())
      await flush()
      expect(h.unlock.mock.calls[1]![1]).toMatchObject({ credentialId: "spare" })
      expect(alternatives()).toEqual(["Use your sign-up passkey"])
      await act(async () => otherKey()!.click())
      await flush()
      expect(h.unlock.mock.calls[2]![1]).toMatchObject({ credentialId: "cred" })
      expect(h.retryUnlock).toHaveBeenCalledTimes(1)
    })

    it("a chosen key's wrong-key card keeps that key: the phone asks for it, and the exit hides it", async () => {
      const { StoredAddressMismatchError } = await import("@obsidion/front-core")
      const wrongKey = () =>
        Object.assign(new StoredAddressMismatchError(), {
          verdict: "wrong-key",
          observed: { credentialId: "spare", attachment: "platform" },
        })
      const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/155.0.0.0 Safari/537.36",
        configurable: true,
      })
      try {
        seedWallet(true)
        h.wallet = new FakeWallet()
        h.unlock.mockRejectedValueOnce(wrongKey()).mockRejectedValueOnce(wrongKey())
        await render()
        await act(async () => backupCard()!.click())
        await flush()
        await act(async () => byTestId("unlock-phone")!.click())
        await flush()
        expect(h.unlock.mock.calls[1]![1]).toMatchObject({ phone: true, credentialId: "spare" })
        await act(async () => byTestId("unlock-choose-passkey")!.click())
        await flush()
        expect(h.assign).toHaveBeenCalledWith("/enter?choose=1&avoid=spare")
      } finally {
        Object.defineProperty(navigator, "userAgent", ua)
      }
    })

    it("a backup this browser holds no record of is found on /enter, from the row's keys", async () => {
      seedWallet(false)
      h.wallet = new FakeWallet()
      await render()
      expect(otherKey()?.textContent).toBe("Use your backup passkey")
      await act(async () => otherKey()!.click())
      await flush()
      expect(h.unlock).not.toHaveBeenCalled()
      expect(h.clear).toHaveBeenCalledTimes(1)
      expect(h.assign).toHaveBeenCalledWith("/enter?pick=cred")
    })

    it("a wallet of three keys, one without a record here, offers another passkey by /enter", async () => {
      const map = {
        version: 1,
        entries: {
          cred: {
            credentialId: "cred",
            rpId: "localhost",
            l2Address: "0xabc",
            pubkey: ROOT,
            isMskRoot: true,
            passkeySet: [ROOT, SPARE, "cc".repeat(64)],
          },
        },
      }
      walletStorage.setItem("obsidion.obsidion_web_passkey_identity_map", JSON.stringify(map))
      h.wallet = new FakeWallet()
      await render()
      expect(otherKey()?.textContent).toBe("Use another passkey")
      expect(byTestId("unlock-keys")).toBeNull()
    })

    it("a wallet of three keys, all recorded here, offers each as a card and unlocks with the one tapped", async () => {
      const THIRD = "cc".repeat(64)
      const passkeySet = [ROOT, SPARE, THIRD]
      const backup = (credentialId: string, pubkey: string) => ({
        credentialId,
        rpId: "localhost",
        l2Address: "0xabc",
        pubkey,
        isMskRoot: false,
        backup: { account: `0x${"11".repeat(20)}`, envelope: `0x${"00".repeat(62)}` },
        passkeySet,
      })
      const entries = {
        cred: {
          credentialId: "cred",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: ROOT,
          isMskRoot: true,
          passkeySet,
        },
        spare: backup("spare", SPARE),
        third: backup("third", THIRD),
      }
      walletStorage.setItem(
        "obsidion.obsidion_web_passkey_identity_map",
        JSON.stringify({ version: 1, entries }),
      )
      h.wallet = new FakeWallet()
      await render()
      expect(
        Array.from(container.querySelectorAll('[data-testid="unlock-keys"] button'), (b) =>
          b.getAttribute("aria-label"),
        ),
      ).toEqual([
        "Unlock with the sign-up passkey, last used on this browser",
        "Unlock with the backup passkey 1",
        "Unlock with the backup passkey 2",
      ])
      expect(container.textContent).toContain("Any of them opens the same wallet.")
      expect(otherKey()).toBeNull()
      await act(async () => card("Unlock with the backup passkey 2")!.click())
      await flush()
      expect(h.unlock.mock.calls[0]![1]).toMatchObject({ credentialId: "third" })
    })
  })

  it("leaving the screen ends the attempt, and its late answer installs nothing", async () => {
    h.wallet = new FakeWallet()
    let finish!: () => void
    h.unlock.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    await render()
    await tapUnlock()
    const signal = (h.unlock.mock.calls[0]![1] as { signal: AbortSignal }).signal
    expect(signal.aborted).toBe(false)
    act(() => root.unmount())
    expect(signal.aborted).toBe(true)
    await act(async () => finish())
    await flush()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it("a policy refusal renders in place with a retry and the chooser exit", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new PhoneRequiredError())
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()

    // "Use a different passkey" signs out and reloads into the chooser.
    await act(async () => byTestId("unlock-choose-passkey")!.click())
    const { getActiveCredentialId } = await import("../../../src/platform/storage/activeStorage")
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(getActiveCredentialId()).toBeNull()
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1")
  })

  it("a backup record whose envelope did not open shows the wallet's card by name, with a retry", async () => {
    const { PasskeyEnvelopeError } = await import("@obsidion/front-core")
    h.wallet = new FakeWallet()
    await render()
    h.unlock.mockRejectedValueOnce(new PasskeyEnvelopeError("decrypt"))
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("PasskeyEnvelopeError")
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "identity:unlock",
      code: "err",
    })
    expect(h.retryUnlock).not.toHaveBeenCalled()
  })

  it("a certain wrong-key mismatch shows the wrong-key card: Show passkeys, no retry, the failing credential avoided", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(
      Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key" }),
    )
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("StoredAddressMismatchError")
    // This copy would answer a retry again; the way on is another device, picked on the sign-in
    // screen with this credential's row hidden.
    expect(byTestId("unlock-retry")).toBeNull()
    expect(byTestId("unlock-show-passkeys")).not.toBeNull()
    await act(async () => byTestId("unlock-show-passkeys")!.click())
    await flush()
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1&avoid=cred")
  })

  it("on a phone the passkey exit is held while the unlock ceremony runs", async () => {
    const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)",
      configurable: true,
    })
    try {
      h.wallet = new FakeWallet()
      h.unlock.mockImplementationOnce(() => new Promise(() => {}))
      await render()
      const exit = () => byTestId("unlock-choose-passkey") as HTMLButtonElement
      expect(exit().disabled).toBe(false)
      await act(async () => unlockButton().click())
      await flush()
      expect(exit().disabled).toBe(true)
      expect(h.clear).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, "userAgent", ua)
    }
  })

  describe("on a Mac", () => {
    const MAC_CHROME =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/155.0.0.0 Safari/537.36"
    const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    beforeEach(() => {
      Object.defineProperty(navigator, "userAgent", { value: MAC_CHROME, configurable: true })
    })
    afterEach(() => {
      Object.defineProperty(navigator, "userAgent", ua)
    })

    const wrongKey = async () => {
      const { StoredAddressMismatchError } = await import("@obsidion/front-core")
      return Object.assign(new StoredAddressMismatchError(), {
        verdict: "wrong-key",
        observed: { credentialId: "cred", attachment: "platform" },
      })
    }
    const phoneFlag = (call: number) =>
      (h.unlock.mock.calls[call]![1] as { phone?: boolean } | undefined)?.phone

    it("the wrong-key card leads with the phone, keeps the session, and still hides the failing credential", async () => {
      h.wallet = new FakeWallet()
      h.unlock.mockRejectedValueOnce(await wrongKey())
      await render()
      await tapUnlock()
      expect(container.textContent).toContain("until you sign out or this browser clears its data")
      expect(byTestId("unlock-retry")).toBeNull()
      expect(byTestId("unlock-show-passkeys")).toBeNull()

      await act(async () => byTestId("unlock-phone")!.click())
      await flush()
      expect(h.unlock).toHaveBeenCalledTimes(2)
      expect(phoneFlag(0)).toBeUndefined()
      expect(phoneFlag(1)).toBe(true)
      expect(h.clear).not.toHaveBeenCalled()
      expect(h.retryUnlock).toHaveBeenCalledTimes(1)
    })

    it("a phone attempt refused for this computer's answer retries on the phone", async () => {
      const { PhoneRequiredError } = await import("@obsidion/passkey-web")
      h.wallet = new FakeWallet()
      h.unlock.mockRejectedValueOnce(await wrongKey())
      h.unlock.mockRejectedValueOnce(new PhoneRequiredError())
      await render()
      await tapUnlock()
      await act(async () => byTestId("unlock-phone")!.click())
      await flush()
      expect(byTestId("unlock-refused")?.dataset.reason).toBe("PhoneRequiredError")
      await act(async () => byTestId("unlock-retry")!.click())
      await flush()
      expect(phoneFlag(2)).toBe(true)
    })

    it("a dismissed phone prompt puts the wrong-key card back", async () => {
      h.wallet = new FakeWallet()
      h.unlock.mockRejectedValueOnce(await wrongKey())
      h.unlock.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
      await render()
      await tapUnlock()
      await act(async () => byTestId("unlock-phone")!.click())
      await flush()
      expect(byTestId("unlock-phone")).not.toBeNull()
    })

    it.each([
      ["this computer's answer with no record id", { attachment: "platform" }, true],
      ["another device's answer", { attachment: "cross-platform" }, false],
    ] as const)(
      "a not-reproduced mismatch from %s: update line %s",
      async (_n, observed, shown) => {
        const { StoredAddressMismatchError } = await import("@obsidion/front-core")
        h.wallet = new FakeWallet()
        h.unlock.mockRejectedValueOnce(
          Object.assign(new StoredAddressMismatchError(), {
            verdict: "not-reproduced",
            observed: { credentialId: "cred", ...observed },
          }),
        )
        await render()
        await tapUnlock()
        expect(byTestId("unlock-retry")).not.toBeNull()
        expect(byTestId("passkey-mac-update") !== null).toBe(shown)
        expect(byTestId("unlock-phone")).toBeNull()
      },
    )
  })

  it("no record for the active passkey goes straight to /enter", async () => {
    walletStorage.removeItem("obsidion.obsidion_web_passkey_identity_map")
    h.wallet = new FakeWallet()
    await render()
    expect(container.textContent).toContain("enter route")
    expect(h.unlock).not.toHaveBeenCalled()
  })

  it("a session that changed while the prompt was open ends the click quietly", async () => {
    const { SessionChangedError } = await import("../../../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new SessionChangedError())
    await render()
    await tapUnlock()
    expect(container.textContent).not.toContain("enter route")
    expect(byTestId("unlock-refused")).toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    expect(unlockButton()).toBeDefined()
  })

  it("a passkey that worked but an account that would not install shows front-core's reason", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(byTestId("unlock-install-failed")).toBeNull()

    // The unlock succeeds and front-core's install fails: the pane stays and says why.
    h.retryUnlock.mockImplementationOnce(async () => {
      h.unlockError = "Historical contract instance is missing"
    })
    await tapUnlock()
    expect(unlockButton()).toBeDefined()
    expect(byTestId("unlock-install-failed")?.textContent).toContain(
      "Historical contract instance is missing",
    )

    // The next tap starts clean.
    h.unlock.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await tapUnlock()
    expect(byTestId("unlock-install-failed")).toBeNull()
  })

  it("an unlock that finds no passkey session goes to /enter", async () => {
    const { NoPasskeySessionError } = await import("../../../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new NoPasskeySessionError())
    await render()
    await tapUnlock()
    expect(container.textContent).toContain("enter route")
  })
})

/** An unlock inside an app's built-in browser, where the passkey can't be used at all. */
describe("UnlockGate in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  }
  const unsupported = () =>
    new DOMException("Error connecting to Web Authentication service", "NotSupportedError")
  const failures = () =>
    h.fireEvent.mock.calls.filter(([event]) => event === "action_failed").map(([, props]) => props)
  let ua: { mockRestore: () => void } | undefined

  /** The signed-in page at `pathname` in a browser with this user agent. */
  const at = (pathname: string, userAgent: string) => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const origin = "https://wallet.test"
    Object.defineProperty(window, "location", {
      value: {
        assign: h.assign,
        origin,
        href: `${origin}${pathname}`,
        pathname,
        search: "",
        hash: "",
      },
      writable: true,
    })
  }

  const reports: unknown[] = []
  let unsubscribe = () => {}

  beforeEach(async () => {
    sessionStorage.clear()
    h.wallet = new FakeWallet()
    const { subscribeErrorModal } = await import("../../../src/errors/errorModal")
    reports.length = 0
    unsubscribe = subscribeErrorModal((payload) => reports.push(payload))
  })
  afterEach(() => {
    unsubscribe()
    ua?.mockRestore()
    ua = undefined
  })

  it("a not-supported unlock shows the card with Chrome opening the sign-in page, not the error modal", async () => {
    at("/", UA.android)
    h.unlock.mockRejectedValueOnce(unsupported())
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("NotSupportedError")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      "intent://wallet.test/enter#Intent;scheme=https;package=com.android.chrome;end",
    )
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(byTestId("unlock-choose-passkey")).not.toBeNull()
    expect(reports).toEqual([])
    expect(failures()).toEqual([{ action: "identity:unlock", code: "err" }])
  })

  it("a closed prompt in an iPhone app browser leaves the pane as it was", async () => {
    at("/", UA.iosX)
    h.unlock.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")).toBeNull()
    expect(unlockButton()).toBeDefined()
    expect(reports).toEqual([])
    expect(failures()).toEqual([])
  })

  it("an attempt a newer tap replaced shows nothing when it fails as not supported", async () => {
    at("/", UA.android)
    let fail!: (e: unknown) => void
    h.unlock
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = reject)))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    await render()
    await tapUnlock()
    await tapUnlock()
    await act(async () => fail(unsupported()))
    await flush()
    expect(byTestId("unlock-refused")).toBeNull()
    expect(failures()).toEqual([])
  })
})

/** One `passkey_ceremony` per unlock tap, classified from what the auth service threw. */
describe("UnlockGate passkey telemetry", () => {
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  const events = () => passkeyEvents(h.fireEvent)

  beforeEach(async () => {
    harness = await passkeyTelemetryHarness()
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
    h.wallet = new FakeWallet()
  })

  it("an unlock whose stored account no longer reproduces reads as a passkey mismatch", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      await harness.answered("assert", opts?.own)
      throw new StoredAddressMismatchError()
    })
    await render()
    await tapUnlock()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch", prompts: "1" }),
    ])
  })

  it("leaving the screen during the request sends nothing, then or when the page goes", async () => {
    const held: { request?: HeldRequest } = {}
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      held.request = harness.request("assert", opts?.signal, opts?.own)
      await held.request.settled
    })
    await render()
    await tapUnlock()
    expect(held.request).toBeDefined()
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("a second tap while the first is still asking sends nothing for the first", async () => {
    const first: { request?: HeldRequest } = {}
    h.unlock
      .mockImplementationOnce(async (_derive, opts) => {
        first.request = harness.request("assert", opts?.signal, opts?.own)
        await first.request.settled
      })
      .mockImplementationOnce(async (_derive, opts) => {
        await harness.answered("assert", opts?.own)
      })
    await render()
    await tapUnlock()
    expect(first.request).toBeDefined()
    await tapUnlock()
    await flush()
    expect(h.unlock).toHaveBeenCalledTimes(2)
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", attempt: "2" }),
    ])
  })

  it("keeps a replaced unlock's own request out of the unlock that replaced it", async () => {
    let askLate!: () => void
    const late = new Promise<void>((resolve) => (askLate = resolve))
    const second: { request?: HeldRequest } = {}
    h.unlock
      .mockImplementationOnce(async (_derive, opts) => {
        await late
        await harness.answered("assert", opts?.own)
      })
      .mockImplementationOnce(async (_derive, opts) => {
        second.request = harness.request("assert", undefined, opts?.own)
        await second.request.settled
      })
    await render()
    await tapUnlock()
    await tapUnlock()
    expect(second.request).toBeDefined()
    // The replaced unlock asks the browser after its successor did, and owns that request.
    askLate()
    await flush()
    await act(async () => second.request!.answer())
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", prompts: "1" }),
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", prompts: "1" }),
    ])
  })
})

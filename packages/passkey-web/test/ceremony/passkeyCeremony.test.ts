// @vitest-environment jsdom
import { runInNewContext } from "node:vm"
import { APPLE_ICLOUD_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hexToBytes } from "../../src/ceremony/bytes.js"
import { KEPT_PASSKEY_API_KEY, NATIVE_LOCK_KEY } from "../../src/ceremony/nativeLock.js"
import {
  BLOCKED_PROMPT_MS,
  BrowserPasskeyCeremony,
  type CeremonyTiming,
  DEFAULT_CEREMONY_TIMING,
  type PasskeyAssertRequest,
  type PasskeyRequestHook,
  type PasskeyRequestSignal,
  decodePrfSlot,
  isBlockedPromptError,
  isEvictedRequestError,
  isNoCredentialError,
  isUnsupportedAlgorithmError,
  extensionAnswersPasskeys,
  isWedgedTabError,
  onPasskeyRequest,
  passkeyExtensionFor,
  passkeysSupported,
  recordRequestHeld,
  requestHeldMs,
} from "../../src/ceremony/passkeyCeremony.js"
import {
  BITWARDEN_CREATE,
  LASTPASS_CREATE,
  NATIVE_CREATE,
  NATIVE_GET,
  ONEPASSWORD_CREATE,
  PROTON_PASS_CREATE,
  installCredentials,
  wrapperFrom,
} from "../support/extensionWrappers.js"
import {
  UNKNOWN_PROVENANCE,
  type UserHandleProvenance,
  decodeUserHandle,
  decodeUserHandleProvenance,
  encodeUserHandle,
} from "../../src/ceremony/userHandle.js"
import {
  RelatedOriginPasskeyError,
  isPasskeyCancelled,
  passkeyWritten,
} from "../../src/refusals/passkeyErrors.js"
import { providerSlugFor } from "../../src/rules/passkeyProviders.js"
import { IOS_FLOOR_COPY } from "../../src/refusals/refusalCopy.js"
import { FakePasskeyCeremony } from "../support/fakePasskeyCeremony.js"

/** A hook that records every signal, and the signals it heard. */
function listener() {
  const heard: PasskeyRequestSignal[] = []
  const hook: PasskeyRequestHook = (signal) => {
    heard.push(signal)
  }
  return { heard, hook, phases: () => heard.map((s) => s.phase) }
}

/** Evidence may name only these; never an id, a key, a signature or PRF output. */
const EVIDENCE_KEYS = ["aaguid", "authenticatorAttachment", "backupEligible", "transports"]

function fakeAssertionCredential(id = "cred-1") {
  return {
    id,
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      signature: new Uint8Array([1, 2, 3]).buffer,
      authenticatorData: new Uint8Array(37).buffer,
      clientDataJSON: new Uint8Array([4, 5]).buffer,
    },
  }
}

const request = { rpId: "localhost", challenge: new Uint8Array(32) }

/** Fast enough to keep the suite quick; the production values are minutes/seconds. */
const timing: CeremonyTiming = {
  handoffWaitMs: 30,
  teardownWaitMs: 5,
  focusWaitMs: 10,
  pendingRetryDelaysMs: [1, 1, 1, 1],
  requestTimeoutMs: 50,
}

const CANCELLED = new DOMException("the user cancelled", "AbortError")
const pendingError = () => new DOMException("A request is already pending.", "NotAllowedError")

/** A request that only ever settles when its abort signal fires. */
function wedged() {
  return (options: CredentialRequestOptions) =>
    new Promise((_, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason))
    })
}

describe("passkeysSupported", () => {
  it("needs WebAuthn and Web Locks, which the setup file stubs under jsdom", () => {
    expect(passkeysSupported()).toBe(true)
  })
})

describe("passkeyExtensionFor and extensionAnswersPasskeys", () => {
  const script = () => async () => null
  let restore = () => {}
  const install = (value: unknown) => {
    restore()
    restore = installCredentials(value)
  }
  afterEach(() => {
    restore()
    restore = () => {}
  })

  it("names 1Password and Bitwarden by the markers in their captured wrappers", () => {
    install({ get: NATIVE_GET, create: wrapperFrom(ONEPASSWORD_CREATE) })
    expect(passkeyExtensionFor()).toBe("1password")
    expect(extensionAnswersPasskeys("create")).toBe(true)
    expect(extensionAnswersPasskeys()).toBe(false)
    install({ get: NATIVE_GET, create: wrapperFrom(BITWARDEN_CREATE) })
    expect(passkeyExtensionFor()).toBe("bitwarden")
  })

  it("reads LastPass, Proton Pass and a plain script as other", () => {
    for (const source of [LASTPASS_CREATE, PROTON_PASS_CREATE]) {
      install({ get: NATIVE_GET, create: wrapperFrom(source) })
      expect(passkeyExtensionFor()).toBe("other")
    }
    install({ get: NATIVE_GET, create: script() })
    expect(passkeyExtensionFor()).toBe("other")
  })

  it("checks Bitwarden's marker first and holds both markers to whole words", () => {
    install({ create: wrapperFrom("function create(e){ return e.hints && e.fallbackRequested }") })
    expect(passkeyExtensionFor()).toBe("bitwarden")
    install({
      create: wrapperFrom("function create(e){ return hintsFor(e) || e.fallbackRequestedAt }"),
    })
    expect(passkeyExtensionFor()).toBe("other")
  })

  it("reads a native print without the method's own name as a script", () => {
    install({ get: NATIVE_GET, create: Object.create.bind(Object) })
    expect(passkeyExtensionFor()).toBe("other")
    expect(extensionAnswersPasskeys("create")).toBe(true)
    expect(extensionAnswersPasskeys()).toBe(false)
    install({ get: NATIVE_GET, create: new Proxy(Object.create, {}) })
    expect(passkeyExtensionFor()).toBe("other")
    install({ get: NATIVE_GET, create: Reflect.get })
    expect(passkeyExtensionFor()).toBe("other")
  })

  /** A function whose print is `text`, as another engine would give it. */
  const printing = (text: string) => {
    const fn = () => null
    const original = Function.prototype.toString
    Function.prototype.toString = function (this: unknown) {
      return this === fn ? text : original.call(this)
    }
    return { fn, restore: () => void (Function.prototype.toString = original) }
  }

  it("reads the browser's print whatever the engine's whitespace, and any other native print as a script", () => {
    const prints = [
      ["function create() {\n    [native code]\n}", "none"],
      ["function create() { [native code] }", "none"],
      ["function () { [native code] }", "other"],
      ["function() {\n    [native code]\n}", "other"],
      ["function ProxyObject() {\n    [native code]\n}", "other"],
    ] as const
    for (const [text, expected] of prints) {
      const { fn, restore } = printing(text)
      try {
        install({ get: NATIVE_GET, create: fn })
        expect(passkeyExtensionFor()).toBe(expected)
        expect(extensionAnswersPasskeys("create")).toBe(expected !== "none")
      } finally {
        restore()
      }
    }
  })

  it("reads a script named create that only mentions the native print as a script", () => {
    install({
      create: wrapperFrom("function create(e){ /* [native code] */ return e.publicKey?.hints }"),
    })
    expect(passkeyExtensionFor()).toBe("1password")
    expect(extensionAnswersPasskeys("create")).toBe(true)
    install({
      create: wrapperFrom('function create(){ return "function create() { [native code] }" }'),
    })
    expect(passkeyExtensionFor()).toBe("other")
  })

  it("never reads get for the class, while the boolean reads each call on its own", () => {
    const reads: string[] = []
    install({
      get get() {
        reads.push("get")
        return script()
      },
      create: NATIVE_CREATE,
    })
    expect(passkeyExtensionFor()).toBe("none")
    expect(reads).toEqual([])
    expect(extensionAnswersPasskeys()).toBe(true)
    expect(extensionAnswersPasskeys("create")).toBe(false)
  })

  it("reads no WebAuthn, or a lookup that throws, as none", () => {
    install(undefined)
    expect(passkeyExtensionFor()).toBe("none")
    expect(extensionAnswersPasskeys()).toBe(false)
    install({})
    expect(passkeyExtensionFor()).toBe("none")
    expect(extensionAnswersPasskeys("create")).toBe(false)
    install({
      get create(): never {
        throw new Error("blocked")
      },
      get get(): never {
        throw new Error("blocked")
      },
    })
    expect(passkeyExtensionFor()).toBe("none")
    expect(extensionAnswersPasskeys()).toBe(false)
    expect(extensionAnswersPasskeys("create")).toBe(false)
  })

  describe("an own create or get that is not the prototype's method", () => {
    /** Another realm's `Object.create`: prints as the browser's own, is a different function. */
    const foreignCreate: unknown = runInNewContext("Object.create")
    const withPrototype = (own: Record<string, unknown>): Record<string, unknown> =>
      Object.assign(Object.create({ create: NATIVE_CREATE, get: NATIVE_GET }), own)
    const scope = globalThis as Record<string, unknown>
    afterEach(() => {
      delete scope[NATIVE_LOCK_KEY]
    })

    it("is a script's, whatever it prints", () => {
      install(withPrototype({ create: foreignCreate }))
      expect(extensionAnswersPasskeys("create")).toBe(true)
      expect(extensionAnswersPasskeys()).toBe(false)
      expect(passkeyExtensionFor()).toBe("other")
      install(withPrototype({ get: runInNewContext("Reflect.get") }))
      expect(extensionAnswersPasskeys()).toBe(true)
      expect(extensionAnswersPasskeys("create")).toBe(false)
      expect(passkeyExtensionFor()).toBe("none")
    })

    it("is the browser's own when it is the prototype's, or frozen as the lock leaves it with the record saying applied", () => {
      const frozen = withPrototype({})
      Object.defineProperty(frozen, "create", { value: foreignCreate, writable: false })
      install(frozen)
      scope[NATIVE_LOCK_KEY] = { create: "applied" }
      expect(extensionAnswersPasskeys("create")).toBe(false)
      expect(passkeyExtensionFor()).toBe("none")
      scope[NATIVE_LOCK_KEY] = { create: "lost_race" }
      expect(passkeyExtensionFor()).toBe("other")
      install(withPrototype({ create: NATIVE_CREATE }))
      delete scope[NATIVE_LOCK_KEY]
      expect(extensionAnswersPasskeys("create")).toBe(false)
      expect(passkeyExtensionFor()).toBe("none")
    })

    it("does not take a forged record's word for a writable override", () => {
      install(withPrototype({ create: foreignCreate }))
      scope[NATIVE_LOCK_KEY] = { create: "applied", get: "applied" }
      expect(extensionAnswersPasskeys("create")).toBe(true)
      expect(passkeyExtensionFor()).toBe("other")
      const scripted = withPrototype({})
      Object.defineProperty(scripted, "create", { value: () => null, writable: false })
      install(scripted)
      expect(extensionAnswersPasskeys("create")).toBe(true)
    })

    it("needs a prototype method to shadow: a plain stand-in keeps reading none", () => {
      install({ get: NATIVE_GET, create: foreignCreate })
      expect(passkeyExtensionFor()).toBe("none")
      expect(extensionAnswersPasskeys("create")).toBe(false)
    })

    it("stays the lock's own after a script patches the prototype behind it", () => {
      const credentials = withPrototype({})
      install(credentials)
      scope[NATIVE_LOCK_KEY] = { create: "applied", get: "applied" }
      Object.defineProperty(credentials, "create", { value: NATIVE_CREATE, writable: false })
      Object.getPrototypeOf(credentials).create = new Proxy(NATIVE_CREATE as object, {})
      expect(extensionAnswersPasskeys("create")).toBe(false)
      expect(passkeyExtensionFor()).toBe("none")
    })

    it("reads an own accessor through its getter, so 1Password's wrapper is still named", () => {
      let reads = 0
      const credentials = withPrototype({})
      Object.defineProperty(credentials, "create", {
        get: () => {
          reads += 1
          return wrapperFrom(ONEPASSWORD_CREATE)
        },
        configurable: false,
      })
      install(credentials)
      scope[NATIVE_LOCK_KEY] = { create: "skipped_accessor", get: "applied" }
      expect(passkeyExtensionFor()).toBe("1password")
      expect(reads).toBe(1)
      expect(extensionAnswersPasskeys("create")).toBe(true)
      expect(extensionAnswersPasskeys()).toBe(false)
    })

    it("is an override when the prototype holds an accessor and the instance a value", () => {
      const credentials = Object.create(
        Object.defineProperty({ get: NATIVE_GET }, "create", { get: () => NATIVE_CREATE }),
      )
      Object.defineProperty(credentials, "create", { value: foreignCreate, writable: true })
      install(credentials)
      expect(extensionAnswersPasskeys("create")).toBe(true)
      expect(passkeyExtensionFor()).toBe("other")
    })
  })
})

describe("BrowserPasskeyCeremony tab slot", () => {
  const get = vi.fn()

  beforeEach(() => {
    get.mockReset()
    Object.defineProperty(navigator, "credentials", {
      value: { get, create: vi.fn() },
      configurable: true,
    })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  it("names the recorded transports on the credential it allows", async () => {
    get.mockResolvedValueOnce(fakeAssertionCredential())
    await new BrowserPasskeyCeremony(timing).assert({
      ...request,
      credentialIds: ["Y3JlZC0x"],
      transports: ["hybrid"],
    })
    const { publicKey } = get.mock.calls[0]![0] as CredentialRequestOptions
    expect(publicKey!.allowCredentials).toMatchObject([
      { type: "public-key", transports: ["hybrid"] },
    ])
  })

  it("leaves the credential transport-free when none were recorded", async () => {
    get.mockResolvedValueOnce(fakeAssertionCredential())
    await new BrowserPasskeyCeremony(timing).assert({ ...request, credentialIds: ["Y3JlZC0x"] })
    const { publicKey } = get.mock.calls[0]![0] as CredentialRequestOptions
    expect(publicKey!.allowCredentials![0]).not.toHaveProperty("transports")
  })

  it("hands back the user handle the credential carries, and nothing when it carries none", async () => {
    const credential = fakeAssertionCredential()
    get.mockResolvedValueOnce({
      ...credential,
      response: { ...credential.response, userHandle: encodeUserHandle("alice").buffer },
    })
    const named = await new BrowserPasskeyCeremony(timing).assert(request)
    expect(decodeUserHandle(named.userHandle)).toBe("alice")

    get.mockResolvedValueOnce(fakeAssertionCredential())
    const nameless = await new BrowserPasskeyCeremony(timing).assert(request)
    expect(nameless.userHandle).toBeUndefined()
  })

  it("reads the user-verified flag, and nothing from authenticator data too short for flags", async () => {
    const credential = fakeAssertionCredential()
    const verified = new Uint8Array(37)
    verified[32] = 0x05
    get.mockResolvedValueOnce({
      ...credential,
      response: { ...credential.response, authenticatorData: verified.buffer },
    })
    expect((await new BrowserPasskeyCeremony(timing).assert(request)).userVerified).toBe(true)

    get.mockResolvedValueOnce(fakeAssertionCredential())
    expect((await new BrowserPasskeyCeremony(timing).assert(request)).userVerified).toBe(false)

    get.mockResolvedValueOnce({
      ...credential,
      response: { ...credential.response, authenticatorData: new Uint8Array(20).buffer },
    })
    expect((await new BrowserPasskeyCeremony(timing).assert(request)).userVerified).toBeUndefined()
  })

  it("queues behind a live ceremony instead of aborting it", async () => {
    let settleFirst!: (credential: unknown) => void
    get.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))
    get.mockResolvedValueOnce(fakeAssertionCredential("cred-2"))

    const ceremony = new BrowserPasskeyCeremony(timing)
    const first = ceremony.assert(request)
    const second = ceremony.assert(request)

    // The second ceremony must not have reached the browser while the first holds the tab.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(get).toHaveBeenCalledTimes(1)

    settleFirst(fakeAssertionCredential("cred-1"))
    expect((await first).credentialId).toBe("cred-1")
    expect((await second).credentialId).toBe("cred-2")
  })

  it("announces the request as it goes out and as it settles, failed or not", async () => {
    const heard: boolean[] = []
    const off = onPasskeyRequest((active) => heard.push(active))
    get.mockImplementationOnce(async () => {
      heard.push(get.mock.calls.length > 0)
      return fakeAssertionCredential()
    })
    get.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    const ceremony = new BrowserPasskeyCeremony(timing)
    await ceremony.assert(request)
    await expect(ceremony.assert(request)).rejects.toThrow("closed")
    off()
    // Announced before the browser saw the request.
    expect(heard).toEqual([true, true, false, true, false])
  })

  it("a holder that outlives its eviction leaves its successor's request announced", async () => {
    const heard: boolean[] = []
    const off = onPasskeyRequest((active) => heard.push(active))
    let settleStuck!: (credential: unknown) => void
    let settleNext!: (credential: unknown) => void
    // Ignores its abort, so it is still out when the successor takes the tab.
    get.mockImplementationOnce(() => new Promise((resolve) => (settleStuck = resolve)))
    get.mockImplementationOnce(() => new Promise((resolve) => (settleNext = resolve)))
    const ceremony = new BrowserPasskeyCeremony(timing)
    const stuck = ceremony.assert(request)
    const next = ceremony.assert(request)
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    settleStuck(fakeAssertionCredential())
    await stuck
    expect(heard).toEqual([true, true])
    settleNext(fakeAssertionCredential())
    await next
    off()
    expect(heard).toEqual([true, true, false])
  })

  it("evicts a wedged holder so the next ceremony can run, and names the eviction", async () => {
    get.mockImplementationOnce(wedged())
    get.mockResolvedValueOnce(fakeAssertionCredential())

    const ceremony = new BrowserPasskeyCeremony(timing)
    const stuck = ceremony.assert(request).catch((e: unknown) => e)

    const result = await ceremony.assert(request)
    expect(result.credentialId).toBe("cred-1")
    const error = await stuck
    expect(isEvictedRequestError(error)).toBe(true)
    expect(isWedgedTabError(error)).toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("proceeds when a wedged holder ignores its abort", async () => {
    get.mockImplementationOnce(() => new Promise(() => {}))
    get.mockResolvedValueOnce(fakeAssertionCredential())

    const ceremony = new BrowserPasskeyCeremony(timing)
    // The holder never settles: its native call ignores the abort.
    void ceremony.assert(request)

    expect((await ceremony.assert(request)).credentialId).toBe("cred-1")
  })

  it("retries while the browser still reports a pending request", async () => {
    get.mockRejectedValueOnce(pendingError())
    get.mockRejectedValueOnce(pendingError())
    get.mockResolvedValueOnce(fakeAssertionCredential())

    const result = await new BrowserPasskeyCeremony(timing).assert(request)
    expect(result.credentialId).toBe("cred-1")
    expect(get).toHaveBeenCalledTimes(3)
  })

  it("names the tab wedged once the retries are exhausted", async () => {
    get.mockRejectedValue(pendingError())

    const error = await new BrowserPasskeyCeremony(timing).assert(request).catch((e: unknown) => e)
    expect(isWedgedTabError(error)).toBe(true)
    expect(isEvictedRequestError(error)).toBe(false)
    expect(get).toHaveBeenCalledTimes(timing.pendingRetryDelaysMs.length + 1)
  })

  it("keeps retrying long enough for a phone session to be released", () => {
    // A sign-in's second assertion can follow the first by seconds while Chromium still holds the
    // first (hybrid) request; the backoff has to outlast that teardown.
    const total = DEFAULT_CEREMONY_TIMING.pendingRetryDelaysMs.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(9_000)
    expect(total).toBeLessThanOrEqual(12_000)
  })

  it("the caller's signal ends the retries between attempts", async () => {
    const controller = new AbortController()
    get.mockImplementation(() => {
      if (get.mock.calls.length === 2) controller.abort()
      return Promise.reject(pendingError())
    })

    await expect(
      new BrowserPasskeyCeremony(timing).assert({ ...request, signal: controller.signal }),
    ).rejects.toThrow(/abort/i)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("the caller's signal closes an issued sheet", async () => {
    const controller = new AbortController()
    get.mockImplementation(wedged())

    const asserting = new BrowserPasskeyCeremony(timing).assert({
      ...request,
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 5))
    controller.abort(CANCELLED)
    await expect(asserting).rejects.toThrow(CANCELLED.message)
  })

  it("a cancelled waiter evicts nobody and keeps its place for the ceremonies behind it", async () => {
    let abortedFirst = false
    get.mockImplementationOnce(
      (options: CredentialRequestOptions) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () => {
            abortedFirst = true
            reject(options.signal!.reason)
          })
        }),
    )
    get.mockResolvedValue(fakeAssertionCredential())

    const ceremony = new BrowserPasskeyCeremony(timing)
    const first = expect(ceremony.assert(request)).rejects.toThrow(/evicted/)
    const cancel = new AbortController()
    const second = ceremony.assert({ ...request, signal: cancel.signal })
    await new Promise((r) => setTimeout(r, 5))
    cancel.abort(CANCELLED)
    await expect(second).rejects.toThrow(CANCELLED.message)

    // Past the cancelled waiter's would-be deadline, the holder is untouched.
    await new Promise((r) => setTimeout(r, timing.handoffWaitMs + timing.teardownWaitMs + 10))
    expect(abortedFirst).toBe(false)
    expect(get).toHaveBeenCalledTimes(1)

    // The next ceremony still queues behind the holder and evicts it on its own deadline.
    expect((await ceremony.assert(request)).credentialId).toBe("cred-1")
    expect(abortedFirst).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
    await first
  })

  it("a cancel during the focus wait ends the ceremony without issuing", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const cancel = new AbortController()
    const pending = new BrowserPasskeyCeremony(timing).assert({
      ...request,
      signal: cancel.signal,
    })
    await new Promise((r) => setTimeout(r, 2))
    cancel.abort(CANCELLED)
    await expect(pending).rejects.toThrow(CANCELLED.message)
    expect(get).not.toHaveBeenCalled()
  })

  it("a signal already aborted issues nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new BrowserPasskeyCeremony(timing).assert({ ...request, signal: controller.signal }),
    ).rejects.toThrow(/abort/i)
    expect(get).not.toHaveBeenCalled()
  })

  it("does not retry other errors", async () => {
    get.mockRejectedValueOnce(new DOMException("The operation was aborted.", "NotAllowedError"))

    await expect(new BrowserPasskeyCeremony(timing).assert(request)).rejects.toThrow(/aborted/)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("holds a ceremony until the document is focused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    get.mockResolvedValueOnce(fakeAssertionCredential())

    const pending = new BrowserPasskeyCeremony(timing).assert(request)
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(get).not.toHaveBeenCalled()

    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    window.dispatchEvent(new Event("focus"))
    expect((await pending).credentialId).toBe("cred-1")
  })

  describe("request hook", () => {
    it("signals the call's own request as it goes to the browser, and the answer after", async () => {
      const { heard, phases } = listener()
      const callsAtSignal: number[] = []
      get.mockResolvedValueOnce(fakeAssertionCredential())
      const asked: PasskeyAssertRequest = { ...request, credentialIds: ["Y3JlZC0x"] }

      await new BrowserPasskeyCeremony(timing, (signal) => {
        callsAtSignal.push(get.mock.calls.length)
        heard.push(signal)
      }).assert(asked)

      expect(phases()).toEqual(["issued", "answered"])
      expect(callsAtSignal).toEqual([0, 1])
      expect(heard.every((s) => s.kind === "assert" && s.request === asked)).toBe(true)
      const answered = heard[1] as Extract<PasskeyRequestSignal, { phase: "answered" }>
      expect(answered.evidence).toEqual({
        authenticatorAttachment: "platform",
        backupEligible: false,
      })
    })

    it("signals every re-issue behind a pending request, and one answer", async () => {
      const { heard, hook, phases } = listener()
      get.mockRejectedValueOnce(pendingError())
      get.mockRejectedValueOnce(pendingError())
      get.mockResolvedValueOnce(fakeAssertionCredential())

      await new BrowserPasskeyCeremony(timing, hook).assert(request)
      expect(phases()).toEqual(["issued", "issued", "issued", "answered"])
      expect(heard.every((s) => s.request === request)).toBe(true)
    })

    it("signals nothing for a call cancelled while it waits its turn", async () => {
      const { heard, hook } = listener()
      let settleFirst!: (credential: unknown) => void
      get.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))

      const ceremony = new BrowserPasskeyCeremony(timing, hook)
      const first = ceremony.assert(request)
      const cancel = new AbortController()
      const queued: PasskeyAssertRequest = { ...request, signal: cancel.signal }
      const second = ceremony.assert(queued)
      await new Promise((r) => setTimeout(r, 2))
      cancel.abort(CANCELLED)
      await expect(second).rejects.toThrow(CANCELLED.message)

      settleFirst(fakeAssertionCredential())
      await first
      expect(heard.filter((s) => s.request === queued)).toEqual([])
      expect(heard.map((s) => s.phase)).toEqual(["issued", "answered"])
    })

    it("never answers a request the browser rejected or resolved empty", async () => {
      const rejected = listener()
      get.mockRejectedValueOnce(new DOMException("Dismissed", "NotAllowedError"))
      await expect(
        new BrowserPasskeyCeremony(timing, rejected.hook).assert(request),
      ).rejects.toThrow(/Dismissed/)
      expect(rejected.phases()).toEqual(["issued"])

      const empty = listener()
      get.mockResolvedValueOnce(null)
      const error = await new BrowserPasskeyCeremony(timing, empty.hook)
        .assert(request)
        .catch((e: unknown) => e)
      expect(empty.phases()).toEqual(["issued"])
      expect(isNoCredentialError(error)).toBe(true)
    })

    it("answers with what could be read, then fails as it would have without the hook", async () => {
      const gone = new Error("response gone")
      const { heard, hook, phases } = listener()
      get.mockResolvedValueOnce({
        ...fakeAssertionCredential(),
        get response(): never {
          throw gone
        },
      })

      await expect(new BrowserPasskeyCeremony(timing, hook).assert(request)).rejects.toThrow(
        gone.message,
      )
      expect(phases()).toEqual(["issued", "answered"])
      const answered = heard[1] as Extract<PasskeyRequestSignal, { phase: "answered" }>
      expect(answered.evidence).toEqual({
        authenticatorAttachment: "platform",
        backupEligible: undefined,
      })
    })

    it("a hook that throws or rejects changes nothing", async () => {
      get.mockResolvedValueOnce(fakeAssertionCredential())
      const throwing = await new BrowserPasskeyCeremony(timing, () => {
        throw new Error("telemetry down")
      }).assert(request)
      expect(throwing.credentialId).toBe("cred-1")

      get.mockResolvedValueOnce(fakeAssertionCredential("cred-2"))
      const rejecting = await new BrowserPasskeyCeremony(timing, (() =>
        Promise.reject(new Error("telemetry down"))) as PasskeyRequestHook).assert(request)
      expect(rejecting.credentialId).toBe("cred-2")

      get.mockRejectedValueOnce(new DOMException("Dismissed", "NotAllowedError"))
      await expect(
        new BrowserPasskeyCeremony(timing, () => {
          throw new Error("telemetry down")
        }).assert(request),
      ).rejects.toThrow(/Dismissed/)
    })
  })

  describe("error predicates", () => {
    it("matches none of the ceremony's own failures on anything else", () => {
      for (const value of [
        new DOMException("the user cancelled", "AbortError"),
        new DOMException("Dismissed", "NotAllowedError"),
        new TypeError("x"),
        "Passkey assertion returned no credential",
        null,
        undefined,
        42,
        {
          get message(): never {
            throw new Error("no")
          },
        },
      ]) {
        expect(isWedgedTabError(value)).toBe(false)
        expect(isEvictedRequestError(value)).toBe(false)
        expect(isNoCredentialError(value)).toBe(false)
        expect(isUnsupportedAlgorithmError(value)).toBe(false)
      }
    })
  })
})

describe("BrowserPasskeyCeremony through a kept wrapper", () => {
  const get = vi.fn()
  const create = vi.fn()
  const keptGet = vi.fn()
  const keptCreate = vi.fn()
  const scope = globalThis as Record<string, unknown>
  const creation = {
    rpId: "localhost",
    rpName: "zk.money",
    userName: "@alice",
    prfFirstSalt: new Uint8Array(32),
  }

  /** Publishes the slot as the lock does: frozen, prototype-free, holding what is given. */
  const keep = (entries: Record<string, unknown>) => {
    Object.defineProperty(scope, KEPT_PASSKEY_API_KEY, {
      value: Object.freeze(Object.assign(Object.create(null), entries)),
      configurable: true,
    })
  }

  beforeEach(() => {
    for (const fn of [get, create, keptGet, keptCreate]) fn.mockReset()
    Object.defineProperty(navigator, "credentials", { value: { get, create }, configurable: true })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    keep({ get: keptGet, create: keptCreate })
  })
  afterEach(() => {
    delete scope[KEPT_PASSKEY_API_KEY]
  })

  it("sends an assertion to the kept get, as a method of navigator.credentials, with a deadline", async () => {
    keptGet.mockResolvedValueOnce(fakeAssertionCredential())
    const result = await new BrowserPasskeyCeremony(timing).assert(request)
    expect(result.credentialId).toBe("cred-1")
    expect(get).not.toHaveBeenCalled()
    expect(keptGet).toHaveBeenCalledTimes(1)
    expect(keptGet.mock.contexts[0]).toBe(navigator.credentials)
    const options = keptGet.mock.calls[0]![0] as CredentialRequestOptions
    expect(options.publicKey!.timeout).toBe(timing.requestTimeoutMs)
  })

  it("calls the kept function itself, not a call property a later script put on it", async () => {
    const hijack = vi.fn()
    Object.defineProperty(keptGet, "call", { value: hijack, configurable: true })
    keptGet.mockResolvedValueOnce(fakeAssertionCredential())
    expect((await new BrowserPasskeyCeremony(timing).assert(request)).credentialId).toBe("cred-1")
    expect(hijack).not.toHaveBeenCalled()
    expect(keptGet.mock.contexts[0]).toBe(navigator.credentials)
  })

  it("sends the browser's own get when nothing is kept, with no deadline", async () => {
    keep({})
    get.mockResolvedValueOnce(fakeAssertionCredential())
    await new BrowserPasskeyCeremony(timing).assert(request)
    expect(keptGet).not.toHaveBeenCalled()
    expect((get.mock.calls[0]![0] as CredentialRequestOptions).publicKey!.timeout).toBeUndefined()

    delete scope[KEPT_PASSKEY_API_KEY]
    get.mockResolvedValueOnce(fakeAssertionCredential())
    await new BrowserPasskeyCeremony(timing).assert(request)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("keeps an assertion hinted away from this device on the browser's own get", async () => {
    get.mockResolvedValue(fakeAssertionCredential())
    keptGet.mockResolvedValue(fakeAssertionCredential())
    const ceremony = new BrowserPasskeyCeremony(timing)

    await ceremony.assert({ ...request, hints: ["hybrid", "security-key"] })
    expect(keptGet).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]![0].publicKey.hints).toEqual(["hybrid", "security-key"])

    await ceremony.assert({ ...request, hints: ["client-device"] })
    expect(keptGet).toHaveBeenCalledTimes(1)
    await ceremony.assert({ ...request, hints: ["client-device", "security-key"] })
    expect(keptGet).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("sends a creation to the kept create only when the request allows an extension", async () => {
    const credential = { id: "cred-1" }
    keptCreate.mockResolvedValue(credential)
    create.mockResolvedValue(credential)
    const ceremony = new BrowserPasskeyCeremony(timing)

    // A credential without a usable key fails after the call: what matters is who was called.
    await expect(ceremony.create({ ...creation, extensionAllowed: true })).rejects.toThrow()
    expect(keptCreate).toHaveBeenCalledTimes(1)
    expect(keptCreate.mock.contexts[0]).toBe(navigator.credentials)
    expect(create).not.toHaveBeenCalled()
    const options = keptCreate.mock.calls[0]![0] as CredentialCreationOptions
    expect(options.publicKey!.timeout).toBe(timing.requestTimeoutMs)

    await expect(ceremony.create(creation)).rejects.toThrow()
    await expect(ceremony.create({ ...creation, extensionAllowed: false })).rejects.toThrow()
    expect(create).toHaveBeenCalledTimes(2)
    expect(keptCreate).toHaveBeenCalledTimes(1)
  })

  it("reads a kept answer like the browser's: user handle, flags and PRF", async () => {
    const credential = fakeAssertionCredential()
    const verified = new Uint8Array(37)
    verified[32] = 0x05
    keptGet.mockResolvedValueOnce({
      ...credential,
      getClientExtensionResults: () => ({
        prf: { results: { first: new Uint8Array(32).fill(7) } },
      }),
      response: {
        ...credential.response,
        authenticatorData: verified.buffer,
        userHandle: encodeUserHandle("alice").buffer,
      },
    })
    const result = await new BrowserPasskeyCeremony(timing).assert(request)
    expect(decodeUserHandle(result.userHandle)).toBe("alice")
    expect(result.userVerified).toBe(true)
    expect(result.prfFirst).toEqual(new Uint8Array(32).fill(7))
  })

  it("hands the caller's cancel back as the cancel, whatever the wrapper made of it", async () => {
    const controller = new AbortController()
    keptGet.mockImplementation(
      (options: CredentialRequestOptions) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(new DOMException("Operation failed", "NotAllowedError")),
          )
        }),
    )
    const asserting = new BrowserPasskeyCeremony(timing).assert({
      ...request,
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 5))
    controller.abort(CANCELLED)
    await expect(asserting).rejects.toThrow(CANCELLED.message)
  })

  it("names an evicted request as evicted when the wrapper reported its own refusal", async () => {
    keptGet.mockImplementationOnce(
      (options: CredentialRequestOptions) =>
        new Promise((_, reject) => {
          options.signal!.addEventListener("abort", () =>
            reject(new DOMException("Operation failed", "NotAllowedError")),
          )
        }),
    )
    keptGet.mockResolvedValueOnce(fakeAssertionCredential())
    const ceremony = new BrowserPasskeyCeremony(timing)
    const stuck = ceremony.assert(request).catch((e: unknown) => e)
    expect((await ceremony.assert(request)).credentialId).toBe("cred-1")
    expect(isEvictedRequestError(await stuck)).toBe(true)
  })

  it("tells request listeners which requests go to the kept wrapper", async () => {
    const heard: [boolean, boolean][] = []
    const off = onPasskeyRequest((active, kept) => heard.push([active, kept]))
    get.mockResolvedValue(fakeAssertionCredential())
    keptGet.mockResolvedValue(fakeAssertionCredential())
    create.mockRejectedValue(new DOMException("closed", "NotAllowedError"))
    const ceremony = new BrowserPasskeyCeremony(timing)
    await ceremony.assert(request)
    await ceremony.assert({ ...request, hints: ["hybrid", "security-key"] })
    await expect(ceremony.create(creation)).rejects.toThrow("closed")
    off()
    expect(heard).toEqual([
      [true, true],
      [false, false],
      [true, false],
      [false, false],
      [true, false],
      [false, false],
    ])
  })

  it("takes only an own function from the slot", async () => {
    get.mockResolvedValue(fakeAssertionCredential())
    const ceremony = new BrowserPasskeyCeremony(timing)
    keep({ get: "PASSKEY_GET" })
    await ceremony.assert(request)
    Object.defineProperty(scope, KEPT_PASSKEY_API_KEY, {
      value: Object.create({ get: keptGet }),
      configurable: true,
    })
    await ceremony.assert(request)
    expect(get).toHaveBeenCalledTimes(2)
    expect(keptGet).not.toHaveBeenCalled()
  })
})

describe("decodePrfSlot", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7)

  it("decodes each slot independently", () => {
    const results = { first: bytes(32).buffer, second: bytes(32) }
    expect(decodePrfSlot(results, "first")).toHaveLength(32)
    expect(decodePrfSlot(results, "second")).toHaveLength(32)
    expect(decodePrfSlot({ first: bytes(32) }, "second")).toBeUndefined()
    expect(decodePrfSlot(undefined, "first")).toBeUndefined()
  })

  it("treats any length but 32 bytes as an absent slot", () => {
    for (const n of [0, 1, 31, 33]) {
      expect(decodePrfSlot({ first: bytes(n), second: bytes(n) }, "first")).toBeUndefined()
      expect(decodePrfSlot({ first: bytes(n), second: bytes(n) }, "second")).toBeUndefined()
    }
  })

  it("reads a plain list of byte values, which is how 1Password's browser extension returns a slot", () => {
    const first = Array.from({ length: 32 }, (_, i) => i)
    const second = Array.from({ length: 32 }, (_, i) => 255 - i)
    expect(decodePrfSlot({ first, second }, "first")).toEqual(Uint8Array.from(first))
    expect(decodePrfSlot({ first, second }, "second")).toEqual(Uint8Array.from(second))
    expect(decodePrfSlot({ first: first.slice(1) }, "first")).toBeUndefined()
  })

  it("reads no key from anything that is not bytes, whatever length it claims", () => {
    const listOf = (entry: (i: number) => unknown) => Array.from({ length: 32 }, (_, i) => entry(i))
    const holes: unknown[] = []
    holes.length = 32
    for (const first of [
      32,
      "32",
      true,
      holes,
      listOf(() => null),
      listOf(() => "7"),
      listOf((i) => (i === 5 ? 256 : i)),
      listOf((i) => (i === 5 ? -1 : i)),
      listOf((i) => (i === 5 ? 1.5 : i)),
      { length: 32 },
      { ...listOf((i) => i) },
    ]) {
      expect(decodePrfSlot({ first }, "first")).toBeUndefined()
    }
  })

  it("reads the bytes behind a view, and a buffer or a view from another realm", () => {
    const source = Uint8Array.from({ length: 40 }, (_, i) => i)
    expect(decodePrfSlot({ first: new DataView(source.buffer, 4, 32) }, "first")).toEqual(
      source.subarray(4, 36),
    )
    const foreign = runInNewContext("new Uint8Array(32).fill(9)") as Uint8Array
    expect(foreign instanceof Uint8Array).toBe(false)
    const read = (slot: "first" | "second") =>
      decodePrfSlot({ first: foreign, second: foreign.buffer }, slot)
    expect(read("first")).toEqual(bytes(32).fill(9))
    expect(read("second")).toEqual(bytes(32).fill(9))
  })

  it("treats an explicit null as an absent slot, which is what a key with no PRF returns", () => {
    // The shape iOS reports for a fingerprint key: the slot is present and empty.
    expect(decodePrfSlot({ first: null, second: null }, "first")).toBeUndefined()
    expect(decodePrfSlot({ first: null }, "first")).toBeUndefined()
    expect(decodePrfSlot({ first: null, second: bytes(32) }, "second")).toHaveLength(32)
  })
})

describe("BrowserPasskeyCeremony create", () => {
  const create = vi.fn()
  /** The x||y point the last stub minted, so a recovered key can be checked against it. */
  let lastPoint: Uint8Array

  beforeEach(() => {
    create.mockReset()
    Object.defineProperty(navigator, "credentials", {
      value: { get: vi.fn(), create },
      configurable: true,
    })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  /** A credential whose response carries the extras a case needs (transports, or none). */
  /** A COSE EC2 key for a P-256 point, and a `none` attestation object wrapping an authData. */
  function coseP256(x: Uint8Array, y: Uint8Array): Uint8Array {
    // {1: 2, 3: -7, -1: 1, -2: x, -3: y}
    return new Uint8Array([
      0xa5,
      0x01,
      0x02,
      0x03,
      0x26,
      0x20,
      0x01,
      0x21,
      0x58,
      0x20,
      ...x,
      0x22,
      0x58,
      0x20,
      ...y,
    ])
  }
  function attestationOf(authData: Uint8Array): Uint8Array {
    // {"fmt": "none", "attStmt": {}, "authData": <bytes>} — authData placed last on purpose,
    // so a parser that assumes it comes first is caught.
    const fmt = [0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65]
    const attStmt = [0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74, 0xa0]
    const key = [0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61, 0x58, authData.length]
    return new Uint8Array([0xa3, ...fmt, ...attStmt, ...key, ...authData])
  }

  async function stubCreate(
    response: Record<string, unknown> = {},
    request: Record<string, unknown> = {},
    getClientExtensionResults: () => Record<string, unknown> = () => ({}),
    authenticator: { aaguidHex?: string; flags?: number; onRequest?: PasskeyRequestHook } = {},
  ) {
    const { p256 } = await import("@noble/curves/p256")
    const raw = p256.getPublicKey(p256.utils.randomPrivateKey(), false)
    const spkiHeader = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200")
    const spki = new Uint8Array(spkiHeader.length + raw.length)
    spki.set(spkiHeader)
    spki.set(raw, spkiHeader.length)
    // rpIdHash(32) + flags(1) + counter(4) + AAGUID(16) + id length(2) + id(1) + COSE key.
    const cose = coseP256(raw.slice(1, 33), raw.slice(33, 65))
    const authData = new Uint8Array(37 + 16 + 2 + 1 + cose.length)
    // By default attested credential data present, backup eligible, and the iCloud id.
    authData[32] = authenticator.flags ?? 0x40 | 0x08
    authData.set(hexToBytes(authenticator.aaguidHex ?? "fbfc3007154e4ecc8c0b6e020557d7bd"), 37)
    authData[54] = 1 // one-byte credential id
    authData[55] = 0xaa
    authData.set(cose, 56)
    create.mockResolvedValue({
      id: "cred-1",
      authenticatorAttachment: "cross-platform",
      getClientExtensionResults,
      response: {
        attestationObject: attestationOf(authData).buffer,
        getPublicKeyAlgorithm: () => -7,
        getPublicKey: () => spki.buffer,
        getAuthenticatorData: () => authData.buffer,
        ...response,
      },
    })
    lastPoint = raw.slice(1)
    return new BrowserPasskeyCeremony(timing, authenticator.onRequest).create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
      prfSecondSalt: new Uint8Array(32),
      ...request,
    })
  }

  it("writes the name and the request's provenance into user.id, and an unknown one without", async () => {
    const provenance: UserHandleProvenance = {
      context: "windows_key",
      osVersion: { major: 15, minor: 0, patch: 0 },
      chip: "x86",
    }
    await stubCreate({}, { provenance })
    const stamped = new Uint8Array(create.mock.calls.at(-1)![0].publicKey.user.id)
    expect(decodeUserHandle(stamped)).toBe("@alice")
    expect(decodeUserHandleProvenance(stamped)).toEqual(provenance)
    await stubCreate()
    const plain = new Uint8Array(create.mock.calls.at(-1)![0].publicKey.user.id)
    expect(decodeUserHandle(plain)).toBe("@alice")
    expect(decodeUserHandleProvenance(plain)).toEqual(UNKNOWN_PROVENANCE)
  })

  it("offers ES256 and nothing else, so no authenticator can mint a key the wallet refuses", async () => {
    await stubCreate()
    const sent = create.mock.calls.at(-1)![0].publicKey
    expect(sent.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }])
  })

  it("waits as long as the request says, and the default when it names no timeout", async () => {
    await stubCreate()
    expect(create.mock.calls.at(-1)![0].publicKey.timeout).toBe(timing.requestTimeoutMs)
    await stubCreate({}, { timeoutMs: 300_000 })
    expect(create.mock.calls.at(-1)![0].publicKey.timeout).toBe(300_000)
  })

  it("hands back the user handle it sent, so the passkey can be renamed later", async () => {
    const result = await stubCreate()
    const sent = create.mock.calls.at(-1)![0].publicKey.user.id
    expect(result.userHandle).toEqual(new Uint8Array(sent))
  })

  it("the caller's signal closes an issued creation sheet", async () => {
    const controller = new AbortController()
    create.mockImplementation(wedged())
    const creating = new BrowserPasskeyCeremony(timing).create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 5))
    controller.abort(CANCELLED)
    await expect(creating).rejects.toThrow(CANCELLED.message)
  })

  it("takes the key from the SPKI, and the browser's algorithm report does not get a veto", async () => {
    // A browser that cannot parse an attestation answers getPublicKeyAlgorithm() with a default
    // such as 0. The bytes decide, not the report.
    const result = await stubCreate({ getPublicKeyAlgorithm: () => 0 })
    expect(result.pubkey).toEqual(lastPoint)
  })

  it("decodes a creation the kept create answered as it does the browser's", async () => {
    const kept = vi.fn((options: CredentialCreationOptions) => create(options))
    Object.defineProperty(globalThis, KEPT_PASSKEY_API_KEY, {
      value: Object.freeze(Object.assign(Object.create(null), { create: kept })),
      configurable: true,
    })
    try {
      const { hook, phases } = listener()
      const written: string[] = []
      const result = await stubCreate(
        {},
        { extensionAllowed: true, onWritten: (id: string) => written.push(id) },
        () => ({ prf: { results: { first: new Uint8Array(32).fill(7) } } }),
        { onRequest: hook },
      )
      expect(kept).toHaveBeenCalledOnce()
      expect(kept.mock.contexts[0]).toBe(navigator.credentials)
      expect(result.credentialId).toBe("cred-1")
      expect(result.pubkey).toEqual(lastPoint)
      expect(result.prfFirst).toEqual(new Uint8Array(32).fill(7))
      expect(result.aaguid).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
      expect(written).toEqual(["cred-1"])
      expect(phases()).toEqual(["issued", "answered"])
    } finally {
      delete (globalThis as Record<string, unknown>)[KEPT_PASSKEY_API_KEY]
    }
  })

  it("recovers the key from the raw attestation when every accessor is missing or empty", async () => {
    const result = await stubCreate({
      getPublicKeyAlgorithm: () => 0,
      getPublicKey: () => null,
      getAuthenticatorData: undefined,
    })
    expect(result.pubkey).toEqual(lastPoint)
    // The provider id and backup flag come from the same raw authData.
    expect(result.aaguid).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
    expect(result.backupEligible).toBe(true)
  })

  it("refuses a key that is not P-256 by its bytes, naming what the browser reported", async () => {
    // A COSE key on another curve, and no SPKI to say otherwise.
    const notP256 = await (async () => {
      const bad = new Uint8Array([0xa4, 0x01, 0x02, 0x03, 0x26, 0x20, 0x02, 0x21, 0x40])
      const authData = new Uint8Array(37 + 16 + 2 + 1 + bad.length)
      authData[32] = 0x40 | 0x08
      authData.set(hexToBytes("fbfc3007154e4ecc8c0b6e020557d7bd"), 37)
      authData[54] = 1
      authData[55] = 0xaa
      authData.set(bad, 56)
      return authData
    })()
    const written: string[] = []
    const { hook, phases } = listener()
    const error = await stubCreate(
      {
        attestationObject: attestationOf(notP256).buffer,
        getPublicKeyAlgorithm: () => -257,
        getPublicKey: () => null,
        getAuthenticatorData: () => notP256.buffer,
      },
      { onWritten: (id: string) => void written.push(id) },
      undefined,
      { onRequest: hook },
    ).catch((e: unknown) => e)
    expect(isUnsupportedAlgorithmError(error)).toBe(true)
    // The hook hears the answer before the refusal.
    expect(phases()).toEqual(["issued", "answered"])
    expect((error as Error).message).toContain("-257")
    expect((error as Error).message).toContain("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
    // The authenticator saved the key before the wallet could refuse it.
    expect(passkeyWritten(error)).toBe(true)
    expect(written).toEqual(["cred-1"])
  })

  it("names an unreported algorithm and an unknown provider when nothing can be read", async () => {
    const empty = attestationOf(new Uint8Array(37)).buffer
    const error = await stubCreate({
      attestationObject: empty,
      getPublicKeyAlgorithm: undefined,
      getPublicKey: undefined,
      getAuthenticatorData: undefined,
    }).catch((e: unknown) => e)
    expect(isUnsupportedAlgorithmError(error)).toBe(true)
    expect((error as Error).message).toContain("unreported")
  })

  it("reads the manager id and the backup flag from the authenticator data", async () => {
    const result = await stubCreate()
    expect(result.aaguid).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
    expect(result.backupEligible).toBe(true)
    expect(result.authenticatorAttachment).toBe("cross-platform")
  })

  it("reads the user-verified flag, undefined when the flags do not parse", async () => {
    expect((await stubCreate()).userVerified).toBe(false)
    const verified = await stubCreate({}, {}, undefined, { flags: 0x40 | 0x08 | 0x04 })
    expect(verified.userVerified).toBe(true)
    const unreadable = await stubCreate({ getAuthenticatorData: () => new Uint8Array(20).buffer })
    expect(unreadable.userVerified).toBeUndefined()
  })

  it("keeps the attested id apart from the reported one: zeros stay, no attested data is undefined", async () => {
    expect((await stubCreate()).attestedAaguid).toBe("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
    const zeros = await stubCreate({}, {}, undefined, { aaguidHex: "0".repeat(32) })
    expect(zeros.aaguid).toBeUndefined()
    expect(zeros.attestedAaguid).toBe(ZERO_AAGUID)
    const unattested = await stubCreate({}, {}, undefined, { flags: 0x08 | 0x04 })
    expect(unattested.aaguid).toBeUndefined()
    expect(unattested.attestedAaguid).toBeUndefined()
  })

  it("passes the hints and the attachment filter through to the browser as given", async () => {
    // The driver decides these; this is the only place that proves what the browser receives.
    await stubCreate({}, { hints: ["client-device", "security-key"] })
    const sent = create.mock.calls.at(-1)![0].publicKey
    expect(sent.hints).toEqual(["client-device", "security-key"])
    expect(sent.authenticatorSelection.authenticatorAttachment).toBeUndefined()

    await stubCreate({}, { authenticatorAttachment: "cross-platform", hints: ["hybrid"] })
    const laptop = create.mock.calls.at(-1)![0].publicKey
    expect(laptop.hints).toEqual(["hybrid"])
    expect(laptop.authenticatorSelection.authenticatorAttachment).toBe("cross-platform")

    await stubCreate()
    const bare = create.mock.calls.at(-1)![0].publicKey
    expect(bare.hints).toBeUndefined()
    expect(bare.authenticatorSelection.authenticatorAttachment).toBeUndefined()
  })

  it("requires a stored passkey unless asked for a preference, and keeps UV required", async () => {
    await stubCreate()
    const required = create.mock.calls.at(-1)![0].publicKey.authenticatorSelection
    expect(required).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    })

    await stubCreate({}, { residentKey: "preferred" })
    const preferred = create.mock.calls.at(-1)![0].publicKey.authenticatorSelection
    expect(preferred).toMatchObject({
      residentKey: "preferred",
      requireResidentKey: false,
      userVerification: "required",
    })
  })

  it("asks whether the passkey was stored beside the PRF salts, and reports the answer", async () => {
    const stored = await stubCreate({}, {}, () => ({ credProps: { rk: true } }))
    const sent = create.mock.calls.at(-1)![0].publicKey.extensions
    expect(sent.credProps).toBe(true)
    expect(sent.prf.eval.first).toBeDefined()
    expect(stored.discoverable).toBe(true)

    const unstored = await stubCreate({}, {}, () => ({ credProps: { rk: false } }))
    expect(unstored.discoverable).toBe(false)

    // No answer, or one that is not a boolean, is not an answer.
    expect((await stubCreate()).discoverable).toBeUndefined()
    expect((await stubCreate({}, {}, () => ({ credProps: {} }))).discoverable).toBeUndefined()
    expect(
      (await stubCreate({}, {}, () => ({ credProps: { rk: 1 } }))).discoverable,
    ).toBeUndefined()
  })

  it.each([
    ["the list the browser gives", () => ["usb", "nfc"], ["usb", "nfc"]],
    // Not the same as no answer.
    ["an empty list", () => [], []],
    ["no answer for an absent getTransports", undefined, undefined],
    [
      "no answer for a throwing getTransports",
      () => {
        throw new Error("not implemented")
      },
      undefined,
    ],
  ])("reports %s", async (_, getTransports, transports) => {
    expect((await stubCreate({ getTransports })).transports).toEqual(transports)
  })

  describe("request hook", () => {
    const answeredEvidence = (heard: PasskeyRequestSignal[]) =>
      (
        heard.find((s) => s.phase === "answered") as Extract<
          PasskeyRequestSignal,
          { phase: "answered" }
        >
      ).evidence

    it("signals the call's own request, then coarse evidence of the answer", async () => {
      await stubCreate({ getTransports: () => ["usb", "nfc"] })
      const { heard, hook, phases } = listener()
      const asked = {
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      }
      await new BrowserPasskeyCeremony(timing, hook).create(asked)

      expect(phases()).toEqual(["issued", "answered"])
      expect(heard.every((s) => s.kind === "create" && s.request === asked)).toBe(true)
      const evidence = answeredEvidence(heard)
      expect(evidence).toEqual({
        authenticatorAttachment: "cross-platform",
        backupEligible: true,
        aaguid: APPLE_ICLOUD_AAGUID,
        transports: ["usb", "nfc"],
      })
      for (const key of Object.keys(evidence)) expect(EVIDENCE_KEYS).toContain(key)
    })

    it("reports an all-zero id as zeros, though the result carries none", async () => {
      const { heard, hook } = listener()
      await stubCreate({}, {}, undefined, { aaguidHex: "0".repeat(32), onRequest: hook })
      expect(answeredEvidence(heard).aaguid).toBe(ZERO_AAGUID)
    })

    it("has no id to report when the response carries no attested data", async () => {
      const { heard, hook } = listener()
      await stubCreate({}, {}, undefined, { flags: 0x08, onRequest: hook })
      expect(answeredEvidence(heard).aaguid).toBeUndefined()
    })

    it("answers from the raw attestation when an accessor throws, then throws that error", async () => {
      const { heard, hook, phases } = listener()
      const accessorError = new Error("authenticator data unavailable")
      const failing = stubCreate(
        {
          getAuthenticatorData: () => {
            throw accessorError
          },
        },
        {},
        undefined,
        { onRequest: hook },
      )
      await expect(failing).rejects.toBe(accessorError)
      expect(passkeyWritten(accessorError)).toBe(true)
      expect(phases()).toEqual(["issued", "answered"])
      expect(answeredEvidence(heard)).toMatchObject({
        backupEligible: true,
        aaguid: APPLE_ICLOUD_AAGUID,
      })
    })

    it("answers before extension results are read, then throws what they threw", async () => {
      const { heard, hook, phases } = listener()
      const extensionError = new Error("extensions unavailable")
      const failing = stubCreate(
        {},
        {},
        () => {
          throw extensionError
        },
        { onRequest: hook },
      )
      await expect(failing).rejects.toBe(extensionError)
      expect(passkeyWritten(extensionError)).toBe(true)
      expect(phases()).toEqual(["issued", "answered"])
      expect(providerSlugFor(answeredEvidence(heard).aaguid)).toBe("icloud_keychain")
    })

    it("never answers a creation the browser resolved empty", async () => {
      create.mockResolvedValue(null)
      const { hook, phases } = listener()
      const written: string[] = []
      const error = await new BrowserPasskeyCeremony(timing, hook)
        .create({
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@a",
          prfFirstSalt: new Uint8Array(32),
          onWritten: (id) => void written.push(id),
        })
        .catch((e: unknown) => e)
      expect(phases()).toEqual(["issued"])
      expect(isNoCredentialError(error)).toBe(true)
      expect(passkeyWritten(error)).toBe(false)
      expect(written).toEqual([])
    })
  })
})

describe("FakePasskeyCeremony request hook", () => {
  it("signals a call and its answer the way the browser ceremony does", async () => {
    const { heard, hook, phases } = listener()
    const fake = new FakePasskeyCeremony({
      onRequest: hook,
      aaguid: ZERO_AAGUID,
      route: "cross-device",
      transports: ["hybrid", "internal"],
    })
    const asked = {
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@alice",
      prfFirstSalt: new Uint8Array(32),
    }
    await fake.create(asked)
    await fake.assert({ rpId: "localhost", challenge: new Uint8Array(32) })

    expect(phases()).toEqual(["issued", "answered", "issued", "answered"])
    expect(heard[0]!.request).toBe(asked)
    expect(heard[1]).toMatchObject({
      phase: "answered",
      kind: "create",
      request: asked,
      evidence: {
        authenticatorAttachment: "cross-platform",
        backupEligible: true,
        aaguid: ZERO_AAGUID,
        transports: ["hybrid", "internal"],
      },
    })
    expect(heard[3]).toMatchObject({
      kind: "assert",
      evidence: { authenticatorAttachment: "cross-platform", backupEligible: true },
    })
  })

  it("signals only the issue when the call rejects", async () => {
    const { hook, phases } = listener()
    const fake = new FakePasskeyCeremony({ onRequest: hook })
    await fake.create({
      rpId: "localhost",
      rpName: "zk.money",
      userName: "@a",
      prfFirstSalt: new Uint8Array(32),
    })
    fake.opts.assertOverride = () => {
      throw new DOMException("Dismissed", "NotAllowedError")
    }
    await expect(fake.assert({ rpId: "localhost", challenge: new Uint8Array(32) })).rejects.toThrow(
      /Dismissed/,
    )
    expect(phases()).toEqual(["issued", "answered", "issued"])
  })
})

describe("requestHeldMs and isBlockedPromptError", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [40, true],
    [BLOCKED_PROMPT_MS, false],
    [5_000, false],
  ])(
    "times a rejection from the request's issue, not from the wait for focus before it (%i ms)",
    async (heldMs, blocked) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
      const dismissed = new DOMException("not allowed", "NotAllowedError")
      const create = vi.fn(async () => {
        vi.setSystemTime(Date.now() + heldMs)
        throw dismissed
      })
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: { create, get: vi.fn() },
      })
      const result = new BrowserPasskeyCeremony({ ...timing, focusWaitMs: 5_000 })
        .create({
          rpId: "localhost",
          rpName: "zk.money",
          userName: "alice",
          prfFirstSalt: new Uint8Array(32),
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await result).toBe(dismissed)
      expect(requestHeldMs(dismissed)).toBe(heldMs)
      expect(isBlockedPromptError(dismissed)).toBe(blocked)
    },
  )

  it("knows nothing of an error no request threw", () => {
    expect(requestHeldMs(new DOMException("not allowed", "NotAllowedError"))).toBeUndefined()
    expect(requestHeldMs("NotAllowedError")).toBeUndefined()
    expect(requestHeldMs(undefined)).toBeUndefined()
    expect(isBlockedPromptError(new DOMException("not allowed", "NotAllowedError"))).toBe(false)
  })

  it("reads a recorded hold from the error or its cause, for a NotAllowedError alone", () => {
    const fast = new DOMException("not allowed", "NotAllowedError")
    recordRequestHeld(fast, 200)
    expect(requestHeldMs(fast)).toBe(200)
    expect(isBlockedPromptError(fast)).toBe(true)
    const aborted = new DOMException("aborted", "AbortError")
    recordRequestHeld(aborted, 40)
    expect(isBlockedPromptError(aborted)).toBe(false)
    const wrapped = Object.assign(new Error("wrapped"), { name: "NotAllowedError", cause: fast })
    expect(isBlockedPromptError(wrapped)).toBe(true)
    recordRequestHeld("NotAllowedError", 40)
    expect(requestHeldMs("NotAllowedError")).toBeUndefined()
    expect(isBlockedPromptError("NotAllowedError")).toBe(false)
  })
})

describe("related-origin failures", () => {
  it.each(["create", "assert"] as const)(
    "explains %s rejection without changing RP",
    async (operation) => {
      const browserError = new DOMException("RP not authorized", "SecurityError")
      const browserRequest = vi.fn().mockRejectedValue(browserError)
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: { create: browserRequest, get: browserRequest },
      })
      vi.spyOn(document, "hasFocus").mockReturnValue(true)
      const ceremony = new BrowserPasskeyCeremony(timing)
      const result =
        operation === "create"
          ? ceremony.create({
              rpId: "auth.zk.money",
              rpName: "zk.money",
              userName: "alice",
              prfFirstSalt: new Uint8Array(32),
            })
          : ceremony.assert({ rpId: "auth.zk.money", challenge: new Uint8Array(32) })
      const error = (await result.then(
        () => undefined,
        (e: unknown) => e,
      )) as Error
      expect(error.name).toBe("RelatedOriginPasskeyError")
      expect(error.cause).toBe(browserError)
      expect(browserRequest).toHaveBeenCalledTimes(1)
      const options = browserRequest.mock.calls[0]![0].publicKey
      expect(operation === "create" ? options.rp.id : options.rpId).toBe("auth.zk.money")
    },
  )
})

describe("extension refusals", () => {
  const bitwardenRefusal = () => new Error("'rp.id' cannot be used with the current origin")

  async function rejection(operation: "create" | "assert", rpId: string, browserError: Error) {
    const browserRequest = vi.fn().mockRejectedValue(browserError)
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { create: browserRequest, get: browserRequest },
    })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    const ceremony = new BrowserPasskeyCeremony(timing)
    const result =
      operation === "create"
        ? ceremony.create({
            rpId,
            rpName: "zk.money",
            userName: "alice",
            prfFirstSalt: new Uint8Array(32),
          })
        : ceremony.assert({ rpId, challenge: new Uint8Array(32) })
    return result.then(
      () => undefined,
      (error: unknown) => error,
    )
  }

  it("classifies Bitwarden's assert refusal on a related origin", async () => {
    const error = await rejection("assert", "auth.zk.money", bitwardenRefusal())
    expect(error).toMatchObject({ name: "RelatedOriginPasskeyError", bitwarden: true })
    const other = new DOMException("RP not authorized", "SecurityError")
    expect(await rejection("assert", "auth.zk.money", other)).toMatchObject({ bitwarden: false })
  })

  it("keeps Bitwarden's assert refusal on the same RP", async () => {
    const browserError = bitwardenRefusal()
    expect(await rejection("assert", "localhost", browserError)).toBe(browserError)
  })

  it("keeps an unrelated assert failure on a related origin", async () => {
    const browserError = new Error("some other failure")
    expect(await rejection("assert", "auth.zk.money", browserError)).toBe(browserError)
  })

  describe("on an iOS below the floor", () => {
    const iphone = (version: string) =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 ` +
      "(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
    const extensionCopy = new RelatedOriginPasskeyError().message
    const nativeUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    const claim = (userAgent: string) =>
      Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true })

    afterEach(() => {
      Object.defineProperty(navigator, "userAgent", nativeUserAgent)
    })

    it.each(["create", "assert"] as const)(
      "says %s needs a newer iOS and keeps the browser's error",
      async (operation) => {
        claim(iphone("16_7"))
        const browserError = new DOMException("RP not authorized", "SecurityError")
        const error = (await rejection(operation, "auth.zk.money", browserError)) as Error
        expect(error).toBeInstanceOf(RelatedOriginPasskeyError)
        expect(error.message).toBe(IOS_FLOOR_COPY)
        expect(error.cause).toBe(browserError)
      },
    )

    it.each([
      ["iOS 18.3.1", iphone("18_3_1"), IOS_FLOOR_COPY],
      ["an iPhone with no version", "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15", extensionCopy],
      [
        "an iPad on iOS 16",
        "Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
          "Version/16.6 Mobile/15E148 Safari/604.1",
        IOS_FLOOR_COPY,
      ],
      [
        "an iPad asking for the desktop site",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
          "Version/16.6 Safari/605.1.15",
        extensionCopy,
      ],
      [
        "an in-app browser on iOS 16",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0.0",
        IOS_FLOOR_COPY,
      ],
    ])("picks the wording for %s", async (_, userAgent, copy) => {
      claim(userAgent)
      const browserError = new DOMException("RP not authorized", "SecurityError")
      const error = (await rejection("assert", "auth.zk.money", browserError)) as Error
      expect(error.message).toBe(copy)
    })

    it("keeps a SecurityError on the same RP", async () => {
      claim(iphone("16_7"))
      const thrown = new DOMException("RP not authorized", "SecurityError")
      expect(await rejection("assert", "localhost", thrown)).toBe(thrown)
    })
  })

  const notAllowedMessage = "The operation either timed out or was not allowed."

  it.each(["localhost", "auth.zk.money"])(
    "reports Bitwarden's assert rejection on %s as a closed prompt",
    async (rpId) => {
      expect(
        isPasskeyCancelled(await rejection("assert", rpId, new Error(notAllowedMessage))),
      ).toBe(true)
    },
  )

  it.each([
    ["a browser NotAllowedError", () => new DOMException(notAllowedMessage, "NotAllowedError")],
    ["a TypeError with the same message", () => new TypeError(notAllowedMessage)],
    ["a plain Error with a longer message", () => new Error(`${notAllowedMessage} Try again.`)],
  ])("keeps %s", async (_, browserError) => {
    const thrown = browserError()
    expect(await rejection("assert", "localhost", thrown)).toBe(thrown)
  })

  it("a first prompt's own rejection is passed through unmarked: nothing was saved", async () => {
    const thrown = new DOMException("Dismissed", "NotAllowedError")
    const error = await rejection("create", "localhost", thrown)
    expect(error).toBe(thrown)
    expect(passkeyWritten(error)).toBe(false)
  })
})

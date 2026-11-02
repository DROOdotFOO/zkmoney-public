/**
 * The wallet's passkey tracker: what it sends through the consent-gated events path, how it reads
 * the wallet's own errors, and which proving flow a signature is reported under.
 */
import { type PasskeyRequestHook, parseUserAgent } from "@obsidion/passkey-web"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { FakePasskeyCeremony, MemoryStorage } from "../support/fakePasskeyCeremony"

vi.setConfig({ testTimeout: 30_000 })

const API = "http://api.test"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const CREATE = {
  rpId: "localhost",
  rpName: "test",
  userName: "@alice",
  prfFirstSalt: new Uint8Array(32),
}
const ASSERT = { rpId: "localhost", challenge: new Uint8Array(32) }

let fetchSpy: MockInstance<typeof fetch>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("VITE_ZKMONEY_API_URL", API)
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
})

afterEach(() => {
  fetchSpy.mockRestore()
  vi.unstubAllEnvs()
})

/** Fresh modules, with the consent answer given. */
async function load(consent = true) {
  const analytics = await import("../../src/lib/analytics")
  analytics.bindAnalyticsConsent(() => consent)
  return import("../../src/lib/passkeyTelemetry")
}

/** Every `passkey_ceremony` body posted so far. */
const posted = () =>
  fetchSpy.mock.calls
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }))
    .filter(({ body }) => body.event === "passkey_ceremony")
const props = () => posted().map(({ body }) => body.props)

/** A fake authenticator the tracker hears, holding one credential made outside any attempt. */
async function authenticator(hook: PasskeyRequestHook) {
  const inner = new FakePasskeyCeremony({ onRequest: hook })
  const created = await inner.create(CREATE)
  return { inner, created }
}

describe("sending", () => {
  it("sends one attempt through the events path once analytics is allowed", async () => {
    const { passkeyTelemetry } = await load(true)
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    const ceremony = passkeyTelemetry.wrap(inner)
    await passkeyTelemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      ceremony.assert(ASSERT),
    )

    expect(posted()).toHaveLength(1)
    const [{ url, body }] = posted()
    expect(url).toBe(`${API}/events`)
    expect(body).toMatchObject({ platform: "web", session_id: expect.stringMatching(UUID) })
    expect(body.props).toMatchObject({
      ceremony: "sign_in",
      flow: "enter",
      outcome: "succeeded",
      prompts: "1",
      attempt: "1",
    })
  })

  it("sends nothing without consent", async () => {
    const { passkeyTelemetry } = await load(false)
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    const ceremony = passkeyTelemetry.wrap(inner)
    await passkeyTelemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      ceremony.assert(ASSERT),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(["onboarding"] as const)(
    "sends a %s result with no id, no viewport and no cookie, whatever the consent answer is",
    async (flow) => {
      for (const consent of [true, false]) {
        fetchSpy.mockClear()
        const { passkeyTelemetry } = await load(consent)
        const { inner } = await authenticator(passkeyTelemetry.requestHook)
        const ceremony = passkeyTelemetry.wrap(inner)
        await passkeyTelemetry.track({ ceremony: "create", flow }, () => ceremony.create(CREATE))

        expect(posted()).toHaveLength(1)
        const [{ url, body }] = posted()
        expect(url).toBe(`${API}/events`)
        expect(body).toEqual({
          event: "passkey_ceremony",
          platform: "web-signup",
          app_version: "dev",
          props: expect.objectContaining({ ceremony: "create", flow, outcome: "succeeded" }),
        })
        expect(body.props).not.toHaveProperty("viewport")
        const [, init] = fetchSpy.mock.calls.find(([, i]) =>
          String(i?.body).includes("passkey_ceremony"),
        )!
        expect(init?.credentials).toBe("omit")
      }
    },
  )

  it("names where the passkey was made, as the handle the wallet wrote claims", async () => {
    const { passkeyTelemetry } = await load(true)
    const { WebAlphaAuthService } = await import("../../src/platform/auth/WebAlphaAuthService")
    const fake = new FakePasskeyCeremony({
      route: "cross-device",
      onRequest: passkeyTelemetry.requestHook,
    })
    const mac = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform: "macOS", brands: [] },
    })
    const storage = new MemoryStorage()
    const service = (ceremony: typeof fake | ReturnType<typeof passkeyTelemetry.wrap>) =>
      new WebAlphaAuthService({
        storage,
        rpId: "localhost",
        ceremony,
        posture: () => "laptop",
        userAgent: () => Promise.resolve(mac),
      })
    // Made on the bare fake, so only the sign-in is counted.
    await service(fake).createPasskey("@alice")
    await passkeyTelemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      service(passkeyTelemetry.wrap(fake)).recoverPasskey({ discover: true }),
    )
    expect(props()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", outcome: "succeeded", made_on: "mac_qr" }),
    ])
  })
})

describe("the wallet's own errors", () => {
  it("reads each by its name, and rethrows it unchanged", async () => {
    const { passkeyTelemetry } = await load()
    const { PasskeyEnvelopeError, StoredAddressMismatchError } = await import(
      "@obsidion/front-core"
    )
    const { PasskeyMismatchError } = await import("../../src/features/onboarding/oxideOnboarding")
    const { HintedKeyMismatchError } = await import("../../src/platform/auth/WebAlphaAuthService")
    const { SignerKeyMismatchError } = await import("../../src/platform/auth/webauthnSigning")
    const { NoPasskeySessionError, SessionChangedError } = await import(
      "../../src/platform/auth/sessionErrors"
    )
    const { GateCancelledError } = await import("../../src/features/identity/ceremonyGate")
    const cases: [Error, string, string][] = [
      [new PasskeyMismatchError(), "refused", "passkey_mismatch"],
      [new HintedKeyMismatchError(), "refused", "passkey_mismatch"],
      [new StoredAddressMismatchError(), "refused", "passkey_mismatch"],
      [new SignerKeyMismatchError(), "failed", "signer_mismatch"],
      [new PasskeyEnvelopeError("decrypt"), "failed", "backup_envelope"],
      [new NoPasskeySessionError(), "failed", "session_lost"],
      [new SessionChangedError(), "failed", "session_lost"],
      [new GateCancelledError(), "cancelled", "in_app_cancel"],
    ]
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    const ceremony = passkeyTelemetry.wrap(inner)
    for (const [error] of cases) {
      const run = passkeyTelemetry.track({ ceremony: "unlock", flow: "unlock" }, async () => {
        await ceremony.assert(ASSERT)
        throw error
      })
      await expect(run).rejects.toBe(error)
    }
    expect(props()).toEqual(
      cases.map(([, outcome, reason]) =>
        expect.objectContaining({ outcome, reason, prompts: "1" }),
      ),
    )
    // A failed row names the thrown value only as far as the vocabulary lists it.
    for (const [index, [, outcome]] of cases.entries()) {
      if (outcome === "failed") expect(props()[index]).toMatchObject({ error_name: "other" })
      else expect(props()[index]).not.toHaveProperty("error_name")
    }
  })

  it("reads the recovery's answer from a passkey it did not ask for as a mismatch", async () => {
    const { passkeyTelemetry } = await load()
    const { WebAlphaAuthService } = await import("../../src/platform/auth/WebAlphaAuthService")
    const fake = new FakePasskeyCeremony({
      route: "cross-device",
      onRequest: passkeyTelemetry.requestHook,
    })
    const storage = new MemoryStorage()
    const service = (ceremony: typeof fake | ReturnType<typeof passkeyTelemetry.wrap>) =>
      new WebAlphaAuthService({ storage, rpId: "localhost", ceremony, posture: () => "laptop" })
    // Set up on the bare fake, so nothing of it is counted.
    const setup = service(fake)
    const created = await setup.createPasskey("@alice")
    await setup.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
      transports: created.transports,
    })
    const other = await fake.create({ ...CREATE, userName: "@bob" })
    fake.opts.assertOverride = () => other.credentialId

    const failure = await passkeyTelemetry
      .track({ ceremony: "sign_in", flow: "enter" }, () =>
        service(passkeyTelemetry.wrap(fake)).beginRecovery(created.credentialId),
      )
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: "passkey.unasked" })
    expect(props()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch", prompts: "1" }),
    ])
  })

  it("counts a sign-in's second request in the same attempt", async () => {
    const { passkeyTelemetry } = await load()
    const { WebAlphaAuthService } = await import("../../src/platform/auth/WebAlphaAuthService")
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    inner.opts.route = "cross-device"
    // A browser with no record of the passkey: its key is settled by a second assertion.
    const service = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony: passkeyTelemetry.wrap(inner),
      posture: () => "laptop",
    })
    await passkeyTelemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      service.recoverPasskey({ discover: true }),
    )
    expect(inner.asserts).toHaveLength(2)
    expect(props()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", outcome: "succeeded", prompts: "2+" }),
    ])
  })
})

describe("the browser's error name", () => {
  it("names a failed row's error, listed or other, and never carries its text", async () => {
    const { passkeyTelemetry } = await load()
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    const ceremony = passkeyTelemetry.wrap(inner)
    const errors = [
      new DOMException(
        "An unknown error occurred while talking to the credential manager.",
        "NotReadableError",
      ),
      Object.assign(new Error("wrong key for 0x1234abcd"), { name: "0x1234abcd@alice" }),
    ]
    for (const error of errors) {
      const run = passkeyTelemetry.track({ ceremony: "unlock", flow: "unlock" }, async () => {
        await ceremony.assert(ASSERT)
        throw error
      })
      await expect(run).rejects.toBe(error)
    }
    expect(props().map((p) => [p.outcome, p.reason, p.error_name])).toEqual([
      ["failed", "after_prompt", "NotReadableError"],
      ["failed", "after_prompt", "other"],
    ])
    const wire = JSON.stringify(posted())
    expect(wire).not.toContain("credential manager")
    expect(wire).not.toContain("0x1234abcd")
  })
})

describe("the phone's platform-authenticator answer", () => {
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"

  /** One sign-in on a tracker created under the current user agent, once its reads have settled. */
  async function signIn() {
    const { passkeyTelemetry } = await load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const { inner } = await authenticator(passkeyTelemetry.requestHook)
    const ceremony = passkeyTelemetry.wrap(inner)
    await passkeyTelemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      ceremony.assert(ASSERT),
    )
  }

  it("never reaches a laptop's rows", async () => {
    await signIn()
    expect(props()).toEqual([expect.objectContaining({ device_class: "laptop" })])
    expect(props()[0]).not.toHaveProperty("platform_authenticator")
  })

  it("rides with the error name on a signup row, on the identifier-free channel", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID)
    try {
      const { passkeyTelemetry } = await load(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const { inner } = await authenticator(passkeyTelemetry.requestHook)
      const ceremony = passkeyTelemetry.wrap(inner)
      const error = new DOMException("credential manager failed", "NotReadableError")
      const run = passkeyTelemetry.track({ ceremony: "create", flow: "onboarding" }, async () => {
        await ceremony.create(CREATE)
        throw error
      })
      await expect(run).rejects.toBe(error)
    } finally {
      ua.mockRestore()
    }
    expect(posted()).toHaveLength(1)
    const [{ body }] = posted()
    expect(body.platform).toBe("web-signup")
    expect(body).not.toHaveProperty("session_id")
    expect(body.props).toMatchObject({
      outcome: "failed",
      reason: "after_prompt",
      error_name: "NotReadableError",
      platform_authenticator: "unknown",
    })
  })
})

describe("the flow a signature belongs to", () => {
  it("is the newest proving screen holding an attempt, and other once none is", async () => {
    const { passkeyTelemetry } = await load()
    const { useProvingOutcome } = await import("../../src/ui/hooks")
    const { makeWebauthnSignFn } = await import("../../src/platform/auth/webauthnSigning")
    const outcomes: Record<string, ReturnType<typeof useProvingOutcome>> = {}
    const Probe = ({ flow }: { flow: string }) => {
      outcomes[flow] = useProvingOutcome(flow)
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    const flows = ["send", "withdraw", "migration"]
    act(() => root.render(flows.map((flow) => createElement(Probe, { key: flow, flow }))))

    const { inner, created } = await authenticator(passkeyTelemetry.requestHook)
    const sign = makeWebauthnSignFn(
      passkeyTelemetry.wrap(inner),
      "localhost",
      created.credentialId,
      created.pubkey,
    )
    const signOnce = () => sign(Buffer.alloc(32, 7))

    outcomes.send.start("proving")
    await signOnce()
    outcomes.withdraw.start("proving")
    await signOnce()
    // Another screen letting go leaves the first one's flow in place.
    outcomes.withdraw.finish()
    await signOnce()
    outcomes.send.finish()
    await signOnce()
    // A flow outside the vocabulary is reported as other.
    outcomes.migration.start("proving")
    await signOnce()
    outcomes.migration.cancel()
    outcomes.send.start("proving")
    act(() => root.unmount())
    await signOnce()

    expect(props().map((event) => [event.ceremony, event.flow])).toEqual([
      ["approve_tx", "send"],
      ["approve_tx", "withdraw"],
      ["approve_tx", "send"],
      ["approve_tx", "other"],
      ["approve_tx", "other"],
      ["approve_tx", "other"],
    ])
  })

  // The claim that holds the signup flow drives its own signature, so its coverage lives with it,
  // in registrationClaimBurn.test.ts.
})

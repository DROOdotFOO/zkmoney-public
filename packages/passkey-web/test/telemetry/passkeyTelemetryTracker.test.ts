// @vitest-environment jsdom
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID, ZERO_AAGUID } from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToHex, hexToBytes } from "../../src/ceremony/bytes.js"
import { NATIVE_LOCK_KEY } from "../../src/ceremony/nativeLock.js"
import { NATIVE_CREATE, NATIVE_GET, installCredentials } from "../support/extensionWrappers.js"
import { type UserHandleProvenance, encodeUserHandle } from "../../src/ceremony/userHandle.js"
import {
  BrowserPasskeyCeremony,
  type CeremonyTiming,
  type PasskeyAnswerEvidence,
  type PasskeyAssertRequest,
  type PasskeyAssertResult,
  type PasskeyCeremony,
  type PasskeyCreateRequest,
  type PasskeyRequestHook,
  type PasskeyRequestSignal,
} from "../../src/ceremony/passkeyCeremony.js"
import { runPasskeyAssertion, runPasskeyCreation } from "../../src/drivers.js"
import { UnsupportedProviderError } from "../../src/refusals/passkeyErrors.js"
import {
  type PasskeyAttemptContext,
  type PasskeyCeremonyProps,
  type PasskeyTelemetryEnvironment,
  type PasskeyTelemetryOptions,
  createPasskeyTelemetry,
} from "../../src/telemetry/passkeyTelemetryTracker.js"
import {
  PASSKEY_CEREMONY_ENUM_PROPS,
  PASSKEY_CEREMONY_INTEGER_PROPS,
  PASSKEY_MAJOR_MAX,
  PASSKEY_MAJOR_MIN,
  type PasskeyPlatformAuthenticator,
} from "../../src/telemetry/passkeyTelemetryVocabulary.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"
import { FakePasskeyCeremony } from "../support/fakePasskeyCeremony.js"

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"

/** What Client Hints add once the async read resolves. */
const HINTED_MAC: PasskeyTelemetryEnvironment = {
  posture: "laptop",
  userAgent: parseUserAgent({
    userAgent: CHROME_MAC,
    userAgentData: { platform: "macOS", platformVersion: "15.1.0" },
  }),
}
const HINTED_MAC_PROPS = {
  device_class: "laptop",
  os: "macos",
  os_major: 15,
  browser: "chrome",
  browser_major: 140,
}

/** Every object any tracker in this file sent through the default harness. */
const everySent: PasskeyCeremonyProps[] = []

function harness(options: Partial<PasskeyTelemetryOptions> = {}) {
  let time = 0
  const sent: PasskeyCeremonyProps[] = []
  const pageHideTarget = new EventTarget()
  const telemetry = createPasskeyTelemetry({
    send: (props) => {
      sent.push(props)
      everySent.push(props)
    },
    now: () => time,
    environment: () => Promise.resolve(HINTED_MAC),
    syncEnvironment: () => ({
      posture: "laptop",
      userAgent: parseUserAgent({ userAgent: CHROME_MAC }),
    }),
    pageHideTarget,
    // Rows here are compared whole; the extension and lock reads are exercised by their own tests below.
    extension: () => undefined as never,
    nativeLock: () => undefined,
    ...options,
  })
  return {
    telemetry,
    sent,
    advance: (ms: number) => void (time += ms),
    pageHide: () => pageHideTarget.dispatchEvent(new Event("pagehide")),
  }
}

type Step = {
  /** Holds the call after it issues, until this settles. */
  hold?: Promise<unknown>
  /** How long the request takes on the tracker's clock. */
  takes?: number
  answer?: PasskeyAnswerEvidence
  /** Thrown after the answer, or with no answer. */
  error?: unknown
  credentialId?: string
  /** Returned with an assertion's result, as the passkey's user handle. */
  userHandle?: Uint8Array
}

/** Each call signals `issued`, then plays the next step. */
function scripted(hook: PasskeyRequestHook, advance: (ms: number) => void, steps: Step[]) {
  async function play(kind: "create" | "assert", request: object): Promise<never> {
    const step = steps.shift() ?? {}
    hook({ phase: "issued", kind, request } as PasskeyRequestSignal)
    await step.hold
    advance(step.takes ?? 0)
    if (step.answer) {
      hook({ phase: "answered", kind, request, evidence: step.answer } as PasskeyRequestSignal)
    }
    if (step.error !== undefined) throw step.error
    return {
      credentialId: step.credentialId ?? "cred-1",
      pubkey: new Uint8Array(64),
      ...(step.userHandle ? { userHandle: step.userHandle } : {}),
    } as never
  }
  return {
    create: (request) => play("create", request),
    assert: (request) => play("assert", request),
  } satisfies PasskeyCeremony
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const createRequest = (): PasskeyCreateRequest => ({
  rpId: "localhost",
  rpName: "zk.money",
  userName: "@alice",
  prfFirstSalt: new Uint8Array(32),
})
const assertRequest = (over: Partial<PasskeyAssertRequest> = {}): PasskeyAssertRequest => ({
  rpId: "localhost",
  challenge: new Uint8Array(32),
  ...over,
})

/** A phone over QR answering a creation, and this device answering an assertion. */
const QR_CREATE: PasskeyAnswerEvidence = {
  authenticatorAttachment: "cross-platform",
  backupEligible: true,
  aaguid: APPLE_ICLOUD_AAGUID,
  transports: ["hybrid", "internal"],
}
const LOCAL_ASSERT: PasskeyAnswerEvidence = {
  authenticatorAttachment: "platform",
  backupEligible: false,
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

afterEach(() => {
  for (const props of everySent.splice(0)) {
    for (const [key, value] of Object.entries(props)) {
      if ((PASSKEY_CEREMONY_INTEGER_PROPS as readonly string[]).includes(key)) {
        expect(Number.isInteger(value), key).toBe(true)
        expect(value as number).toBeGreaterThanOrEqual(PASSKEY_MAJOR_MIN)
        expect(value as number).toBeLessThanOrEqual(PASSKEY_MAJOR_MAX)
        continue
      }
      expect(Object.keys(PASSKEY_CEREMONY_ENUM_PROPS), key).toContain(key)
      const listed = PASSKEY_CEREMONY_ENUM_PROPS[key as keyof typeof PASSKEY_CEREMONY_ENUM_PROPS]
      expect(listed as readonly unknown[], key).toContain(value)
    }
  }
})

describe("wrap", () => {
  it("hands the inner ceremony a fresh copy per call and passes its answer back untouched", async () => {
    const { telemetry } = harness()
    const seen: object[] = []
    const answer = { credentialId: "cred-1" } as PasskeyAssertResult
    const failure = new DOMException("Dismissed", "NotAllowedError")
    const inner: PasskeyCeremony = {
      create: () => Promise.reject(failure),
      assert: (request) => {
        seen.push(request)
        return Promise.resolve(answer)
      },
    }
    const wrapped = telemetry.wrap(inner)
    const signal = new AbortController().signal
    const request = assertRequest({ credentialIds: ["cred-1"], signal })

    expect(await wrapped.assert(request)).toBe(answer)
    expect(await wrapped.assert(request)).toBe(answer)
    expect(seen[0]).not.toBe(request)
    expect(seen[1]).not.toBe(seen[0])
    expect(seen[0]).toEqual(request)
    expect((seen[0] as PasskeyAssertRequest).signal).toBe(signal)
    expect(await caught(wrapped.create(createRequest()))).toBe(failure)
  })

  it("counts a call that never reached the browser as no prompt", async () => {
    const h = harness()
    const quiet = h.telemetry.wrap(new FakePasskeyCeremony({ aaguid: APPLE_ICLOUD_AAGUID }))
    const refusal = new UnsupportedProviderError("manager")
    const error = await caught(
      h.telemetry.track({ ceremony: "create" }, async () => {
        await quiet.create(createRequest())
        throw refusal
      }),
    )
    expect(error).toBe(refusal)
    expect(h.sent).toEqual([
      {
        ceremony: "create",
        outcome: "refused",
        reason: "provider_not_supported",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        ...HINTED_MAC_PROPS,
      },
    ])
  })
})

describe("one event per attempt", () => {
  it("describes a created passkey", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
      route: "cross-device",
      transports: ["hybrid", "internal"],
    })
    const ceremony = h.telemetry.wrap(fake)
    await Promise.resolve()

    const created = await h.telemetry.track({ ceremony: "create", flow: "onboarding" }, () =>
      ceremony.create(createRequest()),
    )

    expect(h.sent).toEqual([
      {
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        provider: "icloud_keychain",
        credential_created: "yes",
        backup_eligible: "yes",
        route: "phone_qr",
        prompts: "1",
        attempt: "1",
        elapsed: "under_1s",
        ...HINTED_MAC_PROPS,
      },
    ])
    const serialized = JSON.stringify(h.sent)
    for (const secret of [
      APPLE_ICLOUD_AAGUID,
      APPLE_ICLOUD_AAGUID.replace(/-/g, ""),
      created.credentialId,
      bytesToHex(created.pubkey),
      bytesToHex(created.prfFirst!),
      CHROME_MAC,
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("keeps a created credential when the chained assertion is cancelled", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
      route: "cross-device",
      prfAtCreate: false,
      assertOverride: () => {
        throw new DOMException("Dismissed", "NotAllowedError")
      },
    })
    const ceremony = h.telemetry.wrap(fake)
    const creating = h.telemetry.track({ ceremony: "create" }, () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      }),
    )
    await expect(creating).rejects.toThrow(/Dismissed/)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      ceremony: "create",
      outcome: "cancelled",
      reason: "prompt_closed",
      provider: "icloud_keychain",
      credential_created: "yes",
      prompts: "2+",
    })
  })

  it("marks a creation the browser refused as not created", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("insecure", "SecurityError") },
      ]),
    )
    await caught(h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())))
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "security_error",
        provider: "unknown",
        credential_created: "no",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("takes the route from the first answer and the duration from the last request", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { takes: 20_000, answer: QR_CREATE },
        { takes: 2_000, answer: LOCAL_ASSERT },
      ]),
    )
    await h.telemetry.track({ ceremony: "create" }, async () => {
      await ceremony.create(createRequest())
      h.advance(5_000)
      return ceremony.assert(assertRequest())
    })
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        route: "phone_qr",
        backup_eligible: "yes",
        prompts: "2+",
        elapsed: "1_10s",
      }),
    ])
  })

  it("classifies what a run throws, and throws it unchanged", async () => {
    const h = harness()
    const steps: Step[] = []
    const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, steps))
    const refusal = new UnsupportedProviderError("manager")
    const outage = new Error("rpc down")
    const typeError = new TypeError("Cannot read properties of undefined")

    steps.push({ answer: QR_CREATE })
    const refused = h.telemetry.track({ ceremony: "create" }, async () => {
      await ceremony.create(createRequest())
      throw refusal
    })
    expect(await caught(refused)).toBe(refusal)

    steps.push({ answer: LOCAL_ASSERT })
    const failedAfter = h.telemetry.track({ ceremony: "sign_in" }, async () => {
      await ceremony.assert(assertRequest())
      throw outage
    })
    expect(await caught(failedAfter)).toBe(outage)

    steps.push({ error: typeError })
    const failedBefore = h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest()),
    )
    expect(await caught(failedBefore)).toBe(typeError)

    expect(h.sent.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["refused", "provider_not_supported"],
      ["failed", "after_prompt"],
      ["failed", "request_failed"],
    ])
    expect(JSON.stringify(h.sent)).not.toMatch(/rpc down|Cannot read|YubiKey|passkey manager/)
  })

  it("classifies a resolved value and returns it unchanged", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    const value = { entered: false, reason: "unknown" as const }
    const result = await h.telemetry.track(
      { ceremony: "sign_in", flow: "enter" },
      async () => {
        await ceremony.assert(assertRequest())
        return value
      },
      (entered) =>
        entered.reason === "unknown"
          ? { outcome: "refused", reason: "no_wallet_for_passkey" }
          : undefined,
    )
    expect(result).toBe(value)
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "refused",
        reason: "no_wallet_for_passkey",
        route: "same_device",
        backup_eligible: "no",
        prompts: "1",
      }),
    ])
    expect(h.sent[0]).not.toHaveProperty("credential_created")
  })

  it("sends nothing for an attempt that asked nothing and ended unexplained", async () => {
    const h = harness()
    expect(await h.telemetry.track({ ceremony: "unlock" }, async () => 7)).toBe(7)
    const error = new TypeError("x")
    expect(
      await caught(h.telemetry.track({ ceremony: "unlock" }, () => Promise.reject(error))),
    ).toBe(error)
    expect(h.sent).toEqual([])
  })

  it("sends a prompt-free outcome once per page load, per ceremony and flow", () => {
    const h = harness()
    const refused = (context: PasskeyAttemptContext) =>
      h.telemetry.begin(context).end({ outcome: "refused", reason: "phone_unreachable" })
    refused({ ceremony: "create" })
    refused({ ceremony: "create" })
    refused({ ceremony: "sign_in" })
    refused({ ceremony: "unlock", flow: "unlock" })
    refused({ ceremony: "unlock", flow: "unlock" })
    refused({ ceremony: "unlock", flow: "deposit" })
    expect(h.sent).toEqual([
      {
        ceremony: "create",
        outcome: "refused",
        reason: "phone_unreachable",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        device_class: "laptop",
        os: "macos",
        browser: "chrome",
        browser_major: 140,
      },
      expect.objectContaining({ ceremony: "sign_in", reason: "phone_unreachable" }),
      // The same refusal on another flow is its own reading, not a repeat.
      expect.objectContaining({ ceremony: "unlock", flow: "unlock" }),
      expect.objectContaining({ ceremony: "unlock", flow: "deposit" }),
    ])
  })

  it("gives a nested attempt's request to the inner attempt only", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    await h.telemetry.track({ ceremony: "sign_in", flow: "send" }, () =>
      h.telemetry.track({ ceremony: "approve_tx", flow: "send" }, () =>
        ceremony.assert(assertRequest()),
      ),
    )
    expect(h.sent).toEqual([expect.objectContaining({ ceremony: "approve_tx", prompts: "1" })])
  })

  it("numbers the attempts that asked, across kinds, in one page load", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("Dismissed", "NotAllowedError") },
        { answer: LOCAL_ASSERT },
        { answer: LOCAL_ASSERT },
        { answer: LOCAL_ASSERT },
      ]),
    )
    await caught(h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())))
    h.telemetry
      .begin({ ceremony: "sign_in" })
      .end({ outcome: "refused", reason: "phone_unreachable" })
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    await h.telemetry.track({ ceremony: "unlock" }, () => ceremony.assert(assertRequest()))
    await ceremony.assert(assertRequest())
    expect(h.sent.map((props) => [props.ceremony, props.attempt])).toEqual([
      ["create", "1"],
      ["sign_in", undefined],
      ["sign_in", "2"],
      ["unlock", "3+"],
      ["untracked", "3+"],
    ])
  })
})

describe("each run owns the requests it makes", () => {
  it("keeps a replaced creation's chained assertion out of the sign-in that began meanwhile", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const answer = deferred()
    const ceremony = h.telemetry.wrap({
      create: async (request) => {
        await answer.promise
        return fake.create(request)
      },
      assert: (request) => fake.assert(request),
    })

    const creating = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    const created = creating.run((own) =>
      runPasskeyCreation(own(ceremony), {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      }),
    )
    // The user gives up on the creation and signs in instead; the phone answers the create anyway,
    // and the driver chains its assertion while the sign-in is the newest attempt.
    creating.superseded()
    const signingIn = h.telemetry.begin({ ceremony: "sign_in", flow: "enter" })
    const dismissed = deferred()
    const entering = caught(signingIn.run(() => dismissed.promise))

    answer.resolve()
    expect((await created).chained).toBeDefined()
    dismissed.reject(new DOMException("Dismissed", "NotAllowedError"))
    await entering

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "2+",
        attempt: "1",
      }),
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "cancelled",
        reason: "prompt_closed",
        prompts: "0",
      }),
    ])
    expect(h.sent[1]).not.toHaveProperty("attempt")
    expect(h.sent[1]).not.toHaveProperty("elapsed")
    expect(h.sent[1]).not.toHaveProperty("made_on")
  })

  it("gives two attempts running at once their own requests", async () => {
    const h = harness()
    const gate = deferred()
    const holdA = deferred()
    const holdB = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: holdB.promise, answer: LOCAL_ASSERT },
        { hold: holdA.promise, answer: QR_CREATE, takes: 20_000 },
      ]),
    )
    // The creation waits at its phone steps while the sign-in asks, so it is the older attempt
    // that asks last.
    const a = h.telemetry.begin({ ceremony: "create" })
    const creating = a.run(async (own) => {
      await gate.promise
      return own(ceremony).create(createRequest())
    })
    const b = h.telemetry.begin({ ceremony: "sign_in" })
    const entering = b.run((own) => own(ceremony).assert(assertRequest()))
    gate.resolve()

    holdB.resolve()
    await entering
    holdA.resolve()
    await creating

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        outcome: "succeeded",
        route: "same_device",
        prompts: "1",
        attempt: "1",
        elapsed: "under_1s",
      }),
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "1",
        attempt: "2",
        elapsed: "10_60s",
      }),
    ])
  })
})

describe("the laptop phone check", () => {
  const closed = () => new DOMException("Dismissed", "NotAllowedError")

  it("rides on every event the handle sends after the note, later runs included", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ error: closed() }, { answer: QR_CREATE }]),
    )
    const handle = h.telemetry.begin({ ceremony: "create" })
    handle.notePhoneReach("no-hybrid")
    await caught(handle.run((own) => own(ceremony).create(createRequest())))
    await handle.run((own) => own(ceremony).create(createRequest()))
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        reason: "prompt_closed",
        phone_reach: "no_hybrid",
      }),
      expect.objectContaining({ outcome: "succeeded", phone_reach: "no_hybrid" }),
    ])
  })

  it("is sent as the vocabulary names it, and not at all for a browser below the floor", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: QR_CREATE }, { answer: QR_CREATE }]),
    )
    const ok = h.telemetry.begin({ ceremony: "create" })
    ok.notePhoneReach("ok")
    await ok.run((own) => own(ceremony).create(createRequest()))
    const floor = h.telemetry.begin({ ceremony: "create" })
    floor.notePhoneReach("below-floor")
    await floor.run((own) => own(ceremony).create(createRequest()))
    expect(h.sent[0]).toMatchObject({ phone_reach: "ok" })
    expect(h.sent[1]).not.toHaveProperty("phone_reach")
  })

  it("rides on a cancel before any request", () => {
    const h = harness()
    const handle = h.telemetry.begin({ ceremony: "create" })
    handle.notePhoneReach("unknown")
    handle.end({ outcome: "cancelled", reason: "in_app_cancel" })
    expect(h.sent).toEqual([
      expect.objectContaining({ reason: "in_app_cancel", prompts: "0", phone_reach: "unknown" }),
    ])
  })

  it("keeps the once-per-page-load rule for prompt-free events, whatever the note", () => {
    const h = harness()
    const first = h.telemetry.begin({ ceremony: "create" })
    first.end({ outcome: "cancelled", reason: "in_app_cancel" })
    const second = h.telemetry.begin({ ceremony: "create" })
    second.notePhoneReach("ok")
    second.end({ outcome: "cancelled", reason: "in_app_cancel" })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).not.toHaveProperty("phone_reach")
  })

  it("never revises an event already sent, and reaches the next run", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ error: closed() }, { error: closed() }]),
    )
    const handle = h.telemetry.begin({ ceremony: "create" })
    await caught(handle.run((own) => own(ceremony).create(createRequest())))
    handle.notePhoneReach("ok")
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).not.toHaveProperty("phone_reach")
    await caught(handle.run((own) => own(ceremony).create(createRequest())))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toMatchObject({ phone_reach: "ok" })
  })

  it("never reaches a request made outside the noted run", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: QR_CREATE },
        { answer: LOCAL_ASSERT },
      ]),
    )
    const noted = h.telemetry.begin({ ceremony: "create" })
    noted.notePhoneReach("ok")
    await noted.run((own) => own(ceremony).create(createRequest()))
    await ceremony.assert(assertRequest())
    expect(h.sent[1]).toMatchObject({ ceremony: "untracked" })
    expect(h.sent[1]).not.toHaveProperty("phone_reach")
  })

  it("keeps a replaced run's late request out of the attempt that replaced it", async () => {
    const h = harness()
    const late = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT },
        { answer: QR_CREATE },
      ]),
    )
    const noted = h.telemetry.begin({ ceremony: "create" })
    noted.notePhoneReach("no-hybrid")
    const replaced = noted.run(async (own) => {
      await late.promise
      return own(ceremony).create(createRequest())
    })
    noted.superseded()
    await h.telemetry.track({ ceremony: "sign_in" }, (own) => own(ceremony).assert(assertRequest()))
    late.resolve()
    await replaced
    // A replaced attempt still reports its own success, under its own note.
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "sign_in" }),
      expect.objectContaining({ ceremony: "create", phone_reach: "no_hybrid" }),
    ])
    expect(h.sent[0]).not.toHaveProperty("phone_reach")
  })
})

describe("a run's own request signals", () => {
  const phases = (signals: PasskeyRequestSignal[]) => signals.map((s) => [s.phase, s.kind])

  it("reach the run that made the requests, a chained one included", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
      route: "cross-device",
      prfAtCreate: false,
    })
    const heard: PasskeyRequestSignal[] = []
    const handle = h.telemetry.begin({ ceremony: "create" })
    await handle.run(
      (own) =>
        runPasskeyCreation(own(h.telemetry.wrap(fake)), {
          posture: "laptop",
          rpId: "localhost",
          rpName: "zk.money",
          userName: "@alice",
          challengeForChained: () => new Uint8Array(32),
        }),
      undefined,
      (signal) => heard.push(signal),
    )
    expect(phases(heard)).toEqual([
      ["issued", "create"],
      ["answered", "create"],
      ["issued", "assert"],
      ["answered", "assert"],
    ])
  })

  it("never reach another run, even when the older run's answer comes last", async () => {
    const h = harness()
    const holdA = deferred()
    const holdB = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: holdA.promise, answer: QR_CREATE },
        { hold: holdB.promise, error: new DOMException("Dismissed", "NotAllowedError") },
      ]),
    )
    const heardA: PasskeyRequestSignal[] = []
    const heardB: PasskeyRequestSignal[] = []
    const a = h.telemetry.begin({ ceremony: "create" })
    const creatingA = a.run(
      (own) => own(ceremony).create(createRequest()),
      undefined,
      (signal) => heardA.push(signal),
    )
    a.unmounted()
    const b = h.telemetry.begin({ ceremony: "create" })
    const creatingB = caught(
      b.run(
        (own) => own(ceremony).create(createRequest()),
        undefined,
        (signal) => heardB.push(signal),
      ),
    )
    holdA.resolve()
    await creatingA
    holdB.resolve()
    await creatingB
    expect(phases(heardA)).toEqual([
      ["issued", "create"],
      ["answered", "create"],
    ])
    expect(phases(heardB)).toEqual([["issued", "create"]])
  })

  it("leave the run and its event alone when the listener throws", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: QR_CREATE }]),
    )
    const result = await h.telemetry.begin({ ceremony: "create" }).run(
      (own) => own(ceremony).create(createRequest()),
      undefined,
      () => {
        throw new Error("listener broke")
      },
    )
    expect(result).toMatchObject({ credentialId: "cred-1" })
    expect(h.sent).toEqual([expect.objectContaining({ outcome: "succeeded", prompts: "1" })])
  })
})

describe("end causes", () => {
  class GateCancelledError extends Error {
    override name = "GateCancelledError"
  }

  it("reports the user's cancel before any request as an in-app cancel", async () => {
    const h = harness()
    const gate = deferred()
    const attempt = h.telemetry.begin({ ceremony: "unlock", flow: "unlock" })
    const running = attempt.run(() => gate.promise)
    attempt.userCancelled()
    const cancel = new GateCancelledError()
    gate.reject(cancel)
    expect(await caught(running)).toBe(cancel)
    expect(h.sent).toEqual([
      {
        ceremony: "unlock",
        flow: "unlock",
        outcome: "cancelled",
        reason: "in_app_cancel",
        provider: "unknown",
        backup_eligible: "unknown",
        route: "unknown",
        prompts: "0",
        ...HINTED_MAC_PROPS,
      },
    ])
  })

  it("reports the user's cancel whatever the request then threw", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, error: new DOMException("aborted", "AbortError") },
      ]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in" })
    const running = attempt.run(() => ceremony.assert(assertRequest()))
    attempt.userCancelled()
    hold.resolve()
    await caught(running)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("keeps a cancelled attempt and its successor apart", async () => {
    for (const [aAsked, bAttempt] of [
      [false, "1"],
      [true, "2"],
    ] as const) {
      const h = harness()
      const holdA = deferred()
      const holdB = deferred()
      const answerB: Step = { hold: holdB.promise, answer: LOCAL_ASSERT }
      const steps: Step[] = aAsked
        ? [{ hold: holdA.promise, error: new GateCancelledError() }, answerB]
        : [answerB]
      const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, steps))
      const a = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
      const runningA = a.run(async () => {
        if (aAsked) return ceremony.create(createRequest())
        await holdA.promise
        throw new GateCancelledError()
      })
      a.userCancelled()
      const b = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
      const runningB = b.run(() => ceremony.assert(assertRequest()))
      holdA.resolve()
      await caught(runningA)
      holdB.resolve()
      await runningB
      expect(h.sent.map(({ outcome, reason, attempt }) => [outcome, reason, attempt])).toEqual([
        ["cancelled", "in_app_cancel", aAsked ? "1" : undefined],
        ["succeeded", undefined, bAttempt],
      ])
    }
  })

  it("sends nothing when a replaced or unmounted attempt fails, and still reports its success", async () => {
    for (const mark of ["superseded", "unmounted"] as const) {
      const h = harness()
      const ceremony = h.telemetry.wrap(
        scripted(h.telemetry.requestHook, h.advance, [
          { error: new DOMException("aborted", "AbortError") },
          { answer: LOCAL_ASSERT },
        ]),
      )
      const failing = h.telemetry.begin({ ceremony: "sign_in" })
      const failed = failing.run(() => ceremony.assert(assertRequest()))
      failing[mark]()
      await caught(failed)
      expect(h.sent).toEqual([])

      const succeeding = h.telemetry.begin({ ceremony: "sign_in" })
      const succeeded = succeeding.run(() => ceremony.assert(assertRequest()))
      succeeding[mark]()
      await succeeded
      expect(h.sent).toEqual([expect.objectContaining({ outcome: "succeeded" })])
    }
  })

  it("lets the first explicit cause win", async () => {
    const cancelledFirst = harness()
    const gate = deferred()
    const a = cancelledFirst.telemetry.begin({ ceremony: "unlock" })
    const runningA = a.run(() => gate.promise)
    a.userCancelled()
    a.unmounted()
    a.superseded()
    gate.reject(new GateCancelledError())
    await caught(runningA)
    expect(cancelledFirst.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel" }),
    ])

    const unmountedFirst = harness()
    const gateB = deferred()
    const b = unmountedFirst.telemetry.begin({ ceremony: "unlock" })
    const runningB = b.run(() => gateB.promise)
    b.unmounted()
    b.userCancelled()
    gateB.reject(new GateCancelledError())
    await caught(runningB)
    expect(unmountedFirst.sent).toEqual([])
  })

  it("closes an idle attempt that is replaced or unmounted, without a word", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in", flow: "enter" })
    attempt.superseded()
    attempt.userCancelled()
    attempt.end({ outcome: "refused", reason: "phone_unreachable" })
    // A run started after all that is the next attempt of the same kind, and reports as one.
    expect(
      await attempt.run(async () => (await ceremony.assert(assertRequest())).credentialId),
    ).toBe("cred-1")
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("reports the user's cancel when an idle cancelled attempt is then unmounted", () => {
    const h = harness()
    const attempt = h.telemetry.begin({ ceremony: "create" })
    attempt.userCancelled()
    attempt.unmounted()
    attempt.end({ outcome: "refused", reason: "phone_unreachable" })
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
      }),
    ])
  })
})

describe("the browser's error name", () => {
  const notReadable = () =>
    new DOMException(
      "An unknown error occurred while talking to the credential manager.",
      "NotReadableError",
    )

  it("names a failed request's error, listed or other, after an issued or an answered request", async () => {
    const h = harness()
    const ceremony = scripted(h.telemetry.requestHook, h.advance, [
      { error: notReadable() },
      { answer: LOCAL_ASSERT, error: notReadable() },
      { error: Object.assign(new Error("wrong key"), { name: "0x1234abcd@alice" }) },
      { error: new TypeError("cannot read properties of undefined") },
    ])
    for (let i = 0; i < 4; i++) {
      await caught(
        h.telemetry.track({ ceremony: "sign_in" }, (own) => own(ceremony).assert(assertRequest())),
      )
    }
    expect(h.sent.map((p) => [p.outcome, p.reason, p.error_name])).toEqual([
      ["failed", "request_failed", "NotReadableError"],
      ["failed", "after_prompt", "NotReadableError"],
      ["failed", "request_failed", "other"],
      ["failed", "request_failed", "TypeError"],
    ])
    expect(JSON.stringify(h.sent)).not.toContain("credential manager")
    expect(JSON.stringify(h.sent)).not.toContain("0x1234")
  })

  it("names a front's own failure other", async () => {
    class SessionChangedError extends Error {
      override name = "SessionChangedError"
    }
    const h = harness({
      extraNames: { SessionChangedError: { outcome: "failed", reason: "session_lost" } },
    })
    const ceremony = scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }])
    await caught(
      h.telemetry.track({ ceremony: "unlock" }, async (own) => {
        await own(ceremony).assert(assertRequest())
        throw new SessionChangedError()
      }),
    )
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "session_lost", error_name: "other" }),
    ])
  })

  it("carries no name on a cancel, a refusal, the user's cancel, an explicit end or a classified result", async () => {
    const h = harness()
    const ceremony = scripted(h.telemetry.requestHook, h.advance, [
      { error: new DOMException("closed", "NotAllowedError") },
      { error: { name: "NoPrfError", message: "no prf" } },
      { error: notReadable() },
      { answer: LOCAL_ASSERT },
    ])
    const attempt = () =>
      h.telemetry.track({ ceremony: "sign_in" }, (own) => own(ceremony).assert(assertRequest()))
    await caught(attempt())
    await caught(attempt())
    const cancelled = h.telemetry.begin({ ceremony: "sign_in" })
    cancelled.userCancelled()
    await caught(cancelled.run((own) => own(ceremony).assert(assertRequest())))
    h.telemetry.begin({ ceremony: "unlock" }).end({ outcome: "failed", reason: "session_lost" })
    await h.telemetry.track(
      { ceremony: "sign_in" },
      (own) => own(ceremony).assert(assertRequest()),
      () => ({ outcome: "failed", reason: "registry_unconfirmed" }),
    )
    expect(h.sent.map((p) => [p.outcome, p.reason])).toEqual([
      ["cancelled", "prompt_closed"],
      ["refused", "no_prf"],
      ["cancelled", "in_app_cancel"],
      ["failed", "session_lost"],
      ["failed", "registry_unconfirmed"],
    ])
    for (const props of h.sent) expect(props).not.toHaveProperty("error_name")
  })
})

describe("the phone's platform-authenticator answer", () => {
  const PHONE: PasskeyTelemetryEnvironment = {
    posture: "phone",
    userAgent: parseUserAgent({ userAgent: SAFARI_IPHONE }),
  }
  const LAPTOP: PasskeyTelemetryEnvironment = {
    posture: "laptop",
    userAgent: parseUserAgent({ userAgent: CHROME_MAC }),
  }
  const phone = (options: Partial<PasskeyTelemetryOptions> = {}) =>
    harness({
      environment: () => Promise.resolve(PHONE),
      syncEnvironment: () => PHONE,
      ...options,
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const succeed = (h: ReturnType<typeof harness>) => {
    const ceremony = scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }])
    return h.telemetry.track({ ceremony: "sign_in" }, (own) =>
      own(ceremony).assert(assertRequest()),
    )
  }

  it("is read once and rides on every phone row once it has settled", async () => {
    const probe = vi.fn(() => Promise.resolve("no" as const))
    const h = phone({ platformAuthenticator: probe })
    await settle()
    const held = deferred<never>()
    const ceremony = scripted(h.telemetry.requestHook, h.advance, [
      { answer: QR_CREATE, credentialId: "c1" },
      { error: { name: "NoPrfError" } },
      { error: new DOMException("closed", "NotAllowedError") },
      { error: new DOMException("x", "NotReadableError") },
      { hold: held.promise },
    ])
    const create = () =>
      h.telemetry.track({ ceremony: "create" }, (own) => own(ceremony).create(createRequest()))
    const assert = () =>
      h.telemetry.track({ ceremony: "sign_in" }, (own) => own(ceremony).assert(assertRequest()))
    await create()
    await caught(create())
    await caught(assert())
    await caught(assert())
    const waiting = caught(assert())
    await Promise.resolve()
    h.pageHide()
    held.resolve(undefined as never)
    await waiting
    expect(probe).toHaveBeenCalledTimes(1)
    expect(h.sent.map((p) => [p.outcome, p.platform_authenticator])).toEqual([
      ["succeeded", "no"],
      ["refused", "no"],
      ["cancelled", "no"],
      ["failed", "no"],
      ["abandoned", "no"],
    ])
  })

  it("survives a read that throws before it returns a promise", async () => {
    const h = phone({
      platformAuthenticator: () => {
        throw new Error("no static")
      },
    })
    await settle()
    await succeed(h)
    expect(h.sent[0]).toMatchObject({ device_class: "phone" })
    expect(h.sent[0]).not.toHaveProperty("platform_authenticator")
  })

  it("is never read on a laptop, and never reaches a laptop row", async () => {
    const probe = vi.fn(() => Promise.resolve("yes" as const))
    const h = harness({ platformAuthenticator: probe })
    await settle()
    await succeed(h)
    expect(probe).not.toHaveBeenCalled()
    expect(h.sent[0]).not.toHaveProperty("platform_authenticator")
  })

  it("is absent until the read settles, and absent when it never does, rejects or answers off the list", async () => {
    const pending = deferred<PasskeyPlatformAuthenticator>()
    const h = phone({ platformAuthenticator: () => pending.promise })
    await succeed(h)
    expect(h.sent[0]).not.toHaveProperty("platform_authenticator")
    pending.resolve("yes")
    await settle()
    await succeed(h)
    expect(h.sent[1]).toMatchObject({ platform_authenticator: "yes" })

    for (const read of [
      () => new Promise<PasskeyPlatformAuthenticator>(() => {}),
      () => Promise.reject(new Error("x")),
      () => Promise.resolve("maybe" as never),
    ]) {
      const other = phone({ platformAuthenticator: read })
      await settle()
      await succeed(other)
      expect(other.sent[0]).toMatchObject({ device_class: "phone", os: "ios", os_major: 18 })
      expect(other.sent[0]).not.toHaveProperty("platform_authenticator")
    }
  })

  it("never holds the Client Hints environment back while it hangs", async () => {
    // An Android phone: the user agent alone gives no OS major and reads Brave as Chrome; only the
    // async Client Hints read does. A probe that never settles must not delay either.
    const CHROME_ANDROID =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"
    const hinted: PasskeyTelemetryEnvironment = {
      posture: "phone",
      userAgent: parseUserAgent({
        userAgent: CHROME_ANDROID,
        userAgentData: {
          platform: "Android",
          platformVersion: "14.0.0",
          brands: [{ brand: "Brave", version: "154" }],
        },
      }),
    }
    const h = harness({
      syncEnvironment: () => ({
        posture: "phone",
        userAgent: parseUserAgent({ userAgent: CHROME_ANDROID }),
      }),
      environment: () => Promise.resolve(hinted),
      platformAuthenticator: () => new Promise(() => {}),
    })
    await settle()
    await succeed(h)
    expect(h.sent[0]).toMatchObject({ os: "android", os_major: 14, browser: "brave" })
    expect(h.sent[0]).not.toHaveProperty("platform_authenticator")
  })

  it("follows the row's own environment when the two postures disagree", async () => {
    const syncPhone = harness({
      syncEnvironment: () => PHONE,
      environment: () => Promise.resolve(HINTED_MAC),
      platformAuthenticator: () => Promise.resolve("yes" as const),
    })
    await settle()
    await succeed(syncPhone)
    expect(syncPhone.sent[0]).toMatchObject(HINTED_MAC_PROPS)
    expect(syncPhone.sent[0]).not.toHaveProperty("platform_authenticator")

    const late = vi.fn(() => Promise.resolve("yes" as const))
    const syncLaptop = harness({
      syncEnvironment: () => LAPTOP,
      environment: () => Promise.resolve(PHONE),
      platformAuthenticator: late,
    })
    await settle()
    await succeed(syncLaptop)
    expect(late).not.toHaveBeenCalled()
    expect(syncLaptop.sent[0]).toMatchObject({ device_class: "phone" })
    expect(syncLaptop.sent[0]).not.toHaveProperty("platform_authenticator")
  })
})

describe("extension", () => {
  const createOnce = (h: ReturnType<typeof harness>, steps: Step[]) =>
    caught(
      h.telemetry.track({ ceremony: "create" }, (own) =>
        own(scripted(h.telemetry.requestHook, h.advance, steps)).create(createRequest()),
      ),
    )
  const signInOnce = (h: ReturnType<typeof harness>) =>
    caught(
      h.telemetry.track({ ceremony: "sign_in" }, (own) =>
        own(scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }])).assert(
          assertRequest(),
        ),
      ),
    )

  it("rides on every row, whatever the ceremony and outcome", async () => {
    const h = harness({ extension: () => "1password" as const })
    await signInOnce(h)
    await createOnce(h, [{ answer: QR_CREATE }])
    await createOnce(h, [{ answer: QR_CREATE, error: { name: "NoPrfError" } }])
    await createOnce(h, [{ error: new DOMException("closed", "NotAllowedError") }])
    await createOnce(h, [{ error: new Error("boom") }])
    h.telemetry.begin({ ceremony: "unlock" }).end({ outcome: "refused", reason: "phone_required" })
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT },
        { answer: LOCAL_ASSERT },
      ]),
    )
    await h.telemetry.track({ ceremony: "approve_tx", flow: "send" }, () =>
      ceremony.assert(assertRequest()),
    )
    await ceremony.assert(assertRequest())
    h.telemetry.begin({ ceremony: "create" })
    h.pageHide()
    expect(h.sent.map((p) => [p.ceremony, p.outcome, p.extension])).toEqual([
      ["sign_in", "succeeded", "1password"],
      ["create", "succeeded", "1password"],
      ["create", "refused", "1password"],
      ["create", "cancelled", "1password"],
      ["create", "failed", "1password"],
      ["unlock", "refused", "1password"],
      ["approve_tx", "succeeded", "1password"],
      ["untracked", "succeeded", "1password"],
      ["create", "abandoned", "1password"],
    ])
  })

  it("is read once per row, as the row is sent, and not for a prompt-free repeat", () => {
    const answers = ["other", "1password", "none"] as const
    let calls = 0
    const h = harness({ extension: () => answers[calls++]! })
    const refuse = () =>
      h.telemetry.begin({ ceremony: "create" }).end({ outcome: "refused", reason: "no_prf" })
    refuse()
    refuse()
    h.telemetry.begin({ ceremony: "sign_in" }).end({ outcome: "refused", reason: "no_prf" })
    expect(h.sent.map((p) => p.extension)).toEqual(["other", "1password"])
    expect(calls).toBe(2)
  })

  it("leaves the prop off when the read throws or answers off the list, and the rest of the row whole", async () => {
    const control = harness({ extension: () => "none" as const })
    await signInOnce(control)
    const { extension, ...rest } = control.sent[0]!
    expect(extension).toBe("none")
    for (const read of [
      () => {
        throw new Error("blocked")
      },
      () => "dashlane" as never,
    ]) {
      const h = harness({ extension: read })
      await signInOnce(h)
      expect(h.sent[0]).toEqual(rest)
    }
  })

  it("reads the page's create wrapper by default", async () => {
    const restore = installCredentials({ get: NATIVE_GET, create: NATIVE_CREATE })
    try {
      const native = harness({ extension: undefined })
      await signInOnce(native)
      expect(native.sent[0]).toMatchObject({ extension: "none" })
      restore()
      const second = installCredentials({ get: NATIVE_GET, create: async () => null })
      try {
        const script = harness({ extension: undefined })
        await signInOnce(script)
        expect(script.sent[0]).toMatchObject({ extension: "other" })
      } finally {
        second()
      }
    } finally {
      restore()
    }
  })
})

describe("native lock", () => {
  const signInOnce = (h: ReturnType<typeof harness>) =>
    caught(
      h.telemetry.track({ ceremony: "sign_in" }, (own) =>
        own(scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }])).assert(
          assertRequest(),
        ),
      ),
    )
  const scope = globalThis as Record<string, unknown>
  afterEach(() => {
    delete scope[NATIVE_LOCK_KEY]
  })

  it("rides on every row, one prop per call, whatever the ceremony and outcome", async () => {
    const h = harness({ nativeLock: () => "applied" as const })
    await signInOnce(h)
    await caught(
      h.telemetry.track({ ceremony: "create" }, (own) =>
        own(scripted(h.telemetry.requestHook, h.advance, [{ answer: QR_CREATE }])).create(
          createRequest(),
        ),
      ),
    )
    h.telemetry.begin({ ceremony: "unlock" }).end({ outcome: "refused", reason: "phone_required" })
    await caught(
      h.telemetry.track({ ceremony: "create" }, (own) =>
        own(scripted(h.telemetry.requestHook, h.advance, [{ error: new Error("boom") }])).create(
          createRequest(),
        ),
      ),
    )
    await caught(
      h.telemetry.track({ ceremony: "create" }, (own) =>
        own(
          scripted(h.telemetry.requestHook, h.advance, [
            { error: new DOMException("closed", "NotAllowedError") },
          ]),
        ).create(createRequest()),
      ),
    )
    expect(
      h.sent.map((p) => [p.ceremony, p.outcome, p.native_lock_create, p.native_lock_get]),
    ).toEqual([
      ["sign_in", "succeeded", "applied", "applied"],
      ["create", "succeeded", "applied", "applied"],
      ["unlock", "refused", "applied", "applied"],
      ["create", "failed", "applied", "applied"],
      ["create", "cancelled", "applied", "applied"],
    ])
  })

  it("carries each call's own answer, in either direction, and every listed value", async () => {
    for (const [create, get] of [
      ["applied", "lost_race"],
      ["lost_race", "applied"],
      ["skipped_accessor", "unsupported"],
    ] as const) {
      const h = harness({ nativeLock: (call) => (call === "create" ? create : get) })
      await signInOnce(h)
      expect(h.sent[0]).toMatchObject({ native_lock_create: create, native_lock_get: get })
    }
  })

  it("leaves a prop off when its read answers nothing, off the list or throws, and the rest of the row whole", async () => {
    const control = harness({ nativeLock: () => "applied" as const })
    await signInOnce(control)
    const { native_lock_create, native_lock_get, ...rest } = control.sent[0]!
    expect([native_lock_create, native_lock_get]).toEqual(["applied", "applied"])
    for (const read of [
      () => undefined,
      () => "frozen" as never,
      () => {
        throw new Error("blocked")
      },
    ]) {
      const h = harness({ nativeLock: read })
      await signInOnce(h)
      expect(h.sent[0]).toEqual(rest)
    }
    const oneSided = harness({
      nativeLock: (call) => (call === "get" ? ("applied" as const) : undefined),
    })
    await signInOnce(oneSided)
    expect(oneSided.sent[0]).toEqual({ ...rest, native_lock_get: "applied" })
  })

  it("reads the page's record by default", async () => {
    scope[NATIVE_LOCK_KEY] = { create: "lost_race", get: "applied" }
    const recorded = harness({ nativeLock: undefined })
    await signInOnce(recorded)
    expect(recorded.sent[0]).toMatchObject({
      native_lock_create: "lost_race",
      native_lock_get: "applied",
    })
    delete scope[NATIVE_LOCK_KEY]
    const bare = harness({ nativeLock: undefined })
    await signInOnce(bare)
    expect(bare.sent[0]).not.toHaveProperty("native_lock_create")
    expect(bare.sent[0]).not.toHaveProperty("native_lock_get")
  })
})

describe("pagehide", () => {
  it("abandons an attempt still waiting on its request, inside the handler, and forgets it", async () => {
    const h = harness()
    h.pageHide()
    expect(h.sent).toEqual([])

    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ hold: hold.promise, answer: LOCAL_ASSERT }]),
    )
    const running = h.telemetry.track({ ceremony: "sign_in", flow: "enter" }, () =>
      ceremony.assert(assertRequest()),
    )
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "abandoned",
        prompts: "1",
      }),
    ])
    expect(h.sent[0]).not.toHaveProperty("reason")

    hold.resolve()
    await running
    h.pageHide()
    expect(h.sent).toHaveLength(1)
  })

  it("abandons an attempt that has not asked yet", () => {
    const h = harness()
    h.telemetry.begin({ ceremony: "create" })
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "0" }),
    ])
    expect(h.sent[0]).not.toHaveProperty("attempt")
    expect(h.sent[0]).not.toHaveProperty("elapsed")
  })

  it("reports a cancelled attempt as cancelled, and its late failure as nothing", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, error: new DOMException("aborted", "AbortError") },
      ]),
    )
    const attempt = h.telemetry.begin({ ceremony: "sign_in" })
    const running = attempt.run(() => ceremony.assert(assertRequest()))
    attempt.userCancelled()
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
    hold.resolve()
    await caught(running)
    expect(h.sent).toHaveLength(1)
  })

  it("sends nothing for a replaced or unmounted attempt, then or later", async () => {
    for (const mark of ["superseded", "unmounted"] as const) {
      const h = harness()
      const hold = deferred()
      const ceremony = h.telemetry.wrap(
        scripted(h.telemetry.requestHook, h.advance, [
          { hold: hold.promise, answer: LOCAL_ASSERT },
        ]),
      )
      const attempt = h.telemetry.begin({ ceremony: "sign_in" })
      const running = attempt.run(() => ceremony.assert(assertRequest()))
      attempt[mark]()
      h.pageHide()
      hold.resolve()
      await running
      expect(h.sent).toEqual([])
    }
  })

  /**
   * A laptop creation over a phone: the create is issued and held; once it answers, the driver
   * chains an assertion for the key material.
   */
  function heldCreation(h: ReturnType<typeof harness>) {
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const issued = deferred()
    const hold = deferred()
    const ceremony = h.telemetry.wrap({
      create: async (request) => {
        h.telemetry.requestHook({ phase: "issued", kind: "create", request })
        issued.resolve()
        await hold.promise
        return fake.create(request)
      },
      assert: (request) => fake.assert(request),
    })
    const creation = () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32),
      })
    return { fake, ceremony, creation, issued: issued.promise, answer: hold.resolve }
  }

  it("keeps a creation's chained assertion inside the attempt it abandoned", async () => {
    const h = harness()
    const { fake, ceremony, creation, issued, answer } = heldCreation(h)
    const running = h.telemetry.track({ ceremony: "create" }, creation)
    await issued
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "1" }),
    ])

    answer()
    const created = await running
    expect(created.chained).toBeDefined()
    expect(fake.assertRequests).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ attempt: "1" })

    // The chained assertion was not counted: the next attempt is the page's second.
    await h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest({ credentialIds: [created.created.credentialId] })),
    )
    expect(h.sent.map((event) => [event.ceremony, event.outcome, event.attempt])).toEqual([
      ["create", "abandoned", "1"],
      ["sign_in", "succeeded", "2"],
    ])
  })

  it("counts the ceremony a handle runs after the page came back", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: GPM_AAGUID,
    })
    const ceremony = h.telemetry.wrap(fake)
    // The laptop route opens its attempt at the phone steps, and asks only once the user is ready.
    const attempt = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    h.pageHide()
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "abandoned", prompts: "0" }),
    ])

    await attempt.run(() => ceremony.create(createRequest()))
    expect(h.sent[1]).toMatchObject({
      ceremony: "create",
      flow: "onboarding",
      outcome: "succeeded",
      provider: "google_password_manager",
      credential_created: "yes",
      prompts: "1",
      attempt: "1",
    })
    expect(h.sent).toHaveLength(2)
  })

  it("keeps a replaced creation's chained assertion silent after the page went", async () => {
    const h = harness()
    const { ceremony, creation, issued, answer } = heldCreation(h)
    const attempt = h.telemetry.begin({ ceremony: "create", flow: "onboarding" })
    const running = attempt.run(creation)
    await issued
    attempt.superseded()
    h.pageHide()
    answer()
    const created = await running
    expect(created.chained).toBeDefined()
    expect(h.sent).toEqual([])

    await h.telemetry.track({ ceremony: "sign_in" }, () =>
      ceremony.assert(assertRequest({ credentialIds: [created.created.credentialId] })),
    )
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "sign_in", outcome: "succeeded", attempt: "2" }),
    ])
  })

  it("listens on the page itself by default", () => {
    const sent: PasskeyCeremonyProps[] = []
    const telemetry = createPasskeyTelemetry({ send: (props) => void sent.push(props) })
    telemetry.begin({ ceremony: "create" })
    window.dispatchEvent(new Event("pagehide"))
    expect(sent).toEqual([expect.objectContaining({ ceremony: "create", outcome: "abandoned" })])
  })
})

describe("snapshot", () => {
  it("names the provider of the credential the latest request targeted", async () => {
    const h = harness({ fallbackProvider: () => "1password" })
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
    })
    const ceremony = h.telemetry.wrap(fake)
    const provider = () => h.telemetry.snapshot().provider
    expect(provider()).toBe("1password")

    const a = await ceremony.create(createRequest())
    expect(provider()).toBe("icloud_keychain")
    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    expect(provider()).toBe("icloud_keychain")

    fake.opts.assertOverride = () => a.credentialId
    await ceremony.assert(assertRequest({ credentialIds: ["credential-b"] }))
    expect(provider()).toBe("unknown")

    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    fake.opts.assertOverride = () => {
      throw new TypeError("x")
    }
    await caught(ceremony.assert(assertRequest({ credentialIds: ["credential-b"] })))
    expect(provider()).toBe("unknown")

    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId] }))
    expect(provider()).toBe("icloud_keychain")
    fake.opts.assertOverride = () => {
      throw new DOMException("Dismissed", "NotAllowedError")
    }
    await caught(ceremony.assert(assertRequest()))
    expect(provider()).toBe("unknown")

    fake.opts.aaguid = GPM_AAGUID
    const b = await ceremony.create(createRequest())
    expect(provider()).toBe("google_password_manager")
    await ceremony.assert(assertRequest({ credentialIds: [a.credentialId, b.credentialId] }))
    expect(provider()).toBe("unknown")
    await ceremony.assert(assertRequest({ credentialIds: [b.credentialId] }))
    expect(provider()).toBe("google_password_manager")
  })

  it("is unknown while a creation waits for its answer, and keeps a creation that failed to decode", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, answer: QR_CREATE, error: new TypeError("decode") },
      ]),
    )
    const creating = caught(ceremony.create(createRequest()))
    expect(h.telemetry.snapshot().provider).toBe("unknown")
    hold.resolve()
    await creating
    expect(h.telemetry.snapshot().provider).toBe("icloud_keychain")
  })

  it("stops asking for the fallback once any request is issued", async () => {
    const h = harness({ fallbackProvider: () => "yubikey" as const })
    expect(h.telemetry.snapshot().provider).toBe("yubikey")
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { error: new DOMException("Dismissed", "NotAllowedError") },
      ]),
    )
    await caught(ceremony.assert(assertRequest()))
    expect(h.telemetry.snapshot().provider).toBe("unknown")
  })

  it("carries the environment, from the user agent until the full read resolves", async () => {
    const full = deferred<PasskeyTelemetryEnvironment>()
    const h = harness({ environment: () => full.promise })
    expect(h.telemetry.snapshot()).toEqual({
      posture: "laptop",
      userAgent: parseUserAgent({ userAgent: CHROME_MAC }),
      provider: "unknown",
    })
    full.resolve(HINTED_MAC)
    await full.promise
    expect(h.telemetry.snapshot()).toEqual({ ...HINTED_MAC, provider: "unknown" })
  })

  it("learns from a request it did not wrap, without counting it", async () => {
    const h = harness()
    const bare = new FakePasskeyCeremony({ onRequest: h.telemetry.requestHook, aaguid: GPM_AAGUID })
    await bare.create(createRequest())
    expect(h.telemetry.snapshot().provider).toBe("google_password_manager")
    expect(h.sent).toEqual([])
  })
})

describe("an unnamed provider's AAGUID", () => {
  const UNNAMED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
  const UNNAMED_CREATE: PasskeyAnswerEvidence = { ...QR_CREATE, aaguid: UNNAMED }
  const unnamed = { provider: "other", aaguid: UNNAMED }

  it("stays in the snapshot for every request that names its credential", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: UNNAMED_CREATE, credentialId: "cred-u" },
        { hold: hold.promise, error: new DOMException("Dismissed", "NotAllowedError") },
        {},
        {},
      ]),
    )
    await ceremony.create(createRequest())
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)

    const asserting = caught(ceremony.assert(assertRequest({ credentialIds: ["cred-u"] })))
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)
    hold.resolve()
    await asserting
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)

    await ceremony.assert(assertRequest({ credentialIds: ["cred-u", "cred-x"] }))
    expect(h.telemetry.snapshot()).toMatchObject({ provider: "unknown" })
    expect(h.telemetry.snapshot()).not.toHaveProperty("aaguid")

    await ceremony.assert(assertRequest({ credentialIds: ["cred-u"] }))
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)
    await ceremony.assert(assertRequest({ credentialIds: ["cred-x"] }))
    expect(h.telemetry.snapshot()).not.toHaveProperty("aaguid")
  })

  it("is absent while a creation waits, and kept when its answer fails to decode", async () => {
    const h = harness()
    const hold = deferred()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { hold: hold.promise, answer: UNNAMED_CREATE, error: new TypeError("decode") },
      ]),
    )
    const creating = caught(
      h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())),
    )
    expect(h.telemetry.snapshot()).not.toHaveProperty("aaguid")
    hold.resolve()
    await creating
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)
  })

  it("comes from a creation the tracker only heard", async () => {
    const h = harness()
    const bare = new FakePasskeyCeremony({ onRequest: h.telemetry.requestHook, aaguid: UNNAMED })
    await bare.create(createRequest())
    expect(h.telemetry.snapshot()).toMatchObject(unnamed)
  })

  it("is never taken from the fallback", () => {
    const h = harness({ fallbackProvider: () => "other" })
    expect(h.telemetry.snapshot().provider).toBe("other")
    expect(h.telemetry.snapshot()).not.toHaveProperty("aaguid")
  })

  it("never reaches the event", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: UNNAMED_CREATE }]),
    )
    await Promise.resolve()
    await caught(
      h.telemetry.track({ ceremony: "create" }, async () => {
        await ceremony.create(createRequest())
        throw new UnsupportedProviderError("manager")
      }),
    )
    expect(h.sent).toEqual([
      {
        ceremony: "create",
        outcome: "refused",
        reason: "provider_not_supported",
        provider: "other",
        credential_created: "yes",
        backup_eligible: "yes",
        route: "phone_qr",
        prompts: "1",
        attempt: "1",
        elapsed: "under_1s",
        ...HINTED_MAC_PROPS,
      },
    ])
  })
})

describe("never in the way", () => {
  it("settles as the run does when sending throws", async () => {
    const h = harness({
      send: () => {
        throw new Error("transport down")
      },
    })
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT },
        { error: new TypeError("x") },
      ]),
    )
    expect(
      (await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest())))
        .credentialId,
    ).toBe("cred-1")
    await expect(
      h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest())),
    ).rejects.toThrow(TypeError)
    const rejecting = harness({ send: () => Promise.reject(new Error("transport down")) as never })
    rejecting.telemetry
      .begin({ ceremony: "create" })
      .end({ outcome: "failed", reason: "constraint" })
  })

  it("sends with the user agent alone when the full environment never arrives", async () => {
    const h = harness({
      environment: () => new Promise(() => {}),
      syncEnvironment: () => ({
        posture: "phone",
        userAgent: parseUserAgent({ userAgent: SAFARI_IPHONE }),
      }),
    })
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: LOCAL_ASSERT }]),
    )
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    expect(h.sent).toEqual([
      expect.objectContaining({
        device_class: "phone",
        os: "ios",
        os_major: 18,
        browser: "safari",
        browser_major: 26,
      }),
    ])
  })

  it("survives every environment and fallback failing", async () => {
    const h = harness({
      environment: () => {
        throw new Error("no hints")
      },
      syncEnvironment: () => {
        throw new Error("no navigator")
      },
      fallbackProvider: () => {
        throw new Error("no storage")
      },
    })
    await Promise.resolve()
    expect(h.telemetry.snapshot().provider).toBe("unknown")
    h.telemetry.begin({ ceremony: "create" }).end({ outcome: "failed", reason: "constraint" })
    expect(h.sent).toEqual([expect.objectContaining({ device_class: "laptop", os: "unknown" })])
  })

  it("ignores a signal it cannot read", () => {
    const { telemetry } = harness()
    expect(() => telemetry.requestHook(undefined as never)).not.toThrow()
    expect(() =>
      telemetry.requestHook({ phase: "answered", kind: "create" } as never),
    ).not.toThrow()
  })
})

describe("over the browser ceremony", () => {
  const timing: CeremonyTiming = {
    handoffWaitMs: 30,
    teardownWaitMs: 5,
    focusWaitMs: 10,
    pendingRetryDelaysMs: [1, 1, 1, 1],
    requestTimeoutMs: 50,
  }
  const get = vi.fn()
  const create = vi.fn()

  beforeEach(() => {
    get.mockReset()
    create.mockReset()
    Object.defineProperty(navigator, "credentials", { value: { get, create }, configurable: true })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  const assertionCredential = () => ({
    id: "cred-1",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      signature: new Uint8Array([1, 2, 3]).buffer,
      authenticatorData: new Uint8Array(37).buffer,
      clientDataJSON: new Uint8Array([4, 5]).buffer,
    },
  })
  const pending = () => new DOMException("A request is already pending.", "NotAllowedError")
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("counts no prompt for a call cancelled while it waits its turn", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    let settleFirst!: (credential: unknown) => void
    get.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))

    await h.telemetry.track({ ceremony: "sign_in" }, async () => {
      const first = ceremony.assert(assertRequest())
      const cancel = new AbortController()
      const second = ceremony.assert(assertRequest({ signal: cancel.signal }))
      await sleep(2)
      const reason = new DOMException("the user cancelled", "AbortError")
      cancel.abort(reason)
      await expect(second).rejects.toBe(reason)
      settleFirst(assertionCredential())
      return first
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", route: "same_device" }),
    ])
  })

  it("counts a re-issue as the same prompt, timed from its first issue", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    get.mockImplementationOnce(() => {
      h.advance(5_000)
      return Promise.reject(pending())
    })
    get.mockImplementationOnce(() => {
      h.advance(500)
      return Promise.resolve(assertionCredential())
    })
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    expect(get).toHaveBeenCalledTimes(2)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", elapsed: "1_10s" }),
    ])
  })

  it("tells a run's listener of each issue of a re-issued request", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    get.mockImplementationOnce(() => Promise.reject(pending()))
    get.mockImplementationOnce(() => Promise.resolve(assertionCredential()))
    const heard: string[] = []
    await h.telemetry.begin({ ceremony: "sign_in" }).run(
      (own) => own(ceremony).assert(assertRequest()),
      undefined,
      (signal) => heard.push(signal.phase),
    )
    expect(heard).toEqual(["issued", "issued", "answered"])
  })

  it("keeps the provider of a creation that answered and then failed to decode", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(new BrowserPasskeyCeremony(timing, h.telemetry.requestHook))
    // Flags: attested data and backup eligible; then the iCloud id.
    const authData = new Uint8Array(37 + 16)
    authData[32] = 0x40 | 0x08
    authData.set(hexToBytes(APPLE_ICLOUD_AAGUID.replace(/-/g, "")), 37)
    const decodeError = new TypeError("detached ArrayBuffer")
    create.mockResolvedValue({
      id: "cred-1",
      authenticatorAttachment: "cross-platform",
      getClientExtensionResults: () => ({}),
      response: {
        get attestationObject(): never {
          throw decodeError
        },
        getAuthenticatorData: () => authData.buffer,
        getTransports: () => ["hybrid", "internal"],
      },
    })

    const error = await caught(
      h.telemetry.track({ ceremony: "create" }, () => ceremony.create(createRequest())),
    )
    expect(error).toBe(decodeError)
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "after_prompt",
        provider: "icloud_keychain",
        credential_created: "yes",
        route: "phone_qr",
        backup_eligible: "yes",
        prompts: "1",
      }),
    ])
    expect(h.telemetry.snapshot().provider).toBe("icloud_keychain")
    expect(JSON.stringify(h.sent)).not.toMatch(/detached|cred-1|fbfc3007/)
  })
})

describe("the drivers over a wrapped ceremony", () => {
  it("run as they do over the bare fake, and are counted", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      prfAtCreate: false,
      createAuthData: false,
      aaguid: GPM_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const ceremony = h.telemetry.wrap(fake)
    const challenge = new Uint8Array(32).fill(9)

    const created = await h.telemetry.track({ ceremony: "create" }, () =>
      runPasskeyCreation(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => challenge,
      }),
    )
    expect(created.chained).toBeDefined()
    expect(created.slot).toBe("first")
    expect(bytesToHex(created.prfOutput)).toBe(
      bytesToHex(fake.prfFor(created.created.credentialId, "first")),
    )
    expect(fake.creates[0]).toMatchObject({ authenticatorAttachment: "cross-platform" })
    expect(fake.assertRequests[0]).toMatchObject({
      credentialIds: [created.created.credentialId],
      challenge,
    })

    fake.opts.route = "local"
    const refused = h.telemetry.track({ ceremony: "sign_in" }, () =>
      runPasskeyAssertion(ceremony, {
        posture: "laptop",
        rpId: "localhost",
        challenge,
        credentialIds: [created.created.credentialId],
      }),
    )
    await expect(refused).rejects.toMatchObject({ name: "PhoneRequiredError" })

    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        provider: "google_password_manager",
        credential_created: "yes",
        route: "phone_qr",
        prompts: "2+",
        attempt: "1",
      }),
      expect.objectContaining({
        ceremony: "sign_in",
        outcome: "refused",
        reason: "phone_required",
        route: "same_device",
        prompts: "1",
        attempt: "2",
      }),
    ])
  })

  it("reports a key the browser lists no transports for on the security-key route", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      route: "cross-device",
      manager: "security-key",
      backupEligible: false,
      aaguid: ZERO_AAGUID,
      transports: [],
    })
    const created = await h.telemetry.track({ ceremony: "create" }, () =>
      runPasskeyCreation(h.telemetry.wrap(fake), {
        posture: "laptop",
        rpId: "localhost",
        rpName: "zk.money",
        userName: "@alice",
        challengeForChained: () => new Uint8Array(32).fill(9),
      }),
    )
    expect(created.securityKey).toBe(true)
    expect(h.sent).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        provider: "not_reported",
        credential_created: "yes",
        route: "security_key",
      }),
    ])
  })
})

describe("a browser that labels another device's answer as this one's", () => {
  const safariMac = (version: string): PasskeyTelemetryEnvironment => ({
    posture: "laptop",
    userAgent: parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
        `(KHTML, like Gecko) Version/${version} Safari/605.1.15`,
    }),
  })

  const on = (version: string) => {
    const environment = safariMac(version)
    return harness({
      environment: () => Promise.resolve(environment),
      syncEnvironment: () => environment,
    })
  }

  /** Safari's label on a phone or key answer inside the window: this laptop's own. */
  const MISLABELLED_ASSERT: PasskeyAnswerEvidence = {
    authenticatorAttachment: "platform",
    backupEligible: true,
  }
  const MISLABELLED_CREATE: PasskeyAnswerEvidence = {
    authenticatorAttachment: "platform",
    backupEligible: true,
    aaguid: APPLE_ICLOUD_AAGUID,
    transports: ["hybrid", "internal"],
  }

  const signIn = async (h: ReturnType<typeof harness>, answer: PasskeyAnswerEvidence) => {
    const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, [{ answer }]))
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
  }

  it("reports a sign-in it mislabels as the phone that answered", async () => {
    const h = on("18.6")
    await signIn(h, MISLABELLED_ASSERT)
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", route: "phone_qr", browser: "safari" }),
    ])
  })

  it("reports a sign-in a security key answered as a security key", async () => {
    const h = on("18.6")
    await signIn(h, { ...MISLABELLED_ASSERT, backupEligible: false })
    expect(h.sent).toEqual([
      expect.objectContaining({ outcome: "succeeded", route: "security_key" }),
    ])
  })

  it("reports a creation it mislabels as the phone over QR", async () => {
    const h = on("18.6")
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [{ answer: MISLABELLED_CREATE }]),
    )
    await h.telemetry.track({ ceremony: "create" }, () =>
      ceremony.create({ ...createRequest(), authenticatorAttachment: "cross-platform" }),
    )
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        credential_created: "yes",
        route: "phone_qr",
      }),
    ])
  })

  it("takes a build outside the window at its word", async () => {
    const above = on("26.4")
    await signIn(above, MISLABELLED_ASSERT)
    const below = on("18.5")
    await signIn(below, MISLABELLED_ASSERT)
    const chrome = harness()
    await signIn(chrome, MISLABELLED_ASSERT)
    for (const h of [above, below, chrome]) {
      expect(h.sent).toEqual([expect.objectContaining({ route: "same_device" })])
    }
  })

  it("leaves a phone alone, where the label is not in doubt", async () => {
    const environment: PasskeyTelemetryEnvironment = {
      posture: "phone",
      userAgent: parseUserAgent({ userAgent: SAFARI_IPHONE }),
    }
    const h = harness({
      environment: () => Promise.resolve(environment),
      syncEnvironment: () => environment,
    })
    await signIn(h, MISLABELLED_ASSERT)
    expect(h.sent).toEqual([
      expect.objectContaining({ route: "same_device", device_class: "phone" }),
    ])
  })
})

describe("where the passkey was made", () => {
  const MAC_QR: UserHandleProvenance = { context: "mac_qr", osVersion: {}, chip: "unknown" }
  const WINDOWS_KEY: UserHandleProvenance = {
    context: "windows_key",
    osVersion: {},
    chip: "unknown",
  }
  const handleMadeOn = (provenance?: UserHandleProvenance) => encodeUserHandle("@alice", provenance)
  /** The shape the web wrote before provenance: the name, then sixteen random bytes. */
  const LEGACY = new Uint8Array([
    ...new TextEncoder().encode("@alice"),
    0x00,
    ...new Uint8Array(16).fill(0x5a),
  ])

  /** One tracked attempt asserting once per step, then everything the tracker sent. */
  async function asserting(
    steps: Step[],
    context: PasskeyAttemptContext = { ceremony: "sign_in" },
  ) {
    const h = harness()
    const calls = steps.length
    const ceremony = h.telemetry.wrap(scripted(h.telemetry.requestHook, h.advance, steps))
    await caught(
      h.telemetry.track(context, async () => {
        for (let i = 0; i < calls; i++) await ceremony.assert(assertRequest())
      }),
    )
    return h.sent
  }

  it("names the context the answering passkey's handle claims", async () => {
    for (const ceremony of ["sign_in", "unlock"] as const) {
      const sent = await asserting([{ answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) }], {
        ceremony,
      })
      expect(sent).toEqual([
        expect.objectContaining({ ceremony, outcome: "succeeded", made_on: "mac_qr" }),
      ])
    }
  })

  it("says unknown for a handle written before provenance, or without any", async () => {
    for (const userHandle of [LEGACY, handleMadeOn()]) {
      const sent = await asserting([{ answer: LOCAL_ASSERT, userHandle }])
      expect(sent).toEqual([expect.objectContaining({ made_on: "unknown" })])
    }
  })

  it("reads the first answered assertion only", async () => {
    const none = await asserting([
      { answer: LOCAL_ASSERT },
      { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) },
    ])
    expect(none).toHaveLength(1)
    expect(none[0]).not.toHaveProperty("made_on")
    const first = await asserting([
      { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) },
      { answer: LOCAL_ASSERT, userHandle: handleMadeOn(WINDOWS_KEY) },
    ])
    expect(first).toEqual([expect.objectContaining({ made_on: "mac_qr" })])
  })

  it("keeps a creation's row to what answered it", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: QR_CREATE },
        { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) },
      ]),
    )
    await h.telemetry.track({ ceremony: "create" }, async () => {
      await ceremony.create(createRequest())
      await ceremony.assert(assertRequest())
    })
    const onlyAsserted = await asserting(
      [{ answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) }],
      {
        ceremony: "create",
      },
    )
    expect(h.sent).toEqual([
      expect.objectContaining({ ceremony: "create", credential_created: "yes" }),
    ])
    expect(onlyAsserted).toEqual([expect.objectContaining({ ceremony: "create" })])
    for (const row of [...h.sent, ...onlyAsserted]) expect(row).not.toHaveProperty("made_on")
  })

  it("carries it on an untracked assertion's row", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) },
      ]),
    )
    await ceremony.assert(assertRequest())
    expect(h.sent).toEqual([expect.objectContaining({ ceremony: "untracked", made_on: "mac_qr" })])
  })

  it("keeps it when the answer is refused afterwards, and has none when the call itself fails", async () => {
    const h = harness()
    const ceremony = h.telemetry.wrap(
      scripted(h.telemetry.requestHook, h.advance, [
        { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) },
        { answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR), error: new TypeError("x") },
      ]),
    )
    await caught(
      h.telemetry.track({ ceremony: "sign_in" }, async () => {
        await ceremony.assert(assertRequest())
        throw new UnsupportedProviderError("manager")
      }),
    )
    await caught(h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest())))
    expect(h.sent).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "provider_not_supported",
        made_on: "mac_qr",
      }),
      expect.objectContaining({ ceremony: "sign_in", prompts: "1" }),
    ])
    expect(h.sent[1]).not.toHaveProperty("made_on")
  })

  it("has none when the page closes between the answer and its result", async () => {
    const h = harness()
    const hook: PasskeyRequestHook = (signal) => {
      h.telemetry.requestHook(signal)
      if (signal.phase === "answered") h.pageHide()
    }
    const ceremony = h.telemetry.wrap(
      scripted(hook, h.advance, [{ answer: LOCAL_ASSERT, userHandle: handleMadeOn(MAC_QR) }]),
    )
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(assertRequest()))
    expect(h.sent).toEqual([expect.objectContaining({ outcome: "abandoned", prompts: "1" })])
    expect(h.sent[0]).not.toHaveProperty("made_on")
  })

  it("reads the handle a passkey was created with, and nothing when the assertion withholds it", async () => {
    const h = harness()
    const fake = new FakePasskeyCeremony({
      onRequest: h.telemetry.requestHook,
      aaguid: APPLE_ICLOUD_AAGUID,
    })
    const ceremony = h.telemetry.wrap(fake)
    const created = await ceremony.create({ ...createRequest(), provenance: MAC_QR })
    const request = () => assertRequest({ credentialIds: [created.credentialId] })
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(request()))
    fake.opts.assertHandle = false
    await h.telemetry.track({ ceremony: "sign_in" }, () => ceremony.assert(request()))
    expect(h.sent.map((row) => [row.ceremony, row.made_on])).toEqual([
      ["untracked", undefined],
      ["sign_in", "mac_qr"],
      ["sign_in", undefined],
    ])
    expect(h.sent[2]).not.toHaveProperty("made_on")
  })
})

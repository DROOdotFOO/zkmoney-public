/**
 * One `passkey_ceremony` event per passkey attempt. The ceremony's request hook reports every
 * native request, `wrap` ties each request to the call that made it, and attempt handles say what
 * the user was doing and how it ended. Nothing here throws into, waits on, or changes a ceremony.
 */

import type {
  PasskeyAnswerEvidence,
  PasskeyAssertRequest,
  PasskeyAttachment,
  PasskeyCeremony,
  PasskeyCreateRequest,
  PasskeyRequestHook,
  PasskeyRequestSignal,
} from "../ceremony/passkeyCeremony.js"
import { type NativeLockCall, nativeLockFor } from "../ceremony/nativeLock.js"
import { passkeyExtensionFor } from "../ceremony/passkeyCeremony.js"
import { decodeUserHandleProvenance } from "../ceremony/userHandle.js"
import { currentDevicePosture } from "../browser/devicePosture.js"
import {
  type PhoneReach,
  currentPlatformAuthenticator,
  mislabelledAssertion,
  mislabelledCreation,
  safariMislabelsCrossDevice,
} from "../browser/passkeyCapabilities.js"
import { providerSlugFor } from "../rules/passkeyProviders.js"
import { madeOnFor } from "../rules/provenance.js"
import {
  type PasskeyClassification,
  type PasskeyEnvironmentProps,
  type PasskeyErrorPredicate,
  type PasskeyTelemetrySnapshot,
  attemptBucketFor,
  backupEligibleFor,
  checkedPasskeyClassification,
  classifyPasskeyError,
  elapsedBucketFor,
  passkeyEnvironmentPropsFor,
  passkeyErrorNameFor,
  passkeyRouteFor,
  phoneReachFor,
  promptsBucketFor,
} from "./passkeyTelemetry.js"
import {
  PASSKEY_CEREMONIES,
  PASSKEY_EXTENSIONS,
  PASSKEY_FLOWS,
  PASSKEY_NATIVE_LOCKS,
  PASSKEY_PLATFORM_AUTHENTICATORS,
  PASSKEY_PROVIDERS,
  type PasskeyAttempt,
  type PasskeyBackupEligible,
  type PasskeyCeremonyKind,
  type PasskeyCredentialCreated,
  type PasskeyElapsed,
  type PasskeyErrorName,
  type PasskeyExtension,
  type PasskeyFlow,
  type PasskeyMadeOn,
  type PasskeyNativeLock,
  type PasskeyOutcome,
  type PasskeyPhoneReach,
  type PasskeyPlatformAuthenticator,
  type PasskeyPrompts,
  type PasskeyProvider,
  type PasskeyReason,
  type PasskeyRoute,
} from "./passkeyTelemetryVocabulary.js"
import { currentUserAgentInfo, parseUserAgent } from "../browser/userAgentInfo.js"

/** The props of one `passkey_ceremony` event. */
export type PasskeyCeremonyProps = {
  ceremony: PasskeyCeremonyKind
  flow?: PasskeyFlow
  outcome: PasskeyOutcome
  reason?: PasskeyReason
  provider: PasskeyProvider
  credential_created?: PasskeyCredentialCreated
  backup_eligible: PasskeyBackupEligible
  route: PasskeyRoute
  prompts: PasskeyPrompts
  attempt?: PasskeyAttempt
  elapsed?: PasskeyElapsed
  phone_reach?: PasskeyPhoneReach
  /** What the answering passkey's handle says about its creation; only on an assertion's row. */
  made_on?: PasskeyMadeOn
  /** On a failed row that ended on a thrown value: its name when listed, else `other`. */
  error_name?: PasskeyErrorName
  /** On a phone row once the probe has settled. */
  platform_authenticator?: PasskeyPlatformAuthenticator
  /** Which extension's script wraps the page's passkey creation, read as the row is sent. */
  extension?: PasskeyExtension
  /** What the page-start lock did to the browser's own `create` and `get`, read as the row is sent. */
  native_lock_create?: PasskeyNativeLock
  native_lock_get?: PasskeyNativeLock
} & PasskeyEnvironmentProps

export type PasskeyTelemetryEnvironment = Pick<PasskeyTelemetrySnapshot, "posture" | "userAgent">

export type PasskeyAttemptContext = {
  ceremony: Exclude<PasskeyCeremonyKind, "untracked">
  flow?: PasskeyFlow
}

/** Reads a resolved value as the refusal or failure it stands for; `undefined` is a success. */
export type PasskeyResultClassifier<T> = (result: T) => PasskeyClassification | undefined

/**
 * Reads a ceremony as the running attempt's own: every request made through what it returns belongs
 * to that attempt, however long after the run started it is made — a chained assertion included.
 */
export type PasskeyRequestScope = (ceremony: PasskeyCeremony) => PasskeyCeremony

/** Hears the request signals of one run's own requests. */
export type PasskeyRequestListener = (signal: PasskeyRequestSignal) => void

/**
 * One user attempt. Every method is a no-op once the attempt has ended, except `run` and
 * `notePhoneReach`.
 */
export type PasskeyAttemptHandle = {
  /**
   * Runs `fn` as this attempt, which ends when it settles. Returns or throws what `fn` does. A run
   * that starts after the attempt ended is the next attempt of the same kind; one still in flight
   * when its attempt ends keeps its requests, and they send nothing. `onRequest` hears the signals
   * of the requests made through this run's scope, and of no others, however late they arrive.
   */
  run<T>(
    fn: (own: PasskeyRequestScope) => Promise<T>,
    classify?: PasskeyResultClassifier<T>,
    onRequest?: PasskeyRequestListener,
  ): Promise<T>
  /**
   * What a laptop's phone-route check answered. Every event this handle sends afterwards carries
   * it, later runs included; an event already sent is not changed.
   */
  notePhoneReach(reach: PhoneReach): void
  /** Ends the attempt with an outcome no request produced. */
  end(outcome: PasskeyClassification): void
  /** The user cancelled in the app. */
  userCancelled(): void
  /** A newer attempt replaced this one. */
  superseded(): void
  /** The screen that owned this attempt went away. */
  unmounted(): void
}

export type PasskeyTelemetryOptions = {
  /** The front's transport. Called synchronously; whatever it throws or rejects is ignored. */
  send: (props: PasskeyCeremonyProps) => void
  /** The front's own error names and tests, tried after the policy's. */
  extraNames?: Readonly<Record<string, PasskeyClassification>>
  extraPredicates?: readonly PasskeyErrorPredicate[]
  now?: () => number
  /** The full environment, Client Hints included; read once, when the tracker is created. */
  environment?: () => Promise<PasskeyTelemetryEnvironment>
  /** What an event or snapshot uses until `environment` resolves. */
  syncEnvironment?: () => PasskeyTelemetryEnvironment
  /**
   * What a phone's platform-authenticator check answers. Started once, when the tracker is created
   * on a phone; nothing waits on it, so a row sent before it settles carries no answer.
   */
  platformAuthenticator?: () => Promise<PasskeyPlatformAuthenticator>
  /** Which extension's script wraps the page's creation; read once per row, as it is sent. */
  extension?: () => PasskeyExtension
  /** What the page-start lock recorded for a call; read once per row, as it is sent. */
  nativeLock?: (call: NativeLockCall) => PasskeyNativeLock | undefined
  /** The provider a snapshot names before any request of this page load. */
  fallbackProvider?: () => PasskeyProvider
  pageHideTarget?: EventTarget
}

export type PasskeyTelemetry = {
  /** Pass to `BrowserPasskeyCeremony`. */
  requestHook: PasskeyRequestHook
  /** Requests made through it belong to the newest attempt open when each one is made. */
  wrap(ceremony: PasskeyCeremony): PasskeyCeremony
  begin(context: PasskeyAttemptContext): PasskeyAttemptHandle
  /** `begin(context).run(fn, classify)`. */
  track<T>(
    context: PasskeyAttemptContext,
    fn: (own: PasskeyRequestScope) => Promise<T>,
    classify?: PasskeyResultClassifier<T>,
  ): Promise<T>
  /** The environment and the provider of the credential the latest request targeted. */
  snapshot(): PasskeyTelemetrySnapshot
}

type EndCause = "userCancelled" | "superseded" | "unmounted"

type Call = {
  kind: PasskeyRequestSignal["kind"]
  attempt: Attempt
  /** First `issued`; a re-issue keeps it. */
  issuedAt?: number
  settledAt?: number
  evidence?: PasskeyAnswerEvidence
  /** Creation only: the class the request asked for, which the mislabel gate reads. */
  requested?: PasskeyAttachment
  /** Assertion only: what the answering passkey's handle claims, read once the result is in. */
  madeOn?: PasskeyMadeOn
  /** The run whose scope made this request. */
  listener?: PasskeyRequestListener
}

type IssuedCall = Call & { issuedAt: number }

type Attempt = {
  ceremony: PasskeyCeremonyKind
  flow?: PasskeyFlow
  /** Begun by a caller, as opposed to a lone call outside any attempt. */
  tracked: boolean
  calls: Call[]
  firstAnswered?: Call
  /** This page load's count of attempts that issued a request, taken at its first. */
  number?: number
  cause?: EndCause
  /** A run is in flight; its settle ends the attempt. */
  running: boolean
  /** Its event is decided; requests its run still makes are silent. */
  closed: boolean
  phoneReach?: PasskeyPhoneReach
}

type Ending =
  | { kind: "succeeded" }
  | {
      kind: "failed"
      classification: () => PasskeyClassification | undefined
      /** Set when a thrown value ended the attempt. */
      errorName?: PasskeyErrorName
    }
  | { kind: "pagehide" }

const SUCCEEDED: Ending = { kind: "succeeded" }
/** Ended with no outcome of its own: only a recorded cause can speak for it. */
const STOPPED: Ending = { kind: "failed", classification: () => undefined }

const UNKNOWN_ENVIRONMENT: PasskeyTelemetryEnvironment = {
  posture: "laptop",
  userAgent: parseUserAgent({ userAgent: "" }),
}

const listed = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value)

function quiet<T>(action: () => T): T | undefined {
  try {
    return action()
  } catch {
    return undefined
  }
}

const defaultNow = () => (typeof performance === "undefined" ? Date.now() : performance.now())

const defaultEnvironment = async (): Promise<PasskeyTelemetryEnvironment> => ({
  posture: currentDevicePosture(),
  userAgent: await currentUserAgentInfo(),
})

const defaultSyncEnvironment = (): PasskeyTelemetryEnvironment => ({
  posture: currentDevicePosture(),
  userAgent: parseUserAgent({
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent ?? "",
  }),
})

const defaultPageHideTarget = (): EventTarget | undefined => {
  const target = globalThis as Partial<EventTarget>
  return typeof target.addEventListener === "function" &&
    typeof target.removeEventListener === "function"
    ? (target as EventTarget)
    : undefined
}

export function createPasskeyTelemetry(options: PasskeyTelemetryOptions): PasskeyTelemetry {
  const now = options.now ?? defaultNow
  const syncEnvironment = options.syncEnvironment ?? defaultSyncEnvironment
  const pageHideTarget = options.pageHideTarget ?? defaultPageHideTarget()

  let environment: PasskeyTelemetryEnvironment | undefined
  quiet(() =>
    Promise.resolve((options.environment ?? defaultEnvironment)()).then(
      (value) => void (environment = value ?? environment),
      () => {},
    ),
  )

  const calls = new WeakMap<object, Call>()
  /** Begun attempts that are open or still running, oldest first; a new call joins the last. */
  const open: Attempt[] = []
  /** Every attempt not yet closed, lone calls included. */
  const live = new Set<Attempt>()
  const promptFreeSent = new Set<string>()
  let attemptsIssued = 0
  let issuedAny = false
  let latestAaguid: string | undefined
  /** Held in memory only: credential ids never leave the tracker. */
  const credentialAaguids = new Map<string, string | undefined>()

  const currentEnvironment = () => environment ?? quiet(syncEnvironment) ?? UNKNOWN_ENVIRONMENT

  let platformAuthenticator: PasskeyPlatformAuthenticator | undefined
  if (quiet(syncEnvironment)?.posture === "phone") {
    quiet(() =>
      Promise.resolve((options.platformAuthenticator ?? currentPlatformAuthenticator)()).then(
        (value) => {
          if (listed(PASSKEY_PLATFORM_AUTHENTICATORS, value)) platformAuthenticator = value
        },
        () => {},
      ),
    )
  }

  const onPageHide = () => {
    for (const attempt of [...live]) quiet(() => finish(attempt, { kind: "pagehide" }))
  }

  function openAttempt(context: Pick<Attempt, "ceremony" | "flow">, tracked: boolean): Attempt {
    const attempt: Attempt = { ...context, tracked, calls: [], running: false, closed: false }
    if (tracked) open.push(attempt)
    live.add(attempt)
    if (live.size === 1) quiet(() => pageHideTarget?.addEventListener("pagehide", onPageHide))
    return attempt
  }

  function close(attempt: Attempt): void {
    attempt.closed = true
    if (!attempt.running) release(attempt)
    live.delete(attempt)
    if (live.size === 0) quiet(() => pageHideTarget?.removeEventListener("pagehide", onPageHide))
  }

  /** New calls stop joining the attempt. */
  function release(attempt: Attempt): void {
    const index = open.indexOf(attempt)
    if (index >= 0) open.splice(index, 1)
  }

  const issuedCalls = (attempt: Attempt): IssuedCall[] =>
    attempt.calls.filter((c): c is IssuedCall => c.issuedAt !== undefined)

  const failure = (attempt: Attempt, error: unknown): Ending => ({
    kind: "failed",
    classification: () =>
      classifyPasskeyError(error, {
        issued: issuedCalls(attempt).length > 0,
        answered: attempt.firstAnswered !== undefined,
        extraNames: options.extraNames,
        extraPredicates: options.extraPredicates,
      }),
    errorName: passkeyErrorNameFor(error),
  })

  /** Closes the attempt and sends what its ending means, if anything. */
  function finish(attempt: Attempt, ending: Ending): void {
    if (attempt.closed) return
    close(attempt)
    if (ending.kind === "succeeded") {
      if (issuedCalls(attempt).length > 0) emit(attempt, "succeeded")
      return
    }
    if (attempt.cause === "userCancelled") return emit(attempt, "cancelled", "in_app_cancel")
    if (attempt.cause) return
    if (ending.kind === "pagehide") return emit(attempt, "abandoned")
    const classification = checkedPasskeyClassification(ending.classification())
    if (classification) {
      emit(attempt, classification.outcome, classification.reason, ending.errorName)
    }
  }

  /**
   * The answer's class as the device it came from, not as the browser labelled it. Inside the
   * window Safari calls another device's answer this laptop's own, and a route that reads the
   * label verbatim counts a phone or a security key as same-device. The drivers read the same
   * answer through the same two gates before the policy sees it.
   */
  function routeEvidence(call: Call, env: PasskeyTelemetryEnvironment): PasskeyAnswerEvidence {
    const evidence = call.evidence ?? {}
    const misreportsCrossDevice = quiet(() => safariMislabelsCrossDevice(env.userAgent))
    const mislabelled =
      call.kind === "create"
        ? mislabelledCreation({
            reported: evidence,
            requested: call.requested,
            misreportsCrossDevice,
          })
        : mislabelledAssertion({
            reportedAttachment: evidence.authenticatorAttachment,
            posture: env.posture,
            misreportsCrossDevice,
          })
    return mislabelled ? { ...evidence, authenticatorAttachment: "cross-platform" } : evidence
  }

  function emit(
    attempt: Attempt,
    outcome: PasskeyOutcome,
    reason?: PasskeyReason,
    errorName?: PasskeyErrorName,
  ): void {
    const issued = issuedCalls(attempt)
    if (issued.length === 0) {
      const key = `${attempt.ceremony}:${attempt.flow ?? ""}:${outcome}:${reason ?? ""}`
      if (promptFreeSent.has(key)) return
      promptFreeSent.add(key)
    }
    const creates = attempt.calls.filter((call) => call.kind === "create")
    const created = creates.find((call) => call.evidence)
    const createIssued = creates.some((call) => call.issuedAt !== undefined)
    const answered = attempt.firstAnswered
    const last = issued.reduce<IssuedCall | undefined>(
      (latest, call) => (latest && latest.issuedAt > call.issuedAt ? latest : call),
      undefined,
    )
    const env = currentEnvironment()
    const extension = quiet(() => (options.extension ?? passkeyExtensionFor)())
    const nativeLock = options.nativeLock ?? nativeLockFor
    const lockCreate = quiet(() => nativeLock("create"))
    const lockGet = quiet(() => nativeLock("get"))
    const props: PasskeyCeremonyProps = {
      ceremony: attempt.ceremony,
      ...(attempt.flow ? { flow: attempt.flow } : {}),
      outcome,
      ...(reason ? { reason } : {}),
      provider: created ? providerSlugFor(created.evidence?.aaguid) : "unknown",
      ...(created
        ? { credential_created: "yes" as const }
        : createIssued
        ? { credential_created: "no" as const }
        : {}),
      backup_eligible: backupEligibleFor(answered?.evidence),
      route: answered ? passkeyRouteFor(answered.kind, routeEvidence(answered, env)) : "unknown",
      prompts: promptsBucketFor(issued.length),
      ...(attempt.number === undefined ? {} : { attempt: attemptBucketFor(attempt.number) }),
      ...(last ? { elapsed: elapsedBucketFor((last.settledAt ?? now()) - last.issuedAt) } : {}),
      ...(attempt.phoneReach ? { phone_reach: attempt.phoneReach } : {}),
      // A creation's row says what answered it; only an assertion's row says what its passkey claims.
      ...(attempt.ceremony !== "create" && answered?.kind === "assert" && answered.madeOn
        ? { made_on: answered.madeOn }
        : {}),
      ...(errorName && outcome === "failed" ? { error_name: errorName } : {}),
      ...(platformAuthenticator && env.posture === "phone"
        ? { platform_authenticator: platformAuthenticator }
        : {}),
      ...(listed(PASSKEY_EXTENSIONS, extension) ? { extension } : {}),
      ...(listed(PASSKEY_NATIVE_LOCKS, lockCreate) ? { native_lock_create: lockCreate } : {}),
      ...(listed(PASSKEY_NATIVE_LOCKS, lockGet) ? { native_lock_get: lockGet } : {}),
      ...passkeyEnvironmentPropsFor(env),
    }
    quiet(() => Promise.resolve(options.send(props)).catch(() => {}))
  }

  /** An assertion naming exactly one credential this tracker knows; anything else is unknown. */
  function targetedAaguid(signal: PasskeyRequestSignal): string | undefined {
    const ids = signal.kind === "assert" ? signal.request.credentialIds : undefined
    return ids?.length === 1 ? credentialAaguids.get(ids[0]!) : undefined
  }

  function hear(signal: PasskeyRequestSignal): void {
    const call = calls.get(signal.request)
    const listener = call?.listener
    if (listener) quiet(() => listener(signal))
    if (signal.phase === "issued") {
      issuedAny = true
      latestAaguid = targetedAaguid(signal)
      if (!call || call.issuedAt !== undefined) return
      call.issuedAt = now()
      if (!call.attempt.closed) call.attempt.number ??= ++attemptsIssued
      return
    }
    if (signal.kind === "create") latestAaguid = signal.evidence?.aaguid
    if (!call || call.evidence) return
    call.evidence = signal.evidence ?? {}
    if (signal.kind === "create") call.requested = signal.request.authenticatorAttachment
    call.attempt.firstAnswered ??= call
  }

  function startCall(
    kind: Call["kind"],
    request: object,
    owner?: Attempt,
    listener?: PasskeyRequestListener,
  ): Call {
    // A call with no scope joins whichever attempt is newest when it is made, which is all a call
    // made outside a run can be read as. A run's own requests take its scope and stay its.
    const attempt = owner ?? open.at(-1) ?? openAttempt({ ceremony: "untracked" }, false)
    const call: Call = { kind, attempt, listener }
    attempt.calls.push(call)
    calls.set(request, call)
    return call
  }

  function settleCall(call: Call, settled: { result: unknown } | { error: unknown }): void {
    call.settledAt = now()
    if ("result" in settled && call.kind === "create" && call.evidence) {
      const id = (settled.result as { credentialId?: unknown } | undefined)?.credentialId
      if (typeof id === "string") credentialAaguids.set(id, call.evidence.aaguid)
    }
    // The handle names the account, so only the enum it decodes to is kept.
    if ("result" in settled && call.kind === "assert") {
      const handle = (settled.result as { userHandle?: unknown } | undefined)?.userHandle
      if (handle instanceof Uint8Array) call.madeOn = madeOnFor(decodeUserHandleProvenance(handle))
    }
    if (call.attempt.tracked) return
    finish(call.attempt, "result" in settled ? SUCCEEDED : failure(call.attempt, settled.error))
  }

  async function watched<R extends PasskeyCreateRequest | PasskeyAssertRequest, T>(
    kind: Call["kind"],
    request: R,
    owner: Attempt | undefined,
    invoke: (request: R) => Promise<T>,
    listener?: PasskeyRequestListener,
  ): Promise<T> {
    const copy = { ...request }
    const call = quiet(() => startCall(kind, copy, owner, listener))
    let result: T
    try {
      result = await invoke(copy)
    } catch (error) {
      if (call) quiet(() => settleCall(call, { error }))
      throw error
    }
    if (call) quiet(() => settleCall(call, { result }))
    return result
  }

  /** The browser behind a ceremony this tracker wrapped, so a scope can ask the same one. */
  const browsers = new WeakMap<PasskeyCeremony, PasskeyCeremony>()

  function wrapping(
    inner: PasskeyCeremony,
    owner?: Attempt,
    listener?: PasskeyRequestListener,
  ): PasskeyCeremony {
    const ceremony: PasskeyCeremony = {
      create: (request) =>
        watched("create", request, owner, (copy) => inner.create(copy), listener),
      assert: (request) =>
        watched("assert", request, owner, (copy) => inner.assert(copy), listener),
    }
    quiet(() => browsers.set(ceremony, inner))
    return ceremony
  }

  const scopeFor =
    (owner: Attempt, listener?: PasskeyRequestListener): PasskeyRequestScope =>
    (ceremony) =>
      quiet(() => wrapping(browsers.get(ceremony) ?? ceremony, owner, listener)) ?? ceremony

  function begin(context: PasskeyAttemptContext): PasskeyAttemptHandle {
    const of: Pick<Attempt, "ceremony" | "flow"> = {
      ceremony: listed(PASSKEY_CEREMONIES, context.ceremony) ? context.ceremony : "untracked",
      flow: listed(PASSKEY_FLOWS, context.flow) ? context.flow : undefined,
    }
    /** What the handle speaks for; a run started after it ended speaks for the next one. */
    let attempt = quiet(() => openAttempt(of, true))
    let phoneReach: PasskeyPhoneReach | undefined
    const ended = () => !attempt || attempt.closed

    // The first cause stays. Replacing or unmounting an attempt with no run ends it there.
    const mark = (cause: EndCause) =>
      quiet(() => {
        if (ended()) return
        attempt!.cause ??= cause
        if (cause !== "userCancelled" && !attempt!.running) finish(attempt!, STOPPED)
      })

    return {
      async run<T>(
        fn: (own: PasskeyRequestScope) => Promise<T>,
        classify?: PasskeyResultClassifier<T>,
        onRequest?: PasskeyRequestListener,
      ): Promise<T> {
        if (ended()) {
          attempt = quiet(() => openAttempt(of, true))
          if (attempt) attempt.phoneReach = phoneReach
        }
        const owner = attempt
        if (!owner) return fn((ceremony) => ceremony)
        owner.running = true
        let result: T
        try {
          result = await fn(scopeFor(owner, onRequest))
        } catch (error) {
          quiet(() => finish(owner, failure(owner, error)))
          throw error
        } finally {
          owner.running = false
          if (owner.closed) release(owner)
        }
        quiet(() => {
          const classification = checkedPasskeyClassification(quiet(() => classify?.(result)))
          finish(
            owner,
            classification ? { kind: "failed", classification: () => classification } : SUCCEEDED,
          )
        })
        return result
      },
      notePhoneReach: (reach) =>
        quiet(() => {
          phoneReach = phoneReachFor(reach)
          if (!ended()) attempt!.phoneReach = phoneReach
        }),
      end: (outcome) =>
        quiet(() => {
          if (!ended()) finish(attempt!, { kind: "failed", classification: () => outcome })
        }),
      userCancelled: () => mark("userCancelled"),
      superseded: () => mark("superseded"),
      unmounted: () => mark("unmounted"),
    }
  }

  return {
    requestHook: (signal) => void quiet(() => hear(signal)),
    wrap: (inner) => wrapping(inner),
    begin,
    track: (context, fn, classify) => begin(context).run(fn, classify),
    snapshot() {
      const { posture, userAgent } = currentEnvironment()
      if (issuedAny) {
        return {
          posture,
          userAgent,
          provider: providerSlugFor(latestAaguid),
          ...(latestAaguid ? { aaguid: latestAaguid } : {}),
        }
      }
      const fallback = quiet(() => options.fallbackProvider?.())
      return {
        posture,
        userAgent,
        provider: listed(PASSKEY_PROVIDERS, fallback) ? fallback : "unknown",
      }
    },
  }
}

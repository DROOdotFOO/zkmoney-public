import { leavePage } from "../../platform/storage/walletStorage"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import type { Hex } from "viem"
import {
  PasskeyEnvelopeError,
  StoredAddressMismatchError,
  composeWireNameHash,
  normalizeTag,
  useContractServiceContext,
  useResource,
  WalletError,
} from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"
import { failureCode, fireEvent, fireOnboardingEvent, reportLanding } from "../../lib/analytics"
import { firstInTab } from "../../lib/trafficSource"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import {
  NoWalletForPasskeyError,
  PHONE_STEPS_COPY,
  currentDevicePosture,
  currentMacCopyMayBeWrong,
  currentUserAgentInfoSync,
  type ExtensionAdvice,
  passkeyExtensionFor,
  inAppBrowserRefusal,
  isPasskeyPolicyError,
  type PasskeyAttemptHandle,
  type PasskeyClassification,
} from "@obsidion/passkey-web"
import { peekAuthService } from "../../platform/auth/useAuthenticator"
import { handOffAccount, servesAnotherAccount, useSession } from "../../platform/session"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { EndpointsModal } from "../../ui/EndpointsModal"
import { useHoldEndpoints } from "../../ui/endpointsHold"
import { useAsyncAction, useNextRoute } from "../../ui/hooks"
import { type CeremonyGate, isGateCancelled, useCeremonyGate } from "../identity/ceremonyGate"
import { InAppBrowserNotice } from "../identity/InAppBrowserNotice"
import { walletInAppUpFront } from "../identity/inAppUpFront"
import { IosFloorNotice } from "../identity/IosFloorNotice"
import {
  DIFFERENT_PASSKEY,
  GRANTED_REGISTRATION,
  INCONCLUSIVE,
  NO_PASSKEY_RECORDED,
  NOT_REPRODUCED_HERE,
  PASSKEY_KEY_MISMATCH,
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
  PasskeyRefusal,
  isPasskeyNotOffered,
  REGISTRY_UNANCHORED,
  RESERVED_REGISTRATION,
  SET_UNREAD,
  STORED_ADDRESS_MISMATCH,
  promptCauses,
  type RouteRefusal,
} from "../identity/PasskeyRefusal"
import { GateStep } from "../identity/PhoneSteps"
import { saveWalletIdentity } from "../identity/walletIdentity"
import {
  mismatchVerdictOf,
  observedOf,
  type Observation,
} from "../../platform/auth/WebAlphaAuthService"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import {
  hasOpeningBreadcrumb,
  listRetiredUsertagCandidates,
  listUsertagCandidates,
  usertagFor,
  walletKeysFor,
  type RememberedAccount,
} from "../../platform/auth/WebPasskeyIdentityMap"
import { resolveSignInTag } from "../contacts/registryResolution"
import { peekClaimStash } from "../paylink/claimStash"
import { linkIdentity } from "../paylink/linkIdentity"
import { isTicketSignupCreating, loadTicketSignupAttempt } from "../paylink/ticketSignupAccount"
import { hasConnectStash } from "../contacts/connectReceive"
import {
  BY_TAG_FAILURE_CODES,
  diagnoseMiss,
  diagnoseUnknown,
  lookupPasskeyByTag,
  type MissDiagnosis,
  type UnknownDiagnosis,
} from "./findPasskeyByTag"
import {
  PasskeyMismatchError,
  PasskeySetUnreadError,
  checkpointRegistrationTerms,
  claimTag,
  collectOnboardingKeys,
  confirmTag,
  enterWithPasskey,
  isCommittedFailure,
  nameGrantToken,
  reservedTagMatch,
  type EnteredClaim,
  type EnterResult,
} from "./oxideOnboarding"
import { boundNameGrantOwner, reservedNameHashes } from "./recoveryProbes"
import { confirmRegistrationTag } from "./openRegistration"
import { getPendingStore } from "./webRegistration"
import { probeNameAvailability } from "./nameAvailability"
import { saveRegistrationTerms } from "./registrationTerms"
import { InvitationChrome } from "./InvitationChrome"
import { OnboardingSpinnerBody } from "./OnboardingCard"
import { type AccountFound, type Found, keyOptions, oneRowPerWallet, useRowKeys } from "./rowKeys"
import { ConfirmTagModal, type ByTagNotice } from "./steps/ConfirmTagModal"
import { CreateWalletStep } from "./steps/CreateWalletStep"

// How the passkey was picked: the browser's list, or pinned to a typed tag or a remembered account.
const LOGIN_METHODS = { "enter": "chooser", "enter:by-tag": "pinned" } as const
type LoginMethod = (typeof LOGIN_METHODS)[Entry["action"]]

/** A failed login: `action_failed` for a consenting browser, and an identifier-free funnel count. */
function failEntry(props: { action: Entry["action"]; code: string }) {
  fireEvent("action_failed", props)
  fireOnboardingEvent("login_failed", { method: LOGIN_METHODS[props.action], code: props.code })
}

type Unclaimed = Extract<EnterResult, { reason: "unclaimed" }>

/** Which sign-in a result came from, and the tag it selected, for the branches shared by both. */
type Entry = {
  op: AbortController
  tag: string
  action: "enter" | "enter:by-tag"
  /** The tag's account, on the pinned path only. */
  l2Address?: string
  /** The L1 read found keys beyond the one pinned, on the pinned path only; unset when there was no read. */
  moreKeys?: boolean
}

/** What the refusal card's retry re-runs: whichever action ran last, steered to the phone or not. */
type LastAction =
  | { kind: "probe" }
  | { kind: "enter"; phone?: boolean }
  | ({ kind: "pinned"; phone?: boolean } & Found)
  | { kind: "bound-grant"; result: Unclaimed; entry: Omit<Entry, "op"> }
  | { kind: "nameless"; result: Unclaimed; entry: Omit<Entry, "op"> }

/**
 * `committed` marks a refusal raised after an account was committed and its signup may hold a tag,
 * whose ways on are its retry and the signup it continues; `probeCommitted` one raised after the
 * arrival probe committed a registered account and a later write failed, whose only ways on are
 * re-probing and the cancel. `resumeTag` names the reservation whose card's way on picks it back up.
 */
type Refusal = RouteRefusal & {
  committed?: boolean
  probeCommitted?: boolean
  resumeTag?: string
}

/** How long a pause in typing waits before the tag is read. */
export const RESOLVE_DEBOUNCE_MS = 400

/**
 * Cards whose retry would run the same attempt again: the screen is where the user tries again —
 * the row, the tag, or Show passkeys — so these offer Back and the cancel instead.
 */
const NO_RETRY = new Set<string>([
  "NoWalletForPasskeyError",
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
  "PasskeyMismatchError",
  PASSKEY_KEY_MISMATCH,
  DIFFERENT_PASSKEY,
  NOT_REPRODUCED_HERE,
  INCONCLUSIVE,
  NO_PASSKEY_RECORDED,
  SET_UNREAD,
])

/**
 * A Windows sign-in refused for want of key material, where this computer answered, gets the
 * 1Password advice: its Windows app returns none, its browser extension does. A sign-in cannot
 * name what answered, so the line is advice beside the refusal; its wording follows whether the
 * script answering the page's passkey creation is 1Password's.
 */
function extensionAdviceFor(e: {
  name: string
  observed?: Observation
}): ExtensionAdvice | undefined {
  if (e.name !== "NoPrfError" || e.observed?.attachment !== "platform") return undefined
  if (currentUserAgentInfoSync().osFamily !== "windows") return undefined
  return passkeyExtensionFor() === "1password" ? "use" : "install"
}

/**
 * A card for a miss that may be this Mac's own copy returning the wrong key suggests a macOS
 * update and, where `lead`, leads with the phone.
 */
const macHelpFor = (observed: Observation | undefined, lead = false): Partial<Refusal> =>
  currentMacCopyMayBeWrong(observed) ? { macUpdate: true, ...(lead ? { macPhone: true } : {}) } : {}

/** The card for a record this browser holds that the passkey no longer reproduces. */
function mismatchRefusal(e: unknown): Refusal {
  const verdict = mismatchVerdictOf(e)
  return {
    name: STORED_ADDRESS_MISMATCH,
    message: "",
    verdict,
    ...macHelpFor(observedOf(e), verdict === "wrong-key"),
  }
}

/** The card each tag-diagnosis verdict shows. The chain marks no root, so it never asserts divergence. */
function missDiagnosisCard(diagnosis: MissDiagnosis, tag: string): Refusal | undefined {
  switch (diagnosis) {
    case "REGISTRY_UNANCHORED":
      return {
        name: REGISTRY_UNANCHORED,
        message: `This passkey is on @${tag}'s account, but its record couldn't be confirmed yet. Try again.`,
      }
    case "NOT_REPRODUCED_HERE":
      return {
        name: NOT_REPRODUCED_HERE,
        message: `This passkey is listed for @${tag}, but this attempt didn't open its wallet. Go back, then choose Show passkeys to use your phone or a security key.`,
      }
    case "DIFFERENT_PASSKEY":
      return {
        name: DIFFERENT_PASSKEY,
        message: `This isn't a passkey on @${tag}'s account. Go back and check the tag, or choose Show passkeys to pick one of @${tag}'s passkeys.`,
      }
    case "INCONCLUSIVE":
      return {
        name: INCONCLUSIVE,
        message: `Couldn't confirm which passkey this is — @${tag}'s account has more keys than we can read. Go back, then choose Show passkeys to use your phone or a security key.`,
      }
    // notFound / staleRollup / noKeyInstalled / unreadable: the screen's inline notices handle these.
    default:
      return undefined
  }
}

/** A nameless account's claims as account-service holds them, the tag the attempt carried, and the
 *  attempt itself, so the tag the user confirms picks the signup up in place. */
type Reserved = {
  nameHashes: Hex[]
  ensDomain: string
  tag: string
  result: Unclaimed
  action: Entry["action"]
}

/** The refusal row (by error name) each reading of a pinned `unknown` shows. */
const DIAGNOSIS_ROWS: Record<Exclude<UnknownDiagnosis, "LOCAL_COPY_WRONG_KEY">, string> = {
  REGISTRY_UNANCHORED,
  PASSKEY_KEY_MISMATCH,
}

const NETWORK_MESSAGE = "Couldn't check this passkey against the network. Try again."

/** The card a matched reservation shows before the signup picks it back up. */
const reservedCard = (tag: string): Refusal => ({
  name: RESERVED_REGISTRATION,
  message: `@${tag} is reserved for this passkey, but the signup that claims it never finished, so there is no wallet to open yet. Pick it back up to finish.`,
  resumeTag: tag,
})

/**
 * What a sign-in result means for its passkey attempt. `unknown` found no wallet, or, pinned to a
 * tag's account, is read the way the refusal card reads it. Every other result succeeded.
 */
const enterOutcome =
  (pinnedTo?: string) =>
  (result: EnterResult): PasskeyClassification | undefined => {
    if (result.entered || result.reason !== "unknown") return undefined
    if (pinnedTo === undefined) return { outcome: "refused", reason: "no_wallet_for_passkey" }
    return diagnoseUnknown(result, pinnedTo) === "REGISTRY_UNANCHORED"
      ? { outcome: "failed", reason: "registry_unconfirmed" }
      : { outcome: "refused", reason: "passkey_mismatch" }
  }

/**
 * `raw` as a path inside this wallet, or undefined: parsed the way the browser will, so `//host`,
 * `/\host` and control characters the parser strips cannot name another origin.
 */
function walletPath(raw: string | undefined): string | undefined {
  if (!raw?.startsWith("/")) return undefined
  try {
    const url = new URL(raw, location.origin)
    // A normalized path can still start `//` (via `..` or `%2e`), which a later navigation would
    // read as protocol-relative.
    if (url.origin !== location.origin || url.pathname.startsWith("//")) return undefined
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

/**
 * Returning user (/enter). As soon as the wallet is ready an arrival probe tries the ceremony-free
 * sources: a cached key enters with no screen and no prompt. Otherwise the sign-in screen: the
 * accounts this browser remembers, one click each; a tag field that resolves as it is typed, whose
 * Login pins the tag's passkey; and "Show passkeys" for the browser's full chooser. Every prompt
 * opens on a tap, never on the tail of a read — the screen prepares (manifest, the one cache proof)
 * before its buttons are live, and a tap-driven entry never restores the cache. The assertion
 * re-derives the account, the anchors decide, and the claim is found on the L1 Registry; when no
 * tag names it, the confirm step asks for the handle, only to NAME the claim (the chain stores its
 * hash). A refusal stays here with the reason, Back to the screen and the cancel: none of them is a
 * reason to create an account. Every action runs under its own AbortController; the user's cancel
 * aborts it, and a result arriving after that is dropped — unless the account was already
 * committed, which is the point of no return: an entry completes, and a moved session reloads.
 */
export function EnterAppScreen() {
  const navigate = useNavigate()
  useEffect(() => {
    reportLanding("login")
    if (firstInTab("login_opened")) fireOnboardingEvent("login_opened")
  }, [])
  const [params] = useSearchParams()
  const config = getConfig()
  const obsidionWallet = useResource(useSession().wallet)
  const { contractService } = useContractServiceContext()
  // Router state normally, and the URL when this screen replaced its own document. Only a path
  // inside the wallet counts: as a URL the destination is anyone's to write.
  const next = walletPath(useNextRoute() ?? params.get("next") ?? undefined)
  const handle = normalizeTag(params.get("handle") ?? "") ?? ""
  /** The passkey's own name, carried over a reload; it names a reservation but never fills the field. */
  const passkeyName = params.get("named") ?? undefined
  const boundGrantToken = handle && params.get("bound") === "1" ? nameGrantToken(handle) : undefined
  // `strict=1`: a by-tag entry reloaded after switching accounts; only the URL's tag names the claim.
  const strict = params.get("strict") === "1"
  // `?choose=1`: the user asked for a different passkey, so no cached key answers and Show passkeys
  // leads the screen; `avoid` names a credential whose row the screen hides (it just failed).
  const chooser = params.get("choose") === "1"
  const avoid = params.get("avoid") ?? undefined
  // `pick` names a remembered row whose keys the screen opens with: the unlock pane's way to a key
  // this browser holds no record of.
  const pick = params.get("pick") ?? undefined
  // Dev-only `/enter?mock=confirm`: opens the confirm-tag modal with no passkey prompt.
  const mock = import.meta.env.DEV && params.get("mock") === "confirm"
  const [confirming, setConfirming] = useState(mock)
  // A stashed paylink is why most visitors reach this screen. Say so, so the passkey prompt reads
  // as the step between them and the money rather than an unexplained interruption.
  const [claimPending] = useState(() => !!peekClaimStash())
  const [connectPending] = useState(() => hasConnectStash())
  const [error, setError] = useState<string>()
  // `name` is the error's stable name (`"error"` for anything the policy did not raise).
  const [refusal, setRefusal] = useState<Refusal>()
  // The tag naming the claim: the URL's until a row or the field selects another.
  const [selectedTag, setSelectedTag] = useState(handle)
  const [start, setStart] = useState(false)
  const [prepared, setPrepared] = useState<"pending" | "ready" | "failed">("pending")
  const [typed, setTyped] = useState("")
  const [found, setFound] = useState<Found>()
  const rows = useRowKeys(config.rpId)
  const [notice, setNotice] = useState<ByTagNotice>()
  const [resolving, setResolving] = useState(false)
  const [endpointsOpen, setEndpointsOpen] = useState(false)
  const { busy, run: runAction } = useAsyncAction()
  /** `useAsyncAction`, also counting a rethrown login failure, which `action_failed` reports only
   *  with consent. */
  const run = (fn: () => Promise<void>, action: Entry["action"], context?: string) =>
    runAction(
      async () => {
        try {
          await fn()
        } catch (e) {
          fireOnboardingEvent("login_failed", {
            method: LOGIN_METHODS[action],
            code: failureCode(e),
          })
          throw e
        }
      },
      action,
      context,
    )
  // The screen's own buttons are the tap before the first prompt; only the second prompt holds.
  const {
    gate,
    state: gateState,
    cancel: cancelGate,
  } = useCeremonyGate(currentDevicePosture, {
    holdsSignIn: false,
  })
  // A sign-in reaches the gate only on its way to a prompt; a key this browser holds skips both.
  const [prompted, setPrompted] = useState(false)
  const promptGate: CeremonyGate = (options) => {
    setPrompted(true)
    return gate(options)
  }
  // A recovered-but-unnamed claim + its rebuilt account, threaded to the confirm step.
  const claimRef = useRef<EnteredClaim | undefined>(undefined)
  const accountRef = useRef<{ account: ObsidionAccount; held: () => boolean } | undefined>(
    undefined,
  )
  // Set instead of the two above when the confirm step names a reservation rather than a claim.
  const [reserved, setReserved] = useState<Reserved>()
  const lastAction = useRef<LastAction>({ kind: "probe" })
  // The arrival handle seeds the field once per arrival; Back returns to a blank field.
  const seeded = useRef(false)
  // Each resolve and each preparation carries a generation; only the current one may land.
  const resolveGen = useRef(0)
  const prepareGen = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The accounts this browser remembers on earlier rollups, read once the screen shows. They follow
  // this rollup's own, which win a duplicate.
  const [retired, setRetired] = useState<RememberedAccount[]>([])
  useEffect(() => {
    if (!start) return
    let cancelled = false
    void listRetiredUsertagCandidates(config.rpId)
      .then((found) => !cancelled && setRetired(found))
      .catch((error) => console.warn("[sign-in] earlier rollups' accounts unread:", error))
    return () => {
      cancelled = true
    }
  }, [config.rpId, start])
  // This rollup's remembered rows, one per wallet; `avoid` hides the failed key's record first.
  const ownRows = () =>
    oneRowPerWallet(
      listUsertagCandidates(config.rpId).filter((c) => c.credentialId !== avoid),
      (c) => walletKeysFor(config.rpId, c.credentialId)?.length ?? 1,
    )
  // The accounts this browser remembers, re-read whenever the screen shows.
  const candidates = useMemo(
    () => {
      const seen = new Set<string>()
      return [...ownRows(), ...retired].filter(
        (c) => c.credentialId !== avoid && !seen.has(c.credentialId) && !!seen.add(c.credentialId),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.rpId, avoid, start, retired],
  )
  const keyed = useMemo(
    () =>
      new Set(
        candidates
          .filter((c) => (walletKeysFor(config.rpId, c.credentialId)?.length ?? 0) > 1)
          .map((c) => c.credentialId),
      ),
    [config.rpId, candidates],
  )

  // The running action. Starting another aborts it; so do the user's cancel and unmount. Every
  // continuation checks the controller it captured, so a late result changes nothing.
  const opRef = useRef<AbortController | undefined>(undefined)
  // The running action's passkey attempt, marked with why it ends before the action is aborted.
  const attemptRef = useRef<PasskeyAttemptHandle | undefined>(undefined)
  const startOp = (attempt?: PasskeyAttemptHandle) => {
    attemptRef.current?.superseded()
    attemptRef.current = attempt
    opRef.current?.abort()
    setPrompted(false)
    const op = new AbortController()
    opRef.current = op
    return op
  }
  const abortOp = () => opRef.current?.abort()

  /** Ends the resolve in flight and the pause that would start one; nothing they answer is taken. */
  const dropResolve = () => {
    resolveGen.current++
    clearTimeout(debounceRef.current)
    debounceRef.current = undefined
    setResolving(false)
  }

  // Leaving the screen ends the attempt behind any open prompt too: the gate's attempt is what the
  // ceremony and every write behind it run under.
  useEffect(
    () => () => {
      attemptRef.current?.unmounted()
      abortOp()
      cancelGate()
      dropResolve()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cancelGate],
  )

  // A refusal is not an error to report, but it is a failed entry for the funnel.
  const refuse = (e: Error, action: Entry["action"] = "enter", extra?: Partial<Refusal>) => {
    failEntry({ action, code: failureCode(e) })
    setRefusal({
      name: e.name,
      message: e.message,
      extensionAdvice: extensionAdviceFor(e),
      ...extra,
    })
  }
  const failByTag = (outcome: keyof typeof BY_TAG_FAILURE_CODES) =>
    failEntry({ action: "enter:by-tag", code: BY_TAG_FAILURE_CODES[outcome] })

  const claimRoute = (search: string, boundGrantOwner?: string) =>
    navigate(`/claim${search}`, {
      replace: true,
      ...(next || boundGrantOwner
        ? { state: { ...(next ? { next } : {}), ...(boundGrantOwner ? { boundGrantOwner } : {}) } }
        : {}),
    })
  // Zero-argument on purpose: it is handed straight to click handlers, which would otherwise pass
  // the event as the search string.
  const toClaim = () => claimRoute("")

  // The account active when this screen opened.
  const previousStorageId = useRef(getActiveStorageId())
  // The account changed while this screen was open, the page served another account before it, or
  // a commit on this page (e.g. a signed-out page entering an account this browser holds) left the
  // stores stale.
  const storesStale = () =>
    peekAuthService()?.recordsStale() === true ||
    servesAnotherAccount() ||
    (previousStorageId.current !== null && previousStorageId.current !== getActiveStorageId())

  /**
   * This screen again, for the account recovery just committed. The selected tag and the
   * destination come along, and `strict=1` when only that tag may name the claim; the chooser and
   * `pick` flags do not, so the reloaded document opens from the cached key instead of asking for
   * another passkey.
   */
  const enterAgain = (entry: { tag: string; strict: boolean; named?: string }) => {
    const carried = new URLSearchParams(params)
    carried.delete("choose")
    carried.delete("avoid")
    carried.delete("pick")
    carried.delete("next")
    if (entry.tag) carried.set("handle", entry.tag)
    else carried.delete("handle")
    if (entry.strict) carried.set("strict", "1")
    else carried.delete("strict")
    if (entry.named) carried.set("named", entry.named)
    else carried.delete("named")
    if (next) carried.set("next", next)
    const query = carried.toString()
    return query ? `/enter?${query}` : "/enter"
  }

  /**
   * Recovery commits the account it found, which can leave record stores this document has already
   * loaded stale. There is no way to release them in place, so the document is replaced as soon as
   * that is known — before anything reads a record, and whether the attempt settled, was cancelled
   * or failed after the commit. True when the document is going.
   */
  const reloadIfSwitched = (entry: Pick<Entry, "tag" | "action">, named?: string): boolean => {
    if (!storesStale()) return false
    const hinted = entry.action === "enter:by-tag"
    void leavePage(enterAgain({ tag: entry.tag, strict: hinted || strict, named }))
    return true
  }

  // A name is required, not optional: an account without one has no route it can pay for, so it
  // never reaches the wallet at all. `live` is the attempt's ownership: a cancel while the identity
  // is saved leaves the passkey hint unwritten and navigates nowhere.
  const finish = async (
    account: ObsidionAccount,
    entered: { handle: string; address: string },
    live: () => boolean,
    method: LoginMethod = "chooser",
  ) => {
    if (!live()) return
    handOffAccount(account)
    await saveWalletIdentity({ ...entered, claimedAt: Date.now() }, live)
    if (!live()) return
    fireOnboardingEvent("login_succeeded", { method })
    // Replace: onboarding panes must never be back targets once in the wallet (useBack pops history).
    // A stashed inbound paylink claims on Home (ClaimLinkModal), not back on /link's split layout.
    navigate(peekClaimStash() ? "/" : next ?? "/", { replace: true })
  }

  /**
   * Whether this attempt forces a fresh ceremony past the cache. `?choose=1` sets it for the whole
   * visit; asking for the chooser sets it from then on, so a retry after a refusal still asks
   * rather than resolving the cache and returning the user to the account they are leaving. A ref,
   * not state: the action reads it in the same tick the chooser sets it, and every caller — the
   * screen, the confirm step's chooser, and the refusal card's retry — shares the one value.
   */
  const chooserRef = useRef(chooser)

  /**
   * The signup a reservation names, picked back up where the sign-in landed: the claim server
   * replays the claim and re-signs the same terms, so the record derives the address any deposit
   * already went to, and the wallet opens on the deposit screen the way the signup would have. A
   * claim that cannot be replayed leaves the card whose way on is the signup itself.
   */
  const resumeClaim = async (result: Unclaimed, tag: string, entry: Entry) => {
    const live = () => !entry.op.signal.aborted && result.held()
    const address = result.account.getAddress().toString()
    let outcome: Awaited<ReturnType<typeof claimTag>>
    try {
      if (!live()) return
      const keys = await collectOnboardingKeys(result.account)
      if (!live()) return
      if (!obsidionWallet) throw new WalletError("wallet.notReady")
      outcome = await claimTag(tag, keys, config, obsidionWallet)
    } catch (e) {
      if (!live()) return
      failEntry({ action: entry.action, code: failureCode(e) })
      setRefusal(reservedCard(tag))
      return
    }
    // A claim the server replayed for an attempt since cancelled or a session since replaced is
    // replayed again by the next sign-in; nothing of it is kept here.
    if (!live()) return
    if (outcome.kind === "custody") {
      await finish(result.account, { handle: tag, address }, live, LOGIN_METHODS[entry.action])
      return
    }
    saveRegistrationTerms(
      checkpointRegistrationTerms(outcome.oxideAccount, tag, outcome.claim, {
        earnedExpected: false,
        ticket: null,
      }),
    )
    // The reservation is the tag the signup settled on; this browser just never saw it confirmed.
    const record = getPendingStore().get(outcome.oxideAccount)
    if (record) confirmRegistrationTag(record)
    if (!live()) return
    handOffAccount(result.account)
    await saveWalletIdentity({ handle: tag, address, claimedAt: Date.now(), pending: true }, live)
    if (!live()) return
    fireOnboardingEvent("login_succeeded", { method: LOGIN_METHODS[entry.action] })
    navigate(peekClaimStash() ? "/" : next ?? "/", { replace: true })
  }

  /**
   * Account-service's claims for a nameless account: any claim continues that signup under the tag
   * naming it — the attempt's own, the name the passkey carries, or the one the user confirms.
   * False when it holds none, for the caller's usual outcome.
   */
  const resumeReservation = async (result: Unclaimed, entry: Entry): Promise<boolean> => {
    // In test mode a key has its own way on, so only a reservation the attempt or passkey names resumes.
    const mayConfirm = !config.accountServiceTestMode
    const live = () => !entry.op.signal.aborted && result.held()
    let nameHashes: Hex[]
    try {
      nameHashes = await reservedNameHashes(result.bootstrap)
    } catch (e) {
      if (!live()) return true
      // The lookup is the way in, so its failure is the committed error with a retry.
      if (!mayConfirm) return false
      const { tag, action, l2Address } = entry
      lastAction.current = { kind: "nameless", result, entry: { tag, action, l2Address } }
      setRefusal({ name: "error", message: NETWORK_MESSAGE, committed: true })
      throw e
    }
    if (!live()) return true
    if (nameHashes.length === 0) return false
    // The attempt's own tag, the tag this browser remembers, then the name the passkey carries: each
    // names the reservation only where it hashes to one the ledger holds, so a tag that hashes to
    // none still yields to the next rather than burying it.
    const carried = result.userHandle ?? passkeyName
    const matched =
      (entry.tag && reservedTagMatch(nameHashes, result.ensDomain, entry.tag)) ||
      (result.usertag && reservedTagMatch(nameHashes, result.ensDomain, result.usertag)) ||
      (carried && reservedTagMatch(nameHashes, result.ensDomain, carried)) ||
      null
    if (matched) {
      await resumeClaim(result, matched, entry)
      return true
    }
    // A held reservation nothing named: the user types it, since the lookup names exactly one account.
    if (!mayConfirm) return false
    claimRef.current = undefined
    accountRef.current = undefined
    setReserved({
      nameHashes,
      ensDomain: result.ensDomain,
      tag: entry.tag,
      result,
      action: entry.action,
    })
    setConfirming(true)
    return true
  }

  /**
   * The stashed link's signup this passkey's account was made for, picked back up on that link, where
   * the claim keeps its ticket.
   */
  const stashedSignupLink = (result: Unclaimed): string | undefined => {
    const fragment = peekClaimStash()
    if (!fragment) return undefined
    try {
      const attempt = loadTicketSignupAttempt(config.rpId, linkIdentity(fragment))
      if (!attempt || isTicketSignupCreating(attempt)) return undefined
      const address = result.account.getAddress().toString().toLowerCase()
      return attempt.l2Address.toLowerCase() === address ? fragment : undefined
    } catch {
      return undefined
    }
  }

  /** A nameless account's way on: its link's signup, its reservation, else the signup it continues. */
  const settleNameless = async (result: Unclaimed, entry: Entry) => {
    const fragment = stashedSignupLink(result)
    if (fragment) {
      navigate(`/link#${fragment}`, { replace: true })
      return
    }
    if (await resumeReservation(result, entry)) return
    setRefusal({ name: GRANTED_REGISTRATION, message: "" })
  }

  /**
   * A plain-path miss (no local record to anchor against): if a tag is at hand — typed, from the
   * arrival, or the one this credential claimed on this browser — read the account on L1 and say
   * whether this passkey even belongs to it, with no second prompt. It never asserts divergence.
   * Returns true when it rendered a card, false to fall through to the generic no-wallet card.
   */
  const diagnosedMiss = async (
    result: Extract<EnterResult, { reason: "unknown" }>,
    entry: Entry,
    live: () => boolean,
  ): Promise<boolean> => {
    const tag =
      entry.tag || (result.credentialId ? usertagFor(config.rpId, result.credentialId) : undefined)
    if (!tag || !result.credentialId || !result.pubkey) return false
    const diagnosis = await diagnoseMiss(
      {
        credentialId: result.credentialId,
        pubkey: result.pubkey,
        addresses: result.addresses ?? [],
      },
      tag,
    ).catch(() => undefined)
    if (!live() || !diagnosis) return false
    const card = missDiagnosisCard(diagnosis, tag)
    if (!card) return false
    failEntry({ action: entry.action, code: BY_TAG_FAILURE_CODES[diagnosis] })
    setRefusal(
      diagnosis === "NOT_REPRODUCED_HERE" ? { ...card, ...macHelpFor(result.observed) } : card,
    )
    return true
  }

  /**
   * Prepare the screen's ceremony actions: the manifest, and the one cache proof, so nothing slow
   * sits between a tap and its prompt. What completes here never opens a prompt by itself.
   */
  const prepare = () => {
    const gen = ++prepareGen.current
    setPrepared("pending")
    void (async () => {
      try {
        await getOxideTuple(config)
        await getAuthService().recoverFromCache()
        if (gen === prepareGen.current) setPrepared("ready")
      } catch {
        if (gen === prepareGen.current) setPrepared("failed")
      }
    })()
  }

  /**
   * Read `tag` on L1. Only the current generation's answer lands, so an older read can neither
   * repopulate the field after an edit nor overwrite a newer notice; nothing here starts a prompt,
   * and nothing here touches the sign-in operation.
   */
  const readTag = (tag: string) => {
    const gen = resolveGen.current
    setResolving(true)
    void lookupPasskeyByTag(tag, { resolveTag: resolveSignInTag }).then(
      (read) => {
        if (gen !== resolveGen.current) return
        if (read.kind !== "notFound") setResolving(false)
        if (read.kind === "resolved") {
          setNotice(undefined)
          const resolved: AccountFound = {
            tag,
            l2Address: read.l2Address,
            hints: { account: read.account, l2Address: read.l2Address, keys: read.keys },
            moreKeys: read.moreKeys,
          }
          setFound({ ...resolved, keys: keyOptions(resolved) })
          return
        }
        setFound(undefined)
        failByTag(read.kind === "inconclusive" ? "INCONCLUSIVE" : read.kind)
        if (read.kind !== "notFound") {
          setNotice({ kind: read.kind, tag })
          return
        }
        // No account on the network yet: a reserved name is one whose signup still waits for its
        // deposit, and its way in is the passkey it was reserved with.
        void probeNameAvailability(tag).then(({ status }) => {
          if (gen !== resolveGen.current) return
          setResolving(false)
          const reserved = status === "reserved" || status === "blocked-reserved"
          setNotice({ kind: reserved ? "reserved" : "notFound", tag })
        })
      },
      () => {
        if (gen !== resolveGen.current) return
        setResolving(false)
        setFound(undefined)
        failByTag("lookupFailed")
        setNotice({ kind: "lookupFailed", tag })
      },
    )
  }

  /** Read `tag` as it is typed. A tag the list shows is that row's sign-in: nothing is read. */
  const resolve = (tag: string) => {
    dropResolve()
    if (candidates.some((c) => c.usertag === tag)) {
      setNotice({ kind: "listed", tag })
      return
    }
    readTag(tag)
  }

  /** A remembered tag's way in with a passkey its row does not hold: read like any other tag. */
  const onDifferentPasskey = () => {
    if (notice?.kind !== "listed") return
    dropResolve()
    setNotice(undefined)
    readTag(notice.tag)
  }

  const onTagChange = (value: string) => {
    setTyped(value)
    setFound(undefined)
    setNotice(undefined)
    dropResolve()
    // Typing a tag leaves the selected row: one account's keys show at a time.
    rows.close()
    const tag = normalizeTag(value)
    if (!tag) return
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined
      resolve(tag)
    }, RESOLVE_DEBOUNCE_MS)
  }

  // A blur runs a pending read at once, and reads a tag nothing has answered yet — never one that
  // already resolved, which would disable Login under the click that blurred the field. A read the
  // network refused is asked again; the notice's Try again comes here too.
  const onTagBlur = () => {
    const tag = normalizeTag(typed)
    if (!tag) return
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = undefined
      resolve(tag)
      return
    }
    const answered = notice?.tag === tag && notice.kind !== "lookupFailed"
    if (resolving || found?.tag === tag || answered) return
    resolve(tag)
  }

  const submitReady = found !== undefined && found.tag === normalizeTag(typed)

  /**
   * Show the sign-in screen. `warm` runs the preparation the arrival probe would have done (the
   * chooser skips the probe; a failed probe left the manifest unread). The arrival handle seeds the
   * field the first time the screen shows, whichever way it did; Back never reseeds it.
   */
  const activateStart = (warm: boolean) => {
    setRefusal(undefined)
    setStart(true)
    if (warm) prepare()
    else setPrepared("ready")
    if (!seeded.current && handle) {
      seeded.current = true
      setTyped(handle)
      resolve(handle)
    }
  }

  /** The branches every sign-in result takes, whichever prompt produced it. */
  const settle = async (result: EnterResult, entry: Entry) => {
    // A reserved recovery commits and reloads to shed record stores this document already read
    // stale; the passkey's own name rides that reload, so the re-entry (recovered from the cache,
    // which carries no name) still names the held reservation.
    const named = !result.entered && result.reason === "unclaimed" ? result.userHandle : undefined
    if (reloadIfSwitched(entry, named)) return
    const live = () => !entry.op.signal.aborted
    // An entry is committed by the time it is reported; the identity save and the move into the
    // wallet are still the attempt's, and stop at its cancel or when its session was replaced.
    if (result.entered) {
      const { account, handle, address } = result
      await finish(
        account,
        { handle, address },
        () => live() && result.held(),
        LOGIN_METHODS[entry.action],
      )
      return
    }
    if (!live()) return
    if (result.reason === "ceremony-required") {
      activateStart(false)
      return
    }
    if (result.reason === "unknown") {
      if (entry.l2Address !== undefined) {
        // Pinning the same credential again would end the same way, so the failure is named. A record
        // this browser holds that no longer reproduces keeps its verdict.
        if (result.storedAddressMismatch && result.verdict) {
          failByTag("PASSKEY_KEY_MISMATCH")
          setRefusal({
            name: STORED_ADDRESS_MISMATCH,
            message: "",
            verdict: result.verdict,
            ...macHelpFor(result.observed, result.verdict === "wrong-key"),
          })
          return
        }
        // A sole key is proven only by a read that found one; an entry with no read proves nothing.
        const diagnosis = diagnoseUnknown(result, entry.l2Address, {
          laptop: currentDevicePosture() === "laptop",
          moreKeys: entry.moreKeys !== false,
        })
        failByTag(diagnosis)
        // This computer's copy of the account's one key answered with the wrong value: the same card
        // as a record mismatch, whose way on is another device.
        if (diagnosis === "LOCAL_COPY_WRONG_KEY") {
          setRefusal({
            name: STORED_ADDRESS_MISMATCH,
            message: "",
            verdict: "wrong-key",
            ...macHelpFor(result.observed, true),
          })
          return
        }
        setRefusal({
          name: DIAGNOSIS_ROWS[diagnosis],
          message:
            diagnosis === "REGISTRY_UNANCHORED"
              ? `Your passkey reproduces @${entry.tag}'s account, but its record couldn't be confirmed. Try again.`
              : `This passkey's key doesn't reproduce @${entry.tag}'s account. Go back and check the tag, or choose Show passkeys and pick your phone (scan the QR code with it) or your security key in the browser's prompt.`,
          ...(diagnosis === "PASSKEY_KEY_MISMATCH" ? macHelpFor(result.observed) : {}),
        })
        return
      }
      // A cancel during the diagnosis ends here: neither card is the cancelled attempt's to show.
      const diagnosed = await diagnosedMiss(result, entry, live)
      if (diagnosed || !live()) return
      // An incomplete catalog proves no account absent: a retry, never "no wallet".
      if (result.catalogIncomplete) {
        failEntry({ action: entry.action, code: "unknown" })
        setRefusal({ name: "error", message: NETWORK_MESSAGE })
        return
      }
      refuse(new NoWalletForPasskeyError(), entry.action, macHelpFor(result.observed, true))
    } else if (result.reason === "confirm") {
      claimRef.current = result.claim
      accountRef.current = { account: result.account, held: result.held }
      setReserved(undefined)
      setConfirming(true)
    } else {
      // A bound grant resumes only with the passkey that first used it.
      if (boundGrantToken && !config.accountServiceTestMode) {
        const nameHash = composeWireNameHash(entry.tag, result.ensDomain)
        let owner: boolean
        try {
          owner = await boundNameGrantOwner(nameHash, boundGrantToken, result.bootstrap, config)
        } catch (e) {
          if (!live()) return
          lastAction.current = {
            kind: "bound-grant",
            result,
            entry: { tag: entry.tag, action: entry.action },
          }
          failEntry({ action: entry.action, code: failureCode(e) })
          setRefusal({ name: "error", message: NETWORK_MESSAGE })
          return
        }
        if (!live()) return
        if (owner) {
          claimRoute(`/${entry.tag}?resume=1`, entry.tag)
          return
        }
        setRefusal({
          name: DIFFERENT_PASSKEY,
          message: `This passkey cannot continue @${entry.tag}'s grant. Go back and choose the passkey used to begin signup.`,
        })
        return
      }
      // A recovered account with no name has nothing to open — every route that moves money sits
      // behind a registered name — so the way on is always the signup.
      await settleNameless(result, entry)
    }
  }

  /**
   * The arrival probe: the ceremony-free sources only. A cached key enters with no screen and no
   * prompt; anything that needs a prompt shows the screen. A failure is sorted by where it landed —
   * a switched account reloads, a cancelled probe shows nothing, a refusal shows its card, a write
   * that failed after a commit shows a card whose retry re-probes, and only a read that failed
   * before anything was asked or written shows the screen, which then prepares itself.
   */
  const probe = () => {
    // No prompt can come of this, so the attempt speaks only for a refusal the cached key earns.
    const attempt = passkeyTelemetry.begin({ ceremony: "sign_in", flow: "enter" })
    const op = startOp(attempt)
    lastAction.current = { kind: "probe" }
    setRefusal(undefined)
    void run(async () => {
      let result: EnterResult
      try {
        result = await attempt.run(
          (own) =>
            enterWithPasskey(obsidionWallet!, config, handle || undefined, {
              contractService: contractService!,
              ...(boundGrantToken ? { grantToken: boundGrantToken } : {}),
              gate: promptGate,
              strictTag: strict,
              signal: op.signal,
              cacheOnly: true,
              own,
            }),
          enterOutcome(),
        )
      } catch (e) {
        if (reloadIfSwitched({ tag: handle, action: "enter" })) return
        if (op.signal.aborted || isGateCancelled(e)) return
        if (e instanceof StoredAddressMismatchError) {
          failEntry({ action: "enter", code: failureCode(e) })
          setRefusal(mismatchRefusal(e))
          return
        }
        if (isPasskeyPolicyError(e)) {
          refuse(e, "enter")
          return
        }
        if (isCommittedFailure(e)) {
          setRefusal({ name: "error", message: NETWORK_MESSAGE, probeCommitted: true })
          throw e
        }
        failEntry({ action: "enter", code: failureCode(e) })
        activateStart(true)
        return
      }
      if (!result.entered && result.reason === "ceremony-required") {
        if (!op.signal.aborted) activateStart(false)
        return
      }
      await settle(result, { op, tag: handle, action: "enter" })
    }, "enter")
    return { op, attempt }
  }

  /**
   * The open sign-in: the browser's own chooser. Runs on a tap, so it restores no cache. `phone`
   * steers the prompt to the phone.
   */
  const enter = (phone = false) => {
    const attempt = passkeyTelemetry.begin({ ceremony: "sign_in", flow: "enter" })
    const op = startOp(attempt)
    const tag = selectedTag
    lastAction.current = { kind: "enter", phone }
    setRefusal(undefined)
    setStart(false)
    void run(async () => {
      let result: EnterResult
      try {
        result = await attempt.run(
          (own) =>
            enterWithPasskey(obsidionWallet!, config, tag || undefined, {
              contractService: contractService!,
              ...(boundGrantToken ? { grantToken: boundGrantToken } : {}),
              gate: promptGate,
              chooser: chooserRef.current,
              ...(phone ? { phone } : {}),
              strictTag: strict,
              signal: op.signal,
              restoreCache: false,
              own,
            }),
          enterOutcome(),
        )
      } catch (e) {
        // A commit that switched accounts stands even when what followed was cancelled or failed;
        // the document with the old stores must go before anything else is shown.
        if (reloadIfSwitched({ tag, action: "enter" })) return
        // Ended by the user's cancel or by unmount: whoever ended it navigated, or must not.
        if (op.signal.aborted || isGateCancelled(e)) return
        const unusable = inAppBrowserRefusal(e)
        if (isPasskeyNotOffered(e)) {
          failEntry({ action: "enter", code: "passkey_prompt_closed" })
          setRefusal(
            unusable
              ? { ...unusable, cause: e }
              : {
                  name: PASSKEY_NOT_OFFERED,
                  message: "The prompt closed without a passkey for zk.money.",
                },
          )
          return
        }
        // A record we hold no longer reproduces from this passkey: the wallet's own card, its copy
        // chosen by the verdict.
        if (e instanceof StoredAddressMismatchError) {
          failEntry({ action: "enter", code: failureCode(e) })
          setRefusal(mismatchRefusal(e))
          return
        }
        // A backup record's envelope did not open, or the passkey's account holds more keys than
        // the sign-in could read: the wallet's own cards.
        if (e instanceof PasskeyEnvelopeError || e instanceof PasskeySetUnreadError) {
          refuse(e, "enter")
          return
        }
        if (isPasskeyPolicyError(e)) {
          refuse(e, "enter")
          return
        }
        // Committed, then a write failed: Retry re-probes the committed key, with no prompt.
        if (isCommittedFailure(e)) {
          lastAction.current = { kind: "probe" }
          setRefusal({ name: "error", message: NETWORK_MESSAGE, probeCommitted: true })
          throw e
        }
        if (unusable) {
          failEntry({ action: "enter", code: failureCode(e) })
          setRefusal({ ...unusable, cause: e })
          return
        }
        // Reported, but the user stays: /claim would mint a second account for someone who has one.
        setRefusal({ name: "error", message: NETWORK_MESSAGE })
        throw e
      }
      await settle(result, { op, tag, action: "enter" })
    }, "enter")
    return { op, attempt }
  }

  /**
   * The pinned sign-in for what a row or the field named; opens on that tap, restoring no cache.
   * `phone` steers the prompt to the phone.
   */
  const pinned = (target: Found, phone = false) => {
    const attempt = passkeyTelemetry.begin({ ceremony: "sign_in", flow: "enter" })
    const op = startOp(attempt)
    lastAction.current = { kind: "pinned", ...target, phone }
    setSelectedTag(target.tag)
    setRefusal(undefined)
    setStart(false)
    void run(
      async () => {
        let result: EnterResult
        try {
          result = await attempt.run(
            (own) =>
              enterWithPasskey(obsidionWallet!, config, target.tag, {
                contractService: contractService!,
                ...(boundGrantToken ? { grantToken: boundGrantToken } : {}),
                gate: promptGate,
                hints: target.hints,
                ...(phone ? { phone } : {}),
                signal: op.signal,
                restoreCache: false,
                own,
              }),
            enterOutcome(target.l2Address),
          )
        } catch (e) {
          if (reloadIfSwitched({ tag: target.tag, action: "enter:by-tag" })) return
          if (op.signal.aborted || isGateCancelled(e)) return
          const unusable = inAppBrowserRefusal(e)
          if (isPasskeyNotOffered(e)) {
            failByTag("promptClosed")
            setRefusal(
              unusable
                ? { ...unusable, cause: e }
                : {
                    name: PASSKEY_NOT_ON_DEVICE,
                    message: `This device was asked for @${target.tag}'s passkey by name and didn't offer it.`,
                  },
            )
            return
          }
          if (e instanceof PasskeyMismatchError) {
            failByTag("wrongCredential")
            setRefusal({ name: e.name, message: e.message })
            return
          }
          // A backup passkey's envelope did not open, or the account holds more keys than the
          // sign-in could read: the wallet's own cards.
          if (
            e instanceof PasskeyEnvelopeError ||
            e instanceof PasskeySetUnreadError ||
            isPasskeyPolicyError(e)
          ) {
            refuse(e, "enter:by-tag")
            return
          }
          if (isCommittedFailure(e)) {
            lastAction.current = { kind: "probe" }
            setRefusal({ name: "error", message: NETWORK_MESSAGE, probeCommitted: true })
            throw e
          }
          if (unusable) {
            failEntry({ action: "enter:by-tag", code: failureCode(e) })
            setRefusal({ ...unusable, cause: e })
            return
          }
          setRefusal({ name: "error", message: NETWORK_MESSAGE })
          throw e
        }
        await settle(result, {
          op,
          tag: target.tag,
          action: "enter:by-tag",
          l2Address: target.l2Address,
          moreKeys: target.moreKeys,
        })
      },
      "enter:by-tag",
      "enter",
    )
  }

  /**
   * A committed account's way on again, after its reservation lookup failed: no passkey prompt (the
   * sign-in's chooser flag would ask again).
   */
  const settleNamelessAgain = (last: Extract<LastAction, { kind: "nameless" }>) => {
    const op = startOp()
    setRefusal(undefined)
    void run(() => settleNameless(last.result, { ...last.entry, op }), last.entry.action, "enter")
  }

  const retryBoundGrant = (last: Extract<LastAction, { kind: "bound-grant" }>) => {
    const op = startOp()
    setRefusal(undefined)
    void run(() => settle(last.result, { ...last.entry, op }), last.entry.action, "enter")
  }

  const rerun = () => {
    const last = lastAction.current
    if (last.kind === "probe") probe()
    else if (last.kind === "enter") enter(last.phone)
    else if (last.kind === "bound-grant") retryBoundGrant(last)
    else if (last.kind === "nameless") settleNamelessAgain(last)
    else pinned(last, last.phone)
  }

  /** The way on from a miss that may be this Mac's own copy: what ran last, steered to the phone. */
  const usePhone = () => {
    dropResolve()
    const last = lastAction.current
    if (last.kind === "pinned") pinned(last, true)
    else enter(true)
  }

  // The screen's three ways in. Each ends the resolve first: nothing it answers may land on a
  // screen that has moved on.
  const showPasskeys = () => {
    dropResolve()
    chooserRef.current = true
    enter()
  }
  const chooseAccount = (account: RememberedAccount) => {
    dropResolve()
    const keys = walletKeysFor(config.rpId, account.credentialId)
    if (keys && keys.length > 1) {
      if (rows.selected?.credentialId === account.credentialId) {
        rows.close()
        return
      }
      // The selected row's keys take Login's place, so the tag field steps aside.
      setTyped("")
      setFound(undefined)
      setNotice(undefined)
      rows.open(account, keys)
      return
    }
    rows.close()
    pinned({
      tag: account.usertag,
      l2Address: account.l2Address,
      hints: { credentialId: account.credentialId },
    })
  }
  const chooseRowKey = (credentialId: string) => {
    const option = rows.optionFor(credentialId)
    if (!option) return
    dropResolve()
    pinned(option.target)
  }
  const login = () => {
    if (!submitReady || !found || found.keys) return
    dropResolve()
    fireEvent("passkey_by_tag_lookup_resolved", { more_keys: found.moreKeys ?? false })
    pinned(found)
  }
  const chooseTagKey = (credentialId: string) => {
    const option = submitReady
      ? found?.keys?.find((o) => o.credentialId === credentialId)
      : undefined
    if (!option) return
    dropResolve()
    fireEvent("passkey_by_tag_lookup_resolved", { more_keys: found?.moreKeys ?? false })
    pinned(option.target)
  }

  // Once the wallet is ready. Restartable: StrictMode replays this effect, and only the replayed
  // invocation may complete, so each setup starts its own and the cleanup ends only that one.
  const walletReady = !!obsidionWallet && !!contractService
  useEffect(() => {
    if (!walletReady || mock) return
    if (chooser || pick) {
      activateStart(true)
      // The picked record's wallet, as the row the screen shows for it.
      const picked = pick
        ? listUsertagCandidates(config.rpId).find((c) => c.credentialId === pick)
        : undefined
      const row = picked
        ? ownRows().find((c) => c.l2Address.toLowerCase() === picked.l2Address.toLowerCase())
        : undefined
      const keys = row ? walletKeysFor(config.rpId, row.credentialId) : undefined
      if (row && keys && keys.length > 1) rows.open(row, keys)
      // The unmount drops the seed's read, so the replay seeds again.
      return () => {
        seeded.current = false
      }
    }
    const { op, attempt } = probe()
    return () => {
      attempt.unmounted()
      op.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletReady])

  const confirm = (typedTag: string) => {
    setError(undefined)
    if (reserved) {
      const matched = reservedTagMatch(reserved.nameHashes, reserved.ensDomain, typedTag)
      if (!matched) {
        setError(`Couldn't match that tag — @${typedTag} is not the tag this passkey reserved.`)
        return
      }
      const { result, action } = reserved
      setReserved(undefined)
      setConfirming(false)
      const op = opRef.current ?? startOp()
      void run(() => resumeClaim(result, matched, { op, tag: matched, action }), action, "enter")
      return
    }
    let entered: ReturnType<typeof confirmTag>
    try {
      entered = confirmTag(claimRef.current!, typedTag)
    } catch (e) {
      setError(`Couldn't match that tag${e instanceof Error ? ` — ${e.message}` : ""}. Try again.`)
      return
    }
    const op = opRef.current
    const adopted = accountRef.current!
    void finish(adopted.account, entered, () => !op?.signal.aborted && adopted.held()).catch(() =>
      setError("Couldn't finish signing in. Try again."),
    )
  }

  // The user's cancel ends the attempt wherever it is — on the screen, past its prompt, or in the
  // writes that follow.
  const cancelSignIn = () => {
    attemptRef.current?.userCancelled()
    abortOp()
    cancelGate()
    dropResolve()
    // A visitor who came from a link goes back to it; otherwise back where the sign-in was opened from.
    const stashed = peekClaimStash()
    if (stashed) navigate(`/link#${stashed}`, { replace: true })
    else if (next) navigate(next, { replace: true })
    else toClaim()
  }
  // The same for a committed account whose signup may hold a tag, where the signup picks it back up.
  const continueSignup = () => {
    attemptRef.current?.userCancelled()
    abortOp()
    cancelGate()
    claimRoute("?resume=1")
  }
  // Back to the screen with a blank field, naming the URL's tag again; whatever was running ends
  // first. A screen that has not shown yet still takes the arrival seed.
  const back = () => {
    attemptRef.current?.superseded()
    abortOp()
    cancelGate()
    dropResolve()
    rows.close()
    setNotice(undefined)
    setFound(undefined)
    setTyped("")
    setSelectedTag(handle)
    activateStart(true)
  }

  const pill = (label: string, testId: string, onClick: () => void) => (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-invite-pill"
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </button>
  )

  // These two cards leave for a signup already begun rather than a new one: the tag is reserved
  // under this account's own key, and the claim server settles that when it is submitted.
  const resuming = refusal?.name === GRANTED_REGISTRATION

  // The spinner and the security-key step: a sign-in is running.
  useHoldEndpoints(!confirming && !refusal && (gateState.kind === "awaiting-action" || !start))

  if (refusal && !confirming) {
    const notOffered = refusal.name === PASSKEY_NOT_OFFERED
    const laptop = currentDevicePosture() === "laptop"
    const wrongKey = refusal.name === STORED_ADDRESS_MISMATCH && refusal.verdict === "wrong-key"
    const resumeTag = refusal.resumeTag
    // The "what went wrong" list stays where it is the only guidance: a phone's closed prompt (a
    // laptop's own account chooser is the guidance there), or a pinned prompt that matched nothing.
    const causes =
      (notOffered && !laptop) || refusal.name === PASSKEY_NOT_ON_DEVICE
        ? promptCauses(currentDevicePosture())
        : undefined
    // A retry runs the same attempt again; where that could only end the same way, the screen is
    // where the user tries again instead. A phone attempt that offered nothing may still reach it.
    const last = lastAction.current
    const phoneOffered =
      (last.kind === "enter" || last.kind === "pinned") &&
      last.phone === true &&
      (notOffered || refusal.name === PASSKEY_NOT_ON_DEVICE)
    const retryable =
      refusal.probeCommitted || refusal.committed || !NO_RETRY.has(refusal.name) || phoneOffered
    return (
      <InvitationChrome landing>
        <div className="ww-passkey-sheet">
          <IosFloorNotice />
          <PasskeyRefusal
            error={refusal}
            onRetry={retryable ? rerun : undefined}
            busy={busy}
            causes={causes}
            verdict={refusal.verdict}
            reportContext="enter"
            primary={
              refusal.macPhone
                ? { title: PHONE_STEPS_COPY.noPhone.back, onClick: usePhone, testId: "enter-phone" }
                : wrongKey
                ? { title: "Show passkeys", onClick: showPasskeys, testId: "enter-show-passkeys" }
                : refusal.name === SET_UNREAD
                ? // Back to the screen, where the tag field takes focus; no prompt opens.
                  { title: "Type your @tag", onClick: back, testId: "enter-type-tag" }
                : resumeTag
                ? {
                    title: "Continue signing up",
                    onClick: () => claimRoute(`/${resumeTag}?resume=1`),
                    testId: "enter-continue",
                  }
                : undefined
            }
            testId="enter-refused"
            retryTestId="enter-retry"
            exits={
              resumeTag ? (
                pill("Back", "enter-back", back)
              ) : resuming ? (
                // A passkey picked by mistake, such as another signup's, needs a way to a different one.
                <>
                  {pill("Continue signing up", "enter-continue", () => claimRoute("?resume=1"))}
                  {pill("Show passkeys", "enter-show-passkeys", showPasskeys)}
                  {pill("Cancel sign-in", "enter-cancel", cancelSignIn)}
                </>
              ) : refusal.committed ? (
                <>
                  {pill("Continue signing up", "enter-continue", continueSignup)}
                  {pill("Cancel sign-in", "enter-cancel", cancelSignIn)}
                </>
              ) : refusal.probeCommitted ? (
                pill("Cancel sign-in", "enter-cancel", cancelSignIn)
              ) : (
                <>
                  {refusal.macPhone && pill("Show passkeys", "enter-show-passkeys", showPasskeys)}
                  {pill("Back", "enter-back", back)}
                  {pill("Cancel sign-in", "enter-cancel", cancelSignIn)}
                </>
              )
            }
          />
        </div>
      </InvitationChrome>
    )
  }

  // The landing card the visitor came from stays behind the sign-in modals.
  const backdrop = (
    <CreateWalletStep
      busy={false}
      returning={hasOpeningBreadcrumb(config.rpId)}
      onCreate={() => {}}
      onLogIn={() => {}}
      onCancel={() => {}}
    />
  )
  if (gateState.kind === "awaiting-action" && !confirming) {
    return (
      <InvitationChrome landing>
        <div className="ww-passkey-sheet">
          <GateStep state={gateState} onCancel={cancelSignIn} cancelLabel="Cancel sign-in" />
        </div>
      </InvitationChrome>
    )
  }
  // An app's built-in browser is told before the first prompt, in place of the screen. The
  // remembered-account rows are not the test: a nameless account, or one the screen hides, is
  // still a passkey that worked here.
  const inAppMode = start && !confirming ? walletInAppUpFront(config.rpId) : undefined
  if (inAppMode) {
    return (
      <InvitationChrome landing>
        <div className="ww-passkey-sheet">
          <InAppBrowserNotice
            mode={inAppMode}
            reportContext="enter"
            testId="enter-in-app-notice"
            exits={pill("Cancel sign-in", "enter-cancel", cancelSignIn)}
          />
        </div>
      </InvitationChrome>
    )
  }
  if (start && !confirming) {
    return (
      <InvitationChrome bare landing>
        {backdrop}
        <>
          <ConfirmTagModal
            start={{
              candidates,
              onCandidate: chooseAccount,
              keyed,
              rowKeys: rows.rowKeys,
              onRowKey: chooseRowKey,
              onRowKeysAgain: rows.again,
              tagKeys: found?.keys,
              onTagKey: chooseTagKey,
              value: typed,
              onTagChange,
              onTagBlur,
              onDifferentPasskey,
              submitReady,
              resolving,
              prepared,
              onPrepareAgain: prepare,
              notice,
              chooserFirst: chooser || notice?.kind === "reserved",
              busy,
              onEndpoints: () => setEndpointsOpen(true),
            }}
            onConfirm={login}
            onShowPasskeys={showPasskeys}
            onClose={cancelSignIn}
          />
          {/* Beside the card, not in it: inside the card's form, Enter in a field would sign in. */}
          {endpointsOpen && <EndpointsModal onClose={() => setEndpointsOpen(false)} />}
        </>
      </InvitationChrome>
    )
  }
  if (!confirming) {
    return (
      <InvitationChrome landing>
        <div className="ww-passkey-sheet">
          <div className="ww-invite-spinner" data-testid="enter-passkey">
            <IosFloorNotice />
            {claimPending && (
              <p className="ww-paylink-summary__caption">Your payment is waiting to be claimed.</p>
            )}
            {connectPending && (
              <p className="ww-paylink-summary__caption">
                Once you're in, you can add the contact someone shared with you.
              </p>
            )}
            <OnboardingSpinnerBody
              label={prompted ? "Signing in with passkey…" : "Signing in…"}
              cancelLabel="Cancel sign-in"
              onCancel={cancelSignIn}
            />
          </div>
        </div>
      </InvitationChrome>
    )
  }
  return (
    <InvitationChrome bare landing>
      {backdrop}
      <>
        <ConfirmTagModal
          key={reserved ? "reserved" : "claimed"}
          initialHandle={reserved ? reserved.tag : selectedTag}
          submitTitle={reserved ? "Continue signing up" : undefined}
          error={error}
          onConfirm={confirm}
          onBack={() => {
            setConfirming(false)
            setReserved(undefined)
            setError(undefined)
            back()
          }}
          onClose={reserved ? continueSignup : cancelSignIn}
        />
      </>
    </InvitationChrome>
  )
}

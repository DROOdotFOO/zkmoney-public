import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { parseUnits } from "viem"
import {
  useContractServiceContext,
  TxInFlightError,
  useStore,
  useResource,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { EmailMismatchError } from "@obsidion/sdk"
import {
  DEFAULT_CONTRACTS,
  WALLET_TOKEN_SYMBOL,
  tokenDecimalsForNetwork,
} from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { TimeoutError } from "../../lib/withTimeout"
import { showErrorModal, showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { useDepositSkim } from "../onboarding/registrationTerms"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { ClaimReviewStep } from "../onboarding/steps/ClaimReviewStep"
import type { WithdrawStage } from "../withdraw/withdrawGateway"
import { usePolledChainSeconds } from "./chainTime"
import {
  ClaimLinkModal,
  ClaimProvingModal,
  type ClaimBeat,
  type ClaimStage,
} from "./ClaimLinkModal"
import { ClaimToL1Modal, type ClaimToL1Choice } from "./ClaimToL1Modal"
import {
  claimWaitSeconds,
  claimWindowRevertCopy,
  closedLinkMessage,
  LINK_STATUS_LABEL,
  withExpiry,
  PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
  useClaimCountdown,
} from "./claimWindow"
import { openClaimPrompt, setLinkFunding } from "./claimPrompt"
import { clearClaimStash } from "./claimStash"
import {
  autoClaimGaveUp,
  claimFailed,
  endClaim,
  holdAutoClaim,
  isClaimRunning,
  resetRunningClaims,
  startClaim,
  useClaimFailure,
  useClaimRunning,
  type AutoClaimHold,
} from "./runningClaims"
import { obtainEmailClaimProof } from "./emailClaim"
import { GoogleSignInCancelled } from "./googleAuth"
import { LINK_READ_BUDGET_MS, readBefore, seededLink, watchLink } from "./linkStatus"
import { paylinkSignupQuote } from "./paylinkSignupQuote"
import { useActiveWithdrawalFee } from "../withdraw/withdrawalFee"
import { useRegistrationSpeed } from "./registrationProverTip"
import { SpeedRow } from "../withdraw/speedChoice"
import {
  commitRegistrationProverTip,
  committedProverTip,
  useRegistrationTerms,
} from "../onboarding/registrationTerms"
import {
  claimLinkToL1,
  planLinkClaimSwap,
  claimSponsoredLink,
  emitLinkOpened,
  VoucherReadError,
  type SponsoredPaylinkDeps,
  type ViewLinkDeps,
} from "./sponsoredPaylink"
import {
  bindLinkDeposit,
  fundingRefusalCopy,
  loadRegistrations,
  onTicketRegistrationsChanged,
  releaseLinkDeposit,
  ticketHoldNotice,
  ticketSignupCommitted,
  ticketSignupContinuation,
  unfundedRegistration,
} from "./ticketContinuation"
import type { PaymentLink } from "./types"
import { useLinkVoucher, usePaylinkDeps } from "./usePaylinkDeps"
import { useActionGuard, useActionVerdict } from "../actionGate"
import { balanceMovingCopy } from "../backupPasskey/backupPasskeyCopy"
import { session, useSession } from "../../platform/session"

export interface ClaimLinkFlow {
  /** The claim prompt, or the sheet for the beats that need the user, when one is on screen. */
  modal: ReactNode
}

/**
 * Claim lifecycle for an inbound paylink (ULT-671 pages 6–7). The prompt gives way to the claim
 * sheet for the beats that need the user present (Google sign-in, the zkJWT prove, the passkey).
 * The passkey ceremony is the last of those, so the sheet closes as it ends and the bell carries
 * the claim — the same hand-off a send makes. Success and failure land on the claim's operation
 * row; a failure before the hand-off also reopens the prompt behind an error sheet, since the
 * prompt is the retry. The stash clears on decline or success, so only an unresolved claim
 * re-prompts; a mount that finds its claim already running shows nothing, because the bell owns it.
 * Either flavor can instead burn to Ethereum: that runs as a withdrawal, whose stored record
 * carries its own live row.
 *
 * A link that paid for this account's signup is claimed by Home itself, publishing the
 * registration's address and burning its slice: the signup entered the wallet as soon as its name
 * was reserved, so the claim starts once the link's window is open and hands off to the bell at
 * once, with no review. That happens once per page and link, with two more tries after a read that
 * timed out; a claim that failed or was cancelled shows the review with its Claim for the retry,
 * and why it failed, as does an email-locked link, whose sign-in needs the tap. Closing the review
 * keeps the link stashed — the signup's funding waits for its claim, and Home's own try still runs.
 * A signup whose renewed quote the link can no longer pay, whose reservation lapsed or whose burn
 * already went out claims nothing and shows nothing here: the hero on Home says why, and the link
 * is still that signup's, never an ordinary claim, until the signup is renewed or abandoned.
 */

/** Links Home has tried to claim on its own in this page. */
const autoClaimed = new Set<string>()

/** Tries after the first, for a failure that may pass: a read that timed out behind other work. */
const AUTO_CLAIM_RETRIES = 2
const AUTO_CLAIM_BACKOFF_MS = 5_000
/** How long Home waits to learn whether the link funds a registration before the plain prompt. */
const DETECT_BUDGET_MS = 15_000

function retryable(e: unknown): boolean {
  return (
    e instanceof VoucherReadError ||
    e instanceof TimeoutError ||
    (e instanceof Error && e.cause instanceof TimeoutError)
  )
}

/** Test seam. */
export function resetRunningClaimsForTests(): void {
  resetRunningClaims()
  autoClaimed.clear()
}

/** Resolves to the claim tx hash. */
async function runClaim(
  deps: SponsoredPaylinkDeps,
  fragment: string,
  link: PaymentLink,
  onStage: (stage: ClaimStage) => void,
  fundRegistration: boolean,
  signal?: AbortSignal,
): Promise<string> {
  try {
    let zkProof
    if (link.flavor === "email") {
      zkProof = await obtainEmailClaimProof(
        deps.account.getAddress(),
        {
          paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
          email: link.email,
          commitment: link.commitment,
        },
        onStage,
        signal,
      )
    }
    const txHash = fundRegistration
      ? await claimSponsoredLink(deps, fragment, onStage, zkProof, { fundRegistration: true })
      : await claimSponsoredLink(deps, fragment, onStage, zkProof)
    // A link that funds the name stays stashed: its review reports the claim and the registration
    // until the funds land, and the continuation it names claims nothing twice.
    if (!fundRegistration) clearClaimStash(fragment)
    return txHash
  } catch (e) {
    if (e instanceof TxInFlightError) {
      // The node has the claim: a reload must not re-offer Accept for a note this wallet spent.
      clearClaimStash(fragment)
    } else if (
      !(e instanceof EmailMismatchError) &&
      !isPasskeyCancelled(e) &&
      !(e instanceof GoogleSignInCancelled)
    ) {
      console.error("paylink claim failed", e)
      fireEvent("action_failed", { action: "paylink:claim", code: failureCode(e) })
    }
    throw e
  }
}

/**
 * `requested`: an activation surface asked for this link's review, so it opens whatever the claim's
 * state, as the place that reports it, rather than only once Home's own try has been made.
 * `onReviewClosed`: that review closed while Home's own try is still to come, so only the request
 * ends and the link stays for that try.
 */
export function useClaimLinkFlow(
  fragment: string | null,
  onDone: () => void,
  requested = false,
  onReviewClosed?: () => void,
): ClaimLinkFlow {
  const obsidionWallet = useResource(useSession().wallet)
  const rollupAddress = obsidionWallet?.networkId
  const { contractService } = useContractServiceContext()
  const claimDeps = usePaylinkDeps()
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)
  const guard = useActionGuard()
  const claimVerdict = useActionVerdict("claim")
  const claimHeld = claimVerdict !== "open"

  // Claim-funnel top for the Home handoff surface — /link redirects signed-in visitors here
  // without emitting. Once per fragment, as soon as the network identity (part of the join key)
  // is known; waits on nothing else.
  const openedFragment = useRef<string>(undefined)
  useEffect(() => {
    if (!fragment || !rollupAddress || openedFragment.current === fragment) return
    openedFragment.current = fragment
    emitLinkOpened(rollupAddress, fragment)
  }, [fragment, rollupAddress])

  const [read, setLink] = useState<PaymentLink | null>(null)
  const link = read && withExpiry(read, chainNow)
  // The link as this tab read it before, until this mount's own read answers: its amount and window
  // stand, its status may not, so a spent link is never offered off it.
  const [seedOnly, setSeedOnly] = useState(false)
  const [claiming, setClaiming] = useState(false)
  // The claim this mount runs started from a tap, not as Home's own try.
  const [tapped, setTapped] = useState(false)
  // The signup this link paid for, when this account still owes it the claim's burn. Read again at
  // the click: the terms can lapse, and the burn can go out elsewhere, after the render.
  // Until the burns load, a signup's own burn is missing and it reads as unfunded or funded elsewhere.
  const burnList = useStore(session().withdrawals.list)
  const burnsLoaded = burnList.hydrated
  const burns = burnList.records
  const readContinuation = () =>
    fragment && claimDeps && burnsLoaded
      ? ticketSignupContinuation(fragment, claimDeps.account.getAddress().toString(), burns)
      : null
  const continuation = readContinuation()
  // This account's registration still waiting for its deposit, when no registration is this
  // link's yet: the link pays it when its note covers the deposit, the fees and the tip.
  // Read off the entered identity too, so the wallet's own boot does not decide the modal.
  const accountAddress = claimDeps?.account.getAddress().toString() ?? loadWalletIdentity()?.address
  const unfunded =
    fragment &&
    accountAddress &&
    burnsLoaded &&
    continuation === null &&
    !ticketSignupCommitted(fragment)
      ? unfundedRegistration(accountAddress, burns)
      : null
  const [registrationsLoaded, setRegistrationsLoaded] = useState(false)
  useEffect(() => {
    let live = true
    const loaded = () => live && setRegistrationsLoaded(true)
    loadRegistrations().then(loaded, loaded)
    return () => {
      live = false
    }
  }, [])
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // The signup moves under Home: its address publishes, or its burn goes out from another surface.
  useEffect(() => {
    if (!fragment) return
    const offRegistrations = onTicketRegistrationsChanged(rerender)
    const offBurns = session().withdrawals.list.subscribe(rerender)
    return () => {
      offRegistrations()
      offBurns()
    }
  }, [fragment])
  // A claim of this link at work, from this mount or an earlier one.
  const running = useClaimRunning(fragment)
  const failure = useClaimFailure(fragment)
  // The link's registration moved past the claim, its funds seen and the name confirmed: the link
  // is done with, and so is its review.
  useEffect(() => {
    if (!fragment || !claimDeps || !burnsLoaded || continuation !== null) return
    if (!ticketSignupCommitted(fragment)) return
    clearClaimStash(fragment)
    onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment, claimDeps, burnsLoaded, continuation === null])
  const navigate = useNavigate()
  const config = getConfig()
  const sweepFee = useDepositSkim(config, continuation !== null || !!unfunded)
  const [beat, setBeat] = useState<ClaimBeat>()
  const [l1Open, setL1Open] = useState(false)
  const signInAbort = useRef<AbortController | null>(null)
  // The fragment this mount is showing; a claim whose fragment no longer matches is obsolete.
  const shown = useRef<string | null>(null)
  // Set as the sheet leaves, ahead of the re-render that clears `shown`: from then on the row alone
  // reports the claim, so a failure landing in that gap cannot reopen the prompt.
  const handedOff = useRef(false)
  const handOff = () => {
    if (handedOff.current) return
    handedOff.current = true
    onDone()
  }
  // The link Home is claiming on its own, handed off at the start: its failure reopens the review.
  const autoRun = useRef<string | null>(null)

  useEffect(() => {
    shown.current = fragment
    setClaiming(false)
    setBeat(undefined)
    setL1Open(false)
    if (!fragment) {
      setLink(null)
      return
    }
    try {
      // What this tab already read of the link: Home claims off it while it is read again.
      setLink(seededLink(fragment))
      setSeedOnly(readBefore(fragment))
    } catch {
      // A fragment that doesn't decode has nothing to prompt for.
      setLink(null)
      clearClaimStash(fragment)
      onDone()
      return
    }
    // Already claiming: nothing to prompt for, the notification row owns it, unless the review was
    // asked for, which then reports the claim at work.
    if (isClaimRunning(fragment) && !requested) {
      setLink(null)
      onDone()
      return
    }
    return () => {
      shown.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment])

  // The account, when unlocked, lets `sync_note` run under a real scope so `claimableFrom` is
  // read reliably; before that the placeholder sender serves.
  const account = claimDeps?.account
  const statusDeps: ViewLinkDeps | undefined = useMemo(
    () =>
      obsidionWallet && contractService
        ? { wallet: obsidionWallet, contractService, account }
        : undefined,
    [obsidionWallet, contractService, account],
  )

  const [readSettled, setReadSettled] = useState(false)
  const [noteMissed, setNoteMissed] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [answers, setAnswers] = useState(0)
  useEffect(() => {
    setReadSettled(false)
    setNoteMissed(false)
    if (!statusDeps || !fragment) return
    return watchLink(
      statusDeps,
      fragment,
      (fresh) => {
        setAnswers((n) => n + 1)
        setLink(fresh)
        setSeedOnly(false)
      },
      (e) =>
        showReportableError(e, "paylink:status", {
          message: `Could not check the link's status: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
      (noteRead) => {
        setReadSettled(true)
        setNoteMissed(!noteRead)
      },
    )
  }, [statusDeps, fragment, readAttempt])
  // A read that does not answer in the time the reads are given ends where reads that kept missing
  // the note do: on the re-read. A later answer still lands. A claim of this link holds the PXE the
  // reads queue behind, so that time runs only while none does.
  const claimBusy = running || claiming
  // A fresh read found the link closed while its claim had yet to fund the registration.
  const closedUnclaimed =
    !seedOnly && link?.status !== undefined && link.status !== "unclaimed" && !claimBusy
  // Every state but `submitted`, whose burn is on its way, still waits on the link.
  const waitingRecord =
    continuation && continuation.activation.state !== "submitted" ? continuation.record : undefined
  useEffect(() => {
    if (closedUnclaimed && waitingRecord) releaseLinkDeposit(waitingRecord)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the registration
  }, [closedUnclaimed, waitingRecord?.account, waitingRecord?.tag])
  useEffect(() => {
    if (!statusDeps || !fragment || readSettled || claimBusy) return
    const stalled = setTimeout(() => {
      setReadSettled(true)
      setNoteMissed(true)
    }, LINK_READ_BUDGET_MS)
    return () => clearTimeout(stalled)
  }, [statusDeps, fragment, readAttempt, answers, readSettled, claimBusy])

  const loading = !readSettled && link?.status === "unclaimed" && link.amount === undefined
  // Grace window: the claim's timestamp check runs at inclusion, so offer a claim only once the
  // window is known to be open.
  const claimWait = claimWaitSeconds(link?.claimableFrom, chainNow)
  const countdown = useClaimCountdown(claimWait, chainNow, obsidionWallet?.node)
  // The reads stopped with the window unknown: Home's own claim waits for a re-read.
  const unreadable = readSettled && link?.status === "unclaimed" && link.claimableFrom == null
  const retryRead = () => setReadAttempt((n) => n + 1)
  // The prompt and the review offer nothing off this tab's earlier read alone, and a re-read once
  // the reads stopped without the note: only a read here supplies its token, email and commitment.
  const offerRetry = readSettled && link?.status === "unclaimed" && noteMissed
  const offeredWait = seedOnly || offerRetry ? undefined : claimWait

  /**
   * Starts the claim; false when nothing could start. `auto`: Home's own try, retried, which may
   * start off this tab's earlier read.
   */
  const claim = (auto = false, fundRegistration = continuation !== null): boolean => {
    if (
      !fragment ||
      !link ||
      link.status !== "unclaimed" ||
      isClaimRunning(fragment) ||
      (auto ? claimWait : offeredWait) !== 0 ||
      // An entered account's link may fund its registration: nothing is claimed before the burns load.
      (!!accountAddress && !burnsLoaded)
    )
      return false
    if (continuation) {
      const live = readContinuation()
      if (live?.activation.state !== "ready") {
        rerender()
        return false
      }
    }
    if (!claimDeps) {
      showReportableError(
        new Error("The wallet is still loading — try again in a moment"),
        "paylink:claim",
      )
      return false
    }
    const owned = fragment
    const live = () => shown.current === owned && !handedOff.current
    // The hand-off means the rest of the claim outlives this mount: its operation's row reports the
    // end, not component state.
    handedOff.current = false
    startClaim(owned)
    setClaiming(true)
    setTapped(!auto)
    setBeat(undefined)
    // Only the Google popup is abortable; once the proof or the claim is running, nothing is.
    const signIn = new AbortController()
    signInAbort.current = signIn
    const attempt = (tries: number) =>
      runClaim(
        claimDeps,
        owned,
        link,
        (s) => {
          // Proving and submitting start before the passkey prompt; the sheet keeps its last beat.
          if (live() && s !== "proving" && s !== "submitting") setBeat(s)
        },
        fundRegistration,
        signIn.signal,
      ).then(
        () => {
          endClaim(owned)
          signInAbort.current = null
          if (live()) handOff()
        },
        (e: unknown) => {
          // Still running while it waits, so nothing else starts the same claim.
          if (auto && tries < AUTO_CLAIM_RETRIES && retryable(e)) {
            console.info(`[paylink] automatic claim failed, trying again: ${String(e)}`)
            setTimeout(() => attempt(tries + 1), AUTO_CLAIM_BACKOFF_MS * 2 ** tries)
            return
          }
          endClaim(owned)
          signInAbort.current = null
          // The claim reached the node and the bell follows it; offering Accept again would burn
          // the note twice.
          if (e instanceof TxInFlightError) {
            if (live()) handOff()
            return
          }
          // Home's own claim ended: the review, with its Claim, is the retry, so Home is asked to
          // show it again; the error sheet, when there is one, opens over it.
          const autoRan = autoRun.current === owned
          if (autoRan) {
            autoRun.current = null
            autoClaimGaveUp(owned)
            openClaimPrompt(owned)
          }
          if (isPasskeyCancelled(e) || e instanceof GoogleSignInCancelled) {
            if (live()) setClaiming(false)
            return
          }
          const windowCopy = claimWindowRevertCopy(e)
          const reason =
            windowCopy?.message ??
            fundingRefusalCopy(e) ??
            (e instanceof Error ? e.message : "Something went wrong")
          // The review says why wherever it opens next, its Claim the retry.
          claimFailed(owned, reason)
          // Failed before the hand-off: the reopened prompt is the retry, and the sheet says why.
          if (!live() && !autoRan) return
          if (live()) setClaiming(false)
          if (e instanceof EmailMismatchError) {
            showErrorModal({ title: "Email mismatch", message: reason, context: "paylink:claim" })
          } else if (windowCopy) {
            showErrorModal({ ...windowCopy, context: "paylink:claim" })
          } else {
            showReportableError(e, "paylink:claim", { title: "Claim failed", message: reason })
          }
        },
      )
    void attempt(0)
    return true
  }

  // The signup's own claim, started by Home: the link is a direct one, so nothing needs the user.
  // It waits for the claim window (off this tab's read of the note, else Home's own) to open, since
  // a try must not be spent on a revert. The hand-off is immediate; the row and the hero report
  // from here, and a failure leaves the link stashed for the review's Claim.
  const autoHeld =
    fragment === null
      ? "no link"
      : claimHeld
      ? `claim ${claimVerdict}`
      : continuation?.activation.state !== "ready"
      ? `ticket ${continuation?.activation.state ?? (claimDeps ? "not this account's" : "unread")}`
      : !link
      ? "link not loaded"
      : link.flavor !== "direct"
      ? "email link"
      : link.status !== "unclaimed"
      ? `link ${link.status}`
      : claimWait === undefined
      ? unreadable
        ? "claim window unreadable"
        : "claim window not read yet"
      : claimWait !== 0
      ? `claim window opens in ${claimWait}s`
      : !claimDeps
      ? "wallet loading"
      : claiming || isClaimRunning(fragment)
      ? "claim running"
      : autoClaimed.has(fragment)
      ? "already tried on this page"
      : undefined
  const ticketLink = fragment !== null && ticketSignupCommitted(fragment)
  useEffect(() => {
    if (!ticketLink || !link) return
    console.info(`[paylink] automatic claim ${autoHeld ? `held: ${autoHeld}` : "starting"}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change of the gate
  }, [ticketLink, autoHeld])
  // What Home's own claim of a ticket link waits for, which the hero says until the claim starts;
  // the hero shows it only for a link Home claims by itself.
  const autoHold: AutoClaimHold | undefined =
    !ticketLink ||
    fragment === null ||
    autoClaimed.has(fragment) ||
    claiming ||
    isClaimRunning(fragment)
      ? undefined
      : claimWait && countdown
      ? { countdown }
      : "preparing"
  const holdKey = typeof autoHold === "object" ? autoHold.countdown : autoHold
  useEffect(() => {
    if (fragment) holdAutoClaim(fragment, autoHold)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key folds the hold in
  }, [fragment, holdKey])
  useEffect(() => {
    if (!fragment) return
    return () => holdAutoClaim(fragment, undefined)
  }, [fragment])
  // What the automatic claim cannot get past on its own: the hero asks for the tap from here.
  const autoBlocked =
    continuation?.activation.state === "ready" &&
    (link?.flavor === "email" || unreadable || (link !== null && link.status !== "unclaimed"))
  useEffect(() => {
    if (autoBlocked && fragment) autoClaimGaveUp(fragment)
  }, [autoBlocked, fragment])
  // Home's own try of this link is still to come on this page, and the hero says so.
  const autoDue =
    fragment !== null &&
    continuation?.activation.state === "ready" &&
    link?.flavor === "direct" &&
    !autoBlocked &&
    !autoClaimed.has(fragment)
  useEffect(() => {
    if (autoHeld !== undefined || !fragment) return
    autoClaimed.add(fragment)
    autoRun.current = fragment
    if (claim(true)) handOff()
    else autoRun.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the gate folds every input in
  }, [autoHeld, fragment])

  // Registered as running like an ordinary claim, so a remount mid-burn shows nothing instead of
  // offering Accept again. The withdrawal record's own live row reports the burn; the stash clears
  // only once it mined.
  const claimToL1 = (
    {
      recipient,
      screener,
      walletName,
      receiveAsset,
      quote,
      zkProof,
      swap,
      proverTip,
    }: ClaimToL1Choice,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<void> => {
    if (!fragment || !link || isClaimRunning(fragment)) return Promise.resolve()
    if (link.status !== "unclaimed" || offeredWait !== 0) {
      return Promise.reject(new Error("This link is not currently claimable"))
    }
    if (!claimDeps) {
      return Promise.reject(new Error("The wallet is still loading — try again in a moment"))
    }
    const owned = fragment
    startClaim(owned)
    return claimLinkToL1(
      claimDeps,
      owned,
      recipient,
      screener,
      onStage,
      walletName,
      receiveAsset,
      quote,
      zkProof,
      swap,
      proverTip,
    )
      .then(() => clearClaimStash(owned))
      .finally(() => endClaim(owned))
  }

  const dismiss = () => {
    if (fragment) clearClaimStash(fragment)
    onDone()
  }

  const hold = continuation
    ? ticketHoldNotice(continuation.activation.state, continuation.record.tag)
    : undefined
  const submitted = continuation?.activation.state === "submitted"
  // The review's amount: the note as the signup read it, else as this prompt's own read has it.
  const paylinkAmount =
    continuation?.stash.amount !== undefined
      ? BigInt(continuation.stash.amount)
      : link?.amount !== undefined
      ? parseUnits(link.amount, tokenDecimalsForNetwork(config.network))
      : undefined
  const registrationPage = () => {
    if (!continuation) return
    onDone()
    navigate(`/claim/${continuation.record.tag}`)
  }
  // A direct link's signup shows its review only once Home's own claim has been tried, when the
  // reads stopped without the claim window and the review's re-read is the way on, or when the
  // link closed before that try (cancelled, expired, spent) and the review is where that is said;
  // until then the hero reports the wait and the claim starts by itself.
  const reviewing =
    continuation !== null &&
    (requested ||
      link?.flavor === "email" ||
      unreadable ||
      (link !== null && link.status !== "unclaimed") ||
      (fragment !== null && autoClaimed.has(fragment)))
  // Only a ready signup has a fundable quote; the split it was offered stands in.
  const reviewSchedule = !continuation
    ? undefined
    : continuation.activation.state === "ready"
    ? continuation.activation.schedule
    : {
        fee: BigInt(continuation.stash.schedule.fee),
        min: BigInt(continuation.stash.schedule.minDeposit),
      }
  // Home's own claim burns what the signup committed; only the review on screen quotes again, and
  // only while nothing burned yet.
  const reviewShown =
    reviewing &&
    !!fragment &&
    !!link &&
    !l1Open &&
    !(claiming && !requested) &&
    !running &&
    !submitted
  const reviewRecord = continuation?.record
  const reviewTerms = useRegistrationTerms(reviewRecord?.account, reviewRecord?.tag)
  const reviewWithdrawalFee = useActiveWithdrawalFee(reviewShown)
  const reviewSpeed = useRegistrationSpeed({
    active: reviewShown,
    node: obsidionWallet?.node,
    noteAmount: paylinkAmount,
    schedule: reviewSchedule,
    withdrawalFee: reviewWithdrawalFee,
    initialSpeed: reviewTerms?.speed,
    onCommit: (tip, speed) => {
      if (reviewRecord)
        commitRegistrationProverTip(reviewRecord.account, reviewRecord.tag, tip, speed)
    },
    commitKey: reviewRecord && `${reviewRecord.account}:${reviewRecord.tag}`,
  })
  // The registration this link may fund: its split, shown before the claim, with the speed choice
  // that commits the tip. A link with no voucher, or a note short of the split, claims as any other.
  const voucher = useLinkVoucher(unfunded ? link : null)
  const fundSchedule = unfunded?.schedule
  const fundWithdrawalFee = useActiveWithdrawalFee(!!unfunded)
  const fundTip = useRef<{ tip: bigint; speed: "standard" | "faster" }>(undefined)
  const fundSpeed = useRegistrationSpeed({
    active: !!unfunded && voucher.uses !== 0,
    node: obsidionWallet?.node,
    noteAmount: paylinkAmount,
    schedule: fundSchedule,
    withdrawalFee: fundWithdrawalFee,
    onCommit: (tip, speed) => {
      fundTip.current = { tip, speed }
    },
  })
  // The review is chosen, and priced, only once the voucher and the sweep fee answered.
  const fundAnswered = voucher.uses !== undefined && sweepFee !== undefined
  const fundQuote =
    fundAnswered &&
    fundSchedule &&
    fundWithdrawalFee !== undefined &&
    fundSpeed.proverTip !== undefined
      ? paylinkSignupQuote({
          ...(paylinkAmount !== undefined ? { paylink: paylinkAmount } : {}),
          schedule: fundSchedule,
          withdrawalFee: fundWithdrawalFee,
          sweepFee,
          proverTip: fundSpeed.proverTip,
        })
      : undefined
  // Which modal applies is decided before any shows: the plain prompt never flashes ahead of the
  // review. A read that fails, or a decision past its time, falls back to the plain prompt.
  const [detectExpiredFor, setDetectExpiredFor] = useState<string>()
  const detectExpired = !!fragment && detectExpiredFor === fragment
  const fundRefused =
    !unfunded ||
    voucher.uses === 0 ||
    voucher.error !== undefined ||
    detectExpired ||
    link?.status !== "unclaimed" ||
    fundQuote?.covers === false
  const detecting =
    continuation === null &&
    !!accountAddress &&
    !detectExpired &&
    (!registrationsLoaded || !burnsLoaded || (!fundRefused && fundQuote === undefined))
  useEffect(() => {
    if (!detecting || !fragment) return
    const timer = setTimeout(() => setDetectExpiredFor(fragment), DETECT_BUDGET_MS)
    return () => clearTimeout(timer)
  }, [detecting, fragment])
  // The hero asks for no deposit while the link may pay an entered account's unfunded registration,
  // and leads back to the review once it does. A ticket signup keeps its own claiming hero.
  const linkFunding =
    !fragment || !unfunded || link?.status !== "unclaimed"
      ? null
      : detecting
      ? "checking"
      : !fundRefused && fundQuote !== undefined
      ? "review"
      : null
  useEffect(() => {
    if (!fragment) return
    setLinkFunding(linkFunding ? { fragment, state: linkFunding, amount: paylinkAmount } : null)
  }, [fragment, linkFunding, paylinkAmount])
  const fundAndClaim = () => {
    if (!unfunded || !fragment || fundQuote?.covers !== true || !voucher.uses) return
    fundSpeed.settle()
    const committed = fundTip.current ?? { tip: 0n, speed: "standard" as const }
    // The terms read back at once: the claim's slice is priced off this binding.
    void bindLinkDeposit(
      unfunded.record,
      { fragment, amount: paylinkAmount, senderTag: link?.senderTag },
      committed.tip,
      committed.speed,
    )
    claim(false, true)
  }

  // A review opened over a running or sent claim shows the tip that claim burns.
  const proverTip =
    reviewSpeed.proverTip ?? (reviewShown ? undefined : committedProverTip(reviewTerms))

  // A signup's claim keeps its review on screen while it runs, so it closes there: one asked for,
  // or one tapped on a direct link. An email link's sign-in has the claim sheet.
  const reviewKept = continuation !== null && (requested || (tapped && link?.flavor === "direct"))
  const modal =
    !fragment || !link ? null : l1Open ? (
      <ClaimToL1Modal
        link={link}
        ready={!!claimDeps}
        onClose={() => setL1Open(false)}
        onHandOff={onDone}
        onConfirm={claimToL1}
        planSwap={(recipient, receiveAsset, quote, amount, proverTip) =>
          claimDeps
            ? planLinkClaimSwap(
                claimDeps,
                fragment,
                amount,
                recipient,
                receiveAsset,
                quote,
                proverTip,
              )
            : Promise.reject(new Error("The wallet is still loading — try again in a moment"))
        }
        node={obsidionWallet?.node}
      />
    ) : claiming && !reviewKept ? (
      <ClaimProvingModal
        beat={beat}
        onCancel={beat === "signing-in" ? () => signInAbort.current?.abort() : undefined}
        onLeave={handOff}
      />
    ) : continuation && !reviewing ? null : continuation ? (
      // A signup's claim keeps its own step: the review, which closes while a claim runs on in the
      // background, its status the review's word.
      <ClaimReviewStep
        quote={
          !reviewSchedule || proverTip === undefined || reviewWithdrawalFee === undefined
            ? undefined
            : paylinkSignupQuote({
                ...(paylinkAmount !== undefined ? { paylink: paylinkAmount } : {}),
                schedule: reviewSchedule,
                sweepFee,
                proverTip,
                withdrawalFee: reviewWithdrawalFee,
                ticket: !reviewTerms?.paylinkDeposit,
              })
        }
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={tokenDecimalsForNetwork(config.network)}
        speed={<SpeedRow choice={reviewSpeed.choice} outcome={reviewSpeed.outcome} />}
        memo={continuation.stash.memo ?? link.memo}
        senderTag={continuation.stash.senderTag ?? link.senderTag}
        busy={claiming}
        onHandOff={handOff}
        status={
          claiming || running
            ? "Claiming"
            : submitted
            ? `Registering @${continuation.record.tag}`
            : link.status !== "unclaimed" || offerRetry
            ? LINK_STATUS_LABEL[link.status]
            : offeredWait === undefined
            ? "Checking when this link can be claimed…"
            : offeredWait
            ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE
            : LINK_STATUS_LABEL[link.status]
        }
        statusDetail={
          submitted && !claiming && !running
            ? "Waiting for the network to sweep the deposit"
            : undefined
        }
        amount={paylinkAmount}
        // A claim at work or sent has nothing left to claim; its status says what follows.
        settled={running || submitted}
        error={
          running || submitted
            ? undefined
            : closedLinkMessage(link.status) ??
              hold ??
              failure ??
              (offerRetry ? "Couldn't check when this link can be claimed." : undefined)
        }
        notices={
          hold && !submitted ? (
            <button
              type="button"
              className="zkm-btn-reset ww-send-to__link"
              onClick={registrationPage}
            >
              Check registration
            </button>
          ) : !hold && offerRetry && !claimBusy ? (
            <button type="button" className="zkm-btn-reset ww-send-to__link" onClick={retryRead}>
              Try again
            </button>
          ) : undefined
        }
        claimable={
          continuation.activation.state === "ready" &&
          link.status === "unclaimed" &&
          offeredWait === 0 &&
          !running
        }
        onClaim={() => guard("claim", () => void claim())}
        onClose={autoDue && onReviewClosed ? onReviewClosed : onDone}
      />
    ) : detecting ? null : !fundRefused ? (
      <ClaimReviewStep
        quote={fundQuote}
        amount={paylinkAmount}
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={tokenDecimalsForNetwork(config.network)}
        speed={<SpeedRow choice={fundSpeed.choice} outcome={fundSpeed.outcome} />}
        memo={link.memo}
        senderTag={link.senderTag}
        busy={claiming}
        onHandOff={handOff}
        status={
          offeredWait === undefined
            ? "Checking when this link can be claimed…"
            : offeredWait
            ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE
            : LINK_STATUS_LABEL[link.status]
        }
        error={failure}
        claimable={fundQuote?.covers === true && offeredWait === 0 && !running}
        onClaim={fundAndClaim}
        // Close keeps the link: the hero leads back to this review.
        onClose={onDone}
      />
    ) : (
      <ClaimLinkModal
        link={link}
        claimWait={offeredWait}
        countdown={countdown}
        loading={loading}
        mustUpgrade={claimVerdict === "upgrade"}
        waiting={claimVerdict === "moving" ? balanceMovingCopy.message : undefined}
        onRetryRead={offerRetry ? retryRead : undefined}
        onClose={dismiss}
        onClaim={() => guard("claim", () => void claim())}
        onClaimToL1={() => guard("claim", () => setL1Open(true))}
      />
    )

  return { modal }
}

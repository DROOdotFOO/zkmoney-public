import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { Address } from "viem"
import { useNavigate } from "react-router-dom"
import {
  SIPADepositStore,
  formatDateLabel,
  formatTimeLabel,
  isStuckSweep,
  SIPA_PROCESSING_COPY,
  STUCK_SWEEP_MS,
  depositPhaseCopy,
  sipaReasonShown,
  depositDetailOffer,
  depositOwed,
  fundsIn,
  useStore,
} from "@obsidion/front-core"
import { Card, Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import paylinkCoins from "../../assets/home/paylink-coins.webp"
import { DepositDetailModal } from "../../ui/screens/DepositDetailModal"
import rowCopy from "../../ui/activity/ActivityRow.copy"
import { registrationRecordForSipa } from "./webRegistration"
import { DepositExitModal } from "../deposit/DepositExitModal/DepositExitModal"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { openClaimPrompt, openTicketClaimReview, useLinkFunding } from "../paylink/claimPrompt"
import { peekClaimStash } from "../paylink/claimStash"
import {
  useAutoClaimGaveUp,
  useAutoClaimHold,
  useClaimRunning,
  type AutoClaimHold,
} from "../paylink/runningClaims"
import { decodeLink } from "../paylink/sponsoredPaylink"
import { ticketActivation } from "../paylink/ticketContinuation"
import { sipaProcessingObserver, useSipaProcessing } from "../deposit/sipaProcessing"
import { useDepositAdmission } from "../identity/admission"
import {
  getPendingStore,
  useRegistrationEscalated,
  useRegistrationPublishStalled,
} from "./webRegistration"
import { useOpenRegistration } from "./openRegistration"
import {
  quoteExpired,
  reservedUntil,
  signedWithoutSchedule,
  termsUnpriced,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useRegistrationTerms,
} from "./registrationTerms"
import { REGISTRATIONS_PAUSED_NOTICE } from "./onboardingErrorCopy"
import { formatTokenAmount } from "./steps/DepositTermsRows"
import { registrationRecoveryNeeded, useRegistrationRefunded } from "./registrationQuoteRecovery"
import { reportRegistrationLapsed } from "./registrationFunnel"
import { session } from "../../platform/session"

const CLOCK_MS = 60_000

/** A direct link, which Home claims without a tap; an email link's sign-in needs one. */
function directLink(fragment: string): boolean {
  try {
    return decodeLink(fragment).flavor === "direct"
  } catch {
    return false
  }
}

/** What the hero says while Home's own claim of the link waits to start. */
function holdBody(hold: AutoClaimHold): string {
  return hold === "preparing"
    ? "Getting your wallet ready to claim your payment."
    : `${hold.countdown}. New links wait a moment so the sender can cancel a mistake.`
}

/**
 * Where the open registration's deposit is on the rail, as the bell's live row words it, or null
 * before the funds are seen and once they are credited. A deposit waiting for its sweep says why,
 * by the shared `sipaReasonShown` rule.
 */
function railLabel(): string | null {
  const { deposit, shown } = railReason()
  if (!deposit) return null
  return shown
    ? SIPA_PROCESSING_COPY[shown.reason.kind].short
    : depositPhaseCopy(deposit).live ?? null
}

/** A stated reason or a stuck sweep has no known end, so the hero promises no short wait. */
function railWaitOpenEnded(): boolean {
  const { deposit, shown } = railReason()
  return shown !== undefined || (deposit !== null && isStuckSweep(deposit))
}

/** When the open deposit's sweep turns stuck, if that is still ahead. */
function railStuckAt(): number | null {
  const { deposit } = railReason()
  if (!deposit || isStuckSweep(deposit)) return null
  return deposit.phase === "sweeping" || deposit.phase === "broadcast"
    ? deposit.startTime + STUCK_SWEEP_MS
    : null
}

function railReason() {
  const open = getPendingStore().current()
  const deposit = open ? SIPADepositStore.get(webStorage).get(open.sipaAddress as never) : null
  if (!deposit) return { deposit: null, shown: undefined }
  const processing = sipaProcessingObserver()?.stateFor(deposit.sipaAddress)
  return { deposit, shown: sipaReasonShown(processing, deposit) ? processing : undefined }
}

function subscribeRailStage(onChange: () => void): () => void {
  const stopDeposits = SIPADepositStore.get(webStorage).onListChanged(onChange)
  const stopProcessing = sipaProcessingObserver()?.subscribe(onChange)
  return () => {
    stopDeposits()
    stopProcessing?.()
  }
}

/** The registration's deposit as the activity feed shows it, kept current while open. */
function LiveDepositDetail(props: { sipaAddress: string; tag: string; onClose: () => void }) {
  const store = SIPADepositStore.get(webStorage)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => store.onListChanged(rerender), [store])
  const { state: processing } = useSipaProcessing(props.sipaAddress)
  const [exit, setExit] = useState<NonNullable<ReturnType<typeof depositDetailOffer>>>()
  const deposit = store.get(props.sipaAddress as Address)
  if (!deposit) return null
  if (exit) {
    return (
      <DepositExitModal
        record={deposit}
        reason={exit.reason}
        canSweep={exit.canSweep}
        sweepable={exit.sweepable}
        onClose={props.onClose}
      />
    )
  }
  const offer = depositDetailOffer(deposit, {
    processing,
    registration: registrationRecordForSipa(deposit.sipaAddress) ?? undefined,
    now: Date.now(),
  })
  return (
    <DepositDetailModal
      record={deposit}
      registrationTag={props.tag}
      exit={
        offer
          ? {
              title: offer.action === "sweep" ? rowCopy.action.sweep : rowCopy.action.recover,
              sweep: offer.canSweep,
              onStart: () => setExit(offer),
            }
          : undefined
      }
      onClose={props.onClose}
    />
  )
}

/**
 * The standing reminder for a name entered before its deposit (registration-fee.md Campaign:
 * Free names enter at once, and a waived reload may enter early): that a deposit is owed and how
 * long the reservation holds. The caller's `ask` renders the plain deposit ask with its hold and
 * waiver note; a quote to refresh, paused registrations and an unpublished address are banners that
 * lead to the pending step. A ticket-funded name reads as claiming while Home claims its link, which
 * also publishes its address. Once funds are in it reads as claiming until the name registers.
 */
export function SecureNameNoticeCard({ ask }: { ask: (note: string) => ReactNode }) {
  const navigate = useNavigate()
  const config = getConfig()
  const escalated = useRegistrationEscalated()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const open = useOpenRegistration()
  const record = open?.record ?? null
  const rail = useSyncExternalStore(subscribeRailStage, railLabel)
  const moment = useSyncExternalStore(subscribeRailStage, railWaitOpenEnded)
    ? ""
    : " This only takes a moment."
  const stuckAt = useSyncExternalStore(subscribeRailStage, railStuckAt)
  const [, tick] = useState(0)
  useEffect(() => {
    if (stuckAt === null) return
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, stuckAt - Date.now()))
    return () => clearTimeout(timer)
  }, [stuckAt])
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const publishStalled = useRegistrationPublishStalled(record)
  // Whether this page is claiming the stashed link, for a ticket-funded name, or will on its own.
  const stashed = peekClaimStash()
  const claimRunning = useClaimRunning(stashed)
  const autoGaveUp = useAutoClaimGaveUp(stashed)
  const autoHold = useAutoClaimHold(stashed)
  const linkFunding = useLinkFunding()
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  const sweepFee = useDepositSkim(config, record !== null, readAttempt)
  const chainAmounts = useRegistrationSchedule(
    config,
    record !== null && unsignedFallback,
    readAttempt,
    sweepFee,
  )
  useChainReadRetry(
    record !== null && ((unsignedFallback && chainAmounts === undefined) || sweepFee === undefined),
    retryReads,
  )
  useEffect(() => {
    if (!record) return
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [record])
  const [detailOpen, setDetailOpen] = useState(false)
  const lapsed =
    open?.stage !== undefined &&
    depositOwed(open.stage) &&
    !depositAdmitted &&
    quoteExpired(terms, nowMs)
  const burns = useStore(session().withdrawals.list)
  useEffect(() => {
    if (lapsed && record) reportRegistrationLapsed(record.account, record.phase)
  }, [lapsed, record])

  // Unknown while the withdrawals load: the card waits rather than ask for a funded deposit.
  if (!open || !record || open.stage === undefined || !burns.hydrated) return null
  const { stage } = open
  // A paylink-funded registration is never asked for an L1 deposit: its link's claim funds and
  // publishes the SIPA. What it needs is decided before any price: progress while this page claims
  // or the burn is on its way; the claim while the bound link is on this tab; else the way back to
  // the link or the renewal.
  const ticket = ticketActivation(record, terms, burns.records, nowMs)
  if (ticket) {
    const holdEnds = reservedUntil(terms, nowMs)
    const heldFor = holdEnds === undefined ? "" : ` until ${formatDateLabel(holdEnds)}`
    // The burn's record is written before its batch signs, so `submitted` alone would read as sent
    // too early: the page's own claim covers proving and the send. Home claims a ready direct link
    // by itself, so the tap is asked for only once that try is over without a claim.
    const claimingLink =
      (claimRunning && (ticket.state === "ready" || ticket.state === "submitted")) ||
      (ticket.state === "ready" && !autoGaveUp && directLink(ticket.stash.fragment))
    // Home's own claim has not started: what it waits for, since the bell has nothing yet.
    const held = claimingLink && !claimRunning ? autoHold : undefined
    const submitted = claimingLink || ticket.state === "submitted"
    const title = held
      ? `Claiming @${record.tag} shortly`
      : submitted
      ? `Claiming @${record.tag}`
      : ticket.state === "ready"
      ? "Claim your payment"
      : ticket.state === "blocked"
      ? `This payment cannot fund @${record.tag}`
      : ticket.state === "renew"
      ? "Refresh your reservation"
      : "Open your payment link"
    const body = held
      ? holdBody(held)
      : claimingLink
      ? "Claiming your payment and setting up your account."
      : ticket.state === "submitted"
      ? rail
        ? `${rail}. This only takes a moment.`
        : `Payment claimed. @${record.tag} registers once the network sweeps the deposit. Nothing to send.`
      : ticket.state === "ready"
      ? `@${record.tag} is reserved${heldFor}. The payment you were sent funds it. Claim it to finish.`
      : ticket.state === "blocked"
      ? "The renewed price is not one the payment covers. Check on the registration."
      : ticket.state === "renew"
      ? `The reservation for @${record.tag} needs a fresh quote. Open it to renew.`
      : `@${record.tag} is reserved${heldFor}. Open the payment link you were sent again to claim it and fund the tag.`
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="secure-name-notice"
        data-ticket-state={ticket.state}
        aria-label={`Activate @${record.tag}`}
        onClick={() => openTicketClaimReview() || navigate(`/claim/${record.tag}`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">{title}</span>
          <span className="ww-banner__body">{body}</span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {submitted ? (
            <Spinner size={12} color="#fff" />
          ) : (
            <Icon name="chevron-right" size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  const needsRefund = registrationRecoveryNeeded(
    record,
    terms,
    { depositAdmitted, refunded },
    sweepFee || undefined,
  )
  // A past refund holds this hero only while the restart it calls for is still owed: a registration
  // resumed under the corrected quote wants its deposit again. A funded one is the sweep's to finish
  // unless its committed quote must be recovered first.
  if (needsRefund || (record.phase === "awaiting_deposit" && depositAdmitted)) {
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="registration-pending-notice"
        aria-label={`Check registration for @${record.tag}`}
        onClick={() => navigate(`/claim/${record.tag}?recovery=1`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {needsRefund ? "Registration needs recovery" : `Claiming @${record.tag}`}
          </span>
          <span className="ww-banner__body">
            {needsRefund
              ? refunded
                ? "Your wallet is open. The old deposit was recovered. Register at the earned price."
                : "Your wallet is open. Recover the old deposit, then register at the earned price."
              : `Your wallet is open. Registration for @${record.tag} is still pending. Check its status. Do not send another deposit.`}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span
          className="ww-banner__chevron"
          {...(needsRefund ? {} : { "data-testid": "deposit-detected" })}
        >
          {needsRefund ? (
            <Icon name="chevron-right" size={8.5} color="#fff" />
          ) : (
            <Spinner size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  // Funds are in: the hero holds and spins until the name is registered. A deposit still waiting
  // for its sweep after the background driver gave up says so and stays the way back in.
  if (fundsIn(stage) || stage === "funding") {
    const stuck = escalated && (stage === "received" || stage === "sweeping")
    return (
      <>
        <button
          type="button"
          className="zkm-btn-reset ww-banner ww-banner--activate"
          data-testid="claiming-notice"
          aria-label={`Claiming @${record.tag}`}
          onClick={() =>
            openTicketClaimReview() ||
            (SIPADepositStore.get(webStorage).get(record.sipaAddress as Address)
              ? setDetailOpen(true)
              : navigate(`/claim/${record.tag}`))
          }
        >
          <span className="ww-banner__text">
            <span className="ww-banner__title">Claiming @{record.tag}</span>
            <span className="ww-banner__body">
              {stuck
                ? "This is taking longer than expected. Check on it."
                : `${
                    rail ?? (stage === "funding" ? "Securing your tag" : "Deposit received")
                  }.${moment}`}
            </span>
          </span>
          <img src={paylinkCoins} alt="" />
          <span className="ww-banner__chevron" data-testid="deposit-detected">
            <Spinner size={12} color="#fff" />
          </span>
        </button>
        {detailOpen && (
          <LiveDepositDetail
            sipaAddress={record.sipaAddress}
            tag={record.tag}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </>
    )
  }
  // A stashed link that may pay the deposit: no deposit is asked for while Home checks it, and
  // once it pays, the way back to its review stands in for the ask.
  if (depositOwed(stage) && linkFunding && linkFunding.fragment === stashed) {
    const checking = linkFunding.state === "checking"
    const amount =
      linkFunding.amount === undefined
        ? "The payment"
        : `The ${formatTokenAmount(
            linkFunding.amount,
            tokenDecimalsForNetwork(config.network),
            WALLET_TOKEN_SYMBOL,
          )}`
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="secure-name-notice"
        data-link-funding={linkFunding.state}
        aria-label={checking ? "Checking your payment" : `Claim your payment for @${record.tag}`}
        disabled={checking}
        onClick={() => openClaimPrompt(linkFunding.fragment)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {checking ? "Checking your payment…" : "Claim your payment"}
          </span>
          <span className="ww-banner__body">
            {checking
              ? `Seeing whether the payment you were sent pays for @${record.tag}.`
              : `${amount} you were sent pays for @${record.tag}. Claim it to finish.`}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {checking ? (
            <Spinner size={12} color="#fff" />
          ) : (
            <Icon name="chevron-right" size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  if (!depositOwed(stage)) return null
  // An unpriced quote cannot waive a fee it never priced.
  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  // Past the stored deadline the resume path signs a fresh quote, so the banner leads back there.
  const quoteStale = quoteExpired(terms, nowMs)
  const paused = unsignedFallback && chainAmounts === null
  // An unpublished address is not asked for: the pending step's retry publishes it first.
  const stalled = !quoteStale && !paused && publishStalled
  // The hold is the headline. The amount it holds is the sheet's to name.
  const held = quoteStale ? undefined : reservedUntil(terms, nowMs)
  const heldLine =
    held === undefined
      ? undefined
      : `Reserved until ${formatDateLabel(held)}, ${formatTimeLabel(held)}.`
  if (!quoteStale && !paused && !stalled)
    return ask([heldLine, feeWaived && "The tag is free."].filter(Boolean).join(" "))

  return (
    <button
      type="button"
      className="zkm-btn-reset ww-banner ww-banner--activate"
      data-testid="secure-name-notice"
      aria-label={`Activate @${record.tag}`}
      onClick={() => navigate(`/claim/${record.tag}`)}
    >
      <span className="ww-banner__text">
        <span className="ww-banner__title">
          {quoteStale
            ? "Refresh your deposit"
            : paused
            ? "Activation is paused"
            : "Activate account"}
        </span>
        <span className="ww-banner__body">
          {quoteStale
            ? "The deposit amount needs a refresh. Open it to get the current amount."
            : paused
            ? REGISTRATIONS_PAUSED_NOTICE
            : `${
                heldLine ? `${heldLine} ` : ""
              }Your deposit address was not published. Check on it to try again.`}
        </span>
      </span>
      <img src={paylinkCoins} alt="" />
      <span className="ww-banner__chevron">
        <Icon name="chevron-right" size={8.5} color="#fff" />
      </span>
    </button>
  )
}

/**
 * The standing prompt for a nameless account: the wallet works, but receiving by tag, sponsored
 * fees, and messaging all wait on a registered name. Leads to the name step; the ceremony there
 * asserts the existing passkey instead of minting one.
 */
export function RegisterNameCard() {
  const navigate = useNavigate()
  const identity = loadWalletIdentity()
  if (!identity || identity.handle) return null
  return (
    <Card padding={16} style={{ marginBottom: 24 }}>
      <div
        data-testid="register-name-prompt"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <span
          className="zkm-type-card-title"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
        >
          Pick your name
        </span>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          People pay a name, not an address. Register yours whenever you are ready.
        </span>
        <PrimaryGradientButton title="Register a name" onClick={() => navigate("/claim")} />
      </div>
    </Card>
  )
}

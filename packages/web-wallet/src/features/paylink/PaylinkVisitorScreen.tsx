import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { REGISTRATION_SCHEDULE_DEFAULTS, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  canSelfFinalizeWithdrawal,
  withdrawalAmounts,
  type WithdrawalRecord,
  useResource,
} from "@obsidion/front-core"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { fireEvent, fireOnboardingEvent, reportLanding } from "../../lib/analytics"
import { markTicketChannel } from "../../lib/trafficSource"
import { shortL1Addr, usdFigure } from "../../ui/format"
import { BalanceSkeleton } from "../../ui/Skeletons"
import type { EntryOpener, NotificationScope } from "../../ui/NotificationsPanel/NotificationsPanel"
import { NotificationsBell } from "../../ui/NotificationsBell/NotificationsBell"
import { withdrawalStatus } from "../../ui/screens/WithdrawalDetailModal"
import { operationIdOf } from "../operations/operationEntries"
import { TabLine } from "../operations/TabLine"
import { releaseNote } from "../withdraw/waitingNote"
import { SwapExitModal } from "../withdraw/SwapExitModal"
import { swapExitReasonFor, type SwapExitReason } from "@obsidion/front-core"
import { WithdrawalExitModal } from "../withdraw/WithdrawalExitModal"
import { InvitationChrome } from "../onboarding/InvitationChrome"
import {
  clearTicketSignup,
  peekTicketSignup,
  receivesToAccount,
  stashClaimLink,
  stashTicketSignup,
} from "./claimStash"
import { useGoldenTicketOffer, type GoldenTicketOffer } from "./goldenTicketOffer"
import { ticketKnownSpent } from "./ticketSpent"
import { PaylinkOnboardingScreen } from "./PaylinkOnboardingScreen"
import { ticketSignupCommitted, ticketSignupResumable } from "./ticketContinuation"
import {
  belowTicketThresholdCopy,
  linkBaseUnits,
  linkTicketEligibility,
  ticketThresholdLabel,
} from "./ticketThreshold"
import { ClaimProgressModal, hasClaimReceipt } from "./ClaimProgressModal"
import { ClaimToL1Modal } from "./ClaimToL1Modal"
import { usePolledChainSeconds } from "./chainTime"
import { claimWaitSeconds, useClaimCountdown } from "./claimWindow"
import { cashOutLink, planCashOutSwap } from "./paylinkExit"
import { useLinkVoucher, useLinkWithdrawal } from "./usePaylinkDeps"
import { CLOSED_LINK_COPY } from "./claimWindow"
import { senderLine } from "./senderLine"
import type { PaymentLink } from "./types"
import { useSession } from "../../platform/session"

/** A typed name's own schedule, base units: what a link with no ticket pays for it. */
const NAME_SCHEDULE = {
  fee: REGISTRATION_SCHEDULE_DEFAULTS.standard.fee.toString(),
  minDeposit: REGISTRATION_SCHEDULE_DEFAULTS.standard.min.toString(),
}

/**
 * `/link#…` for a visitor with no account. A link whose escrow holds a voucher offers two ways to
 * take the money — an account here, or a claim to an external Ethereum wallet the link itself pays
 * for — and asks which before either. Without a voucher the only way through is signup, so the page
 * opens on it, and the stashed fragment reopens as the claim prompt once that lands.
 *
 * Both choices stay visible while funding is checked; the external claim enables once the read
 * succeeds and the signer connects. A failed check offers retry instead of silently selecting signup.
 *
 * A cash-out is an ordinary operation with the page as its row: status and whether the page may
 * close, then its receipt, which the bell opens too.
 */
export function PaylinkVisitorScreen({
  link,
  statusSettled = true,
  noteMissed = false,
  onRetryStatus,
}: {
  link: PaymentLink
  /** The page's status read is over. The voucher read waits for it: a fresh escrow's note is
   *  readable only a few blocks late, and the voucher read would miss it the same way. */
  statusSettled?: boolean
  /** The status reads stopped without the note: this tab's earlier read shows its amount and
   *  window, but not the token the cash-out prices its fee in. */
  noteMissed?: boolean
  /** Reads the link's status again. */
  onRetryStatus: () => void
}) {
  const navigate = useNavigate()
  const { state: routeState } = useLocation()
  const obsidionWallet = useResource(useSession().wallet)
  // A claim is offered only once the window is known to be open; the chain refuses one before.
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)
  const claimWait = claimWaitSeconds(link.claimableFrom, chainNow)
  const countdown = useClaimCountdown(claimWait, chainNow, obsidionWallet?.node)
  // The status reads stopped without the note, so the cash-out waits on a re-read.
  const unreadable =
    statusSettled && link.status === "unclaimed" && (noteMissed || link.claimableFrom == null)
  const { uses, deps, error, retry } = useLinkVoucher(link, { enabled: statusSettled })
  const withdrawal = useLinkWithdrawal(link)
  const [signup, setSignup] = useState(false)
  // Decided once, when signup starts: the claim that ends the ticket signup clears its stash, and
  // the wizard must not remount into an ordinary signup under the user while it finishes.
  const [ticketSignup, setTicketSignup] = useState(false)
  const [cashOut, setCashOut] = useState(false)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [exit, setExit] = useState<"finalize" | SwapExitReason | null>(null)
  // The manual exits open on elapsed time, not on a record write, so the page re-reads the clock.
  const [now, setNow] = useState(Date.now)
  const burned = !!withdrawal?.l2TxHash
  useEffect(() => {
    if (!burned) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [burned])
  // The network's ticket offer decides what "Receive to zk.money" means: the link paying for the
  // account (the three-step signup), or an ordinary signup with the link claimed on Home after. A
  // read that failed decides neither, so the choice retries it instead.
  const { offer: offered, failed: offerFailed, retry: retryOffer } = useGoldenTicketOffer()
  // A ticket this browser already saw refused as spent is no ticket.
  const offer = offered && ticketKnownSpent(link.fragment) ? null : offered

  useEffect(() => {
    stashClaimLink(link.fragment)
  }, [link.fragment])
  useEffect(() => reportLanding("paylink"), [])

  // Leaving the page (Close, back, another route) before the tag is claimed drops the ticket
  // intent; the link stays stashed for an ordinary claim. Once the ticket bought a registration
  // the marker is that signup's continuation and outlives this page.
  useEffect(() => {
    if (!ticketSignup) return
    return () => {
      if (!ticketSignupCommitted(link.fragment)) clearTicketSignup()
    }
  }, [ticketSignup, link.fragment])

  // A shared browser holds other visitors' cash-outs and other notifications: this page's bell
  // shows only this link's.
  const localId = withdrawal?.localId
  const operationId = withdrawal?.operationId
  const scope = useMemo<NotificationScope>(
    () => ({
      entry: (entry) => {
        const target = entry.target as { type: string; bridgeKind?: string; sourceId?: string }
        const own =
          target.type === "bridge.txDetail" &&
          target.bridgeKind === "withdrawal" &&
          localId !== undefined &&
          target.sourceId === localId
        return own || (operationId !== undefined && operationIdOf(entry.id) === operationId)
      },
      operation: (id) => operationId !== undefined && id === operationId,
    }),
    [localId, operationId],
  )
  const openEntry: EntryOpener = () =>
    withdrawal && hasClaimReceipt(withdrawal) ? () => setReceiptOpen(true) : null
  const bell = <NotificationsBell openEntry={openEntry} place="page" scope={scope} />

  const known = uses !== undefined
  const canCashOut = !!uses && uses > 0
  // The burn seeds its record before it proves; the sheet that started it stays up until it hands off.
  const tracking = withdrawal && !cashOut
  // A link with no voucher has one way through, the ordinary signup: the ticket signup's claim
  // batch is paid by the voucher, so a spent one cannot pay for the account.
  const voucherless = known && !canCashOut && !cashOut
  // The same manual exits a wallet's activity row offers once no relayer has moved the withdrawal.
  const canFinalize = !!withdrawal && canSelfFinalizeWithdrawal(withdrawal, now)
  const swapExit = withdrawal ? swapExitReasonFor(withdrawal, now) : null
  // A link this browser cashed out reads as claimed on chain. Saying so plainly is the difference
  // between "your money is on its way" and "someone else took it".
  // The ticket signup keeps this page as the backdrop of its modal steps whatever the reads say
  // once it has started: the wizard is never swapped under the visitor.
  const choosing = !tracking && (ticketSignup || (!signup && !voucherless))
  // Either signup mode is picked only once the voucher read has answered: the link pays for the
  // account, ticket or name price, only through it.
  const voucherUnread = !known
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  // The note's amount as this page read it: it decides whether a new ticket signup may start, and
  // prices the signup's split at once.
  const amount = linkBaseUnits(link.amount, decimals)
  const eligibility = linkTicketEligibility(
    offer,
    amount,
    canCashOut && !ticketSignupResumable(link.fragment),
  )
  // Whether the network offered to pay this visitor's registration; unset until that is known.
  const ticketOffered =
    offer === undefined || eligibility === "unknown" ? undefined : eligibility === "eligible"
  // The status reads stopped without the note: their re-read is the retry.
  const amountFailed = eligibility === "unknown" && statusSettled
  const thresholdNote =
    offer && eligibility === "below_threshold"
      ? belowTicketThresholdCopy(ticketThresholdLabel(offer.threshold, decimals))
      : undefined
  const accountRetry = offerFailed
    ? retryOffer
    : voucherUnread && error
    ? retry
    : amountFailed
    ? onRetryStatus
    : undefined
  const accountChecking =
    !accountRetry && (offer === undefined || voucherUnread || eligibility === "unknown")

  // The signup funnel's first ticket step, once per mount: the page offered to pay for the account,
  // or opened the signup a link sent here pays for at the name's price.
  const ticketShown = useRef(false)
  const reportTicketStart = () => {
    if (ticketShown.current) return
    ticketShown.current = true
    markTicketChannel()
    fireOnboardingEvent("onboarding_started", { entry: "ticket" })
  }

  /**
   * `paid`: no ticket applies, and the link pays the name's own price when its note covers it.
   * False when the signup cannot start yet.
   */
  const startSignup = (paid = false): boolean => {
    if (offer === undefined || voucherUnread) return false
    const ticket = canCashOut && (paid || !!offer)
    if (!paid && eligibility !== undefined && eligibility !== "eligible") return false
    // The link pays the name only with its amount in the marker: a later read never reaches it.
    if (ticket && paid && amount === undefined) return false
    fireEvent("paylink_visitor_chose", { choice: "account", ticket: !paid && ticketOffered })
    if (ticket) {
      stashTicketSignup({
        fragment: link.fragment,
        ...(paid || !offer
          ? { paid: true as const, schedule: NAME_SCHEDULE }
          : { threshold: offer.threshold, schedule: offer.schedule }),
        ...(link.memo ? { memo: link.memo } : {}),
        ...(link.senderTag ? { senderTag: link.senderTag } : {}),
        amount,
        // Home claims off this read rather than waiting on its own.
        ...(link.claimableFrom != null ? { claimableFrom: link.claimableFrom } : {}),
        ...(link.claimableUntil != null ? { claimableUntil: link.claimableUntil } : {}),
        ...(link.tokenAddress ? { tokenAddress: link.tokenAddress } : {}),
        ...(link.txHash ? { txHash: link.txHash } : {}),
      })
    } else clearTicketSignup()
    if (ticket && paid) reportTicketStart()
    if (ticket) markTicketChannel()
    setTicketSignup(ticket)
    setCashOut(false)
    setSignup(true)
    return true
  }

  // A link whose ticket signup already holds a passkey or a registration goes straight back into
  // it, as after the reload that follows the passkey's creation; the choice was already made, so
  // this tab's marker keeps its mode, ticket or paid. So does a link a signup elsewhere sent here
  // to pick a name: its free tag when the ticket is eligible, else the name's own price.
  const resumable = ticketSignupResumable(link.fragment)
  const sentHere = receivesToAccount(routeState)
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || signup || tracking) return
    if (offer === undefined || voucherUnread) return
    if (resumable && peekTicketSignup()?.fragment === link.fragment) {
      resumed.current = true
      markTicketChannel()
      setTicketSignup(true)
      setSignup(true)
    } else if (resumable || (sentHere && eligibility === "eligible")) {
      resumed.current = true
      startSignup()
    } else if (sentHere && eligibility !== "unknown") {
      resumed.current = startSignup(true)
    }
  })

  useEffect(() => {
    if (!tracking && ticketOffered === true) reportTicketStart()
  })

  const closed = link.status === "unclaimed" ? undefined : CLOSED_LINK_COPY[link.status]
  const summary = (
    <VisitorSummary
      link={link}
      statusSettled={statusSettled}
      withdrawal={tracking ? withdrawal : undefined}
      noVoucher={known && !canCashOut}
    />
  )

  let page: ReactNode
  if (tracking) {
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing ww-invite__content--visitor">
          {summary}
          <p className="ww-invite-modal-foot">
            <TabLine operationId={withdrawal.operationId} place="page" />
            {releaseNote(withdrawal, now)}
          </p>
          {canFinalize && (
            <PrimaryGradientButton
              title="Finalize it yourself"
              onClick={() => setExit("finalize")}
            />
          )}
          {swapExit && (
            <PrimaryGradientButton
              title={swapExit === "stuck" ? "Run swap manually" : "Recover"}
              onClick={() => setExit(swapExit)}
            />
          )}
          {hasClaimReceipt(withdrawal) && (
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => setReceiptOpen(true)}
            >
              View receipt
            </button>
          )}
        </div>
      </InvitationChrome>
    )
  } else if (closed && !cashOut) {
    // A closed link has nothing to offer: the message is the whole page. A link this browser is
    // cashing out reads as claimed once the burn lands, so that sheet stays up until it resolves.
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing ww-invite__content--visitor">
          {summary}
        </div>
      </InvitationChrome>
    )
  } else if (choosing) {
    const checking = !known || (claimWait === undefined && !unreadable)
    const externalCaption = error
      ? "Couldn't check availability."
      : checking
      ? EXTERNAL_CHECKING_NOTE
      : unreadable
      ? "Couldn't check when this link can be claimed. Tap to try again."
      : countdown
      ? countdown
      : !deps
      ? "Connecting…"
      : "Slower. Public onchain payment."
    const externalPending = !error && (checking || (!unreadable && !countdown && !deps))
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing ww-invite__content--visitor">
          {summary}
          <VisitorChoices
            privateFlag={offer !== undefined}
            account={{
              // Until the offer, voucher and amount are read the button promises nothing: a click
              // here would have to pick the paid signup for a visitor the link may be about to pay
              // for. A read that failed is not a confirmed absence, so the click retries it.
              disabled: signup || accountChecking || thresholdNote !== undefined,
              onClick: accountRetry ?? (() => startSignup()),
              pending: accountChecking,
              note: accountRetry
                ? "Couldn't check what this link pays for. Tap to try again."
                : accountChecking
                ? ACCOUNT_CHECKING_NOTE
                : thresholdNote
                ? thresholdNote
                : offer === null
                ? "Create an account to receive it. Your balance stays private."
                : "Instant. Your balance stays private.",
            }}
            external={{
              disabled:
                !known || !canCashOut || signup || (!unreadable && (!deps || claimWait !== 0)),
              onClick: () => {
                if (unreadable) return onRetryStatus()
                fireEvent("paylink_visitor_chose", { choice: "ethereum", ticket: ticketOffered })
                setCashOut(true)
              },
              pending: externalPending,
              note: externalCaption,
            }}
            error={error}
            onRetry={retry}
            // The passkey prompt, not the key this browser last held: that may be this link's own signup.
            onLogIn={() => navigate("/enter?choose=1")}
          />
        </div>
        {signup && ticketSignup && (
          <PaylinkOnboardingScreen
            embedded
            ticketSignup
            // Back to the choice; the effect above drops the uncommitted ticket intent.
            onExit={() => {
              setTicketSignup(false)
              setSignup(false)
            }}
          />
        )}
        {cashOut && deps && (
          <ClaimToL1Modal
            link={link}
            ready={true}
            onClose={() => setCashOut(false)}
            // No passkey in this flow: the modal closes as the proof starts, and the page carries
            // the withdrawal from there.
            onHandOff={() => setCashOut(false)}
            onConfirm={(choice, onStage) =>
              cashOutLink(
                { ...deps, screener: choice.screener },
                link.fragment,
                choice.recipient,
                onStage,
                choice.receiveAsset,
                choice.quote,
                choice.zkProof,
                choice.swap,
              )
            }
            planSwap={(recipient, receiveAsset, quote, amount) =>
              planCashOutSwap(deps, link.fragment, amount, recipient, receiveAsset, quote)
            }
            onClaimInstead={thresholdNote ? undefined : () => startSignup()}
          />
        )}
      </InvitationChrome>
    )
  } else {
    page = (
      <InvitationChrome actions={bell}>
        <PaylinkOnboardingScreen embedded inviteHeader={summary} />
      </InvitationChrome>
    )
  }

  return (
    <>
      {page}
      {exit === "finalize" && withdrawal && (
        <WithdrawalExitModal record={withdrawal} onClose={() => setExit(null)} />
      )}
      {exit && exit !== "finalize" && withdrawal && (
        <SwapExitModal
          record={withdrawal}
          reason={exit}
          linkFragment={link.fragment}
          onClose={() => setExit(null)}
        />
      )}
      {receiptOpen && withdrawal && (
        <ClaimProgressModal
          record={withdrawal}
          memo={link.memo}
          onClose={() => setReceiptOpen(false)}
        />
      )}
    </>
  )
}

const ACCOUNT_CHECKING_NOTE = "Checking what this link pays for…"
const EXTERNAL_CHECKING_NOTE = "Checking availability…"

/**
 * The page before any of its reads, as the wallet first renders it: shown while the wallet starts,
 * so it paints before the PXE without looking different once the page itself takes over. Taps that
 * need the wallet wait for it.
 */
export function PaylinkVisitorPending({
  link,
  offer,
  bell,
  onLogIn,
}: {
  link: PaymentLink
  /** The network's ticket offer, once read. */
  offer: GoldenTicketOffer | null | undefined
  bell: ReactNode
  onLogIn: () => void
}) {
  return (
    <InvitationChrome actions={bell}>
      <div className="ww-invite__content ww-invite__content--landing ww-invite__content--visitor">
        <VisitorSummary link={link} statusSettled={false} noVoucher={false} />
        {link.status === "unclaimed" && (
          <VisitorChoices
            privateFlag={offer !== undefined}
            account={{ disabled: true, pending: true, note: ACCOUNT_CHECKING_NOTE }}
            external={{ disabled: true, pending: true, note: EXTERNAL_CHECKING_NOTE }}
            onLogIn={onLogIn}
          />
        )}
      </div>
    </InvitationChrome>
  )
}

/** What the link pays, or why it no longer can, or the cash-out this browser made with it. */
function VisitorSummary({
  link,
  statusSettled,
  withdrawal,
  noVoucher,
}: {
  link: PaymentLink
  statusSettled: boolean
  /** This browser's cash-out of the link, which the summary reports instead. */
  withdrawal?: WithdrawalRecord
  /** The voucher read found no way to cash the link out. */
  noVoucher: boolean
}) {
  const closed = link.status === "unclaimed" ? undefined : CLOSED_LINK_COPY[link.status]
  return (
    <>
      <span className="ww-invite-modal-badge">
        <Icon name="link" size={32} color="#fff" />
      </span>
      <div className="ww-paylink-summary">
        <span className="ww-paylink-summary__label">
          {withdrawal ? "You withdrew" : closed ? closed.title : senderLine(link.senderTag)}
        </span>
        {/* A cash-out spends the escrow note the link's amount is read from; the record keeps it,
            gross of the fee the receipt itemizes. */}
        {withdrawal ? (
          <span className="ww-paylink-summary__amount">
            {usdFigure(withdrawalAmounts(withdrawal).grossDisplay)}
          </span>
        ) : link.amount ? (
          <span className="ww-paylink-summary__amount">${link.amount}</span>
        ) : (
          // The amount's line (40px/1.3), held while the note is read.
          !closed && !statusSettled && <BalanceSkeleton width={120} height={40} />
        )}
        {link.memo && <span className="ww-paylink-summary__note">{link.memo}</span>}
      </div>
      {link.flavor === "email" && link.email && !withdrawal && (
        <span className="ww-paylink-summary__pill">
          EMAIL <b>{link.email}</b>
        </span>
      )}
      {(withdrawal || closed || noVoucher) && (
        <p className="ww-paylink-summary__caption">
          {withdrawal
            ? `${withdrawalStatus(withdrawal).label} — to ${shortL1Addr(withdrawal.recipient)}`
            : closed
            ? closed.caption
            : "Log in or sign up to zk.money to receive your payment"}
        </p>
      )}
    </>
  )
}

type VisitorOption = { disabled: boolean; onClick?: () => void; pending: boolean; note: string }

/** The two ways to receive the link's funds, and the way in for an existing account. */
function VisitorChoices({
  privateFlag,
  account,
  external,
  error,
  onRetry,
  onLogIn,
}: {
  privateFlag: boolean
  account: VisitorOption
  external: VisitorOption
  error?: string
  onRetry?: () => void
  onLogIn: () => void
}) {
  return (
    <>
      <p className="ww-paylink-summary__caption">Choose how to receive payment</p>
      <div className="ww-paymethods">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod ww-paymethod--best"
          disabled={account.disabled}
          onClick={account.onClick}
        >
          {privateFlag && (
            <span className="ww-paymethod__flag">
              <span>Private</span>
            </span>
          )}
          <span className="ww-deposit__connect-icon">
            <Icon name="lock-shield" size={24} color="#fff" />
          </span>
          <span className="ww-deposit__connect-text">
            <b>Receive to zk.money</b>
            <OptionNote pending={account.pending}>{account.note}</OptionNote>
          </span>
          <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
        </button>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod"
          disabled={external.disabled}
          onClick={external.onClick}
        >
          <span className="ww-deposit__connect-icon">
            <Icon name="wallet" size={24} color="#fff" />
          </span>
          <span className="ww-deposit__connect-text">
            <b>Claim to an Ethereum wallet</b>
            <OptionNote pending={external.pending}>{external.note}</OptionNote>
          </span>
          <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
        </button>
      </div>
      {error && (
        <>
          <p className="ww-invite-modal-error" role="alert">
            {error}
          </p>
          <PrimaryGradientButton title="Try again" buttonStyle="dark" onClick={onRetry} />
        </>
      )}
      <p className="ww-invite-modal-foot">
        Already have an account?{" "}
        <button type="button" className="zkm-btn-reset ww-invite__link" onClick={onLogIn}>
          Log in
        </button>
      </p>
    </>
  )
}

/** An option's second line, which pulses like the app's loading shimmer while its answer is pending. */
function OptionNote({ pending, children }: { pending: boolean; children: ReactNode }) {
  return <span aria-busy={pending || undefined}>{children}</span>
}

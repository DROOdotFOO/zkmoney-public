import { parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { fixedCents, floorToCents, parseAmount } from "../../../ui/format"
import { Modal } from "../../../ui/Modal"
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import {
  ContactStorage,
  exceedsBalance,
  useContractServiceContext,
  useStore,
  TxInFlightError,
  type Contact,
  useResource,
  WalletError,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { Icon } from "@obsidion/web-ds"
import { showReportableError } from "../../../errors/errorModal"
import {
  amountBucket,
  failureCode,
  fireEvent,
  lapTimer,
  requestAmountBucket,
} from "../../../lib/analytics"
import { MessagingBanner } from "../../../platform/xmtp/MessagingBanner"
import { fireRequestOpened } from "../../requests/requestOpened"
import { loadWalletIdentity } from "../../identity/walletIdentity"
import { PayModalChrome } from "../../../ui/PayModalChrome"
import { useBack, useProvingOutcome } from "../../../ui/hooks"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { RecipientNotUpgradedError, runContactPay, type PayStage } from "../contactPay"
import { useRecipientUpgraded } from "../useRecipientUpgraded"
import { recipientNotUpgradedCopy } from "../../migration/upgradeCopy"
import { useUserFlowActive } from "../../provingGate"
import { useActionVerdict } from "../../actionGate"
import { findContactEntry } from "../contactsView"
import { lookUpUnsavedContact } from "../unsavedContact"
import { PayAmountForm } from "../PayAmountForm"
import { PayConfirmForm } from "../PayConfirmForm"
import { PayWorking } from "../PayWorking"
import { sendLimitError } from "../../limits/withdrawalLimit"
import { useSession } from "../../../platform/session"
import copy from "./ContactPayScreen.copy"
import { fmt } from "../../../lib/fmt"

/** Router state: a fulfilling send carries the request (activity-row Send, or a decoded request
 *  link via its pay page); `from` marks entry from the contact detail, which stays as the backdrop
 *  and is popped back to on success instead of pushed again. Link requests add: `source:"link"`
 *  (no local row — the fulfilled signal must not require one), the packet's `requesterAddress`
 *  pin, and the note. amount 0 = any-amount link (starts on the amount phase). */
interface PayScreenState {
  request?: {
    id: string
    tag?: string
    amount: number
    source?: "link"
    requesterAddress?: string
    note?: string
    /** The pay page's path and hash, so the payer can switch to its Ethereum route. */
    link?: string
    /** From a standing `/pay/<tag>` page rather than a minted request. */
    standing?: boolean
  }
  from?: "detail"
  /** The person the page already loaded, so the flow opens without looking them up again. */
  contact?: Contact
  saved?: boolean
}

type Phase = "amount" | "confirm" | "working" | "sent"

/** Send to / request from a contact as a modal over the page it was opened from: amount →
 *  confirm → progress, then straight into the contact chat. A fulfilling send (activity-row Send on an
 *  incoming request) also works for an unsaved requester tag — the send rail registry-resolves the
 *  tag itself — starts on confirm with the requested amount, and on success fulfills the request
 *  and saves the requester as a contact. A plain send to a tag opened unsaved from search saves
 *  nothing. */
export function ContactPayScreen({ mode }: { mode: "send" | "request" }) {
  // A new recipient is a new flow: nothing typed or confirmed for the last one may carry over.
  const { idOrTag } = useParams()
  return <ContactPayFlow key={idOrTag} mode={mode} />
}

function ContactPayFlow({ mode }: { mode: "send" | "request" }) {
  const navigate = useNavigate()
  const { idOrTag } = useParams()
  const routerState = useLocation().state as PayScreenState | null
  const request = routerState?.request
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const tokenService = useResource(useSession().token)
  const balances = useSession().balances
  const { contractService } = useContractServiceContext()
  const balance = useStore(balances.view)
  const main = balance.main

  const [entry, setEntry] = useState<Contact | null | undefined>(routerState?.contact)
  const [phase, setPhase] = useState<Phase>(request && request.amount > 0 ? "confirm" : "amount")
  const [amount, setAmount] = useState(request && request.amount > 0 ? String(request.amount) : "")
  const [note, setNote] = useState(request?.note ?? "")
  const [stage, setStage] = useState<PayStage>("resolving")
  const [failedOnce, setFailedOnce] = useState(false)
  const requestSource = request?.standing ? "pay_page" : request?.source ?? "contact"
  // Cancel is honoured only before proving starts; the sponsored rail can't abort a proof.
  const cancelled = useRef(false)
  const left = useRef(false)

  useEffect(() => {
    if (routerState?.contact) return
    let current = true
    ContactStorage.get()
      .getEntries()
      .then(async (entries) => {
        const found = findContactEntry(entries, idOrTag ?? "")
        const next = found ?? (request ? null : await lookUpUnsavedContact(idOrTag ?? ""))
        if (current) setEntry(next)
      })
      .catch((e) => {
        console.warn(e)
        if (current) setEntry(null)
      })
    return () => {
      current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the request is fixed for this entry
  }, [idOrTag])

  // Funnel top: a fulfilling send is the payer opening a request; a plain send starts at the
  // contact pick.
  useEffect(() => {
    if (request) {
      fireRequestOpened(requestSource, request.id, request.amount, request.tag)
    } else if (mode === "send") {
      fireEvent("send_contact_selected")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only funnel entry
  }, [])

  const outcome = useProvingOutcome("send")

  const parsed = parseAmount(amount)
  const validAmount = Number.isFinite(parsed) && parsed > 0
  const isSend = mode === "send"
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  const decimals = tokenService?.metadata.decimals ?? DEFAULT_DECIMALS
  const overspent =
    isSend && exceedsBalance(balance, validAmount ? parseUnits(amount, decimals) : undefined)
  // A request over the limit is one its payer can't send.
  const limitError = validAmount
    ? sendLimitError(parseUnits(amount, decimals), decimals)
    : undefined
  const targetTag = entry?.tag ?? (isSend ? request?.tag : undefined)
  // A recipient still on a retired rollup can't be paid or asked. Found before the amount is typed,
  // their chat keeps the history and says why.
  const upgraded = useRecipientUpgraded(targetTag)
  useEffect(() => {
    if (upgraded !== false) return
    if (routerState?.from === "detail") navigate(-1)
    else navigate(`/contacts/${idOrTag}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaves once, on the answer
  }, [upgraded])
  // Found at send time, from a fresh manifest the chat's cached read may not agree with: the sheet
  // says why itself.
  const [refused, setRefused] = useState(false)
  const railReady = useActionVerdict("send") === "open"
  const ready = isSend
    ? railReady && !!(obsidionWallet && obsidionAccount && tokenService && contractService)
    : !!tokenService
  const busy = useUserFlowActive()
  // Paying a request saves an unsaved payee; a sender the wallet added from a transfer is approved by
  // paying their request.
  const savesPayee = (routerState?.contact ? !routerState.saved : !entry) || !!entry?.autoAdded
  // Abandoning the flow: pop history so the close returns wherever the user came from.
  const back = useBack(entry ? `/contacts/${idOrTag}` : "/send")
  // Finishing the flow: replace so the next back reaches the true origin, not the finished flow.
  const finish = useCallback(() => {
    if (routerState?.from === "detail") navigate(-1)
    else navigate(entry ? `/contacts/${idOrTag}` : "/activity", { replace: true })
  }, [navigate, routerState, entry, idOrTag])

  // Past the hand-off the send outlives this screen: its operation's row reports the end.
  const leave = () => {
    left.current = true
    outcome.finish()
    finish()
  }

  // Brief success beat before the chat takes over; cleanup cancels it if the user leaves first.
  useEffect(() => {
    if (phase !== "sent") return
    const timer = setTimeout(finish, 1500)
    return () => clearTimeout(timer)
  }, [phase, finish])

  const toConfirm = () => {
    // Plain sends only: a fulfilling send belongs to the request funnel, and letting it enter the
    // contact-send funnel mid-way would fabricate step-2/3 conversions with no step 1.
    if (isSend && !request) fireEvent("send_amount_confirmed")
    setPhase("confirm")
  }

  // Range only — never the exact amount or tag.
  const fireSendSubmitted = (props: { duration_ms: number } | { in_flight: true }) =>
    fireEvent("send_submitted", {
      ...props,
      amount_bucket: amountBucket(BigInt(Math.floor(parsed)), 0),
      // Lets the contact-send funnel exclude fulfilling sends (they enter via request_opened,
      // not send_contact_selected) while volume counts keep every send.
      fulfills_request: !!request,
    })

  const submit = async () => {
    if (failedOnce) fireEvent("retry_clicked", { flow: isSend ? "send" : "request" })
    if (isSend) outcome.start("resolving")
    setPhase("working")
    setStage("resolving")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    const elapsed = lapTimer()
    try {
      const tag = targetTag
      // Behind WalletGate, which already applied the stricter onboarded-identity read.
      const senderTag = loadWalletIdentity()?.handle
      // The confirm CTA gates on `ready`, so the wallet, account and services are present here.
      if (
        !tag ||
        !senderTag ||
        !obsidionWallet ||
        !obsidionAccount ||
        !tokenService ||
        !contractService
      )
        throw new WalletError("contact.unavailable")
      const result = await runContactPay(
        isSend
          ? {
              mode: "send",
              deps: {
                wallet: obsidionWallet,
                account: obsidionAccount,
                tokenService,
                contractService,
              },
              tag,
              senderTag,
              amountDisplay: amount,
              note: note.trim() || undefined,
              request,
              saveUnsavedRequester: savesPayee,
            }
          : {
              mode: "request",
              deps: { tokenService, wallet: obsidionWallet },
              tag,
              senderTag,
              amountDisplay: amount,
              note: note.trim() || undefined,
            },
        (s) => {
          // Only here. `submitting` lands after the send has mined, and cancelling there would
          // leave the row pending and skip the request it fulfilled.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
      )
      outcome.finish()
      // sendToContact waits for the mine, so duration spans confirm → mine; the per-phase
      // split rides tx_timing (flow "send").
      if (result.txHash) {
        fireSendSubmitted({ duration_ms: elapsed() })
        if (request) {
          fireEvent("request_paid", {
            source: requestSource,
            amount_bucket: requestAmountBucket(parsed),
          })
        }
      }
      if (!isSend) {
        fireEvent("request_created", {
          source: "contact",
          amount_bucket: requestAmountBucket(parsed),
        })
      }
      if (!isSend) setPhase("sent")
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      // Reached the node, outcome unknown: the chain settles the operation. No error modal — there is
      // no error to report yet.
      if (e instanceof TxInFlightError) {
        outcome.finish()
        fireSendSubmitted({ in_flight: true })
        return
      }
      outcome.finish()
      // Nothing was sent and nothing failed: the sheet shows the hint.
      if (e instanceof RecipientNotUpgradedError) {
        setRefused(true)
        setPhase("confirm")
        return
      }
      fireEvent("action_failed", {
        action: isSend ? "contact:send" : "contact:request",
        code: failureCode(e),
      })
      if (left.current) return
      showReportableError(e, isSend ? "contact:send" : "contact:request")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  if ((entry === undefined && !request) || upgraded === false) return null

  const notFound = entry === null && !request
  const checking = upgraded === undefined
  const blocked = notFound || checking || refused
  const handle = targetTag ?? (entry ? entry.tag ?? entry.name : "")
  // Paying a request or a pay page.
  const paying = isSend && !!request
  const title = paying ? copy.title.pay : isSend ? copy.title.send : copy.title.request

  return (
    <Modal
      variant="bare"
      label={title}
      className="ww-pay"
      onClose={phase === "working" || phase === "sent" ? undefined : back}
    >
      {phase === "sent" ? (
        <div className="ww-pay__working">
          <Icon name="check" size={36} color="var(--accent-green)" strokeWidth={2.5} />
          <span className="ww-pay__title">{copy.requestSent}</span>
        </div>
      ) : phase === "working" && isSend ? (
        <OperationHandOff
          onLeave={leave}
          onCancel={
            stage === "resolving"
              ? () => {
                  cancelled.current = true
                }
              : undefined
          }
        />
      ) : phase === "working" ? (
        <PayWorking beat="preparing" label={copy.sendingRequest} warn={false} />
      ) : (
        <>
          <PayModalChrome
            title={title}
            subtitle={paying ? `@${handle}` : fmt(copy.tag, { handle })}
            name={handle}
            onClose={back}
            onBack={phase === "confirm" && !request ? () => setPhase("amount") : undefined}
          />
          {/* Requests hard-fail without a live XMTP leader; surface the state before submit. */}
          {!isSend && <MessagingBanner />}

          {notFound && <div className="ww-pay__handle">{copy.notFound}</div>}
          {checking && <div className="ww-pay__handle">{fmt(copy.checking, { handle })}</div>}
          {refused && <p className="ww-pay__hint">{recipientNotUpgradedCopy.payHint(handle)}</p>}

          {!blocked && phase === "amount" && (
            <PayAmountForm
              amount={amount}
              note={note}
              isSend={isSend}
              walletBalance={fixedCents(main && { ...main, decimals })}
              maxAmount={main ? floorToCents(main.atomic, decimals) : undefined}
              overspent={overspent}
              limitError={limitError}
              validAmount={validAmount}
              onAmount={setAmount}
              onNote={setNote}
              onContinue={toConfirm}
              submitLabel={paying ? fmt(copy.payTag, { handle }) : undefined}
            />
          )}

          {!blocked && phase === "confirm" && (
            <PayConfirmForm
              title={title}
              amount={parsed}
              note={note}
              ready={ready}
              busy={busy}
              overspent={overspent}
              limitError={limitError}
              isSend={isSend}
              payee={paying ? { tag: handle, savesContact: savesPayee } : undefined}
              onConfirm={submit}
            />
          )}
          {!blocked && phase === "confirm" && request?.source === "link" && request.link && (
            <button
              type="button"
              className="zkm-btn-reset ww-claim-modal__alt"
              onClick={() => navigate(request.link!, { state: { external: true } })}
            >
              {copy.payExternal}
            </button>
          )}
        </>
      )}
    </Modal>
  )
}

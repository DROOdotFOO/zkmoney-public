import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { useResource } from "@obsidion/front-core"
import { PAYMENT_REQUEST_NOTE_MAX_LEN } from "@obsidion/sdk"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { BrandLockup } from "../../ui/BrandLockup"
import { StyledQr } from "../../ui/StyledQr"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { useBack, useLinkSharing, useWakeLock } from "../../ui/hooks"
import { requestShareText } from "../requests/shareView"
import { useShortRequestLink } from "../requests/shortRequestLink"
import { useRegistrationDepositOwed } from "../onboarding/openRegistration"
import { REQUESTS_PATH } from "../requests/nonContactView"
import { RecipientNotUpgradedError, requestFromContact } from "../contacts/contactPay"
import { errorCopy } from "../../errors/catalog"
import { recipientNotUpgradedCopy } from "../migration/upgradeCopy"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { PrintedCard, printedCodeHost, useSaveCard } from "./PrintedCard"
import { CODE_LOGO, ReceiveCodeCard, ReceivePaid } from "./ReceiveCodeFace"
import { parseRequestAmount } from "./receiveView"
import { RequestContactPicker } from "./RequestContactPicker/RequestContactPicker"
import { useCodeForm } from "./useCodeForm"
import { useReceiveCode } from "./useReceiveCode"
import { useSession } from "../../platform/session"

/**
 * New request, routed at /receive: the amount and note, then who from. A contact gets it in their
 * Received list; anyone else scans the code or opens the link. Full screen shows the live code and
 * saves or prints the permanent one.
 */
export function ReceiveScreen() {
  const navigate = useNavigate()
  const back = useBack(REQUESTS_PATH)
  // A request names the tag as payee, so until the name is activated the way on is the deposit.
  const awaitingActivation = useRegistrationDepositOwed()
  const { tag, code, payment, setAmount, clearAmount, showCode } = useReceiveCode(
    !awaitingActivation,
  )
  const shortLink = useShortRequestLink(code)
  const publishing = shortLink.status === "publishing"
  const { copied, copy, share } = useLinkSharing(
    shortLink.url,
    "Pay me",
    requestShareText(code?.amount ?? 0),
  )
  const [full, setFull] = useState(false)
  useWakeLock(!!code && !payment)

  // A link request counts once handed out: copied, shared or shown full screen. Codes re-mint
  // unseen, so minting is no measure.
  const counted = useRef<string | undefined>(undefined)
  const handOut = () => {
    if (!code || counted.current === code.requestId) return
    counted.current = code.requestId
    fireEvent("request_created", {
      source: "link",
      amount_bucket: requestAmountBucket(code.amount),
    })
  }

  const enterFull = () => {
    handOut()
    setFull(true)
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
  const exitFull = () => {
    setFull(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
  // A payment closes full screen onto the paid state; the next code shows only after Show code.
  useEffect(() => {
    if (payment) exitFull()
  }, [payment])
  // Leaving browser full screen leaves ours too, and Escape closes ours where there is none.
  useEffect(() => {
    if (!full) return
    const onChange = () => !document.fullscreenElement && setFull(false)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false)
    document.addEventListener("fullscreenchange", onChange)
    document.addEventListener("keydown", onKey)
    const overflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
    return () => {
      document.documentElement.style.overflow = overflow
      document.removeEventListener("fullscreenchange", onChange)
      document.removeEventListener("keydown", onKey)
    }
  }, [full])

  const form = useCodeForm(code, setAmount)
  const phone = usePhoneLayout()
  const card = useSaveCard(tag ?? "")
  const tokenService = useResource(useSession().token)
  const wallet = useResource(useSession().wallet)
  const [who, setWho] = useState<"contact" | "anyone">("anyone")
  const [sending, setSending] = useState<string>()
  const [sendError, setSendError] = useState("")
  const [sendHint, setSendHint] = useState("")
  const [shake, setShake] = useState(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const amount = parseRequestAmount(form.amount)

  const requestContact = async (contact: string) => {
    const requesterTag = loadWalletIdentity()?.handle
    if (!amount) {
      setShake(true)
      amountInput.current?.focus()
      return
    }
    if (!tokenService || !wallet || !requesterTag) return
    setSending(contact)
    setSendError("")
    setSendHint("")
    try {
      await requestFromContact(
        { tokenService, wallet },
        {
          tag: contact,
          requesterTag,
          amountDisplay: String(amount),
          note: form.note.trim() || undefined,
        },
      )
      fireEvent("request_created", {
        source: "contact",
        amount_bucket: requestAmountBucket(amount),
      })
      // The contact's request is the one row; the code holding the same amount would be a second.
      await clearAmount().catch((err) => console.warn("[receive] code not cleared:", err))
      navigate(REQUESTS_PATH)
    } catch (e) {
      if (e instanceof RecipientNotUpgradedError) {
        setSendHint(recipientNotUpgradedCopy.requestHint(contact))
      } else {
        setSendError(
          errorCopy(e) ?? (e instanceof Error ? e.message : "Couldn't send the request"), // slice-check-ignore: an uncoded error keeps its own words until its source throws a code
        )
      }
      setSending(undefined)
    }
  }

  const tab = (value: typeof who, label: string, icon: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={who === value}
      className="zkm-btn-reset ww-request-who__tab"
      onClick={() => setWho(value)}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )

  const content = payment ? (
    <ReceivePaid payment={payment} next={code} onShowCode={showCode} />
  ) : awaitingActivation || !tag ? (
    <div className="ww-receive__card">
      <span className="ww-receive__eyebrow">Scan to pay</span>
      <button
        type="button"
        className="zkm-btn-reset ww-receive__qr ww-receive__qr--empty"
        onClick={() => navigate("/deposit")}
      >
        Your code shows once your name is active.
      </button>
    </div>
  ) : (
    <>
      <section className="ww-request-form">
        <label className={`zkm-field${form.amountError ? " zkm-field--error" : ""}`}>
          <span className="zkm-field__label">Amount</span>
          <span
            className="zkm-field__box ww-request-form__amount"
            data-shake={shake || undefined}
            onAnimationEnd={() => setShake(false)}
          >
            <span className="ww-request-form__currency">$</span>
            <input
              ref={amountInput}
              className="zkm-field__input"
              aria-label="Amount"
              placeholder="0.00"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => form.setAmount(e.target.value.replace(/^\$/, ""))}
            />
            <span className="ww-request-form__unit">USD</span>
          </span>
          {form.amountError && <span className="zkm-field__error">{form.amountError}</span>}
        </label>
        <label className="zkm-field">
          <span className="zkm-field__label ww-request-form__label">
            Note <i>Optional</i>
          </span>
          <span className="zkm-field__box">
            <input
              className="zkm-field__input"
              aria-label="Note"
              maxLength={PAYMENT_REQUEST_NOTE_MAX_LEN}
              placeholder="What's it for?"
              value={form.note}
              onChange={(e) => form.setNote(e.target.value)}
            />
          </span>
        </label>
        {form.error && <span className="ww-receive__error">{form.error}</span>}
      </section>
      <span className="ww-receive__who">Who from?</span>
      <div className="ww-request-who" role="tablist" aria-label="Who from" data-who={who}>
        {tab("contact", "A contact", "person")}
        {tab("anyone", "Anyone", "link")}
      </div>
      {who === "anyone" ? (
        <div role="tabpanel" className="ww-request-anyone">
          <div className="ww-request-anyone__code">
            <button
              type="button"
              className={`zkm-btn-reset ww-request-anyone__qr${
                code ? "" : " ww-deposit-sheet__qr--pulse"
              }`}
              aria-label="Fill the screen with your code"
              disabled={!code}
              onClick={enterFull}
            >
              {code && (
                <StyledQr
                  value={shortLink.qrUrl ?? code.url}
                  icon={CODE_LOGO}
                  busy={publishing}
                  label="Your pay code"
                  size={128}
                />
              )}
            </button>
            <span className="ww-request-anyone__text">
              <b>Scan or share</b>
              <span>Pay from zk.money or any Ethereum wallet</span>
              <button
                type="button"
                className="zkm-btn-reset ww-receive__full"
                disabled={!code}
                onClick={enterFull}
              >
                <Icon name="qr-code" size={14} />
                Full screen
              </button>
            </span>
          </div>
        </div>
      ) : (
        <div role="tabpanel">
          <RequestContactPicker
            sending={sending}
            dimmed={!amount}
            onRequest={(tag) => void requestContact(tag)}
          />
          {sendError && <span className="ww-receive__error">{sendError}</span>}
          {sendHint && <span className="ww-receive__hint">{sendHint}</span>}
        </div>
      )}
      {who === "anyone" && (
        <section className="ww-receive__rows">
          <PrimaryGradientButton
            title={phone ? "Share link" : copied ? "Copied" : "Copy link"}
            leadingIcon={phone ? "share" : copied ? "check" : "copy"}
            isDisabled={!code}
            onClick={() => {
              handOut()
              shortLink.publish()
              void (phone ? share() : copy())
            }}
          />
          {shortLink.status === "failed" && (
            <span className="ww-receive__error">
              Your link didn't publish. Share again for a new one.
            </span>
          )}
        </section>
      )}
    </>
  )

  return (
    <div className="ww-panel ww-receive">
      <div className="ww-panel__head ww-modal__head">
        <span className="ww-modal__head-slot">
          <TopNavIconButton icon="arrow-left" ariaLabel="Back" onClick={back} />
        </span>
        <span className="ww-modal__head-title">
          <GradientText size={24} weight={700}>
            New request
          </GradientText>
        </span>
        <span className="ww-modal__head-slot" />
      </div>
      <div className="ww-panel__scroll ww-receive__body">{content}</div>

      {full &&
        !payment &&
        tag &&
        code &&
        createPortal(
          <div className="ww-receive-full" role="dialog" aria-label="Your code">
            <div className="ww-receive-full__bar">
              <BrandLockup />
              <TopNavIconButton icon="x" ariaLabel="Close full screen" onClick={exitFull} />
            </div>
            <ReceiveCodeCard tag={tag} code={code} url={shortLink.qrUrl} busy={publishing} />
            <div className="ww-receive-full__print">
              <div className="ww-receive__actions">
                <PrimaryGradientButton
                  title="Save"
                  buttonStyle="dark"
                  leadingIcon="download"
                  isLoading={card.saving}
                  onClick={() => void card.save()}
                />
                <PrimaryGradientButton
                  title="Print"
                  buttonStyle="dark"
                  leadingIcon="print"
                  onClick={() => window.print()}
                />
              </div>
              <span className="ww-receive-full__note">
                Save and Print use {printedCodeHost(tag)}, which never expires.
              </span>
            </div>
            <PrintedCard tag={tag} />
          </div>,
          document.body,
        )}
    </div>
  )
}

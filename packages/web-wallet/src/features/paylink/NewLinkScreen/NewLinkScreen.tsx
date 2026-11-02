import { Modal } from "../../../ui/Modal"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  exceedsBalance,
  parseEscrowAmount,
  TxInFlightError,
  useStore,
  useResource,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { PAYLINK_MEMO_MAX_BYTES, truncateUtf8 } from "@obsidion/sdk"
import {
  ConfirmationSheetDetailRow,
  GradientToggle,
  Icon,
  PrimaryGradientButton,
  TextField,
} from "@obsidion/web-ds"
import { showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent } from "../../../lib/analytics"
import { SendScreen } from "../../contacts/SendScreen/SendScreen"
import type { CreateStage, PaymentLink } from "../types"
import {
  DEFAULT_CLAIM_WINDOW_DAYS,
  createSponsoredLink,
  hasPendingDeposits,
  voucherAvailable,
} from "../sponsoredPaylink"
import { usePaylinkDeps } from "../usePaylinkDeps"
import { useGoldenTicketOffer } from "../goldenTicketOffer"
import {
  linkBaseUnits,
  linkTicketEligibility,
  TICKET_GRANT_COPY,
  ticketThresholdHint,
  ticketThresholdLabel,
} from "../ticketThreshold"
import { PayModalChrome } from "../../../ui/PayModalChrome"
import { useBack, useProvingOutcome } from "../../../ui/hooks"
import { useUserFlowActive } from "../../provingGate"
import {
  amountError,
  decimalInput,
  fixedCents,
  floorToCents,
  parseAmount,
  usd,
} from "../../../ui/format"
import { emailLockedLinksEnabled } from "../../../config/features"
import { useBusyLabel } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { LocalPasskeyHint } from "../../../ui/LocalPasskeyHint"
import {
  SponsoredActionNotice,
  useSponsoredActionBlock,
} from "../../allowance/SponsoredActionNotice"
import { loadWalletIdentity } from "../../identity/walletIdentity"
import { paylinkRowUrl } from "../../shortLinks"
import { useSession } from "../../../platform/session"
import styles from "./NewLinkScreen.module.css"
import copy from "./NewLinkScreen.copy"
import { fmt } from "../../../lib/fmt"

type Phase = "amount" | "options" | "confirm" | "working"

const PREVIOUS_PHASE: Partial<Record<Phase, Phase>> = { options: "amount", confirm: "options" }
const EXPIRY_DAYS = [1, 7, 30]
const MIN_AMOUNT = 1

/**
 * Create a payment link as a modal over Send: amount → expiry/protect → review → passkey → share.
 * Sponsored, so the fee row reads free. The link exists before the passkey prompt, so as the
 * ceremony ends the link's own detail sheet opens over Activity with the URL ready to copy, and the
 * deposit proves under the bell.
 */
export function NewLinkScreen() {
  const navigate = useNavigate()
  const back = useBack("/send")
  const deps = usePaylinkDeps()
  const balance = useStore(useSession().balances.view)
  const main = balance.main
  const decimals = useResource(useSession().token)?.metadata.decimals

  const [phase, setPhase] = useState<Phase>("amount")
  const previousPhase = PREVIOUS_PHASE[phase]
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [expiryDays, setExpiryDays] = useState(DEFAULT_CLAIM_WINDOW_DAYS)
  const [protectEnabled, setProtectEnabled] = useState(false)
  const [email, setEmail] = useState("")
  const [handle] = useState(() => loadWalletIdentity()?.handle)
  const [showTag, setShowTag] = useState(true)
  const senderTag = handle && showTag ? handle : undefined
  const [stage, setStage] = useState<CreateStage>("building")
  const [failedOnce, setFailedOnce] = useState(false)
  // Whether the link will carry a cash-out voucher; undefined while the allowance read is in flight.
  const [voucher, setVoucher] = useState<boolean>()
  // Cancel is honoured only before proving starts; the sponsored rail can't abort a proof.
  const cancelled = useRef(false)
  const left = useRef(false)
  const link = useRef<PaymentLink | null>(null)

  useEffect(() => fireEvent("paylink_create_opened"), [])
  const outcome = useProvingOutcome("paylink-create")

  const leave = () => {
    left.current = true
    outcome.finish()
    // The row stores the full link, so the sheet is found by that, not the short one shared.
    const state = link.current ? { openPaylink: paylinkRowUrl(link.current.fragment) } : undefined
    navigate("/activity", { replace: true, state })
  }

  const parsed = parseAmount(amount)
  const validAmount = Number.isFinite(parsed) && parsed >= MIN_AMOUNT
  const belowMin = Number.isFinite(parsed) && parsed < MIN_AMOUNT
  const trimmedEmail = email.trim()
  // Minimal address-shape check; the SDK enforces the 64-byte cap at create.
  const validEmail =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) &&
    new TextEncoder().encode(trimmedEmail).length <= 64
  const emailLocked = protectEnabled && !!trimmedEmail
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount, and
  // parked deposits are spendable here without ever reaching `assets` (create redeems them itself).
  // Past those, a $0 account blocks too — the escrow it can't fund reverts a minute into proving,
  // after the passkey prompt, and the link never exists.
  const overspent =
    !hasPendingDeposits() &&
    exceedsBalance(balance, validAmount ? parseEscrowAmount(amount, decimals ?? 0).atomic : 0n)
  const canNext = validAmount && !overspent
  const canConfirm = !protectEnabled || validEmail
  // The token and co-signer connect async after mount; the CTA waits for the full deps set.
  const ready = !!deps
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(phase === "confirm")
  // Resolved on the review sheet, so the row promises exactly what the create will do.
  useEffect(() => {
    if (phase !== "confirm" || !deps) return
    let stale = false
    setVoucher(undefined)
    void voucherAvailable(deps).then((ok) => !stale && setVoucher(ok))
    return () => {
      stale = true
    }
  }, [phase, deps])
  const voucherKnown = voucher !== undefined
  // The visitor page reads the same offer and amount: a link at the threshold, carrying a voucher,
  // pays a new user's tag.
  const { offer } = useGoldenTicketOffer()
  const ticketMinimum =
    offer && decimals !== undefined ? ticketThresholdLabel(offer.threshold, decimals) : undefined
  const amountUnits =
    validAmount && decimals !== undefined ? linkBaseUnits(amount, decimals) : undefined
  // The voucher is read on the review sheet: only there can the link itself be promised.
  const grantsTicket = linkTicketEligibility(offer, amountUnits, voucher === true) === "eligible"

  // Input complete (amount + options), review sheet next — email_locked is decided by here.
  const toConfirm = () => {
    fireEvent("paylink_create_amount_confirmed", { email_locked: emailLocked })
    setPhase("confirm")
  }

  const create = async () => {
    fireEvent("paylink_create_submitted", { email_locked: emailLocked })
    if (failedOnce) fireEvent("retry_clicked", { flow: "paylink-create" })
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    link.current = null
    try {
      // The raw string goes through — parseEscrowAmount keeps full precision
      // at the token's decimals. The CTA gates on `ready`, so deps is present here.
      await createSponsoredLink(
        deps!,
        amount,
        (s) => {
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
        {
          email: emailLocked ? trimmedEmail : undefined,
          expiryDays,
          memo: note.trim() || undefined,
          senderTag,
          onLink: (l) => {
            link.current = l
          },
          voucher: voucher === true,
        },
      )
      outcome.finish()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      // Reached the node: the chain settles the operation. A failure here would put a retry under a
      // link that may well exist.
      if (e instanceof TxInFlightError) {
        outcome.finish()
        return
      }
      outcome.finish()
      fireEvent("action_failed", { action: "paylink:create", code: failureCode(e) })
      // Past the hand-off the create's operation row reports it.
      if (left.current) return
      showReportableError(e, "paylink:create")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  const feeRows = (
    <div className="ww-pay__summary">
      <ConfirmationSheetDetailRow label={copy.rows.fee} value={copy.rows.free} />
    </div>
  )

  return (
    <>
      <SendScreen />
      <Modal
        variant="bare"
        label={copy.title}
        className="ww-pay"
        onClose={phase === "working" ? undefined : back}
      >
        {phase === "working" ? (
          <OperationHandOff
            onLeave={leave}
            onCancel={
              stage === "building"
                ? () => {
                    cancelled.current = true
                  }
                : undefined
            }
          />
        ) : (
          <>
            <PayModalChrome
              title={copy.title}
              subtitle=""
              onClose={back}
              onBack={previousPhase && (() => setPhase(previousPhase))}
              avatar={
                <span className="ww-send-option__icon">
                  <Icon name="link" size={24} color="#fff" />
                </span>
              }
            />

            {phase === "amount" && (
              <div className="ww-pay__form">
                <div className="ww-pay__field">
                  <span className="ww-pay__available">
                    {copy.available}{" "}
                    <b>
                      ${fixedCents(main && { ...main, decimals: decimals ?? DEFAULT_DECIMALS })}
                    </b>
                  </span>
                  <TextField
                    label={copy.rows.amount}
                    placeholder={fmt(copy.minimum, { min: MIN_AMOUNT })}
                    inputMode="decimal"
                    autoFocus
                    className="ww-autofocus"
                    value={amount}
                    onChange={(v) => setAmount(decimalInput(v))}
                    onSubmit={() => canNext && setPhase("options")}
                    error={
                      overspent
                        ? copy.overspent
                        : amountError(amount) ??
                          (belowMin ? fmt(copy.tooSmall, { min: MIN_AMOUNT }) : undefined)
                    }
                    trailing={
                      <button
                        type="button"
                        className="zkm-btn-reset ww-pay__max"
                        onClick={() =>
                          main &&
                          decimals !== undefined &&
                          setAmount(floorToCents(main.atomic, decimals))
                        }
                      >
                        {copy.max}
                      </button>
                    }
                  />
                </div>
                <TextField
                  label={copy.note}
                  placeholder={copy.notePlaceholder}
                  value={note}
                  onChange={(v) => setNote(truncateUtf8(v, PAYLINK_MEMO_MAX_BYTES))}
                  onSubmit={() => canNext && setPhase("options")}
                />
                {feeRows}
                {ticketMinimum !== undefined && (
                  <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
                    {ticketThresholdHint(ticketMinimum)}
                  </span>
                )}
                <PrimaryGradientButton
                  title={copy.next}
                  isDisabled={!canNext}
                  onClick={() => setPhase("options")}
                />
              </div>
            )}

            {phase === "options" && (
              <div className="ww-pay__form">
                <label className="zkm-field">
                  <span className="zkm-field__label">{copy.expiryLabel}</span>
                  <span className={`zkm-field__box ${styles.select}`}>
                    <select
                      value={expiryDays}
                      onChange={(e) => setExpiryDays(Number(e.target.value))}
                    >
                      {EXPIRY_DAYS.map((d) => (
                        <option key={d} value={d}>
                          {fmt(copy.expireIn, { count: d, unit: d === 1 ? copy.day : copy.days })}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={16} color="var(--text-primary)" />
                  </span>
                </label>
                {handle && (
                  <div className="ww-pay__summary">
                    <div className={styles.payProtect}>
                      <span>{copy.showTag}</span>
                      <GradientToggle isOn={showTag} onChange={setShowTag} />
                    </div>
                  </div>
                )}
                {emailLockedLinksEnabled && (
                  <div className="zkm-field">
                    <span className="zkm-field__label" title={copy.protect.title}>
                      {copy.protect.label}
                    </span>
                    <div className="ww-pay__summary">
                      <div className={styles.payProtect}>
                        <span>{copy.protect.toggle}</span>
                        <GradientToggle isOn={protectEnabled} onChange={setProtectEnabled} />
                      </div>
                      {protectEnabled && (
                        <TextField
                          placeholder={copy.protect.placeholder}
                          type="email"
                          inputMode="email"
                          autoFocus
                          value={email}
                          onChange={setEmail}
                          error={trimmedEmail && !validEmail ? copy.protect.invalid : undefined}
                          onSubmit={() => canConfirm && toConfirm()}
                        />
                      )}
                      {protectEnabled && (
                        <span
                          className="zkm-type-body-sm"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {copy.protect.google}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <PrimaryGradientButton
                  title={copy.confirm}
                  isDisabled={!canConfirm}
                  onClick={toConfirm}
                />
              </div>
            )}

            {phase === "confirm" && (
              <div className="ww-pay__form">
                <div className="ww-pay__summary">
                  <ConfirmationSheetDetailRow label={copy.rows.amount} value={usd(parsed)} />
                  <ConfirmationSheetDetailRow label={copy.rows.fee} value={copy.rows.free} />
                  <ConfirmationSheetDetailRow
                    label={copy.rows.expiry}
                    value={fmt(copy.expiryValue, {
                      count: expiryDays,
                      unit: expiryDays === 1 ? copy.day : copy.days,
                    })}
                  />
                  {emailLocked && (
                    <ConfirmationSheetDetailRow label={copy.rows.validation} value={trimmedEmail} />
                  )}
                  {note.trim() && (
                    <ConfirmationSheetDetailRow label={copy.rows.note} value={note.trim()} />
                  )}
                  {senderTag && (
                    <ConfirmationSheetDetailRow label={copy.rows.from} value={`@${senderTag}`} />
                  )}
                  <ConfirmationSheetDetailRow
                    label={copy.rows.recipient}
                    value={
                      voucher === undefined
                        ? copy.recipient.checking
                        : voucher
                        ? copy.recipient.anyone
                        : copy.recipient.account
                    }
                  />
                </div>
                {grantsTicket && (
                  <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
                    {TICKET_GRANT_COPY}
                  </span>
                )}
                {/* Reachable when the balance lands after Next — the CTA is dead without this. */}
                {overspent && <span className="ww-pay__error">{copy.overspent}</span>}
                <SponsoredActionNotice reason={unsponsored} />
                <LocalPasskeyHint />
                <PrimaryGradientButton
                  testId="paylink-create"
                  title={busy ? busyLabel : ready && voucherKnown ? copy.create : copy.connecting}
                  isDisabled={!ready || !voucherKnown || overspent || busy || !!unsponsored}
                  onClick={create}
                />
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  )
}

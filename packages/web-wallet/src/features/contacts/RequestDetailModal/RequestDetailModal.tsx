import { useEffect, useState } from "react"
import type { PaymentRequest } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  GradientText,
  Icon,
  PrimaryGradientButton,
} from "@obsidion/web-ds"
import cancelArt from "../../../assets/contacts/cancel-request.webp"
import { getConfig } from "../../../config/env"
import { showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent } from "../../../lib/analytics"
import { l2TxUrl } from "../../../lib/explorer"
import { rowTimestamp, shortAddr, usdBalance } from "../../../ui/format"
import { Modal } from "../../../ui/Modal"
import { useSession } from "../../../platform/session"
import { cancelRequestById } from "../requestActions"
import { REMIND_TITLE, type RemindState } from "../useRemind"
import styles from "./RequestDetailModal.module.css"
import copy from "./RequestDetailModal.copy"
import { fmt } from "../../../lib/fmt"

const STATUS_VIEW: Record<
  PaymentRequest["status"],
  { label: string; icon: string; color: string }
> = {
  pending: { label: copy.status.pending, icon: "clock", color: "#eed04e" },
  fulfilled: { label: copy.status.fulfilled, icon: "check", color: "#2ecc71" },
  declined: { label: copy.status.declined, icon: "x", color: "#fe708b" },
  cancelled: { label: copy.status.cancelled, icon: "x", color: "#fe708b" },
}

/** The one confirm sheet every request-cancel path goes through. */
export function CancelRequestConfirmModal({
  busy,
  onConfirm,
  onClose,
}: {
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal variant="create" label={copy.cancel.title} onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className={styles.cancelConfirm}>
          <img src={cancelArt} alt="" width={139} height={140} />
          <span className={styles.cancelConfirmTitle}>{copy.cancel.title}</span>
        </div>
        <button
          type="button"
          className={`zkm-btn-reset zkm-pressable ${styles.dangerBtn}`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? copy.cancel.cancelling : copy.cancel.action}
        </button>
      </div>
    </Modal>
  )
}

/** Post-cancel beat; the host closes it after a moment. */
export function RequestCancelledModal() {
  return (
    <Modal variant="create" label={copy.cancel.done}>
      <div className="ww-create-modal__body">
        <div className={styles.cancelConfirm}>
          <Icon name="x" size={28} color="#fe708b" />
          <span className={styles.cancelConfirmTitle}>{copy.cancel.done}</span>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Detail sheet for a payment request in the contact chat (ULT-671 page 5): the stored row's
 * fields plus, for an open outgoing request, a cancel chain (confirm → local flip → "Request
 * cancelled"). Cancelling only flips the local row — the peer's copy stays until an XMTP cancel
 * signal exists. `initialStep="confirm"` enters at the confirm sheet (the bubble's and the
 * activity rows' inline Cancel). `tag` falls back to the stored row's contact tag when the caller
 * doesn't know the counterparty (a feed row).
 */
export function RequestDetailModal({
  requestId,
  tag,
  initialStep = "detail",
  remind = "idle",
  onRemind,
  onClose,
}: {
  requestId: string
  tag?: string
  initialStep?: "detail" | "confirm"
  remind?: RemindState
  /** Offers Remind beside Cancel on an open outgoing request. */
  onRemind?: () => void
  onClose: () => void
}) {
  const [row, setRow] = useState<PaymentRequest>()
  const [step, setStep] = useState<"detail" | "confirm" | "cancelled">(initialStep)
  const [busy, setBusy] = useState(false)
  const { requests } = useSession()
  useEffect(() => {
    let open = true
    // Loads once per open — the modal owns the row for its lifetime.
    requests.all().then(
      (rows) => {
        if (!open) return
        const found = rows.find((r) => r.id === requestId)
        if (found) setRow(found)
        else onClose()
      },
      () => open && onClose(),
    )
    return () => {
      open = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  useEffect(() => {
    if (step !== "cancelled") return
    const t = setTimeout(onClose, 1600)
    return () => clearTimeout(t)
  }, [step, onClose])

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await cancelRequestById(requestId)) {
        setStep("cancelled")
        return
      }
      // Lost the race to a terminal status: show what the row became.
      const fresh = (await requests.all()).find((r) => r.id === requestId)
      if (fresh) setRow(fresh)
      else onClose()
      setStep("detail")
    } catch (cause) {
      fireEvent("action_failed", { action: "contact:request-cancel", code: failureCode(cause) })
      showReportableError(cause, "contact:request-cancel")
    } finally {
      setBusy(false)
    }
  }

  if (!row) return null

  if (step === "cancelled") return <RequestCancelledModal />

  if (step === "confirm") {
    return (
      <CancelRequestConfirmModal busy={busy} onConfirm={() => void cancel()} onClose={onClose} />
    )
  }

  const config = getConfig()
  const status = STATUS_VIEW[row.status]
  const txHash = row.fulfillmentTxHash
  const handle = tag ?? row.contactTag
  return (
    <Modal variant="create" label={copy.title} onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-create-modal__head">
          <GradientInitialAvatar name={handle ?? copy.title} size={64} />
          <div className="ww-share-modal__title">
            <GradientText size={24} weight={700}>
              {copy.title}
            </GradientText>
            <span className="ww-request-contact__handle">
              {handle ? fmt(copy.handle, { handle }) : copy.viaPaylink}
            </span>
          </div>
        </div>

        <div className="ww-review-card">
          <ConfirmationSheetDetailRow label={copy.rows.type} value={copy.rows.receive} />
          <ConfirmationSheetDetailRow
            label={copy.rows.amount}
            value={usdBalance(String(row.amount))}
          />
          {row.note && <ConfirmationSheetDetailRow label={copy.rows.note} value={row.note} />}
          <ConfirmationSheetDetailRow label={copy.rows.date} value={rowTimestamp(row.createdAt)} />
          <ConfirmationSheetDetailRow
            label={copy.rows.hash}
            value={
              txHash ? (
                <a
                  className="ww-request-detail__hash"
                  href={l2TxUrl(config.network, config.nodeUrl, txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(txHash)}
                  <Icon name="share-box" size={16} color="currentColor" />
                </a>
              ) : (
                <span className="ww-request-detail__hash">
                  --
                  <Icon name="share-box" size={16} color="currentColor" />
                </span>
              )
            }
          />
          <div className={styles.reviewCardDivider} />
          <ConfirmationSheetDetailRow
            label={copy.rows.status}
            value={
              <span className={styles.requestDetailStatus} style={{ color: status.color }}>
                <Icon name={status.icon} size={16} color="currentColor" />
                {status.label}
              </span>
            }
          />
        </div>

        {row.direction === "outgoing" && row.status === "pending" && onRemind && (
          <div className="ww-share-modal__buttons">
            <PrimaryGradientButton
              title={copy.cancel.action}
              buttonStyle="dark"
              onClick={() => setStep("confirm")}
            />
            <PrimaryGradientButton
              title={REMIND_TITLE[remind]}
              isLoading={remind === "sending"}
              isDisabled={remind === "sent"}
              onClick={onRemind}
            />
          </div>
        )}
        {row.direction === "outgoing" && row.status === "pending" && !onRemind && (
          <button
            type="button"
            className={`zkm-btn-reset zkm-pressable ${styles.dangerBtn}`}
            onClick={() => setStep("confirm")}
          >
            {copy.cancel.action}
          </button>
        )}
      </div>
    </Modal>
  )
}

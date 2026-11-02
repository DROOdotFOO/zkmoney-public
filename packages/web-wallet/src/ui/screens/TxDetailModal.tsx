/**
 * Transaction detail modal: counterparty
 * avatar, Type / Amount / Note / Date / Tx hash (Aztec Scan link) / Status card, and for creator
 * paylink rows the share section: tap-to-copy claim URL and Share (Web Share API only — hidden when
 * the browser has no share sheet).
 *
 * On a creator paylink row the status is the link's own lifecycle, in the words the feed row uses.
 * It starts from the stored row (front-core's paylinkStatusFor); opening rechecks the chain through
 * the shared claim reconciler, whose flip updates the feed row and this sheet together.
 *
 * A creator paylink row whose escrow is still spendable also carries its recovery: "Cancel link"
 * during the grace window, "Reclaim funds" once the claim window has closed (`creatorLinkActions.ts`).
 * The gate reads the refreshed status, so a link the refresh shows claimed offers neither, and stays
 * inert while that refresh is in flight. What the sheet offers is front-core's `paylinkRowView`, as
 * on the feed row: an unsettled create or a refund in flight offers no recovery.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  globalEventEmitter,
  isRefundInFlight,
  onRefundInFlightChanged,
  paylinkRowView,
  refundInFlightVersion,
  truncateMiddle,
  type PaylinkRowStatusLabel,
  useResource,
} from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  Icon,
  PrimaryGradientButton,
  StatusBadge,
  avatarColors,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import { PayModalChrome } from "../PayModalChrome"
import { usePhoneLayout } from "../usePhoneLayout"
import { Modal } from "../Modal"
import { usdFigure } from "../format"
import { useL2TxUrl } from "../useL2TxUrl"
import { useBalanceMovingPause } from "../../features/backupPasskey/balanceMovingPause"
import { creatorLinkAction, isOtherRollupLink, type CreatorLinkAction } from "@obsidion/front-core"
import { paylinkRowShareUrl } from "../../features/shortLinks"
import { LinkRecoverModal } from "../../features/paylink/LinkRecoverModal"
import { usePolledChainSeconds } from "../../features/paylink/chainTime"
import { recheckPaylinkClaim } from "../../features/notifications/PaylinkClaimMount/PaylinkClaimMount"
import { usePaylinkDeps } from "../../features/paylink/usePaylinkDeps"
import { useTabLine } from "../../features/operations/operations"
import { HashRow } from "../detailRows"
import { useCopy } from "../hooks"
import { linkFragmentOf, type ActivityRowView } from "./activityView"
import { StatusWithReason } from "./DepositStatusValue"
import { useSession } from "../../platform/session"

// Styles match the feed row's STATUS_STYLE for the same labels, so one state never wears two colors.
const PAYLINK_BADGE_STYLE: Record<PaylinkRowStatusLabel, StatusBadgeStyle> = {
  Pending: "pending",
  Failed: "failed",
  Cancelling: "pending",
  Reclaiming: "pending",
  Cancelled: "cancelled",
  Reclaimed: "cancelled",
  Unclaimed: "awaitingClaim",
  Claimed: "paid",
  Refunded: "cancelled",
  Migrated: "pending",
  Expired: "failed",
}

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function"

function expiryLabel(untilSec: number | undefined, nowSec: number): string {
  if (untilSec == null) return "--"
  const days = Math.ceil((untilSec - nowSec) / 86400)
  return days <= 0 ? "Expired" : `${days} ${days === 1 ? "day" : "days"} remaining`
}

export function TxDetailModal({
  row,
  note: noteProp,
  notice,
  onClose,
}: {
  row: ActivityRowView
  /** Memo override — the chat passes the fulfilled request's note when the transfer has none. */
  note?: string
  /** Full text of the notification that opened this detail. */
  notice?: string
  onClose: () => void
}) {
  const { copied, copy } = useCopy()
  const phone = usePhoneLayout()
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const deps = usePaylinkDeps()
  const networkId = useResource(useSession().wallet)?.networkId
  const linkTabLine = useTabLine(row.paylinkRow?.operationId)
  const pauseForMove = useBalanceMovingPause()

  const fragment = row.paylink ? linkFragmentOf(row.paylink) : null
  const [linkStatus, setLinkStatus] = useState(row.paylinkStatus)
  const [checking, setChecking] = useState(false)
  // Paylink windows are chain timestamps: the recovery on offer must flip as the tip crosses
  // them while the sheet is open, and stays withheld until the tip has been read.
  const chainNow = usePolledChainSeconds(deps?.wallet.node)
  // Re-renders as this page starts or ends a refund, before the row learns its hash.
  useSyncExternalStore(onRefundInFlightChanged, refundInFlightVersion)
  // Captured at the tap: the sheet follows its row, and a refund scrubs that row's link as it
  // lands, so the recovery modal must not depend on what the row carries afterwards.
  const [recovering, setRecovering] = useState<{
    action: CreatorLinkAction
    fragment: string
    paylinkRow: NonNullable<ActivityRowView["paylinkRow"]>
    amount: string
    createdMs: number
  } | null>(null)

  // A status the row itself now carries (refunded, claimed) wins over the one it opened with.
  useEffect(() => setLinkStatus(row.paylinkStatus), [row.paylinkStatus])

  useEffect(() => {
    const { txHash } = row
    if (!txHash || !row.paylinkStatus) return
    let cancelled = false
    const onClaimed = (d: { txHash: string }) => d.txHash === txHash && setLinkStatus("claimed")
    globalEventEmitter.onPaylinkClaimed(onClaimed)
    setChecking(true)
    void recheckPaylinkClaim(txHash).finally(() => !cancelled && setChecking(false))
    return () => {
      cancelled = true
      globalEventEmitter.offPaylinkClaimed(onClaimed)
    }
  }, [row.txHash, row.paylinkStatus])

  const l2TxUrl = useL2TxUrl(row.networkId)
  const explorerUrl = row.txHash && l2TxUrl ? l2TxUrl(row.txHash) : null
  // A refund has no row of its own, so the link's own row is where its transaction is readable.
  const refundUrl = row.refundTxHash && l2TxUrl ? l2TxUrl(row.refundTxHash) : null
  // The feed row's view, re-derived off the refreshed link status and the polled chain tip, so the
  // two can never read differently.
  const linkView = row.paylinkRow
    ? paylinkRowView(row.paylinkRow, {
        linkStatus,
        offer:
          linkStatus && chainNow != null
            ? creatorLinkAction(row.paylinkRow, {
                nowSec: chainNow,
                liveStatus: linkStatus,
                account: deps?.account.getAddress().toString(),
              })
            : null,
        refundStatus: row.refundStatus,
        refundStarting: isRefundInFlight(row.paylinkRow.payToEmailSecret ?? ""),
        retired: isOtherRollupLink(row.paylinkRow, networkId),
        nowSec: chainNow ?? Math.floor(Date.now() / 1000),
      })
    : undefined
  const statusLabel = linkView?.statusLabel ?? "Completed"
  const paylinkBadgeStyle: StatusBadgeStyle = linkView?.statusLabel
    ? PAYLINK_BADGE_STYLE[linkView.statusLabel]
    : "awaitingClaim"
  const recovery = linkView?.recovery ?? null

  if (recovering) {
    return (
      <LinkRecoverModal
        action={recovering.action}
        deps={deps}
        fragment={recovering.fragment}
        amount={recovering.amount}
        createdMs={recovering.createdMs}
        untilClaimableSec={recovering.paylinkRow.untilClaimable}
        refundableUntilSec={recovering.paylinkRow.refundableUntil}
        onClose={onClose}
      />
    )
  }

  const outgoing = row.amount.trim().startsWith("-")
  const pending = row.status === "pending"
  const type = outgoing ? "Send" : "Receive"
  // Only a settled transfer reads as done ("Sent" / "Received"); a pending or failed one keeps the action's name.
  const title = row.paylink
    ? row.counterparty
    : row.status === "success"
    ? outgoing
      ? "Sent"
      : "Received"
    : type
  const avatarName = row.contact?.name ?? row.counterparty
  // The counterparty's chat is where all of that user's transactions live; an unsaved tag opens it
  // unsaved.
  const contactId = row.contact?.id ?? row.counterpartyTag
  const contactPath =
    contactId && !row.paylink ? `/contacts/${encodeURIComponent(contactId)}` : null
  const openContact =
    contactPath && pathname !== contactPath
      ? () => {
          onClose()
          navigate(contactPath)
        }
      : undefined
  const subtitle = row.contact?.tag
    ? `${row.contact.tag.replace(/^@/, "")}.zk.money`
    : row.counterparty

  const isLink = !!(row.paylink && fragment && linkStatus)
  // An unsettled create is not a send yet.
  const linkTitle = row.status === "success" ? "Send via paylink" : "Paylink"
  const nowSec = chainNow ?? Math.floor(Date.now() / 1000)
  const amountFace = row.amount.replace(/^[+-]/, "")
  const note = noteProp ?? row.note
  const hashLink =
    explorerUrl && row.txHash ? (
      <a className="ww-txd__hash" href={explorerUrl} target="_blank" rel="noreferrer">
        {truncateMiddle(row.txHash, 12)}
        <Icon name="share-box" size={14} color="currentColor" />
      </a>
    ) : (
      "--"
    )

  const badge = linkStatus ? (
    <StatusBadge label={statusLabel} badgeStyle={paylinkBadgeStyle} />
  ) : pending ? (
    <StatusBadge label="Pending" badgeStyle="pending" />
  ) : row.status === "failed" ? (
    <StatusBadge label={row.statusLabel ?? "Failed"} badgeStyle="failed" />
  ) : (
    <StatusBadge label="Completed" badgeStyle="paid" />
  )
  const status = <StatusWithReason status={badge} reason={row.error} />

  return (
    <Modal
      variant="bare"
      className="ww-txd"
      label={`${isLink ? linkTitle : title} ${amountFace}`}
      onClose={onClose}
    >
      <PayModalChrome
        title={isLink ? linkTitle : title}
        subtitle={
          isLink ? null : openContact ? (
            <button type="button" className="zkm-btn-reset ww-txd__link" onClick={openContact}>
              {subtitle}
              <Icon name="chevron-right" size={12} color="currentColor" />
            </button>
          ) : (
            subtitle
          )
        }
        onClose={onClose}
        avatar={
          isLink ? (
            <span className="ww-send-option__icon">
              <Icon name="link" size={24} color="#fff" />
            </span>
          ) : row.avatarIcon ? (
            <Icon name={row.avatarIcon} size={28} color="#fff" />
          ) : (
            <GradientInitialAvatar
              name={avatarName}
              colors={avatarColors(row.contact?.id ?? avatarName)}
              size={52}
            />
          )
        }
      />

      {notice && <p className="ww-txd__notice">{notice}</p>}
      {/* Leaving loses the link's deposit while it proves here; once sent it is the chain's. */}
      {isLink && linkTabLine === "keep" && (
        <div className="ww-txd__notice ww-txd__notice--live" role="status">
          <span>
            Your link is ready to share. Keep this tab open until it's finished creation. You can
            close this modal now, we'll notify you.
          </span>
        </div>
      )}
      {isLink && linkTabLine === "safe" && (
        <p className="ww-txd__notice ww-txd__notice--safe" role="status">
          Sent. You can close this tab. The link can be claimed once the network confirms it.
        </p>
      )}

      {isLink ? (
        <div className="ww-txd__card">
          {note && <ConfirmationSheetDetailRow label="Note" value={note} />}
          {row.paylinkRow?.to && (
            <ConfirmationSheetDetailRow label="Validation" value={row.paylinkRow.to} />
          )}
          <ConfirmationSheetDetailRow label="Date created" value={pending ? "--" : row.timestamp} />
          <ConfirmationSheetDetailRow label="Tx hash" value={hashLink} />
          {row.refundTxHash && (
            <HashRow label="Refund" hash={row.refundTxHash} url={refundUrl ?? undefined} />
          )}
          <hr className="ww-divider" />
          <ConfirmationSheetDetailRow label="Amount" value={amountFace} />
          <ConfirmationSheetDetailRow label="Status" value={status} />
          {row.status !== "failed" && (
            <ConfirmationSheetDetailRow
              label="Link expiry"
              value={expiryLabel(row.paylinkRow?.untilClaimable, nowSec)}
            />
          )}
        </div>
      ) : (
        <div className="ww-txd__card">
          <ConfirmationSheetDetailRow label="Amount" value={row.amount.replace(/^[+-]/, "")} />
          {note && <ConfirmationSheetDetailRow label="Note" value={note} />}
          <ConfirmationSheetDetailRow label="Date" value={pending ? "--" : row.timestamp} />
          <ConfirmationSheetDetailRow label="Tx hash" value={hashLink} />
          {row.refundTxHash && (
            <HashRow label="Refund" hash={row.refundTxHash} url={refundUrl ?? undefined} />
          )}
          <hr className="ww-divider" />
          <ConfirmationSheetDetailRow label="Status" value={status} />
        </div>
      )}

      {isLink ? (
        <>
          {linkView?.canShare && (
            <div className="ww-txd__actions">
              {canShare && phone && (
                <PrimaryGradientButton
                  title="Share"
                  buttonStyle="dark"
                  leadingIcon="share"
                  onClick={() => {
                    void navigator
                      .share({
                        text: `I sent you ${amountFace} on zk.money`,
                        url: paylinkRowShareUrl(row.paylink!),
                      })
                      .catch(() => {})
                  }}
                />
              )}
              <PrimaryGradientButton
                title={copied ? "Copied!" : "Copy paylink"}
                leadingIcon={copied ? "check" : "file-copy"}
                onClick={() =>
                  void copy(paylinkRowShareUrl(row.paylink!)).then(
                    (copiedLink) => copiedLink && onClose(),
                  )
                }
              />
            </div>
          )}
          {recovery && fragment && row.paylinkRow && (
            <PrimaryGradientButton
              title={recovery === "reclaim" ? "Reclaim funds" : "Cancel link"}
              buttonStyle="danger"
              isDisabled={checking}
              onClick={() =>
                pauseForMove(() => {
                  const token = row.paylinkRow?.token
                  setRecovering({
                    action: recovery,
                    fragment,
                    paylinkRow: row.paylinkRow!,
                    amount: token
                      ? usdFigure(String(token.amount))
                      : row.amount.replace(/^[+-]/, ""),
                    createdMs: row.timestampMs,
                  })
                })
              }
            />
          )}
        </>
      ) : (
        // ponytail: cancellation is out of scope; a pending row shows no footer action.
        !pending &&
        openContact && (
          <button type="button" className="zkm-btn-reset ww-txd__all" onClick={openContact}>
            See all transactions
          </button>
        )
      )}
    </Modal>
  )
}

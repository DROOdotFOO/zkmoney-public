import { Modal } from "../../ui/Modal"
/**
 * Confirm sheet for the two creator-side link recoveries (`creatorLinkActions.ts`): cancel an
 * unclaimed link inside its refund window, or reclaim one whose claim window has closed. Nothing to choose — the
 * row fixed the amount and the destination is the creator's own balance — so this is copy, three
 * facts, and a button.
 *
 * A claim that lands first spends the escrow's nullifier and makes the submit revert; that revert is
 * the one mapped to friendly copy, everything else stays reportable.
 */
import { useRef, useState } from "react"
import {
  isPaylinkAlreadySpentRevert,
  isPaylinkWindowRevert,
  PAYLINK_ALREADY_SPENT_MESSAGE,
  TxInFlightError,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  ConfirmationSheetDetailRow,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { showErrorModal, showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { whenLabel } from "../../ui/detailRows"
import { useUserFlowActive } from "../provingGate"
import { PAYLINK_WINDOW_MESSAGE } from "./claimWindow"
import type { CreatorLinkAction } from "@obsidion/front-core"
import { recoverSponsoredLink, type SponsoredPaylinkDeps } from "./sponsoredPaylink"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"

const ALREADY_SPENT_TITLE = "Already claimed"

const COPY: Record<
  CreatorLinkAction,
  {
    title: string
    explainer: string
    cta: string
    windowLabel: string
  }
> = {
  reclaim: {
    title: "Reclaim funds",
    explainer:
      "The claim window on this link has closed and nobody claimed it. Reclaim it and the funds come back to your balance. If a claim landed in the final moments, this fails harmlessly and those funds stay with whoever claimed them.",
    cta: "Reclaim funds",
    windowLabel: "Claim window closed",
  },
  cancel: {
    title: "Cancel link",
    explainer:
      "Nobody has claimed this link yet. Cancel it and the funds come back to your balance.",
    cta: "Cancel link",
    windowLabel: "Cancellable until",
  },
}

const ACTION_TAG: Record<CreatorLinkAction, string> = {
  reclaim: "paylink:reclaim",
  cancel: "paylink:cancel",
}

export function LinkRecoverModal({
  action,
  deps,
  fragment,
  amount,
  createdMs,
  untilClaimableSec,
  refundableUntilSec,
  onClose,
}: {
  action: CreatorLinkAction
  /** Undefined until the wallet finishes loading; submitting then refuses before anything moves. */
  deps: SponsoredPaylinkDeps | undefined
  fragment: string
  /** Display amount in dollars, e.g. "$30". */
  amount: string
  createdMs: number
  untilClaimableSec?: number
  refundableUntilSec?: number
  onClose: () => void
}) {
  const copy = COPY[action]
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const windowSec = action === "cancel" ? refundableUntilSec : untilClaimableSec
  const [phase, setPhase] = useState<"form" | "working">("form")
  const left = useRef(false)
  const leave = () => {
    left.current = true
    onClose()
  }

  const submit = async () => {
    if (!deps) {
      showReportableError(
        new Error("The wallet is still loading. Try again in a moment."),
        ACTION_TAG[action],
      )
      return
    }
    setPhase("working")
    try {
      await recoverSponsoredLink(deps, fragment)
    } catch (e) {
      if (isPasskeyCancelled(e)) {
        setPhase("form")
        return
      }
      // At the node already: back to the form is an invitation to send it twice.
      if (e instanceof TxInFlightError) return
      fireEvent("action_failed", { action: ACTION_TAG[action], code: failureCode(e) })
      if (left.current) return
      setPhase("form")
      if (isPaylinkAlreadySpentRevert(e)) {
        showErrorModal({
          title: ALREADY_SPENT_TITLE,
          message: PAYLINK_ALREADY_SPENT_MESSAGE,
          context: ACTION_TAG[action],
        })
      } else if (isPaylinkWindowRevert(e)) {
        showErrorModal({
          title: "Window closed",
          message: PAYLINK_WINDOW_MESSAGE,
          context: ACTION_TAG[action],
        })
      } else {
        showReportableError(e, ACTION_TAG[action])
      }
    }
  }

  return (
    <Modal variant="bare" label={copy.title} onClose={phase === "working" ? undefined : onClose}>
      {phase === "working" ? (
        <OperationHandOff onLeave={leave} />
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
              {copy.title}
            </span>
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              {copy.explainer}
            </p>
            <div>
              <ConfirmationSheetDetailRow label="Amount" value={amount} />
              <ConfirmationSheetDetailRow label="Link created" value={whenLabel(createdMs)} />
              {windowSec != null && (
                <ConfirmationSheetDetailRow
                  label={copy.windowLabel}
                  value={whenLabel(windowSec * 1000)}
                />
              )}
            </div>
            <PrimaryGradientButton
              title={busy ? busyLabel : copy.cta}
              isDisabled={busy}
              onClick={() => void submit()}
            />
          </div>
        </>
      )}
    </Modal>
  )
}

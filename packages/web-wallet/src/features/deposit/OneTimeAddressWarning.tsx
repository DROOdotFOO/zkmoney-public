import { Modal } from "../../ui/Modal"
import { useEffect, useState } from "react"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { ADDRESS_RECHECK_NOTE } from "../limits/limitsCopy"

export interface OneTimeAddressPoint {
  id: "loss" | "rotates" | "single-use"
  icon: string
  title: string
  body: string
}

/** What a payer has to know about a single-use SIPA address, wherever one is shown. */
export function oneTimeAddressPoints(symbol: string): OneTimeAddressPoint[] {
  return [
    {
      id: "loss",
      icon: "coins",
      title: "Risk of loss",
      body: `Only send ${symbol} on Ethereum (ERC20). Sending wrong requires manual recovery.`,
    },
    {
      id: "rotates",
      icon: "history-clock",
      title: "This address changes every time",
      body: "A new address is generated each time you open this screen. Don't save it for future use.",
    },
    {
      id: "single-use",
      icon: "shield-check",
      title: "Keep it single use",
      body: "Sending to this address more than once reduces your privacy. Use it only one time.",
    },
  ]
}

export function OneTimeAddressPoints({ points }: { points: OneTimeAddressPoint[] }) {
  return (
    <div className="ww-deposit-warning__points">
      {points.map((p) => (
        <div key={p.id} className="ww-deposit-warning__point">
          <span className="ww-deposit-warning__point-icon">
            <Icon name={p.icon} size={24} color="#fff" />
          </span>
          <span className="ww-deposit__connect-text">
            <b>{p.title}</b>
            <span>{p.body}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** The dialog in front of Copy and Show QR. `capacityWarning` is said every time it is set. */
export function OneTimeAddressWarning({
  capacityWarning,
  onClose,
  onGotIt,
}: {
  /** Shared capacity is zero or not confirmed for this address. */
  capacityWarning?: string
  onClose: () => void
  onGotIt: () => void
}) {
  // A reading that improves while the dialog is open does not empty it: the last warning stays.
  const [shownWarning, setShownWarning] = useState(capacityWarning)
  useEffect(() => {
    if (capacityWarning) setShownWarning(capacityWarning)
  }, [capacityWarning])

  return (
    <Modal
      variant="bare"
      label="Network capacity" // slice-check-ignore: existing label, unmigrated component
      className="ww-deposit-warning"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
        <Icon name="alert-triangle" size={32} color="#fff" />
      </span>
      <GradientText size={24} weight={700}>
        Before you share this address
      </GradientText>
      {shownWarning && (
        <div
          className="ww-deposit-warning__capacity"
          role="alert"
          data-testid="address-capacity-warning"
        >
          <p>{shownWarning}</p>
          <p>{ADDRESS_RECHECK_NOTE}</p>
        </div>
      )}
      <div className="ww-deposit-warning__actions">
        <PrimaryGradientButton
          title="Got it!"
          onClick={onGotIt}
          style={{ width: 166, height: 48 }}
        />
      </div>
    </Modal>
  )
}

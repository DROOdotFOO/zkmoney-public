import { bubbleViewOf, type ChatMessage } from "../contactChat"
import copy from "../contactChat.copy"
import { GradientInitialAvatar, Icon, Spinner, avatarColors } from "@obsidion/web-ds"
import styles from "./ChatBubble.module.css"

/** Amount bubble for the contact payments chat: counterparty avatar + glass bubble, left (incoming)
 *  or right (outgoing). The body is the control that opens the message's detail sheet; `actions`
 *  sit beside it as siblings, never inside it. */
export function ChatBubble({
  message,
  leftName,
  rightName,
  actions,
  onOpen,
}: {
  message: ChatMessage
  /** Avatar seed for incoming bubbles (the contact). */
  leftName: string
  /** Avatar seed for outgoing bubbles (the user). */
  rightName: string
  /** Open-request buttons, left→right; the last is the gradient primary unless `secondary`. */
  actions?: {
    label: string
    onClick: () => void
    disabled?: boolean
    loading?: boolean
    secondary?: boolean
  }[]
  onOpen: () => void
}) {
  const view = bubbleViewOf(message.role)
  const right = view.side === "right"
  const avatarName = right ? rightName : leftName
  return (
    <div className={styles.chatRow} data-side={view.side}>
      <GradientInitialAvatar name={avatarName} colors={avatarColors(avatarName)} size={40} />
      <div className="ww-bubble" data-side={view.side} data-error={view.error || undefined}>
        <div
          className={styles.bubbleBody}
          role="button"
          aria-label={view.request ? copy.aria.request : copy.aria.transaction}
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onOpen()
            }
          }}
        >
          <span
            className={styles.bubblePill}
            data-gold={view.request || undefined}
            data-settled={view.settled || undefined}
          >
            {view.label}
            <Icon name={view.icon} size={12} color="currentColor" />
          </span>
          <span
            className={styles.bubbleAmount}
            style={{ textDecoration: view.struck ? "line-through" : undefined }}
          >
            {view.request || view.settled ? message.amount.replace(/^[+-]/, "") : message.amount}
          </span>
          {message.memo && <span className="ww-bubble__memo">{message.memo}</span>}
          {!view.request && (
            <span className={styles.bubbleTime}>
              {message.timeLabel}
              {view.tick === "proving" && <Spinner size={12} />}
              {/* A received row is only ever recorded once it is on-chain, so it never doubles. */}
              {/* Mempool tick stays muted — green is reserved for mined, or a Pending bubble
                  reads as success. */}
              {view.tick === "sent" && (
                <Icon name="check" size={14} color="var(--text-secondary)" />
              )}
              {view.tick === "mined" && (
                <Icon name={right ? "double-check" : "check"} size={14} color="#2ecc71" />
              )}
            </span>
          )}
        </div>
        {actions && actions.length > 0 && (
          <span className={styles.bubbleActions}>
            {actions.map((a, i) => (
              <button
                key={a.label}
                type="button"
                className={`zkm-btn-reset ${styles.bubbleBtn}`}
                data-primary={(i === actions.length - 1 && !a.secondary) || undefined}
                disabled={a.disabled || a.loading}
                aria-busy={a.loading || undefined}
                aria-label={a.loading ? a.label : undefined}
                onClick={a.onClick}
              >
                {a.loading ? <Spinner size={12} color="#fff" /> : a.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

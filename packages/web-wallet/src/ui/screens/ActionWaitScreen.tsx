import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { Card } from "@obsidion/web-ds"

/** Shown in place of an action that has to wait: what it waits for, and a way back to the wallet. */
export function ActionWaitScreen({
  testId,
  title,
  message,
  action,
}: {
  testId: string
  title: string
  message: string
  /** A way to end the wait, shown above "Back to wallet". */
  action?: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <div style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
      <Card padding={20}>
        <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span
            className="zkm-type-card-title"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
          >
            {title}
          </span>
          <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
            {message}
          </span>
          {action}
          <button
            type="button"
            className="zkm-btn-reset ww-invite__link"
            style={{ width: "fit-content", alignSelf: "center", fontSize: 14 }}
            onClick={() => navigate("/")}
          >
            Back to wallet
          </button>
        </div>
      </Card>
    </div>
  )
}

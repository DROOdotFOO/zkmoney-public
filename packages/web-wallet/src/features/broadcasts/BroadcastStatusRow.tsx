/**
 * The line under an address whose broadcast has not landed: where it stands. Funds sent meanwhile
 * wait at the address.
 */
import type { ReactNode } from "react"
import { Spinner } from "@obsidion/web-ds"
import { getBroadcastLedger } from "./broadcasts"
import { broadcastStatusLine, useBroadcastStatus } from "./useBroadcastStatus"

/** `fallback` reads while the ledger does not hold the address yet, e.g. before a tick owes it. */
export function BroadcastStatusRow({
  address,
  fallback = broadcastStatusLine({ kind: "waiting" }),
}: {
  address: string
  fallback?: ReactNode
}) {
  const status = useBroadcastStatus(address)
  if (!status)
    return (
      <div className="ww-send-to__note" data-testid="broadcast-status" data-status="unknown">
        <Spinner size={12} />
        <span>{fallback}</span>
      </div>
    )
  if (status.kind === "published") return null
  const working =
    status.kind !== "unlock" && status.kind !== "registration" && status.kind !== "moving"
  return (
    <div className="ww-send-to__note" data-testid="broadcast-status" data-status={status.kind}>
      {working && <Spinner size={12} />}
      <span>{broadcastStatusLine(status)}</span>
      {status.kind === "retrying" && (
        <button
          type="button"
          className="zkm-btn-reset ww-send-to__link"
          data-testid="broadcast-retry"
          onClick={() =>
            void getBroadcastLedger()
              .retryNow(address)
              .catch((err: unknown) => console.warn("[broadcasts] could not retry", err))
          }
        >
          Re-broadcast
        </button>
      )}
    </div>
  )
}

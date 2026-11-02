/**
 * Where an address's broadcast stands, for the row that shows it beside the address: built from
 * the ledger's job and the prover's stage events.
 */
import { useSyncExternalStore } from "react"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import {
  WAITING_FOR_BALANCE_MOVE,
  WAITING_FOR_REGISTRATION,
  WAITING_FOR_UNLOCK,
  getBroadcastLedger,
} from "./broadcasts"

export type BroadcastStatus =
  | { kind: "published" }
  /** Owed, behind another broadcast or about to start. */
  | { kind: "waiting" }
  | { kind: "proving"; stage: ProvingStage | null }
  | { kind: "unlock" }
  | { kind: "registration" }
  | { kind: "moving" }
  /** An attempt failed or had to wait; the ledger tries again at its retry time. */
  | { kind: "retrying" }

function statusOf(address: string): BroadcastStatus | undefined {
  const job = getBroadcastLedger().get(address)
  if (!job) return undefined
  if (job.state === "landed") return { kind: "published" }
  if (job.state === "proving" || job.state === "sent") {
    const stage = job.operationId
      ? provingProgress.getCurrentStageSnapshot(job.operationId)?.stage ?? null
      : null
    return { kind: "proving", stage }
  }
  if (job.lastError === WAITING_FOR_UNLOCK) return { kind: "unlock" }
  if (job.lastError === WAITING_FOR_REGISTRATION) return { kind: "registration" }
  if (job.lastError === WAITING_FOR_BALANCE_MOVE) return { kind: "moving" }
  if (job.failures > 0 || (job.retryAt ?? 0) > Date.now()) return { kind: "retrying" }
  return { kind: "waiting" }
}

function subscribe(onChange: () => void): () => void {
  const offLedger = getBroadcastLedger().onListChanged(onChange)
  provingProgress.on("stage-start", onChange)
  return () => {
    offLedger()
    provingProgress.off("stage-start", onChange)
  }
}

/** The address's broadcast status. */
export function useBroadcastStatus(address: string | undefined): BroadcastStatus | undefined {
  const key = useSyncExternalStore(subscribe, () =>
    address ? JSON.stringify(statusOf(address) ?? null) : "null",
  )
  return (JSON.parse(key) as BroadcastStatus | null) ?? undefined
}

const STAGE: Record<ProvingStage, string> = {
  [ProvingStage.Simulating]: "Preparing transaction…",
  [ProvingStage.Witgen]: "Preparing transaction…",
  [ProvingStage.Proving]: "Proving privately…",
  [ProvingStage.Mining]: "Publishing your address…",
}

/** The row's line. Proposed copy, pending review. */
export function broadcastStatusLine(status: BroadcastStatus): string {
  switch (status.kind) {
    case "published":
      return "Address published"
    case "waiting":
      return "Publishing your address shortly"
    case "proving":
      return status.stage ? STAGE[status.stage] : "Publishing your address…"
    case "unlock":
      return "Unlock your wallet to publish this address"
    case "registration":
      return "Publishes once your tag is registered"
    case "moving":
      return "Publishes once your balance has moved"
    case "retrying":
      return "Couldn't publish yet. Trying again soon"
  }
}

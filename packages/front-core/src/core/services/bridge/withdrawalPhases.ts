/** What a withdrawal record's phase means to the screens and the tracker. */

import { TxStatus } from "@aztec-labs/stdlib/tx"
import { swapEscrowTarget } from "./swapEscrowArgs"
import type { WithdrawalPhase, WithdrawalRecord } from "./types"

/**
 * When a post-mine record has sat in its current phase longer than this, the UI
 * flips to the non-terminal `delayed` presentation ("taking longer than usual").
 * Sized well above the deployment's ~40-min proven cadence so a normal wait is
 * never mislabeled; tuned against measured latency in the staging smoke.
 */
export const WITHDRAWAL_DELAYED_THRESHOLD_MS = 60 * 60 * 1000

/**
 * How long a funded escrow may wait for a relayer before the user is offered to run the swap
 * themselves. The relayer drops an operation after its retry budget (ten simulations at 30 s
 * apart), so past this a swap nobody has run is one nobody will.
 */
export const SWAP_STUCK_THRESHOLD_MS = 5 * 60 * 1000

/** Post-mine phases that keep advancing toward `done` (i.e. can be `delayed`). */
const POST_MINE_NONTERMINAL_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "swapping",
])

export function isTerminalPhase(phase: WithdrawalPhase): boolean {
  return phase === "done" || phase === "recovered" || phase === "failed"
}

export function isPostMineNonTerminal(phase: WithdrawalPhase): boolean {
  return POST_MINE_NONTERMINAL_PHASES.has(phase)
}

/** Proven-or-later: Aztec v4 receipts can skip past `proven` straight to `finalized`. */
export function isAtLeastProven(status: TxStatus): boolean {
  return status === TxStatus.PROVEN || status === TxStatus.FINALIZED
}

/**
 * DERIVED, non-terminal `delayed` presentation. True when a post-mine record has
 * sat in its current phase past the threshold. Not a stored phase — the record's
 * `phase` stays `l2_mined`/`awaiting_proven`/`finalizing_l1`; presenters overlay
 * "taking longer than usual" without firing a failure. Pre-mine and terminal
 * records are never delayed.
 */
export function isWithdrawalDelayed(
  record: WithdrawalRecord,
  now: number = Date.now(),
  thresholdMs: number = WITHDRAWAL_DELAYED_THRESHOLD_MS,
): boolean {
  if (!isPostMineNonTerminal(record.phase)) return false
  const enteredAt = record.phaseEnteredAt ?? record.startTime
  return now - enteredAt >= thresholdMs
}

/**
 * Whether the burn is a link escrow's rather than the account's. It carries no recovery data, so
 * only a relayer releases it. A golden-ticket registration burn is the account's own.
 */
export function isEscrowBurn(record: Pick<WithdrawalRecord, "source" | "intent">): boolean {
  return record.source === "paylink" && record.intent !== "registration"
}

/**
 * Whether `record` may be finalized by the user themselves. The portal's `withdraw` is
 * permissionless whatever the prover tip, so the owner can release a proven burn from its recovery
 * events — but only once the L2 side is done (`finalizing_l1`) and only once the wait has been
 * delayed for a while, since a relayer that lands first will make the call revert.
 */
export function canSelfFinalizeWithdrawal(
  record: WithdrawalRecord,
  now: number = Date.now(),
): boolean {
  return (
    !isEscrowBurn(record) &&
    record.phase === "finalizing_l1" &&
    isWithdrawalDelayed(record, now) &&
    // `l2TxHash` exists means the burn is done on the L2 side.
    !!record.l2TxHash &&
    // `finalizeTxHash` exists means one is already in flight.
    !record.finalizeTxHash
  )
}

/**
 * Whether the user may run a swap record's escrow themselves. `deployAndExecute` is permissionless and
 * pays its caller the tip, so once the escrow has waited past `SWAP_STUCK_THRESHOLD_MS` with no
 * relayer the user is the relayer. A record that cannot rebuild its escrow args has nothing to
 * run.
 */
export function canSelfExecuteSwap(
  record: WithdrawalRecord,
  now: number = Date.now(),
  thresholdMs: number = SWAP_STUCK_THRESHOLD_MS,
): boolean {
  return (
    record.phase === "swapping" &&
    swapEscrowTarget(record) !== undefined &&
    // `swapExecuteTxHash` exists means a self-run is already in flight.
    !record.swapExecuteTxHash &&
    isWithdrawalDelayed(record, now, thresholdMs)
  )
}

/** Whether the escrow's DAI can be signed back out: parked `recoverable`, with rebuildable args. */
export function canRecoverSwap(record: WithdrawalRecord): boolean {
  return record.phase === "recoverable" && swapEscrowTarget(record) !== undefined
}

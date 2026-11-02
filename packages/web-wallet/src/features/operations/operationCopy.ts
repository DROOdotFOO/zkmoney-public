import { INTERRUPTED_ERRORS, type OperationFailureCause } from "@obsidion/front-core"
import { claimWindowRevertCopy } from "../paylink/claimWindow"
import type { OperationFlow } from "./operations"

interface FlowCopy {
  /**
   * Row title while it runs, before the summary ("Sending", "$25 to @alice"); also the working
   * beat's label while it runs as a child operation.
   */
  live: string
  /** Settled row title; none where no settled row is due. */
  settled?: string
  failed: string
  /** A transaction button's label while this runs: local proving is single-flight. */
  busy: string
  icon: string
  /** Who reports the ending: the panel off the operation, or the flow's own record's rows. */
  outcome: "operation" | "record"
  /** Row text for a failure the store recorded itself; `null` writes no row. */
  causes: Readonly<Record<OperationFailureCause, string | null>>
  /** Row text for a failure the flow threw: its message stays on the record, never on screen. */
  thrown: string
  /** Row text for a thrown failure the flow can name. */
  describeError?: (error: string) => string | undefined
}

/**
 * `balanceKept`: the amount came out of the balance, so the user needs to hear it is still there.
 * `interrupted` is the activity row's own tab-close text, where the flow writes one.
 */
function failures(balanceKept: boolean, interrupted?: string): Pick<FlowCopy, "causes" | "thrown"> {
  const kept = balanceKept ? " The amount is still in your balance." : ""
  return {
    causes: {
      interrupted: interrupted ?? `The tab closed before it was sent.${kept}`,
      dropped: `The network turned it down.${kept}`,
    },
    thrown: `It didn't go through.${kept}`,
  }
}

export const OPERATION_COPY: Readonly<Record<OperationFlow, FlowCopy>> = {
  "send": {
    live: "Sending",
    settled: "Sent",
    failed: "Send failed",
    busy: "Waiting for your send to finish",
    icon: "arrow.up.right",
    outcome: "operation",
    ...failures(true, INTERRUPTED_ERRORS.send),
  },
  "withdraw": {
    live: "Withdrawing",
    failed: "Withdrawal failed",
    busy: "Waiting for your withdrawal to finish",
    icon: "arrow.up.right",
    outcome: "record",
    ...failures(true),
  },
  "savings": {
    live: "Moving funds",
    failed: "Move failed",
    busy: "Waiting for your move to finish",
    icon: "arrow.up.right",
    outcome: "record",
    ...failures(true),
  },
  "paylink-create": {
    live: "Creating",
    settled: "Paylink created",
    failed: "Paylink failed",
    busy: "Waiting for your new paylink to be created",
    icon: "link",
    outcome: "operation",
    ...failures(true, INTERRUPTED_ERRORS.paylinkCreate),
  },
  "paylink-claim": {
    live: "Receiving",
    settled: "Received",
    failed: "Claim failed",
    busy: "Waiting for your paylink claim to finish",
    icon: "arrow.down.left",
    outcome: "operation",
    ...failures(false, INTERRUPTED_ERRORS.paylinkClaim),
    describeError: (error) => claimWindowRevertCopy(error)?.message,
  },
  "paylink-claim-l1": {
    live: "Withdrawing",
    failed: "Withdrawal failed",
    busy: "Waiting for your withdrawal to finish",
    icon: "arrow.up.right",
    outcome: "record",
    ...failures(false),
  },
  "paylink-reclaim": {
    live: "Recovering",
    settled: "Paylink recovered",
    failed: "Recovery failed",
    busy: "Waiting for your paylink recovery to finish",
    icon: "arrow.uturn.backward",
    outcome: "operation",
    ...failures(false),
  },
  "deposit": {
    live: "Preparing",
    failed: "Deposit address failed",
    busy: "Waiting for your deposit address",
    icon: "arrow.down.left",
    outcome: "operation",
    ...failures(false),
  },
  "request-link": {
    live: "Publishing request link",
    settled: "Request link ready",
    failed: "Request link not published",
    busy: "Waiting for your request link",
    icon: "link",
    outcome: "operation",
    causes: {
      interrupted: "The tab closed before it was sent. Share again for a new link.",
      dropped: "The network turned it down. Share again for a new link.",
    },
    thrown: "It didn't go through. Share again for a new link.",
  },
  "migration": {
    live: "Upgrading",
    failed: "Upgrade failed",
    busy: "Waiting for your upgrade",
    icon: "arrow.up.right",
    outcome: "record",
    ...failures(false),
  },
  // Only saved records carry this flow: a migration's arrival address, published before its burn.
  "migration-arrival": {
    live: "Publishing your new address",
    failed: "Couldn't publish your new address",
    busy: "Waiting for your new address",
    icon: "arrow.down.left",
    outcome: "operation",
    // It runs before the burn: nothing moved, and the move is offered again.
    causes: { interrupted: null, dropped: null },
    thrown: "Nothing moved. You can try again.",
    describeError: () => "Nothing moved. You can try again.",
  },
}

export function flowCopy(flow: string): FlowCopy {
  return OPERATION_COPY[flow as OperationFlow] ?? OPERATION_COPY.send
}

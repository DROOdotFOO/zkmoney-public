import { isHash, type Hex } from "viem"
import { WalletError } from "./errors"
import {
  WITHDRAWAL_RECORD_VERSION,
  WITHDRAWAL_TERMINAL_PHASES,
  type WithdrawalPhase,
  type WithdrawalRecord,
} from "../core/services/bridge/types"

/** What a burn's recovery data says it paid: the executor, and that executor's fee. */
export interface BurnExecutor {
  executor: Hex
  withdrawalFee: bigint
}

/** The fields a `patch` sets; it names the phase the writer means the record to hold. */
export type WithdrawalPatch = Partial<WithdrawalRecord> & Pick<WithdrawalRecord, "phase">

/**
 * What changes a withdrawal record. The flows and the tracker write `patch` and `mined`; the reorg
 * monitor writes `demoted`, `revived` and `burnDropped`; boot writes `interrupted`; the rescan
 * writes `executorMigrated`. A `patch` carries the record's `reorgEpoch` as its writer read it.
 */
export type WithdrawalEvent =
  | { type: "patch"; fields: WithdrawalPatch }
  /** `rawAmount` and `relayerTip` keep the record's own values when absent. */
  | {
      type: "mined"
      l2TxHash: string
      blockNumber: number
      rawAmount?: string
      relayerTip?: string
    }
  /** A reorg: back one phase, or `failed` when the burn dropped. */
  | { type: "demoted"; droppedBurn?: boolean }
  /** A dropped-burn failure whose burn is on chain after all. */
  | { type: "revived" }
  /** When the burn first read as dropped; `undefined` clears it. */
  | { type: "burnDropped"; at: number | undefined }
  /** A pre-mine row the tab closed on before its burn was sent. */
  | { type: "interrupted" }
  /** Stamps the burn's executor (and its fee, where the record names none) on a version 1 record. */
  | { type: "executorMigrated"; burn?: BurnExecutor }

/** Phases reached only by observing the L1 release; nothing local outranks or unwinds them. */
const RELEASED_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "swapping",
  "recoverable",
  "recovered",
  "done",
])

/** What a reorg can still undo: a mined burn not yet released. */
export function isDemotable(phase: WithdrawalPhase): boolean {
  return !RELEASED_PHASES.has(phase) && phase !== "failed" && phase !== "submitting"
}

/** The first terminal entry's time sticks. */
function stampTerminal(record: WithdrawalRecord, now: number): WithdrawalRecord {
  return WITHDRAWAL_TERMINAL_PHASES.has(record.phase) && !record.endTime
    ? { ...record, endTime: now }
    : record
}

/**
 * The one place a withdrawal record changes; `undefined` leaves it as it is.
 * - Once a reorg demoted the record (`reorgEpoch > 0`), a `patch` from another epoch is ignored.
 * - `demoted` refuses a released, failed or pre-mine record; `revived` takes only a dropped-burn
 *   failure; `burnDropped` sets only on a demotable record and never moves a recorded time.
 * - Entering a terminal phase stamps `endTime` once.
 */
export function withdrawalTransition(
  record: WithdrawalRecord,
  event: WithdrawalEvent,
  now: number,
): WithdrawalRecord | undefined {
  const epoch = record.reorgEpoch ?? 0
  switch (event.type) {
    case "patch":
      if (epoch > 0 && (event.fields.reorgEpoch ?? 0) !== epoch) return undefined
      return stampTerminal({ ...record, ...event.fields, localId: record.localId }, now)
    case "mined":
      // A malformed hash would read as "burn not found" in every later lookup.
      if (!isHash(event.l2TxHash))
        throw new WalletError(
          "invariant",
          `withdrawal: l2TxHash is not a 32-byte hex hash (${event.l2TxHash})`,
        )
      return {
        ...record,
        l2TxHash: event.l2TxHash,
        blockNumber: event.blockNumber,
        rawAmount: event.rawAmount ?? record.rawAmount,
        relayerTip: event.relayerTip ?? record.relayerTip,
        phase: "l2_mined",
        minedAt: record.minedAt ?? now,
      }
    case "demoted":
      if (!isDemotable(record.phase)) return undefined
      // `finalizeTxHash` names a release of the burn the reorg invalidated.
      return event.droppedBurn
        ? {
            ...record,
            phase: "failed",
            reorgEpoch: epoch + 1,
            endTime: now,
            droppedBurn: true,
            burnDroppedAt: undefined,
            failure: { code: "withdrawal.reorged" },
            finalizeTxHash: undefined,
          }
        : {
            ...record,
            phase: record.phase === "finalizing_l1" ? "awaiting_proven" : "l2_mined",
            reorgEpoch: epoch + 1,
            endTime: undefined,
            burnDroppedAt: undefined,
            phaseEnteredAt: now,
            finalizeTxHash: undefined,
          }
    case "revived":
      if (record.phase !== "failed" || !record.droppedBurn) return undefined
      return {
        ...record,
        phase: "l2_mined",
        reorgEpoch: epoch + 1,
        phaseEnteredAt: now,
        endTime: undefined,
        failure: undefined,
        droppedBurn: undefined,
        burnDroppedAt: undefined,
      }
    case "burnDropped": {
      const recorded = record.burnDroppedAt !== undefined
      if (event.at === undefined)
        return recorded ? { ...record, burnDroppedAt: undefined } : undefined
      if (recorded || !isDemotable(record.phase)) return undefined
      return { ...record, burnDroppedAt: event.at }
    }
    case "interrupted":
      if (record.phase !== "submitting" || record.l2TxHash) return undefined
      return stampTerminal(
        { ...record, phase: "failed", failure: { code: "withdrawal.interrupted" } },
        now,
      )
    case "executorMigrated": {
      if ((record.version ?? 1) >= WITHDRAWAL_RECORD_VERSION) return undefined
      const { burn } = event
      const unstamped = record.deployment && !record.deployment.executor
      if (unstamped && !burn) return undefined
      return {
        ...record,
        version: WITHDRAWAL_RECORD_VERSION,
        ...(record.deployment && burn
          ? { deployment: { ...record.deployment, executor: burn.executor } }
          : {}),
        ...(burn && !record.withdrawalFee && burn.withdrawalFee > 0n
          ? { withdrawalFee: burn.withdrawalFee.toString() }
          : {}),
      }
    }
  }
}

/**
 * The rules the activity feed and its detail sheets read off one record, with every clock passed
 * in. They name an action, never its words.
 */
import { formatUnits } from "viem"
import { REGISTRATION_SCHEDULE_DEFAULTS } from "@obsidion/core/constants"
import type { ActivityItem, BridgeActivityItem } from "../core/services/bridge/BridgeActivityFeed"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { withdrawalAmounts } from "../core/services/bridge/withdrawalAmounts"
import {
  canRecoverSwap,
  canSelfExecuteSwap,
  canSelfFinalizeWithdrawal,
} from "../core/services/bridge/withdrawalPhases"
import {
  isAwaitingSweep,
  sipaSweepAllowed,
  type SipaProcessingState,
} from "../core/services/deposits/sipaProcessing"
import { isStuckSweep } from "../core/services/deposits/sipaStuck"
import {
  isAccountMoveSipa,
  isUnfundedSipaDeposit,
  type SIPADepositPhase,
  type SIPADepositRecord,
} from "../core/services/deposits/SIPADepositStore"
import type { PendingRegistrationRecord } from "../core/services/registration/PendingRegistrationStore"
import type { SavingsMoveRecord } from "../core/services/savings/types"
import { canSelfRunSkyEscrow } from "../oxide/skyEscrowExit"

/** No sweep can move a `recoverable` deposit, and a `recovered` one went back out on L1. */
export function neverCreditsL2(phase: SIPADepositPhase): boolean {
  return phase === "recoverable" || phase === "recovered"
}

/** Why a record offers the exit: `unsweepable` can never be swept, `stuck` still can. */
export type RecoveryReason = "unsweepable" | "stuck" | "registration-quote" | "stranded"

/**
 * Whether `record` offers the recovery exit, and on which grounds. The note's message secret is
 * half the recovery key, so a record discovered without one cannot sign at all.
 */
export function recoveryReasonFor(
  record: Pick<SIPADepositRecord, "phase" | "messageSecret" | "startTime" | "sweepTxHash">,
  now: number,
): RecoveryReason | null {
  if (!record.messageSecret) return null
  if (record.phase === "recoverable") return "unsweepable"
  return isStuckSweep(record, now) ? "stuck" : null
}

/**
 * Whether the user may sweep a stuck deposit themselves: the CREATE2 address binds the two derived
 * fields, which a record created before discovery may not have yet.
 */
export function canSelfSweep(
  record: Pick<
    SIPADepositRecord,
    "phase" | "startTime" | "sweepTxHash" | "recipientHash" | "recoveryAddress" | "origin"
  >,
  now: number,
): boolean {
  return (
    isStuckSweep(record, now) &&
    !!record.recipientHash &&
    !!(record.recoveryAddress || record.origin)
  )
}

export type RegistrationRef = Pick<
  PendingRegistrationRecord,
  "sipaAddress" | "tag" | "phase" | "sweptAt" | "sweepTxHash" | "fundedAt"
>

/** This wallet's registrations, live and replaced, and its own handle. */
export interface Registrations {
  records: readonly RegistrationRef[]
  handle?: string
}

/** A registration deposit the user can push through by hand: pending, and not already swept. */
export function canManualRegistrationSweep(
  record: Pick<PendingRegistrationRecord, "phase" | "sweptAt" | "sweepTxHash">,
): boolean {
  return (
    (record.phase === "awaiting_deposit" || record.phase === "funded") &&
    record.sweptAt === undefined &&
    record.sweepTxHash === undefined
  )
}

export function registrationFor(
  registrations: Registrations,
  sipaAddress: string,
): RegistrationRef | undefined {
  const needle = sipaAddress.toLowerCase()
  return registrations.records.find((r) => r.sipaAddress.toLowerCase() === needle)
}

/**
 * The tag a registration SIPA registered. One discovered from the note on another device has no
 * record, but its intent says so, and the name it registered is this wallet's own.
 */
export function registrationTagForSipa(
  registrations: Registrations,
  sipaAddress: string,
  deposit?: Pick<SIPADepositRecord, "intent">,
): string | undefined {
  const pending = registrationFor(registrations, sipaAddress)
  if (pending) return pending.tag
  return deposit?.intent === "registration" ? registrations.handle : undefined
}

/**
 * The tag a deposit row wears: none once the deposit went back and the registration waits for
 * payment again, so the returned funds and the registration are two rows.
 */
export function registrationTagForDeposit(
  registrations: Registrations,
  deposit: Pick<SIPADepositRecord, "sipaAddress" | "intent" | "phase">,
): string | undefined {
  const pending = registrationFor(registrations, deposit.sipaAddress)
  const refunded =
    !!pending &&
    deposit.phase === "recovered" &&
    pending.phase === "awaiting_deposit" &&
    pending.fundedAt === undefined
  return refunded ? undefined : registrationTagForSipa(registrations, deposit.sipaAddress, deposit)
}

export interface DepositOffer {
  reason: RecoveryReason | null
  /** The sheet offers the sweep. */
  canSweep: boolean
  /** A sweep could land but for capacity: an open sheet offers it once a read clears that. */
  sweepable: boolean
  waiting: boolean
  action: "sweep" | "recover"
}

export interface DepositContext {
  processing?: SipaProcessingState
  /** The registration behind the address, when it is one of this wallet's. */
  registration?: RegistrationRef
  now: number
}

/**
 * The exit a deposit row offers. A sweep may still land on a stuck deposit, so it stays pending;
 * one no sweep can move is a state of its own. An unfunded address offers neither, nor does a
 * backup passkey's: its sweep can wait far past the stuck clock, so a Recover here could cancel a
 * healthy rotation, and its panel recovers the funding once the flow finds it stranded. A
 * registration-backed deposit follows the registration's own gate on the stuck clock. A confirmed
 * capacity blocker withholds the sweep, never the recovery.
 */
export function depositExitOffer(
  record: SIPADepositRecord,
  { processing, registration, now }: DepositContext,
): DepositOffer | null {
  if (isUnfundedSipaDeposit(record) || isAccountMoveSipa(record)) return null
  const reason = recoveryReasonFor(record, now)
  const sweepable = registration
    ? isStuckSweep(record, now) && canManualRegistrationSweep(registration)
    : canSelfSweep(record, now)
  const canSweep = sweepable && sipaSweepAllowed(processing)
  if (!reason && !canSweep) return null
  const waiting = reason === "stuck" || sweepable
  return { reason, canSweep, sweepable, waiting, action: canSweep ? "sweep" : "recover" }
}

/**
 * The detail sheet's offer: the row's clocked offer, else a manual sweep for funds still at the
 * address with no sweep seen. Opening the detail is the "act now" signal, so the sheet never makes
 * the user wait out the row's stuck clock.
 */
export function depositDetailOffer(
  record: SIPADepositRecord,
  context: DepositContext,
): DepositOffer | null {
  const clocked = depositExitOffer(record, context)
  if (clocked) return clocked
  if (!isAwaitingSweep(record) || isAccountMoveSipa(record)) return null
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) return null
  if (context.registration && !canManualRegistrationSweep(context.registration)) return null
  if (!sipaSweepAllowed(context.processing)) return null
  return { reason: null, canSweep: true, sweepable: true, waiting: true, action: "sweep" }
}

/** Why a swap record offers an exit: `unswappable` can never fill, `stuck` still can. */
export type SwapExitReason = "unswappable" | "stuck"

export function swapExitReasonFor(record: WithdrawalRecord, now: number): SwapExitReason | null {
  if (canRecoverSwap(record)) return "unswappable"
  return canSelfExecuteSwap(record, now) ? "stuck" : null
}

/** The exit a withdrawal offers: finalize a stalled release, else the swap's run or recovery. */
export type WithdrawalExit = { kind: "finalize" } | { kind: "swap"; reason: SwapExitReason }

export function withdrawalExit(record: WithdrawalRecord, now: number): WithdrawalExit | undefined {
  if (canSelfFinalizeWithdrawal(record, now)) return { kind: "finalize" }
  const reason = swapExitReasonFor(record, now)
  return reason ? { kind: "swap", reason } : undefined
}

/** The fee fields a migration's withdrawal record carries, base units as strings. */
export type MigrationFeeFields = Required<
  Pick<WithdrawalRecord, "relayerTip" | "arrivalFee" | "withdrawalFee">
>

export interface MigrationAmounts {
  /** What leaves before it reaches the new balance: the exit's fee, then the arrival's. */
  exitFeeDisplay: string
  arrivalFeeDisplay: string
  /** What the new balance receives, before any subsidy. */
  netAtomic: bigint
  netDisplay: string
}

/** Undefined while any fee is unknown: no figure beats a wrong one. */
export function migrationAmounts(
  record: Pick<WithdrawalRecord, "amount" | "rawAmount" | "proverTip" | "tokenDecimals"> &
    Partial<MigrationFeeFields>,
): MigrationAmounts | undefined {
  if (record.arrivalFee == null) return undefined
  const exit = withdrawalAmounts(record)
  if (!exit.feeKnown) return undefined
  const arrivalFee = BigInt(record.arrivalFee)
  const netAtomic = exit.netAtomic > arrivalFee ? exit.netAtomic - arrivalFee : 0n
  return {
    exitFeeDisplay: exit.feeDisplay,
    arrivalFeeDisplay: formatUnits(arrivalFee, record.tokenDecimals),
    netAtomic,
    netDisplay: formatUnits(netAtomic, record.tokenDecimals),
  }
}

/** A move an old version's record shows unfinished when that version closed. It can't finish here. */
export const isStrandedSavingsMove = (move: SavingsMoveRecord, burn?: WithdrawalRecord) =>
  !!move.retired && burn?.phase !== "failed" && !move.recovered && !move.deposit?.claimed

/** Whether the move has its outcome: claimed, recovered, a burn that failed, or stranded on an old version. */
export const isSavingsMoveSettled = (move: SavingsMoveRecord, burn?: WithdrawalRecord) =>
  !!move.deposit?.claimed ||
  !!move.recovered ||
  burn?.phase === "failed" ||
  isStrandedSavingsMove(move, burn)

/**
 * The exit a stalled move offers: `finalize` when no relayer has sent its release, `run` when the
 * release paid its escrow and nobody has run it since.
 */
export function savingsMoveExitOffer(
  move: SavingsMoveRecord,
  burn: WithdrawalRecord,
  now: number,
): "finalize" | "run" | null {
  if (canSelfFinalizeWithdrawal(burn, now)) return "finalize"
  return canSelfRunSkyEscrow(move, burn, now) ? "run" : null
}

/** What a registration's signed fee charged for the tag itself: the part above the sweep fee. */
export function tagPriceOf(record: { registrationFee?: string }): bigint {
  const fee = BigInt(record.registrationFee ?? 0)
  const sweepFee = REGISTRATION_SCHEDULE_DEFAULTS.earned_tag.fee
  return fee > sweepFee ? fee - sweepFee : 0n
}

/**
 * A deposit is dated by when the person funded it; a withdrawal by its release, the moment that
 * matters to the person.
 */
export function bridgeItemTime(item: BridgeActivityItem): number {
  if (item.kind === "bridge.sipaDeposit") return item.record.startTime
  return item.record.endTime ?? item.record.startTime
}

/**
 * The bridge row a notification asks to open. Its target lowercases the SIPA address; records keep
 * it checksummed. A reorg notice carries only the tx hash: the burn's or the claim's.
 */
export function findBridgeItem(
  items: readonly ActivityItem[],
  target: { openWithdrawalId?: string; openDepositAddress?: string; openTxHash?: string },
): BridgeActivityItem | undefined {
  const { openWithdrawalId } = target
  const deposit = target.openDepositAddress?.toLowerCase()
  const txHash = target.openTxHash?.toLowerCase()
  if (!openWithdrawalId && !deposit && !txHash) return undefined
  return items.find(
    (item): item is BridgeActivityItem =>
      (item.kind === "bridge.withdrawal" &&
        (item.record.localId === openWithdrawalId ||
          (!!txHash && item.record.l2TxHash?.toLowerCase() === txHash))) ||
      (item.kind === "bridge.sipaDeposit" &&
        !item.credit &&
        (item.record.sipaAddress.toLowerCase() === deposit ||
          (!!txHash && item.record.claimTxHash?.toLowerCase() === txHash))),
  )
}

type DepositBridgeItem = Extract<ActivityItem, { kind: "bridge.sipaDeposit" }>

/** The token a deposit row shows: the one it splits out, else the record's own. */
const depositRowToken = (item: { record: SIPADepositRecord; credit?: string }) =>
  (item.credit ?? item.record.rowToken ?? item.record.tokenAddress)?.toLowerCase()

/** A deposit row's detail id: its address, and the token the row shows. */
export function depositDetailId(item: { record: SIPADepositRecord; credit?: string }): string {
  const token = depositRowToken(item)
  return token ? `${item.record.sipaAddress}:${token}` : item.record.sipaAddress
}

/**
 * The row a deposit detail shows: `address:token` picks that token's row, whether it is split out
 * or the address's own by now; an address alone, or a token it no longer shows, picks the address's
 * own row.
 */
export function depositDetailItem(
  items: readonly ActivityItem[],
  id: string,
): DepositBridgeItem | undefined {
  const [address, token] = id.toLowerCase().split(":")
  const rows = items.filter(
    (item): item is DepositBridgeItem =>
      item.kind === "bridge.sipaDeposit" && item.record.sipaAddress.toLowerCase() === address,
  )
  return (
    (token ? rows.find((item) => depositRowToken(item) === token) : undefined) ??
    rows.find((item) => !item.credit)
  )
}

/**
 * The detail a routed bridge row opens: a Savings move's burn its Savings detail, a leg of a fresh
 * withdrawal its group, a deposit its address.
 */
export function bridgeDetailTarget(
  hit: BridgeActivityItem,
): { kind: "savings" | "withdrawal"; id: string } | { kind: "deposit"; address: string } {
  if (hit.kind === "bridge.sipaDeposit") return { kind: "deposit", address: hit.record.sipaAddress }
  if (hit.record.skyMove) return { kind: "savings", id: hit.record.localId }
  return { kind: "withdrawal", id: hit.record.groupId ?? hit.record.localId }
}

/**
 * A legacy fresh-address withdrawal is two burns to one recipient, the ETH gas leg and the funds
 * leg, sharing a `groupId`. The wallet no longer writes groups; every surface that shows a stored
 * pair as one withdrawal (the activity row, the detail sheet, the bell) derives its phase, time and
 * figure here.
 */
import { formatUnits, parseUnits, type Hex } from "viem"
import { decimalPlaces } from "../../../utils/validate"
import { WITHDRAWAL_TERMINAL_PHASES } from "./types"
import type { WithdrawalGroupLeg, WithdrawalPhase, WithdrawalRecord } from "./types"

export interface WithdrawalGroup {
  groupId: Hex
  /** The latest record per leg: a leg sent again after a pre-mine failure replaces its first try. */
  legs: Partial<Record<WithdrawalGroupLeg, WithdrawalRecord>>
  /** Every record of the group, gas first. */
  records: WithdrawalRecord[]
}

const LEGS: readonly WithdrawalGroupLeg[] = ["gas", "funds"]

/** What the group needs from the user first, then the least advanced leg still in flight. */
const PHASE_PRECEDENCE: readonly WithdrawalPhase[] = [
  "failed",
  "recoverable",
  "submitting",
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "swapping",
  "recovered",
  "done",
]

const legRank = (record: WithdrawalRecord): number =>
  record.groupLeg ? LEGS.indexOf(record.groupLeg) : LEGS.length

/** The legs, gas first; the records themselves when none names its leg. */
function legRecords(group: WithdrawalGroup): WithdrawalRecord[] {
  const legs = LEGS.flatMap((leg) => group.legs[leg] ?? [])
  return legs.length ? legs : group.records
}

/**
 * Records that carry a groupId, grouped; groups ordered by their earliest startTime. Ungrouped
 * records are left out.
 */
export function withdrawalGroupsOf(records: readonly WithdrawalRecord[]): WithdrawalGroup[] {
  const byId = new Map<string, WithdrawalGroup>()
  const grouped = records
    .filter((r): r is WithdrawalRecord & { groupId: Hex } => r.groupId !== undefined)
    .sort((a, b) => a.startTime - b.startTime)
  for (const record of grouped) {
    const key = record.groupId.toLowerCase()
    let group = byId.get(key)
    if (!group) {
      group = { groupId: record.groupId, legs: {}, records: [] }
      byId.set(key, group)
    }
    group.records.push(record)
    if (record.groupLeg) group.legs[record.groupLeg] = record
  }
  for (const group of byId.values()) {
    group.records.sort((a, b) => legRank(a) - legRank(b) || a.startTime - b.startTime)
  }
  return [...byId.values()]
}

/** Every present leg is in a terminal phase. No funds leg follows a gas leg any more. */
export function isWithdrawalGroupTerminal(group: WithdrawalGroup): boolean {
  return legRecords(group).every((r) => WITHDRAWAL_TERMINAL_PHASES.has(r.phase))
}

/** Gas legs whose ETH is on its way or landed; a stuck or recovered one gives the address no gas. */
export const GAS_LEG_UNDERWAY: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "swapping",
  "done",
])

/** The gas went out and no funds leg followed: the address has gas and none of the funds. */
export function isFundsLegUnsent(group: WithdrawalGroup): boolean {
  const { gas, funds } = group.legs
  return !!gas && !funds && GAS_LEG_UNDERWAY.has(gas.phase)
}

/**
 * The phase the group shows: failed, then recoverable, then the earliest in-flight phase in machine
 * order, then recovered, then done.
 */
export function worstWithdrawalPhase(group: WithdrawalGroup): WithdrawalPhase {
  const phases = new Set(legRecords(group).map((r) => r.phase))
  return PHASE_PRECEDENCE.find((phase) => phases.has(phase)) ?? "done"
}

/** When every leg has settled, the latest endTime; else the latest startTime. */
export function withdrawalGroupTime(group: WithdrawalGroup): number {
  const legs = legRecords(group)
  const ends = legs.map((r) => r.endTime)
  return ends.every((t): t is number => t !== undefined)
    ? Math.max(...ends)
    : Math.max(...legs.map((r) => r.startTime))
}

/** Sum of the legs' display amounts as a decimal string, added exactly. */
export function withdrawalGroupAmount(group: WithdrawalGroup): string {
  const amounts = legRecords(group).map((r) => r.amount)
  const scale = Math.max(0, ...amounts.map(decimalPlaces))
  const sum = amounts.reduce((total, amount) => total + parseUnits(amount, scale), 0n)
  return formatUnits(sum, scale)
}

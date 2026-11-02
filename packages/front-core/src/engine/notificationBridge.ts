/**
 * The bell's bridge entries, read off the deposit, withdrawal and upgrade records: one live row per
 * record still in flight, and one entry per record's ending. A registration's deposit and its
 * funding burn are the registration's story; an upgrade's deposits are its run's.
 */
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  hiddenBehindOwnWithdrawal,
  type ActivityItem,
  type BridgeActivityItem,
} from "../core/services/bridge/BridgeActivityFeed"
import type { WithdrawalPhase, WithdrawalRecord } from "../core/services/bridge/types"
import {
  isWithdrawalGroupTerminal,
  withdrawalGroupAmount,
  withdrawalGroupsOf,
  withdrawalGroupTime,
  worstWithdrawalPhase,
  type WithdrawalGroup,
} from "../core/services/bridge/withdrawalGroups"
import { upgradeBatchArrived } from "../core/migration/upgradeActivity"
import { chainUpgradeBatches } from "../core/migration/chainUpgradeBatches"
import { sipaCredits } from "../core/services/deposits/sipaCredits"
import { upgradeRunsOf, type UpgradeRun } from "../core/migration/upgradeRuns"
import {
  sipaReasonShown,
  type SipaProcessingKind,
  type SipaProcessingState,
} from "../core/services/deposits/sipaProcessing"
import {
  isAccountMoveSipa,
  isUnfundedSipaDeposit,
  type SIPADepositPhase,
  type SIPADepositRecord,
  type SIPASweep,
} from "../core/services/deposits/SIPADepositStore"
import type { UpgradeBatchItem } from "../core/migration/upgradeActivity"
import type { Loaded } from "./recordSource"

/** Withdrawal phases a live row reports. */
export const LIVE_WITHDRAWAL_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "swapping",
])

/** Deposit phases a live row reports, once funds were sent to the address. */
export const LIVE_DEPOSIT_PHASES: ReadonlySet<SIPADepositPhase> = new Set<SIPADepositPhase>([
  "funding",
  "funded",
  "broadcast",
  "sweeping",
  "pendingClaim",
])

/** Phases a rebuilt withdrawal sits in until the tracker has seen its L1 release. */
const UNRELEASED: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
])

export type BridgeTarget =
  | { type: "bridge.txDetail"; bridgeKind: "deposit"; sourceId: string }
  | { type: "bridge.txDetail"; bridgeKind: "withdrawal"; sourceId: string; l2TxHash?: string }

export type BridgeAbout =
  | {
      kind: "bridgeLive"
      item: BridgeActivityItem
      migration: boolean
      /** A deposit's stated reason for waiting on its sweep. */
      reason?: SipaProcessingKind
    }
  | {
      kind: "bridgeEnded"
      item: BridgeActivityItem
      outcome: "done" | "failed"
      migration: boolean
    }
  | { kind: "upgradeRun"; run: UpgradeRun; done: boolean }

export interface BridgeEntry {
  id: string
  about: BridgeAbout
  timestampMs: number
  severity: "info" | "success" | "error"
  icon: string
  pending: boolean
  target: BridgeTarget | { type: "upgrade.run"; run: string }
  settledAt?: number
  seenWith?: string
}

export interface BridgeSources {
  deposits: Loaded<SIPADepositRecord>
  withdrawals: Loaded<WithdrawalRecord>
  /** `recipients`: every deposit address a run of this device pays. */
  upgrades: {
    items: readonly UpgradeBatchItem[]
    recipients: ReadonlySet<string>
    loaded: boolean
  }
  processing: ReadonlyMap<string, SipaProcessingState>
}

const DONE = { icon: "checkmark.circle.fill", severity: "success" } as const
const FAILED = { icon: "exclamationmark.triangle.fill", severity: "error" } as const

/**
 * The records as the bridge feed lists them: a deposit funded by its own burn is the burn's, each
 * other token an address credited is a deposit of its own, and an upgrade's direct deposits no run
 * of this device covers are that upgrade's batches once its runs are read.
 */
function activityItems(sources: BridgeSources, now: number): ActivityItem[] {
  const withdrawals = sources.withdrawals.records
  const { upgrades } = sources
  const chainBatches = upgrades.loaded
    ? chainUpgradeBatches(sources.deposits.records, upgrades.recipients)
    : []
  return [
    ...sources.deposits.records
      .filter((record) => !hiddenBehindOwnWithdrawal(record, withdrawals, now))
      .flatMap((stored) =>
        sipaCredits(stored).map(({ record, token }): ActivityItem => {
          if (token) return { kind: "bridge.sipaDeposit", record, credit: token }
          const processing = sources.processing.get(record.sipaAddress.toLowerCase())
          return processing
            ? { kind: "bridge.sipaDeposit", record, processing }
            : { kind: "bridge.sipaDeposit", record }
        }),
      ),
    ...withdrawals.map<ActivityItem>((record) => ({ kind: "bridge.withdrawal", record })),
    ...[...upgrades.items, ...chainBatches].map<ActivityItem>((batch) => ({
      kind: "upgrade.batch",
      batch,
    })),
  ]
}

function terminalPhase(item: BridgeActivityItem): "done" | "failed" | null {
  const { phase } = item.record
  if (item.kind === "bridge.withdrawal") {
    // `delayed` and `recoverable` stay quiet: their funds are safe and the row says so.
    if (phase === "recovered") return "done"
    return phase === "done" || phase === "failed" ? phase : null
  }
  if (phase === "claimed" || phase === "recovered") return "done"
  return phase === "failed" ? "failed" : null
}

/**
 * Whether the record has a live row: a withdrawal's burn before it mines is the front's own
 * operation, and a rebuilt one is not live until the tracker sees its release.
 */
function liveOf(item: BridgeActivityItem, now: number): { reason?: SipaProcessingKind } | null {
  if (item.kind === "bridge.sipaDeposit") {
    if (sipaReasonShown(item.processing, item.record, now))
      return { reason: item.processing.reason.kind }
    const { phase } = item.record
    return !isUnfundedSipaDeposit(item.record) && LIVE_DEPOSIT_PHASES.has(phase) ? {} : null
  }
  if (item.record.rebuilt && UNRELEASED.has(item.record.phase)) return null
  return LIVE_WITHDRAWAL_PHASES.has(item.record.phase) ? {} : null
}

/** A group as one withdrawal on its lead leg (the failed one, else funds, else gas). */
function groupAsItem(group: WithdrawalGroup): BridgeActivityItem {
  const legs = [group.legs.gas, group.legs.funds].filter((r): r is WithdrawalRecord => !!r)
  const over = (records: WithdrawalRecord[]): WithdrawalGroup => ({ ...group, legs: {}, records })
  const terminal = isWithdrawalGroupTerminal(group)
  const failed = terminal ? legs.find((r) => r.phase === "failed") : undefined
  const lead = failed ?? group.legs.funds ?? group.legs.gas ?? group.records[0]
  const live = legs.filter((r) => LIVE_WITHDRAWAL_PHASES.has(r.phase))
  const shown = terminal ? group : over(live)
  const phase = terminal || live.length ? worstWithdrawalPhase(shown) : "submitting"
  // Only what was recovered came back; a leg that paid out is not returned.
  const amount = withdrawalGroupAmount(
    phase === "recovered" ? over(legs.filter((r) => r.phase === "recovered")) : group,
  )
  const startTime = Math.min(...group.records.map((r) => r.startTime))
  const endTime = terminal ? withdrawalGroupTime(group) : undefined
  return { kind: "bridge.withdrawal", record: { ...lead, phase, amount, startTime, endTime } }
}

const withdrawalKey = (record: WithdrawalRecord) =>
  record.groupId
    ? `withdrawal-group:${record.groupId.toLowerCase()}`
    : `withdrawal:${record.localId.toLowerCase()}`

export function bridgeLiveId(item: BridgeActivityItem): string {
  return item.kind === "bridge.withdrawal"
    ? `bridge:${withdrawalKey(item.record)}:inflight`
    : `bridge:sipaDeposit:${item.record.sipaAddress.toLowerCase()}:inflight`
}

/**
 * One claim of a re-used address, from its sweep ledger. A sweep credits its row's token, the
 * wallet token where it names none, never ETH; the record's own token may name a later funding.
 */
function claimOf(record: SIPADepositRecord, sweep: SIPASweep): BridgeActivityItem {
  return {
    kind: "bridge.sipaDeposit",
    record: {
      ...record,
      phase: "claimed",
      tokenAddress: sweep.tokenAddress,
      tokenSymbol: sweep.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
      tokenDecimals: sweep.tokenDecimals,
      rowToken: undefined,
      inboxIndex: sweep.inboxIndex,
      sweepTxHash: sweep.sweepTxHash,
      netAmount: sweep.netAmount,
      fee: undefined,
      registrationFee: undefined,
      fundingTokenSymbol: sweep.fundingTokenSymbol,
      endTime: sweep.settledAt ?? record.startTime,
    },
  }
}

const tokenKey = (token: string | undefined) => token?.toLowerCase() ?? ""

/**
 * Every ending a record reports: a deposit address paid more than once ends once per claim, so an
 * earlier claim keeps its entry when the address is paid again. Another token's claims are that
 * token's own deposit's.
 */
function endings(item: BridgeActivityItem): BridgeActivityItem[] {
  if (item.kind !== "bridge.sipaDeposit") return [item]
  const { record } = item
  const own = tokenKey(record.rowToken ?? record.tokenAddress)
  const current = record.phase === "claimed" ? record.inboxIndex : undefined
  const earlier = (record.sweeps ?? []).filter(
    (sweep) =>
      sweep.inboxIndex !== current &&
      (!sweep.tokenAddress || !own || tokenKey(sweep.tokenAddress) === own),
  )
  return [...earlier.map((sweep) => claimOf(record, sweep)), item]
}

/** A grouped leg sent again is a new record, so its failure reports anew; a re-used SIPA per claim. */
function endedId(item: BridgeActivityItem, outcome: "done" | "failed"): string {
  if (item.kind === "bridge.withdrawal") {
    const { record } = item
    const leg = record.groupId && outcome === "failed" ? `:${record.localId.toLowerCase()}` : ""
    return `bridge:${withdrawalKey(record)}:${outcome}${leg}`
  }
  const { record } = item
  return `bridge:sipaDeposit:${record.sipaAddress.toLowerCase()}:${
    record.inboxIndex ?? ""
  }:${outcome}`
}

function targetOf(item: BridgeActivityItem): BridgeTarget {
  return item.kind === "bridge.withdrawal"
    ? {
        type: "bridge.txDetail",
        bridgeKind: "withdrawal",
        sourceId: item.record.localId,
        l2TxHash: item.record.l2TxHash,
      }
    : {
        type: "bridge.txDetail",
        bridgeKind: "deposit",
        sourceId: item.record.sipaAddress.toLowerCase(),
      }
}

/** A migration's exit and the deposit it pays are one move; a SIPA the account pays itself arrives on its own. */
function migrationMatcher(items: BridgeActivityItem[], upgradeArrivals: ReadonlySet<string>) {
  const arrivals = new Set([
    ...items.flatMap((i) =>
      i.kind === "bridge.withdrawal" && i.record.intent === "migration"
        ? [i.record.recipient.toLowerCase()]
        : [],
    ),
    ...upgradeArrivals,
  ])
  return (item: BridgeActivityItem) =>
    item.kind === "bridge.withdrawal"
      ? item.record.intent === "migration"
      : isAccountMoveSipa(item.record) || arrivals.has(item.record.sipaAddress.toLowerCase())
}

export function bridgeEntries(sources: BridgeSources, now: number): BridgeEntry[] {
  const items = activityItems(sources, now)
  const all = items.filter(
    (i): i is BridgeActivityItem =>
      i.kind === "bridge.sipaDeposit" || i.kind === "bridge.withdrawal",
  )
  const withdrawals = all.flatMap((i) => (i.kind === "bridge.withdrawal" ? [i.record] : []))
  // Each fresh-address group stands in for its legs. A backup passkey rotation's deposit address
  // and the burn that funds it are followed by the settings panel that drives them.
  const bridge = all
    .filter(
      (i) =>
        i.record.intent !== "registration" &&
        !(i.kind === "bridge.withdrawal" && i.record.groupId) &&
        !(i.kind === "bridge.withdrawal" && i.record.intent === "backup") &&
        !(i.kind === "bridge.sipaDeposit" && i.record.intent === "user-op"),
    )
    .concat(withdrawalGroupsOf(withdrawals).map(groupAsItem))
  const runs = upgradeRunsOf(items)
  const runArrivals = new Set(
    runs.flatMap((run) => run.legs.map((leg) => leg.batch.recipient.toLowerCase())),
  )
  const ofRun = (item: BridgeActivityItem) =>
    item.kind === "bridge.sipaDeposit" && runArrivals.has(item.record.sipaAddress.toLowerCase())
  const isMigration = migrationMatcher(bridge, runArrivals)
  const out: BridgeEntry[] = []

  for (const item of bridge) {
    if (ofRun(item)) continue
    const live = liveOf(item, now)
    if (!live) continue
    out.push({
      id: bridgeLiveId(item),
      about: { kind: "bridgeLive", item, migration: isMigration(item), ...live },
      timestampMs: item.record.startTime,
      severity: "info",
      icon: item.kind === "bridge.withdrawal" ? "arrow.up.right" : "arrow.down.left",
      pending: true,
      target: targetOf(item),
    })
  }
  // The upgrade is complete only once no run is still to arrive or approved and unsent.
  const upgrading =
    runs.some((run) => !run.settled) ||
    items.some((i) => i.kind === "upgrade.batch" && i.batch.state === "planned" && i.batch.approved)
  for (const run of runs) {
    const live = `migration-run:${run.run}`
    const target = { type: "upgrade.run", run: run.run } as const
    if (!run.settled)
      out.push({
        id: live,
        about: { kind: "upgradeRun", run, done: false },
        timestampMs: Math.min(...run.legs.map((leg) => leg.batch.startTime)),
        severity: "info",
        icon: "arrow.down.left",
        pending: true,
        target,
      })
    if (!run.complete || upgrading) continue
    // Funds that reach the old version later join the run: its larger whole reports anew. An
    // inferred run's legs join as discovery finds them, so it keeps one report.
    const count = run.inferred ? "" : `:${run.legs.length}`
    const at = Math.max(...run.legs.map((leg) => leg.arrival?.endTime ?? 0))
    out.push({
      id: `${live}:done${count}`,
      about: { kind: "upgradeRun", run, done: true },
      timestampMs: at,
      ...DONE,
      pending: false,
      target,
      settledAt: at,
      // A run seen in flight reports its ending, whenever its deposit's claim is dated. An
      // inferred run reads as pending while discovery claims its history, so only time counts.
      ...(run.inferred ? {} : { seenWith: live }),
    })
  }
  for (const item of bridge.flatMap(endings)) {
    const outcome = terminalPhase(item)
    const endTime = item.record.endTime
    if (!outcome || endTime == null) continue
    if (outcome === "done" && ofRun(item) && upgradeBatchArrived(item.record as SIPADepositRecord))
      continue
    const migration = isMigration(item)
    // A migration's exit is half of one move; its arrival reports the move.
    if (migration && item.kind === "bridge.withdrawal" && outcome === "done") continue
    // A reorg that drops the burn reports whenever it is seen: nothing else tells the user.
    const dropped = item.kind === "bridge.withdrawal" && item.record.droppedBurn
    out.push({
      id: endedId(item, outcome),
      about: { kind: "bridgeEnded", item, outcome, migration },
      timestampMs: endTime,
      ...(outcome === "done" ? DONE : FAILED),
      pending: false,
      target: targetOf(item),
      ...(dropped ? {} : { settledAt: endTime }),
    })
  }
  return out
}

/**
 * Failure entries whose withdrawal is no longer failed, or was replaced by a later try of its leg:
 * forgotten, so a later failure reports anew.
 */
export function recoveredWithdrawalIds(withdrawals: Loaded<WithdrawalRecord>): string[] {
  if (!withdrawals.hydrated) return []
  const replaced = new Set(
    withdrawalGroupsOf(withdrawals.records).flatMap((group) =>
      group.records
        .filter((r) => r.groupLeg && group.legs[r.groupLeg]?.localId !== r.localId)
        .map((r) => r.localId),
    ),
  )
  return withdrawals.records.flatMap((record) => {
    // A group that names no leg keys its failed entry by its first record, failed or not.
    if (record.groupId && !record.groupLeg) return []
    if (record.phase === "failed" && !replaced.has(record.localId)) return []
    return [endedId({ kind: "bridge.withdrawal", record }, "failed")]
  })
}

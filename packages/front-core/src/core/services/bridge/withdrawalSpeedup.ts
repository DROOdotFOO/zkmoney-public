/**
 * How much a prover tip speeds up a withdrawal. A burn is finalizable on L1 once the proven checkpoint covers it.
 * Without a tip that is the full proof of its epoch N; a tip buys a partial proof of N's prefix up to the burn. The
 * prover proves checkpoints as they land, so a partial proof follows the burn's checkpoint by a latency that does
 * not grow with the prefix. Every proof of N builds on the proven tip, so it cannot land before epoch N−1 is
 * proven:
 *
 *   standard ≈ epochEnd(N) + fullProof
 *   tipped   ≈ max(landedAt + partialProof, provenAt(N−1))
 *
 * Epoch end is the start of the next epoch throughout. Both ETAs count from the burn's landing: the L2 confirmation
 * ahead of it is the device's proving, not the chain's wait.
 */

import { CheckpointNumber, EpochNumber } from "@aztec-labs/foundation/branded-types"
import { RollupAbi } from "@aztec-foundation/l1-artifacts/RollupAbi"
import {
  getEpochAtSlot,
  getSlotAtTimestamp,
  getSlotRangeForEpoch,
  getStartTimestampForEpoch,
  type L1RollupConstants,
} from "@aztec-labs/stdlib/epoch-helpers"
import { MAX_RPC_CHECKPOINTS_DATA_LEN } from "@aztec-labs/stdlib/interfaces/api-limit"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { Address, PublicClient } from "viem"

import { logger } from "../../../utils/logger"

export type SpeedupRollupConstants = Pick<
  L1RollupConstants,
  "l1GenesisTime" | "slotDuration" | "epochDuration"
>

/** Proof latencies in seconds. */
export interface ProofLatency {
  /** Epoch end → full epoch proof on L1. */
  fullProofSeconds: number
  /** The burn's checkpoint landing → the partial proof covering it on L1, once the epoch before is proven. */
  partialProofSeconds: number
}

/** `measured` when both latencies come from recent L1 proofs. */
export type SpeedupConfidence = "measured" | "fallback"

export interface ProofCalibration extends ProofLatency {
  confidence: SpeedupConfidence
}

/**
 * The last 1-based checkpoint index in an epoch a tip is offered for. A partial proof proves the epoch's prefix from
 * its first checkpoint, so a later burn is covered by the full epoch proof first and its tip buys nothing.
 */
export const LAST_TIPPED_CHECKPOINT_INDEX = 25

export const DEFAULT_PROOF_LATENCY: ProofLatency = {
  fullProofSeconds: 900,
  partialProofSeconds: 180,
}

/** When the burn's checkpoint lands on L1, in seconds from now. */
export interface BurnLanding {
  expected: number
  earliest: number
  latest: number
}

export interface WithdrawalSpeedupInput {
  constants: SpeedupRollupConstants
  /** Unix seconds. */
  now: number
  landing: BurnLanding
  /**
   * Unix seconds the epoch before the expected landing's was proven at (any time ≤ now works);
   * undefined while unproven.
   */
  predecessorProvenAt?: number
  calibration: ProofCalibration
}

export interface WithdrawalSpeedupEstimate {
  /** The burn's epoch. */
  epoch: EpochNumber
  /** The burn's 1-based checkpoint index in its epoch: how many checkpoints its partial proof covers, which prices the tip. */
  checkpointIndex: number
  /** Seconds from the burn's landing until it is finalizable without a tip. */
  standardEtaSeconds: number
  /** Seconds from the burn's landing until it is finalizable with a tip. */
  tippedEtaSeconds: number
  speedupSeconds: number
  /**
   * The smallest speedup anywhere in the landing window. A tip is fixed before proving starts, so
   * this is what it buys for certain: a window reaching an epoch's end buys nothing.
   */
  worstSpeedupSeconds: number
  confidence: SpeedupConfidence
  /** The landing window reaches past {@link LAST_TIPPED_CHECKPOINT_INDEX}: no tip should be offered. */
  pastTipCutoff: boolean
}

function epochEnd(epoch: number, constants: SpeedupRollupConstants): number {
  return Number(getStartTimestampForEpoch(EpochNumber(epoch + 1), constants))
}

/** The epoch a checkpoint landing at `landsAt` belongs to, and its 1-based slot index in that epoch. */
export function burnPosition(
  constants: SpeedupRollupConstants,
  landsAt: number,
): { epoch: EpochNumber; checkpointIndex: number } {
  const slot = getSlotAtTimestamp(BigInt(Math.floor(landsAt)), constants)
  const epoch = getEpochAtSlot(slot, constants)
  const [firstSlot] = getSlotRangeForEpoch(epoch, constants)
  return { epoch, checkpointIndex: slot - firstSlot + 1 }
}

function estimateAt(input: WithdrawalSpeedupInput, landsAt: number) {
  const { constants, now, calibration } = input
  const { epoch, checkpointIndex } = burnPosition(constants, landsAt)
  const expectedEpoch = burnPosition(constants, now + Math.max(0, input.landing.expected)).epoch
  const predecessorProvenAt =
    (epoch === expectedEpoch ? input.predecessorProvenAt : undefined) ??
    Math.max(now, epochEnd(epoch - 1, constants) + calibration.fullProofSeconds)
  const standard = Math.max(
    epochEnd(epoch, constants) + calibration.fullProofSeconds,
    predecessorProvenAt,
  )
  const partial = landsAt + calibration.partialProofSeconds
  const tipped = Math.min(standard, Math.max(partial, predecessorProvenAt))
  return { epoch, checkpointIndex, standard, tipped }
}

export function estimateWithdrawalSpeedup(
  input: WithdrawalSpeedupInput,
): WithdrawalSpeedupEstimate {
  const { constants, now, landing } = input
  const earliest = now + Math.max(0, Math.min(landing.earliest, landing.expected))
  const latest = now + Math.max(landing.latest, landing.expected, 0)
  const landsAt = now + Math.max(0, landing.expected)
  const { epoch, checkpointIndex, standard, tipped } = estimateAt(input, landsAt)
  // Within an epoch the speedup only shrinks as the landing moves later, so its minimum over the
  // window sits at the window's end or just before an epoch boundary inside it.
  const ends = [latest]
  for (let e = burnPosition(constants, earliest).epoch; epochEnd(e, constants) <= latest; e++) {
    ends.push(epochEnd(e, constants) - 1)
  }
  const worstSpeedupSeconds = Math.min(
    ...ends.map((at) => {
      const point = estimateAt(input, at)
      return point.standard - point.tipped
    }),
  )
  return {
    epoch,
    checkpointIndex,
    standardEtaSeconds: standard - landsAt,
    tippedEtaSeconds: tipped - landsAt,
    speedupSeconds: standard - tipped,
    worstSpeedupSeconds,
    confidence: input.calibration.confidence,
    pastTipCutoff: ends.some(
      (at) => burnPosition(constants, at).checkpointIndex > LAST_TIPPED_CHECKPOINT_INDEX,
    ),
  }
}

export type WithdrawalSpeedupNode = Pick<
  AztecNode,
  "getL1Constants" | "getL1ContractAddresses" | "getCheckpointNumber" | "getCheckpointsData"
>

export interface WithdrawalSpeedupEstimatorOptions {
  /** Latencies used where recent L1 proofs give too few samples. */
  fallback?: ProofLatency
  /** How many epochs of L1 history calibration reads. */
  calibrationEpochs?: number
  /** Samples a latency needs before it counts as measured. */
  minSamples?: number
  cacheTtlSeconds?: number
  /** Unix seconds; paces the calibration cache. */
  now?: () => number
}

const MAX_CALIBRATION_BLOCKS = 10_000n

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Estimates the tip speedup from node RPC and the rollup's `L2ProofVerified` logs. Latencies are calibrated from
 * recent proofs: a proof ending on its epoch's last checkpoint samples the full latency (from epoch end); one ending
 * mid-epoch samples the partial latency (from the later of the checkpoint landing and the predecessor epoch's proof).
 */
export class WithdrawalSpeedupEstimator {
  private readonly fallback: ProofLatency
  private readonly calibrationEpochs: number
  private readonly minSamples: number
  private readonly cacheTtlSeconds: number
  private readonly now: () => number
  private constants?: Promise<L1RollupConstants>
  private cached?: { at: number; value: ProofCalibration }
  private inflight?: Promise<ProofCalibration>

  constructor(
    private readonly deps: { node: WithdrawalSpeedupNode; publicClient: PublicClient },
    options: WithdrawalSpeedupEstimatorOptions = {},
  ) {
    this.fallback = options.fallback ?? DEFAULT_PROOF_LATENCY
    this.calibrationEpochs = options.calibrationEpochs ?? 6
    this.minSamples = options.minSamples ?? 3
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 300
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  async estimate(landing: BurnLanding): Promise<WithdrawalSpeedupEstimate> {
    // The chain's clock, not the device's: epochs are laid out on L1 time.
    const [constants, head] = await Promise.all([
      this.l1Constants(),
      this.deps.publicClient.getBlock({ blockTag: "latest" }),
    ])
    const now = Number(head.timestamp)
    const { epoch } = burnPosition(constants, now + Math.max(0, landing.expected))
    const [predecessorProven, calibration] = await Promise.all([
      this.isProvenBefore(epoch, constants, now),
      this.calibrate(),
    ])
    return estimateWithdrawalSpeedup({
      constants,
      now,
      landing,
      predecessorProvenAt: predecessorProven ? now : undefined,
      calibration,
    })
  }

  /** Cached calibration; a failed read yields the fallback and is not cached. */
  calibrate(): Promise<ProofCalibration> {
    if (this.cached && this.now() - this.cached.at < this.cacheTtlSeconds)
      return Promise.resolve(this.cached.value)
    this.inflight ??= this.measure()
      .then(
        (value) => {
          this.cached = { at: this.now(), value }
          return value
        },
        (err) => {
          logger.warn(
            "[WithdrawalSpeedupEstimator] calibration failed, using fallback latencies",
            err,
          )
          return { ...this.fallback, confidence: "fallback" as const }
        },
      )
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  private l1Constants(): Promise<L1RollupConstants> {
    this.constants ??= this.deps.node.getL1Constants().catch((err) => {
      this.constants = undefined
      throw err
    })
    return this.constants
  }

  /** Whether every checkpoint before `epoch` is proven. */
  private async isProvenBefore(
    epoch: number,
    constants: L1RollupConstants,
    now: number,
  ): Promise<boolean> {
    const proven = await this.deps.node.getCheckpointNumber("proven")
    const [next] = await this.deps.node.getCheckpointsData({
      from: CheckpointNumber(proven + 1),
      limit: 1,
    })
    if (next) return getEpochAtSlot(next.header.slotNumber, constants) >= epoch
    return now >= epochEnd(epoch - 1, constants)
  }

  private async measure(): Promise<ProofCalibration> {
    const { node, publicClient } = this.deps
    const constants = await this.l1Constants()
    const { rollupAddress } = await node.getL1ContractAddresses()
    const head = await publicClient.getBlockNumber()
    const epochBlocks = BigInt(
      Math.ceil(
        (constants.epochDuration * constants.slotDuration) / constants.ethereumSlotDuration,
      ),
    )
    const span = epochBlocks * BigInt(this.calibrationEpochs)
    const window = span < MAX_CALIBRATION_BLOCKS ? span : MAX_CALIBRATION_BLOCKS
    const fromBlock =
      head - window > constants.l1StartBlock ? head - window : constants.l1StartBlock
    const logs = await publicClient.getContractEvents({
      address: rollupAddress.toString() as Address,
      abi: RollupAbi,
      eventName: "L2ProofVerified",
      fromBlock,
      toBlock: head,
    })
    const proofs = logs.flatMap((log) =>
      log.args.checkpointNumber === undefined || log.blockNumber === null
        ? []
        : [{ checkpoint: Number(log.args.checkpointNumber), block: log.blockNumber }],
    )
    if (proofs.length === 0) return this.fromSamples([], [])

    const provenAt = new Map<bigint, number>()
    await Promise.all(
      [...new Set(proofs.map((p) => p.block))].map(async (blockNumber) => {
        provenAt.set(blockNumber, Number((await publicClient.getBlock({ blockNumber })).timestamp))
      }),
    )
    const first = Math.min(...proofs.map((p) => p.checkpoint))
    const last = Math.max(...proofs.map((p) => p.checkpoint))
    // One read holds a bounded span; keep the most recent proofs when the window is wider.
    const from = Math.max(first, last + 2 - MAX_RPC_CHECKPOINTS_DATA_LEN)
    const checkpoints = await node.getCheckpointsData({
      from: CheckpointNumber(from),
      limit: last - from + 2,
    })
    const byNumber = new Map(checkpoints.map((c) => [Number(c.checkpointNumber), c]))

    const full: number[] = []
    const partial: number[] = []
    let predecessor: { epoch: number; provenAt: number } | undefined
    for (const proof of proofs) {
      const checkpoint = byNumber.get(proof.checkpoint)
      const at = provenAt.get(proof.block)
      if (!checkpoint || at === undefined) {
        predecessor = undefined
        continue
      }
      const epoch = getEpochAtSlot(checkpoint.header.slotNumber, constants)
      const end = epochEnd(epoch, constants)
      const next = byNumber.get(proof.checkpoint + 1)
      const isFull = next ? getEpochAtSlot(next.header.slotNumber, constants) > epoch : at >= end
      if (isFull) {
        if (at > end) full.push(at - end)
      } else if (predecessor) {
        // A partial proof waits on the proof before it, so it is only measured when that one was read.
        const gate = predecessor.epoch < epoch ? predecessor.provenAt : 0
        const latency = at - Math.max(Number(checkpoint.l1.timestamp), gate)
        if (latency > 0) partial.push(latency)
      }
      predecessor = { epoch, provenAt: at }
    }
    return this.fromSamples(full, partial)
  }

  private fromSamples(full: number[], partial: number[]): ProofCalibration {
    const measuredFull = full.length >= this.minSamples ? median(full) : undefined
    const measuredPartial = partial.length >= this.minSamples ? median(partial) : undefined
    return {
      fullProofSeconds: measuredFull ?? this.fallback.fullProofSeconds,
      partialProofSeconds: measuredPartial ?? this.fallback.partialProofSeconds,
      confidence:
        measuredFull !== undefined && measuredPartial !== undefined ? "measured" : "fallback",
    }
  }
}

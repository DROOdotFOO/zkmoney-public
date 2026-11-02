/**
 * The withdrawal tracker: drives a withdrawal record through its phases by WATCHING chain, not by
 * talking to a relayer. oxide's relayer finalizes L2→L1 withdrawals headlessly (no status
 * endpoint), so the client only observes:
 *
 *   submitting → l2_mined → awaiting_proven → finalizing_l1 → done
 *
 * A swap-on-withdraw has one more leg: the release funds a counterfactual escrow and a relayer
 * runs the swap. The relayer is headless here too (it drops an operation whose `deployAndExecute` keeps
 * reverting and says nothing), so the tracker watches the escrow through the injected
 * `SwapEscrowReader`:
 *
 *   finalizing_l1 → swapping → done            (escrow emptied by the swap)
 *                 → swapping → recoverable       (funded, and `deployAndExecute` reverts: the route cannot deliver)
 *                            → recovered         (the user's recoverERC20 emptied it: the escrow's recovery log)
 *
 * The flow (`runBurn`) writes the pre-mine `submitting` row, submits the burn, marks it mined and
 * wakes the tracker. Each pass reads chain for every record past submit:
 *   - lazily derive + stamp the `withdrawalId` (needs the burn's tx effect,
 *     which lags mining by a moment — a missing effect is retryable, never a
 *     failure),
 *   - poll `node.getTxReceipt` until the burn is proven-or-later (`isAtLeastProven`),
 *   - poll the injected `WithdrawalFinalizationReader.isSpent(withdrawalId)` — the
 *     authoritative L1 release signal — then best-effort resolve the L1 tx hash for
 *     the explorer link,
 *   - on a swap record, poll the escrow's DAI balance and code, and simulate `deployAndExecute`
 *     while it stays funded.
 *
 * `failed` is reachable from a pre-mine local error (owned by the flow),
 * from a rejected/reverted paylink submission verified by its receipt,
 * or from a reorg-dropped burn (a `demoted` event
 * with `droppedBurn`, owned by the reorg layer). A post-mine stall (relayer not running, dry subsidy reserve,
 * gas spike) surfaces as the derived, non-terminal `delayed` presentation (see
 * `isWithdrawalDelayed`) — never a false failure notification. Every phase
 * patch here carries the record's `reorgEpoch`, so a demote racing a pass
 * fences the pass's stale write.
 *
 * Layering: `node.getTxReceipt` and `fetchWithdrawalIds` are node RPC (fine
 * in front-core); the L1 CONTRACT read comes only through the injected
 * `WithdrawalFinalizationReader` (sdk layer), so front-core originates no contract
 * call. RPC reads fail loud (logged) and retry next pass; the authoritative
 * `isSpent` path never silently stalls.
 */

import { TxHash } from "@aztec-labs/stdlib/tx"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  fetchWithdrawalIds,
  type ObsidionWallet,
  type SwapEscrowReader,
  type WithdrawalFinalizationReader,
} from "@obsidion/sdk"
import type { Hex } from "viem"
import { swapEscrowTarget } from "../core/services/bridge/swapEscrowArgs"
import { withdrawalRecipients } from "../core/services/bridge/withdrawalRecipients"
import type {
  WithdrawalDeployment,
  WithdrawalPhase,
  WithdrawalRecord,
} from "../core/services/bridge/types"
import {
  isAtLeastProven,
  isPostMineNonTerminal,
  isTerminalPhase,
} from "../core/services/bridge/withdrawalPhases"
import { isFailedSubmission, trackSubmission } from "../core/services/transactions/trackSubmission"
import { logger } from "../utils/logger"
import { makeLimiter } from "../utils/makeLimiter"
import type { Write } from "./database"
import { bestEffort, WalletError } from "./errors"
import type { Resource } from "./resource"
import { task, within, type Task } from "./runtime"
import type { Withdrawals } from "./withdrawals"
import type { WithdrawalPatch } from "./withdrawalTransition"

/** Records a live in-process submission owns, so the tracker stands off until it releases. */
const liveSubmissions = new Set<string>()

/**
 * {@link trackSubmission} over a withdrawal record. `stamp` is the burn's `onTxHash`: it saves the
 * hash onto the record, strictly, so a stamp that did not persist sends nothing. A rejection is
 * answered with the record whenever the burn may still land, so a lost connection never fails a
 * withdrawal that is already on chain. `announce: false` for a record riding another's tx.
 */
export function trackWithdrawalSubmission(
  store: Withdrawals,
  localId: string,
  operationId: string,
  opts: { announce?: boolean } = {},
) {
  liveSubmissions.add(localId)
  const submission = trackSubmission(operationId, opts)
  const stampIn = async (txHash: string, w?: Write): Promise<void> => {
    if (!(await store.get(localId, w)))
      throw new WalletError("invariant", `withdrawal: no record ${localId} to stamp`)
    await store.apply(
      localId,
      { type: "patch", fields: { phase: "submitting", l2TxHash: txHash as Hex } },
      w,
    )
  }
  return {
    /** The hash emitted at the submit boundary; undefined until then. */
    get txHash() {
      return submission.txHash
    },
    stamp: (txHash: string) => stampIn(txHash),
    /** The stamp inside the caller's transaction. */
    stampIn,
    /** The record while the burn may still land, else null. */
    async recover(node: Pick<AztecNode, "getTxReceipt">) {
      if (!(await submission.survived(node))) return null
      return (await store.get(localId)) ?? null
    },
    stop() {
      submission.stop()
      liveSubmissions.delete(localId)
    },
  }
}

/**
 * The withdrawal whose burn a node still holds, named by its refusal of a later burn of the same
 * notes. Its record can read `failed`: a node answered its receipt as dropped while another kept
 * it. Such a record goes back to `submitting` for the tracker. Null when no withdrawal sent it.
 */
export async function revivePendingWithdrawal(
  store: Withdrawals,
  txHash: string,
): Promise<WithdrawalRecord | null> {
  await store.ready
  const record = await store.byHash(txHash)
  if (!record || record.phase !== "failed") return record ?? null
  const revived = await store.apply(record.localId, {
    type: "patch",
    fields: {
      phase: "submitting",
      failure: undefined,
      endTime: undefined,
      droppedBurn: undefined,
      burnDroppedAt: undefined,
      // The tracker derives these again from the burn's receipt, which moves it on to mined.
      withdrawalId: undefined,
      blockNumber: undefined,
      reorgEpoch: record.reorgEpoch,
    },
  })
  return revived ?? record
}

/** A record the tracker steps. A pre-mine record without a hash is the flow's. */
const tracked = (record: WithdrawalRecord) => !isTerminalPhase(record.phase) && !!record.l2TxHash

/** Records stepped at once. A restored device settles its whole history, each with several L1 reads. */
const STEP_CONCURRENCY = 4

/**
 * Structural view of the Aztec node the tracker needs: receipts, and the burn's tx effect for the
 * `withdrawalId` derivation.
 */
export type WithdrawalTrackerNode = AztecNode

/** The L1 readers the manifest's withdrawal rails give the tracker. */
export interface TrackerRails {
  finalizationReader: WithdrawalFinalizationReader
  /**
   * The live deployment: its L1 portal, and its L2 token, whose burn DA attests the withdrawal
   * message hashes `withdrawalId` derives from.
   */
  deployment: WithdrawalDeployment
  /** Reader for a record stamped with another deployment (a retired portal). */
  readerForDeployment?: (deployment: WithdrawalDeployment) => WithdrawalFinalizationReader
  /**
   * Escrow reads for swap records. Without one a swap record settles `done` at the release, the
   * way a direct withdrawal does, and the swap leg goes unwatched.
   */
  swapEscrowReader?: SwapEscrowReader
  /** The first L1 block at or after a time (ms). The release search starts at the burn's, not the
   *  reader's default look-back, which misses an older release. */
  l1BlockAt?: (ms: number) => Promise<bigint | undefined>
}

export interface TrackerWiring extends TrackerRails {
  node: WithdrawalTrackerNode
  /** A burn's withdrawal ids; `fetchWithdrawalIds` unless given. */
  withdrawalIds?: typeof fetchWithdrawalIds
}

/**
 * `endTime` for a record rebuilt from chain that settles on this device. Its settlement was never
 * observed, so the burn time dates it; the wall clock would date it at discovery. Undefined for a
 * live record, whose settlement the store stamps as it happens.
 */
function rebuiltSettledAt(record: WithdrawalRecord): number | undefined {
  return record.rebuilt ? record.startTime : undefined
}

/**
 * One pass over every record past submit, 4 at a time. Each step is isolated so one record's RPC
 * error (logged loud) doesn't abort the others; the failing record stays non-terminal and retries
 * next pass.
 */
export function withdrawalStepper(
  store: Withdrawals,
  wiring: TrackerWiring,
  now: () => number = Date.now,
): () => Promise<void> {
  const {
    node,
    finalizationReader,
    deployment,
    readerForDeployment,
    swapEscrowReader,
    l1BlockAt,
    withdrawalIds = fetchWithdrawalIds,
  } = wiring
  /** Per-portal readers built from `readerForDeployment`. */
  const deploymentReaders = new Map<string, WithdrawalFinalizationReader>()

  /** `fields` on the record, or the record as it stands when the transition refused them. */
  const patch = async (keyOrHash: string, fields: WithdrawalPatch): Promise<WithdrawalRecord> => {
    const record =
      (await store.apply(keyOrHash, { type: "patch", fields })) ?? (await store.get(keyOrHash))
    if (!record) throw new WalletError("invariant", `withdrawal: no record for ${keyOrHash}`)
    return record
  }

  const advancePhase = (record: WithdrawalRecord, phase: WithdrawalPhase) =>
    patch(record.l2TxHash!, { phase, phaseEnteredAt: now(), reorgEpoch: record.reorgEpoch })

  /** A post-mine record's delayed timer starts at its first pass, not its `startTime`. */
  const backfillPhaseEnteredAt = async (record: WithdrawalRecord): Promise<void> => {
    if (!isPostMineNonTerminal(record.phase)) return
    if (record.phaseEnteredAt !== undefined) return
    if (!record.l2TxHash) return
    await patch(record.l2TxHash, {
      phase: record.phase,
      phaseEnteredAt: now(),
      reorgEpoch: record.reorgEpoch,
    })
  }

  /** Reader + L2 token for the deployment `record` burned on; the live pair when unstamped. */
  const bindingsFor = (record: WithdrawalRecord) => {
    const stamped = record.deployment
    if (
      !stamped ||
      !readerForDeployment ||
      stamped.portal.toLowerCase() === deployment.portal.toLowerCase()
    ) {
      return { reader: finalizationReader, l2Token: deployment.l2Token }
    }
    const key = stamped.portal.toLowerCase()
    let reader = deploymentReaders.get(key)
    if (!reader) {
      reader = readerForDeployment(stamped)
      deploymentReaders.set(key, reader)
    }
    return { reader, l2Token: stamped.l2Token }
  }

  /**
   * Advance one record as far as chain allows. Deriving `withdrawalId` gates the
   * rest of the step: until the burn's tx effect is indexed we cannot bind the
   * finalization poll, and the tx is far too fresh to be proven anyway, so
   * deferring the whole step is harmless and keeps the record cleanly parked at
   * its phase.
   */
  const step = async (mutableRecord: WithdrawalRecord): Promise<void> => {
    let record = mutableRecord
    const l2TxHash = record.l2TxHash!
    const txHash = TxHash.fromString(l2TxHash)
    const { reader, l2Token } = bindingsFor(record)

    if (record.phase === "submitting") {
      // Mining publishes the hash before sendTx; don't race the live submission.
      if (liveSubmissions.has(record.localId)) return
      const receipt = await node.getTxReceipt(txHash)
      if (isFailedSubmission(receipt)) {
        await patch(record.localId, {
          phase: "failed",
          failure: {
            code: "withdrawal.dropped",
            ...(receipt.error ? { detail: receipt.error } : {}),
          },
        })
        return
      }
    }

    if (!record.withdrawalId) {
      let derivedId: Hex | undefined
      try {
        const [withdrawal] = await withdrawalIds(
          node,
          txHash,
          AztecAddress.fromStringUnsafe(l2Token),
        )
        derivedId = withdrawal?.withdrawalId.toString() as Hex | undefined
        // The sender may have lost its receipt after broadcast. Only an indexed burn and
        // its receipt can advance that durable submitting record to mined.
        if (withdrawal && record.phase === "submitting") {
          const receipt = await node.getTxReceipt(txHash)
          if (receipt.blockNumber === undefined) return
          const mined = await store.apply(record.localId, {
            type: "mined",
            l2TxHash,
            blockNumber: receipt.blockNumber,
          })
          record = mined ?? record
        }
      } catch (err) {
        // Burn effect not yet indexed (or transient RPC) — retryable. Surface
        // it, then defer the rest of the step to the next pass.
        logger.warn(`[withdrawalTracker] withdrawalId derivation deferred for ${l2TxHash}:`, err)
        return
      }
      if (!derivedId) return // no withdrawal log yet — defer
      record = await patch(l2TxHash, {
        phase: record.phase,
        withdrawalId: derivedId,
        reorgEpoch: record.reorgEpoch,
      })
    }

    if (record.phase === "l2_mined" || record.phase === "awaiting_proven") {
      const receipt = await node.getTxReceipt(txHash)
      if (!isAtLeastProven(receipt.status)) {
        if (record.phase === "l2_mined") await advancePhase(record, "awaiting_proven")
        return
      }
      // A burn proven long ago is likely released too, so read L1 in this step.
      record = await advancePhase(record, "finalizing_l1")
    }

    if (record.phase === "finalizing_l1") {
      const withdrawalId = record.withdrawalId!
      const spent = await reader.isSpent(withdrawalId)
      if (!spent) return
      // Best-effort explorer link — never blocks `done`, omitted when ambiguous. The search starts
      // at the burn's time, unless a rebuild stamped its own clock there: a release before that
      // would be missed, so the reader's own look-back stands.
      const fromBlock =
        record.startTimeEstimated || !l1BlockAt
          ? undefined
          : await bestEffort("unknown", l1BlockAt(record.startTime))
      const l1TxHash = await bestEffort(
        "unknown",
        fromBlock === undefined
          ? reader.resolveL1TxHash(withdrawalId)
          : reader.resolveL1TxHash(withdrawalId, { fromBlock }),
      )
      const phase = withdrawalRecipients(record).viaEscrow && swapEscrowReader ? "swapping" : "done"
      const received =
        phase === "done" && l1TxHash
          ? await reader.receivedIn?.(l1TxHash, record.recipient)
          : undefined
      const endTime =
        phase === "done"
          ? (l1TxHash && (await reader.l1TxTimestampMs?.(l1TxHash))) || rebuiltSettledAt(record)
          : undefined
      const released = await patch(l2TxHash, {
        phase,
        phaseEnteredAt: now(),
        l1TxHash,
        ...(endTime === undefined ? {} : { endTime }),
        ...(received === undefined ? {} : { receivedAmount: received.toString() }),
        failure: undefined,
        reorgEpoch: record.reorgEpoch,
      })
      if (released.phase === "swapping") await stepSwap(released)
      return
    }

    if (record.phase === "swapping" || record.phase === "recoverable") {
      await stepSwap(record)
    }
  }

  /**
   * The escrow leg of a swap record. The escrow's DAI is the ground truth: gone from a deployed
   * escrow means the swap ran or the user's recovery did, and the logs tell the two apart; still
   * there means nobody has run it, and a `deployAndExecute` simulation says whether anybody can.
   */
  const stepSwap = async (record: WithdrawalRecord): Promise<void> => {
    const reader = swapEscrowReader
    const target = swapEscrowTarget(record)
    if (!reader || !record.swapEscrow) return
    const l2TxHash = record.l2TxHash!
    const [balance, deployed] = await Promise.all([
      reader.daiBalance(record.swapEscrow),
      reader.isDeployed(record.swapEscrow),
    ])

    if (balance === 0n) {
      if (!deployed) return // release not indexed yet, or balance read raced it — defer
      // A failed log read throws and the step retries: read as "no log" it would misreport.
      const factory = target?.factory ?? record.swapEscrowFactory
      const [executed, recovered] = await Promise.all([
        factory ? reader.executedTxHash(factory, record.swapEscrow) : undefined,
        reader.recoveredTxHash(record.swapEscrow),
      ])
      if (recovered && !executed) {
        await patch(l2TxHash, {
          phase: "recovered",
          recoveryTxHash: recovered.txHash,
          recoveryTarget: recovered.target,
          reorgEpoch: record.reorgEpoch,
        })
        return
      }
      await patch(l2TxHash, {
        phase: "done",
        swapExecuteTxHash: executed ?? record.swapExecuteTxHash,
        endTime: rebuiltSettledAt(record),
        reorgEpoch: record.reorgEpoch,
      })
      return
    }

    // Funded. Without rebuildable args nothing can be simulated: the record waits on a relayer.
    if (!target) return
    const fillable = await reader.deploySimulates(target.factory, target)
    if (!fillable && record.phase === "swapping") {
      await advancePhase(record, "recoverable")
    } else if (fillable && record.phase === "recoverable") {
      // The route can fill again (the pool price moved back): let a relayer or the user run it.
      await advancePhase(record, "swapping")
    }
  }

  return async () => {
    await store.ready
    const limit = makeLimiter(STEP_CONCURRENCY)
    await Promise.all(
      store.list
        .get()
        .records.filter(tracked)
        .map((record) =>
          limit(async () => {
            await backfillPhaseEnteredAt(record)
            await step(record)
          }).catch((err) => {
            // Fail loud, stay non-terminal, retry next pass. A mined burn is
            // never failed by a transient read error.
            logger.warn(`[withdrawalTracker] step failed for ${record.l2TxHash}:`, err)
          }),
        ),
    )
  }
}

export interface WithdrawalTrackerDeps {
  wallet: Resource<Pick<ObsidionWallet, "node">>
  store: Withdrawals
  /** The manifest's withdrawal rails; null where it has none. */
  rails(): Promise<TrackerRails | null>
  now?: () => number
}

/**
 * Steps the session's withdrawals every 20 s, and every minute while hidden: a burn already on L2
 * keeps advancing with nobody watching.
 */
export function withdrawalTracker({ wallet, store, rails, now }: WithdrawalTrackerDeps): Task {
  let built:
    | { rails: TrackerRails; node: WithdrawalTrackerNode; pass: () => Promise<void> }
    | undefined
  return task("withdrawalTracker", {
    needs: { wallet },
    every: 20_000,
    whenHidden: 60_000,
    backoff: { baseMs: 20_000, maxMs: 300_000 },
    async run({ wallet, signal }) {
      await within(store.ready, "withdrawals", { signal })
      // The rails read the manifest and build L1 clients: only for a record to step.
      if (!store.list.get().records.some(tracked)) return
      const wired = await within(rails(), "withdrawal rails", { signal })
      if (!wired) return
      if (built?.rails !== wired || built.node !== wallet.node) {
        const pass = withdrawalStepper(store, { ...wired, node: wallet.node }, now)
        built = { rails: wired, node: wallet.node, pass }
      }
      await within(built.pass(), "withdrawal pass", { signal })
    },
  })
}

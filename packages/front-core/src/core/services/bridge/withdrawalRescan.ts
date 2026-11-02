/**
 * Rebuild the withdrawal records a store lost from the account's own recovery events. Every burn
 * the account made delivered its finalization data to it, which names the executor and the L1
 * address the burn pays, the amount and the relayer tip, and a swap's or a Sky move's memo also
 * carries the escrow args, so a fresh device gets its history back — and with it a stuck escrow's
 * exits — from chain alone.
 * Records the store already holds (by burn tx hash) keep their state, and one written before
 * executor stamps gets its burn's executor; the rest are created at `l2_mined` for the tracker to
 * walk forward like any mined burn. Pure over injected collaborators.
 */

import { formatUnits, type Hash, type Hex } from "viem"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import type { ScannedWithdrawEvent, WithdrawEventSource } from "@obsidion/sdk"
import { syncCatchUp } from "../../../engine/catchUp"
import { newWithdrawalLocalId, type Withdrawals } from "../../../engine/withdrawals"
import type { OnNetwork } from "../../../types/networkStamp"
import type { WithdrawalDeployment, WithdrawalRecord } from "./types"

export interface WithdrawalRescanDeps {
  source: WithdrawEventSource
  store: Pick<Withdrawals, "ready" | "byHash" | "adopt" | "migrateExecutors">
  tokenSymbol: string
  tokenDecimals: number
  /** The network the events were read on. */
  networkId: string
  /** The events' deployment, stamped on each rebuilt record with its burn's executor. */
  deployment?: Omit<WithdrawalDeployment, "executor">
  /** First block to scan. Default 1, the lowest PXE accepts. */
  fromBlock?: number
  /** Stands in for a burn whose block time cannot be read. Defaults to Date.now. */
  now?: () => number
  /** Told what the scan found, for the console of a device whose history is being rebuilt. */
  report?: (summary: WithdrawalRescanSummary) => void
}

export interface WithdrawalRescanSummary {
  tokenSymbol: string
  /** Withdrawals the account's PXE recovers for the token. */
  events: number
  /** Events no stored record covers. */
  unknown: number
  created: WithdrawalRecord[]
  /** Created records that fund a Savings move. */
  savingsMoves: number
}

/** The records created, oldest burn first. */
export async function rebuildWithdrawals(deps: WithdrawalRescanDeps): Promise<WithdrawalRecord[]> {
  await deps.store.ready
  const head = await deps.source.headBlock()
  const events = await deps.source.listWithdrawals(deps.fromBlock ?? 1, head + 1)
  const byTxHash = new Map(events.map((event) => [event.txHash.toLowerCase(), event]))
  await deps.store.migrateExecutors((record) => {
    const event = record.l2TxHash && byTxHash.get(record.l2TxHash.toLowerCase())
    return event
      ? { executor: event.executor as Hex, withdrawalFee: event.withdrawalFee }
      : undefined
  })
  const held = await Promise.all(events.map((event) => deps.store.byHash(event.txHash)))
  const missing = events
    .filter((_, i) => !held[i])
    .sort((a, b) => a.blockNumber - b.blockNumber)
  // Rebuilt rows join an in-progress chain catch-up so they land behind the activity skeleton.
  const end =
    missing.length && syncCatchUp.status.get() ? syncCatchUp.begin() : undefined
  const created: WithdrawalRecord[] = []
  try {
    for (const event of missing) {
      const blockTime = await deps.source.blockTimestampMs(event.blockNumber)
      const startTime = blockTime ?? (deps.now ?? Date.now)()
      const rebuilt = rebuiltRecord(event, startTime, deps, blockTime === undefined)
      // A record the flow saved meanwhile holds the hash and wins.
      const { record, adopted } = await deps.store.adopt(rebuilt)
      if (adopted) created.push(record)
    }
  } finally {
    end?.()
  }
  deps.report?.({
    tokenSymbol: deps.tokenSymbol,
    events: events.length,
    unknown: missing.length,
    created,
    savingsMoves: created.filter((record) => record.skyMove).length,
  })
  return created
}

function rebuiltRecord(
  event: ScannedWithdrawEvent,
  startTime: number,
  deps: WithdrawalRescanDeps,
  startTimeEstimated: boolean,
): OnNetwork<WithdrawalRecord> {
  const { swap, sky } = event
  return {
    localId: newWithdrawalLocalId(),
    networkId: deps.networkId,
    l2TxHash: event.txHash as Hash,
    blockNumber: event.blockNumber,
    recipient: swap?.recipient ?? event.l1Recipient,
    recipientProvenance: "saved-recipient",
    amount: formatUnits(event.amount, deps.tokenDecimals),
    rawAmount: event.amount.toString(),
    relayerTip: event.relayerTip.toString(),
    ...(event.withdrawalFee > 0n ? { withdrawalFee: event.withdrawalFee.toString() } : {}),
    ...(event.proverTip > 0n ? { proverTip: event.proverTip.toString() } : {}),
    tokenSymbol: deps.tokenSymbol,
    tokenDecimals: deps.tokenDecimals,
    phase: "l2_mined",
    startTime,
    ...(deps.deployment
      ? { deployment: { ...deps.deployment, executor: event.executor as Hex } }
      : {}),
    rebuilt: true,
    ...(startTimeEstimated ? { startTimeEstimated: true } : {}),
    ...(swap
      ? {
          swapOutput: swap.output,
          swapEscrow: event.l1Recipient,
          swapEscrowFactory: swap.factory,
          swapEscrowLayout: "v2",
          swapNonce: swap.nonce,
          swapRecoveryCommitment: swap.recoveryCommitment,
          swapRelayerTip: swap.relayerTip.toString(),
          ...(swap.daiForGas > 0n ? { swapDaiForGas: swap.daiForGas.toString() } : {}),
          ...(swap.minEthForGas > 0n ? { swapMinEthForGas: swap.minEthForGas.toString() } : {}),
        }
      : {}),
    ...(sky
      ? {
          skyMove: {
            direction: sky.route === SkyRoute.Stake ? "in" : "out",
            factory: sky.factory,
            recipientCommitment: sky.recipientCommitment,
            recoveryCommitment: sky.recoveryCommitment,
            relayerTip: sky.relayerTip.toString(),
            nonce: sky.nonce,
          },
        }
      : {}),
  }
}

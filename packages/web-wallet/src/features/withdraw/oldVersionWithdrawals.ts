/**
 * The record of each "Withdraw to Ethereum" run from old versions. Activity and the bell show it,
 * pending until the old portals ran every refund or L2 dropped its broadcast. A closed tab resumes
 * the check in the wallet runtime.
 */
import { OxidePortalAbi } from "@oxide/l1-contracts"
import type { Address, Hex } from "viem"
import {
  OldVersionWithdrawalStorage,
  SWAP_STUCK_THRESHOLD_MS,
  type BroadcastTxState,
  type OldVersionWithdrawal,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { noteRefundedSavingsMoves } from "../savings/savingsMoveStore"

let store: OldVersionWithdrawalStorage | undefined

export function getOldVersionWithdrawalStore(): OldVersionWithdrawalStorage {
  return (store ??= new OldVersionWithdrawalStorage(webStorage))
}

/** What a withdrawal sends, net of tips, in 18-decimal USD: every refund L2 did not drop. */
export const withdrawalSent = (record: OldVersionWithdrawal) =>
  record.refunds.reduce((sum, refund) => (refund.dropped ? sum : sum + BigInt(refund.usd)), 0n)

/** The refund ids a sent, unfinished withdrawal holds, which no new refund may take. */
export const pendingRefundIds = (records: readonly OldVersionWithdrawal[]) =>
  new Set(
    records.flatMap((r) =>
      r.refunds.filter((f) => !f.l1TxHash && !f.dropped).flatMap((f) => f.ids),
    ),
  )

// The record a zk.money run in this tab is still sending.
let producing: string | undefined

export function setProducingOldVersionWithdrawal(id: string | undefined) {
  producing = id
}

/**
 * The refund the user may send themselves: the first one no relayer ran within the wait a swap gets
 * before Run swap manually. A refund needs no L2 network proof, so its relayer runs it once its
 * broadcast lands.
 */
export function oldVersionRefundOffer(record: OldVersionWithdrawal, now = Date.now()) {
  if (record.phase !== "sending" || record.id === producing) return undefined
  return record.refunds.find(
    (r) =>
      !r.l1TxHash && !r.dropped && now - (r.sentAt ?? record.startTime) >= SWAP_STUCK_THRESHOLD_MS,
  )
}

const LOG_RANGE = 10_000n

/** The portal's L1 transaction that ran a refund of `ids`, from `fromBlock` on. */
async function refundTx(portal: Address, ids: string[], fromBlock: bigint) {
  const client = l1PublicClient(getConfig())
  const head = await client.getBlockNumber()
  for (let start = fromBlock; start <= head; start += LOG_RANGE) {
    const end = start + LOG_RANGE - 1n < head ? start + LOG_RANGE - 1n : head
    const logs = await client.getContractEvents({
      address: portal,
      abi: OxidePortalAbi,
      eventName: "WithdrawalOrRefund",
      args: { nullifier: ids as Hex[] },
      fromBlock: start,
      toBlock: end,
    })
    const hash = logs[0]?.transactionHash
    if (hash) return hash
  }
  return undefined
}

/**
 * Reads which refunds of `id` ran on L1, and with `l2State` which broadcasts L2 dropped, and saves
 * them into the latest copy of the record. Resolves to the record as saved.
 */
export async function settleOldVersionWithdrawal(
  id: string,
  l2State?: (txHash: string) => Promise<BroadcastTxState>,
) {
  const records = getOldVersionWithdrawalStore()
  await records.load()
  const record = records.get(id)
  if (!record || record.phase !== "sending") return record
  const checked = new Map<
    string,
    Pick<OldVersionWithdrawal["refunds"][number], "l1TxHash" | "dropped">
  >()
  await Promise.all(
    record.refunds.map(async (refund) => {
      if (refund.l1TxHash || refund.dropped) return
      const l1TxHash = await refundTx(
        refund.portal as Address,
        refund.ids,
        BigInt(record.fromBlock),
      )
      if (l1TxHash) {
        checked.set(refund.l2TxHash, { l1TxHash })
        await noteRefundedSavingsMoves(refund.deposits ?? [], record.to as Address, l1TxHash)
      } else if ((await l2State?.(refund.l2TxHash)) === "dropped")
        checked.set(refund.l2TxHash, { dropped: true })
    }),
  )
  const next = await records.update(id, (latest) =>
    withPhase({
      ...latest,
      // A refund saved as run since the read stays run.
      refunds: latest.refunds.map((refund) =>
        refund.l1TxHash ? refund : { ...refund, ...checked.get(refund.l2TxHash) },
      ),
    }),
  )
  return next
}

function withPhase(record: OldVersionWithdrawal): OldVersionWithdrawal {
  const { refunds } = record
  const open = !record.allSent || refunds.some((refund) => !refund.l1TxHash && !refund.dropped)
  return {
    ...record,
    phase: open ? "sending" : refunds.some((refund) => refund.l1TxHash) ? "done" : "failed",
  }
}

/**
 * Saves the refund the user sent themselves as run, whatever L2 made of its broadcast. No run sends
 * the record anymore, since the offer skips one that does, so no refund joins it after this.
 */
export async function noteSelfRefunded(
  id: string,
  refund: OldVersionWithdrawal["refunds"][number],
  l1TxHash: Hex,
) {
  const records = getOldVersionWithdrawalStore()
  await records.load()
  const to = records.get(id)?.to as Address | undefined
  if (to) await noteRefundedSavingsMoves(refund.deposits ?? [], to, l1TxHash)
  const next = await records.update(id, (latest) =>
    withPhase({
      ...latest,
      allSent: true,
      refunds: latest.refunds.map((r) =>
        r.l2TxHash === refund.l2TxHash ? { ...r, l1TxHash, dropped: undefined } : r,
      ),
    }),
  )
  return next
}

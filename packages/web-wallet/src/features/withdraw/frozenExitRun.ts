/**
 * The exit from a deployment whose portal is frozen: refund every source fund to the user's own L1
 * account, one capped batch per transaction, each sent from that account. Nothing is broadcast on L2
 * and no relayer takes part, so the refund carries no tip.
 */
import {
  nextFrozenSelfRefund,
  type FrozenMigrationRuntime,
  type RefundedDeposit,
} from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import type { L1ExitChannel } from "../deposit/sipaRecovery"
import { noteRefundedSavingsMoves } from "../savings/savingsMoveStore"

export type FrozenExitRuntime = Pick<FrozenMigrationRuntime, "candidates" | "build">

export type FrozenExitRead = Awaited<ReturnType<FrozenExitRuntime["candidates"]>>

/** What the frozen portal refunds now, the part of it in payment links, and what waits. */
export function frozenExitSummary({ candidates, waiting, maxBatchAmount }: FrozenExitRead) {
  let refundable = 0n
  let links = 0n
  // A note above the portal's cap fits no refund.
  let overCap = 0n
  for (const c of candidates) {
    if (BigInt(c.amount) > maxBatchAmount) overCap += BigInt(c.amount)
    else {
      refundable += BigInt(c.amount)
      if (c.kind === "escrow-note") links += BigInt(c.amount)
    }
  }
  return { refundable, links, waiting: (waiting ?? 0n) + overCap }
}

export interface FrozenExitProgress {
  /** Refunded so far in this run. */
  refunded: bigint
  hashes: Hex[]
}

export type FrozenExitSent = { refunded: bigint; hashes: Hex[] }
export type FrozenExitDone = FrozenExitSent & { left: bigint; to: Address }

export interface FrozenSourceFunds {
  /** Refundable now, in the portal's token units. */
  refundable: bigint
  /** The part of `refundable` held in payment links. */
  links: bigint
  /** Not refundable yet. */
  waiting: bigint
}

export interface FrozenFunds {
  main: FrozenSourceFunds
  /** Absent where Savings is not frozen. */
  savings?: FrozenSourceFunds
  /** The Savings scan failed; Main's still stands. */
  savingsFailed?: boolean
  /** What this browser's open payment links hold, which Main's `links` should match. */
  openLinks: bigint
}

// Outlives the screen: a second run would resend the first one's unconfirmed batch.
let running = false
// A sent refund whose receipt never came. The next run waits for it, so it never sends it twice.
let pending: { hash: Hex; deposits: RefundedDeposit[]; to: Address } | undefined

/**
 * Refunds batches until none is left. A batch that reverts or comes back after its own refund
 * stops the run. Resolves to what moved and what is left behind.
 */
export async function runFrozenExit(
  runtime: FrozenExitRuntime,
  channel: L1ExitChannel,
  onBatch?: (progress: FrozenExitProgress) => void,
) {
  if (running) throw new Error("A withdrawal is already running. Wait for it to finish.")
  running = true
  try {
    if (pending) {
      const { hash, deposits, to } = pending
      if (await channel.waitForReceipt(hash)) await noteRefundedSavingsMoves(deposits, to, hash)
      pending = undefined
    }
    return await refundAll(runtime, channel, onBatch)
  } finally {
    running = false
  }
}

async function refundAll(
  runtime: FrozenExitRuntime,
  channel: L1ExitChannel,
  onBatch?: (progress: FrozenExitProgress) => void,
) {
  const progress: FrozenExitProgress = { refunded: 0n, hashes: [] }
  const sent = new Set<string>()
  for (let fresh = true; ; fresh = false) {
    const next = await nextFrozenSelfRefund(runtime, channel.target, { fresh })
    if (!next.refund) return { ...progress, stranded: next.remaining, waiting: next.waiting }
    const { ids, amount, to, data } = next.refund
    if (ids.some((id) => sent.has(id)))
      throw new Error("A refund already sent is still unconfirmed. Wait a minute and try again.")
    const hash = await channel.sendTransaction(to, data)
    pending = { hash, deposits: next.refund.deposits, to: channel.target }
    const ok = await channel.waitForReceipt(hash)
    pending = undefined
    if (!ok) throw new Error(`Refund transaction ${hash} reverted, so nothing moved. Try again.`)
    await noteRefundedSavingsMoves(next.refund.deposits, channel.target, hash)
    ids.forEach((id) => sent.add(id))
    progress.refunded += amount
    progress.hashes.push(hash)
    onBatch?.({ ...progress, hashes: [...progress.hashes] })
  }
}

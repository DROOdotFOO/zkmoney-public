/**
 * One L1 observation of every tracked SIPA, whatever its flavor: the portal deposits its sweeps made,
 * what left it and what funded it, and what it holds now. A fixed number of requests per window,
 * however many SIPAs. See docs/bridge/sipa-pipeline.md.
 */

import type { Address, Hex, PublicClient } from "viem"
import {
  readPortalDeposits,
  readSipaBalancesMany,
  readSweepEmitters,
  readTokenTransfers,
  type PortalDeposit,
  type TokenTransfer,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"

/** One SIPA address to observe. */
export interface SipaSubject {
  address: Address
  /** What its sweeps deposit to: the record's `recipientHash`. */
  commitment: Hex
  /** The first block to read for it. */
  fromBlock: bigint
  /** Whether to read what funded it. */
  inflows: boolean
  /**
   * A direct deposit's record, not a SIPA: `address` holds nothing on L1, and its commitment alone
   * names its deposits.
   */
  direct?: boolean
}

/** A sweep of one SIPA, with its claim inputs. */
export interface ObservedSweep {
  /** The portal whose `Deposit` the sweep made: it names the row the sweep settled on. */
  portal: Address
  index: bigint
  /** The amount credited on L2. */
  amount: bigint
  /** The L1→L2 message hash. */
  messageKey: Hex
  blockNumber: bigint
  blockHash: Hex
  txHash: Hex
}

export interface SipaObserved {
  sweeps: ObservedSweep[]
  /** Every transfer out of the SIPA: sweep legs and recoveries. */
  outflows: TokenTransfer[]
  /** Transfers out in a transaction with no sweep of this SIPA. */
  recoveries: TokenTransfer[]
  /** Transfers into the SIPA; undefined when not read. */
  inflows?: TokenTransfer[]
  /** Balances keyed by lowercased token, ETH under the zero address; undefined when the read failed. */
  balances?: Map<string, bigint>
}

/**
 * Observes `subjects` through `head`, on every one of `portals`. Subjects that share a commitment are read from the earliest of
 * their starts, so a deposit to that commitment always meets the outflow that names its SIPA. Each
 * window is read on its own: a subject whose window failed is missing from the result, and the rest
 * are observed.
 */
export async function observeSipas(
  publicClient: PublicClient,
  params: {
    portals: readonly Address[]
    tokens: readonly Address[]
    subjects: readonly SipaSubject[]
    head: bigint
  },
): Promise<{
  observed: Map<string, SipaObserved>
  /** Deposits to a tracked commitment that no tracked SIPA sent: their SIPAs are not tracked yet. */
  strays: PortalDeposit[]
}> {
  const { portals, tokens, head } = params
  const subjects = dedupe(params.subjects)
  const startOf = new Map<string, bigint>()
  for (const s of subjects) {
    const key = s.commitment.toLowerCase()
    const known = startOf.get(key)
    if (known === undefined || s.fromBlock < known) startOf.set(key, s.fromBlock)
  }
  const windows = new Map<bigint, SipaSubject[]>()
  for (const s of subjects) {
    const from = startOf.get(s.commitment.toLowerCase())!
    windows.set(from, [...(windows.get(from) ?? []), s])
  }

  const [settled, balances] = await Promise.all([
    Promise.allSettled(
      [...windows].map(async ([from, group]) => {
        const addresses = group.filter((s) => !s.direct).map((s) => s.address)
        const [deposits, outflows, inflows] = await Promise.all([
          readPortalDeposits(
            publicClient,
            portals,
            group.map((s) => s.commitment),
            from,
            head,
          ),
          readTokenTransfers(publicClient, tokens, "from", addresses, from, head),
          readTokenTransfers(
            publicClient,
            tokens,
            "to",
            group.filter((s) => s.inflows && !s.direct).map((s) => s.address),
            from,
            head,
          ),
        ])
        return { group, deposits, outflows, inflows }
      }),
    ),
    readSipaBalancesMany(
      publicClient,
      subjects.filter((s) => !s.direct).map((s) => s.address),
      tokens,
    ).catch((err: unknown) => {
      logger.warn("[sipaObservation] holdings read failed:", err)
      return undefined
    }),
  ])

  const reads = settled.flatMap((read, i) => {
    if (read.status === "fulfilled") return [read.value]
    logger.warn(`[sipaObservation] window from ${[...windows.keys()][i]} failed:`, read.reason)
    return []
  })
  const out = new Map<string, SipaObserved>()
  for (const s of reads.flatMap((read) => read.group)) {
    const key = s.address.toLowerCase()
    out.set(key, {
      sweeps: [],
      outflows: [],
      recoveries: [],
      ...(s.inflows ? { inflows: [] } : {}),
      // A direct deposit's key holds nothing, so it is never read.
      balances: s.direct ? new Map() : balances?.get(key),
    })
  }
  const deposits = new Map<string, PortalDeposit>()
  for (const read of reads) {
    for (const deposit of read.deposits)
      deposits.set(`${deposit.txHash}:${deposit.logIndex}`, deposit)
    for (const flow of read.outflows) out.get(flow.from.toLowerCase())?.outflows.push(flow)
    for (const flow of read.inflows) out.get(flow.to.toLowerCase())?.inflows?.push(flow)
  }

  const byCommitment = new Map<string, SipaSubject[]>()
  for (const s of reads.flatMap((read) => read.group)) {
    const key = s.commitment.toLowerCase()
    byCommitment.set(key, [...(byCommitment.get(key) ?? []), s])
  }
  const strays: PortalDeposit[] = []
  // Senders in a transaction whose Sweep logs could not be read: unobserved this pass.
  const unread = new Set<string>()
  // One sender swept the deposit. Several in one transaction are told apart by the Sweep log each
  // emits: the deposit is the sender that emitted one (any contract can emit the log, so an emitter
  // that is no sender proves nothing), a stray when no sender did, and left for the next pass, with
  // its senders unobserved, when the receipt cannot be read.
  for (const deposit of [...deposits.values()].sort(byPosition)) {
    const senders = sendersOf(deposit, byCommitment.get(deposit.recipientCommitment) ?? [], out)
    let owner: string | undefined = senders[0]
    if (senders.length > 1) {
      const emitters = await readSweepEmitters(publicClient, deposit.txHash, deposit.index).catch(
        (err: unknown) => {
          logger.warn(
            `[sipaObservation] could not read which SIPA swept deposit ${deposit.index}:`,
            err,
          )
          return null
        },
      )
      if (emitters === null) {
        for (const key of senders) unread.add(key)
        continue
      }
      owner = senders.find((key) => emitters.some((emitter) => emitter.toLowerCase() === key))
    }
    if (!owner) {
      strays.push(deposit)
      continue
    }
    out.get(owner)!.sweeps.push({
      portal: deposit.portal,
      index: deposit.index,
      amount: deposit.amount,
      messageKey: deposit.key,
      blockNumber: deposit.blockNumber,
      blockHash: deposit.blockHash,
      txHash: deposit.txHash,
    })
  }
  for (const key of unread) out.delete(key)
  for (const observed of out.values()) {
    const swept = new Set(observed.sweeps.map((s) => s.txHash.toLowerCase()))
    observed.recoveries = observed.outflows.filter((flow) => !swept.has(flow.txHash.toLowerCase()))
  }
  return { observed: out, strays }
}

/**
 * The tracked SIPAs with the deposit's commitment that sent tokens in its transaction, as every
 * sweep does. Commitment alone is not enough: addresses that share a salt, such as one name's
 * registrations at two fees, share it.
 * A direct record has no SIPA: it takes the deposits to its commitment that no tracked SIPA sent.
 */
function sendersOf(
  deposit: PortalDeposit,
  candidates: readonly SipaSubject[],
  observed: Map<string, SipaObserved>,
): string[] {
  const tx = deposit.txHash.toLowerCase()
  const senders = candidates
    .filter((s) => !s.direct)
    .map((s) => s.address.toLowerCase())
    .filter((key) => observed.get(key)?.outflows.some((flow) => flow.txHash.toLowerCase() === tx))
  const direct = candidates.find((s) => s.direct)
  return senders.length || !direct ? senders : [direct.address.toLowerCase()]
}

function dedupe(subjects: readonly SipaSubject[]): SipaSubject[] {
  const byAddress = new Map<string, SipaSubject>()
  for (const s of subjects) {
    const key = s.address.toLowerCase()
    const known = byAddress.get(key)
    byAddress.set(
      key,
      known
        ? {
            ...known,
            fromBlock: s.fromBlock < known.fromBlock ? s.fromBlock : known.fromBlock,
            inflows: known.inflows || s.inflows,
          }
        : s,
    )
  }
  return [...byAddress.values()]
}

const byPosition = (a: PortalDeposit, b: PortalDeposit) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

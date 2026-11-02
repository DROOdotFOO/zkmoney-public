/**
 * Refundable-deposit enumeration for migration: synced `SIPA` events supply the SIPA identities, and
 * one observation of the deployment's portal supplies every sweep's claim inputs and every balance.
 */
import type { Address, Hex, PublicClient } from "viem"
import type { FrozenDepositDescriptor } from "@obsidion/core/types"
import { observeSipas } from "../../../oxide/sipaObservation"

/** The minimum secret-bearing identity needed to find refundable value on L1. */
export interface RefundableSipaSource {
  sipaAddress: string
  recipientL2Address: string
  /** Fr hex. */
  messageSecret: string
  /** What the SIPA's sweeps deposit to on the portal. */
  recipientCommitment: string
  /** Found by its commitment alone: `sipaAddress` is a placeholder that holds nothing on L1. */
  direct?: boolean
}

/** Plain-data form of one `SIPA` event synced from this rollup's token. */
export interface RefundableSipaEvent {
  /** The event's `shared_secret_salt`, as Fr hex. */
  messageSecret: string
  resweepable: boolean
  /** The announced intent hash, hex. Absent or zero on events that predate intent hashes: a deposit. */
  intentHash?: string
}

export interface RefundableDeposit {
  sipaAddress: string
  l2Recipient: string
  messageSecret: string
  /** The L1→L2 message hash. */
  messageKey: Hex
  messageLeafIndex: bigint
  amount: bigint
  sweepBlockNumber: bigint
}

/** A broadcast SIPA that still holds L1 funds and has not yet been fully swept. */
export interface InTransitSipaDeposit {
  source: RefundableSipaSource
  balance: bigint
}

export interface RefundableDepositScan {
  refundable: RefundableDeposit[]
  inTransit: InTransitSipaDeposit[]
}

/** Where one retired deployment's observation reads: its portal, its token and its window. */
export interface RefundScanTarget {
  publicClient: PublicClient
  portal: Address
  token: Address
  fromBlock: bigint
  head: bigint
}

/**
 * Every sweep of `sources` and every SIPA still holding the deployment's token, from one observation.
 * A failed window or a deposit no derived SIPA sent throws, so a scan never reads as empty.
 * `consumed` drops the deposits already spent on L2, in one batch.
 */
export async function scanRefundableDeposits(
  target: RefundScanTarget,
  sources: readonly RefundableSipaSource[],
  consumed?: (deposits: readonly RefundableDeposit[]) => Promise<boolean[]>,
): Promise<RefundableDepositScan> {
  if (!sources.length) return { refundable: [], inTransit: [] }
  const { observed, strays } = await observeSipas(target.publicClient, {
    portals: [target.portal],
    tokens: [target.token],
    head: target.head,
    subjects: sources.map((source) => ({
      address: source.sipaAddress as Address,
      commitment: source.recipientCommitment as Hex,
      fromBlock: target.fromBlock,
      inflows: false,
      ...(source.direct ? { direct: true } : {}),
    })),
  })
  if (strays.length)
    throw new Error(
      `${strays.length} portal deposit(s) to this account came from SIPAs it did not derive`,
    )
  const deposits: RefundableDeposit[] = []
  const inTransit: InTransitSipaDeposit[] = []
  for (const source of sources) {
    const seen = observed.get(source.sipaAddress.toLowerCase())
    if (!seen) throw new Error(`${source.sipaAddress} was not observed`)
    if (!source.direct) {
      const balance = seen.balances?.get(target.token.toLowerCase())
      if (balance === undefined) throw new Error(`${source.sipaAddress}'s balance was not read`)
      if (balance > 0n) inTransit.push({ source, balance })
    }
    for (const sweep of seen.sweeps)
      deposits.push({
        sipaAddress: source.sipaAddress,
        l2Recipient: source.recipientL2Address,
        messageSecret: source.messageSecret,
        messageKey: sweep.messageKey,
        messageLeafIndex: sweep.index,
        amount: sweep.amount,
        sweepBlockNumber: sweep.blockNumber,
      })
  }
  const spent = consumed && deposits.length ? await consumed(deposits) : []
  return { refundable: deposits.filter((_, i) => !spent[i]), inTransit }
}

/**
 * Every swept deposit of `sources` as refund inputs, plus the SIPAs still holding L1 funds. For a
 * frozen source there is no L2 claim check: its refund classifier decides a deposit's state at the
 * freeze.
 */
export async function scanSweptDeposits(
  target: RefundScanTarget,
  sources: readonly RefundableSipaSource[],
): Promise<{ descriptors: FrozenDepositDescriptor[]; inTransit: InTransitSipaDeposit[] }> {
  const scan = await scanRefundableDeposits(target, sources)
  return {
    descriptors: scan.refundable.map((deposit) => ({
      messageKey: deposit.messageKey,
      messageLeafIndex: String(deposit.messageLeafIndex),
      l1BlockNumber: String(deposit.sweepBlockNumber),
      sharedSecretSalt: deposit.messageSecret,
      amount: String(deposit.amount),
    })),
    inTransit: scan.inTransit,
  }
}

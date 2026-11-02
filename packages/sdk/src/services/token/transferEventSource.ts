/**
 * Chain-native source of the account's `Transfer` events, both received and sent (the token
 * delivers each transfer to both parties): reads the account-scoped private events of the oxide
 * token and decodes their `meta`. `ObsidionWallet.getPrivateEvents` syncs
 * PXE first, so each scan is also the note-discovery trigger. Consumed by front-core's
 * `TransferEventScanner`. A payout lane is kept only when its keys derive the event's `from` under
 * the given contract service, so a lane reaching a consumer is a verified paylink claim; without a
 * contract service every payout lane is dropped.
 */

import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { OxideTokenContract, type Transfer as TransferEvent } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { PrivateEvent } from "@aztec-labs/aztec.js/wallet"
import {
  decodeTransferMeta,
  type PaylinkCreatedMeta,
  type PaylinkPayoutMeta,
} from "./transferMeta.js"
import type { ContractService } from "@obsidion/contracts"
import {
  escrowInstancesForKnownClasses,
  paylinkEscrowInstance,
  paylinkTypeOf,
} from "../paylink/escrow/paylinkEscrow.js"

/** One decoded `Transfer` event addressed to the scanned account. */
export interface ScannedTransferEvent {
  txHash: string
  from: string
  to: string
  /** Raw base-unit amount. */
  amount: string
  blockNumber: number
  requestId?: string
  senderTag?: string
  recipientTag?: string
  memo?: string
  /** On an escrow's funding transfer: the link it escrows (see `PaylinkService.recoverPaylinkFromTransfer`). */
  paylinkCreated?: PaylinkCreatedMeta
  /** On a claim's payout, once the source verified it: the escrow `from` is. */
  paylinkPayout?: PaylinkPayoutMeta
}

type EscrowVerifier =
  | Pick<ContractService, "getArtifactForContract" | "getKnownClassIds">
  | undefined

/** Private balances by token address, read at one PXE anchor. */
export type WalletBalances = Record<string, bigint>

/**
 * `readAt` is when each token's read resolved. PXE runs jobs in order, so a read that resolved
 * before a PXE write resolved does not hold it, and one that resolved after it does.
 */
export interface WalletBalanceRead {
  balances: WalletBalances
  readAt?: Record<string, number>
}

export interface WalletSyncSnapshot extends WalletBalanceRead {
  events: ScannedTransferEvent[]
  anchorBlock: number
}

export interface WalletSyncSource extends TransferEventSource {
  /** `assumeSynced` reads at PXE's current anchor, for a later range of an already-synced pass. */
  readSnapshot(
    fromBlock: number,
    toBlockExclusive: number,
    opts?: { assumeSynced?: boolean },
  ): Promise<WalletSyncSnapshot>
  /** The balances alone, on one sync. */
  readBalanceSnapshot(): Promise<WalletBalanceRead & { anchorBlock: number }>
}

export interface TransferEventSource {
  headBlock(): Promise<number>
  /** Events in `[fromBlock, toBlockExclusive)` scoped to the account. */
  listIncoming(fromBlock: number, toBlockExclusive: number): Promise<ScannedTransferEvent[]>
  /** Block timestamp (ms); `undefined` when the node cannot serve the block, and the scanner retries. */
  blockTimestampMs(blockNumber: number): Promise<number | undefined>
  /**
   * PXE's synced block — the highest block whose events `listIncoming` can actually see. The
   * scanner never persists its cursor past this. 0 before the first sync; rejects on an
   * operational fault so the tick fails and backs off. Absent means head is authoritative.
   */
  anchorBlock?(): Promise<number>
}

export function createTransferEventSource(deps: {
  wallet: ObsidionWallet
  tokenAddress: string
  accountAddress: string
  /** Verifies payout lanes; absent, they are dropped. */
  contractService?: EscrowVerifier
}): TransferEventSource {
  const contractAddress = AztecAddress.fromStringUnsafe(deps.tokenAddress)
  const scope = AztecAddress.fromStringUnsafe(deps.accountAddress)
  return {
    headBlock: async () => Number(await deps.wallet.node.getBlockNumber()),
    async listIncoming(fromBlock, toBlockExclusive) {
      const events = await deps.wallet.getPrivateEvents<TransferEvent>(
        OxideTokenContract.events.Transfer,
        {
          contractAddress,
          fromBlock: BlockNumber(fromBlock),
          toBlock: BlockNumber(toBlockExclusive),
          scopes: [scope],
        },
      )
      return decodeEvents(events, deps.contractService)
    },
    async anchorBlock() {
      try {
        const header = await deps.wallet.pxe.getSyncedBlockHeader()
        return Number(header.globalVariables.blockNumber.toString())
      } catch (err) {
        // PXE throws this shape only before the first sync ("not-yet-synchronized PXE"); anything
        // else is a real store/backend fault and must fail the tick, not masquerade as anchor 0.
        if (err instanceof Error && err.message.includes("not-yet-synchronized")) return 0
        throw err
      }
    },
    async blockTimestampMs(blockNumber) {
      try {
        const block = await deps.wallet.node.getBlockData(BlockNumber(blockNumber))
        const ts = block?.header.globalVariables.timestamp
        return ts === undefined ? undefined : Number(ts) * 1000
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Events and balances verified against the same PXE header, without changing event-only callers.
 * `readBalances` picks the tokens; it runs at the anchor the events were read at.
 */
export function createWalletSyncSource(deps: {
  wallet: ObsidionWallet
  tokenAddress: string
  accountAddress: string
  contractService?: EscrowVerifier
  readBalances: () => Promise<WalletBalanceRead>
  /** Stores the token's immutables in this PXE. Reading its events runs its sync, which needs them. */
  prepareToken: () => Promise<void>
}): WalletSyncSource {
  return {
    ...createTransferEventSource(deps),
    async readSnapshot(fromBlock, toBlockExclusive, opts) {
      await deps.prepareToken()
      const { events, projection, anchorBlock } = await deps.wallet.getPrivateEventsSnapshot<
        TransferEvent,
        WalletBalanceRead
      >(
        OxideTokenContract.events.Transfer,
        {
          contractAddress: AztecAddress.fromStringUnsafe(deps.tokenAddress),
          fromBlock: BlockNumber(fromBlock),
          toBlock: BlockNumber(toBlockExclusive),
          scopes: [AztecAddress.fromStringUnsafe(deps.accountAddress)],
        },
        deps.readBalances,
        opts,
      )
      return {
        events: await decodeEvents(events, deps.contractService),
        ...projection,
        anchorBlock,
      }
    },
    async readBalanceSnapshot() {
      const { value, anchorBlock } = await deps.wallet.getSnapshot(deps.readBalances)
      return { ...value, anchorBlock }
    },
  }
}

async function decodeEvents(
  events: PrivateEvent<TransferEvent>[],
  contractService: EscrowVerifier,
): Promise<ScannedTransferEvent[]> {
  return Promise.all(events.map(decodeEvent).map((e) => verifyPayout(e, contractService)))
}

/** Keeps the payout lane only when its keys derive the event's `from`, under any known class. */
async function verifyPayout(
  event: ScannedTransferEvent,
  contractService: EscrowVerifier,
): Promise<ScannedTransferEvent> {
  const lane = event.paylinkPayout
  if (!lane) return event
  const { paylinkPayout: _, ...plain } = event
  if (!contractService) return plain
  let current: ContractInstanceWithAddress
  try {
    current = await paylinkEscrowInstance(
      contractService,
      lane.flavor,
      lane.secret,
      lane.fallbackKeyHash,
    )
  } catch {
    return plain
  }
  const payer = AztecAddress.fromStringUnsafe(event.from)
  if (current.address.equals(payer)) return event
  // Only an earlier class needs the catalog. Failing to read it fails the tick: dropping the lane
  // would store a plain receive the cursor then moves past.
  const escrows = await escrowInstancesForKnownClasses(
    contractService,
    paylinkTypeOf(lane.flavor),
    current,
  )
  return escrows.some((escrow) => escrow.address.equals(payer)) ? event : plain
}

function decodeEvent({ event, metadata }: PrivateEvent<TransferEvent>): ScannedTransferEvent {
  return {
    txHash: metadata.txHash.toString(),
    from: event.from.toString(),
    to: event.to.toString(),
    amount: BigInt(event.amount).toString(),
    blockNumber: Number(metadata.l2BlockNumber),
    ...decodeTransferMeta(event.meta),
  }
}

/**
 * Shared ports for incoming-transfer ingest (`TransferEventScanner`) and its platform adapters.
 * Free of `@aztec/*` runtime imports: everything crosses these seams as primitives (hex strings,
 * stringified bigints, numbers).
 */

import type { PaylinkActionEnum } from "@obsidion/core/constants"
import type { Activity } from "../engine/activity"
import type { TokenInTxService } from "../types/tokens"

/**
 * Forward tag resolution: `senderTag → L2 address`, always a fresh registry read. Returns `null`
 * when the tag is not registered (permanent). Throws on transport / service failure — callers
 * defer and retry.
 */
export interface ITagForwardResolver {
  resolveL2(tag: string, rollupId: string): Promise<{ l2Address: string } | null>
}

/**
 * Contact-display lookup by L2 address. Implementations typically wrap `ContactStorage`. Returns
 * `null` when no contact is known for the sender; if `registerL2` is supplied, a verified
 * first-time sender is best-effort auto-added for display attribution.
 */
export type ContactsByL2 = {
  findByL2Address(addr: string): Promise<{ tag: string } | null>
  registerL2?(args: { tag: string; l2Address: string }): Promise<void>
}

/** The activity reads and writes the ingest needs; its writes join the scan's transaction. */
export type TransactionStoreWrites = Pick<Activity, "hasTxHash" | "backfillMemo" | "record">

/** Payload for `payoutRow`. */
export type NewPaylinkPayoutTx = {
  action: PaylinkActionEnum.CLAIM | PaylinkActionEnum.CLAIM_BACK
  txHash: string
  flavor: "direct" | "email"
  token: TokenInTxService
  amountAtomic: bigint
  timestamp: number
  blockNumber: number
  memo?: string
  networkId: string
}

/** Payload for `scannedRow`. */
export type NewIncomingTokenTx = {
  /** Defaults to `receive`. */
  action?: "send" | "receive"
  txHash: string
  from: string
  senderL2Address: string
  to: string
  token: TokenInTxService
  timestamp: number
  memo?: string
  /** Mined block of the emitting tx; the reorg watch anchor. */
  blockNumber?: number
  requestId?: string
  /** Network the event was scanned on. */
  networkId: string
  /** Raw amount in base units, from the decoded on-chain `Transfer` event. */
  amountAtomic: bigint
}

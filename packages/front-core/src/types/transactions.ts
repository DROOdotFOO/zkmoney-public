import type { QueueStatus } from "@obsidion/sdk"
import type { OriginalFlowKind } from "@obsidion/proving-progress"
import type { TokenAction, TokenInTxService, PaylinkAction } from "./tokens"
import type { TxStatus } from "@aztec-labs/stdlib/tx"
import type { Failure } from "../engine/errors"

// Add a new action type for faucet transactions
export type FaucetAction = "faucet"
export enum FaucetActionEnum {
  FAUCET = "faucet",
}

export type TransactionStatus = "pending" | "success" | "failed"

export type AccountCreationAction = "create_account" | "import_account"
// More detailed status that mirrors the queue status

// Base transaction type with common fields
export type BaseTransaction = {
  /** The record key: the operation id for a row this device started, else the tx hash. */
  id: string
  timestamp: number
  status: TransactionStatus
  txHash: string
  /** The user operation that wrote this row; proving-progress events carry the same id. */
  operationId?: string
  detailedStatus?: QueueStatus
  progress?: number
  /** Raw amount in base units; 0 when the amount is unknown. */
  amountAtomic: bigint
  failure?: Failure
  startTime?: number
  endTime?: number
  estimatedDuration?: number
  description?: string
  /** The user's source flow (`"send"`, `"withdraw"`, `"paylink-create"`, …). */
  kind?: OriginalFlowKind
  /** Network the row was created on: see `OnNetwork`. */
  networkId?: string
  // Reorg anchors: block inclusion data, re-writable on re-inclusion.
  blockNumber?: number
  blockHash?: string
  /** Internal six-tier status; the binary `status` stays the user-facing truth. */
  tier?: TxStatus
  /** Incremented on each reorg demote; stale forward writes carry an older epoch. */
  reorgEpoch?: number
}

// Token-related transaction.
//
// For `action: "send"`, `to` holds the recipient and `from` is the local user.
// For `action: "receive"`, `from` holds the sender (tag or raw L2 address) and
// `to` is the local user. The fields below `memo` are populated by the
// chain-native ingest (see core/services/transactions/TransferEventScanner.ts).
export type TokenTransaction = BaseTransaction & {
  action: TokenAction
  token: TokenInTxService
  from?: string
  to?: string
  // Sender-attached note: persisted on an outgoing send, or decoded from an incoming transfer's on-chain meta.
  memo?: string
  senderL2Address?: string
  /** Recipient's @tag on an outgoing send, so a send to someone not saved still reads as them. */
  toTag?: string
  /** Payment request this transfer fulfills (from the on-chain `Transfer.meta`). */
  requestId?: string
}

export type ContractCallTransaction = BaseTransaction & {
  action: "contract_call"
  from: string
  to: string
  functionName: string
}
// Add new Faucet transaction type
export type FaucetTransaction = BaseTransaction & {
  action: FaucetAction
  token: TokenInTxService
  // We could add additional faucet-specific fields here if needed
}

// PaylinkTransaction (formerly EmailPaymentTransaction) — represents a paylink
// row in either flavor (direct or email). The persisted field name
// `emailPaymentAction` is kept unchanged for back-compat with stored rows; new
// rows write `flavor` to distinguish direct vs email-validated paylinks.
export type PaylinkTransaction = BaseTransaction & {
  action: PaylinkAction
  token?: TokenInTxService
  /**
   * Persisted action discriminator, kept under its legacy field name
   * `emailPaymentAction` so stored rows from before the EmailPayment→Paylink
   * rename continue to decode. New rows still write this field; the rename is
   * type-level only at this layer.
   */
  emailPaymentAction: PaylinkAction
  /** Discriminates direct paylinks (no recipient validation) from email paylinks (email-bound). */
  flavor: "direct" | "email" | "zk"
  from?: string
  to?: string
  payToEmailSecret?: string
  obsidionAccountAddress?: string
  partialAddress?: string
  // The escrow's fallback secret, stamped once the create has its keys: the creator's migration
  // factor, never in the link.
  fallbackSecret?: string
  /**
   * Claim-window timestamps (unix seconds). Not encoded in the link, persisted here.
   */
  fromClaimable?: number
  untilClaimable?: number
  /** End of the creator refund window (unix seconds), which opens at creation. */
  refundableUntil?: number
  tokenAddress?: string
  paylink?: string
  /** Creator's memo: set at create; on a claim row, read from the escrow note. */
  memo?: string
  isRefunded?: boolean
  /**
   * The refund transaction that returned this link's escrow. The refund has no activity row of its
   * own — the create row carries the whole round trip — so this is where its hash is readable.
   */
  refundTxHash?: string
  /** Which recovery returned the escrow; unset on rows refunded before it was recorded. */
  refundKind?: "cancel" | "reclaim"
  isClaimed?: boolean
  /**
   * When the link was claimed: the claim's block time on a row rebuilt from chain, else when this
   * device first saw it claimed.
   */
  claimedAt?: number
  /** Who claimed it: this account (`self`) or someone the chain showed (`chain`, and unset). */
  claimedBy?: "self" | "chain"
  // Escrow returned on L1 by an upgrade off a retired deployment. Its L2 note stays unspent there, so
  // no nullifier read ever settles this row.
  isMigrated?: boolean
}

export function isPaylinkTransaction(tx: Transaction): tx is PaylinkTransaction {
  return (tx as PaylinkTransaction).emailPaymentAction !== undefined
}

export type AccountCreationTransaction = BaseTransaction & {
  action: AccountCreationAction
  accountAddress?: string
  isDevMode?: boolean
  hasEmail?: boolean
}

// Union type for all transaction types
export type Transaction =
  | TokenTransaction
  | FaucetTransaction
  | PaylinkTransaction
  | AccountCreationTransaction
  | ContractCallTransaction

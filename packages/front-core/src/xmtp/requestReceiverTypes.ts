/**
 * Types for the payment-request receiver. Pure ports — mounts inject store / binding / verification adapters.
 */

import type { AztecPaymentRequestContent } from "@obsidion/sdk"

/** Store writes the receiver needs. */
export interface RequestStoreWrites {
  /** Insert incoming row; `inserted: false` = duplicate `requestId`. */
  addIncomingRequest(input: IncomingRequestInput): Promise<{ inserted: boolean }>
  /** The payer turned the request down; `applied: false` = missing row or not pending. */
  decline(requestId: string): Promise<{ applied: boolean }>
  /** Row lookup for the binding gate. Required when a binding resolver is wired. */
  findById?(requestId: string): Promise<StoredRequestView | null>
}

/** Row fields the receiver reads for bind / verify. */
export interface StoredRequestView {
  contactTag: string
  direction: "outgoing" | "incoming"
  /** Display amount when atomic fields are absent. */
  amount?: number
  amountAtomic?: string
  tokenDecimals?: number
  tokenAddress?: string
}

/**
 * A tag's Registry bootstrap address (fresh manifest, not contact cache).
 * `null` if unresolved; throw on transport failure → receiver defers.
 */
export interface RequestTagBindingResolver {
  resolveXmtpBinding(tag: string): Promise<string | null>
}

/** Who may send new requests. A throw admits: the UI filters by sender again. */
export interface RequestSenderPolicy {
  admitsRequester(tag: string): Promise<boolean>
}

/** Fields for an incoming request row. */
export interface IncomingRequestInput {
  requestId: string
  /** Requester's Aztec tag (payee / contact key). */
  requesterTag: string
  /** Raw amount in base units; `"0"` = any amount. */
  amountAtomic: string
  decimals: number
  tokenAddress: string
  tokenSymbol?: string
  networkId: string
  note?: string
  expiresAt?: number
}

/** One decoded `AztecPaymentRequestContent` message. */
export interface RequestReceiveInput {
  content: AztecPaymentRequestContent
  /** Every address on the DM peer's inbox; empty if unresolvable. Used by the tag check. */
  senderXmtpAddresses?: readonly string[]
}

/**
 * Receiver result — never thrown.
 * Driver advances on accepted | duplicate | ignored; holds only on deferred.
 */
export type RequestReceiveStatus =
  | { status: "accepted"; kind: AztecPaymentRequestContent["kind"] }
  | { status: "duplicate" }
  | { status: "ignored"; reason: RequestIgnoreReason }
  | { status: "deferred"; reason: RequestDeferReason }

export type RequestIgnoreReason =
  | "no-matching-request"
  /** The claimed tag's bootstrap address is not on the peer's inbox. */
  | "sender-binding-mismatch"
  /** The sender policy refused the requester. */
  | "sender-not-admitted"

export type RequestDeferReason =
  | "store-write-failure"
  /** Binding resolver threw (transport); retryable. */
  | "binding-resolver-unavailable"

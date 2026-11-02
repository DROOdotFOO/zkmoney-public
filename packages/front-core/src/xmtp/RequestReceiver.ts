/**
 * Routes one decoded payment-request message (`request` / `request-declined`) into
 * `RequestStoreWrites`. The optional sender policy skips refused requesters; the optional
 * tag-binding gate skips peer mismatches and defers transport failures. Fulfillment never arrives
 * here — `resolveRequests` reads it from the on-chain `Transfer.meta`. `process` never
 * throws — store errors become `deferred` for retry. Idempotency lives in the store.
 */

import { plainText } from "@obsidion/core/text"
import type { TokenTransaction } from "../types/transactions.js"
import { hasAddress } from "./tagForwardResolver.js"
import type {
  RequestReceiveInput,
  RequestReceiveStatus,
  RequestSenderPolicy,
  RequestStoreWrites,
  RequestTagBindingResolver,
  StoredRequestView,
} from "./requestReceiverTypes.js"

export type RequestReceiverLogger = {
  warn(message: string, context?: Record<string, unknown>): void
}

const noopLogger: RequestReceiverLogger = { warn: () => undefined }

/** Verified receive satisfies a request: matching token (when both set) and sufficient amount. Requested `0`/unset = any amount. */
export function fulfillmentSatisfiesRequest(
  request: Pick<StoredRequestView, "amount" | "amountAtomic" | "tokenDecimals" | "tokenAddress">,
  tx: TokenTransaction,
): boolean {
  if (
    request.tokenAddress &&
    tx.token.address &&
    request.tokenAddress.toLowerCase() !== tx.token.address.toLowerCase()
  ) {
    return false
  }
  // Base-unit compare when both sides carry raw amounts. `tx.token.amount` is a display float
  // scaled by the sender's wire-asserted decimals, so it must never decide fulfillment on its own —
  // a payer asserting decimals:0 would let dust satisfy the request.
  if (request.amountAtomic != null && tx.amountAtomic != null) {
    try {
      return BigInt(tx.amountAtomic) >= BigInt(request.amountAtomic)
    } catch {
      // Malformed raw amount: fall through to the display compare.
    }
  }
  const requested =
    request.amountAtomic != null && request.tokenDecimals != null
      ? Number(request.amountAtomic) / 10 ** request.tokenDecimals
      : request.amount ?? 0
  if (!(requested > 0)) return true
  return tx.token.amount >= requested - requested * 1e-9
}

export class RequestReceiver {
  constructor(
    private readonly store: RequestStoreWrites,
    private readonly logger: RequestReceiverLogger = noopLogger,
    /** Optional: accept only if the claimed tag's bootstrap address is on the DM peer's inbox. */
    private readonly binding?: RequestTagBindingResolver,
    /** Optional: checked before the binding, so a refused requester costs no Registry read. */
    private readonly senders?: RequestSenderPolicy,
  ) {}

  async process(input: RequestReceiveInput): Promise<RequestReceiveStatus> {
    try {
      return await this.run(input)
    } catch (cause) {
      this.logger.warn("[RequestReceiver] store write threw", { cause: describeCause(cause) })
      return { status: "deferred", reason: "store-write-failure" }
    }
  }

  private async run({
    content,
    senderXmtpAddresses,
  }: RequestReceiveInput): Promise<RequestReceiveStatus> {
    switch (content.kind) {
      case "request": {
        if (!(await this.admits(content.requesterTag))) {
          return { status: "ignored", reason: "sender-not-admitted" }
        }
        if (this.binding) {
          const gate = await this.bindingGate(content.requesterTag, senderXmtpAddresses)
          if (gate) return gate
        }
        const { inserted } = await this.store.addIncomingRequest({
          requestId: content.requestId,
          requesterTag: content.requesterTag,
          amountAtomic: content.amountAtomic,
          decimals: content.decimals,
          tokenAddress: content.token,
          tokenSymbol: content.tokenSymbol,
          networkId: content.networkId,
          note: content.note && plainText(content.note),
          expiresAt: content.expiresAt,
        })
        return inserted ? { status: "accepted", kind: "request" } : { status: "duplicate" }
      }
      case "request-declined": {
        const gate = await this.flipGate(content.requestId, senderXmtpAddresses)
        if (gate) return gate
        const { applied } = await this.store.decline(content.requestId)
        return applied
          ? { status: "accepted", kind: "request-declined" }
          : { status: "ignored", reason: "no-matching-request" }
      }
    }
  }

  private async admits(tag: string): Promise<boolean> {
    if (!this.senders) return true
    try {
      return await this.senders.admitsRequester(tag)
    } catch (cause) {
      this.logger.warn("[RequestReceiver] sender policy threw — request admitted", {
        tag,
        cause: describeCause(cause),
      })
      return true
    }
  }

  /** Tag check for a declined flip: the peer must own the row's `contactTag`. */
  private async flipGate(
    requestId: string,
    peers: readonly string[] | undefined,
  ): Promise<RequestReceiveStatus | null> {
    if (!this.binding || !this.store.findById) return null
    const row = await this.store.findById(requestId)
    if (!row) return { status: "ignored", reason: "no-matching-request" }
    return this.bindingGate(row.contactTag, peers)
  }

  /** Null when `tag`'s bootstrap address is on the peer's inbox; a skip/defer status otherwise. */
  private async bindingGate(
    tag: string,
    peers: readonly string[] | undefined,
  ): Promise<RequestReceiveStatus | null> {
    let published: string | null
    try {
      published = await this.binding!.resolveXmtpBinding(tag)
    } catch (cause) {
      this.logger.warn("[RequestReceiver] binding resolver threw", {
        tag,
        cause: describeCause(cause),
      })
      return { status: "deferred", reason: "binding-resolver-unavailable" }
    }
    if (!published || !hasAddress(peers ?? [], published)) {
      this.logger.warn("[RequestReceiver] sender binding mismatch — message skipped", {
        tag,
        peers: peers ?? [],
        published,
      })
      return { status: "ignored", reason: "sender-binding-mismatch" }
    }
    return null
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  return String(cause)
}

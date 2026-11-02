import { z } from "zod"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TRANSFER_MEMO_MAX_BYTES } from "../services/token/transferMeta.js"

/**
 * Maximum accepted length of a connect-back `uuid` string, in characters.
 * A canonical UUID is 36 chars; we allow a generous bound so the handshake
 * can carry a longer opaque token if its format changes, while still keeping
 * the field bounded (no unbounded strings on the wire).
 */
export const CONNECT_BACK_UUID_MAX_LEN = 128

/**
 * Scanner-claimed tag on a connect-back. Matches front-core's tag charset (X
 * handle alphabet plus `-`, no leading/trailing hyphen, max 32). Optional on
 * the wire so a tag-less scanner and an older sender still decode.
 */
export const CONNECT_BACK_TAG_MAX_LEN = 32
export const CONNECT_BACK_TAG_REGEX = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

/**
 * Connect-back content carried by the custom XMTP content type
 * `obsidion.xyz/connect-back:1.0`.
 *
 * Emitted by the *scanner* of a QR / link handshake immediately after they
 * resolve the sharer's encrypted blob and add the sharer as a contact. It
 * carries the redeemed `uuid` back to the sharer over XMTP so the sharer can
 * match it against their local issued-blob store, auto-add the scanner, and
 * delete the blob (single-use). An optional `tag` is the scanner's own handle;
 * the sharer forward-resolves it and accepts it only when the registry XMTP
 * binding matches the authenticated sender.
 *
 * Payload encoding: UTF-8 JSON.
 */
export const ConnectBackContentSchema = z.object({
  /**
   * Payload schema version. Bounded small integer; lets the receiver reject
   * or branch on a wire version it doesn't understand. The content-type id
   * also carries a version, but an in-payload version keeps the two
   * decoupled if the schema evolves within a single content-type version.
   */
  version: z.number().int().min(1).max(255),

  /**
   * Opaque redeemed handshake UUID. Matched verbatim against the sharer's
   * local issued-blob store. Bounded length so the payload stays small and
   * an unbounded string can't be smuggled onto the wire.
   */
  uuid: z.string().min(1).max(CONNECT_BACK_UUID_MAX_LEN),

  /**
   * Scanner's own tag, when they have one. Omitted for a tag-less scanner.
   * The sharer never trusts this field alone — they forward-resolve it.
   */
  tag: z.string().min(1).max(CONNECT_BACK_TAG_MAX_LEN).regex(CONNECT_BACK_TAG_REGEX).optional(),
})

export type ConnectBackContent = z.infer<typeof ConnectBackContentSchema>

/** Wire `requestId`: a `0x`-hex BN254 field, so it always fits `Transfer.meta`'s reference entry on a fulfilling send. */
const PaymentRequestIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .refine((id) => {
    try {
      Fr.fromHexString(id)
      return true
    } catch {
      return false
    }
  }, "requestId must fit a BN254 field")

/** Max accepted length of a request `note`, mirroring the send-transfer memo cap. */
export const PAYMENT_REQUEST_NOTE_MAX_LEN = TRANSFER_MEMO_MAX_BYTES

/**
 * Payment-request content carried by the custom XMTP content type
 * `obsidion.xyz/payment-request:1.0`.
 *
 * A payment request is the inverse of a paylink: the requester asks to be paid,
 * and the payer fulfills it with an ordinary L2 send. Nothing is escrowed. This
 * single content type covers the whole lifecycle via a `kind`-discriminated
 * union keyed on `requestId`:
 *
 *   - `request`           — the requester announces a bill to a contact.
 *   - `request-declined`  — the payer signals a decline back.
 *
 * Fulfillment has no signal: the fulfilling send carries `requestId` in the on-chain
 * `Transfer.meta`, and the requester joins it there. `requestId` is a `0x`-hex BN254 field (it
 * must fit one Field). Payloads carry no `Fr`/`Point` — only
 * strings/numbers — so the wire form is plain JSON (mirrors
 * `ConnectBackContentSchema`).
 */
export const AztecPaymentRequestContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("request"),
    /** Join key minted by the requester (`Fr.random()` hex); echoed back on decline, rides `Transfer.meta` on fulfillment. */
    requestId: PaymentRequestIdSchema,
    /** Requester's Aztec tag (normalized, e.g. `"alice"`) — the payee. */
    requesterTag: z.string().min(1),
    /** Raw amount in the token's base units. `"0"` = "any amount". */
    amountAtomic: z.string().regex(/^[0-9]+$/),
    /** Token contract address (Aztec address, hex). */
    token: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .min(4),
    /** Optional token symbol/ticker for UI convenience. */
    tokenSymbol: z.string().max(16).optional(),
    /** Decimals for the token (UI formatting only). */
    decimals: z.number().int().min(0).max(36),
    /** Aztec network the request targets — keeps cross-network requests unambiguous. */
    networkId: z.string().min(1),
    /** Optional short note from the requester, capped to keep payloads small. */
    note: z.string().max(PAYMENT_REQUEST_NOTE_MAX_LEN).optional(),
    /** Optional soft expiry (epoch ms) — checked at the UI, not in decode. */
    expiresAt: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("request-declined"),
    requestId: PaymentRequestIdSchema,
    networkId: z.string().min(1),
  }),
])

export type AztecPaymentRequestContent = z.infer<typeof AztecPaymentRequestContentSchema>

/**
 * Error thrown by the codec when a payload cannot be decoded.
 * Wraps the underlying JSON / schema error with a typed surface so callers
 * can filter these out of logs without touching msgpack / Zod internals.
 */
export class CodecDecodeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "CodecDecodeError"
  }
}

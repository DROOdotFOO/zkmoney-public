/**
 * The asserted token's `transfer` carries a 7-Field `meta` passthrough that lands unparsed in the
 * recipient's private `Transfer` event. The wallet fills it with one flat 217-byte TLV stream
 * (31 bytes per field, big-endian in each field's low 31 bytes; the top byte is always zero):
 *
 *   byte 0      format version (0x01)
 *   then        [type: u8][len: u8][value: len bytes] entries —
 *               0x01 memo (UTF-8, ≤ TRANSFER_MEMO_MAX_BYTES), 0x02 reference (the payment-request
 *               id as its 32-byte Fr value), 0x03 sender tag, 0x04 recipient tag (ASCII, ≤ 32 bytes),
 *               0x10 paylink created: [flavor: u8][day: u16][secret: 32][fallbackKeyHash: 32][email: rest]
 *               0x11 paylink payout: [flavor: u8][secret: 32][fallbackKeyHash: 32]
 *   then        0x00 terminator, zero fill
 *
 * The created lane rides the escrow's funding transfer, never a plain send. The token delivers
 * that transfer to both parties and a link holder can decrypt the escrow's copy, so the lane
 * carries only what the link already gives them: the escrow secret, the fallback key's hash, the
 * creation day and the lock email. The fallback secret never leaves the creator. Their own copy is
 * the resync record: the day and secret locate the `(day, n)` nonce under the master secret, which
 * re-derives the creator-only fallback secret.
 *
 * The payout lane rides a claim's payout from the escrow to the claimer, so a fresh device can
 * rebuild the claim: its secret and key hash re-derive the escrow, which must be the payout's
 * `from`. A refund carries no lane.
 *
 * Everything is sender-asserted (unconstrained delivery): the tags are display attribution the
 * reader verifies via the name registry — the recipient checks the sender tag against
 * `Transfer.from`; the sender, rebuilding history from its own event copy, checks the recipient tag
 * against `Transfer.to` — and a paylink lane counts only once its secret and fallback key derive the
 * escrow the transfer funded. Decoding is total — any input yields a (possibly empty) TransferMeta, never a
 * throw — and unknown entry types are skipped by `len`, so new fields can ship without breaking
 * old readers.
 */

import { Fr } from "@aztec-labs/aztec.js/fields"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import { MAX_TAG_LENGTH, TRANSFER_META_LEN } from "@obsidion/core/constants"
import { plainText } from "@obsidion/core/text"
import { metaCapacity, packMetaFields, unpackMetaFields } from "./metaFields.js"

export { fieldLikeToFr } from "./metaFields.js"

const META_CAPACITY = metaCapacity(TRANSFER_META_LEN)

const TLV_VERSION = 0x01
const TYPE_END = 0x00
const TYPE_MEMO = 0x01
const TYPE_REFERENCE = 0x02
const TYPE_SENDER_TAG = 0x03
const TYPE_RECIPIENT_TAG = 0x04
const TYPE_PAYLINK_CREATED = 0x10
const TYPE_PAYLINK_PAYOUT = 0x11

const PAYLINK_FLAVOR_BYTES = { direct: 0x00, email: 0x01 } as const
const SECRET_LEN = Fr.SIZE_IN_BYTES

const REFERENCE_LEN = Fr.SIZE_IN_BYTES
// Tags are ASCII (TAG_RE), so the claim-time character cap is also the byte cap.
const MAX_TAG_BYTES = MAX_TAG_LENGTH
const TAG_RE = /^[a-z0-9_-]+$/

/** Memo bytes guaranteed to fit even beside two maximum-length tags and a reference. */
export const TRANSFER_MEMO_MAX_BYTES =
  META_CAPACITY - 1 - (2 + REFERENCE_LEN) - 2 * (2 + MAX_TAG_BYTES) - 2 - 1

/** A funding transfer's announcement of the paylink it escrows. */
export interface PaylinkCreatedMeta {
  flavor: keyof typeof PAYLINK_FLAVOR_BYTES
  /** Epoch day the creator stamped the key nonce with; tells a resync which day's slots to try. */
  day: number
  /** The escrow secret; every escrow key but fallback derives from it. */
  secret: Fr
  /** `fbpkMHash`: all the escrow address needs of the fallback key. The fallback secret stays creator-only. */
  fallbackKeyHash: Fr
  /** Plaintext lock email (email flavor); the claimer's display hint. */
  email?: string
}

/** The lock email's packed width (`EMAIL_LEN`), the most a created lane carries after its secrets. */
const PAYLINK_EMAIL_MAX_BYTES = 64
const PAYLINK_DAY_LEN = 2
const PAYLINK_CREATED_HEAD_LEN = 1 + PAYLINK_DAY_LEN + 2 * SECRET_LEN
const PAYLINK_CREATED_MAX_LEN = PAYLINK_CREATED_HEAD_LEN + PAYLINK_EMAIL_MAX_BYTES

/** Memo bytes that fit a funding transfer beside a full sender-tag lane and a full created lane. */
export const PAYLINK_MEMO_MAX_BYTES =
  META_CAPACITY - 1 - (2 + MAX_TAG_BYTES) - (2 + PAYLINK_CREATED_MAX_LEN) - 2 - 1

/** A claim payout's announcement of the escrow it left. */
export type PaylinkPayoutMeta = Pick<PaylinkCreatedMeta, "flavor" | "secret" | "fallbackKeyHash">

const PAYLINK_PAYOUT_LEN = 1 + 2 * SECRET_LEN

export interface TransferMeta {
  requestId?: string
  senderTag?: string
  recipientTag?: string
  memo?: string
  paylinkCreated?: PaylinkCreatedMeta
  paylinkPayout?: PaylinkPayoutMeta
}

export function buildTransferMeta(input: TransferMeta): Fr[] {
  const buf = Buffer.alloc(META_CAPACITY)
  buf[0] = TLV_VERSION
  let pos = 1
  const put = (type: number, value: Buffer) => {
    if (value.length > 0xff || pos + 2 + value.length > META_CAPACITY) {
      throw new Error(`transfer meta entry 0x${type.toString(16)} does not fit`)
    }
    buf[pos] = type
    buf[pos + 1] = value.length
    value.copy(buf, pos + 2)
    pos += 2 + value.length
  }
  if (input.requestId) {
    const id = Fr.fromHexString(input.requestId)
    if (!id.isZero()) put(TYPE_REFERENCE, id.toBuffer())
  }
  const putTag = (type: number, value: string | undefined) => {
    if (!value) return
    const tag = Buffer.from(value, "ascii")
    if (tag.length > MAX_TAG_BYTES) {
      throw new Error(`transfer meta tag exceeds ${MAX_TAG_BYTES} bytes`)
    }
    if (tag.length > 0) put(type, tag)
  }
  putTag(TYPE_SENDER_TAG, input.senderTag)
  putTag(TYPE_RECIPIENT_TAG, input.recipientTag)
  // The memo lane truncates instead of throwing: a display note must never fail the payment.
  if (input.memo) {
    const budget = input.paylinkCreated ? PAYLINK_MEMO_MAX_BYTES : TRANSFER_MEMO_MAX_BYTES
    const memo = Buffer.from(truncateUtf8(input.memo, budget), "utf8")
    if (memo.length > 0) put(TYPE_MEMO, memo)
  }
  if (input.paylinkCreated) {
    const { flavor, day, secret, fallbackKeyHash, email } = input.paylinkCreated
    const dayBytes = Buffer.alloc(PAYLINK_DAY_LEN)
    dayBytes.writeUInt16BE(day)
    put(
      TYPE_PAYLINK_CREATED,
      Buffer.concat([
        Buffer.from([PAYLINK_FLAVOR_BYTES[flavor]]),
        dayBytes,
        secret.toBuffer(),
        fallbackKeyHash.toBuffer(),
        Buffer.from(email ?? "", "utf8"),
      ]),
    )
  }
  if (input.paylinkPayout) {
    const { flavor, secret, fallbackKeyHash } = input.paylinkPayout
    put(
      TYPE_PAYLINK_PAYOUT,
      Buffer.concat([
        Buffer.from([PAYLINK_FLAVOR_BYTES[flavor]]),
        secret.toBuffer(),
        fallbackKeyHash.toBuffer(),
      ]),
    )
  }
  return packMetaFields(buf, TRANSFER_META_LEN)
}

/**
 * Send-path variant: a display or join field never fails the payment. A non-field legacy request
 * id and an invalid tag (over 32 bytes, or failing the tag charset after lowercase/trim) are
 * dropped; everything else encodes strictly.
 */
export function buildTransferMetaForSend(input: TransferMeta): Fr[] {
  const out: TransferMeta = {}
  if (input.requestId) {
    try {
      Fr.fromHexString(input.requestId)
      out.requestId = input.requestId
    } catch {
      // legacy non-field id: the payment wins over the join
    }
  }
  out.senderTag = lenientTag(input.senderTag)
  out.recipientTag = lenientTag(input.recipientTag)
  if (input.memo) out.memo = input.memo
  if (input.paylinkCreated) out.paylinkCreated = input.paylinkCreated
  if (input.paylinkPayout) out.paylinkPayout = input.paylinkPayout
  return buildTransferMeta(out)
}

function lenientTag(value: string | undefined): string | undefined {
  if (!value) return undefined
  const tag = value.trim().toLowerCase()
  return TAG_RE.test(tag) && tag.length <= MAX_TAG_BYTES ? tag : undefined
}

/** Longest prefix of `value` that fits `maxBytes` UTF-8 bytes, cut at a codepoint boundary. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  // Walk back over continuation bytes (0b10xxxxxx) to the previous codepoint start.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

/**
 * Total decode: any input — wrong version, truncated arrays, overrunning lengths, duplicate
 * entries, invalid values — yields a (possibly empty) TransferMeta, never a throw. Duplicates are
 * first-wins so the result is a pure function of the stream prefix; a malformed entry (reference
 * len ≠ 32, zero reference, oversize or charset-invalid tag, zero-length or invalid-UTF-8 value)
 * is dropped, never repaired. Each iteration consumes ≥ 2 bytes, bounding the loop by the buffer.
 */
export function decodeTransferMeta(meta: readonly FieldLike[] | undefined): TransferMeta {
  const buf = unpackMetaFields(meta, TRANSFER_META_LEN)
  if (!buf || buf[0] !== TLV_VERSION) return {}

  const out: TransferMeta = {}
  let pos = 1
  while (pos + 1 < META_CAPACITY) {
    const type = buf[pos]!
    if (type === TYPE_END) break
    const len = buf[pos + 1]!
    const end = pos + 2 + len
    if (end > META_CAPACITY) break
    const value = buf.subarray(pos + 2, end)
    if (type === TYPE_REFERENCE && out.requestId === undefined && len === REFERENCE_LEN) {
      try {
        const id = Fr.fromBuffer(value)
        if (!id.isZero()) out.requestId = id.toString().toLowerCase()
      } catch {
        // ≥ field modulus: dropped
      }
    } else if (type === TYPE_SENDER_TAG && out.senderTag === undefined && len <= MAX_TAG_BYTES) {
      const tag = decodeText(value)
      if (tag && TAG_RE.test(tag)) out.senderTag = tag
    } else if (
      type === TYPE_RECIPIENT_TAG &&
      out.recipientTag === undefined &&
      len <= MAX_TAG_BYTES
    ) {
      const tag = decodeText(value)
      if (tag && TAG_RE.test(tag)) out.recipientTag = tag
    } else if (type === TYPE_MEMO && out.memo === undefined && len > 0) {
      const memo = decodeText(value)
      if (memo) out.memo = plainText(memo)
    } else if (type === TYPE_PAYLINK_CREATED && out.paylinkCreated === undefined) {
      const created = decodePaylinkCreated(value)
      if (created) out.paylinkCreated = created
    } else if (type === TYPE_PAYLINK_PAYOUT && out.paylinkPayout === undefined) {
      const payout = decodePaylinkPayout(value)
      if (payout) out.paylinkPayout = payout
    }
    pos = end
  }
  return out
}

function flavorOf(byte: number | undefined): PaylinkCreatedMeta["flavor"] | undefined {
  return (Object.keys(PAYLINK_FLAVOR_BYTES) as PaylinkCreatedMeta["flavor"][]).find(
    (name) => PAYLINK_FLAVOR_BYTES[name] === byte,
  )
}

/** Two non-zero fields at `at`, or undefined. */
function secretsAt(
  value: Buffer,
  at: number,
): Pick<PaylinkPayoutMeta, "secret" | "fallbackKeyHash"> | undefined {
  try {
    const secret = Fr.fromBuffer(value.subarray(at, at + SECRET_LEN))
    const fallbackKeyHash = Fr.fromBuffer(value.subarray(at + SECRET_LEN, at + 2 * SECRET_LEN))
    return secret.isZero() || fallbackKeyHash.isZero() ? undefined : { secret, fallbackKeyHash }
  } catch {
    return undefined
  }
}

/** The lane's value, or undefined for an unknown flavor, a zero or non-field secret, or an invalid email. */
function decodePaylinkCreated(value: Buffer): PaylinkCreatedMeta | undefined {
  if (value.length < PAYLINK_CREATED_HEAD_LEN) return undefined
  const flavor = flavorOf(value[0])
  const secrets = secretsAt(value, 1 + PAYLINK_DAY_LEN)
  if (!flavor || !secrets) return undefined
  const day = value.readUInt16BE(1)
  const { secret, fallbackKeyHash } = secrets
  const emailBytes = value.subarray(PAYLINK_CREATED_HEAD_LEN)
  if (emailBytes.length === 0) return { flavor, day, secret, fallbackKeyHash }
  const email = decodeText(emailBytes)
  return email === undefined ? undefined : { flavor, day, secret, fallbackKeyHash, email }
}

/** The lane's value, or undefined for a wrong length, an unknown flavor, or a zero or non-field secret. */
function decodePaylinkPayout(value: Buffer): PaylinkPayoutMeta | undefined {
  if (value.length !== PAYLINK_PAYOUT_LEN) return undefined
  const flavor = flavorOf(value[0])
  const secrets = secretsAt(value, 1)
  return flavor && secrets ? { flavor, ...secrets } : undefined
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.length === 0) return undefined
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return undefined
  }
}

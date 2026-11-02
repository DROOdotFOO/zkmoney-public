import type { ContractArtifact, FieldLike } from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2Hash, poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"

/** Unpacked `PaylinkNote.data` — amount + claim window timestamps. */
export type PaylinkNoteData = {
  amount: bigint
  from_claimable: bigint
  until_claimable: bigint
}

/** Claim-window phase derived from on-chain timestamps vs wall clock. */
export type PaylinkClaimWindowStatus = "gracePeriod" | "claimable" | "expired"

/** On-chain `PaylinkNote` fields returned by `sync_note()`. */
export type RawPaylinkNote = {
  hash: Fr
  sender_hash: Fr
  data: Fr
  refundable_until: Fr
  oidc_key_registry: AztecAddress
  vkey_hash: Fr
  token_address: AztecAddress
}

/** Display-ready paylink note — output of `PaylinkService.sync_notes`. */
export type PaylinkNoteView = RawPaylinkNote & {
  amount: bigint
  tokenAddress: AztecAddress
  /** Unix seconds — claim window opens (grace period ends). */
  claimableFrom: number
  /** Unix seconds — recipient claim deadline. */
  claimableUntil: number
  /** ISO 8601 of `claimableUntil`. */
  validUntil: string
  /** Same as `claimableUntil`. */
  expiresAt: number
  /** Unix seconds — end of the creator refund window, which opens at creation. */
  refundableUntil: number
  isInGracePeriod: boolean
  isClaimable: boolean
  isExpired: boolean
  /** Creator can refund now: not yet past `refundableUntil`, or past `claimableUntil`. */
  isRefundable: boolean
  status: PaylinkClaimWindowStatus
}

function fieldToBytes(data: FieldLike): Buffer {
  return toFr(data).toBuffer()
}

function toFr(data: FieldLike): Fr {
  return data instanceof Fr ? data : Fr.fromString(String(data))
}

function fieldToBigInt(data: FieldLike): bigint {
  return toFr(data).toBigInt()
}

/**
 * Mirrors `paylink_note::unpack_data` — decodes the packed `PaylinkNote.data` field
 * (u128 amount + u64 from_claimable + u64 until_claimable, big-endian in 32 bytes).
 */
export function unpackPaylinkData(data: FieldLike): PaylinkNoteData {
  const bytes = fieldToBytes(data)
  if (bytes.length !== 32) {
    throw new Error(`unpackPaylinkData: expected 32-byte field, got ${bytes.length}`)
  }

  let amount = 0n
  for (let i = 0; i < 16; i++) {
    amount = amount * 256n + BigInt(bytes[i]!)
  }

  let from_claimable = 0n
  for (let i = 0; i < 8; i++) {
    from_claimable = from_claimable * 256n + BigInt(bytes[16 + i]!)
  }

  let until_claimable = 0n
  for (let i = 0; i < 8; i++) {
    until_claimable = until_claimable * 256n + BigInt(bytes[24 + i]!)
  }

  return { amount, from_claimable, until_claimable }
}

/** Mirrors `paylink_note::pack_data`. */
export function packPaylinkData(amount: bigint, fromClaimable: bigint, untilClaimable: bigint): Fr {
  return new Fr((amount << 128n) | (fromClaimable << 64n) | untilClaimable)
}

/** Mirrors the deposit's `sender_hash`, which binds refund rights to the funder. */
export function paylinkSenderHash(sender: AztecAddress): Promise<Fr> {
  return poseidon2Hash([sender.toField()])
}

/** "PLTM", as `paylink_note::paylink_terms` separates it. */
const TERMS_SEPARATOR = 0x504c544d

/**
 * Mirrors `paylink_note::paylink_terms`: one hash over every note field. A link carries it and a
 * claim asserts it, so a link opens only the escrow it was made for.
 */
export function paylinkTerms(note: RawPaylinkNote): Promise<Fr> {
  return poseidon2HashWithSeparator(
    [
      note.hash,
      note.sender_hash,
      note.data,
      note.refundable_until,
      note.oidc_key_registry.toField(),
      note.vkey_hash,
      note.token_address.toField(),
    ],
    TERMS_SEPARATOR,
  )
}

export const PAYLINK_TERMS_REFUSAL = "This link doesn't match its escrow"

/** Refuse a note other than the one the link was made for. */
export async function assertPaylinkTerms(
  link: { terms?: Fr },
  note: RawPaylinkNote,
): Promise<void> {
  if (link.terms && !(await paylinkTerms(note)).equals(link.terms)) {
    throw new Error(PAYLINK_TERMS_REFUSAL)
  }
}

/**
 * The trailing `terms` a claim on an escrow of this artifact takes; none on a class made before
 * them. A link without terms, made before them or rebuilt by a resync from its creator's own
 * funding transfer, claims against the note it reads.
 */
export async function claimTermsArgs(
  artifact: ContractArtifact,
  link: { terms?: Fr },
  readNote: () => Promise<RawPaylinkNote>,
): Promise<Fr[]> {
  const claim = artifact.functions.find((f) => f.name === "claim")
  if (!claim?.parameters.some((p) => p.name === "terms")) return []
  return [link.terms ?? (await paylinkTerms(await readNote()))]
}

/** Shape a raw synced note into display-ready fields (amount, valid until, expiry status). */
export function buildPaylinkNoteView(
  raw: RawPaylinkNote,
  nowSec: number = Math.floor(Date.now() / 1000),
): PaylinkNoteView {
  const { amount, from_claimable, until_claimable } = unpackPaylinkData(raw.data)
  const claimableFrom = Number(from_claimable)
  const claimableUntil = Number(until_claimable)
  const refundableUntil = Number(fieldToBigInt(raw.refundable_until))
  const isInGracePeriod = nowSec < claimableFrom
  const isExpired = nowSec > claimableUntil
  const isClaimable = !isInGracePeriod && !isExpired
  const isRefundable = nowSec <= refundableUntil || isExpired

  const status: PaylinkClaimWindowStatus = isInGracePeriod
    ? "gracePeriod"
    : isExpired
    ? "expired"
    : "claimable"

  return {
    ...raw,
    amount,
    tokenAddress: raw.token_address,
    claimableFrom,
    claimableUntil,
    validUntil: new Date(claimableUntil * 1000).toISOString(),
    expiresAt: claimableUntil,
    refundableUntil,
    isInGracePeriod,
    isClaimable,
    isExpired,
    isRefundable,
    status,
  }
}

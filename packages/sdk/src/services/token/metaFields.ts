/**
 * The byte layout shared by the oxide token's `meta` passthroughs: a flat stream packed 31 bytes
 * per Field, big-endian in each field's low bytes with the top byte zero, so every field stays
 * below the modulus.
 */

import { Fr } from "@aztec-labs/aztec.js/fields"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"

export const BYTES_PER_FIELD = 31

export function metaCapacity(fieldCount: number): number {
  return fieldCount * BYTES_PER_FIELD
}

/** `buf` must be exactly `metaCapacity(fieldCount)` bytes. */
export function packMetaFields(buf: Buffer, fieldCount: number): Fr[] {
  const meta: Fr[] = []
  for (let i = 0; i < fieldCount; i++) {
    const chunk = buf.subarray(i * BYTES_PER_FIELD, (i + 1) * BYTES_PER_FIELD)
    meta.push(
      Fr.fromBuffer(Buffer.concat([Buffer.alloc(Fr.SIZE_IN_BYTES - BYTES_PER_FIELD), chunk])),
    )
  }
  return meta
}

/** Inverse of `packMetaFields`. Undefined when `meta` is short or a field does not parse. */
export function unpackMetaFields(
  meta: readonly FieldLike[] | undefined,
  fieldCount: number,
): Buffer | undefined {
  if (!meta || meta.length < fieldCount) return undefined
  try {
    return Buffer.concat(
      meta.slice(0, fieldCount).map((f) =>
        fieldLikeToFr(f)
          .toBuffer()
          .subarray(Fr.SIZE_IN_BYTES - BYTES_PER_FIELD),
      ),
    )
  } catch {
    return undefined
  }
}

export function fieldLikeToFr(v: FieldLike): Fr {
  if (v instanceof Fr) return v
  if (Buffer.isBuffer(v)) return Fr.fromBuffer(v)
  if (typeof v === "object") return v.toField()
  return new Fr(v)
}

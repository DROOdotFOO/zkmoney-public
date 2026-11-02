import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"

/** Declared width of PasswordFPC's password argument (`str<31>`). */
export const FPC_PASSWORD_MAX_LENGTH = 31

/**
 * Compute the password hash PasswordFPC stores, mirroring its `get_password_hash`.
 *
 * `FieldCompressedString` packs a `str<31>` into one field: the 31 characters zero-filled to the
 * declared width and read big-endian, which leaves the field's top byte clear. The hash is a
 * poseidon2 over that single field.
 *
 * The FPC's bootstrap constructor takes this hash rather than the password, because the caller
 * derives the contract address from the initializer arguments before the contract exists.
 */
export async function computeFpcPasswordHash(password: string): Promise<Fr> {
  if (password.length > FPC_PASSWORD_MAX_LENGTH) {
    throw new Error(
      `FPC password must be at most ${FPC_PASSWORD_MAX_LENGTH} characters, got ${password.length}`,
    )
  }
  const packed = Buffer.alloc(Fr.SIZE_IN_BYTES)
  const chars = Buffer.from(password, "utf8")
  if (chars.length > FPC_PASSWORD_MAX_LENGTH) {
    throw new Error("FPC password must be ASCII: multi-byte characters exceed the declared width")
  }
  chars.copy(packed, Fr.SIZE_IN_BYTES - FPC_PASSWORD_MAX_LENGTH)
  return await poseidon2Hash([Fr.fromBuffer(packed)])
}

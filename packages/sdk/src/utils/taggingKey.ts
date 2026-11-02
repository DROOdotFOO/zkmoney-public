import { sha512ToGrumpkinScalar } from "@aztec-labs/foundation/crypto/sha512"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import type { Fr } from "@aztec-labs/foundation/curves/bn254"
import { DomainSeparator } from "@aztec-labs/constants"

/**
 * Derive the tagging secret key from the account's master secret.
 * Standard Aztec derivation: sha512ToGrumpkinScalar([secretKey, DomainSeparator.TSK_M]).
 */
export function deriveTaggingSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.TSK_M])
}

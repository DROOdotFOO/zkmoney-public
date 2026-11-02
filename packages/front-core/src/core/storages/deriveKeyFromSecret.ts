import type { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"

import { DOMAIN_SEPARATORS } from "./derived-key-domains"

/**
 * Single source of truth for deriving a 32-byte symmetric key from the master
 * secret and a domain separator.
 *
 * `poseidon2HashWithSeparator([secret], separator)` returns an `Fr` (a BN254
 * field element); `toBuffer()` always yields exactly 32 bytes (the top ~2 bits
 * are structurally zero, ~2^253.6 of key space — cryptographically irrelevant
 * for a local symmetric key). `AlphaAuthService.getDerivedKey`
 * implementations and the XMTP DB-key path delegate here so the derived bytes are identical by
 * construction rather than by copied conversion.
 *
 * The `domain` is looked up against {@link DOMAIN_SEPARATORS}; an unknown domain
 * throws before any hashing. Callers that already hold a typed
 * `KnownDerivedKeyDomain` get compile-time safety; the runtime check guards
 * `string`-typed callers (the `getDerivedKey(domain: string)` interface).
 */
export async function deriveKeyFromSecret(secret: Fr, domain: string): Promise<Uint8Array> {
  const separator = DOMAIN_SEPARATORS[domain]
  if (separator === undefined) {
    throw new Error(`Unknown derived-key domain: ${domain}`)
  }
  const derivedFr = await poseidon2HashWithSeparator([secret], separator)
  const key = new Uint8Array(derivedFr.toBuffer())
  if (key.length !== 32) {
    throw new Error(`Derived key for domain "${domain}" must be 32 bytes (got ${key.length})`)
  }
  return key
}

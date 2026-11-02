import { BN254_FR_MODULUS, MSK_PRF_SALT } from "@obsidion/core/constants"
import { bytesToHex, hexToBytes } from "./ceremony/bytes.js"

/**
 * WebAuthn PRF contextualization `K(x) = SHA-256("WebAuthn PRF" ‖ 0x00 ‖ x)`: the transform a
 * browser applies to a PRF salt before the authenticator sees it. Computed here for `eval.second`
 * so a provider that passes the salt through unchanged still lands the browser-reproducible value.
 */
export async function contextualize(canonical: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is required to contextualize the PRF salt")
  }
  const prefix = new TextEncoder().encode("WebAuthn PRF")
  const buf = new Uint8Array(prefix.length + 1 + canonical.length)
  buf.set(prefix, 0)
  buf[prefix.length] = 0x00
  buf.set(canonical, prefix.length + 1)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf))
}

export type PrfSalts = { prfFirstSalt: Uint8Array; prfSecondSalt: Uint8Array }

let secondSalt: Promise<Uint8Array> | undefined

/** Both salts every ceremony sends: the canonical salt in `first`, its contextualisation in `second`. */
export function prfSalts(): Promise<PrfSalts> {
  secondSalt ??= contextualize(MSK_PRF_SALT).catch((err: unknown) => {
    secondSalt = undefined
    throw err
  })
  return secondSalt.then((prfSecondSalt) => ({ prfFirstSalt: MSK_PRF_SALT, prfSecondSalt }))
}

/**
 * The master key from a PRF output: 32 uniformly random bytes reduced into the BN254 scalar field
 * (the modulo bias is cryptographically negligible), as 32 big-endian bytes. Exactly 32 bytes in:
 * a shorter value is not a PRF output and a longer one is a malformed slot, and neither may reduce
 * into a derivable-but-wrong key. Pinned to the sdk's `Fr` derivation by the shared vectors.
 */
export function deriveMskFromPrf(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) {
    throw new Error(`PRF output must be exactly 32 bytes, got ${prfOutput.length}`)
  }
  const scalar = BigInt(`0x${bytesToHex(prfOutput)}`) % BN254_FR_MODULUS
  return hexToBytes(scalar.toString(16).padStart(64, "0"))
}

/** `deriveMskFromPrf` as the 0x-prefixed 64-digit hex `Fr.toString()` yields. */
export function deriveMskHexFromPrf(prfOutput: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(deriveMskFromPrf(prfOutput))}`
}

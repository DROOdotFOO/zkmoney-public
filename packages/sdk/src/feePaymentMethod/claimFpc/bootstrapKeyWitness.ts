/**
 * The witnesses ClaimFPC's registration gate takes to prove the prover holds a bootstrap key, without revealing it.
 *
 * The gate verifies an ECDSA signature made with nonce 1 (`r = x(G)`, `s = z + r*k mod n`), which passes exactly when
 * `k` is `sk` or `-2z/r - sk`. The gate admits only the one with low `s`, so `k` is unique per key and keys the
 * subscription nullifier. `k` reveals `sk`: it never leaves the prover.
 * `bootstrap_key.nr` in the ClaimFPC is the circuit side, and the shared test fixtures keep the two in step.
 */
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "viem"

const N = secp256k1.CURVE.n

/** x(G): the r of a nonce-1 signature. */
const NONCE_ONE_R = secp256k1.CURVE.Gx

/** The message hash the nonce-1 signature signs: ASCII "ZKMONEY_SUBSCRIPTION_KEY_V1", zero padded. */
export const KEY_PROOF_Z = BigInt(
  bytesToHex(new TextEncoder().encode("ZKMONEY_SUBSCRIPTION_KEY_V1")).padEnd(66, "0"),
)

/** The registration gate's key witnesses for a bootstrap private key. */
export interface BootstrapKeyProof {
  bootstrapPubKeyX: Uint8Array // 32
  bootstrapPubKeyY: Uint8Array // 32
  keyWitness: Uint8Array // 32
}

/** The one `k` the gate admits for `privateKey`. */
export function bootstrapKeyWitness(privateKey: bigint): bigint {
  const s = mod(KEY_PROOF_Z + NONCE_ONE_R * privateKey)
  if (s <= (N - 1n) / 2n) return privateKey
  return mod(-2n * KEY_PROOF_Z * invert(NONCE_ONE_R) - privateKey)
}

export function bootstrapKeyProof(privateKey: bigint): BootstrapKeyProof {
  const publicKey = secp256k1.getPublicKey(hexToBytes(bytes32(privateKey)), false)
  return {
    bootstrapPubKeyX: publicKey.slice(1, 33),
    bootstrapPubKeyY: publicKey.slice(33, 65),
    keyWitness: hexToBytes(bytes32(bootstrapKeyWitness(privateKey))),
  }
}

function mod(value: bigint): bigint {
  return ((value % N) + N) % N
}

function invert(value: bigint): bigint {
  let result = 1n
  let base = mod(value)
  for (let exponent = N - 2n; exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = (result * base) % N
    base = (base * base) % N
  }
  return result
}

function bytes32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`
}

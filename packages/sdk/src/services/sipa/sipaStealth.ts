/**
 * Recipient-side SIPA stealth crypto — pure-JS mirrors of oxide's
 * `resolver-lib/src/resolution.ts` + `oxide-lib/src/content_hash.ts`
 * (themselves TS mirrors of `noir-projects/resolver_circuit`), pinned to the
 * circuit's `valid()` fixture in the colocated tests. oxide's resolver-lib
 * rides native libsecp256k1 bindings, which don't load in a browser, so
 * the secp256k1 ops here are `@noble/curves` instead.
 *
 * A SIPA's salt has two origins: the resolver's ECDH shared secret
 * (`deriveSharedSecret`) for a resolver-issued SIPA, and `deriveSelfSipaSecret`
 * for one the wallet derives itself. Either way the discovered SIPA event
 * carries the salt, and the recipient commitment and recovery key derive from
 * it with no ECDH and no day/nonce search.
 *
 * Pure compute only — no contract call, no RPC, no storage.
 */

import { toBufferBE } from "@aztec-labs/foundation/bigint-buffer"
import { DomainSeparator } from "@aztec-labs/constants"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { secp256k1 } from "@noble/curves/secp256k1"

// Constants copied from oxide's generated source
// (`oxide-lib/src/oxide_constants.gen.ts`), refreshed per vendor re-pin and
// pinned by the circuit-fixture tests.
export const MAX_NONCE = 1_000_000
const DOM_SEP__STEALTH_K = 0x8b6a41145c2309231109ae29649177a76f92d7df34703281d44018b565e9f3n

/** Wallet-owned separator for self-derived salts; oxide has no counterpart, by design. */
const DOM_SEP__SELF_SIPA_SALT = Buffer.from("obsidion:self-sipa-salt")

const CURVE_ORDER = secp256k1.CURVE.n

/** An uncompressed secp256k1 point (oxide's `K1Point` wire shape). */
export interface SipaK1Point {
  x: bigint
  y: bigint
}

function toPoint(point: SipaK1Point) {
  const projective = secp256k1.ProjectivePoint.fromAffine({ x: point.x, y: point.y })
  // Mirrors resolver-lib's assertOnCurve — an off-curve "point" must never
  // reach the scalar multiplication.
  projective.assertValidity()
  return projective
}

function assertU32(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} is not a u32: ${value}`)
  }
}

function assertSipaCoordinates(day: number, nonce: number) {
  assertU32(day, "day")
  assertU32(nonce, "nonce")
  if (nonce >= MAX_NONCE) {
    throw new Error(`nonce out of range: ${nonce} >= ${MAX_NONCE}`)
  }
}

function assertScalar(value: bigint, name: string) {
  if (value <= 0n || value >= CURVE_ORDER) {
    throw new Error(`${name} not in field`)
  }
}

/**
 * The scalar `k = H(DOM_SEP__STEALTH_K, day, nonce)` that tweaks the private
 * key before the ECDH step. A BN254 digest fits the secp256k1 scalar field,
 * so the reinterpretation never reduces; `k` is public and deterministic,
 * not key material.
 */
function computeStealthTweak(day: number, nonce: number): bigint {
  assertSipaCoordinates(day, nonce)
  return sha256ToField([
    new Fr(DOM_SEP__STEALTH_K).toBuffer(),
    toBufferBE(BigInt(day), 32),
    toBufferBE(BigInt(nonce), 32),
  ]).toBigInt()
}

/**
 * The bilinear ECDH shared secret
 * `SHA256((counterpartyPub · (ownPriv · k)).x ‖ .y)` — symmetric, so the
 * recipient calls it as `(resolverPublicKey, userPrivateKey, day, nonce)`
 * to reproduce what the resolver derived as `(userPub, resolverPriv, …)`.
 */
export function deriveSharedSecret(
  counterpartyPublicKey: SipaK1Point,
  ownPrivateKey: bigint,
  day: number,
  nonce: number,
): Fr {
  const point = toPoint(counterpartyPublicKey)
  assertScalar(ownPrivateKey, "private key")
  const k = computeStealthTweak(day, nonce)
  const combined = (ownPrivateKey * k) % CURVE_ORDER
  if (combined === 0n) {
    throw new Error("stealth tweak degenerated to a zero scalar")
  }
  const sharedPoint = point.multiply(combined).toRawBytes(false)
  return sha256ToField([Buffer.from(sharedPoint.subarray(1, 65))])
}

/**
 * The salt of a wallet-derived SIPA at `(day, nonce)`. Same coordinates as the
 * resolver's ECDH salt, so slots, ledgers and resumes keep their shape, but
 * hashed from a key the resolver never sees: the resolver can replay its own
 * ECDH against the registry stealth key for any `(day, nonce)`, and that would
 * reproduce the wallet's addresses, recipient commitments and recovery
 * commitments. This key is never registered, so it cannot.
 */
export function deriveSelfSipaSecret(selfSipaKey: Fr, day: number, nonce: number): Fr {
  if (selfSipaKey.isZero()) {
    throw new Error("self SIPA key is zero")
  }
  assertSipaCoordinates(day, nonce)
  return sha256ToField([
    DOM_SEP__SELF_SIPA_SALT,
    selfSipaKey.toBuffer(),
    toBufferBE(BigInt(day), 32),
    toBufferBE(BigInt(nonce), 32),
  ])
}

/**
 * oxide's `computeRecipientCommitment`:
 * `poseidon2HashWithSeparator([sharedSecretSalt, recipient], SECRET_HASH)` — the
 * recipient commitment a SIPA is bound to on L1 and the L2 claim asserts
 * against. Implemented locally (pure hash) rather than through the vendored
 * package's native bindings; pinned to the circuit fixture in tests.
 */
export function computeStealthRecipientHash(
  sharedSecretSalt: Fr,
  recipient: AztecAddress,
): Promise<Fr> {
  return poseidon2HashWithSeparator(
    [sharedSecretSalt, recipient.toField()],
    DomainSeparator.SECRET_HASH,
  )
}

function pointToEthAddress(point: ReturnType<typeof toPoint>): EthAddress {
  const uncompressed = point.toRawBytes(false)
  return new EthAddress(keccak256(Buffer.from(uncompressed.subarray(1, 65))).subarray(12))
}

/**
 * The SIPA's recovery address: the point `userPub + sharedSecret·G`. Only
 * the user can compute the matching private key (see
 * {@link deriveRecoveryPrivateKey}).
 */
export function deriveRecoveryAddress(userPublicKey: SipaK1Point, sharedSecret: Fr): EthAddress {
  const base = toPoint(userPublicKey)
  const tweak = sharedSecret.toBigInt()
  // A BN254 field element always fits the secp256k1 scalar field, so no
  // reduction is needed; a zero tweak leaves the point untouched (mirrors
  // resolver-lib, where libsecp rejects a zero tweakAdd).
  const recoveryPoint =
    tweak === 0n ? base : base.add(secp256k1.ProjectivePoint.BASE.multiply(tweak))
  return pointToEthAddress(recoveryPoint)
}

/**
 * The private key behind {@link deriveRecoveryAddress}:
 * `userPrivateKey + sharedSecret mod n`. For a discovered note this is a
 * single scalar add (`sharedSecret` = the note's `message_secret`) — no
 * search. Handle like any private key: sign with it, never persist it.
 */
export function deriveRecoveryPrivateKey(userPrivateKey: bigint, sharedSecret: Fr): bigint {
  assertScalar(userPrivateKey, "private key")
  const key = (userPrivateKey + sharedSecret.toBigInt()) % CURVE_ORDER
  if (key === 0n) {
    throw new Error("recovery key degenerated to zero")
  }
  return key
}

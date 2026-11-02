import { describe, expect, it } from "vitest"
import { secp256k1 } from "@noble/curves/secp256k1"
import { invert, mod } from "@noble/curves/abstract/modular"
import { bytesToHex } from "viem"
import {
  bootstrapKeyProof,
  bootstrapKeyWitness,
  KEY_PROOF_Z,
} from "../../../src/feePaymentMethod/claimFpc/bootstrapKeyWitness.js"

// Same fixtures as claim_fpc's bootstrap_key.nr tests: key 1's witness is -2z/r - 1, key 2's is 2.
const KEY_ONE_LOW = 0xd931f7b72d72ecffd88650190529c1105a3e85b5c3152395c086ee90df9c1f04n
const KEY_TWO_HIGH = 0xd931f7b72d72ecffd88650190529c1105a3e85b5c3152395c086ee90df9c1f03n

const N = secp256k1.CURVE.n
const G = secp256k1.ProjectivePoint.BASE
const lowS = (k: bigint) => (KEY_PROOF_Z + secp256k1.CURVE.Gx * k) % N <= (N - 1n) / 2n

describe("bootstrap key witness", () => {
  it("takes the companion witness when the key's own s is high", () => {
    expect(lowS(1n)).toBe(false)
    expect(bootstrapKeyWitness(1n)).toBe(KEY_ONE_LOW)
  })

  it("takes the key itself when its s is low", () => {
    expect(lowS(KEY_TWO_HIGH)).toBe(false)
    expect(bootstrapKeyWitness(2n)).toBe(2n)
  })

  it("always lands on the low-s one of the key and its companion -2z/r - key", () => {
    const r = secp256k1.CURVE.Gx
    for (const key of [
      3n,
      0xabcdefn,
      N - 1n,
      0x2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80910n,
    ]) {
      const companion = mod(-2n * KEY_PROOF_Z * invert(r, N) - key, N)
      const k = bootstrapKeyWitness(key)
      expect([key, companion]).toContain(k)
      expect(lowS(k)).toBe(true)
      expect(lowS(k === key ? companion : key)).toBe(false)
    }
  })

  it("carries the uncompressed public key the gate hashes into the bootstrap address", () => {
    const proof = bootstrapKeyProof(2n)
    const point = G.multiply(2n).toAffine()
    expect(BigInt(bytesToHex(proof.bootstrapPubKeyX))).toBe(point.x)
    expect(BigInt(bytesToHex(proof.bootstrapPubKeyY))).toBe(point.y)
    expect(BigInt(bytesToHex(proof.keyWitness))).toBe(2n)
  })
})

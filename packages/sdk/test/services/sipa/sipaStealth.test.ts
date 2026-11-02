// @vitest-environment node
/**
 * SIPA stealth crypto — pinned to the `valid()` fixture in oxide's
 * `resolver_circuit/src/main.nr` (the same vector oxide's resolver-lib pins
 * against), so this pure-JS mirror can never drift from the circuit without
 * a test failure. The eth-address vectors come from the circuit's
 * `eth_address_of_{2,3}g` tests.
 */

import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import {
  MAX_NONCE,
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  deriveRecoveryPrivateKey,
  deriveSelfSipaSecret,
  deriveSharedSecret,
  type SipaK1Point,
} from "../../../src/services/sipa/sipaStealth.js"
import { selfSipaNonce } from "../../../src/services/sipa/sipaSelfResolve.js"

const CURVE_ORDER = secp256k1.CURVE.n

/** Copy of the circuit's `valid()` fixture. */
const fixture = {
  day: 20000,
  nonce: 42,
  userPublicKey: {
    x: 0x88e2ddeb04657dbd0edadf9c1f98da3b3895faa1f00527934dd35d17542ffe9bn,
    y: 0x1e7640d7737e24e36d208effb77e86affe670a9a497aa7fb52bf4e687a17fff4n,
  } satisfies SipaK1Point,
  resolverPublicKey: {
    x: 0xbb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020dn,
    y: 0xecddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4n,
  } satisfies SipaK1Point,
  userL2Address: 0x0ead00000000000000000000000000000000000000000000000000000000bee0n,
  resolverPrivateKey: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn,
  expectedRecipientCommitment: 0x2d2b85117fb7b9c18c24f74d964a952070dc83713469c0493c8ac1bcbed0e171n,
  expectedRecoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
}

function pointOf(scalar: bigint): SipaK1Point {
  const { x, y } = secp256k1.ProjectivePoint.BASE.multiply(scalar).toAffine()
  return { x, y }
}

describe("circuit fixture", () => {
  it("derives the recipient commitment of the circuit fixture", async () => {
    const sharedSecret = deriveSharedSecret(
      fixture.userPublicKey,
      fixture.resolverPrivateKey,
      fixture.day,
      fixture.nonce,
    )
    const recipientCommitment = await computeStealthRecipientHash(
      sharedSecret,
      AztecAddress.fromBigIntUnsafe(fixture.userL2Address),
    )
    expect(recipientCommitment.toBigInt()).toBe(fixture.expectedRecipientCommitment)
  })

  it("derives the recovery address of the circuit fixture", () => {
    const sharedSecret = deriveSharedSecret(
      fixture.userPublicKey,
      fixture.resolverPrivateKey,
      fixture.day,
      fixture.nonce,
    )
    expect(deriveRecoveryAddress(fixture.userPublicKey, sharedSecret).toString()).toBe(
      fixture.expectedRecoveryAddress,
    )
  })
})

describe("deriveSharedSecret", () => {
  it("is symmetric — the recipient side (resolverPub, userPriv) reproduces the resolver side", () => {
    const userPrivateKey = 0xa11cen
    const resolverPrivateKey = 0xb0bn
    const asResolver = deriveSharedSecret(pointOf(userPrivateKey), resolverPrivateKey, 123, 4)
    const asUser = deriveSharedSecret(pointOf(resolverPrivateKey), userPrivateKey, 123, 4)
    expect(asResolver.toBigInt()).toBe(asUser.toBigInt())
  })

  it("rejects a nonce at MAX_NONCE, like the circuit", () => {
    expect(() =>
      deriveSharedSecret(fixture.userPublicKey, fixture.resolverPrivateKey, fixture.day, MAX_NONCE),
    ).toThrow(/nonce out of range/)
  })

  it("rejects an off-curve public key", () => {
    const offCurve = { x: fixture.userPublicKey.x, y: fixture.userPublicKey.y + 1n }
    expect(() =>
      deriveSharedSecret(offCurve, fixture.resolverPrivateKey, fixture.day, fixture.nonce),
    ).toThrow()
  })

  it("rejects a private key outside the scalar field", () => {
    for (const bad of [0n, CURVE_ORDER]) {
      expect(() =>
        deriveSharedSecret(fixture.userPublicKey, bad, fixture.day, fixture.nonce),
      ).toThrow(/not in field/)
    }
  })
})

describe("deriveSelfSipaSecret", () => {
  const selfKey = new Fr(0x5e1fn)

  it("matches the pinned vector", () => {
    expect(deriveSelfSipaSecret(selfKey, fixture.day, fixture.nonce).toString()).toBe(
      "0x00e62ccd5bf6b8907a7be2014772e5987bffee07f3601275b2e7f755e429ecc1",
    )
  })

  it("rejects a zero key and the circuit's nonce bound", () => {
    expect(() => deriveSelfSipaSecret(new Fr(0n), 123, 4)).toThrow(/zero/)
    expect(() => deriveSelfSipaSecret(selfKey, 123, MAX_NONCE)).toThrow(/nonce out of range/)
    expect(() => deriveSelfSipaSecret(selfKey, -1, 4)).toThrow(/u32/)
  })

  it("is not what the resolver derives for the wallet's slots from the registry stealth key", () => {
    for (const slot of [0, 1, 2]) {
      const nonce = selfSipaNonce(slot)
      const asResolver = deriveSharedSecret(
        fixture.userPublicKey,
        fixture.resolverPrivateKey,
        fixture.day,
        nonce,
      )
      expect(asResolver.equals(deriveSelfSipaSecret(selfKey, fixture.day, nonce))).toBe(false)
    }
  })

  it("yields a recovery key pair like any other salt", () => {
    const userPrivateKey = 0x5eedn
    const salt = deriveSelfSipaSecret(selfKey, 123, 4)
    const recoveryKey = deriveRecoveryPrivateKey(userPrivateKey, salt)
    expect(deriveRecoveryAddress(pointOf(recoveryKey), new Fr(0n)).toString()).toBe(
      deriveRecoveryAddress(pointOf(userPrivateKey), salt).toString(),
    )
  })
})

describe("recovery key pair", () => {
  it("a zero shared secret leaves the user's own address (mirrors resolver-lib)", () => {
    // Doubles as the pin for point→address: the circuit's eth_address_of_{2,3}g vectors.
    expect(deriveRecoveryAddress(pointOf(2n), new Fr(0n)).toString()).toBe(
      "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
    )
    expect(deriveRecoveryAddress(pointOf(3n), new Fr(0n)).toString()).toBe(
      "0x6813eb9362372eef6200f3b1dbc3f819671cba69",
    )
  })

  it("rejects a user private key outside the scalar field", () => {
    expect(() => deriveRecoveryPrivateKey(0n, new Fr(1n))).toThrow(/not in field/)
    expect(() => deriveRecoveryPrivateKey(CURVE_ORDER, new Fr(1n))).toThrow(/not in field/)
  })
})

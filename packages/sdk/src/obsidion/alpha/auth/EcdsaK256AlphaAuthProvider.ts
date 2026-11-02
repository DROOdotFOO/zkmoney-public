import { Fr } from "@aztec-labs/aztec.js/fields"
import { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import { Ecdsa } from "@aztec-labs/foundation/crypto/ecdsa"
import type { AlphaAuthProvider } from "./AlphaAuthProvider.js"
import { MAX_WITNESS_LEN, PASSKEY_SET_INDEX } from "../../../utils/constants.js"
import {
  type AlphaPasskeySet,
  MAX_ACCOUNT_PASSKEYS,
  lazyPasskeySet,
  providerPasskeySet,
  pubkeyHexOf,
} from "../account/alphaPasskeySet.js"

const PUBKEY_X_INDEX = 0
const PUBKEY_Y_INDEX = 32
const SIGNATURE_INDEX = 64

/**
 * ECDSA K256 auth provider for alpha account testing.
 *
 * Witness layout:
 *   [0..31]:    pub_key_x (32 bytes)
 *   [32..63]:   pub_key_y (32 bytes)
 *   [64..127]:  signature (64 bytes)
 *   [485..492]: passkey-set slots
 */
export class EcdsaK256AlphaAuthProvider implements AlphaAuthProvider {
  private readonly passkeys: readonly string[] | undefined
  private readonly passkeySet = lazyPasskeySet(() =>
    pubkeyHexOf(this).then((own) => providerPasskeySet(own, this.passkeys)),
  )

  /** `passkeys` is the set this key signs for (x‖y hex, any order); it defaults to the key alone. */
  constructor(private signingKey: Buffer, passkeys?: readonly string[]) {
    this.passkeys = passkeys && [...passkeys]
  }

  async getPubkeys(): Promise<[Buffer, Buffer]> {
    const publicKey = await new Ecdsa().computePublicKey(this.signingKey)
    return [publicKey.subarray(0, 32), publicKey.subarray(32, 64)]
  }

  getPasskeySet(): Promise<AlphaPasskeySet> {
    return this.passkeySet()
  }

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const set = await this.getPasskeySet()
    const witness: Fr[] = new Array(MAX_WITNESS_LEN).fill(Fr.ZERO)

    const [pubkeyX, pubkeyY] = await this.getPubkeys()
    for (let i = 0; i < 32; i++) {
      witness[PUBKEY_X_INDEX + i] = new Fr(pubkeyX[i]!)
      witness[PUBKEY_Y_INDEX + i] = new Fr(pubkeyY[i]!)
    }

    const signature = await new Ecdsa().constructSignature(messageHash.toBuffer(), this.signingKey)
    const signatureBytes = [...signature.r, ...signature.s]
    for (let i = 0; i < 64; i++) {
      witness[SIGNATURE_INDEX + i] = new Fr(signatureBytes[i]!)
    }

    for (let i = 0; i < MAX_ACCOUNT_PASSKEYS; i++) {
      witness[PASSKEY_SET_INDEX + i] = set.slots[i]!
    }

    return new AuthWitness(messageHash, witness)
  }
}

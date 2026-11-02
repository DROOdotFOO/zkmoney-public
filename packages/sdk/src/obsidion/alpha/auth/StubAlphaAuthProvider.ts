import { Fr } from "@aztec-labs/aztec.js/fields"
import { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import type { AlphaAuthProvider } from "./AlphaAuthProvider.js"
import { MAX_WITNESS_LEN } from "../../../utils/constants.js"
import {
  type AlphaPasskeySet,
  alphaPasskeySet,
  lazyPasskeySet,
} from "../account/alphaPasskeySet.js"

/**
 * No-op auth provider used only during kernelless simulation against the
 * `ObsidionAccountAlphaSimulated` stub. The stub artifact strips
 * `validate` from every entrypoint, so the pubkey, signature and passkey-set
 * fields carried in the witness are never read. Returning a zeroed witness
 * keeps the AuthWitness wire shape identical to the real providers (PXE
 * expects exactly `MAX_WITNESS_LEN` fields), so the simulation txRequest is
 * structurally well-formed even though no signing actually happened.
 *
 * Do NOT use outside the simulation path. The real `ObsidionAccountAlpha`
 * class on chain WILL read the witness and the zeroed bytes will fail
 * `verify_webauthn_p256`.
 */
export class StubAlphaAuthProvider implements AlphaAuthProvider {
  private readonly passkeySet = lazyPasskeySet(() => alphaPasskeySet(["00".repeat(64)]))

  async getPubkeys(): Promise<[Buffer, Buffer]> {
    return [Buffer.alloc(32), Buffer.alloc(32)]
  }

  /** The set of the zero key; nothing validates it. */
  getPasskeySet(): Promise<AlphaPasskeySet> {
    return this.passkeySet()
  }

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    return new AuthWitness(messageHash, new Array(MAX_WITNESS_LEN).fill(Fr.ZERO))
  }
}

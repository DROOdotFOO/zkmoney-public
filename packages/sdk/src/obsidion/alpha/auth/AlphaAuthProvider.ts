import type { AuthWitnessProvider } from "@aztec-labs/entrypoints/interfaces"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import type { AlphaPasskeySet } from "../account/alphaPasskeySet.js"

/**
 * Auth provider interface for alpha (non-module) accounts: a signing key plus the passkey set it
 * belongs to. The set is committed into the account address, so the account layer derives the
 * address from `getPasskeySet()`, and every witness the provider produces carries the set's slots.
 *
 * Witness layout (alpha, no module prefix):
 *   [0..31]:    pub_key_x (32 bytes)
 *   [32..63]:   pub_key_y (32 bytes)
 *   [64..484]:  scheme-specific signature data
 *   [485..492]: passkey-set slots (`PASSKEY_SET_INDEX`)
 */
export interface AlphaAuthProvider extends AuthWitnessProvider {
  getPubkeys(): Promise<[Buffer, Buffer]>
  /** The set this provider signs for; rejects when its own key is not a member. */
  getPasskeySet(): Promise<AlphaPasskeySet>
  /** `signal` ends the signature's ceremony, including any wait before its prompt opens. */
  createAuthWit(messageHash: Fr, opts?: { signal?: AbortSignal }): Promise<AuthWitness>
}

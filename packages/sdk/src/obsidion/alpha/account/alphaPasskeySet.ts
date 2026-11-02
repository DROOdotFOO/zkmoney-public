import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
  computePasskeyHash,
  computePasskeySetImmutablesHash,
  passkeySetSlots,
} from "@oxide/oxide-lib/account_address.js"
import { MAX_ACCOUNT_PASSKEYS } from "@oxide/oxide-lib/oxide_constants.gen.js"
import type { AlphaAuthProvider } from "../auth/AlphaAuthProvider.js"

export { MAX_ACCOUNT_PASSKEYS }

/**
 * The passkey set an account commits to: `immutablesHash` is the account's `immutables_hash`, and
 * `slots` is what every witness carries. `keys` and `commitments` are in slot order.
 */
export interface AlphaPasskeySet {
  /** Normalized x‖y hex keys (64 bytes, lowercase, no 0x), in slot order. */
  readonly keys: readonly string[]
  /** `H(pk)` per key, same order as `keys` (oxide `computePasskeyHash`). */
  readonly commitments: readonly Fr[]
  /** `MAX_ACCOUNT_PASSKEYS` fields: `commitments` ascending, then zero (oxide `passkeySetSlots`). */
  readonly slots: readonly Fr[]
  /** The account's `immutables_hash` (oxide `computePasskeySetImmutablesHash(slots)`). */
  readonly immutablesHash: Fr
}

/** The 64-byte x‖y key as lowercase hex without a prefix; throws on anything else. */
export function normalizePubkeyHex(pubkeyHex: string): string {
  const raw = pubkeyHex.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{128}$/.test(raw))
    throw new Error("alphaPasskeySet: expected a 64-byte x||y key as hex")
  return raw
}

/** The x‖y hex of an auth provider's signing key, the shape every address derivation takes. */
export async function pubkeyHexOf(provider: AlphaAuthProvider): Promise<string> {
  const [x, y] = await provider.getPubkeys()
  return Buffer.concat([x, y]).toString("hex")
}

/**
 * The set of 1 to `MAX_ACCOUNT_PASSKEYS` distinct keys, given in any order. Throws on an empty or
 * oversized list, a malformed key or a duplicate. The result is frozen and shares nothing with
 * the input, so no caller can change a provider's set after the fact.
 */
export async function alphaPasskeySet(passkeys: readonly string[]): Promise<AlphaPasskeySet> {
  const keys = passkeys.map(normalizePubkeyHex)
  if (keys.length === 0 || keys.length > MAX_ACCOUNT_PASSKEYS) {
    throw new Error(
      `alphaPasskeySet: a set holds 1 to ${MAX_ACCOUNT_PASSKEYS} passkeys, not ${keys.length}`,
    )
  }
  if (new Set(keys).size !== keys.length) throw new Error("alphaPasskeySet: duplicate passkey")

  const hashed = await Promise.all(
    keys.map(async (key) => {
      const raw = Buffer.from(key, "hex")
      const commitment = await computePasskeyHash({ x: raw.subarray(0, 32), y: raw.subarray(32) })
      return { key, commitment }
    }),
  )
  const slots = passkeySetSlots(hashed.map((h) => h.commitment))
  const ordered = slots
    .slice(0, hashed.length)
    .map((slot) => hashed.find((h) => h.commitment.equals(slot))!)
  return Object.freeze({
    keys: Object.freeze(ordered.map((h) => h.key)),
    commitments: Object.freeze(ordered.map((h) => h.commitment)),
    slots: Object.freeze(slots),
    immutablesHash: await computePasskeySetImmutablesHash(slots),
  })
}

/** Whether `pubkeyHex` is a member of `set`. */
export function passkeySetHas(set: AlphaPasskeySet, pubkeyHex: string): boolean {
  return set.keys.includes(normalizePubkeyHex(pubkeyHex))
}

/**
 * The set a provider signs for: `passkeys` when given, else its own key alone. A provider whose
 * key is not a member could never satisfy the account's membership check, so it is refused here.
 */
export async function providerPasskeySet(
  ownPubkeyHex: string,
  passkeys?: readonly string[],
): Promise<AlphaPasskeySet> {
  const set = await alphaPasskeySet(passkeys ?? [ownPubkeyHex])
  if (!passkeySetHas(set, ownPubkeyHex)) {
    throw new Error("alphaPasskeySet: the provider's signing key is not in its passkey set")
  }
  return set
}

/**
 * A set computed on first use and shared by every later call. A rejection is not kept, so a
 * transient failure (hashing not ready) is retried on the next call instead of sticking to the
 * provider for its whole life.
 */
export function lazyPasskeySet(
  compute: () => Promise<AlphaPasskeySet>,
): () => Promise<AlphaPasskeySet> {
  let pending: Promise<AlphaPasskeySet> | undefined
  return () => {
    if (!pending) {
      const started = compute()
      started.catch(() => {
        if (pending === started) pending = undefined
      })
      pending = started
    }
    return pending
  }
}

import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { PrfSlot } from "@obsidion/core/types"
import type { RecoveredCandidates } from "./resolveRecoveredMsk"

/** Every candidate derived an address and none was the stored one. */
export class StoredAddressMismatchError extends Error {
  constructor() {
    super(
      "Recovered key does not match the stored account address — refusing to bind a " +
        "wrong master key (this would land on an unreachable wallet).",
    )
    this.name = "StoredAddressMismatchError"
  }
}

/**
 * R10 verify-before-commit selection. Given a dual-slot recovery result and a
 * pure (side-effect-free) address-derivation function, return the MSK to commit,
 * or throw — FAIL CLOSED — if no candidate can be safely committed.
 *
 * - `"test"`: commit the single minted candidate. There is no provider
 *   ambiguity and no synced address to verify against.
 * - `"webauthn"` (all production recovery): derive each candidate's account
 *   address and require an exact match against the stored `expectedAddress`,
 *   trying the preferred slot first. Fail closed when `expectedAddress` is
 *   absent (record not yet synced) or no candidate matches — committing an
 *   unverified MSK could land on an unreachable wallet (the P0 hazard).
 *
 * `deriveAddress` MUST be the pure, side-effect-free derivation
 * (`ObsidionWallet.deriveAccountAddress`, bound to the recovered signing key by the
 * caller) that uses the same inputs as account creation, so the recover-time and
 * create-time addresses are comparable.
 */
export async function selectRecoveredMsk(
  result: RecoveredCandidates,
  deriveAddress: (msk: Fr) => Promise<string>,
): Promise<Fr> {
  const { candidates, preferredSlot, candidateSource, expectedAddress } = result
  const order: PrfSlot[] = preferredSlot === "second" ? ["second", "first"] : ["first", "second"]

  if (candidateSource === "test") {
    for (const slot of order) {
      const cand = candidates[slot]
      if (cand) return cand
    }
    throw new Error("Test recovery returned no MSK candidate")
  }

  // "webauthn" — an address match is mandatory WHENEVER an expected address is
  // available (both authenticator types). The one exception is a SECURITY-KEY
  // recover with NO available address: a hardware key has a single deterministic,
  // cross-device-stable slot (no wrong-slot ambiguity), so it commits the
  // preferred-slot candidate under the explicit "open the wallet this key roots"
  // semantic. (The orchestrator guards this path so it only runs when the device
  // has no current wallet — `commitSecret` overwrites the single MSK slot.) A
  // PLATFORM recover still fails closed without an address.
  if (!expectedAddress) {
    if (result.authenticatorType === "security-key") {
      for (const slot of order) {
        const cand = candidates[slot]
        if (cand) return cand
      }
      throw new Error("Security-key recovery returned no MSK candidate")
    }
    throw new Error(
      "Cannot verify the recovered wallet: no stored account address (the recovery " +
        "record has not synced to this device yet). Retry once iCloud sync completes, " +
        "or recover on the original device.",
    )
  }
  const expected = expectedAddress.toLowerCase()
  for (const slot of order) {
    const cand = candidates[slot]
    if (!cand) continue
    const derived = (await deriveAddress(cand)).toLowerCase()
    if (derived === expected) return cand
  }
  throw new StoredAddressMismatchError()
}

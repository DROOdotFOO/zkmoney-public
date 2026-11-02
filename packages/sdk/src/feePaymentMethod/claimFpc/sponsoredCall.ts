import { DomainSeparator } from "@aztec-labs/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type FunctionCall, FunctionSelector, FunctionType } from "@aztec-labs/stdlib/abi"
import { Capsule, HashedValues } from "@aztec-labs/stdlib/tx"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { computeOuterAuthWitHash } from "@aztec-labs/stdlib/auth-witness"
import type { ChainInfo } from "@aztec-labs/entrypoints/interfaces"
import { CAPSULE_SLOT } from "../../utils/constants.js"

/** Mirrors the FPC's `MAX_SPONSORED_CALLS`. */
export const MAX_SPONSORED_CALLS = 5
/** Mirrors the account's `INTENT_HASHES_LEN`. */
export const INTENT_HASHES_LEN = 4
/** Mirrors the FPC's `MAX_PUBLIC_CALLDATA_FIELDS`: the selector plus 15 argument fields. The FPC
 * holds a public call's whole calldata to bind the selector it dispatches, so the bound is real. */
export const MAX_PUBLIC_CALLDATA_FIELDS = 16

/** The Noir `FunctionCall` struct shape the FPC's sponsored entrypoints take. */
export interface NoirFunctionCall {
  args_hash: Fr
  function_selector: FunctionSelector
  target_address: AztecAddress
  is_public: boolean
  hide_msg_sender: boolean
  is_static: boolean
}

/**
 * Convert a TS `FunctionCall` into the Noir struct + the `HashedValues` whose
 * hash the struct carries. The preimage MUST ride the tx's `extraHashedArgs`
 * (→ `TxExecutionRequest.argsOfCalls`) or the PXE cannot resolve the nested
 * `call_*_with_args_hash` during execution. Phase split per protocol rules:
 * public calls hash `[selector, ...args]` as calldata, private calls hash the
 * bare args.
 *
 * A public call's calldata is ALSO returned in the clear (padded to
 * `MAX_PUBLIC_CALLDATA_FIELDS`): the FPC rehashes it to bind the selector it
 * matches on, because the target's `public_dispatch` runs the calldata's first
 * field and not `function_selector` (claim_fpc/src/config.nr).
 */
export async function buildNoirFunctionCall(call: FunctionCall): Promise<{
  call: NoirFunctionCall
  hashedValues: HashedValues
  publicCalldata: Fr[]
  publicCalldataLen: number
}> {
  const isPublic = call.type === FunctionType.PUBLIC
  const calldata = isPublic ? [call.selector.toField(), ...call.args] : []
  if (calldata.length > MAX_PUBLIC_CALLDATA_FIELDS) {
    throw new Error(
      `ClaimFPC cannot sponsor a public call with ${calldata.length} calldata fields ` +
        `(${call.name}); the FPC binds the whole preimage, so ${MAX_PUBLIC_CALLDATA_FIELDS} is the limit`,
    )
  }
  const hashedValues = isPublic
    ? await HashedValues.fromCalldata(calldata)
    : await HashedValues.fromArgs(call.args)
  return {
    call: {
      args_hash: hashedValues.hash,
      function_selector: call.selector,
      target_address: call.to,
      is_public: isPublic,
      hide_msg_sender: call.hideMsgSender ?? false,
      is_static: call.isStatic ?? false,
    },
    hashedValues,
    publicCalldata: padCalldata(calldata),
    publicCalldataLen: calldata.length,
  }
}

/** Fixed-width calldata slot, zero-padded — the FPC's ABI is a fixed-size array. */
function padCalldata(calldata: Fr[]): Fr[] {
  return [
    ...calldata,
    ...Array.from({ length: MAX_PUBLIC_CALLDATA_FIELDS - calldata.length }, () => Fr.ZERO),
  ]
}

/** Zero-target padding entry — the FPC skips calls with a zero target address. */
export function emptyNoirFunctionCall(): NoirFunctionCall {
  return {
    args_hash: Fr.ZERO,
    function_selector: FunctionSelector.empty(),
    target_address: AztecAddress.ZERO,
    is_public: false,
    hide_msg_sender: false,
    is_static: false,
  }
}

/**
 * Convert + pad a call batch to `MAX_SPONSORED_CALLS`, collecting the args preimages and the
 * public calldata the FPC binds its selector matching to (all-zero slots for private legs).
 */
export async function buildSponsoredCallBatch(calls: FunctionCall[]): Promise<{
  calls: NoirFunctionCall[]
  extraHashedArgs: HashedValues[]
  publicCalldata: Fr[][]
  publicCalldataLens: number[]
}> {
  if (calls.length === 0 || calls.length > MAX_SPONSORED_CALLS) {
    throw new Error(
      `sponsored batch must have 1..${MAX_SPONSORED_CALLS} calls, got ${calls.length}`,
    )
  }
  const built = await Promise.all(calls.map(buildNoirFunctionCall))
  const emptySlots = MAX_SPONSORED_CALLS - built.length
  return {
    calls: [
      ...built.map((b) => b.call),
      ...Array.from({ length: emptySlots }, emptyNoirFunctionCall),
    ],
    extraHashedArgs: built.map((b) => b.hashedValues),
    publicCalldata: [
      ...built.map((b) => b.publicCalldata),
      ...Array.from({ length: emptySlots }, () => padCalldata([])),
    ],
    publicCalldataLens: [...built.map((b) => b.publicCalldataLen), ...Array(emptySlots).fill(0)],
  }
}

/** Pad intent hashes to `INTENT_HASHES_LEN` (`Fr.ZERO` = unused slot). */
export function padIntentHashes(intentHashes: Fr[]): Fr[] {
  if (intentHashes.length > INTENT_HASHES_LEN) {
    throw new Error(
      `at most ${INTENT_HASHES_LEN} intents per sponsored tx, got ${intentHashes.length}`,
    )
  }
  return [
    ...intentHashes,
    ...Array.from({ length: INTENT_HASHES_LEN - intentHashes.length }, () => Fr.ZERO),
  ]
}

/**
 * The intents-only signature payload (4-element poseidon2 — length-domain-separated from the
 * 5-element entrypoint form). This is the inner hash; the account verifies the signature over
 * `computeIntentsOnlyAuthWitHash`, which binds it to the account, chain and version.
 */
export async function computeIntentsOnlySignatureHash(intentHashes: Fr[]): Promise<Fr> {
  return poseidon2HashWithSeparator(
    padIntentHashes(intentHashes),
    DomainSeparator.SIGNATURE_PAYLOAD,
  )
}

/** The message the account's `authorize_intents` verifies. Sign it with `authProvider.createAuthWit`. */
export async function computeIntentsOnlyAuthWitHash(
  account: AztecAddress,
  chainInfo: ChainInfo,
  intentHashes: Fr[],
): Promise<Fr> {
  return computeOuterAuthWitHash(
    account,
    chainInfo.chainId,
    chainInfo.version,
    await computeIntentsOnlySignatureHash(intentHashes),
  )
}

/**
 * The capsule `verify_private_authwit` reads to map an inner hash onto its
 * batch. Slot 0 is the app-payload hash in account-entrypoint mode; unused
 * (zero) under an FPC entrypoint — the membership check reads slots 1..4.
 */
export function buildIntentCapsule(account: AztecAddress, intentHashes: Fr[]): Capsule {
  return new Capsule(account, new Fr(CAPSULE_SLOT), [Fr.ZERO, ...padIntentHashes(intentHashes)])
}

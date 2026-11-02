import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import type { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { EmailPaylinkProcessor } from "../create/processors/EmailPaylinkProcessor.js"
import type { ClaimInput } from "../types.js"

/** Hex proof fields are accepted because browser proof bundles serialize fields. */
export interface PaylinkL1Proof {
  vkey: (FieldLike | string)[]
  proof: (FieldLike | string)[]
  public_inputs: string[]
}

/** What a `claim_to_l1` burns to: the plain withdrawal executor and the user payload it runs. */
export interface PaylinkL1Payout {
  executor: EthAddress
  userPayload: Buffer
}

/**
 * The zkJWT `caller` an email link's L1 claim binds: the executor and the payload it runs, so a
 * proof cannot be replayed through another executor or to another address.
 */
export function paylinkL1Caller(payout: PaylinkL1Payout): Promise<Fr> {
  return poseidon2Hash([payout.executor.toField(), getUserPayloadHash(payout.userPayload)])
}

/** Shared ABI construction for registered and account-free escrow exits. */
export async function paylinkL1ClaimArgs(
  paylinkType: string,
  payout: PaylinkL1Payout,
  proverTip: bigint,
  zkProof?: PaylinkL1Proof,
) {
  if (payout.executor.isZero()) throw new Error("L1 executor required")
  if (proverTip < 0n) throw new Error("Tips cannot be negative")
  const userPayloadHash = getUserPayloadHash(payout.userPayload)
  if (paylinkType === DEFAULT_CONTRACTS.paylinkDirect) {
    return [payout.executor, userPayloadHash, proverTip]
  }
  if (paylinkType !== DEFAULT_CONTRACTS.paylinkEmail) {
    throw new Error(`L1 claim supports direct and email paylinks, got ${paylinkType}`)
  }
  const { zkProof: validated } = await new EmailPaylinkProcessor().prepareClaimInputs({
    zkProof,
  } as ClaimInput)
  const [caller, ...publicInputs] = validated.public_inputs.map((hex) => Fr.fromHexString(hex))
  if (!caller!.equals(await paylinkL1Caller(payout))) {
    throw new Error("zkJWT proof is not bound to the withdrawal payout")
  }
  const toField = (field: FieldLike | string) =>
    typeof field === "string" ? Fr.fromHexString(field) : field
  return [
    validated.vkey.map(toField),
    validated.proof.map(toField),
    ...publicInputs,
    payout.executor,
    userPayloadHash,
    proverTip,
  ]
}

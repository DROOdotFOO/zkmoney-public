import type { RawPaylinkNote } from "../../escrow/paylinkNoteData.js"
import {
  BasePaylinkProcessor,
  commonDepositNote,
  type DepositArg,
  type PaylinkConstructorArgs,
  toField,
} from "./BasePaylinkProcessor.js"
import {
  PROOF_FIELD_COUNT,
  ZKJWT_PUBLIC_INPUT_COUNT,
  VKEY_FIELD_COUNT,
  DEFAULT_CONTRACTS,
} from "@obsidion/core/constants"
import type { ContractName } from "@obsidion/core/types"
import {
  type CommitmentInput,
  type EmailCommitmentInput,
  type ClaimInput,
  isZkProofClaimInput,
  type ZkProofClaimInput,
} from "../../types.js"
import { EMAIL_LEN, poseidon2HashPackedString } from "../../../../email/utils.js"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import assert from "assert"

/**
 * Processor for email-based paylinks
 * Commits to the hash of the recipient's email address
 */
export class EmailPaylinkProcessor extends BasePaylinkProcessor {
  /**
   * Compute email hash using poseidon2
   * @param input - Email string or EmailCommitmentInput
   * @returns The email hash as Fr
   */
  async computeCommitmentHash(input?: CommitmentInput): Promise<FieldLike> {
    assert(input !== undefined, "Email paylink requires a commitment input")
    const email = typeof input === "string" ? input : (input as EmailCommitmentInput)?.email

    assert(typeof email === "string", "Email must be a string")
    assert(email.trim().length > 0, "Email must not be empty")

    // Validate basic email format
    assert(email.includes("@"), "Email must be valid")
    assert(email.indexOf("@") > 0, "Email must have characters before @")
    assert(email.indexOf("@") < email.length - 1, "Email must have characters after @")

    // Check for truncation
    const emailByteLength = new TextEncoder().encode(email).length
    assert(emailByteLength <= EMAIL_LEN, `Email exceeds ${EMAIL_LEN} byte limit`)

    return poseidon2HashPackedString(email, EMAIL_LEN)
  }

  /**
   * Get the paylinkEmail contract name
   */
  getContractName(): ContractName {
    return DEFAULT_CONTRACTS.paylinkEmail
  }

  /**
   * Get constructor arguments for paylinkEmail contract
   * Includes registry_address for email verification
   */
  getConstructorArgs(args: PaylinkConstructorArgs): DepositArg[] {
    // Matches PaylinkEmail.deposit(amount, oidc_key_registry, vkey_hash, emailhash, from_claimable,
    // until_claimable, refundable_until, token_address, sender, meta). registry + vkey are per-paylink
    // init args; token is per-paylink and read from the note at claim; sender is the funding
    // account (explicit so the deposit is sponsorable — msg_sender is the FPC on that rail).
    assert(
      args.registry_address !== undefined,
      "email paylink requires an oidc_key_registry address",
    )
    assert(args.vkey_hash !== undefined, "email paylink requires a vkey_hash")
    assert(args.sender !== undefined, "email paylink requires a sender")
    return [
      args.amount,
      args.registry_address,
      args.vkey_hash,
      args.hash,
      args.window.fromClaimable,
      args.window.untilClaimable,
      args.window.refundableUntil,
      args.token,
      args.sender,
      args.meta,
    ]
  }

  async depositNote(args: PaylinkConstructorArgs): Promise<RawPaylinkNote> {
    assert(
      args.registry_address !== undefined,
      "email paylink requires an oidc_key_registry address",
    )
    assert(args.vkey_hash !== undefined, "email paylink requires a vkey_hash")
    return {
      ...(await commonDepositNote(args)),
      hash: toField(args.hash),
      oidc_key_registry: args.registry_address,
      vkey_hash: toField(args.vkey_hash),
    }
  }

  /**
   * Validate the pre-generated zkJWT proof bundle that the claim will submit.
   * @param proof - must carry a `zkProof` whose vkey, proof, and public inputs
   *   have the widths the contract expects
   */
  async prepareClaimInputs(proof: ClaimInput): Promise<ZkProofClaimInput> {
    assert(isZkProofClaimInput(proof), "zkProof is required for email ZK claim")
    const input = proof
    assert(
      input.zkProof.vkey?.length === VKEY_FIELD_COUNT,
      `vkey must have ${VKEY_FIELD_COUNT} fields`,
    )
    assert(
      input.zkProof.proof?.length === PROOF_FIELD_COUNT,
      `proof must have ${PROOF_FIELD_COUNT} fields`,
    )
    assert(
      input.zkProof.public_inputs?.length === ZKJWT_PUBLIC_INPUT_COUNT,
      `public_inputs must have ${ZKJWT_PUBLIC_INPUT_COUNT} entries`,
    )
    return input
  }
}

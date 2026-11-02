import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { FieldLike } from "@aztec-labs/aztec.js/abi"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ContractName } from "@obsidion/contracts"
import type { CommitmentInput, ClaimInput, PaylinkWindow } from "../../types.js"
import { packPaylinkData, paylinkSenderHash, type RawPaylinkNote } from "../../escrow/paylinkNoteData.js"

/**
 * Constructor arguments that might be needed by paylink contracts
 */
export interface PaylinkConstructorArgs {
  amount: bigint
  hash: FieldLike
  token: AztecAddress
  window: PaylinkWindow
  // OidcKeyRegistry address + zkJWT vkey hash this paylink binds to (email flavor).
  registry_address?: AztecAddress
  vkey_hash?: FieldLike
  // Funding account (direct flavor): refund rights bind to it; the token authwit-gates the pull
  // when the creation is sponsored (msg_sender != sender). Injected by PaylinkService.
  sender?: AztecAddress
  // The funding transfer's `Transfer.meta`, already encoded. Built once by PaylinkService so the
  // sender's pull authwit hashes exactly the fields `deposit` passes to the token.
  meta: FieldLike[]
}

/** One `deposit` calldata arg: a field, or the transfer meta's field array. */
export type DepositArg = FieldLike | FieldLike[]

/**
 * Abstract base class for paylink type processors
 * Each paylink type (email, direct) extends this to provide type-specific logic
 */
export abstract class BasePaylinkProcessor {
  /**
   * Compute the commitment hash from input data
   * Each processor implements its own hashing logic based on the commitment type
   * @param input - The input data specific to this paylink type (the email address)
   * @returns Promise resolving to the commitment hash as Fr
   */
  abstract computeCommitmentHash(input?: CommitmentInput): Promise<FieldLike>

  /**
   * Get the contract name for this paylink type
   * @returns The contract name to use for this paylink
   * This is the identifier for the paylink type
   */
  abstract getContractName(): ContractName

  /**
   * Get the constructor arguments in the correct order for this contract type
   * Different contracts may have different constructor signatures
   * @param args - The paylink constructor parameters
   * @returns Array of arguments in the order expected by the contract constructor
   */
  abstract getConstructorArgs(args: PaylinkConstructorArgs): DepositArg[]

  /** The note `deposit` writes for these args, whose terms the link carries. */
  abstract depositNote(args: PaylinkConstructorArgs): Promise<RawPaylinkNote>

  /**
   * Prepare claim inputs for the contract claim method
   * Transforms proof data into the format expected by the contract
   * @param proof - The proof data specific to this paylink type
   * @returns Promise resolving to the prepared claim inputs
   */
  abstract prepareClaimInputs(proof: ClaimInput): Promise<unknown>
}

/** The fields both flavors' `deposit` write alike. */
export async function commonDepositNote(
  args: PaylinkConstructorArgs,
): Promise<Omit<RawPaylinkNote, "hash" | "oidc_key_registry" | "vkey_hash">> {
  if (!args.sender) throw new Error("a paylink deposit requires the funding sender")
  return {
    sender_hash: await paylinkSenderHash(args.sender),
    data: packPaylinkData(args.amount, args.window.fromClaimable, args.window.untilClaimable),
    refundable_until: new Fr(args.window.refundableUntil),
    token_address: args.token,
  }
}

export function toField(value: FieldLike): Fr {
  return value instanceof Fr ? value : new Fr(BigInt(value.toString()))
}

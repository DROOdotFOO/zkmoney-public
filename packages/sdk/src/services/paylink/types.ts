// Paylink types that depend on SDK-local runtime references (wallet, contract, and TEE
// types) live here. The pure-data set lives in @obsidion/core/types and is re-exported
// below so existing imports from this path keep working.
export type {
  EmailCommitmentInput,
  CommitmentInput,
  PayLinkAsset,
  BaseClaimInput,
  DirectClaimInput,
  ZkProofClaimInput,
  PaylinkWindow,
} from "@obsidion/core/types"

import type { Account } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import type { TxReceipt, TxHash } from "@aztec-labs/aztec.js/tx"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import type { MethodOptions } from "../ServiceBase.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import type { TokenService } from "../token/TokenService.js"
import type { PaylinkKeyMaterial } from "./escrow/paylinkKeys.js"
import type { DirectClaimInput, ZkProofClaimInput } from "@obsidion/core/types"

/**
 * Shared submit context for the `outerCall` paylink dispatch path. Carries
 * the references the `preparePaylinkClaimSubmit` helper needs to resolve
 * the per-call fee, build the paylink-flavoured spend-metadata resolver,
 * and fetch the token contract / TEE signer.
 *
 * Constructed once by `PaylinkService.claimPaylink` (the router) AND by
 * `PaylinkService.refundPaylink`, then threaded into the helper. The four
 * `PaylinkClaimService` leaves consume `submitContext` instead of
 * reconstructing the bag themselves.
 *
 * `feePaymentMethod` is optional — the helper's resolution order is
 *   `options.sendOptions.fee.paymentMethod` →
 *   `submitContext.feePaymentMethod` →
 *   `wallet.getDefaultSendOptions(batchSender).fee.paymentMethod`
 * so the caller can omit it and let the wallet default win.
 */
export interface ClaimSubmitContext {
  tokenService: TokenService
  teeSigner: RegisteredTeeSigner
  paylinkInstance: ContractInstanceWithAddress
  paylinkKeys: PaylinkKeyMaterial
  /** The link's funding tx, when it carries one; otherwise the escrow note's creation tx serves. */
  depositTxHash?: TxHash
  feePaymentMethod?: FeePaymentMethod
  /**
   * `Transfer.meta` the payout carries — what the claimer read off the escrow's deposit event.
   * Absent on `claim_to_l1`, whose burn carries no transfer meta.
   */
  transferMeta?: Fr[]
  /** The trailing `terms` this escrow's claims take; empty on a class without them. */
  claimTerms?: Fr[]
}

/**
 * Shared interface for all paylink claim services (email, direct).
 * Enables PaylinkService to route claims without `as any` casts.
 *
 * `submitContext` carries the TEE references the leaf threads through
 * `preparePaylinkClaimSubmit`; `options` is the standard `MethodOptions`
 * (caller's `sendOptions`, `operationId`, `kind`, `profile`).
 */
export interface ClaimService {
  claimPayment(
    contractInstance: ContractBase,
    proof: unknown,
    recipient: Account,
    submitContext: ClaimSubmitContext,
    options?: MethodOptions,
  ): Promise<ClaimTransactionResult>
  contractAddress?: AztecAddress
}

export type ClaimTransactionResult = {
  txPromise: Promise<{ txHash: string; receipt: TxReceipt }>
  txHash: Promise<string>
}

/**
 * Union type for all claim inputs
 */
export type ClaimInput = DirectClaimInput | ZkProofClaimInput

export function isZkProofClaimInput(proof: ClaimInput): proof is ZkProofClaimInput {
  if (typeof proof !== "object" || proof === null || !("zkProof" in proof)) return false
  const zk = (proof as ZkProofClaimInput).zkProof
  return zk != null && typeof zk === "object"
}

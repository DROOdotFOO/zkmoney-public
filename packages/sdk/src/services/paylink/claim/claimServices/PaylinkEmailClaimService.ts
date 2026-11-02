import { emptyTransferMeta } from "@obsidion/core/constants"
import type { ObsidionWallet } from "../../../../obsidion/ObsidionWallet.js"
import { type MethodOptions, ServiceBase } from "../../../ServiceBase.js"
import type { ClaimService, ClaimSubmitContext, ZkProofClaimInput } from "../../types.js"
import { preparePaylinkClaimSubmit } from "../paylinkClaimSubmit.js"
import type { Account } from "@aztec-labs/aztec.js/account"
import type { TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import assert from "assert"

/**
 * Claim service for email paylinks (zkJWT proof verified on-chain). Builds the
 * `claim(vkey, proof, ...emailFields, recipient, authwit_nonce)` interaction
 * with the leaf-specific zkJWT verifier args and routes through the shared
 * `preparePaylinkClaimSubmit` helper for TEE-aware preparation.
 */
export class PaylinkEmailClaimService extends ServiceBase implements ClaimService {
  constructor(wallet: ObsidionWallet, _sender: Account) {
    super(wallet)
  }

  public async claimPayment(
    contractInstance: ContractBase,
    proof: ZkProofClaimInput,
    recipient: Account,
    submitContext: ClaimSubmitContext,
    options?: MethodOptions,
  ): Promise<{
    txPromise: Promise<{ txHash: string; receipt: TxReceipt }>
    txHash: Promise<string>
  }> {
    this.emitInit()

    assert(proof.zkProof, "zkProof is required")
    const { vkey, proof: proofFields, public_inputs } = proof.zkProof
    const [caller, emailHash, preEmailHash, audHash, iat, jwkId, hIss] = public_inputs.map(
      (hex: string) => Fr.fromHexString(hex),
    )

    // The contract verifies the proof with recipient in the caller slot, so a
    // mismatched proof can only fail on-chain — catch it here with a clear error.
    assert(
      caller!.equals(recipient.getAddress().toField()),
      `zkJWT proof is bound to ${caller!.toString()}, not the claiming account`,
    )

    // Self-claim through the recipient's own account (msg_sender == recipient):
    // authorize_once takes the self path, which requires authwit_nonce == 0. A
    // sponsored claim (FPC callstack) instead supplies a fresh nonce and the
    // recipient's authwit — see PaylinkService.claimSponsoredPaylink.
    const interaction = contractInstance.methods.claim!(
      vkey,
      proofFields,
      emailHash,
      preEmailHash,
      audHash,
      iat,
      jwkId,
      hIss,
      recipient.getAddress(),
      new Fr(0),
      submitContext.transferMeta ?? emptyTransferMeta(),
      ...(submitContext.claimTerms ?? []),
    )

    const { initFn, buildResult, sendOptions } = await preparePaylinkClaimSubmit({
      wallet: this.wallet,
      node: this.wallet.node,
      interaction,
      batchSender: recipient.getAddress(),
      submitContext,
      options,
    })

    return this.sendAndWait(initFn, buildResult, {
      sendOptions,
      profile: options?.profile,
      operationId: options?.operationId,
      kind: options?.kind,
    })
  }
}

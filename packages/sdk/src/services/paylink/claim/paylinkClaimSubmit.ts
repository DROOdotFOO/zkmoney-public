import type {
  BatchCall,
  ContractFunctionInteraction,
  SendInteractionOptions,
} from "@aztec-labs/aztec.js/contracts"
import type { TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Capsule } from "@aztec-labs/stdlib/tx"

import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import type { MethodOptions } from "../../ServiceBase.js"
import { type BuildTeeOperationSendOpts, buildTeeOperation } from "../../tee/teeOperation.js"
import type { Operation } from "../../../oxide/index.js"
import type { PlainWithdrawalContext, WithdrawOperation } from "../../../oxide/withdrawal/plainWithdrawal.js"
import type { ClaimSubmitContext } from "../types.js"
import { makePaylinkSpendMetadataResolver } from "./paylinkSpendMetadata.js"
import { resolveFeePaymentMethod } from "../../helpers/feeResolution.js"

/**
 * Closure that wires an `outerCall` operation to the underlying interaction
 * with the seed / strict-mode / signature capsules supplied by
 * `buildTeeOperation`. Exported so paylink deposit (`prepareDepositSubmit`)
 * reuses the same shape — both deposit and claim/refund now dispatch through
 * `sendAndWait` (paylink-create joined as of the 2026-06-03 send unification).
 *
 * The helper throws on any non-outerCall kind: the paylink flow uses
 * `outerCall` exclusively, and a token-side `transfer` / `withdraw` should
 * never land here.
 */
export function buildOperationCall(
  op: Operation,
  capsules: Capsule[],
): ContractFunctionInteraction {
  if (op.kind !== "outerCall") {
    throw new Error(
      `[paylinkClaimSubmit.buildOperationCall] Unexpected operation kind "${op.kind}"; this builder only handles outerCall.`,
    )
  }
  return op.interaction.with({
    capsules,
    authWitnesses: op.authwits ?? [],
  })
}

/**
 * Ingredients returned by {@link preparePaylinkClaimSubmit}. The caller —
 * `PaylinkService.claimPaylink` / `PaylinkService.refundPaylink` / a
 * `PaylinkClaimService` leaf, all of which extend `ServiceBase` — passes
 * `initFn` + `buildResult` to `this.sendAndWait(...)`, threading
 * `sendOptions` along with `operationId` / `kind`.
 *
 * The helper does NOT dispatch directly because `ServiceBase.sendAndWait`
 * is `protected` and the helper is a free function — the caller-side
 * `sendAndWait` invocation is what preserves `operationId`/`kind`
 * threading into the wallet's Mining-stage START emit and the post-receipt
 * `provingProgress.emitStageComplete(Mining, operationId)` fire.
 */
export interface PreparedPaylinkClaimSubmit {
  initFn: () => Promise<{
    interaction: BatchCall
    sendOpts: BuildTeeOperationSendOpts
  }>
  buildResult: (data: { txHash: string; receipt: TxReceipt }) => {
    txHash: string
    receipt: TxReceipt
  }
  sendOptions: SendInteractionOptions
}

/**
 * Shared preparation helper for every paylink leaf claim service AND
 * `PaylinkService.refundPaylink`. Wraps `buildTeeOperation` with the
 * `outerCall` op variant so the inner
 * `transfer(paylink -> claimer/depositor, amount)` triggered by the noir
 * `execute_claim` / `execute_refund` ships with the TEE capsules required
 * for `validate_note` to accept the resulting balance note on the
 * recipient's PXE.
 *
 * The nullified note belongs to the paylink contract; the spend-metadata
 * resolver is derived from `submitContext.paylinkKeys` +
 * `submitContext.paylinkInstance` + `submitContext.depositTxHash`.
 *
 * Each leaf service (email / direct) builds its own
 * `interaction` with the verifier-specific args, then defers to this
 * helper for the TEE-aware preparation. Refund builds its own
 * `refund(sender, nonce)` interaction.
 *
 * Note: this helper is claim+refund-only. Paylink deposit
 * (`PaylinkService.createPaylinkContract`) calls `buildTeeOperation`
 * directly and dispatches via `wallet.sendTx`, reading the ciphertext from
 * the send result's `offchainMessages` — the resolver in that case is the
 * caller-supplied `options.resolveSpendMetadata` (sender-owned notes),
 * not the paylink-flavoured one this helper builds.
 */
export async function preparePaylinkClaimSubmit(args: {
  wallet: ObsidionWallet
  node: AztecNode
  interaction: ContractFunctionInteraction
  batchSender: AztecAddress
  submitContext: ClaimSubmitContext
  teeUnsignedInteractions?: ContractFunctionInteraction[]
  /** The withdrawal the escrow call makes (`claim_to_l1`) and the deployment it settles on. */
  withdrawal?: { declared: WithdrawOperation; plainWithdrawal: PlainWithdrawalContext }
  options?: MethodOptions
}): Promise<PreparedPaylinkClaimSubmit> {
  const { wallet, node, interaction, batchSender, submitContext, options } = args

  // Step 1. Fee resolution: see `resolveFeePaymentMethod` for the chain
  // (caller explicit → submitContext → wallet default).
  const feePaymentMethod = await resolveFeePaymentMethod(
    options,
    submitContext.feePaymentMethod,
    wallet,
    batchSender,
  )

  // Step 2. Paylink-flavoured spend-metadata resolver. A link-carried deposit tx
  // hash wins; otherwise the nullification effect's own `creationTxHash` anchors
  // the note.
  const resolveSpendMetadata = makePaylinkSpendMetadataResolver(
    submitContext.paylinkInstance,
    submitContext.depositTxHash,
    submitContext.paylinkKeys,
  )

  // Step 3. Token contract + TEE signer come from the router-prepared
  // `submitContext` — `tokenService.getTokenContract()` is async, so we
  // resolve it eagerly here.
  const tokenContract = await submitContext.tokenService.getTokenContract()
  const teeSigner = submitContext.teeSigner

  // Step 4-5. Compose initFn. buildTeeOperation assembles the
  // simulation-shape batch and returns the unsent `BatchCall` + send sidecar
  // (incl. the staged `finalize`, which performs the single sim's TEE signing
  // inside `wallet.sendTx`); the caller dispatches via `this.sendAndWait(...)`.
  const initFn = async () => {
    const { batchCall, sendOpts } = await buildTeeOperation(
      {
        wallet,
        node,
        paymentMethod: feePaymentMethod,
        // Benchmark correlation (U3) — claim/refund run TEE prep lazily here,
        // inside the `sendAndWait` initFn. Inert unless the flag + a caller
        // operationId are both set. Flow tag = the kind (paylink-claim/refund).
        operationId: options?.operationId,
        benchmarkFlow: options?.kind,
      },
      batchSender,
      {
        tokenContract,
        signer: teeSigner,
        teeUnsignedInteractions: args.teeUnsignedInteractions,
        plainWithdrawal: args.withdrawal?.plainWithdrawal,
        operations: [
          {
            kind: "outerCall",
            interaction,
            // Paylink contract owns the nullified note + is the caller of
            // the inner `transfer(paylink -> ...)` — PXE needs its keys in
            // scope to validate the contract-side spend.
            additionalScopes: [submitContext.paylinkInstance.address],
            withdrawals: args.withdrawal ? [args.withdrawal.declared] : undefined,
          },
        ],
        buildOperationCall,
        resolveSpendMetadata,
      },
    )
    return { interaction: batchCall, sendOpts }
  }

  // Step 6. buildResult passes the receipt through unchanged. Claim/refund
  // don't need offchain effects extracted by the caller — that's the
  // deposit-only path, which reads `offchainMessages` from its
  // `wallet.sendTx` result.
  const buildResult = ({ txHash, receipt }: { txHash: string; receipt: TxReceipt }) => ({
    txHash,
    receipt,
  })

  // Step 7. sendOptions baseline: caller-supplied `sendOptions` (with `from`
  // forced to `batchSender` and the paylink scope added) wins over the
  // wallet default. The caller's `sendAndWait` call merges this with the
  // helper's `sendOpts` sidecar (per the dedupe + shallow-merge contract
  // documented on `sendAndWait`).
  const baselineSendOptions =
    options?.sendOptions ?? (await wallet.getDefaultSendOptions(batchSender))
  const sendOptions: SendInteractionOptions = {
    ...baselineSendOptions,
    from: batchSender,
    additionalScopes: [
      ...(baselineSendOptions?.additionalScopes ?? []),
      submitContext.paylinkInstance.address,
    ],
  }

  return { initFn, buildResult, sendOptions }
}

import type {
  BatchCall,
  Contract,
  ContractFunctionInteraction,
} from "@aztec-labs/aztec.js/contracts"
import type { AuthWitness } from "@aztec-labs/aztec.js/authorization"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"

import type { ObsidionWallet } from "../../../obsidion/ObsidionWallet.js"
import type { MethodOptions } from "../../ServiceBase.js"
import {
  type BuildTeeOperationSendOpts,
  buildTeeOperation,
  requireSpendMetadataResolver,
} from "../../tee/teeOperation.js"
import { resolveFeePaymentMethod } from "../../helpers/feeResolution.js"
import type { DepositSpendMetadataResolver, SpendMetadataResolver } from "../../../oxide/index.js"
import { buildOperationCall as paylinkOuterCallBuilder } from "../claim/paylinkClaimSubmit.js"

/**
 * Ingredients returned by {@link prepareDepositSubmit}. The caller —
 * `PaylinkService.createPaylinkContract` — wraps `batchCall` in a trivial
 * `initFn` and dispatches via `this.sendAndWait(initFn, ..., { silent: true })`,
 * then reads the paylink ciphertext (for the shareable URL) from the
 * `sentTx` promise's `offchainMessages`. `sendAndWait` sends with `NO_WAIT`,
 * so `sentTx` resolves as soon as the tx is submitted (post-`aztecNode.sendTx`,
 * pre-mining) — create returns the link without blocking on the receipt. The
 * `silent` flag keeps this behavior-neutral vs. the old direct-`sendTx` path
 * (no lifecycle/status emits).
 *
 * `sendOpts.additionalScopes` contains the paylink instance address (PXE
 * needs it during sim AND submit for the paylink-owned offchain message
 * emit).
 *
 * `sendOpts.finalize` MUST reach `wallet.sendTx` — the TEE pipeline (sign +
 * capsule assembly + `publish_da`) lives in the finalizer, and the
 * simulation-shape payload alone mines without DA attestation, silently
 * dropping the deposited note at PXE discovery. `sendAndWait` forwards it
 * (`finalize: init.sendOpts?.finalize` in `ServiceBase`), so routing through
 * the shared seam preserves it.
 */
export interface PreparedDepositSubmit {
  batchCall: BatchCall
  sendOpts: BuildTeeOperationSendOpts
}

/**
 * Shared preparation helper for `PaylinkService.createPaylinkContract`.
 * Wraps `buildTeeOperation` with the `outerCall` op variant so the inner
 * `transfer(sender, paylink, amount)` triggered by the
 * noir `deposit` initializer ships with the TEE capsules required for
 * `validate_note` to accept the paylink-owned balance note.
 *
 * `buildTeeOperation` neither simulates nor signs: the single sim and the TEE
 * sign both happen inside `wallet.sendTx`.
 *
 * The nullified note belongs to the SENDER (deposit transfers
 * `sender -> paylink`), so the spend-metadata resolver is the caller-
 * supplied `options.resolveSpendMetadata` (sender-owned notes), NOT the
 * paylink-flavoured one `preparePaylinkClaimSubmit` builds for the
 * claim/refund path.
 */
export async function prepareDepositSubmit(args: {
  wallet: ObsidionWallet
  node: AztecNode
  sender: AztecAddress
  teeSigner: RegisteredTeeSigner
  tokenContract: Contract
  depositInteraction: ContractFunctionInteraction
  paylinkInstance: ContractInstanceWithAddress
  authwit: AuthWitness
  /** Calls that need no TEE capsules, sent in the deposit's tx (the short link's announce). */
  teeUnsignedInteractions?: ContractFunctionInteraction[]
  options?: MethodOptions<{
    resolveSpendMetadata?: SpendMetadataResolver
    /** Metadata for deposits the funding pull may spend. */
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver
  }>
}): Promise<PreparedDepositSubmit> {
  const {
    wallet,
    node,
    sender,
    teeSigner,
    tokenContract,
    depositInteraction,
    paylinkInstance,
    authwit,
    options,
  } = args

  const feePaymentMethod = await resolveFeePaymentMethod(options, undefined, wallet, sender)
  const resolveSpendMetadata = requireSpendMetadataResolver(
    options ?? {},
    "PaylinkService.createPaylinkContract",
  )

  const { batchCall, sendOpts } = await buildTeeOperation(
    {
      wallet,
      node,
      paymentMethod: feePaymentMethod,
      // Benchmark correlation (U3) — create's TEE-op assembly runs here,
      // eagerly, before `createPaylinkContract`'s trivial `sendAndWait`
      // initFn; the enclave roundtrip itself happens later, inside `sendTx`'s
      // finalizer. Inert unless the flag + a caller operationId are both set.
      operationId: options?.operationId,
      benchmarkFlow: options?.kind,
    },
    sender,
    {
      tokenContract,
      signer: teeSigner,
      operations: [
        {
          kind: "outerCall",
          interaction: depositInteraction,
          authwits: [authwit],
          additionalScopes: [paylinkInstance.address],
        },
      ],
      buildOperationCall: paylinkOuterCallBuilder,
      teeUnsignedInteractions: args.teeUnsignedInteractions,
      resolveSpendMetadata,
      resolveDepositSpendMetadata: options?.resolveDepositSpendMetadata,
    },
  )

  // Return the simulation-shape `BatchCall` (+ send sidecar incl. the
  // staged-execution `finalize`) unsent. The caller wraps it in an `initFn`
  // for `this.sendAndWait(..., { silent: true })`, which performs the
  // `BatchCall.send({ ...mergedSendOptions, wait: NO_WAIT })` — routing
  // through `wallet.sendTx`, whose single internal simulation feeds the
  // finalizer (TEE sign + capsule assembly + `publish_da`). Mirrors
  // `preparePaylinkClaimSubmit`'s `{ batchCall, sendOpts }`-via-initFn shape.
  return { batchCall, sendOpts }
}

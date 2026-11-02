import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Contract, ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Capsule } from "@aztec-labs/stdlib/tx"
import { getTransferMetaLen } from "@oxide/oxide-client/l2_operations.js"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"

import type { Operation } from "../../oxide/index.js"

/**
 * Per-operation call builder for the oxide-token contract. Passed (after binding `tokenContract`)
 * as the `buildOperationCall` closure to `buildTeeOperation` for token-only batches. Paylink
 * batches inject their own builder via `paylinkOuterCallBuilder`.
 *
 * Each argument list is positional and hardcoded here; `packages/sdk/test/tokenOperationCall.test.ts`
 * holds it to the artifact's parameter list. An omitted transfer `meta` is zero-filled to the length the
 * bound artifact declares.
 *
 * **Sync constraint:** `buildOperationCall` is a synchronous callback. Do NOT introduce `await` —
 * callers resolve the token contract before the closure is constructed.
 */
export function buildTokenOperationCall(
  tokenContract: Contract,
  op: Operation,
  capsules: Capsule[],
): ContractFunctionInteraction {
  switch (op.kind) {
    case "transfer":
      return tokenContract.methods.transfer!(
        op.from,
        op.to,
        op.amount,
        op.meta ?? Array(getTransferMetaLen(tokenContract.artifact)).fill(Fr.ZERO),
        op.authwitNonce ?? 0,
      ).with({ capsules })
    case "withdraw":
      return tokenContract.methods.withdraw!(
        op.from,
        op.executor,
        getUserPayloadHash(op.userPayload),
        op.amount,
        op.proverTip,
        op.authwitNonce ?? 0,
      ).with({ capsules })
    case "outerCall":
      throw new Error(
        "buildTokenOperationCall: outerCall operations are routed through PaylinkService's own builder, not the token-side builder",
      )
  }
}

// Local extensions to `@oxide/oxide-client/l2_operations.ts`. `Operation` gains an `outerCall`
// variant for cross-contract flows (paylink deposit / claim / refund) that ride the same TEE
// choreography as a direct token call. `L2SubmitContext` takes a whole `AztecNode` where upstream
// takes the narrower `ChainDataSource`, and carries the wallet's benchmark correlation fields.
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AuthWitness } from "@aztec-labs/aztec.js/authorization"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"

import type {
  Operation as TokenOperationCall,
  WithdrawOperation,
} from "@oxide/oxide-client/l2_operations.js"
import type { BenchmarkFlow } from "@obsidion/core/types"

/**
 * Wallet + node + fee context shared across submissions.
 */
export interface L2SubmitContext {
  wallet: Wallet
  node: AztecNode
  /** Absent → the sender pays from its own fee-juice balance. */
  paymentMethod?: FeePaymentMethod
  /**
   * Time-perf benchmark correlation key (docs/plans/2026-06-03-001). Set ONLY
   * on the benchmark path; when present (and the flag is on), the staged
   * finalizer built by `buildTeeOperation` contributes the TEE leg (the
   * `enclave` phase) to the `benchmarkRegistry` under this id so it
   * correlates with the prove leg from `sendTx`. Inert otherwise.
   */
  operationId?: string
  /** Flow tag for the TEE leg's benchmark sample (paired with `operationId`). */
  benchmarkFlow?: BenchmarkFlow
}

/**
 * One contract call within a submission's operation list. Upstream's `transfer` / `withdraw`
 * variants map to `OxideTokenContract` methods directly; the `outerCall` variant carries an
 * arbitrary outer-contract interaction whose nested call into the token contract emits the
 * offchain effects the TEE signs over.
 */
export type Operation =
  | TokenOperationCall
  | {
      /**
       * Arbitrary outer-contract call that internally invokes one or more of the token's spending
       * methods (transfer / withdraw). Use for cross-contract flows (paylink escrow deposit / claim /
       * refund, etc.) that need to ride the same TEE choreography as a direct transfer: seed +
       * strict-mode capsules, real / dummy signature capsules, `publish_da` with TEE-signed
       * required-nullifiers and notes.
       *
       * The TEE only sees the offchain effects (insertions / nullifications / withdrawals) the nested
       * token call emits; it neither knows nor cares about the outer contract. `args.tokenContract` is
       * still the token contract — used by `collectAccountingEffects` (filtering by token address) and
       * by capsule slot derivation. A nested `withdraw` is collected and signed like a direct one
       * (paylink `claim_to_l1` relies on this). Only `deposits` need explicit wiring, via
       * `resolveDepositSpendMetadata`.
       *
       * This variant carries no `from` field — the kernel-level batch sender is the only
       * identity, and the nested token call enforces its own `from == msg_sender()` via authwit
       * or contract-as-sender semantics.
       */
      kind: "outerCall"
      interaction: ContractFunctionInteraction
      /** Auth witnesses for the outer call (e.g. the token transfer authwit when the outer
       *  contract spends the sender's notes via the token's `_validate_from_private` authwit
       *  fallback). */
      authwits?: AuthWitness[]
      /** Extra account scopes the simulation and real send need to resolve keys for, beyond the
       *  batch `from`. Necessary when the outer contract owns notes / emits offchain deliveries
       *  to itself (e.g. a paylink escrow): without the outer contract's address in scope, PXE's
       *  key-validation oracle can't find the contract-owned keys and `simulateTx` rejects with
       *  `Key validation request denied: no scoped account has a key with hash ...`. */
      additionalScopes?: AztecAddress[]
      /** The withdrawals the nested token call makes (paylink `claim_to_l1`), in call order. The batch
       *  checks their relayer tips and broadcasts their finalization requests. */
      withdrawals?: WithdrawOperation[]
    }

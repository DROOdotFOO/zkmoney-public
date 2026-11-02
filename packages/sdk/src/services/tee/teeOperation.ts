import {
  BatchCall,
  type Contract,
  type ContractFunctionInteraction,
} from "@aztec-labs/aztec.js/contracts"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { Capsule } from "@aztec-labs/stdlib/tx"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createLogger } from "@aztec-labs/foundation/log"
import type { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { ViemClient } from "@aztec-labs/ethereum/types"
import type { Hex } from "viem"
import {
  buildNoteSignatureCapsules,
  buildPublishDaCapsules,
  buildRecoveryChunkCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
} from "@oxide/oxide-client/capsules.js"
import type { Timeouts } from "@oxide/oxide-client/enclave_transport.js"
import { FleetSigner } from "@oxide/oxide-client/fleet_signer.js"
import {
  assertRecoveryChunksFitInTx,
  buildRecoveryData,
  buildSignedFinalizationData,
  buildSimulationFinalizationData,
} from "@oxide/oxide-client/submitted_withdrawal.js"
import {
  type CollectedAccountingEffects,
  hydrateTokenOperation,
} from "@oxide/oxide-client/token_operations_collector.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { buildFinalizationRequestCall } from "@oxide/oxide-client/withdrawal_finalization_request.js"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import { TEEMetadata } from "@oxide/oxide-lib/types.js"
import type { WithdrawalFinalizationData } from "@oxide/oxide-lib/withdrawal_finalization_data.js"
import {
  assertWalletWithdrawals,
  declaredWithdrawals,
  type PlainWithdrawalContext,
  type WithdrawOperation,
} from "../../oxide/withdrawal/plainWithdrawal.js"
import { computePublishDaLogEmittedLengths } from "../../oxide/token/publishDaLogs.js"
import {
  type SpendMetadataResolver,
  type DepositSpendMetadataResolver,
  collectAccountingEffects,
  type L2SubmitContext,
  type Operation,
} from "../../oxide/index.js"
import {
  priceDeclaredEffectDeltas,
  type FinalizedPayload,
  type PayloadFinalizer,
} from "../../obsidion/stagedExecution.js"
import { benchmarkRegistry } from "../../obsidion/benchmark/benchmarkRegistry.js"
import { benchNow } from "../../obsidion/benchmark/proveTimingExtract.js"
import { readTimingBenchFlag } from "../../obsidion/proving-progress-helpers.js"

// Re-export `RegisteredTeeSigner` from the SDK barrel so front-core callers can consume it without
// depending on `@oxide/oxide-client` directly.
export type { RegisteredTeeSigner }

/** Mirrors `ACCOUNT_MAX_CALLS` in `contracts/alpha/lib/src/payloads.nr` — the entrypoint AppPayload
 *  holds this many FunctionCalls. */
export const ACCOUNT_MAX_CALLS = 5

/**
 * Logger for the oxide-token / oxide TEE dispatch path. Surfaces enough
 * shape information (operation kinds, contract addresses, anchor hash,
 * signature counts, batch-call layout) to confirm at a glance that a tx
 * routed through the oxide pipeline (TEE-signed OxideToken op with
 * `publish_da` capsule fan-out) and not, say, a naive aztec.js path. NEVER
 * log raw signature bytes / nullifiers / TEE notes — they are
 * nullifier-material-bearing and must not leave the finalizer.
 */
const teeOpLogger = createLogger("sdk:tee-op")

export interface LoadTeeSignerOptions {
  /** Override the attestation-fetch and/or sealed-operation timeouts. Defaults to oxide's
   *  30s / 180s — the operation budget has to cover tens of seconds of enclave CPU on a
   *  worst-case `signTokenOperation`. */
  timeouts?: Partial<Timeouts>
  /** Attempts (obtain a pin, then send) per operation before giving up. Defaults to 3. */
  maxAttempts?: number
}

/**
 * Connect a {@link FleetSigner} over the enclave fleet at `url`, pinning one enclave whose
 * attestation matches the keys registered on the `TeeRegistry` of the L1 `OxidePortal` at
 * `portalAddress`. Every registered enclave is an equal peer: the signer re-pins and retries
 * when the fleet reports its pin is gone, so the identity behind the returned signer can move.
 *
 * Throws when the enclave is not registered, its attestation keys differ from the registered
 * ones, or the attestation fetch times out or rejects.
 *
 * NOTE: the full Nitro COSE_Sign1 attestation is NOT re-verified client-side. The registry
 * registers only enclaves that run its PCR0, so the client trusts the on-chain registration as
 * the integrity root and cross-checks the live attestation's keys against it.
 *
 * @param url           Fleet router / enclave HTTP proxy endpoint (e.g.
 *                      `http://127.0.0.1:8080/rpc` for local dev or the EC2
 *                      proxy URL for testnet).
 * @param portalAddress L1 `OxidePortal` contract address (typically sourced
 *                      from `ContractService.getL1Addresses().portal`).
 * @param viemClient    Read-capable viem client targeting the L1 chain.
 * @param opts          Optional timeout / retry overrides.
 */
export async function loadTeeSigner(
  url: string,
  portalAddress: Hex | EthAddress,
  viemClient: ViemClient,
  opts?: LoadTeeSignerOptions,
): Promise<RegisteredTeeSigner> {
  const portal = new OxidePortalContract(viemClient, portalAddress)
  return FleetSigner.connect(url, portal, {
    ...(opts?.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts?.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  })
}

/**
 * Dedupe `AztecAddress[]` by stringified hex. Object-identity dedupe would
 * miss two `AztecAddress` instances built from the same hex (each call to
 * `AztecAddress.fromStringUnsafe(...)` returns a fresh object), so callers (this
 * module and `sendAndWait` in `ServiceBase.ts`) canonicalize via
 * `.toString()` before keying.
 */
export function dedupeByAddressString(addrs: AztecAddress[]): AztecAddress[] {
  return Array.from(new Map(addrs.map((a) => [a.toString(), a])).values())
}

/**
 * Sidecar options returned alongside the simulation-shape {@link BatchCall}
 * from {@link buildTeeOperation}. `BatchCall` has no `.with()` method, so the
 * caller receives these here and is responsible for merging them into the
 * final `.send(...)` options (`sendAndWait` does this for service callers;
 * `L2Claimer` spreads them directly).
 *
 * INVARIANT: `fee` must NOT include `gasSettings` — only `paymentMethod`. The
 * shallow-merge contract in `sendAndWait` relies on this: caller-provided
 * `gasSettings` survives a `{ ...callerFee, ...initFee }` merge precisely
 * because the helper does not overwrite that sub-key. If a future revision
 * needs to set `gasSettings` here, switch `sendAndWait`'s merge to an explicit
 * per-sub-key deep merge.
 */
export interface BuildTeeOperationSendOpts {
  fee?: { paymentMethod: FeePaymentMethod }
  additionalScopes?: AztecAddress[]
  /**
   * Staged-execution finalizer (see `obsidion/stagedExecution.ts`):
   * `ObsidionWallet.sendTx` invokes it with the result of its single
   * kernelless pre-simulation of the simulation-shape batch. The finalizer
   * hydrates the TEE-attested token effects from that result, signs them,
   * assembles the production batch (signature + strict-mode capsules on every
   * op call, the signed recovery data and finalization requests, plus the
   * closing `publish_da`), and returns its `ExecutionPayload` together with
   * the `Gas` delta of the `publish_da` emissions (priced here via
   * `priceDeclaredEffectDeltas`, which mirrors the protocol's metering
   * constants).
   *
   * MUST reach `wallet.sendTx` — dropping it silently would prove and submit
   * the simulation-shape batch (seed capsule only, no `publish_da`), whose
   * freshly-minted notes PXE drops during discovery.
   */
  finalize: PayloadFinalizer
}

/**
 * Result returned by {@link buildTeeOperation}. The function assembles the
 * simulation-shape `BatchCall` and a {@link PayloadFinalizer} — it performs
 * no simulation, no TEE signing, and does NOT dispatch. Callers route the
 * returned `batchCall` through `sendAndWait` (which goes through
 * `wallet.sendTx`); the wallet runs ONE kernelless simulation (authwit
 * capture + gas estimation + the TEE-attestation source, all in the same
 * pass) and invokes `sendOpts.finalize` with the result, then proves and
 * submits the finalized payload. The full pipeline (proving-progress emits,
 * withProvingScope, pendingTxStore) fires as for any other send.
 */
export interface BuildTeeOperationResult {
  batchCall: BatchCall
  sendOpts: BuildTeeOperationSendOpts
}

/**
 * Validate that the caller supplied a `resolveSpendMetadata` resolver on the
 * options bag. Throws a uniform error referencing the call-site label and the
 * two production-grade resolver factories.
 *
 * Used by every public method that ultimately dispatches through
 * {@link buildTeeOperation} with nullifying operations (transfer, withdraw,
 * paylink deposit). The TEE pipeline needs a resolver to hydrate nullified
 * notes into the spend metadata the signer attests over — calling
 * `buildTeeOperation` without one would throw deep inside the helper at a
 * less actionable point.
 */
export function requireSpendMetadataResolver(
  options: { resolveSpendMetadata?: SpendMetadataResolver },
  callerLabel: string,
): SpendMetadataResolver {
  const resolver = options.resolveSpendMetadata
  if (!resolver) {
    throw new Error(
      `[${callerLabel}] \`resolveSpendMetadata\` is required: the TEE dispatch helper needs a resolver to hydrate nullified notes for signing. Pass \`accountManager.makeSpendMetadataResolver()\` (ObsidionAccount) or \`buildSpendMetadata\`-backed resolver (Schnorr fixtures).`,
    )
  }
  return resolver
}

/** Maps one operation to its contract call, with `capsules` attached. */
export type OperationCallBuilder = (
  op: Operation,
  capsules: Capsule[],
) => ContractFunctionInteraction

/**
 * The calls of one pass, one per operation. `tail` holds the unsigned interactions and then each withdrawal's
 * finalization request. `finalizationData[k]` belongs to declared withdrawal `k`; the token reads its recovery chunks
 * from capsules, which every operation call carries.
 */
export async function buildTeeBatchCalls(args: {
  tokenContract: Contract
  operations: Operation[]
  buildOperationCall: OperationCallBuilder
  capsules: Capsule[]
  teeUnsignedInteractions: ContractFunctionInteraction[]
  declared: WithdrawOperation[]
  finalizationData: WithdrawalFinalizationData[]
}): Promise<{
  operationCalls: ContractFunctionInteraction[]
  tail: ContractFunctionInteraction[]
}> {
  const { buildOperationCall, declared, finalizationData } = args
  const capsules = [
    ...args.capsules,
    ...(await buildRecoveryChunkCapsules(
      args.tokenContract.address,
      buildRecoveryData(declared, finalizationData),
    )),
  ]
  const operationCalls = args.operations.map((op) => buildOperationCall(op, capsules))
  const finalizationRequests = declared.flatMap((withdrawal, k) =>
    withdrawal.finalizationRequestBroadcastParams
      ? [
          buildFinalizationRequestCall(
            withdrawal.finalizationRequestBroadcastParams,
            finalizationData[k]!,
          ),
        ]
      : [],
  )
  return { operationCalls, tail: [...args.teeUnsignedInteractions, ...finalizationRequests] }
}

/** Throws unless the batch's withdrawals are wallet withdrawals whose recovery data fits in one tx. */
export function assertTeeBatchWithdrawals(
  operations: Operation[],
  plainWithdrawal: PlainWithdrawalContext | undefined,
): WithdrawOperation[] {
  const declared = declaredWithdrawals(operations)
  assertWalletWithdrawals(declared, plainWithdrawal)
  assertRecoveryChunksFitInTx(declared)
  return declared
}

/** The simulation pass's finalization data: final sizes, zero randomness and signatures. */
export function simulationFinalizationData(
  declared: WithdrawOperation[],
): WithdrawalFinalizationData[] {
  return declared.map(buildSimulationFinalizationData)
}

/** What {@link signTeeBatch} hands the production pass. Nullifier-material-bearing: keep it local. */
export interface SignedTeeBatch {
  collected: CollectedAccountingEffects
  /** Capsules every op call carries: seed, strict mode and the note signatures. */
  capsules: Capsule[]
  /** The signed finalization data of each declared withdrawal. */
  finalizationData: WithdrawalFinalizationData[]
  /** The closing `publish_da` call. */
  publishDa: ContractFunctionInteraction
  /** Gas of `publish_da`'s emissions, the only emission difference from the simulation pass. */
  gasDelta: ReturnType<typeof priceDeclaredEffectDeltas>
  /** Enclave round-trip, for the benchmark TEE leg. */
  enclaveMs: number
}

/**
 * Hydrate the token effects of the wallet's simulation, have the TEE sign them, and build what the
 * production pass adds: the signature capsules, the signed finalization data and `publish_da`.
 */
export async function signTeeBatch(args: {
  node: AztecNode
  tokenContract: Contract
  signer: RegisteredTeeSigner
  simResult: Parameters<PayloadFinalizer>[0]
  /** The simulation's seed capsule; the same seed reproduces the notes the TEE signs. */
  seedCapsule: Capsule
  declared: WithdrawOperation[]
  resolveSpendMetadata?: SpendMetadataResolver
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver
  /** Abort before the enclave signs unless the batch burns exactly this much. */
  expectedWithdrawalAmount?: bigint
  timingBench: boolean
  logLabel: string
}): Promise<SignedTeeBatch> {
  const { tokenContract, signer, simResult, declared } = args
  const anchorBlockHeader = simResult.publicInputs.constants.anchorBlockHeader
  const collected = collectAccountingEffects(tokenContract.address, simResult.offchainEffects)

  if (args.expectedWithdrawalAmount !== undefined) {
    const burned = collected.withdrawals.reduce((sum, w) => sum + w.amount, 0n)
    if (burned !== args.expectedWithdrawalAmount) {
      // No amounts in the message: the simulated burn is private and errors get reported.
      throw new Error(`${args.logLabel}: withdrawal amount does not match the expected amount`)
    }
  }

  const tokenOperation = await hydrateTokenOperation(args.node, {
    tokenAddress: tokenContract.address,
    teeRegistry: signer.teeRegistry,
    anchorBlockHeader,
    collected,
    resolveSpendMetadata: args.resolveSpendMetadata,
    resolveDepositSpendMetadata: args.resolveDepositSpendMetadata,
  })
  teeOpLogger.info(`${args.logLabel}: requesting TEE signature`, {
    tokenContract: tokenContract.address.toString(),
    createdNotes: tokenOperation.createdNotes.length,
    nullifiedNotes: collected.nullifiedNotes.length,
    deposits: tokenOperation.deposits.length,
    withdrawals: tokenOperation.withdrawals.length,
  })
  const enclaveStart = args.timingBench ? benchNow() : 0
  const signOutput = await signer.signTokenOperation(tokenOperation)
  const enclaveMs = args.timingBench ? benchNow() - enclaveStart : 0

  const anchorBlockHash = await anchorBlockHeader.hash()
  const capsules = [
    args.seedCapsule,
    buildStrictModeCapsule(tokenContract.address),
    ...(await buildNoteSignatureCapsules(tokenContract.address, collected, signOutput.signatures)),
  ]
  const publishDa = tokenContract.methods.publish_da!().with({
    capsules: buildPublishDaCapsules(tokenContract.address, signOutput, anchorBlockHash),
  })
  const teeMetadata = TEEMetadata.fromPublicKey(
    signOutput.publicKey,
    anchorBlockHash,
    new Fr(signOutput.registrationLeafIndex),
  )
  const gasDelta = priceDeclaredEffectDeltas({
    privateLogEmittedLengths: computePublishDaLogEmittedLengths({
      teeNotes: signOutput.teeNotes.length,
      requiredNullifiers: signOutput.requiredNullifiers.length,
      withdrawalMessageHashes: signOutput.withdrawalMessageHashes.length,
      metadataFields: teeMetadata.toFields().length,
    }),
  })
  return {
    collected,
    capsules,
    finalizationData: buildSignedFinalizationData(declared, tokenOperation, signOutput),
    publishDa,
    gasDelta,
    enclaveMs,
  }
}

/**
 * Assemble a batched operation against one token as a *staged* send: the
 * simulation-shape `BatchCall` plus a {@link PayloadFinalizer} that maps the
 * wallet's pre-simulation result to the production (TEE-signed) payload. The
 * caller owns dispatch (so `wallet.sendTx` runs and the full
 * proving-progress / persist pipeline fires); the wallet owns the
 * single simulation that feeds BOTH the TEE attestation and its own
 * authwit-capture / gas-estimation pass, plus the PXE sync point and the
 * gas pricing of the finalize delta (see `obsidion/stagedExecution.ts`).
 *
 * For the `Operation` variants this helper batches (`transfer` / `withdraw` /
 * `outerCall`), see the canonical type definition at
 * `src/oxide/token/l2_operations.ts` — in particular the `outerCall` JSDoc, which
 * documents the cross-contract dispatch contract (no `from` field,
 * `additionalScopes` for outer-contract-owned notes, etc.).
 *
 * **Forked from** oxide-client's `submit()` (`oxide-client/src/l2_operations.ts`),
 * built from its bindings-free pieces. Differences from upstream:
 *
 *   1. `from` → `batchSender`: the tx originator, not necessarily the note owner.
 *      Paylink claim/refund use `op.from = paylink.address` while `batchSender` is the
 *      claimer or depositor; the TEE's owner-preimage check guards spends.
 *   2. No dispatch: returns the unsent simulation-shape `BatchCall` + a `sendOpts`
 *      sidecar (`fee`, `additionalScopes`, `finalize`), because `BatchCall` has no
 *      `.with()` method.
 *   3. `buildOperationCall` is a caller closure (token side calls the token's
 *      `transfer`/`withdraw`; paylink side calls the paylink contract), and an
 *      `outerCall` operation declares the withdrawals its nested token call makes.
 *   4. `additionalScopes` for outer-contract-owned notes.
 *   5. No pre-simulation here: the wallet's own kernelless simulation inside
 *      `sendTx` feeds `sendOpts.finalize`. The seed capsule derives note randomness
 *      from the seed, not the tx nonce, so the finalized batch reproduces exactly the
 *      notes that simulation produced and the TEE attested.
 *   6. Every withdrawal must broadcast its finalization request, and a plain one is
 *      checked to leave the executor its relayer tip.
 *
 * INVARIANTS:
 *   - `sendOpts.fee` carries `paymentMethod` only — no `gasSettings`. The
 *     shallow-merge contract in `sendAndWait` relies on this.
 *   - The token operation and the sign output are nullifier-material-bearing:
 *     they stay inside the finalizer and are never returned or logged.
 */
export async function buildTeeOperation(
  ctx: L2SubmitContext,
  batchSender: AztecAddress,
  args: {
    tokenContract: Contract
    signer: RegisteredTeeSigner
    operations: Operation[]
    /** Per-operation call builder; replaces oxide's internal switch helper. */
    buildOperationCall: OperationCallBuilder
    /** Resolves a nullification effect into the spend metadata the TEE needs.
     *  Only required when the simulated batch nullifies at least one note. */
    resolveSpendMetadata?: SpendMetadataResolver
    /** Resolves a spent deposit's recipient into the metadata (address preimage
     *  + master nullifier hiding key) the TEE needs to key the deposit-message
     *  nullifier. Only required when the batch consumes an unspent deposit. */
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver
    /** Extra addresses whose private state PXE should expose during the
     *  simulation. Required for paylink flavour where `batchSender =
     *  claimer.account` but the spent notes are owned by `paylink.address`. */
    additionalScopes?: AztecAddress[]
    teeUnsignedInteractions?: ContractFunctionInteraction[]
    /** The deployment's plain withdrawal executor. Required when the batch withdraws. */
    plainWithdrawal?: PlainWithdrawalContext
  },
): Promise<BuildTeeOperationResult> {
  const { tokenContract, signer, operations, buildOperationCall } = args
  if (operations.length === 0) {
    throw new Error("buildTeeOperation called with no operations")
  }
  const declared = assertTeeBatchWithdrawals(operations, args.plainWithdrawal)
  const teeUnsignedInteractions = args.teeUnsignedInteractions ?? []

  const { wallet, node, paymentMethod } = ctx
  const fee = paymentMethod ? { paymentMethod } : undefined

  // Time-perf benchmark TEE-leg span (docs/plans/2026-06-03-001, U3): only when the flag is on
  // AND the caller threaded a benchmark operationId onto the ctx.
  const timingBench = readTimingBenchFlag() && ctx.operationId !== undefined

  // `args.additionalScopes` plus the per-op scopes of `outerCall` operations. Both feed the sim's
  // key-validation oracle and the returned `sendOpts.additionalScopes`.
  const additionalScopes = dedupeByAddressString([
    ...(args.additionalScopes ?? []),
    ...operations.flatMap((op) =>
      op.kind === "outerCall" && op.additionalScopes ? op.additionalScopes : [],
    ),
  ])

  const batchCalls = async (
    capsules: Capsule[],
    finalizationData: WithdrawalFinalizationData[],
  ) => {
    const { operationCalls, tail } = await buildTeeBatchCalls({
      tokenContract,
      operations,
      buildOperationCall,
      capsules,
      teeUnsignedInteractions,
      declared,
      finalizationData,
    })
    return [...operationCalls, ...tail]
  }

  // 1. Simulation shape: only the deterministic-randomness seed capsule, and finalization data of
  // its final size. The wallet simulates this shape exactly once inside `sendTx`; that pass is its
  // authwit/gas source AND the offchain-effects feed the TEE attests over.
  const seedCapsule = buildSeedCapsule(tokenContract.address)
  const simBatchCalls = await batchCalls([seedCapsule], simulationFinalizationData(declared))
  // + publish_da + the fee call.
  if (simBatchCalls.length + 2 > ACCOUNT_MAX_CALLS) {
    throw new Error(
      `TEE batch of ${operations.length} operation(s) needs ${
        simBatchCalls.length + 1
      } entrypoint calls ` +
        `(operations, broadcasts and publish_da) plus the fee call, exceeding ` +
        `ACCOUNT_MAX_CALLS = ${ACCOUNT_MAX_CALLS}. Split the operations across transactions.`,
    )
  }

  // 2. Finalizer: consumes the wallet's simulation result and produces the production payload,
  // on the send path, exactly once.
  const finalize: PayloadFinalizer = async (simResult): Promise<FinalizedPayload> => {
    const signed = await signTeeBatch({
      node,
      tokenContract,
      signer,
      simResult,
      seedCapsule,
      declared,
      resolveSpendMetadata: args.resolveSpendMetadata,
      resolveDepositSpendMetadata: args.resolveDepositSpendMetadata,
      timingBench,
      logLabel: "buildTeeOperation",
    })
    const realBatchCalls = [
      ...(await batchCalls(signed.capsules, signed.finalizationData)),
      signed.publishDa,
    ]

    teeOpLogger.info("assembled exec payload", {
      tokenContract: tokenContract.address.toString(),
      batchSender: batchSender.toString(),
      callLayout: [...operations.map((op) => `op:${op.kind}`), "publish_da"],
      totalCalls: realBatchCalls.length,
      gasDelta: { daGas: signed.gasDelta.daGas, l2Gas: signed.gasDelta.l2Gas },
    })

    // Bake the fee leg with the same `fee` the simulation-shape batch was
    // sent with — `sendTx` computed its fee options from the simulated
    // payload's feePayer and asserts the finalized payload matches.
    const payload = await new BatchCall(wallet, realBatchCalls).request({ fee })

    // At the END of the finalizer, so a throw above leaves no partial in the registry.
    if (timingBench && ctx.operationId) {
      benchmarkRegistry.contributeTee(ctx.operationId, {
        flow: ctx.benchmarkFlow ?? "send",
        enclave: signed.enclaveMs,
        notesUsed: signed.collected.nullifiedNotes.length,
      })
    }

    return { payload, gasDelta: signed.gasDelta }
  }

  return {
    batchCall: new BatchCall(wallet, simBatchCalls),
    sendOpts: { fee, additionalScopes, finalize },
  }
}

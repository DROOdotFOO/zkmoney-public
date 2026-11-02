/**
 * TEE-attested oxide-token operations under ClaimFPC sponsorship — the
 * composition of `buildTeeOperation` (single-sim staged execution, TEE
 * signing, capsule assembly, `publish_da`) with `buildClaimSponsorPayload`
 * (NO_FROM entrypoint batches).
 *
 * Shape parity with the account-entrypoint variant, with two differences the
 * sponsored batch imposes:
 *   - calls are `FunctionCall` structs dispatched by the FPC, matched against
 *     its policy (the shipped single `ByAny` entry matches them all; class
 *     witnesses are still supplied so a per-call ByClass policy also matches),
 *     not an account `BatchCall`;
 *   - capsules ride the ExecutionPayload tx-globally (`extraCapsules`) —
 *     they are keyed by (contract, slot), so per-call attachment was never
 *     load-bearing.
 *
 * Batch layout (MAX_SPONSORED_CALLS = 5): [account auth?, ...ops, ...teeUnsignedInteractions,
 * ...finalization requests, publish_da].
 */
import type { Contract, ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Capsule, ExecutionPayload } from "@aztec-labs/stdlib/tx"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact, FunctionCall } from "@aztec-labs/stdlib/abi"
import type { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { createLogger } from "@aztec-labs/foundation/log"
import { buildSeedCapsule } from "@oxide/oxide-client/capsules.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import type { WithdrawalFinalizationData } from "@oxide/oxide-lib/withdrawal_finalization_data.js"
import type { PlainWithdrawalContext } from "../../oxide/withdrawal/plainWithdrawal.js"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type {
  Operation,
  SpendMetadataResolver,
  DepositSpendMetadataResolver,
} from "../../oxide/index.js"
import type { FinalizedPayload, PayloadFinalizer } from "../../obsidion/stagedExecution.js"
import {
  MAX_SPONSORED_CALLS,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  claimFpcSponsoredFee,
  type ClaimFpcGateWitness,
  type ClaimFpcPolicy,
  type ClassWitnessInput,
} from "../../feePaymentMethod/index.js"
import {
  assertTeeBatchWithdrawals,
  buildTeeBatchCalls,
  dedupeByAddressString,
  signTeeBatch,
  simulationFinalizationData,
  type OperationCallBuilder,
} from "./teeOperation.js"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { BenchmarkFlow } from "@obsidion/core/types"
import { benchmarkRegistry } from "../../obsidion/benchmark/benchmarkRegistry.js"
import { readTimingBenchFlag } from "../../obsidion/proving-progress-helpers.js"

const log = createLogger("wallet-sdk:sponsored-tee-operation")

/** Extract the call struct + any capsules an interaction accumulated via `.with()`. */
async function toCallAndCapsules(
  interaction: ContractFunctionInteraction,
): Promise<{ call: FunctionCall; capsules: Capsule[] }> {
  const payload = await interaction.request()
  return { call: payload.calls[0]!, capsules: payload.capsules ?? [] }
}

export interface SponsoredTeeOperationArgs {
  fpcAddress: AztecAddress
  fpcArtifact: ContractArtifact
  /** The rail this batch rides and the policy that bounds it (`railByName`). */
  railId: number
  policy: ClaimFpcPolicy
  user: AztecAddress
  /** Owner of the intent capsule when the account authorizing the ops is not the paying `user`. */
  intentsAccount?: AztecAddress
  tokenContract: Contract
  signer: RegisteredTeeSigner
  operations: Operation[]
  buildOperationCall: OperationCallBuilder
  resolveSpendMetadata?: SpendMetadataResolver
  /** Metadata (address preimage + nullifier hiding key) for deposits the batch spends. */
  resolveDepositSpendMetadata?: DepositSpendMetadataResolver
  additionalScopes?: AztecAddress[]
  /** Class witnesses aligned with `operations` (undefined for ByAddress targets). */
  operationClassWitnesses: (ClassWitnessInput | undefined)[]
  /** Account authorization riding the batch (authorize_intents); absent when the ops consume
   * intents an earlier batch authorized. */
  accountCall?: { call: FunctionCall; classWitness: ClassWitnessInput }
  /**
   * Non-token calls riding the batch that the TEE does not sign — oxide `submit`'s seam of the
   * same name (e.g. the swap-on-withdraw L1-operation broadcast). They sit between the ops and
   * `publish_da` in BOTH the sim and finalized shapes; `collectTokenEffects` filters by token
   * address, so they never reach the attestation. Matched by address or `ByAny` — no class witness.
   */
  teeUnsignedInteractions?: ContractFunctionInteraction[]
  /**
   * Abort before the enclave signs unless the batch burns exactly this much. Guards a
   * caller-planned L1 leg (a swap escrow sized off a paylink's advertised amount) against a note
   * that holds less than the link claims.
   */
  expectedWithdrawalAmount?: bigint
  /** The deployment's plain withdrawal executor. Required when the batch withdraws. */
  plainWithdrawal?: PlainWithdrawalContext
  intentHashes?: Fr[]
  combinedAuthWitness?: AuthWitness
  /** First-tx subscribe on this rail: ride `subscribe` instead of `sponsor`, with the witnesses
   * the rail's gate consumes. */
  gate?: ClaimFpcGateWitness
}

export interface SponsoredTeeOperationResult {
  /** Simulation-shape sponsored payload; send with `{ from: NO_FROM, ...sendOpts }`. */
  payload: ExecutionPayload
  sendOpts: {
    additionalScopes: AztecAddress[]
    finalize: PayloadFinalizer
    /** What the policy budgets this batch at, declared as the tx's limits — see
     * `claimFpcSponsoredFee`. */
    fee: ReturnType<typeof claimFpcSponsoredFee>
  }
}

/** The FPC payload builders and fee rule the batch is handed to. Tests read the assembled batch here. */
const SPONSOR_DEPS = { buildClaimSponsorPayload, buildClaimSubscribePayload, claimFpcSponsoredFee }

export async function buildSponsoredTeeOperation(
  ctx: {
    wallet: ObsidionWallet
    node: AztecNode
    /** Benchmark correlation id; when set (and the flag is on) the finalizer contributes the TEE leg. */
    operationId?: string
    benchmarkFlow?: BenchmarkFlow
  },
  args: SponsoredTeeOperationArgs,
  deps: typeof SPONSOR_DEPS = SPONSOR_DEPS,
): Promise<SponsoredTeeOperationResult> {
  const { node } = ctx
  // Same gate as `buildTeeOperation`: flag on AND a caller-threaded operationId.
  const timingBench = readTimingBenchFlag() && ctx.operationId !== undefined
  const { fpcAddress, fpcArtifact, user, tokenContract, operations, operationClassWitnesses } = args
  if (operations.length === 0) {
    throw new Error("buildSponsoredTeeOperation called with no operations")
  }
  const declared = assertTeeBatchWithdrawals(operations, args.plainWithdrawal)
  for (const op of operations) {
    if (op.kind === "outerCall" && op.authwits?.length) {
      throw new Error(
        "sponsored TEE operations must not carry per-op authwits — intents ride the FPC intent capsule",
      )
    }
  }

  const additionalScopes = dedupeByAddressString([
    ...(args.additionalScopes ?? []),
    ...operations.flatMap((op) =>
      op.kind === "outerCall" && op.additionalScopes ? op.additionalScopes : [],
    ),
  ])

  const assembleSponsored = async (
    opCapsules: Capsule[],
    finalizationData: WithdrawalFinalizationData[],
    publishDa?: ContractFunctionInteraction,
  ): Promise<{ payload: ExecutionPayload; innerCalls: FunctionCall[] }> => {
    const { operationCalls, tail } = await buildTeeBatchCalls({
      tokenContract,
      operations,
      buildOperationCall: args.buildOperationCall,
      capsules: opCapsules,
      teeUnsignedInteractions: args.teeUnsignedInteractions ?? [],
      declared,
      finalizationData,
    })
    const innerCalls: FunctionCall[] = []
    const classWitnesses: (ClassWitnessInput | undefined)[] = []
    const capsules: Capsule[] = []
    const push = async (
      interaction: ContractFunctionInteraction,
      classWitness?: ClassWitnessInput,
    ) => {
      const { call, capsules: callCapsules } = await toCallAndCapsules(interaction)
      innerCalls.push(call)
      classWitnesses.push(classWitness)
      capsules.push(...callCapsules)
    }
    if (args.accountCall) {
      innerCalls.push(args.accountCall.call)
      classWitnesses.push(args.accountCall.classWitness)
    }
    for (let i = 0; i < operationCalls.length; i++) {
      await push(operationCalls[i]!, operationClassWitnesses[i])
    }
    for (const interaction of [...tail, ...(publishDa ? [publishDa] : [])]) await push(interaction)
    if (innerCalls.length + (publishDa ? 0 : 1) > MAX_SPONSORED_CALLS) {
      throw new Error(
        `sponsored TEE batch would need ${
          innerCalls.length + (publishDa ? 0 : 1)
        } calls; the FPC dispatches at most ${MAX_SPONSORED_CALLS}`,
      )
    }
    const common = {
      fpcAddress,
      fpcArtifact,
      railId: args.railId,
      policy: args.policy,
      user,
      intentsAccount: args.intentsAccount,
      innerCalls,
      classWitnesses,
      intentHashes: args.intentHashes,
      combinedAuthWitness: args.combinedAuthWitness,
      extraCapsules: dedupeCapsules([...opCapsules, ...capsules]),
    }
    const payload = args.gate
      ? await deps.buildClaimSubscribePayload({ ...common, gate: args.gate })
      : await deps.buildClaimSponsorPayload(common)
    return { payload, innerCalls }
  }

  // Simulation shape: [auth?, ...ops, ...tail] with only the seed capsule — the wallet's single
  // internal sim is both the gas source and the effects feed the TEE attests over.
  const seedCapsule = buildSeedCapsule(tokenContract.address)
  const { payload, innerCalls } = await assembleSponsored(
    [seedCapsule],
    simulationFinalizationData(declared),
  )

  const finalize: PayloadFinalizer = async (simResult): Promise<FinalizedPayload> => {
    const signed = await signTeeBatch({
      node,
      tokenContract,
      signer: args.signer,
      simResult,
      seedCapsule,
      declared,
      resolveSpendMetadata: args.resolveSpendMetadata,
      resolveDepositSpendMetadata: args.resolveDepositSpendMetadata,
      expectedWithdrawalAmount: args.expectedWithdrawalAmount,
      timingBench,
      logLabel: "buildSponsoredTeeOperation",
    })
    const { payload: finalizedPayload, innerCalls: finalizedCalls } = await assembleSponsored(
      signed.capsules,
      signed.finalizationData,
      signed.publishDa,
    )

    log.info("assembled sponsored exec payload", {
      callLayout: finalizedCalls.map((call) => call.name),
      gasDelta: { daGas: signed.gasDelta.daGas, l2Gas: signed.gasDelta.l2Gas },
    })

    // At the END of the finalizer, so a throw above leaves no partial in the registry.
    if (timingBench && ctx.operationId) {
      benchmarkRegistry.contributeTee(ctx.operationId, {
        flow: ctx.benchmarkFlow ?? "send",
        enclave: signed.enclaveMs,
        notesUsed: signed.collected.nullifiedNotes.length,
      })
    }

    return { payload: finalizedPayload, gasDelta: signed.gasDelta }
  }

  // Priced as sent: the finalized batch appends `publish_da`.
  const fee = deps.claimFpcSponsoredFee(args.policy, [...innerCalls, { name: "publish_da" }])

  return { payload, sendOpts: { additionalScopes, finalize, fee } }
}

/** Capsules are keyed by (contract, slot); a duplicate key would shadow — keep the LAST writer. */
function dedupeCapsules(capsules: Capsule[]): Capsule[] {
  const byKey = new Map<string, Capsule>()
  for (const c of capsules) {
    byKey.set(`${c.contractAddress.toString()}:${c.storageSlot.toString()}`, c)
  }
  return [...byKey.values()]
}

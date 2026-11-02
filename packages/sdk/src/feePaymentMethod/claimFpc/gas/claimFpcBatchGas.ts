/**
 * Gas limits a ClaimFPC-sponsored tx must declare — the same numbers the deployed policy's budget
 * was priced from.
 *
 * WHY THE CLIENT HAS TO DECLARE THEM. `_assert_fee_within_max` (claim_fpc/src/main.nr) bounds
 * `(gas_limits + teardown_gas_limits) x max_fees_per_gas`, i.e. what the tx DECLARES, not what it
 * spends. Left to default, upstream declares the network's per-tx admission ceiling for a send and
 * three times the per-checkpoint processable maximum for a gas-estimation simulation — an order of
 * magnitude above a per-call inventory, which rejects every such tx outright, and ~3x the flat caps,
 * which leaves an open policy one fee uptick from the same fate (pinned in
 * claimFpcGasInventory.test.ts). Declaring the policy's own numbers makes the assert reduce to the
 * one comparison it is meant to be: the tx's fee-per-gas against the fee-per-gas the FPC sponsors
 * at.
 *
 * TWO REGIMES, ONE PER POLICY SHAPE (`claimFpcDeclaredGas` picks by the policy the FPC committed):
 *   - A policy with a `ByAny` entry sponsors any private non-FPC call, so no per-call inventory
 *     exists to declare: the batch declares the flat `CLAIM_FPC_MAX_BATCH_{DA,L2}_GAS` caps, which
 *     the deploy priced into that entry's per-batch `max_fee`.
 *   - A per-call policy budgets each committed call separately, so the batch declares the
 *     inventory: the entrypoint overhead plus every call's marginal, mirroring
 *     `_entrypoint_preamble`'s `batch_max_fee` in gas terms.
 *
 * Either way the batch declares the config's own fee-per-gas, so the assert holds and sponsorship
 * pauses only while the network fee itself is above the config's — the drain brake the immutable
 * config is meant to have, not a bug.
 *
 * Declared limits also bound execution: a batch that meters above what it declared runs out of gas
 * instead of being sponsored. Under the caps that headroom is deliberate slack; under an inventory
 * declaration it is the whitelist ceiling's own refusal (the fee assert would reject the batch),
 * moved earlier and made explicit.
 */
import { Gas, GasFees } from "@aztec-labs/stdlib/gas"
import type { FunctionCall } from "@aztec-labs/stdlib/abi"
import {
  CLAIM_FPC_MAX_BATCH_DA_GAS,
  CLAIM_FPC_MAX_BATCH_L2_GAS,
  CLAIM_FPC_MAX_FEE_PER_GAS,
  PROOF_FIELD_COUNT,
  VKEY_FIELD_COUNT,
} from "@obsidion/core/constants"
import {
  CLAIM_FPC_GATE_FUNCTIONS,
  claimFpcPolicySponsorsAnyCall,
  type ClaimFpcGateKind,
  type ClaimFpcPolicy,
} from "../claimSponsoredCall.js"
import { deriveClaimFpcGasBudgets } from "./claimFpcGasBudgets.js"
import { privateSideEffectGas, registrationGateEffects } from "./claimFpcGasModel.js"
import type { ClaimFpcMeasuredTx } from "./claimFpcGasTable.js"

/** A batched call as the gas inventory sees it: the policy-matched name plus the flattened
 * args, which disambiguate the flavors that share a name. */
export type SponsorableCall = Pick<FunctionCall, "name"> & { args?: readonly unknown[] }

/** The shared flat per-batch caps, as a batch of gas. */
export const CLAIM_FPC_BATCH_CAPS: ClaimFpcMeasuredTx = {
  daGas: CLAIM_FPC_MAX_BATCH_DA_GAS,
  l2Gas: CLAIM_FPC_MAX_BATCH_L2_GAS,
}

export const CLAIM_FPC_MAX_FEES_PER_GAS = new GasFees(
  CLAIM_FPC_MAX_FEE_PER_GAS,
  CLAIM_FPC_MAX_FEE_PER_GAS,
)

/** The sponsorable calls a per-call policy can commit, keyed by the function name it matches on. */
const MARGINAL_BY_FUNCTION: Record<string, keyof ReturnType<typeof deriveClaimFpcGasBudgets>> = {
  authorize_intents: "mAuth",
  gift_voucher: "mGift",
  notify_sipa_recipient: "mSipaNotify",
  announce: "mLinkAnnounce",
  broadcast_l1_operation_2k: "mL1Operation",
  broadcast_l1_operation_4k: "mL1Operation4k",
  broadcast_l1_operation_pair_2k: "mL1OperationPair",
  publish_da: "mPublishDa",
  transfer: "mTransfer",
  withdraw: "mWithdraw",
  deposit: "mPaylinkDeposit",
  claim: "mPaylinkClaim",
  // Refund reuses the claim budget (same escrow-note spend and payout, no registry view).
  refund: "mPaylinkClaim",
  // The email flavor is selected from the proof-bearing arguments below.
  claim_to_l1: "mPaylinkClaimToL1",
  claim_with_withdrawal: "mPaylinkClaimWithWithdrawal",
}

/**
 * What each gate's self-call adds to a `subscribe`, on top of the entrypoint overhead — the
 * contract's `#[abi(fpc_gate_gas)]` globals, metered here from the kernel's constants so a wallet
 * pricing a batch needs no contract artifact. `claimFpcGasInventory.test.ts` pins them against the
 * artifact and the measured table.
 *
 * A subscribe's shape names its gate as its first leg (`subscribe[registration,authorize_intents]`),
 * which is how the declaration prices the gate that actually runs.
 */
const GATE_MARGINAL: Record<ClaimFpcGateKind, ClaimFpcMeasuredTx> = {
  // Two signature checks and a CREATE2 derivation, all in-circuit: no side effects, no gas.
  nameClaim: { daGas: 0, l2Gas: 0 },
  // A key proof and a message existence check, both in-circuit: no side effects either.
  registration: privateSideEffectGas(registrationGateEffects()),
  // No gate runs: a rail entered by gift alone refuses every subscribe.
  none: { daGas: 0, l2Gas: 0 },
}

/** The gate leg `name` stands for, or undefined when it names a batched call instead. */
export function claimFpcGateMarginal(name: string): ClaimFpcMeasuredTx | undefined {
  return name in CLAIM_FPC_GATE_FUNCTIONS ? GATE_MARGINAL[name as ClaimFpcGateKind] : undefined
}

/** Both paylink flavors name their claim `claim` and their exit `claim_to_l1` (separate ByClass
 * entries); the email flavor is recognizable by the zkJWT vkey+proof riding its flattened args. The
 * deposit needs no split — both flavors share one budget. */
const carriesZkJwt = (call: SponsorableCall): boolean =>
  (call.args?.length ?? 0) >= VKEY_FIELD_COUNT + PROOF_FIELD_COUNT
const isEmailClaim = (call: SponsorableCall): boolean => call.name === "claim" && carriesZkJwt(call)

/** Cached: the derivation runs every model-vs-measured cross-check, and the inputs are constants. */
let cached: ReturnType<typeof deriveClaimFpcGasBudgets> | undefined
const budgets = () => (cached ??= deriveClaimFpcGasBudgets())

/**
 * The inventory marginal of one batched call, by function name. Throws on anything a per-call
 * policy has no budget for: such a policy would reject the batch in-circuit, and a silent zero
 * would declare limits too low to execute. Only a per-call policy reaches this — a `ByAny` one
 * declares the caps, and any call it dispatches is by definition outside the inventory.
 */
export function claimFpcCallGas(call: SponsorableCall): ClaimFpcMeasuredTx {
  if (call.name === "claim_to_l1" && carriesZkJwt(call)) {
    return budgets().mPaylinkEmailClaimToL1
  }
  const key = isEmailClaim(call) ? "mPaylinkEmailClaim" : MARGINAL_BY_FUNCTION[call.name]
  if (!key) {
    throw new Error(
      `ClaimFPC has no per-call gas budget for "${call.name}", so a per-call policy cannot ` +
        "sponsor it. Budgeted calls: " +
        Object.keys(MARGINAL_BY_FUNCTION).join(", "),
    )
  }
  return budgets()[key]
}

/**
 * Whole-batch inventory gas: the entrypoint overhead charged once, plus the gate's own cost when
 * the shape names one, plus every call's marginal. Mirrors `subscribe`/`sponsor`'s fee cap in gas
 * terms, so pricing this at the config's fee-per-gas reproduces a per-call policy's budget exactly.
 */
export function claimFpcBatchGas(calls: SponsorableCall[]): ClaimFpcMeasuredTx {
  return calls.reduce<ClaimFpcMeasuredTx>(
    (total, call) => {
      const marginal = claimFpcGateMarginal(call.name) ?? claimFpcCallGas(call)
      return { daGas: total.daGas + marginal.daGas, l2Gas: total.l2Gas + marginal.l2Gas }
    },
    { ...budgets().base },
  )
}

/**
 * The gas `policy` budgets this batch at: the flat caps when it sponsors any call, the per-call
 * inventory when it commits specific entries.
 *
 * A `ByAny` leaf makes every non-FPC call ride it, so the caps are exact for any batch — except one
 * built purely of calls back INTO the FPC, which match `BY_SELF` leaves instead. A policy that
 * commits both kinds has to budget those leaves at or above the caps.
 */
export function claimFpcDeclaredGas(
  policy: ClaimFpcPolicy,
  calls: SponsorableCall[],
): ClaimFpcMeasuredTx {
  return claimFpcPolicySponsorsAnyCall(policy) ? CLAIM_FPC_BATCH_CAPS : claimFpcBatchGas(calls)
}

/**
 * The `fee` to send a sponsored batch with: `{ fee: claimFpcSponsoredFee(policy, innerCalls) }`.
 *
 * The budget is declared EXACTLY — no padding on top. A private tx is charged its METERED gas, not
 * its declared limits, so declaring the whole budget costs nothing, while padding it would eat the
 * ceiling's fee room. The fee-per-gas is the config's for the same reason: a tx pays the base fee,
 * not its declared maximum.
 *
 * Teardown is zero: no sponsorable call registers a public teardown function, and the assert sums
 * both dimensions, so the whole allowance rides `gasLimits`.
 *
 * Pass every call the sent batch carries, including a `publish_da` a staged send appends while
 * finalizing.
 */
export function claimFpcSponsoredFee(
  policy: ClaimFpcPolicy,
  calls: SponsorableCall[],
): {
  gasSettings: { gasLimits: Gas; teardownGasLimits: Gas; maxFeesPerGas: GasFees }
} {
  const gas = claimFpcDeclaredGas(policy, calls)
  return {
    gasSettings: {
      gasLimits: new Gas(gas.daGas, gas.l2Gas),
      teardownGasLimits: Gas.empty(),
      maxFeesPerGas: CLAIM_FPC_MAX_FEES_PER_GAS,
    },
  }
}

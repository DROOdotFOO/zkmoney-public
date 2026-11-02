import {
  DA_GAS_PER_FIELD,
  L2_GAS_PER_NOTE_HASH,
  L2_GAS_PER_NULLIFIER,
  L2_GAS_PER_PRIVATE_LOG,
  PRIVATE_TX_L2_GAS_OVERHEAD,
  PUBLIC_DATA_WRITE_LENGTH,
  TX_DA_GAS_OVERHEAD,
} from "@aztec-labs/constants"
import type { ClaimFpcMeasuredTx } from "./claimFpcGasTable.js"

/**
 * What the ClaimFPC entrypoint itself adds to a sponsored tx, priced from the kernel's metering
 * constants (the no-public-calls branch of `meterGasUsed`). Both entrypoints emit the same fixed
 * side effects — one nullifier (claim push or note pop), one SubscriptionNote hash, one delivery
 * log — on top of the protocol's per-tx overhead (PRIVATE_TX_L2_GAS_OVERHEAD, the tx-request
 * nullifier, the fee payer's public-data write, TX_DA_GAS_OVERHEAD).
 *
 * The circuit charges the contract's own `CLAIM_FPC_OVERHEAD_GAS` once per batch, and
 * `deriveClaimFpcGasBudgets` checks that this value, that global and the measured table all agree,
 * so a metering constant moved by an aztec bump fails loudly instead of mispricing every batch.
 *
 * Only valid for a tx with no public calls. A call that enqueues one changes the price of the whole
 * tx (PUBLIC_TX_L2_GAS_OVERHEAD plus the AVM's per-side-effect prices); claimFpcGasModel.ts prices
 * those shapes per call.
 */

/** Emitted length (in fields) of the SubscriptionNote delivery log. Asserted against a real
 * sponsored tx's effects in the sdk's ClaimFPC overhead test. */
export const SUBSCRIPTION_NOTE_LOG_EMITTED_LENGTH = 16

export function meterClaimFpcOverheadGas(): ClaimFpcMeasuredTx {
  // Tx-request nullifier + the FPC's own nullifier + the SubscriptionNote hash.
  const nullifiers = 2
  const noteHashes = 1
  const daFields =
    nullifiers + noteHashes + (SUBSCRIPTION_NOTE_LOG_EMITTED_LENGTH + 1) + PUBLIC_DATA_WRITE_LENGTH
  return {
    daGas: TX_DA_GAS_OVERHEAD + daFields * DA_GAS_PER_FIELD,
    l2Gas:
      PRIVATE_TX_L2_GAS_OVERHEAD +
      nullifiers * L2_GAS_PER_NULLIFIER +
      noteHashes * L2_GAS_PER_NOTE_HASH +
      L2_GAS_PER_PRIVATE_LOG,
  }
}

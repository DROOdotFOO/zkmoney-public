/**
 * One ClaimFPC rail's allowance for one user, from the utilities every deployed ClaimFPC has:
 * whether the user holds a note on the rail, the uses stored in it, and the rail's configured
 * allowance and refill period. A stored zero on a rail that refills cannot say whether the next
 * batch renews it; only the batch itself finds out.
 */
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"

import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { claimFpcSubscriptionUses, hasClaimFpcSubscription } from "./claimSponsor.js"

export interface ClaimFpcAllowance {
  /** Whether the user holds any note on the rail. False before the first subscribe or gift. */
  subscribed: boolean
  /** Stored uses, summed over the rail's notes. */
  uses: number
  /** The allowance a subscribe or a renewal grants. */
  maxTx: number
  /** Seconds a spent allowance waits before it can renew. 0: the rail never renews. */
  refillPeriod: number
}

interface RailResult {
  max_tx: bigint
  refill_period: bigint
}

/** `user`'s allowance on `railId` of the ClaimFPC at `fpcAddress`, read with that instance's artifact. */
export async function readClaimFpcAllowance(
  wallet: ObsidionWallet,
  fpcAddress: AztecAddress,
  fpcArtifact: ContractArtifact,
  user: AztecAddress,
  railId: number,
): Promise<ClaimFpcAllowance> {
  const [subscribed, uses, config] = await Promise.all([
    hasClaimFpcSubscription(wallet, fpcAddress, fpcArtifact, user, railId),
    claimFpcSubscriptionUses(wallet, fpcAddress, fpcArtifact, user, railId),
    Contract.at(fpcAddress, fpcArtifact, wallet).methods.get_config!().simulate({ from: user }),
  ])
  const rail = (config.result as { rails: RailResult[] }).rails[railId]
  if (!rail) throw new Error(`ClaimFPC at ${fpcAddress.toString()} has no rail ${railId}`)
  return {
    subscribed,
    uses,
    maxTx: Number(rail.max_tx),
    refillPeriod: Number(rail.refill_period),
  }
}

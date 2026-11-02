/**
 * ClaimFPC deterministic instantiation + the `refuel` tx's fee declaration.
 *
 * The address must be computable before the oxide L1 side exists (their skim pool deposits to it),
 * so the deploy is universal (zero deployer), the salt is a pinned versioned constant per network,
 * and the only constructor arg is the configure-password hash. Same (artifact, salt, hash) → same
 * address on every network.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Gas } from "@aztec-labs/stdlib/gas"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from "@aztec-labs/stdlib/contract"
import { CLAIM_FPC_GAS_TABLE } from "./gas/claimFpcGasTable.js"
import { CLAIM_FPC_MAX_FEES_PER_GAS, type claimFpcSponsoredFee } from "./gas/claimFpcBatchGas.js"

/** TS mirror of the circuit's `password_hash_of`: the `str<31>` packed as one big-endian field
 * (FieldCompressedString), poseidon2-hashed. ASCII-only. */
export async function claimFpcPasswordHash(password: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(password)
  if (bytes.length === 0) {
    throw new Error("ClaimFPC password must not be empty")
  }
  if (bytes.length > 31) {
    throw new Error(`ClaimFPC password must be at most 31 bytes, got ${bytes.length}`)
  }
  const padded = new Uint8Array(31)
  padded.set(bytes)
  const hex = Array.from(padded, (b) => b.toString(16).padStart(2, "0")).join("")
  return await poseidon2Hash([new Fr(BigInt(`0x${hex}`))])
}

/** The counterfactual ClaimFPC instance at the given salt: universal deploy (no deployer in the address
 * preimage), password hash as the only initializer arg. The salt is oxide's — they seed it and publish it
 * beside the address their FPCFunder deposits to. */
export async function getClaimFpcInstance(
  artifact: ContractArtifact,
  passwordHash: Fr,
  salt: Fr,
): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(artifact, {
    salt,
    constructorArgs: [passwordHash],
  })
}

/**
 * The `fee` for a `refuel` send: the contract's own `REFUEL_OVERHEAD_GAS` declared exactly as the
 * limits, mirroring `claimFpcSponsoredFee` — the circuit bounds declared gas x fee-per-gas, so the
 * declaration must be the budget, at the config's fee-per-gas.
 *
 * refuel is a fixed shape, so its measured table entry is that global to the gas; the inventory
 * test pins the two equal. Reading the table keeps the ClaimFPC artifact out of the wallet's boot
 * bundle.
 */
export function claimFpcRefuelFee(): ReturnType<typeof claimFpcSponsoredFee> {
  const gas = CLAIM_FPC_GAS_TABLE["refuel"]
  if (!gas) {
    throw new Error(
      "the measured gas table has no refuel entry; re-run the sdk fpc suites with CLAIMFPC_GAS_REPORT=1",
    )
  }
  return {
    gasSettings: {
      gasLimits: new Gas(gas.daGas, gas.l2Gas),
      teardownGasLimits: Gas.empty(),
      maxFeesPerGas: CLAIM_FPC_MAX_FEES_PER_GAS,
    },
  }
}

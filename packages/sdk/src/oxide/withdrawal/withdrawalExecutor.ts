// A bridge's withdrawal executor: the L1 contract a burn pays, which takes the protocol fee and pays
// out the rest. Its terms are immutables, so a burn's fee is its executor's `FEE` whenever read.
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { readPlainWithdrawalFee } from "@oxide/oxide-client/executors/plain_withdrawal_executor.js"
import { PlainWithdrawalExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from "viem"

/**
 * Which executor contract a bridge deploys. `plain` (`PlainWithdrawalExecutor`) extends oxide's
 * `FeeChargingExecutorBase`: it charges `FEE` in the asset to `BENEFICIARY` on each withdrawal, and
 * serves direct and swap burns. `sky` (`SkyWithdrawalExecutor`) redeems sUSDS to DAI and does not
 * extend it: the contract has no `FEE` or `BENEFICIARY`, so its withdrawals pay no protocol fee.
 */
export type WithdrawalExecutorKind = "plain" | "sky"

interface ExecutorBase {
  address: Address
  /** The portal the executor serves: the only caller it accepts. */
  portal: Address
}

export interface FeeChargingExecutor extends ExecutorBase {
  kind: "plain"
  /** What the executor takes from each withdrawal, in the asset's base units. */
  fee: bigint
  /** Who receives `fee`. Absent when the executor names nobody. */
  beneficiary?: Address
}

/** An executor whose contract charges nothing; `fee` is zero by type, not by a read. */
export interface FeeFreeExecutor extends ExecutorBase {
  kind: "sky"
  fee: 0n
  beneficiary?: never
}

export type WithdrawalExecutor = FeeChargingExecutor | FeeFreeExecutor

/** `executor.portal`. Every executor kind exposes `PORTAL`. */
export async function readExecutorPortal(
  client: Pick<PublicClient, "readContract">,
  address: Address,
): Promise<Address> {
  const portal = await client.readContract({
    address,
    abi: PlainWithdrawalExecutorAbi,
    functionName: "PORTAL",
  })
  return getAddress(portal)
}

/** The withdrawal subsidy the executor created, which a release through it claims. Every executor kind exposes `SUBSIDY`. */
export async function readExecutorSubsidy(
  client: Pick<PublicClient, "readContract">,
  address: Address,
): Promise<Address> {
  const subsidy = await client.readContract({
    address,
    abi: PlainWithdrawalExecutorAbi,
    functionName: "SUBSIDY",
  })
  return getAddress(subsidy)
}

export async function readWithdrawalExecutor(
  client: Pick<PublicClient, "readContract">,
  address: Address,
  kind: WithdrawalExecutorKind,
): Promise<WithdrawalExecutor> {
  if (kind === "sky") {
    return {
      address: getAddress(address),
      kind,
      portal: await readExecutorPortal(client, address),
      fee: 0n,
    }
  }
  const [portal, fee, beneficiary] = await Promise.all([
    readExecutorPortal(client, address),
    readPlainWithdrawalFee(client, EthAddress.fromString(address)),
    client.readContract({ address, abi: PlainWithdrawalExecutorAbi, functionName: "BENEFICIARY" }),
  ])
  return {
    address: getAddress(address),
    kind,
    portal,
    fee,
    ...(isAddressEqual(beneficiary, zeroAddress) ? {} : { beneficiary: getAddress(beneficiary) }),
  }
}

/** Throws unless `executor` serves `portal`: it reverts a call from any other portal. */
export function assertExecutorServesPortal(
  executor: Pick<WithdrawalExecutor, "address" | "portal">,
  portal: Address,
): void {
  if (!isAddressEqual(executor.portal, portal)) {
    throw new Error(
      `Withdrawal executor ${executor.address} serves portal ${executor.portal}, not ${portal}`,
    )
  }
}

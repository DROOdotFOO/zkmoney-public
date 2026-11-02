import type { Address, PublicClient } from "viem"
import { OxidePortalAbi } from "@oxide/l1-contracts/artifacts.js"
import { chunkedContractEvents } from "../../services/helpers/l1Logs.js"

/** The L1 block `portal` froze at, from its `Frozen` event in `range`; null while it runs. */
export async function readPortalFreezeBlock(
  publicClient: PublicClient,
  portal: Address,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<bigint | null> {
  const logs = await chunkedContractEvents(
    publicClient,
    { address: portal, abi: OxidePortalAbi, eventName: "Frozen" },
    range.fromBlock,
    range.toBlock,
  )
  return (logs[0] as { blockNumber: bigint } | undefined)?.blockNumber ?? null
}

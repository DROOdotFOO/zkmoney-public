/**
 * A sandbox SIPA's claim inputs, read the slow way: its own `Sweep` logs, then each sweep's receipt for the portal
 * `Deposit` it emitted. For fixtures that hold one address and no commitment; the wallet reads every SIPA at once
 * through `sipaChain.ts`.
 */
import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { OxidePortalEventsAbi, SIPAAbi } from "@oxide/l1-contracts"
import { chunkedContractEvents } from "../../../src/services/helpers/l1Logs.js"

export interface SipaSweepEvent {
  /** L1→L2 inbox leaf index: the claim's `inbox_index`. */
  index: bigint
  /** The amount credited on L2. */
  amount: bigint
  blockNumber: bigint
  txHash: Hex
}

/** Every `Sweep` of `sipa` from `fromBlock` (the chain start by default) to `toBlock` (the head). */
export async function readSweepEvents(
  publicClient: PublicClient,
  sipa: Address,
  fromBlock = 0n,
  toBlock?: bigint,
): Promise<SipaSweepEvent[]> {
  const head = toBlock ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))
  const logs = await chunkedContractEvents(
    publicClient,
    { address: sipa, abi: SIPAAbi, eventName: "Sweep" },
    fromBlock,
    head,
  )
  return logs.map((log) => {
    const { args, blockNumber, transactionHash } = log as unknown as {
      args: { index: bigint; amount: bigint }
      blockNumber: bigint
      transactionHash: Hex
    }
    return { index: args.index, amount: args.amount, blockNumber, txHash: transactionHash }
  })
}

/** The L1→L2 message key of the sweep at `inboxIndex` in `txHash`, or null when the receipt has none. */
export async function readDepositMessageKey(
  publicClient: PublicClient,
  portal: Address,
  txHash: Hex,
  inboxIndex: bigint,
): Promise<Fr | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== portal.toLowerCase()) continue
    try {
      const { args } = decodeEventLog({
        abi: OxidePortalEventsAbi,
        eventName: "Deposit",
        topics: log.topics,
        data: log.data,
      }) as unknown as { args: { key: Hex; index: bigint } }
      if (args.index === inboxIndex) return Fr.fromHexString(args.key)
    } catch {
      continue
    }
  }
  return null
}

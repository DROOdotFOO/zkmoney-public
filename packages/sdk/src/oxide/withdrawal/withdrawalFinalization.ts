// L1 finalization reads for oxide withdrawals. This is the sdk-layer home for
// the contract calls the front-core watcher must NOT originate (monorepo layering
// rule): front-core depends on the `WithdrawalFinalizationReader` interface and is
// handed a concrete reader at boot.
//
// Two reads:
//   - `isSpent`         — the authoritative per-withdrawal "finalized" signal
//                         (`OxidePortal.$isWithdrawalSpent`). Propagates RPC errors
//                         so the watcher can fail loudly / retry.
//   - `resolveL1TxHash` — a best-effort Etherscan-link lookup. Cosmetic; runs only
//                         after `isSpent` is already true, so it never throws and
//                         never blocks `done` — a missing link is fine, a wrong
//                         link is not.
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { erc20Abi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem"
import { readBlockTimeMs } from "../../services/sipa/sipaClaim.js"

export interface ResolveL1TxHashOptions {
  /** Explicit scan bounds. Omitted → the last `maxLookbackBlocks` up to head. */
  fromBlock?: bigint
  toBlock?: bigint
}

/**
 * Read-only view of L1 withdrawal finalization. front-core depends on this type;
 * the concrete `L1WithdrawalFinalizationReader` is injected at boot.
 */
export interface WithdrawalFinalizationReader {
  /** Authoritative done-signal: `OxidePortal.$isWithdrawalSpent(withdrawalId)`. */
  isSpent(withdrawalId: Hex): Promise<boolean>
  /**
   * Best-effort L1 release tx for the Etherscan link: the portal's `WithdrawalOrRefund` log for
   * `withdrawalId`. Returns `undefined` on an exhausted window or an unreadable chain. Never throws.
   */
  resolveL1TxHash(withdrawalId: Hex, options?: ResolveL1TxHashOptions): Promise<Hex | undefined>
  /** Block time (ms) of a resolved release tx, so a record rebuilt on a new device settles at the
   *  release rather than at discovery. Undefined when unreadable. Never throws. */
  l1TxTimestampMs?(txHash: Hex): Promise<number | undefined>
  /** Tokens `txHash` transferred to `recipient`, raw units. Undefined when unreadable. Never throws. */
  receivedIn?(txHash: Hex, recipient: Address): Promise<bigint | undefined>
}

export interface WithdrawalFinalizationReaderConfig {
  /** L1 TEE portal (`tuple.portal`) — home of `$isWithdrawalSpent` + `WithdrawalOrRefund`. */
  portal: Hex
  /** Cap on the backward scan when explicit bounds aren't given. Default 50_000. */
  maxLookbackBlocks?: bigint
  /** Per-`getLogs` chunk size, keeping ranges bounded (PAYG RPC). Default 10_000. */
  logRangeBlocks?: bigint
}

/** `IExecutor.Flow.Withdrawal`. */
const WITHDRAWAL_FLOW = 0

const DEFAULT_MAX_LOOKBACK_BLOCKS = 50_000n
const DEFAULT_LOG_RANGE_BLOCKS = 10_000n

/**
 * `OxidePortal.$isWithdrawalSpent(withdrawalId)` — the authoritative "already finalized" read.
 */
export function isWithdrawalSpent(
  client: PublicClient,
  portal: Hex,
  withdrawalId: Hex,
): Promise<boolean> {
  return client.readContract({
    address: portal,
    abi: OxidePortalAbi,
    functionName: "$isWithdrawalSpent",
    args: [withdrawalId],
  }) as Promise<boolean>
}

export class L1WithdrawalFinalizationReader implements WithdrawalFinalizationReader {
  private readonly portal: Hex
  private readonly maxLookbackBlocks: bigint
  private readonly logRangeBlocks: bigint

  constructor(private readonly client: PublicClient, config: WithdrawalFinalizationReaderConfig) {
    this.portal = config.portal.toLowerCase() as Hex
    this.maxLookbackBlocks = config.maxLookbackBlocks ?? DEFAULT_MAX_LOOKBACK_BLOCKS
    this.logRangeBlocks = config.logRangeBlocks ?? DEFAULT_LOG_RANGE_BLOCKS
  }

  isSpent(withdrawalId: Hex): Promise<boolean> {
    return isWithdrawalSpent(this.client, this.portal, withdrawalId)
  }

  async resolveL1TxHash(
    withdrawalId: Hex,
    options?: ResolveL1TxHashOptions,
  ): Promise<Hex | undefined> {
    try {
      const toBlock = options?.toBlock ?? (await this.client.getBlockNumber())
      const fromBlock =
        options?.fromBlock ??
        (toBlock > this.maxLookbackBlocks ? toBlock - this.maxLookbackBlocks : 0n)

      // A withdrawalId is spent once, so exactly one release logs it.
      for (let start = fromBlock; start <= toBlock; start += this.logRangeBlocks) {
        const end =
          start + this.logRangeBlocks - 1n < toBlock ? start + this.logRangeBlocks - 1n : toBlock
        const logs = await this.client.getContractEvents({
          address: this.portal,
          abi: OxidePortalAbi,
          eventName: "WithdrawalOrRefund",
          args: { flow: WITHDRAWAL_FLOW, nullifier: withdrawalId },
          fromBlock: start,
          toBlock: end,
          strict: true,
        })
        const hash = logs.find((log) => log.transactionHash)?.transactionHash
        if (hash) return hash
      }
      return undefined
    } catch {
      // Cosmetic link only — never block `done` on an RPC hiccup.
      return undefined
    }
  }

  async l1TxTimestampMs(txHash: Hex): Promise<number | undefined> {
    try {
      const { blockNumber } = await this.client.getTransactionReceipt({ hash: txHash })
      return await readBlockTimeMs(this.client, blockNumber)
    } catch {
      return undefined
    }
  }

  async receivedIn(txHash: Hex, recipient: Address): Promise<bigint | undefined> {
    try {
      const { logs } = await this.client.getTransactionReceipt({ hash: txHash })
      return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs, args: { to: recipient } }).reduce(
        (sum, log) => sum + log.args.value,
        0n,
      )
    } catch {
      return undefined
    }
  }
}

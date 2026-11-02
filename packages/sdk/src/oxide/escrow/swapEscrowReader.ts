/**
 * L1 reads over a swap-on-withdraw escrow, for the client that has to notice when nobody runs the
 * swap. Oxide's relayer drops an operation whose `deployAndExecute` keeps reverting and exposes no
 * status, so the wallet watches the escrow itself: its DAI balance says whether it is still funded,
 * its code says whether a `deployAndExecute` (or deploy-only `deploy`) ever ran, and a
 * `deployAndExecute` simulation says whether the route can deliver at all.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import {
  LegacySwapEscrowEventsAbi,
  LegacySwapEscrowFactoryAbi,
  SwapEscrowAbi,
  SwapEscrowFactoryAbi,
} from "@oxide/l1-contracts"
import type { SwapEscrowCommitment } from "./swapOnWithdraw.js"

export interface SwapEscrowReader {
  /** DAI held at the escrow. Zero once the swap ran or the DAI was recovered. */
  daiBalance(escrow: Address): Promise<bigint>
  /** Whether the escrow has code. A clone only appears through `deployAndExecute` or `deploy`. */
  isDeployed(escrow: Address): Promise<boolean>
  /**
   * Whether `factory.deployAndExecute(args)` would succeed now. False only on a contract revert (a min-out
   * miss, an ETH recipient that rejects ETH); an RPC failure throws so the caller retries.
   */
  deploySimulates(factory: Address, commitment: SwapEscrowCommitment): Promise<boolean>
  /**
   * Tx of the factory's execution log for `escrow`. Undefined when none is in the lookback window; an
   * RPC failure throws so the caller retries rather than reading it as "no swap".
   */
  executedTxHash(factory: Address, escrow: Address): Promise<Hex | undefined>
  /**
   * The escrow's recovery log: which tx moved the DAI out, and where. Undefined when none is in the
   * lookback window; an RPC failure throws.
   */
  recoveredTxHash(escrow: Address): Promise<SwapEscrowRecovery | undefined>
}

export interface SwapEscrowRecovery {
  txHash: Hex
  target: Address
}

export interface SwapEscrowReaderConfig {
  /** The withdrawn token (`tuple.token`). */
  dai: Address
  /** Cap on the backward log scan. Default 50_000. */
  maxLookbackBlocks?: bigint
  /** Per-`getLogs` chunk size, keeping ranges bounded (PAYG RPC). Default 10_000. */
  logRangeBlocks?: bigint
}

const DEFAULT_MAX_LOOKBACK_BLOCKS = 50_000n
const DEFAULT_LOG_RANGE_BLOCKS = 10_000n

export class L1SwapEscrowReader implements SwapEscrowReader {
  private readonly dai: Address
  private readonly maxLookbackBlocks: bigint
  private readonly logRangeBlocks: bigint

  constructor(private readonly client: PublicClient, config: SwapEscrowReaderConfig) {
    this.dai = config.dai
    this.maxLookbackBlocks = config.maxLookbackBlocks ?? DEFAULT_MAX_LOOKBACK_BLOCKS
    this.logRangeBlocks = config.logRangeBlocks ?? DEFAULT_LOG_RANGE_BLOCKS
  }

  daiBalance(escrow: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.dai,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [escrow],
    })
  }

  async isDeployed(escrow: Address): Promise<boolean> {
    const code = await this.client.getCode({ address: escrow })
    return code !== undefined && code !== "0x"
  }

  async deploySimulates(factory: Address, commitment: SwapEscrowCommitment): Promise<boolean> {
    try {
      await this.client.simulateContract({
        address: factory,
        abi: commitment.layout === "v2" ? SwapEscrowFactoryAbi : LegacySwapEscrowFactoryAbi,
        functionName: "deployAndExecute",
        args: [commitment.args] as never,
        // `deployAndExecute` pays its caller the tip, and an ERC20 refuses the zero address, so the simulation
        // needs a real payee. The recipient is one the escrow already commits to.
        account: commitment.args.recipient,
      })
      return true
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) {
        return false
      }
      // A revert without decodable data still surfaces as an execution error carrying "reverted".
      if (err instanceof BaseError && /revert/i.test(err.shortMessage)) return false
      throw err
    }
  }

  // Factories and escrows deployed before oxide's `EscrowBase` emit the legacy event names, and a
  // persisted withdrawal keeps the factory it was built against, so both names are read.
  async executedTxHash(factory: Address, escrow: Address): Promise<Hex | undefined> {
    const hit = await this.findLog(async (fromBlock, toBlock) => {
      const range = { address: factory, args: { escrow }, fromBlock, toBlock, strict: true } as const
      const [current, legacy] = await Promise.all([
        this.client.getContractEvents({ ...range, abi: SwapEscrowFactoryAbi, eventName: "EscrowExecuted" }),
        this.client.getContractEvents({
          ...range,
          abi: LegacySwapEscrowEventsAbi,
          eventName: "SwapEscrowExecuted",
        }),
      ])
      return [...current, ...legacy]
    })
    return hit?.transactionHash
  }

  async recoveredTxHash(escrow: Address): Promise<SwapEscrowRecovery | undefined> {
    const hit = await this.findLog(async (fromBlock, toBlock) => {
      const range = { address: escrow, fromBlock, toBlock, strict: true } as const
      const [current, legacy] = await Promise.all([
        this.client.getContractEvents({ ...range, abi: SwapEscrowAbi, eventName: "EscrowRecovered" }),
        this.client.getContractEvents({
          ...range,
          abi: LegacySwapEscrowEventsAbi,
          eventName: "SwapEscrowRecovered",
        }),
      ])
      return [...current, ...legacy]
    })
    return hit ? { txHash: hit.transactionHash, target: hit.args.target } : undefined
  }

  /** The first mined log `fetch` yields, scanning the lookback window in bounded chunks. */
  private async findLog<T extends { transactionHash: Hex | null }>(
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  ): Promise<(T & { transactionHash: Hex }) | undefined> {
    // Uncached: viem caches the head for a polling interval, and a lagging head misses the log of the
    // execution whose emptied balance the caller just read.
    const toBlock = await this.client.getBlockNumber({ cacheTime: 0 })
    const fromBlock = toBlock > this.maxLookbackBlocks ? toBlock - this.maxLookbackBlocks : 0n
    for (let start = fromBlock; start <= toBlock; start += this.logRangeBlocks) {
      const end =
        start + this.logRangeBlocks - 1n < toBlock ? start + this.logRangeBlocks - 1n : toBlock
      const hit = (await fetch(start, end)).find((log) => log.transactionHash)
      if (hit) return hit as T & { transactionHash: Hex }
    }
    return undefined
  }
}

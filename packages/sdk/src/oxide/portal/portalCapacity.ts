/**
 * The portal's deposit capacity and per-transaction cap (`Caps.sol`), read through its public getters. Every value
 * comes from one L1 block, so capacity, ceiling, refill rate and cap always describe the same chain state.
 */
import {
  BaseError,
  ContractFunctionZeroDataError,
  erc20Abi,
  type Address,
  type PublicClient,
} from "viem"
import { OxidePortalAbi } from "@oxide/l1-contracts/artifacts.js"

export interface PortalCapacitySnapshot {
  /** The chain the RPC reported, not the one the caller expected. */
  chainId: number
  portal: Address
  /** The portal's `UNDERLYING`, checked against the token the caller named. */
  token: Address
  decimals: number
  blockNumber: bigint
  /** Seconds. */
  blockTimestamp: bigint
  /** `RATE()`: token base units added per second. */
  rateAtomicPerSecond: bigint
  /** `GLOBAL_LIMIT()`: the most the bucket can hold. */
  globalLimitAtomic: bigint
  /** `getCurrentAvailable()` at `blockNumber`. */
  availableAtomic: bigint
  /** `TX_AMOUNT_CAP()`: the most one operation may move, in settlement-token base units. */
  txAmountCapAtomic: bigint
}

export type PortalCapacityUnsupportedReason =
  | "token-mismatch"
  | "no-capacity-getters"
  | "chain-mismatch"

/** The portal cannot report capacity for this token on this RPC. Retrying does not help. */
export class PortalCapacityUnsupportedError extends Error {
  constructor(readonly reason: PortalCapacityUnsupportedReason, message: string) {
    super(message)
    this.name = "PortalCapacityUnsupportedError"
  }
}

/** A call that returns no data hits an address without that function; any other failure passes through. */
const unsupportedOnZeroData =
  (reason: PortalCapacityUnsupportedReason, detail: string) =>
  (err: unknown): never => {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError)) {
      throw new PortalCapacityUnsupportedError(reason, detail)
    }
    throw err
  }

/**
 * Read the portal's capacity at the latest block. With `chainId`, an RPC on another chain is refused before any
 * contract read. RPC failures reject with the RPC error.
 */
export async function readPortalCapacity(
  client: PublicClient,
  target: { portal: Address; token: Address; chainId?: number },
): Promise<PortalCapacitySnapshot> {
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "latest" }),
  ])
  if (target.chainId !== undefined && chainId !== target.chainId) {
    throw new PortalCapacityUnsupportedError(
      "chain-mismatch",
      `RPC serves chain ${chainId}, not ${target.chainId}`,
    )
  }
  const blockNumber = block.number
  const portalRead = <
    F extends "UNDERLYING" | "RATE" | "GLOBAL_LIMIT" | "getCurrentAvailable" | "TX_AMOUNT_CAP",
  >(
    functionName: F,
  ) =>
    client
      .readContract({ address: target.portal, abi: OxidePortalAbi, functionName, blockNumber })
      .catch(
        unsupportedOnZeroData(
          "no-capacity-getters",
          `portal ${target.portal} returned no data for ${functionName}() at block ${blockNumber}`,
        ),
      )
  const [underlying, rate, globalLimit, available, txAmountCap, decimals] = await Promise.all([
    portalRead("UNDERLYING"),
    portalRead("RATE"),
    portalRead("GLOBAL_LIMIT"),
    portalRead("getCurrentAvailable"),
    portalRead("TX_AMOUNT_CAP"),
    client
      .readContract({ address: target.token, abi: erc20Abi, functionName: "decimals", blockNumber })
      .catch(
        unsupportedOnZeroData(
          "token-mismatch",
          `token ${target.token} returned no data for decimals() at block ${blockNumber}`,
        ),
      ),
  ])
  if (underlying.toLowerCase() !== target.token.toLowerCase()) {
    throw new PortalCapacityUnsupportedError(
      "token-mismatch",
      `portal ${target.portal} settles in ${underlying}, not ${target.token}`,
    )
  }
  return {
    chainId,
    portal: target.portal,
    token: underlying,
    decimals,
    blockNumber,
    blockTimestamp: block.timestamp,
    rateAtomicPerSecond: rate,
    globalLimitAtomic: globalLimit,
    availableAtomic: available,
    txAmountCapAtomic: txAmountCap,
  }
}

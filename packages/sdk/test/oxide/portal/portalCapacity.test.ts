import { describe, expect, it, vi } from "vitest"
import {
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  type PublicClient,
} from "viem"
import { OxidePortalAbi } from "@oxide/l1-contracts"

import {
  PortalCapacityUnsupportedError,
  readPortalCapacity,
} from "../../../src/oxide/portal/portalCapacity.js"

const portal = `0x${"11".repeat(20)}` as const
const token = `0x${"22".repeat(20)}` as const
const BLOCK = 1234n

function client(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    UNDERLYING: token.toUpperCase().replace("0X", "0x"),
    RATE: 7n,
    GLOBAL_LIMIT: 500_000n * 10n ** 18n,
    TX_AMOUNT_CAP: 5_166n * 10n ** 18n,
    getCurrentAvailable: 123n,
    decimals: 6,
    ...overrides,
  }
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    const value = values[functionName]
    if (value instanceof Error) throw value
    return value
  })
  const getBlock = vi.fn(async () => ({ number: BLOCK, timestamp: 1_700_000_000n }))
  const getChainId = vi.fn(async () => 31337)
  return {
    client: { readContract, getBlock, getChainId } as unknown as PublicClient,
    readContract,
    getBlock,
  }
}

describe("readPortalCapacity", () => {
  it("reads every value at the one block it fetched", async () => {
    const { client: c, readContract, getBlock } = client()

    const snapshot = await readPortalCapacity(c, { portal, token })

    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" })
    expect(snapshot).toEqual({
      chainId: 31337,
      portal,
      token: token.toUpperCase().replace("0X", "0x"),
      decimals: 6,
      blockNumber: BLOCK,
      blockTimestamp: 1_700_000_000n,
      rateAtomicPerSecond: 7n,
      globalLimitAtomic: 500_000n * 10n ** 18n,
      txAmountCapAtomic: 5_166n * 10n ** 18n,
      availableAtomic: 123n,
    })
    const calls = readContract.mock.calls.map(([call]) => call as Record<string, unknown>)
    expect(calls.map((call) => call.functionName).sort()).toEqual(
      [
        "GLOBAL_LIMIT",
        "RATE",
        "TX_AMOUNT_CAP",
        "UNDERLYING",
        "decimals",
        "getCurrentAvailable",
      ].sort(),
    )
    expect(calls.every((call) => call.blockNumber === BLOCK)).toBe(true)
    expect(
      calls
        .filter((call) => call.functionName !== "decimals")
        .every((call) => call.abi === OxidePortalAbi),
    ).toBe(true)
    expect(calls.find((call) => call.functionName === "decimals")?.address).toBe(token)
  })

  it("keeps a zero capacity as a value, not a failure", async () => {
    const snapshot = await readPortalCapacity(
      client({ getCurrentAvailable: 0n, RATE: 0n }).client,
      {
        portal,
        token,
      },
    )
    expect(snapshot.availableAtomic).toBe(0n)
    expect(snapshot.rateAtomicPerSecond).toBe(0n)
  })

  it("refuses a portal that settles in another token", async () => {
    const other = `0x${"33".repeat(20)}`
    const read = readPortalCapacity(client({ UNDERLYING: other }).client, { portal, token })
    await expect(read).rejects.toBeInstanceOf(PortalCapacityUnsupportedError)
    await expect(read).rejects.toMatchObject({ reason: "token-mismatch" })
  })

  const zeroData = (functionName: string) =>
    new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName }), {
      abi: OxidePortalAbi,
      functionName,
      contractAddress: portal,
    })

  it("reports a portal without the capacity getters as unsupported, naming the getter", async () => {
    const read = readPortalCapacity(client({ RATE: zeroData("RATE") }).client, { portal, token })
    await expect(read).rejects.toMatchObject({
      reason: "no-capacity-getters",
      message: expect.stringContaining("RATE()"),
    })
  })

  it("blames the token, not the portal, when the token has no decimals()", async () => {
    const read = readPortalCapacity(client({ decimals: zeroData("decimals") }).client, {
      portal,
      token,
    })
    await expect(read).rejects.toMatchObject({
      reason: "token-mismatch",
      message: expect.stringContaining(`token ${token} returned no data for decimals()`),
    })
  })

  it("refuses an RPC on another chain before any contract read", async () => {
    const { client: c, readContract } = client({ RATE: zeroData("RATE") })
    const read = readPortalCapacity(c, { portal, token, chainId: 1 })
    await expect(read).rejects.toMatchObject({ reason: "chain-mismatch" })
    expect(readContract).not.toHaveBeenCalled()
    await expect(readPortalCapacity(c, { portal, token, chainId: 31337 })).rejects.toMatchObject({
      reason: "no-capacity-getters",
    })
  })

  it("passes an RPC failure through unchanged", async () => {
    const failure = new Error("header not found")
    await expect(
      readPortalCapacity(client({ getCurrentAvailable: failure }).client, { portal, token }),
    ).rejects.toBe(failure)
  })
})

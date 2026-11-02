import { describe, expect, it } from "vitest"
import type { PublicClient } from "viem"
import {
  chunkedContractEvents,
  L1_LOG_CHUNK_CONCURRENCY,
  L1_LOG_RANGE_BLOCKS,
} from "../../../src/services/helpers/l1Logs.js"

const REQUEST = { address: `0x${"11".repeat(20)}` as const, abi: [], eventName: "Ping" }

/** What an RPC that caps ranges answers to a window wider than one chunk. */
const refuseWide = (fromBlock: bigint, toBlock: bigint) => {
  if (toBlock - fromBlock >= L1_LOG_RANGE_BLOCKS) throw new Error("block range too large")
}

/** A client whose chunks answer in reverse order of asking, recording each window and the peak in flight. */
function slowClient() {
  const windows: [bigint, bigint][] = []
  let inFlight = 0
  let peak = 0
  const client = {
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      refuseWide(fromBlock, toBlock)
      windows.push([fromBlock, toBlock])
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) =>
        setTimeout(resolve, 30 - Number(fromBlock / L1_LOG_RANGE_BLOCKS)),
      )
      inFlight--
      return [{ fromBlock }]
    },
  }
  return { client: client as unknown as PublicClient, windows, peak: () => peak }
}

describe("chunkedContractEvents", () => {
  it("covers the window in range-sized chunks, at most the bounded number at once, in block order", async () => {
    const { client, windows, peak } = slowClient()
    const to = 20n * L1_LOG_RANGE_BLOCKS + 5n
    const logs = (await chunkedContractEvents(client, REQUEST, 0n, to)) as { fromBlock: bigint }[]
    expect(windows).toHaveLength(21)
    expect([...windows].sort((a, b) => Number(a[0] - b[0])).at(-1)).toEqual([
      20n * L1_LOG_RANGE_BLOCKS,
      to,
    ])
    expect(peak()).toBe(L1_LOG_CHUNK_CONCURRENCY)
    expect(logs.map((l) => l.fromBlock)).toEqual(
      Array.from({ length: 21 }, (_, i) => BigInt(i) * L1_LOG_RANGE_BLOCKS),
    )
  })

  it("reads a wide window in one request from an RPC that serves it", async () => {
    const windows: [bigint, bigint][] = []
    const client = {
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        windows.push([fromBlock, toBlock])
        return [{ fromBlock }]
      },
    } as unknown as PublicClient
    await chunkedContractEvents(client, REQUEST, 0n, 5_000_000n)
    expect(windows).toEqual([[0n, 5_000_000n]])
  })

  it("reads the rest one at a time after a refused round, still complete and in block order", async () => {
    let calls = 0
    let inFlight = 0
    let peakAfterRound = 0
    const client = {
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        refuseWide(fromBlock, toBlock)
        calls++
        inFlight++
        if (calls > L1_LOG_CHUNK_CONCURRENCY) peakAfterRound = Math.max(peakAfterRound, inFlight)
        try {
          if (calls === 2) throw new Error("429 Too Many Requests")
          await new Promise((resolve) => setTimeout(resolve, 5))
          return [{ fromBlock }]
        } finally {
          inFlight--
        }
      },
    } as unknown as PublicClient
    const logs = (await chunkedContractEvents(
      client,
      REQUEST,
      0n,
      20n * L1_LOG_RANGE_BLOCKS - 1n,
    )) as { fromBlock: bigint }[]
    expect(logs.map((l) => l.fromBlock)).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(i) * L1_LOG_RANGE_BLOCKS),
    )
    // The first round drains; the refused chunk and every one after the round go alone.
    expect(calls).toBe(21)
    expect(peakAfterRound).toBe(1)
  })

  it("fails the scan when a chunk fails even read alone", async () => {
    const bad = 3n * L1_LOG_RANGE_BLOCKS
    const client = {
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        refuseWide(fromBlock, toBlock)
        if (fromBlock === bad) throw new Error("rpc down")
        return []
      },
    } as unknown as PublicClient
    await expect(
      chunkedContractEvents(client, REQUEST, 0n, 10n * L1_LOG_RANGE_BLOCKS),
    ).rejects.toThrow("rpc down")
  })
})

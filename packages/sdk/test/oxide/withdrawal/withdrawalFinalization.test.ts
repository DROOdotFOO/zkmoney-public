/**
 * The reader runs against a real viem client over an in-memory `eth_getLogs`, so the event filter
 * is encoded to topics and the portal's `WithdrawalOrRefund` logs are decoded exactly as on L1.
 */
import { OxidePortalAbi } from "@oxide/l1-contracts"
import {
  type Hex,
  type PublicClient,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
} from "viem"
import { describe, expect, it, vi } from "vitest"

import { L1WithdrawalFinalizationReader } from "../../../src/oxide/withdrawal/withdrawalFinalization.js"

const PORTAL = ("0x" + "1A".repeat(20)) as Hex
const OTHER_PORTAL = ("0x" + "88".repeat(20)) as Hex
const EXECUTOR = ("0x" + "e0".repeat(20)) as Hex

const WID_A = ("0x" + "a1".repeat(32)) as Hex
const WID_B = ("0x" + "b2".repeat(32)) as Hex

const TX1 = ("0x" + "01".repeat(32)) as Hex
const TX2 = ("0x" + "02".repeat(32)) as Hex
const TX3 = ("0x" + "03".repeat(32)) as Hex

/** `IExecutor.Flow`. */
const Flow = { Withdrawal: 0, FrozenNotesRefund: 1 } as const

interface Release {
  portal?: Hex
  flow: number
  nullifier: Hex
  block: bigint
  tx: Hex
}

type Topic = Hex | Hex[] | null

function topicMatches(filter: Topic | undefined, topic: Hex | undefined) {
  if (filter === undefined || filter === null) return true
  const wanted = Array.isArray(filter) ? filter : [filter]
  return wanted.some((t) => t.toLowerCase() === topic?.toLowerCase())
}

/** A viem client whose node holds `releases`, recording each `eth_getLogs` range it serves. */
function chain(releases: Release[], head = 1_000n) {
  const ranges: [bigint, bigint][] = []
  const logs = releases.map((release, i) => ({
    address: (release.portal ?? PORTAL).toLowerCase() as Hex,
    topics: encodeEventTopics({
      abi: OxidePortalAbi,
      eventName: "WithdrawalOrRefund",
      args: { flow: release.flow, nullifier: release.nullifier, executor: EXECUTOR },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [1_000n]),
    blockNumber: release.block,
    transactionHash: release.tx,
    logIndex: i,
  }))
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_blockNumber") return numberToHex(head)
    if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`)
    const [filter] = params as [{ address: Hex; topics: Topic[]; fromBlock: Hex; toBlock: Hex }]
    const from = BigInt(filter.fromBlock)
    const to = BigInt(filter.toBlock)
    ranges.push([from, to])
    return logs
      .filter(
        (log) =>
          log.address === filter.address.toLowerCase() &&
          log.blockNumber >= from &&
          log.blockNumber <= to &&
          filter.topics.every((topic, i) => topicMatches(topic, log.topics[i])),
      )
      .map((log) => ({
        ...log,
        blockNumber: numberToHex(log.blockNumber),
        logIndex: numberToHex(log.logIndex),
        blockHash: "0x" + "bb".repeat(32),
        transactionIndex: "0x0",
        removed: false,
      }))
  })
  const client = createPublicClient({ transport: custom({ request }) }) as PublicClient
  return { client, request, ranges }
}

function reader(
  client: PublicClient,
  config: { maxLookbackBlocks?: bigint; logRangeBlocks?: bigint } = {},
) {
  return new L1WithdrawalFinalizationReader(client, { portal: PORTAL, ...config })
}

describe("isSpent", () => {
  it("reads $isWithdrawalSpent on the portal", async () => {
    const readContract = vi.fn(async () => true)
    const client = { readContract } as unknown as PublicClient
    expect(await reader(client).isSpent(WID_A)).toBe(true)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PORTAL.toLowerCase(),
        functionName: "$isWithdrawalSpent",
        args: [WID_A],
      }),
    )
  })

  it("propagates RPC errors (loud, not swallowed)", async () => {
    const client = {
      readContract: vi.fn(async () => Promise.reject(new Error("rpc down"))),
    } as unknown as PublicClient
    await expect(reader(client).isSpent(WID_A)).rejects.toThrow(/rpc down/)
  })
})

describe("resolveL1TxHash", () => {
  it("returns the tx of the withdrawal release that nullifies the id", async () => {
    const { client } = chain([
      { flow: Flow.Withdrawal, nullifier: WID_B, block: 900n, tx: TX2 },
      { flow: Flow.Withdrawal, nullifier: WID_A, block: 950n, tx: TX1 },
    ])
    expect(await reader(client).resolveL1TxHash(WID_A)).toBe(TX1)
    expect(await reader(client).resolveL1TxHash(WID_B)).toBe(TX2)
  })

  it("filters on the withdrawal flow, so a refund with the same nullifier is not the release", async () => {
    const { client } = chain([
      { flow: Flow.FrozenNotesRefund, nullifier: WID_A, block: 900n, tx: TX3 },
    ])
    expect(await reader(client).resolveL1TxHash(WID_A)).toBeUndefined()
  })

  it("reads only our portal's logs", async () => {
    const { client } = chain([
      { portal: OTHER_PORTAL, flow: Flow.Withdrawal, nullifier: WID_A, block: 900n, tx: TX3 },
    ])
    expect(await reader(client).resolveL1TxHash(WID_A)).toBeUndefined()
  })

  it("scans the lookback window up to head in bounded chunks, stopping at the release", async () => {
    const { client, ranges } = chain(
      [{ flow: Flow.Withdrawal, nullifier: WID_A, block: 18n, tx: TX1 }],
      25n,
    )
    const r = reader(client, { maxLookbackBlocks: 20n, logRangeBlocks: 10n })
    expect(await r.resolveL1TxHash(WID_A)).toBe(TX1)
    expect(ranges).toEqual([
      [5n, 14n],
      [15n, 24n],
    ])

    ranges.length = 0
    expect(await r.resolveL1TxHash(WID_B)).toBeUndefined()
    expect(ranges).toEqual([
      [5n, 14n],
      [15n, 24n],
      [25n, 25n],
    ])
  })

  it("starts at genesis when head is inside the lookback, and honours explicit bounds", async () => {
    const { client, request, ranges } = chain([], 30n)
    await reader(client).resolveL1TxHash(WID_A)
    expect(ranges).toEqual([[0n, 30n]])

    ranges.length = 0
    request.mockClear()
    await reader(client).resolveL1TxHash(WID_A, { fromBlock: 100n, toBlock: 120n })
    expect(ranges).toEqual([[100n, 120n]])
    expect(request.mock.calls.map(([{ method }]) => method)).toEqual(["eth_getLogs"])
  })

  it("never throws — swallows RPC errors and returns undefined (cosmetic link)", async () => {
    const headDown = {
      getBlockNumber: vi.fn(async () => Promise.reject(new Error("rpc down"))),
    } as unknown as PublicClient
    expect(await reader(headDown).resolveL1TxHash(WID_A)).toBeUndefined()

    const logsDown = {
      getBlockNumber: vi.fn(async () => 10n),
      getContractEvents: vi.fn(async () => Promise.reject(new Error("rpc down"))),
    } as unknown as PublicClient
    expect(await reader(logsDown).resolveL1TxHash(WID_A)).toBeUndefined()
  })
})

describe("l1TxTimestampMs", () => {
  it("reads the release block's time, and undefined when unreadable", async () => {
    const client = {
      getTransactionReceipt: vi.fn(async () => ({ blockNumber: 7n })),
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
    } as unknown as PublicClient
    expect(await reader(client).l1TxTimestampMs!(TX1)).toBe(1_700_000_000_000)
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 7n })

    const missing = {
      getTransactionReceipt: vi.fn(async () => Promise.reject(new Error("not found"))),
    } as unknown as PublicClient
    expect(await reader(missing).l1TxTimestampMs!(TX1)).toBeUndefined()
  })
})

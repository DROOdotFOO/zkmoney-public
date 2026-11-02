import type { Address, PublicClient } from "viem"

/** Per-`getLogs` chunk. 10k is the ceiling public RPCs converge on; over it they reject outright. */
export const L1_LOG_RANGE_BLOCKS = 10_000n

/**
 * Chunks in flight at once. Same-tick requests share one JSON-RPC batch on a batching transport, so
 * this is roughly the chunks per round trip; bounded so a long window never sends one huge batch.
 */
export const L1_LOG_CHUNK_CONCURRENCY = 8

/**
 * `getContractEvents` over an explicit window, split into chunks an RPC serves. The window is the
 * caller's: how far back a scan must reach is a completeness decision, and each reader owns its
 * own. This owns the chunking alone. Logs come back in block order whatever order chunks answer in.
 *
 * A window wider than one chunk is asked for whole first: an archive RPC answers a filtered range of
 * millions of blocks in one request, and one that refuses it is read in chunks.
 */
export async function chunkedContractEvents(
  publicClient: PublicClient,
  request: { address: Address | Address[]; abi: unknown; eventName: string; args?: unknown },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<unknown[]> {
  if (toBlock - fromBlock >= L1_LOG_RANGE_BLOCKS) {
    try {
      return (await publicClient.getContractEvents({
        ...request,
        fromBlock,
        toBlock,
      } as never)) as unknown[]
    } catch {
      // Over the RPC's range or result cap: read it in chunks.
    }
  }
  const ranges: { from: bigint; to: bigint }[] = []
  for (let from = fromBlock; from <= toBlock; from += L1_LOG_RANGE_BLOCKS) {
    const chunkEnd = from + L1_LOG_RANGE_BLOCKS - 1n
    ranges.push({ from, to: chunkEnd < toBlock ? chunkEnd : toBlock })
  }
  const read = (i: number) =>
    publicClient.getContractEvents({
      ...request,
      fromBlock: ranges[i]!.from,
      toBlock: ranges[i]!.to,
    } as never) as Promise<unknown[]>
  const chunks: (unknown[] | undefined)[] = new Array(ranges.length)
  let next = 0
  // An RPC that rate-limits batched calls refuses a round: stop taking chunks, and read what is left
  // one at a time below, where the transport's own retry applies to each call.
  let refused = false
  const worker = async () => {
    while (next < ranges.length && !refused) {
      const i = next++
      try {
        chunks[i] = await read(i)
      } catch {
        refused = true
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(L1_LOG_CHUNK_CONCURRENCY, ranges.length) }, worker),
  )
  for (let i = 0; i < ranges.length; i++) chunks[i] ??= await read(i)
  return chunks.flat() as unknown[]
}

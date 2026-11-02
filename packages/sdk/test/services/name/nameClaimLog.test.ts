/**
 * Witness recovery from the NameRegistry's `NameClaimed` log — unit tests against a stub client. Two
 * things are ours and load-bearing: the selection (the event also fires on name CHANGES, so an
 * account can carry several logs and handing a superseded one to `subscribe_with_name_claim` would
 * present a signature over a name the account no longer owns), and the result contract — `null`
 * means exactly "the live binding is zero"; every other shortfall throws, because callers treat
 * null as "never claimed, pay your own fees" and a scan failure must not buy that downgrade.
 */

import { describe, expect, it } from "vitest"
import type { Address, Hex, PublicClient } from "viem"
import {
  NameClaimScanExhaustedError,
  readNameClaimLog,
} from "../../../src/services/name/nameClaimLog.js"

const NAME_REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
const OLD_NAME = `0x${"11".repeat(32)}` as Hex
const LIVE_NAME = `0x${"22".repeat(32)}` as Hex
const ZERO_NAME = `0x${"00".repeat(32)}` as Hex

const log = (nameHash: Hex, nonce: bigint, signature: Hex) => ({
  args: { owner: ACCOUNT, nameHash, nonce, deadline: 1893456000n, signature },
})

function stubClient(opts: {
  nameHash: Hex
  logs: ReturnType<typeof log>[]
  head?: bigint
  /** Serve logs only when the requested range covers this block (simulates an old claim). */
  logsAtBlock?: bigint
}): {
  client: PublicClient
  calls: { fromBlock?: bigint | string; toBlock?: bigint | string; args?: unknown }[]
} {
  const calls: { fromBlock?: bigint | string; toBlock?: bigint | string; args?: unknown }[] = []
  const client = {
    readContract: async () => opts.nameHash,
    getBlockNumber: async () => opts.head ?? 5_000n,
    getLogs: async (params: { fromBlock?: bigint; toBlock?: bigint; args?: unknown }) => {
      calls.push(params)
      if (opts.logsAtBlock !== undefined) {
        const from = typeof params.fromBlock === "bigint" ? params.fromBlock : 0n
        const to = typeof params.toBlock === "bigint" ? params.toBlock : opts.head ?? 5_000n
        return from <= opts.logsAtBlock && opts.logsAtBlock <= to ? opts.logs : []
      }
      return opts.logs
    },
  } as unknown as PublicClient
  return { client, calls }
}

describe("readNameClaimLog", () => {
  it("returns the claim artifacts for a registered account", async () => {
    const { client, calls } = stubClient({
      nameHash: LIVE_NAME,
      logs: [log(LIVE_NAME, 7n, "0xabcd")],
    })
    const record = await readNameClaimLog(client, NAME_REGISTRY, ACCOUNT)

    expect(record).toEqual({
      nameHash: LIVE_NAME,
      nonce: "7",
      deadline: "1893456000",
      signature: "0xabcd",
    })
    // Scoped to both indexed topics — the account alone would also match superseded names.
    expect(calls[0]?.args).toEqual({ owner: ACCOUNT, nameHash: LIVE_NAME })
  })

  it("takes the newest log, so a name change supersedes the claim that preceded it", async () => {
    const { client } = stubClient({
      nameHash: LIVE_NAME,
      logs: [log(LIVE_NAME, 1n, "0x1111"), log(LIVE_NAME, 2n, "0x2222")],
    })
    expect((await readNameClaimLog(client, NAME_REGISTRY, ACCOUNT))?.nonce).toBe("2")
  })

  it("is null for an account that never claimed — the live read decides, no scan runs", async () => {
    const { client, calls } = stubClient({
      nameHash: ZERO_NAME,
      logs: [log(OLD_NAME, 1n, "0x1111")],
    })
    expect(await readNameClaimLog(client, NAME_REGISTRY, ACCOUNT)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("scans backward in range-capped chunks and finds an old claim past the first chunk", async () => {
    // Claim at block 100 with head at 25_000: three chunks before the hit.
    const { client, calls } = stubClient({
      nameHash: LIVE_NAME,
      logs: [log(LIVE_NAME, 3n, "0x3333")],
      head: 25_000n,
      logsAtBlock: 100n,
    })
    expect((await readNameClaimLog(client, NAME_REGISTRY, ACCOUNT))?.nonce).toBe("3")
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) {
      const from = c.fromBlock as bigint
      const to = c.toBlock as bigint
      expect(to - from + 1n).toBeLessThanOrEqual(9_000n)
    }
  })

  it("throws (integrity), never null, when a live binding has no log in the full history", async () => {
    const { client } = stubClient({ nameHash: LIVE_NAME, logs: [], head: 20_000n })
    await expect(readNameClaimLog(client, NAME_REGISTRY, ACCOUNT)).rejects.toThrow(
      /no NameClaimed log exists/,
    )
  })

  it("throws NameClaimScanExhaustedError when the chunk budget runs out before genesis", async () => {
    // Head deep enough that 200 chunks of 9k blocks cannot reach block 0.
    const { client } = stubClient({ nameHash: LIVE_NAME, logs: [], head: 9_000n * 250n })
    await expect(readNameClaimLog(client, NAME_REGISTRY, ACCOUNT)).rejects.toThrow(
      NameClaimScanExhaustedError,
    )
  })

  it("with an explicit fromBlock: one ranged query; a miss throws rather than lying null", async () => {
    const { client, calls } = stubClient({ nameHash: LIVE_NAME, logs: [], head: 20_000n })
    await expect(readNameClaimLog(client, NAME_REGISTRY, ACCOUNT, 1_000n)).rejects.toThrow(
      NameClaimScanExhaustedError,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.fromBlock).toBe(1_000n)
  })

  it("propagates a mid-scan RPC failure — never converts it to null", async () => {
    const client = {
      readContract: async () => LIVE_NAME,
      getBlockNumber: async () => 5_000n,
      getLogs: async () => {
        throw new Error("rpc range cap")
      },
    } as unknown as PublicClient
    await expect(readNameClaimLog(client, NAME_REGISTRY, ACCOUNT)).rejects.toThrow("rpc range cap")
  })
})

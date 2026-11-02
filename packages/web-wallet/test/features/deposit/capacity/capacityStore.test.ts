/**
 * The shared capacity registry: one store per bucket for every consumer, reads bound to the configured L1 client
 * and the key's chain, bounded by the Aztec node's synced L1 time (the pre-boot client, then the booted one), and
 * the active deployment's key taken from the manifest tuple.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const CHAIN = 11155111
const PORTAL = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"
const OTHER_PORTAL = "0x1111111111111111111111111111111111111111"
const TOKEN = "0x2222222222222222222222222222222222222222"
const ROW_TOKEN = "0x3333333333333333333333333333333333333333"

const config = vi.hoisted(() => ({
  network: "testnet" as string,
  nodeUrl: "http://node.invalid",
  nodeApiKey: "node-key",
}))
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000))
/** An Aztec node as the reference sees it; `synced` is read on every call. */
const makeNode = (chainId = 11155111) => {
  const node = {
    synced: undefined as bigint | undefined | "now",
    down: false,
    getChainId: vi.fn(async () => {
      if (node.down) throw new Error("node down")
      return chainId
    }),
    getSyncedL1Timestamp: vi.fn(async () => (node.synced === "now" ? nowSeconds() : node.synced)),
  }
  node.synced = "now"
  return node
}
const nodes = vi.hoisted(() => ({ preBoot: undefined as unknown }))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  createNode: vi.fn(() => nodes.preBoot),
}))
const reads = vi.hoisted(() => [] as { address: string; functionName: string }[])
const client = vi.hoisted(() => ({
  getChainId: async () => 11155111,
  blockAgeSeconds: 0n,
  getBlock: async () => ({
    number: 10n,
    timestamp: BigInt(Math.floor(Date.now() / 1000)) - client.blockAgeSeconds,
  }),
  readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
    reads.push({ address, functionName })
    return {
      UNDERLYING: "0x2222222222222222222222222222222222222222",
      RATE: 1n,
      GLOBAL_LIMIT: 100n,
      getCurrentAvailable: 40n,
      decimals: 18,
    }[functionName]
  },
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => config }))
const tuple = vi.hoisted(() => ({
  fail: false,
  chainId: "11155111" as string | undefined,
  underlying: undefined as string | undefined,
}))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => client,
  getOxideTuple: async () => {
    if (tuple.fail) throw new Error("manifest fetch failed")
    return { chainId: tuple.chainId, portal: PORTAL, token: TOKEN, underlying: tuple.underlying }
  },
  getOxideDeployment: async () => ({
    deployment: {
      bridges: [
        {
          underlying: TOKEN,
          portal: PORTAL,
          tuple: { chainId: tuple.chainId, portal: PORTAL, token: TOKEN },
        },
        {
          underlying: ROW_TOKEN,
          portal: OTHER_PORTAL,
          tuple: { chainId: tuple.chainId, portal: OTHER_PORTAL, token: ROW_TOKEN },
        },
      ],
    },
  }),
}))

const load = () => import("../../../../src/features/deposit/capacityStore")
const key = (portal: string, chainId = CHAIN) => ({ chainId, portal, token: TOKEN } as never)

// The first load compiles the SDK bundle, which can take longer than one test's timeout.
beforeAll(() => load(), 60_000)

beforeEach(() => {
  vi.resetModules()
  reads.length = 0
  client.blockAgeSeconds = 0n
  nodes.preBoot = makeNode()
  config.network = "testnet"
  tuple.fail = false
  tuple.chainId = String(CHAIN)
  tuple.underlying = undefined
})

describe("capacityStore", () => {
  it("gives every consumer the same store for a bucket, whatever the address casing", async () => {
    const { depositCapacityStore } = await load()
    const store = depositCapacityStore(key(PORTAL))
    expect(depositCapacityStore(key(PORTAL.toLowerCase()))).toBe(store)
    expect(depositCapacityStore(key(OTHER_PORTAL))).not.toBe(store)
    expect(store.key).toEqual({ chainId: CHAIN, portal: PORTAL.toLowerCase(), token: TOKEN })
  })

  it("reads an explicit original portal through the configured client", async () => {
    const { depositCapacityStore } = await load()
    const state = await depositCapacityStore(key(OTHER_PORTAL)).refresh()
    expect(state.status).toBe("fresh")
    expect(state.status === "fresh" && state.snapshot.availableAtomic).toBe(40n)
    expect(new Set(reads.map((r) => r.address.toLowerCase()))).toEqual(
      new Set([OTHER_PORTAL, TOKEN]),
    )
  })

  it("fails closed for a key on another chain, before any contract read", async () => {
    const { PortalCapacityReferenceError } = await import("@obsidion/front-core")
    const { depositCapacityStore } = await load()
    // The node reference follows another L1 chain than the key, so the read never starts.
    const state = await depositCapacityStore(key(PORTAL, 1)).refresh()
    expect(state.status).toBe("unavailable")
    expect(state.status === "unavailable" && state.error).toBeInstanceOf(
      PortalCapacityReferenceError,
    )
    expect((state as { error: { reason: string } }).error.reason).toBe("chain-mismatch")
    expect(reads).toEqual([])

    // Without a reference (sandbox), the reader itself refuses the other chain.
    vi.resetModules()
    config.network = "sandbox"
    const sandbox = await (await load()).depositCapacityStore(key(PORTAL, 1)).refresh()
    expect(sandbox).toMatchObject({ status: "unsupported", reason: "chain-mismatch" })
    expect(reads).toEqual([])
  })

  it("keys new funding by the active deployment's portal and token", async () => {
    const { activeCapacityKey } = await load()
    await expect(activeCapacityKey()).resolves.toEqual({
      chainId: CHAIN,
      portal: PORTAL.toLowerCase(),
      token: TOKEN,
    })
  })

  it("keys the pinned bridge by its row token where the user's token differs", async () => {
    const { activeCapacityKey } = await load()
    tuple.underlying = ROW_TOKEN
    await expect(activeCapacityKey()).resolves.toMatchObject({ token: ROW_TOKEN })
  })

  it("keys new funding of a row by that row's portal and token", async () => {
    const { activeCapacityKey } = await load()
    await expect(activeCapacityKey(ROW_TOKEN)).resolves.toEqual({
      chainId: CHAIN,
      portal: OTHER_PORTAL.toLowerCase(),
      token: ROW_TOKEN,
    })
    await expect(activeCapacityKey(`0x${"44".repeat(20)}`)).rejects.toThrow(/no bridge/)
  })

  it("rejects the active key when the manifest cannot be loaded or has no chain, and recovers on the next call", async () => {
    const { activeCapacityKey } = await load()
    tuple.fail = true
    await expect(activeCapacityKey()).rejects.toThrow("manifest fetch failed")
    tuple.fail = false
    tuple.chainId = undefined
    await expect(activeCapacityKey()).rejects.toThrow(/invalid chainId/)
    tuple.chainId = String(CHAIN)
    await expect(activeCapacityKey()).resolves.toMatchObject({ chainId: CHAIN })
  })

  it("turns the head-age checks off only on the sandbox", async () => {
    const live = (await load()).depositCapacityStore(key(PORTAL))
    expect(live.policy.maxHeadAgeMs).toBe(60_000)
    vi.resetModules()
    config.network = "sandbox"
    const sandbox = (await load()).depositCapacityStore(key(PORTAL))
    expect(sandbox.policy.maxHeadAgeMs).toBe(Infinity)
  })

  it("bounds reads with the pre-boot node, then with the node the wallet booted", async () => {
    const { setActiveGenerationNode } = await import("@obsidion/front-core")
    const { createNode } = await import("@obsidion/sdk")
    setActiveGenerationNode(undefined)
    const { depositCapacityStore } = await load()
    const store = depositCapacityStore(key(PORTAL))
    expect((await store.retry()).status).toBe("fresh")
    expect(createNode).toHaveBeenCalledWith(config.nodeUrl, config.nodeApiKey)
    const preBoot = nodes.preBoot as ReturnType<typeof makeNode>
    expect(preBoot.getSyncedL1Timestamp).toHaveBeenCalled()

    const booted = makeNode()
    setActiveGenerationNode(booted as never)
    expect((await store.retry()).status).toBe("fresh")
    expect(booted.getSyncedL1Timestamp).toHaveBeenCalled()
    setActiveGenerationNode(undefined)
  })
})

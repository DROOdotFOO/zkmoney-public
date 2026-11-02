/**
 * The pre-boot node reference through the real SDK node client and JSON-RPC transport (only `fetch` is replaced): it
 * sends the configured API key, and a node read that never answers does not hold later reads, so Retry recovers.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { PortalCapacityState } from "@obsidion/front-core"

const config = vi.hoisted(() => ({
  network: "testnet",
  nodeUrl: "http://node.invalid",
  nodeApiKey: "node-key",
}))
const portal = vi.hoisted(() => ({
  chainId: 11155111,
  portal: "0xabcdef0123456789abcdef0123456789abcdef01",
  token: "0x2222222222222222222222222222222222222222",
}))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => config }))
vi.mock("../../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({
    getChainId: async () => portal.chainId,
    getBlock: async () => ({ number: 10n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    readContract: async ({ functionName }: { functionName: string }) =>
      ({
        UNDERLYING: portal.token,
        RATE: 1n,
        GLOBAL_LIMIT: 100n,
        getCurrentAvailable: 40n,
        decimals: 18,
      }[functionName]),
  }),
  getOxideTuple: async () => ({ ...portal, chainId: String(portal.chainId) }),
}))

/** The node behind `config.nodeUrl`: answers JSON-RPC batches, or, while `silent`, never answers. */
const node = {
  silent: false,
  requests: [] as { url: string; methods: string[]; apiKey: string | null }[],
}
const answers: Record<string, () => unknown> = {
  aztec_getChainId: () => portal.chainId,
  aztec_getSyncedL1Timestamp: () => String(Math.floor(Date.now() / 1000)),
}
const nodeFetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
  const calls = JSON.parse(init.body) as { id: number; method: string }[]
  const methods = calls.map((call) => call.method)
  node.requests.push({ url, methods, apiKey: new Headers(init.headers).get("x-api-key") })
  if (node.silent) return new Promise(() => {})
  const body = calls.map((call) => ({
    jsonrpc: "2.0",
    id: call.id,
    result: answers[call.method]!(),
  }))
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  }
}

const load = () => import("../../../../src/features/deposit/capacityStore")

// The first load compiles the SDK bundle, which can take longer than one test's timeout.
beforeAll(() => load(), 60_000)

beforeEach(async () => {
  vi.resetModules()
  node.silent = false
  node.requests.length = 0
  vi.stubGlobal("fetch", vi.fn(nodeFetch))
  ;(await import("@obsidion/front-core")).setActiveGenerationNode(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("capacityStore before boot", () => {
  it("reads the node with the configured API key", async () => {
    const { depositCapacityStore } = await load()
    expect((await depositCapacityStore(portal as never).retry()).status).toBe("fresh")
    expect(node.requests.flatMap((request) => request.methods)).toEqual(
      expect.arrayContaining(["aztec_getChainId", "aztec_getSyncedL1Timestamp"]),
    )
    for (const request of node.requests) {
      expect(request).toMatchObject({ url: config.nodeUrl, apiKey: config.nodeApiKey })
    }
  })

  it("recovers on Retry after a node read that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const store = (await load()).depositCapacityStore(portal as never)
    node.silent = true
    const stalled = store.retry()
    await vi.advanceTimersByTimeAsync(store.policy.readTimeoutMs)
    expect((await stalled).status).toBe("unavailable")

    node.silent = false
    let retried: PortalCapacityState | undefined
    void store.retry().then((state) => (retried = state))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retried?.status).toBe("fresh")
    expect(
      node.requests.filter((request) => request.methods.includes("aztec_getChainId")),
    ).toHaveLength(2)
  })
})

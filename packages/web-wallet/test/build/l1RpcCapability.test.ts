// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { assertBakedL1RpcSimulates } from "../../l1RpcCapability"

const RPC = "https://rpc.example/v3/secret-key"
const MAINNET = { VITE_NETWORK: "mainnet", VITE_L1_RPC_URL: RPC }

const answer = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch

describe("assertBakedL1RpcSimulates", () => {
  it("passes a mainnet build whose RPC answers eth_simulateV1", async () => {
    const fetchImpl = answer({ jsonrpc: "2.0", id: 1, result: [{ calls: [] }] })
    await assertBakedL1RpcSimulates(MAINNET, fetchImpl)
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(RPC)
  })

  it("fails a mainnet build whose RPC lacks eth_simulateV1", async () => {
    const fetchImpl = answer({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } })
    await expect(assertBakedL1RpcSimulates(MAINNET, fetchImpl)).rejects.toThrow(
      /rpc\.example does not serve eth_simulateV1/,
    )
  })

  it.each([
    ["testnet", { VITE_NETWORK: "testnet", VITE_L1_RPC_URL: RPC }],
    ["sandbox", { VITE_NETWORK: "sandbox", VITE_L1_RPC_URL: RPC }],
    ["mainnet with no baked RPC", { VITE_NETWORK: "mainnet" }],
  ])("does not probe on %s", async (_name, env) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await assertBakedL1RpcSimulates(env, fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

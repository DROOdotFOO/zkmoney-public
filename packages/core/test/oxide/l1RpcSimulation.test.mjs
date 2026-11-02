import assert from "node:assert/strict"
import { test } from "node:test"
import { L1RpcSimulationUnsupportedError, assertL1RpcSimulates } from "../../dist/oxide/index.js"

const RPC = "https://rpc.example/v3/secret-key"

function answering(body, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, calls }
}

test("passes an RPC that simulates under a state override", async () => {
  const { fetchImpl, calls } = answering({ jsonrpc: "2.0", id: 1, result: [{ calls: [] }] })
  await assertL1RpcSimulates(RPC, fetchImpl)
  assert.equal(calls[0].url, RPC)
  assert.equal(calls[0].body.method, "eth_simulateV1")
  assert.ok(calls[0].body.params[0].blockStateCalls[0].stateOverrides)
})

test("refuses an RPC without eth_simulateV1, naming its host but not its key", async () => {
  const { fetchImpl } = answering({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "The method eth_simulateV1 does not exist/is not available" },
  })
  await assert.rejects(assertL1RpcSimulates(RPC, fetchImpl), (e) => {
    assert.ok(e instanceof L1RpcSimulationUnsupportedError)
    assert.equal(e.host, "rpc.example")
    assert.match(e.message, /rpc\.example does not serve eth_simulateV1 \(The method/)
    assert.doesNotMatch(e.message, /secret-key/)
    return true
  })
})

test("a throttled or failing server is a failed probe, not a missing method", async () => {
  for (const status of [429, 503]) {
    const { fetchImpl } = answering(
      { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "busy" } },
      status,
    )
    await assert.rejects(assertL1RpcSimulates(RPC, fetchImpl), (e) => {
      assert.ok(!(e instanceof L1RpcSimulationUnsupportedError))
      assert.match(
        e.message,
        new RegExp(`rpc\\.example: eth_simulateV1 probe failed: HTTP ${status}`),
      )
      return true
    })
  }
})

test("a JSON-RPC error other than method-not-found is a failed probe, not a missing method", async () => {
  const answers = [
    [200, { code: -32005, message: "rate limited" }],
    [
      200,
      { code: -32000, message: "Unauthorized: You must authenticate your request with an API key" },
    ],
    [403, { code: -32002, message: "rejected due to project ID settings" }],
  ]
  for (const [status, error] of answers) {
    const { fetchImpl } = answering({ jsonrpc: "2.0", id: 1, error }, status)
    await assert.rejects(assertL1RpcSimulates(RPC, fetchImpl), (e) => {
      assert.ok(!(e instanceof L1RpcSimulationUnsupportedError))
      assert.ok(e.message.includes(`rpc.example: eth_simulateV1 probe failed: ${error.message}`))
      return true
    })
  }
})

test("method-not-found refuses the RPC whatever the HTTP status", async () => {
  const { fetchImpl } = answering(
    { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "rpc method is not whitelisted" } },
    403,
  )
  await assert.rejects(assertL1RpcSimulates(RPC, fetchImpl), L1RpcSimulationUnsupportedError)
})

test("an unreachable RPC is a failed probe", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED")
  }
  await assert.rejects(assertL1RpcSimulates(RPC, fetchImpl), (e) => {
    assert.ok(!(e instanceof L1RpcSimulationUnsupportedError))
    assert.match(e.message, /rpc\.example: eth_simulateV1 probe failed: ECONNREFUSED/)
    return true
  })
})

// Oxide's relayer prices an L1 operation from an `eth_simulateV1` run with a state override, and the
// wallet prices a swap-on-withdraw tip the same way, so every L1 RPC the wallet runs on must serve both.

import type { FetchFunction } from "../types/index.js"

/** The RPC answered that it does not serve `eth_simulateV1`. */
export class L1RpcSimulationUnsupportedError extends Error {
  constructor(readonly host: string, readonly detail: string) {
    super(
      `L1 RPC ${host} does not serve eth_simulateV1 (${detail}); swap withdrawals cannot be priced without it`,
    )
    this.name = "L1RpcSimulationUnsupportedError"
  }
}

const PROBE_TIMEOUT_MS = 15_000
const JSON_RPC_METHOD_NOT_FOUND = -32601

/**
 * Resolves when `url` simulates a block under a state override. Throws `L1RpcSimulationUnsupportedError`
 * when it answers that it lacks the method, and a plain error when it cannot be asked or answers with any
 * other error. Errors name only the host: a keyed provider carries its key in the path.
 */
export async function assertL1RpcSimulates(
  url: string,
  fetchImpl: FetchFunction = fetch,
): Promise<void> {
  const host = new URL(url).host
  let body: { result?: unknown; error?: { code?: number; message?: string } }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_simulateV1",
        params: [
          {
            blockStateCalls: [
              {
                stateOverrides: {
                  "0x0000000000000000000000000000000000000001": { balance: "0x1" },
                },
                calls: [],
              },
            ],
          },
          "latest",
        ],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // A throttled or failing server says nothing about the method.
    if (response.status === 429 || response.status >= 500)
      throw new Error(`HTTP ${response.status}`)
    body = (await response.json()) as typeof body
  } catch (e) {
    throw new Error(`L1 RPC ${host}: eth_simulateV1 probe failed: ${(e as Error).message}`)
  }
  if (Array.isArray(body.result)) return
  const detail = body.error?.message ?? "no result"
  if (body.error?.code === JSON_RPC_METHOD_NOT_FOUND) {
    throw new L1RpcSimulationUnsupportedError(host, detail)
  }
  // Only method-not-found says the RPC lacks it; throttling, auth and node errors do not.
  throw new Error(`L1 RPC ${host}: eth_simulateV1 probe failed: ${detail}`)
}

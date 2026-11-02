import * as actual from "@obsidion/front-core"
import { DEMO_L2_ADDRESS } from "../../../src/dev/demoFixtures"
import { fixtureState } from "./control"
import { TOKEN_INFO, ROLLUP } from "./data"
export * from "@obsidion/front-core"

const unavailable = () => {
  throw new actual.WalletError("invariant", "Unmocked contract operation in a UI capture")
}
const opaque = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : unavailable) })
// The chain clock probes the tip before it reads a header, so both reads are stubbed.
const node = {
  getBlockNumber: async () => 1,
  getBlockData: async () => ({
    header: { globalVariables: { blockNumber: 1, timestamp: Math.floor(Date.now() / 1000) } },
  }),
}
const wallet = new Proxy(
  { node, networkId: ROLLUP },
  {
    get: (target, key) =>
      key === "node" || key === "networkId"
        ? target[key]
        : key === "then"
        ? undefined
        : unavailable,
  },
)
const address = { toString: () => DEMO_L2_ADDRESS }
const account = { address, getAddress: () => address }
const tokenService = {
  fetchTokenInformation: async () => TOKEN_INFO,
  metadata: TOKEN_INFO,
}
const ready: Record<string, unknown> = { wallet, account, token: tokenService, teeSigner: opaque }
// Only explicitly listed UI consumers receive these readiness values. WalletGate, provider setup,
// sync loops, and transaction implementations continue to read the real session resources.
export const useResource: typeof actual.useResource = (resource) => {
  const value = actual.useResource(resource)
  return fixtureState() && resource && resource.name in ready
    ? (ready[resource.name] as typeof value)
    : value
}
export function useContractServiceContext() {
  const context = actual.useContractServiceContext()
  return fixtureState()
    ? ({ ...context, contractService: opaque } as unknown as typeof context)
    : context
}

// @vitest-environment node
/**
 * The deposit picker and the accepted-token list come from the pinned table's rows: a manifest with another bridge,
 * and a table that lists it, add a token with no wallet change. The manifest and the L1 behind these tests are
 * fixtures served over fetch, read through the real manifest parser, table reader and route rule.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from "viem"
import { foundry } from "viem/chains"
import { Network } from "@obsidion/core/constants"
import type { WebWalletConfig } from "../../../src/config/env"

const config = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => config.current,
}))

const { loadDepositDisplayFacts, loadDepositTokens, recoveryProbeTokens, sipaFundingTokens } =
  await import("../../../src/features/deposit/loadDepositFacts")

const RPC_URL = "http://l1.test/"
const TABLE = `0x${"fb".repeat(20)}` as Address
const TEST = `0x${"7e".repeat(20)}` as Address
const USD2 = `0x${"5d".repeat(20)}` as Address
const TEST_PORTAL = `0x${"a1".repeat(20)}` as Address
const USD2_PORTAL = `0x${"b2".repeat(20)}` as Address
const ERC20: Record<string, { symbol: string; decimals: number }> = {
  [TEST]: { symbol: "TEST", decimals: 18 },
  [USD2]: { symbol: "USD2", decimals: 6 },
}
const ROWS: Record<string, { portal: Address; sweepTip: bigint }> = {
  [TEST]: { portal: TEST_PORTAL, sweepTip: 3n },
  [USD2]: { portal: USD2_PORTAL, sweepTip: 7n },
}

const L1 = parseAbi([
  "function rowFor(address token, uint8 intent) view returns (address, address, uint128, uint128)",
  "function TX_AMOUNT_CAP() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
])

const bridge = (key: string, token: Address, portal: Address, byte: string) => ({
  key,
  bridgeId: `brg-${key}`,
  token,
  underlying: token,
  portal,
  l2Token: `0x${byte.repeat(32)}`,
})

const manifest = (bridges: ReturnType<typeof bridge>[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: "5",
  deployments: [
    {
      label: "sandbox",
      deployedAt: "2026-10-13T20:24:20.754Z",
      updatedAt: "2026-10-14T20:24:20.754Z",
      chainId: "31337",
      rollupVersion: "1",
      enclaveUrl: "https://enclave.example/rpc",
      forwardingTable: TABLE,
      feeToken: TEST,
      ...extra,
      bridges,
    },
  ],
})

function answer(call: { to: Address; data: Hex }): Hex {
  const { functionName, args } = decodeFunctionData({ abi: L1, data: call.data })
  const to = call.to.toLowerCase()
  if (functionName === "rowFor") {
    const row = ROWS[(args[0] as string).toLowerCase()]
    if (!row || to !== TABLE) throw new Error(`no row for ${String(args[0])}`)
    return encodeFunctionResult({
      abi: L1,
      functionName,
      result: [row.portal, `0x${"be".repeat(20)}`, 0n, row.sweepTip],
    })
  }
  if (functionName === "TX_AMOUNT_CAP") {
    return encodeFunctionResult({ abi: L1, functionName, result: to === TEST_PORTAL ? 100n : 200n })
  }
  const token = ERC20[to]
  if (!token) throw new Error(`no token at ${to}`)
  return functionName === "symbol"
    ? encodeFunctionResult({ abi: L1, functionName, result: token.symbol })
    : encodeFunctionResult({ abi: L1, functionName, result: token.decimals })
}

let served = 0
const originalFetch = globalThis.fetch

/** A profile pinned to `TEST_PORTAL` in a manifest of its own, served with the fixture L1. */
function serve(
  document: ReturnType<typeof manifest>,
  assets: { symbol: string; portal: string }[] = [],
): WebWalletConfig {
  const manifestUrl = `https://oxide.test/${++served}.json`
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url === manifestUrl) return Response.json(document)
    if (url !== RPC_URL) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body))
    const one = (request: { id: number; params: [{ to: Address; data: Hex }] }) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: answer(request.params[0]),
    })
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  }) as typeof fetch
  const next = {
    oxideProfile: { manifestUrl, portal: TEST_PORTAL },
    network: Network.SANDBOX,
    l1ChainId: 31337,
    l1Chain: foundry,
    l1RpcUrl: RPC_URL,
    assets,
  } as unknown as WebWalletConfig
  config.current = next
  return next
}

const symbols = (tokens: { options: { symbol: string }[] }) => tokens.options.map((t) => t.symbol)

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("loadDepositTokens", () => {
  it("lists the one row of a one-bridge table", async () => {
    const tokens = await loadDepositTokens(
      serve(manifest([bridge("test", TEST, TEST_PORTAL, "a1")])),
    )

    expect(symbols(tokens)).toEqual(["TEST"])
    expect(tokens.settlement.address).toBe(TEST)
  })

  it("lists a second row with no wallet change, in the picker and the accepted tokens", async () => {
    const two = serve(
      manifest([bridge("test", TEST, TEST_PORTAL, "a1"), bridge("usd2", USD2, USD2_PORTAL, "b2")]),
    )
    const tokens = await loadDepositTokens(two)

    expect(tokens.options.map((t) => [t.symbol, t.decimals, t.settlesIn, t.swapped])).toEqual([
      ["TEST", 18, TEST, false],
      ["USD2", 6, USD2, false],
    ])
    expect(tokens.offered).toEqual(tokens.options)
    expect((await sipaFundingTokens(two, TEST)).map((t) => t.address)).toEqual([TEST, USD2])
    // A registration settles on the fee token's row only.
    expect(symbols(await loadDepositTokens(two, "registration"))).toEqual(["TEST"])
  })

  it("offers a feature's product row on no deposit surface, but sweeps and recovers it", async () => {
    const sky = serve(
      manifest([bridge("usd2", USD2, USD2_PORTAL, "b2"), bridge("test", TEST, TEST_PORTAL, "a1")], {
        features: {
          "fea-sky": {
            project: "sky",
            bridges: { sUsds: "brg-usd2", dai: "brg-test" },
            contracts: {},
          },
        },
      }),
    )
    const tokens = await loadDepositTokens(sky)

    expect(symbols(tokens)).toEqual(["USD2", "TEST"])
    expect(tokens.offered.map((t) => t.symbol)).toEqual(["TEST"])
    expect(tokens.settlement.symbol).toBe("TEST")
    expect((await sipaFundingTokens(sky, TEST)).map((t) => t.address)).toEqual([TEST, USD2])
    expect((await recoveryProbeTokens(sky, TEST)).map((t) => t.address)).toEqual([TEST, USD2])
  })

  it("probes the named token alone when the table cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const document = manifest([bridge("usd2", USD2, USD2_PORTAL, "b2")])
    delete (document.deployments[0] as { forwardingTable?: string }).forwardingTable

    const probed = await recoveryProbeTokens(serve(document), USD2)
    expect(probed).toEqual([{ address: USD2, symbol: "", decimals: 6 }])
  })

  it("quotes each picked token on its own row", async () => {
    serve(
      manifest([bridge("test", TEST, TEST_PORTAL, "a1"), bridge("usd2", USD2, USD2_PORTAL, "b2")]),
    )

    await expect(loadDepositDisplayFacts({ settlesIn: USD2 })).resolves.toEqual({
      fee: "0.000007",
      token: USD2,
      sweepFeeAtomic: 7n,
      txAmountCap: 200n,
    })
    await expect(loadDepositDisplayFacts()).resolves.toMatchObject({
      token: TEST,
      txAmountCap: 100n,
    })
  })

  it("takes only names and order from the profile's assets: they add and remove no token", async () => {
    const tokens = await loadDepositTokens(
      serve(
        manifest([
          bridge("test", TEST, TEST_PORTAL, "a1"),
          bridge("usd2", USD2, USD2_PORTAL, "b2"),
        ]),
        [
          { symbol: "Dollar Two", portal: USD2_PORTAL },
          { symbol: "GHOST", portal: `0x${"99".repeat(20)}` },
        ],
      ),
    )

    expect(symbols(tokens)).toEqual(["Dollar Two", "TEST"])
    expect(tokens.settlement.symbol).toBe("TEST")
  })
})

/**
 * A registration settles on the fee token's row, so its broadcast sweeps every token that row accepts and no other
 * row's. Relayers never rewrite an operation: a token the broadcast leaves out is never swept.
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from "@oxide/l1-contracts"
import { Network } from "@obsidion/core/constants"
import { deploymentOfTuples, type OxideDeploymentTable } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"

const MANIFEST_TOKEN = `0x${"d4".repeat(20)}` as Address
const FORWARDING_TABLE = `0x${"fb".repeat(20)}`

const TUPLE = {
  ensDomain: "zk.money",
  l2Broadcaster: `0x${"0b".repeat(32)}`,
  l2Token: `0x${"0c".repeat(32)}`,
  portal: `0x${"a0".repeat(20)}`,
  sipaFactory: `0x${"f0".repeat(20)}`,
  operationExecutor: `0x${"e0".repeat(20)}`,
  depositSubsidy: `0x${"5b".repeat(20)}`,
  token: MANIFEST_TOKEN,
  underlying: MANIFEST_TOKEN,
}

const rowTuple = (token: string, byte: string, feeToken: string): OxideEnvTuple => ({
  version: "v6",
  gitSha: "",
  timestamp: "2026-10-14T00:00:00.000Z",
  deployedAt: "2026-10-14T00:00:00.000Z",
  portal: `0x${byte.repeat(20)}`,
  token,
  underlying: token,
  l2Token: `0x${byte.repeat(32)}`,
  enclaveUrl: "https://enclave.example/rpc",
  pcr0: "",
  rollupVersion: "1",
  forwardingTable: FORWARDING_TABLE,
  feeToken,
  depositSubsidy: `0x${byte.replace(/^./, "5").repeat(20)}`,
})

/** A fee-token row that prices registrations, and a second row that takes deposits alone. */
function twoRows(feeToken: string): OxideDeploymentTable {
  const deployment = deploymentOfTuples([
    rowTuple(feeToken, "a0", feeToken),
    rowTuple(`0x${"e2".repeat(20)}`, "a2", feeToken),
  ])
  const terms = { sweepTip: 1n, beneficiaryFee: 0n }
  return {
    deployment,
    rows: [
      {
        bridge: deployment.bridges[0]!,
        intents: { deposit: terms, registration: terms },
        txAmountCap: 1n,
      },
      { bridge: deployment.bridges[1]!, intents: { deposit: terms }, txAmountCap: 1n },
    ],
  }
}

const {
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  sendTx,
  readSipaDeployed,
  getWebBroadcasterArtifact,
  getSipaDeploymentTable,
} = vi.hoisted(() => ({
  assertSubsidySweepsSipa: vi.fn(),
  buildSipaSweepBroadcasts: vi.fn(),
  sendTx: vi.fn(),
  readSipaDeployed: vi.fn(),
  getWebBroadcasterArtifact: vi.fn(async (..._args: unknown[]) => ({})),
  getSipaDeploymentTable: vi.fn(),
}))

vi.mock("../../../src/features/deposit/sipaSweep", () => ({ readSipaDeployed }))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  buildClaimSponsorPayload: async () => ({}),
  claimFpcSponsoredFee: () => ({}),
  encodeRegistrationProofs: () => "0x",
  BroadcasterContract: { at: () => ({}) },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  composeWireNameHash: () => `0x${"aa".repeat(32)}`,
  NameClaimStore: { get: () => ({ put: async () => {} }) },
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => TUPLE,
  getFeeTokenBridgeTuple: async () => TUPLE,
  getSipaDeploymentTable,
  l1PublicClient: () => ({}),
}))
vi.mock("../../../src/config/classArtifacts", () => ({
  getWebBroadcasterArtifact,
  getWebOxideToken: async (_wallet: unknown, _contracts: unknown, l2Token: string) => ({ l2Token }),
}))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({
    fpcAddress: AztecAddress.ZERO,
    fpcArtifact: {},
    railId: 0,
    policy: {},
    subscribe: undefined,
  }),
}))

import { OxideSipaIntent } from "@obsidion/sdk"
import { createWebRegistrationBroadcaster } from "../../../src/features/onboarding/webRegistrationBroadcast"

const PAYLOAD = {
  sipaAddress: `0x${"9f".repeat(20)}`,
  recipient: `0x${"01".repeat(32)}`,
  sharedSecretSalt: "0x02",
  sipaArgs: {
    resweepable: false,
    intentHash: `0x${"33".repeat(32)}`,
    forwardingTable: FORWARDING_TABLE,
  },
  registrationData: "0x",
  consentSig: "0x",
  bootstrap: `0x${"44".repeat(20)}`,
  domainAuth: { nonce: 1n, deadline: 2n, signature: "0x" },
  signedTerms: { fee: 0n, minDeposit: 0n, nonce: 0n, deadline: 0n, signature: "0x" },
  r1Install: {},
}

async function broadcastCall(network: Network) {
  const broadcast = createWebRegistrationBroadcaster({
    wallet: {
      pxe: { registerContractClass: async () => {}, registerContract: async () => {} },
      node: { getContract: async () => ({}) },
      sendTx,
    } as never,
    account: { getAddress: () => AztecAddress.fromStringUnsafe(`0x${"07".repeat(32)}`) } as never,
    contractService: {} as never,
    config: { network, l1ChainId: network === Network.MAINNET ? 1 : 31337 } as never,
    handle: "alice",
  })
  await broadcast(PAYLOAD as never)
  expect(buildSipaSweepBroadcasts).toHaveBeenCalledTimes(1)
  const [notifier, , params] = buildSipaSweepBroadcasts.mock.calls[0]
  return { notifier, params }
}

async function broadcastTokens(network: Network): Promise<string[]> {
  const { params } = await broadcastCall(network)
  return (params.routes as { token: string }[]).map(({ token }) => token.toLowerCase())
}

describe("createWebRegistrationBroadcaster funding tokens", () => {
  beforeEach(() => {
    assertSubsidySweepsSipa.mockReset().mockResolvedValue(undefined)
    buildSipaSweepBroadcasts.mockReset().mockReturnValue([])
    sendTx.mockReset().mockResolvedValue({ receipt: { txHash: { toString: () => "0x01" } } })
    readSipaDeployed.mockReset().mockResolvedValue(false)
    getSipaDeploymentTable.mockReset().mockResolvedValue(twoRows(MANIFEST_TOKEN))
  })

  it("omits the deploy call for a SIPA that already has code", async () => {
    readSipaDeployed.mockResolvedValue(true)
    await broadcastTokens(Network.SANDBOX)
    expect(readSipaDeployed).toHaveBeenCalledWith(expect.anything(), PAYLOAD.sipaAddress)
    expect(buildSipaSweepBroadcasts.mock.calls[0][2].deployed).toBe(true)
    expect(assertSubsidySweepsSipa).not.toHaveBeenCalled()
  })

  it("publishes the registration intent once the subsidy is known to deploy the payload's SIPA", async () => {
    await broadcastTokens(Network.SANDBOX)
    const fee = twoRows(MANIFEST_TOKEN).rows[0]!.bridge
    expect(assertSubsidySweepsSipa).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        routes: [
          { token: fee.underlying, portal: fee.portal, depositSubsidy: fee.tuple.depositSubsidy },
        ],
        sipaFactory: TUPLE.sipaFactory,
        intent: OxideSipaIntent.Registration,
        deployArgs: PAYLOAD.sipaArgs,
        intentData: PAYLOAD.registrationData,
        sipa: PAYLOAD.sipaAddress,
      }),
    )
    const [, , params] = buildSipaSweepBroadcasts.mock.calls[0]
    expect(params.intent).toBe(OxideSipaIntent.Registration)
  })

  it("does not publish when the subsidy would deploy another SIPA", async () => {
    assertSubsidySweepsSipa.mockRejectedValue(new Error("would deploy"))
    // The PXE is readied beside the L1 checks, so the wallet answers that half.
    const broadcast = createWebRegistrationBroadcaster({
      wallet: {
        pxe: { registerContractClass: async () => {}, registerContract: async () => {} },
        node: { getContract: async () => ({}) },
        sendTx,
      } as never,
      account: { getAddress: () => AztecAddress.fromStringUnsafe(`0x${"07".repeat(32)}`) } as never,
      contractService: {} as never,
      config: { network: Network.SANDBOX, l1ChainId: 31337 } as never,
      handle: "alice",
    })
    await expect(broadcast(PAYLOAD as never)).rejects.toThrow("would deploy")
    expect(buildSipaSweepBroadcasts).not.toHaveBeenCalled()
    expect(sendTx).not.toHaveBeenCalled()
  })

  it.each([Network.SANDBOX])(
    "broadcasts the fee token's row alone on %s, notified on its bridge's L2 token",
    async (network) => {
      const { notifier, params } = await broadcastCall(network)
      expect(params.routes.map(({ token }: { token: string }) => token.toLowerCase())).toEqual([
        MANIFEST_TOKEN.toLowerCase(),
      ])
      expect(notifier).toEqual({ l2Token: TUPLE.l2Token })
      expect(getSipaDeploymentTable).toHaveBeenCalledWith(expect.anything(), FORWARDING_TABLE)
      expect(sendTx).toHaveBeenCalledTimes(1)
    },
  )

  it("sweeps the mainnet swap inputs through the DAI fee row's subsidy", async () => {
    const table = twoRows(MAINNET_DAI.toString())
    getSipaDeploymentTable.mockResolvedValue(table)
    const { params } = await broadcastCall(Network.MAINNET)
    const subsidy = table.rows[0]!.bridge.tuple.depositSubsidy
    expect(
      params.routes.map(({ token, depositSubsidy }: { token: string; depositSubsidy: string }) => [
        token.toLowerCase(),
        depositSubsidy,
      ]),
    ).toEqual(
      [MAINNET_DAI, MAINNET_USDC, MAINNET_USDT].map((token) => [
        token.toString().toLowerCase(),
        subsidy,
      ]),
    )
  })
})

import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import {
  SkyEscrowFactoryAbi,
  SkyRoute,
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
} from "@oxide/experiments/sky/sky_savings.js"
import { PlainWithdrawalSubsidyAbi, encodeEscrowRecoverERC20 } from "@oxide/l1-contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { multicall3Abi } from "viem"
import { L1_OPERATION_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import { MULTICALL3_ADDRESS } from "../../../src/services/sipa/sipaClaim.js"
import {
  ETH_USD_FEED_DECIMALS,
  ETH_USD_MAX_PRICE_AGE_SECONDS,
  weiToUSD,
} from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  gasCostAtQuotePrice,
} from "@oxide/oxide-client/l1_operation_quote.js"
import {
  SKY_RELEASE_GAS,
  SkyTipExceedsFundingError,
  buildSkyEscrowRecoverCall,
  buildSkyEscrowRunCall,
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
} from "../../../src/oxide/escrow/skySavings.js"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"

const FACTORY = "0x00000000000000000000000000000000000fac70" as Address
const EXECUTOR = "0x0000000000000000000000000000000000e0e0e0" as Address
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const SUBSIDY = "0x0000000000000000000000000000000000005b51" as Address
const FEED = "0x000000000000000000000000000000000000feed" as Address
const SENDER = "0x0000000000000000000000000000000000000b0b" as Address
const DAI_BALANCE_SLOT = 2n
const NOW = 1_800_000_000n
const BASE_FEE = parseGwei("10")
const PRIORITY_FEE = parseGwei("1")
const FEES = await estimateL1OperationFeeValues({
  getBlock: async () => ({ baseFeePerGas: BASE_FEE }),
  estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
} as unknown as PublicClient)
const GAS_USED = 300_000n
const ETH_USD = 3000n * 10n ** ETH_USD_FEED_DECIMALS
const deployment = {
  skyEscrowFactory: FACTORY,
  operationExecutor: EXECUTOR,
  dai: DAI,
  withdrawalSubsidy: SUBSIDY,
}

/** The relayer's floor for `gas` at the fakes' fees, with the wallet's margin. */
const floorFor = (gas: bigint) => {
  const minPayout = gasCostAtQuotePrice(
    gas + 2n * UINT256_EXTRA_CALLDATA_GAS,
    { number: 7n, baseFeePerGas: BASE_FEE },
    FEES,
    weiToUSD(WEI_PER_ETH, ETH_USD),
  )
  return { minPayout, tip: (minPayout * L1_OPERATION_TIP_MARGIN_BPS + 9_999n) / 10_000n }
}

function fakeClient({ feedUpdatedAt = NOW } = {}) {
  return {
    readContract: vi.fn(
      async ({
        functionName,
        args,
        stateOverride,
      }: {
        functionName: string
        args?: readonly unknown[]
        stateOverride?: StateOverride
      }) => {
        switch (functionName) {
          case "PRICE_FEED":
            return FEED
          case "latestRoundData":
            return [0n, ETH_USD, 0n, feedUpdatedAt, 0n]
          case "balanceOf": {
            const wanted = mappingSlot(args![0] as Address, DAI_BALANCE_SLOT)
            const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
            return hit ? BigInt(hit.value) : 0n
          }
          default:
            throw new Error(`unexpected read ${functionName}`)
        }
      },
    ),
    getBlock: vi.fn(async () => ({ number: 7n, baseFeePerGas: BASE_FEE, timestamp: NOW })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => PRIORITY_FEE),
    // The executor takes the six-argument `execute` only.
    simulateBlocks: vi.fn(async ({ blocks }: { blocks: { calls: { args: unknown[] }[] }[] }) => [
      {
        calls: [
          blocks[0]!.calls[0]!.args.length === 6
            ? { status: "success", result: 0n, gasUsed: GAS_USED, data: "0x", logs: [] }
            : { status: "failure", error: new Error("no data"), gasUsed: 0n },
        ],
      },
    ]),
  }
}

const quote = (client: ReturnType<typeof fakeClient>, escrowFunding: bigint) =>
  quoteSkyEscrowTip(client as unknown as PublicClient, deployment, {
    route: SkyRoute.Stake,
    escrowFunding,
    sender: SENDER,
  })

describe("quoteSkyEscrowTip", () => {
  it("prices the relayer's run of an escrow funded with what the release leaves it", async () => {
    const client = fakeClient()
    const funding = 50n * 10n ** 18n

    const tip = await quote(client, funding)

    const { minPayout, tip: relayerTip } = floorFor(GAS_USED)
    expect(tip).toEqual({
      relayerTip,
      minPayout,
      gasUsed: GAS_USED,
      maxFeePerGas: FEES.maxFeePerGas,
      usdPerEth: ETH_USD,
      baseFee: BASE_FEE,
      priorityFee: FEES.maxPriorityFeePerGas,
    })
    const { blocks } = client.simulateBlocks.mock.calls
      .map(([request]) => request)
      .find((request) => request.blocks[0]!.calls[0]!.args.length === 6) as unknown as {
      blocks: {
        stateOverrides: StateOverride
        calls: { to: Address; functionName: string; args: readonly unknown[] }[]
      }[]
    }
    const call = blocks[0]!.calls[0]!
    expect([call.to, call.functionName]).toEqual([EXECUTOR, "execute"])
    const [target, runCalldata, payoutToken, simulatedPayout] = call.args as [
      Address,
      Hex,
      Address,
      bigint,
    ]
    expect([target.toLowerCase(), payoutToken.toLowerCase()]).toEqual([FACTORY, DAI])
    const run = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: runCalldata })
    expect(run.functionName).toBe("deployAndExecute")
    const args = run.args[0] as Parameters<typeof predictSkyEscrowAddressLocally>[1]
    expect(args.route).toBe(SkyRoute.Stake)
    // Like the relayer's run, the simulation demands the committed tip as its payout.
    expect(simulatedPayout).toBe(args.relayerTip)
    const daiOverride = blocks[0]!.stateOverrides.find(
      (entry) => entry.address.toLowerCase() === DAI,
    )
    expect(daiOverride?.stateDiff).toEqual([
      {
        slot: mappingSlot(predictSkyEscrowAddressLocally(FACTORY, args), DAI_BALANCE_SLOT),
        value: `0x${funding.toString(16).padStart(64, "0")}`,
      },
    ])
  })

  it("refuses a move whose escrow could not pay the tip", async () => {
    await expect(quote(fakeClient(), 1n)).rejects.toBeInstanceOf(SkyTipExceedsFundingError)
  })

  it("refuses a stale ETH/USD answer", async () => {
    const client = fakeClient({ feedUpdatedAt: NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n })
    await expect(quote(client, 50n * 10n ** 18n)).rejects.toThrow(/stale/)
  })
})

describe("quoteSkyReleaseTip", () => {
  const subsidized = (subsidy: bigint, feedUpdatedAt = NOW) => ({
    ...fakeClient({ feedUpdatedAt }),
    call: vi.fn<(request: unknown) => Promise<{ data: Hex }>>(async () => ({
      data: encodeFunctionResult({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        result: subsidy,
      }),
    })),
  })
  const floor = (route: SkyRoute) => floorFor(SKY_RELEASE_GAS[route]).tip
  const releaseTip = (client: ReturnType<typeof subsidized>, route: SkyRoute) =>
    quoteSkyReleaseTip(client as unknown as PublicClient, SUBSIDY, route)

  it("offers what the relayer's floor asks beyond the subsidy, priced at the release's gas price", async () => {
    const client = subsidized(10n ** 15n)

    const tip = await releaseTip(client, SkyRoute.Unstake)

    expect(tip.relayerTip).toBe(floor(SkyRoute.Unstake) - 10n ** 15n)
    expect(tip.gasUsed).toBe(SKY_RELEASE_GAS[SkyRoute.Unstake])
    expect(client.call).toHaveBeenCalledWith({
      to: SUBSIDY,
      data: encodeFunctionData({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        args: [0],
      }),
      gasPrice: BASE_FEE + FEES.maxPriorityFeePerGas,
    })
  })

  it("prices the Sky executor's release above a plain one", async () => {
    const [stake, unstake] = await Promise.all([
      releaseTip(subsidized(0n), SkyRoute.Stake),
      releaseTip(subsidized(0n), SkyRoute.Unstake),
    ])
    expect(unstake.relayerTip).toBeGreaterThan(stake.relayerTip)
  })

  it("offers nothing once the subsidy covers the release", async () => {
    const tip = await releaseTip(subsidized(floor(SkyRoute.Stake)), SkyRoute.Stake)
    expect(tip.relayerTip).toBe(0n)
  })

  it("refuses a stale ETH/USD answer", async () => {
    const stale = subsidized(0n, NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n)
    await expect(releaseTip(stale, SkyRoute.Unstake)).rejects.toThrow(/stale/)
  })
})

describe("Sky escrow exits", () => {
  const args = {
    route: SkyRoute.Unstake,
    recipientCommitment: `0x${"ab".repeat(32)}` as Hex,
    recoveryCommitment: `0x00${"cd".repeat(31)}` as Hex,
    relayerTip: 7n,
    nonce: `0x${"ef".repeat(32)}` as Hex,
  }
  const ESCROW = predictSkyEscrowAddressLocally(FACTORY, args)
  const recover = {
    escrow: ESCROW,
    factory: FACTORY,
    args,
    recovery: { account: SENDER, salt: new Fr(42n) },
    signature: "0x1234" as Hex,
    target: SENDER,
    token: DAI,
    nonce: `0x${"01".repeat(32)}` as Hex,
    deadline: 99n,
  }
  const recoverData = encodeEscrowRecoverERC20({
    recoverySalt: recover.recovery.salt.toString() as Hex,
    account: SENDER,
    signature: recover.signature,
    target: SENDER,
    token: DAI,
    nonce: recover.nonce,
    deadline: 99n,
  })

  it("runs the escrow through the factory", () => {
    expect(buildSkyEscrowRunCall(FACTORY, args)).toEqual({
      to: FACTORY,
      data: encodeSkyEscrowDeploy(args),
    })
  })

  it("recovers from a deployed escrow directly, and deploys one that never ran in the same call", () => {
    expect(buildSkyEscrowRecoverCall({ ...recover, deployed: true })).toEqual({
      to: ESCROW,
      data: recoverData,
    })
    const undeployed = buildSkyEscrowRecoverCall({ ...recover, deployed: false })
    expect(undeployed.to).toBe(MULTICALL3_ADDRESS)
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data: undeployed.data })
      .args as readonly [readonly { target: Address; callData: Hex }[]]
    const deploy = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: calls[0]!.callData })
    expect([deploy.functionName, deploy.args[0]]).toEqual(["deploy", args])
    expect(calls[1]).toMatchObject({ target: ESCROW, callData: recoverData })
  })
})

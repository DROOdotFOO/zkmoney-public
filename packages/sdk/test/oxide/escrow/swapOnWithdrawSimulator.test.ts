/**
 * The tip a swap withdrawal commits to is the relayer's `minPayout` for the deploy-and-swap, times the margin.
 * oxide-client's `quoteL1Operation` owns the relayer's rule; what is pinned here is that the simulated operation
 * is the one the relayer sends, the storage-slot discovery that funds the counterfactual escrow, and the payout
 * measurement.
 */
import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import {
  SwapEscrowFactoryAbi,
  SwapRoute,
  predictSwapEscrowAddressLocally,
} from "@oxide/l1-contracts"
import { ETH_USD_MAX_PRICE_AGE_SECONDS, weiToUSD } from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  SIMULATED_SENDER_BALANCE,
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  gasCostAtQuotePrice,
  relayerGasCost,
} from "@oxide/oxide-client/l1_operation_quote.js"
import { L1_OPERATION_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import { MULTICALL3_ADDRESS } from "../../../src/services/sipa/sipaClaim.js"
import {
  SwapOnWithdrawSimulator,
  SwapTipExceedsInputError,
  findBalanceOfSlot,
  mappingSlot,
} from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"

const BASE_FEE = parseGwei("10")
const PRIORITY_FEE = parseGwei("1")
const FEES = await estimateL1OperationFeeValues({
  getBlock: async () => ({ baseFeePerGas: BASE_FEE }),
  estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
} as unknown as PublicClient)

const NOW = 1_800_000_000n
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** A token whose `balanceOf` mapping lives at `slot`, answering only through the state override. */
function tokenWithBalanceSlot(slot: bigint | undefined) {
  return {
    readContract: vi.fn(
      async ({
        args,
        stateOverride,
      }: {
        args: readonly [Address]
        stateOverride?: StateOverride
      }) => {
        if (slot === undefined) return 0n
        const wanted = mappingSlot(args[0], slot)
        const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
        return hit ? BigInt(hit.value) : 0n
      },
    ),
  } as unknown as Pick<PublicClient, "readContract">
}

describe("findBalanceOfSlot", () => {
  it("finds OpenZeppelin's slot 0 (the sandbox MintableToken) in one call", async () => {
    const client = tokenWithBalanceSlot(0n)
    await expect(
      findBalanceOfSlot(client, "0x000000000000000000000000000000000000da1a"),
    ).resolves.toBe(0n)
    expect(client.readContract).toHaveBeenCalledTimes(1)
  })

  it("finds mainnet DAI's slot 2", async () => {
    await expect(
      findBalanceOfSlot(tokenWithBalanceSlot(2n), "0x6b175474e89094c44da98b954eedeac495271d0f"),
    ).resolves.toBe(2n)
  })

  it("refuses a token whose balance is not a mapping in the probed slots", async () => {
    await expect(
      findBalanceOfSlot(
        tokenWithBalanceSlot(undefined),
        "0x000000000000000000000000000000000000da1a",
      ),
    ).rejects.toThrow(/state override/)
  })

  it("derives the slot the way Solidity does: keccak256(abi.encode(key, slot))", () => {
    expect(mappingSlot("0x000000000000000000000000000000000000b0b0", 2n)).toBe(
      "0x979613238220eb169bce36f2bc75edd95d03fb71f401bf9f649ef4e1a31403a1",
    )
  })
})

describe("SwapOnWithdrawSimulator", () => {
  const FACTORY = "0x00000000000000000000000000000000000fac70" as Address
  const OPERATION_EXECUTOR = "0x0000000000000000000000000000000000e0e0e0" as Address
  const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
  const IMPL = "0x0000000000000000000000000000000000001111" as Address
  const FEED = "0x000000000000000000000000000000000000feed" as Address
  const USDC = "0x000000000000000000000000000000000000c0c0" as Address
  const USDT = "0x000000000000000000000000000000000000c0c1" as Address
  const RECIPIENT = "0x0000000000000000000000000000000000000b0b" as Address
  const DAI_BALANCE_SLOT = 2n
  const GAS_USED = 250_000n
  const ETH_USD = 3000n * 10n ** 8n

  const uint = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value])

  function fakeClient(
    opts: {
      payout?: bigint
      /** ETH the gas swap pays; set, the payout reads the route and the ETH balance. */
      gasPayout?: bigint
      feedUpdatedAt?: bigint
      callFailure?: Error
      /** The executor takes the four-argument `execute`. */
      legacyExecutor?: boolean
    } = {},
  ) {
    const payout = opts.payout ?? 99_000_000n
    const balances = (offset: bigint) =>
      opts.gasPayout === undefined
        ? [{ success: true, returnData: uint(1_000n + offset * payout) }]
        : [
            { success: true, returnData: uint(1_000n + offset * payout) },
            { success: true, returnData: uint(5_000n + offset * opts.gasPayout) },
          ]
    const readContract = vi.fn(
      async ({
        address,
        functionName,
        args,
        stateOverride,
      }: {
        address: Address
        functionName: string
        args?: readonly unknown[]
        stateOverride?: StateOverride
      }) => {
        switch (functionName) {
          case "IMPLEMENTATION":
            return IMPL
          case "ETH_USD_FEED":
            return FEED
          case "USDC":
            return USDC
          case "USDT":
            return USDT
          case "decimals":
            return address === USDC || address === USDT ? 6 : 18
          case "latestRoundData":
            return [0n, ETH_USD, 0n, opts.feedUpdatedAt ?? NOW, 0n]
          case "balanceOf": {
            const wanted = mappingSlot(args![0] as Address, DAI_BALANCE_SLOT)
            const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
            return hit ? BigInt(hit.value) : 0n
          }
          default:
            throw new Error(`unexpected read ${functionName}`)
        }
      },
    )
    const client = {
      readContract,
      getBlock: vi.fn(async () => ({ number: 7n, baseFeePerGas: BASE_FEE, timestamp: NOW })),
      estimateMaxPriorityFeePerGas: vi.fn(async () => PRIORITY_FEE),
      simulateBlocks: vi.fn(async ({ blocks }: { blocks: { calls: { args: unknown[] }[] }[] }) => {
        // The executor dispatches only its own `execute`, and the other shape fails first.
        if (blocks[0]!.calls[0]!.args.length !== (opts.legacyExecutor ? 4 : 6)) {
          return [{ calls: [{ status: "failure", error: new Error("no data"), gasUsed: 0n }] }]
        }
        await new Promise((resolve) => setTimeout(resolve))
        return [
          {
            calls: [
              opts.callFailure
                ? { status: "failure", error: opts.callFailure, gasUsed: GAS_USED, data: "0x" }
                : { status: "success", result: 0n, gasUsed: GAS_USED, data: "0x", logs: [] },
            ],
          },
        ]
      }),
      call: vi.fn<(params: unknown) => Promise<{ data: Hex }>>(async () => ({
        data: encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: [...balances(0n), { success: true, returnData: "0x" }, ...balances(1n)],
        }),
      })),
    }
    return client
  }

  /** The `aggregate3` calls inside a Multicall3 `eth_call`. */
  const multicallCalls = (data: Hex) => {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data })
    if (decoded.functionName !== "aggregate3") throw new Error(`decoded ${decoded.functionName}`)
    return decoded.args[0]
  }

  /** The escrow args of a factory `deployAndExecute` call. */
  const deployedEscrowArgs = (data: Hex) => {
    const deploy = decodeFunctionData({ abi: SwapEscrowFactoryAbi, data })
    if (deploy.functionName !== "deployAndExecute")
      throw new Error(`decoded ${deploy.functionName}`)
    return deploy.args[0]
  }

  const simulator = (client: ReturnType<typeof fakeClient>) =>
    new SwapOnWithdrawSimulator(client as unknown as PublicClient, {
      swapEscrowFactoryV2: FACTORY,
      operationExecutor: OPERATION_EXECUTOR,
      token: DAI,
    })

  const deductions = {
    withdrawalFee: 2n * 10n ** 17n,
    withdrawalRelayerTip: 10n ** 17n,
    proverTip: 0n,
  }
  /** What the executor keeps from the burn before the escrow sees it. */
  const EXECUTOR_DEDUCTIONS = deductions.withdrawalFee + deductions.withdrawalRelayerTip
  const AMOUNT = 100n * 10n ** 18n
  const FUNDING = AMOUNT - EXECUTOR_DEDUCTIONS

  const minPayout = gasCostAtQuotePrice(
    GAS_USED + 2n * UINT256_EXTRA_CALLDATA_GAS,
    { number: 7n, baseFeePerGas: BASE_FEE },
    FEES,
    weiToUSD(WEI_PER_ETH, ETH_USD),
  )
  const expectedTip = {
    relayerTip: ceilDiv(minPayout * L1_OPERATION_TIP_MARGIN_BPS, 10_000n),
    minPayout,
    gasUsed: GAS_USED,
    maxFeePerGas: FEES.maxFeePerGas,
    usdPerEth: ETH_USD,
    baseFee: BASE_FEE,
    priorityFee: FEES.maxPriorityFeePerGas,
  }

  /** The single call of the single block `eth_simulateV1` ran with `argCount` arguments, and its escrow args. */
  const simulatedCall = (client: ReturnType<typeof fakeClient>, argCount = 6) => {
    const { blocks } = client.simulateBlocks.mock.calls
      .map(([request]) => request)
      .find((request) => request.blocks[0]!.calls[0]!.args.length === argCount) as unknown as {
      blocks: {
        stateOverrides: StateOverride
        calls: { from: Address; to: Address; functionName: string; args: readonly unknown[] }[]
      }[]
    }
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.calls).toHaveLength(1)
    const call = blocks[0]!.calls[0]!
    expect(call.functionName).toBe("execute")
    const [target, deployCalldata, payoutToken, minPayoutArg] = call.args as [
      Address,
      Hex,
      Address,
      bigint,
    ]
    expect(target).toBe(FACTORY)
    expect(payoutToken).toBe(DAI)
    const escrowArgs = deployedEscrowArgs(deployCalldata)
    // Like the relayer's gas run, the simulation demands the committed tip as its payout.
    expect(minPayoutArg).toBe(escrowArgs.relayerTip)
    return { ...call, escrowArgs, stateOverride: blocks[0]!.stateOverrides }
  }

  it("prices the relayer's exact execute call and pays out the executed swap", async () => {
    const client = fakeClient()
    const simulation = await simulator(client).simulate({
      output: "USDC",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })

    expect(simulation).toEqual({ ...expectedTip, amountOut: 99_000_000n, decimals: 6, gasOut: 0n })

    // The simulation is the relayer's transaction: to the operation executor, paying DAI.
    const simulated = simulatedCall(client)
    expect(simulated.from).not.toBe(RECIPIENT)
    expect(simulated.to).toBe(OPERATION_EXECUTOR)
    const simulatedArgs = simulated.escrowArgs
    expect(simulatedArgs.route).toBe(SwapRoute.USDC)
    expect(simulatedArgs.recipient.toLowerCase()).toBe(RECIPIENT)
    // The factory refuses a zero commitment; the execute path never opens it.
    expect(simulatedArgs.recoveryCommitment).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(simulatedArgs.recoveryCommitment)).not.toBe(0n)
    expect(simulatedArgs.relayerTip).toBe(1n)
    // The counterfactual escrow holds exactly what the portal will release to it.
    const escrow = predictSwapEscrowAddressLocally(FACTORY, simulatedArgs)
    expect(simulated.stateOverride).toEqual([
      { address: simulated.from, balance: SIMULATED_SENDER_BALANCE },
      {
        address: DAI,
        stateDiff: [
          {
            slot: mappingSlot(escrow, DAI_BALANCE_SLOT),
            value: `0x${FUNDING.toString(16).padStart(64, "0")}`,
          },
        ],
      },
    ])

    // The payout runs the final args — the committed tip — through Multicall3 as the recipient.
    const payout = client.call.mock.calls[0]![0] as {
      to: Address
      account: Address
      data: Hex
      stateOverride: StateOverride
    }
    expect(payout.to).toBe(MULTICALL3_ADDRESS)
    expect(payout.account).toBe(RECIPIENT)
    const [before, deploy, after] = multicallCalls(payout.data)
    expect(before).toEqual(after)
    expect(before!.target.toLowerCase()).toBe(USDC)
    expect(before!.allowFailure).toBe(false)
    const finalArgs = deployedEscrowArgs(deploy!.callData)
    expect(finalArgs.relayerTip).toBe(expectedTip.relayerTip)
    expect(deploy!.target.toLowerCase()).toBe(FACTORY)
    expect(payout.stateOverride[0]!.stateDiff![0]!.slot).toBe(
      mappingSlot(predictSwapEscrowAddressLocally(FACTORY, finalArgs), DAI_BALANCE_SLOT),
    )
  })

  it("prices with the escrow's ETH/USD feed", async () => {
    const client = fakeClient()
    await simulator(client).simulate({
      output: "USDC",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: FEED, functionName: "latestRoundData" }),
    )
  })

  it("measures the ETH route on the recipient's ETH balance through Multicall3", async () => {
    const client = fakeClient({ payout: 31_350_000_000_000_000n })
    const simulation = await simulator(client).simulate({
      output: "ETH",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })
    expect(simulation.amountOut).toBe(31_350_000_000_000_000n)
    expect(simulation.decimals).toBe(18)
    const [balanceCall] = multicallCalls((client.call.mock.calls[0]![0] as { data: Hex }).data)
    expect(balanceCall!.target.toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase())
    expect(balanceCall!.callData.startsWith("0x4d2301cc")).toBe(true) // getEthBalance(address)
  })

  it("swaps the gas share on the DAI route and measures it on the recipient's ETH balance", async () => {
    const daiForGas = 5n * 10n ** 18n
    const client = fakeClient({ payout: 90n * 10n ** 18n, gasPayout: 1_600_000_000_000_000n })
    const simulation = await simulator(client).simulate({
      output: "DAI",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
      daiForGas,
    })
    expect(simulation).toMatchObject({
      amountOut: 90n * 10n ** 18n,
      decimals: 18,
      gasOut: 1_600_000_000_000_000n,
    })
    // The tip is priced on the exact escrow the burn commits to: the gas swap included.
    expect(simulatedCall(client).escrowArgs).toMatchObject({ route: SwapRoute.DAI, daiForGas })
    const [routeBefore, ethBefore, deploy, routeAfter, ethAfter] = multicallCalls(
      (client.call.mock.calls[0]![0] as { data: Hex }).data,
    )
    expect(routeBefore!.target.toLowerCase()).toBe(DAI)
    expect(ethBefore!.callData.startsWith("0x4d2301cc")).toBe(true) // getEthBalance(address)
    expect([routeAfter, ethAfter]).toEqual([routeBefore, ethBefore])
    expect(deployedEscrowArgs(deploy!.callData)).toMatchObject({ daiForGas, minEthForGas: 0n })
  })

  it("refuses a gas share the escrow funding cannot cover, before and after the tip", async () => {
    const daiForGas = 5n * 10n ** 18n
    const fees = EXECUTOR_DEDUCTIONS
    await expect(
      simulator(fakeClient()).simulate({
        output: "USDC",
        amount: fees + daiForGas,
        deductions,
        recipient: RECIPIENT,
        daiForGas,
      }),
    ).rejects.toThrow(/does not cover the withdrawal fees and the gas swap/)
    await expect(
      simulator(fakeClient()).simulate({
        output: "USDC",
        amount: fees + daiForGas + expectedTip.relayerTip,
        deductions,
        recipient: RECIPIENT,
        daiForGas,
      }),
    ).rejects.toBeInstanceOf(SwapTipExceedsInputError)
  })

  it("quotes through an executor that takes the four-argument execute", async () => {
    const client = fakeClient({ legacyExecutor: true })
    const simulation = await simulator(client).simulate({
      output: "USDC",
      amount: AMOUNT,
      deductions,
      recipient: RECIPIENT,
    })
    // A legacy executor takes a fixed floor, which the relayer prices at the max fee per gas.
    const legacyMinPayout = relayerGasCost(
      "legacy",
      GAS_USED + 2n * UINT256_EXTRA_CALLDATA_GAS,
      { number: 7n, baseFeePerGas: BASE_FEE },
      FEES,
      weiToUSD(WEI_PER_ETH, ETH_USD),
    )
    expect(simulation).toEqual({
      ...expectedTip,
      minPayout: legacyMinPayout,
      relayerTip: ceilDiv(legacyMinPayout * L1_OPERATION_TIP_MARGIN_BPS, 10_000n),
      amountOut: 99_000_000n,
      decimals: 6,
      gasOut: 0n,
    })
    expect(simulatedCall(client, 4).to).toBe(OPERATION_EXECUTOR)
  })

  it("throws when the simulated execute fails", async () => {
    const client = fakeClient({ callFailure: new Error("SwapEscrow: swap reverted") })
    await expect(
      simulator(client).simulate({
        output: "USDC",
        amount: AMOUNT,
        deductions,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/swap reverted/)
  })

  it("reports the tip when the amount leaves nothing to swap after paying it", async () => {
    const client = fakeClient()
    const amount = EXECUTOR_DEDUCTIONS + expectedTip.relayerTip
    const attempt = simulator(client).simulate({
      output: "USDC",
      amount,
      deductions,
      recipient: RECIPIENT,
    })
    await expect(attempt).rejects.toBeInstanceOf(SwapTipExceedsInputError)
    await expect(attempt).rejects.toMatchObject({
      tip: expectedTip,
      escrowFunding: expectedTip.relayerTip,
    })
    expect(client.call).not.toHaveBeenCalled()
  })

  it("refuses an amount the portal's deductions already consume", async () => {
    const client = fakeClient()
    await expect(
      simulator(client).simulate({
        output: "USDC",
        amount: EXECUTOR_DEDUCTIONS,
        deductions,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/does not cover/)
    expect(client.simulateBlocks).not.toHaveBeenCalled()
  })

  it("refuses to price off a stale feed", async () => {
    const client = fakeClient({ feedUpdatedAt: NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n })
    await expect(
      simulator(client).simulate({
        output: "USDC",
        amount: AMOUNT,
        deductions,
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/stale/)
  })

  it("reads the deployment and the balance slot once per simulator", async () => {
    const client = fakeClient()
    const sim = simulator(client)
    await sim.simulate({ output: "USDC", amount: AMOUNT, deductions, recipient: RECIPIENT })
    await sim.simulate({ output: "ETH", amount: AMOUNT, deductions, recipient: RECIPIENT })
    const reads = client.readContract.mock.calls.map(
      (call) => (call[0] as { functionName: string }).functionName,
    )
    expect(reads.filter((name) => name === "IMPLEMENTATION")).toHaveLength(1)
    expect(reads.filter((name) => name === "balanceOf")).toHaveLength(1)
    // Each simulation quotes both `execute` shapes, and each quote reads the feed.
    expect(reads.filter((name) => name === "latestRoundData")).toHaveLength(4)
  })
})

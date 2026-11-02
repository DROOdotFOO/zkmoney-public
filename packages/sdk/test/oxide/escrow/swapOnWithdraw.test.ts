/**
 * The plan is what the burn and the broadcast both commit to: the escrow address must be the
 * CREATE2 image of the exact args the deploy calldata carries, or the withdrawal funds an address
 * the factory can never deploy to.
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { decodeFunctionData, multicall3Abi, type Address } from "viem"
import {
  predictSwapEscrowAddressLocally,
  SwapEscrowAbi,
  SwapEscrowFactoryAbi,
  SwapRoute,
} from "@oxide/l1-contracts"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { MULTICALL3_ADDRESS } from "../../../src/services/sipa/sipaClaim.js"
import {
  buildSwapEscrowExecuteCall,
  buildSwapEscrowRecoverCall,
  planSwapOnWithdraw,
  predictSwapEscrow,
  swapRouteForOutput,
  type LegacySwapEscrowArgs,
  type SwapEscrowCommitment,
  type SwapRecovery,
} from "../../../src/oxide/escrow/swapOnWithdraw.js"

const FACTORY = "0x00000000000000000000000000000000000fac70"
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"
const RECIPIENT = "0x0000000000000000000000000000000000000b0b"
const RECOVERY: SwapRecovery = {
  account: "0x0000000000000000000000000000000000005afe",
  salt: new Fr(7n),
}
const NONCE = `0x${"11".repeat(32)}` as const
const OTHER_NONCE = `0x${"22".repeat(32)}` as const

const commitment = (recovery: SwapRecovery) =>
  deriveRecoveryCommitment(recovery.salt, EthAddress.fromString(recovery.account)).toString()

const plan = (overrides: Partial<Parameters<typeof planSwapOnWithdraw>[0]> = {}) =>
  planSwapOnWithdraw({
    swapEscrowFactoryV2: FACTORY,
    output: "USDT",
    l1Recipient: RECIPIENT,
    recovery: RECOVERY,
    amount: 100n * 10n ** 18n,
    withdrawalFee: 2n * 10n ** 17n,
    withdrawalRelayerTip: 10n ** 17n,
    proverTip: 0n,
    relayerTip: 0n,
    nonce: NONCE,
    ...overrides,
  })

describe("planSwapOnWithdraw", () => {
  it("maps outputs onto Oxide's SwapRoute enum", () => {
    expect(swapRouteForOutput("USDC")).toBe(SwapRoute.USDC)
    expect(swapRouteForOutput("USDT")).toBe(SwapRoute.USDT)
    expect(swapRouteForOutput("ETH")).toBe(SwapRoute.ETH)
    expect(swapRouteForOutput("DAI")).toBe(SwapRoute.DAI)
  })

  it("commits the escrow to its gas swap, and leaves the route something after it", () => {
    const daiForGas = 5n * 10n ** 18n
    const withGas = plan({ output: "DAI", daiForGas })
    expect(withGas.escrowArgs).toMatchObject({ route: SwapRoute.DAI, daiForGas, minEthForGas: 0n })
    expect(withGas.escrow).not.toBe(plan({ output: "DAI" }).escrow)
    // input = 100 - 0.2 - 0.1 - tip; the route must keep more than the gas share.
    const tip = 100n * 10n ** 18n - 3n * 10n ** 17n - daiForGas
    expect(() => plan({ daiForGas, relayerTip: tip })).toThrow(/nothing left/)
    expect(() => plan({ daiForGas, relayerTip: tip - 1n })).not.toThrow()
  })

  it("commits the escrow address to the exact args the deploy calldata carries", () => {
    const result = plan({ nonce: NONCE, relayerTip: 5n * 10n ** 18n })
    const decoded = decodeFunctionData({
      abi: SwapEscrowFactoryAbi,
      data: result.deployCalldata,
    }) as { functionName: string; args: readonly [Record<string, unknown>] }
    expect(decoded.functionName).toBe("deployAndExecute")
    expect(decoded.args[0]).toMatchObject({
      route: SwapRoute.USDT,
      recipient: expect.stringMatching(new RegExp(RECIPIENT, "i")),
      daiForGas: 0n,
      minEthForGas: 0n,
      recoveryCommitment: commitment(RECOVERY),
      relayerTip: 5n * 10n ** 18n,
      nonce: NONCE,
    })
    expect(result.escrow).toBe(predictSwapEscrowAddressLocally(FACTORY, result.escrowArgs))
  })

  it("commits the recovery account and salt: changing either is a different escrow", () => {
    const a = plan()
    expect(a.recovery).toBe(RECOVERY)
    const otherAccount = plan({
      recovery: { ...RECOVERY, account: "0x000000000000000000000000000000000000beef" },
    })
    const otherSalt = plan({ recovery: { ...RECOVERY, salt: new Fr(8n) } })
    expect(otherAccount.escrow).not.toBe(a.escrow)
    expect(otherSalt.escrow).not.toBe(a.escrow)
    expect(otherSalt.escrow).not.toBe(otherAccount.escrow)
  })

  it("takes the caller's nonce, so repeat withdrawals never share an escrow", () => {
    const a = plan({ nonce: NONCE })
    const b = plan({ nonce: OTHER_NONCE })
    expect(a.escrow).not.toBe(b.escrow)
  })

  it("refuses the zero address as the recovery account", () => {
    expect(() => plan({ recovery: { ...RECOVERY, account: `0x${"00".repeat(20)}` } })).toThrow(
      /recovery account must be nonzero/,
    )
  })

  it("rejects deductions that leave nothing to swap", () => {
    // input = 100 - 0.2 - 0.1 - tip; the factory executes only above zero, so the boundary is <= 0.
    expect(() => plan({ relayerTip: 100n * 10n ** 18n - 3n * 10n ** 17n })).toThrow(/nothing left/)
    expect(() => plan({ relayerTip: 100n * 10n ** 18n - 3n * 10n ** 17n - 1n })).not.toThrow()
  })
})

describe("swap escrow self-execution and recovery calls", () => {
  const SIG = `0x${"ab".repeat(65)}` as const
  const TARGET = "0x000000000000000000000000000000000000d00d"
  const DEADLINE = 1_800_000_000n

  const recoverCall = (deployed: boolean) => {
    const result = plan()
    return {
      result,
      call: buildSwapEscrowRecoverCall({
        deployed,
        factory: FACTORY,
        escrow: result.escrow,
        commitment: { layout: "v2", args: result.escrowArgs },
        recovery: result.recovery,
        signature: SIG,
        target: TARGET,
        token: DAI,
        nonce: OTHER_NONCE,
        deadline: DEADLINE,
      }),
    }
  }

  /** `recoverERC20`'s args, addresses lowercased. */
  const recoverArgs = (data: `0x${string}`) => {
    const decoded = decodeFunctionData({ abi: SwapEscrowAbi, data })
    expect(decoded.functionName).toBe("recoverERC20")
    return (decoded.args as readonly (string | bigint)[]).map((a) =>
      typeof a === "string" ? a.toLowerCase() : a,
    )
  }

  it("execute is the same factory.deployAndExecute the broadcast carries", () => {
    const result = plan()
    const call = buildSwapEscrowExecuteCall(FACTORY, { layout: "v2", args: result.escrowArgs })
    expect(call).toEqual({ to: FACTORY, data: result.deployCalldata })
  })

  it("recovers a deployed escrow with a direct recoverERC20 opening the commitment", () => {
    const { result, call } = recoverCall(true)
    expect(call.to).toBe(result.escrow)
    const [salt, account, ...rest] = recoverArgs(call.data)
    expect(salt).toBe(RECOVERY.salt.toString())
    expect(account).toBe(RECOVERY.account)
    expect(rest).toEqual([SIG, TARGET, DAI, OTHER_NONCE, DEADLINE])
    expect(
      deriveRecoveryCommitment(
        Fr.fromHexString(salt as string),
        EthAddress.fromString(account as Address),
      ).toString(),
    ).toBe(result.escrowArgs.recoveryCommitment)
  })

  it("deploys an escrow without code first, atomically, through Multicall3", () => {
    const { result, call } = recoverCall(false)
    expect(call.to).toBe(MULTICALL3_ADDRESS)
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data }) as {
      functionName: string
      args: readonly [readonly { target: string; allowFailure: boolean; callData: `0x${string}` }[]]
    }
    expect(decoded.functionName).toBe("aggregate3")
    const [deployLeg, recoverLeg] = decoded.args[0]
    expect(deployLeg!.target.toLowerCase()).toBe(FACTORY)
    expect(deployLeg!.allowFailure).toBe(false)
    const deploy = decodeFunctionData({ abi: SwapEscrowFactoryAbi, data: deployLeg!.callData })
    expect(deploy.functionName).toBe("deploy")
    expect(recoverLeg!.target.toLowerCase()).toBe(result.escrow.toLowerCase())
    expect(recoverLeg!.allowFailure).toBe(false)
    expect(recoverLeg!.callData).toBe(recoverCall(true).call.data)
  })
})

describe("legacy swap escrows", () => {
  // The prod manifest's `swapEscrowFactory`: its `predictEscrowAddress` returns ESCROW for ARGS.
  const LEGACY_FACTORY = "0x03b21bba8e75a1bd0354c5ecbec078cf59c85343"
  const ARGS: LegacySwapEscrowArgs = {
    route: SwapRoute.USDC,
    recipient: "0x1111111111111111111111111111111111111111",
    recoveryCommitment: `0x${"22".repeat(32)}`,
    relayerTip: 1234567890123456789n,
    nonce: `0x${"33".repeat(32)}`,
  }
  const ESCROW = "0x989bF68BCd5EBF60655AD10e45d7d182f5Afe6b0"
  const ENCODED = `${"0".repeat(64)}${"0".repeat(24)}${"11".repeat(20)}${"22".repeat(
    32,
  )}${"112210f47de98115".padStart(64, "0")}${"33".repeat(32)}`
  const legacy: SwapEscrowCommitment = { layout: "legacy", args: ARGS }

  it("derives the escrow the legacy factory deploys", () => {
    expect(predictSwapEscrow(LEGACY_FACTORY, legacy)).toBe(ESCROW)
    expect(
      predictSwapEscrow(LEGACY_FACTORY, {
        layout: "v2",
        args: { ...ARGS, daiForGas: 0n, minEthForGas: 0n },
      }),
    ).not.toBe(ESCROW)
  })

  it("runs the swap with the legacy deployAndExecute", () => {
    expect(buildSwapEscrowExecuteCall(LEGACY_FACTORY, legacy)).toEqual({
      to: LEGACY_FACTORY,
      data: `0xd1cb17ef${ENCODED}`,
    })
  })

  it("deploys an escrow without code with the legacy deploy before the recovery", () => {
    const call = buildSwapEscrowRecoverCall({
      deployed: false,
      factory: LEGACY_FACTORY,
      escrow: ESCROW,
      commitment: legacy,
      recovery: RECOVERY,
      signature: `0x${"ab".repeat(65)}`,
      target: RECIPIENT,
      token: DAI,
      nonce: OTHER_NONCE,
      deadline: 1_800_000_000n,
    })
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data }) as {
      args: readonly [readonly { target: string; callData: `0x${string}` }[]]
    }
    const [deployLeg, recoverLeg] = decoded.args[0]
    expect(deployLeg!.target.toLowerCase()).toBe(LEGACY_FACTORY)
    expect(deployLeg!.callData).toBe(`0xebd3470d${ENCODED}`)
    expect(recoverLeg!.target.toLowerCase()).toBe(ESCROW.toLowerCase())
  })
})

/**
 * The fresh-address withdrawal: one burn to one swap escrow that lands the funds as the picked asset
 * and swaps the gas share to ETH, its route floor on top of what the recipient should receive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem"
import { SwapRoute } from "@oxide/l1-contracts"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"

const BURN_TX = `0x${"0b".repeat(32)}` as Hex
const TX_AMOUNT_CAP = 5166n * 10n ** 18n
const RECIPIENT = getAddress(`0x${"dd".repeat(20)}`) as Address
const ACCOUNT = getAddress(`0x${"ac".repeat(20)}`)
const SWAP_TUPLE = {
  swapEscrowFactoryV2: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}

const QUOTE = {
  relayerTip: 2n * 10n ** 18n,
  amountOut: 118_000_000n,
  decimals: 6,
  gasOut: parseUnits("0.0016", 18),
  floorAtomic: parseUnits("2.5", 18),
}
const INPUT = {
  recipient: RECIPIENT,
  recipientAlias: "Fresh",
  fundsDisplay: "120",
  gasDisplay: "5",
  fundsAsset: "USDC" as const,
  quote: QUOTE,
}
const GAS = parseUnits("5", 18)
const BURN = parseUnits("120", 18) + GAS + QUOTE.floorAtomic

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1Transport: () => ({}),
}))
const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === "predictAccountAddress" ? ACCOUNT : undefined,
)
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ ...SWAP_TUPLE }),
  l1PublicClient: () => ({ readContract }),
}))
vi.mock("../../../../src/features/token/oxideToken", () => ({
  currentTxAmountCap: async () => TX_AMOUNT_CAP,
}))
const claimSponsorContext = vi.fn(async () => ({ fpcAddress: {}, policy: {} }))
vi.mock("../../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: (...args: unknown[]) => claimSponsorContext(...(args as [])),
  noteSubscribed: vi.fn(),
}))
vi.mock("../../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
const MASTER_SECRET = { toString: () => `0x${"11".repeat(32)}` }
const mockSecretKey = vi.fn(async () => MASTER_SECRET as never)
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: mockSecretKey }),
}))

const { submitFreshAddressWithdrawal } = await import(
  "../../../../src/features/withdraw/freshAddressGateway"
)
const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)
const withdrawals = () => session().withdrawals

type ExitOpts = {
  useRawAmount?: boolean
  withdrawal: { swap?: { escrowArgs: { route: number; daiForGas: bigint } } }
  proverTip?: bigint
}
type ExitCall = [{ toString(): string }, string, unknown, ExitOpts]

/** A burn that mines what it was asked to burn. */
const exitMock = () =>
  vi.fn(async (_to: unknown, amount: string) => ({
    txHash: BURN_TX,
    blockNumber: 43,
    amount: BigInt(amount),
    humanReadableAmount: formatUnits(BigInt(amount), 18),
    l1Recipient: RECIPIENT,
  }))

type Given = { screen?: () => Promise<unknown> }
const deps = ({ screen = async () => ({ compliant: true }) }: Given = {}) =>
  ({
    wallet: { networkId: "0xnet", node: { getContract: async () => ({}) }, pxe: {} },
    account: { getAddress: () => ({ toString: () => "0xuser" }) },
    contractService: {},
    screener: { screen: vi.fn(screen) },
    tokenService: {
      fetchTokenInformation: vi.fn(async () => ({ symbol: "DAI", decimals: 18 })),
      exitToL1PrivateSponsored: exitMock(),
    },
  } as unknown as Parameters<typeof submitFreshAddressWithdrawal>[0])

const exitCalls = (d: ReturnType<typeof deps>) =>
  (d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>).mock.calls as ExitCall[]

beforeEach(async () => {
  localStorage.clear()
  claimSponsorContext.mockClear()
})

describe("submitFreshAddressWithdrawal", () => {
  it("burns once to an escrow that lands the funds and swaps the gas share to ETH", async () => {
    const d = deps()
    const onStage = vi.fn()
    const record = await submitFreshAddressWithdrawal(d, INPUT, onStage)

    expect(onStage.mock.calls.map(([s]) => s)).toEqual(["building", "proving", "submitting"])
    expect(record).toMatchObject({
      phase: "l2_mined",
      l2TxHash: BURN_TX,
      recipient: RECIPIENT,
      recipientAlias: "Fresh",
      rawAmount: BURN.toString(),
      swapOutput: "USDC",
      swapEscrowLayout: "v2",
      swapDaiForGas: GAS.toString(),
      swapRelayerTip: QUOTE.relayerTip.toString(),
      swapEstimatedOut: QUOTE.amountOut.toString(),
      swapEstimatedGasOut: QUOTE.gasOut.toString(),
    })
    expect(record.groupId).toBeUndefined()
    const [[to, amount, , opts]] = exitCalls(d)
    expect(exitCalls(d)).toHaveLength(1)
    expect(to.toString().toLowerCase()).toBe(record.swapEscrow!.toLowerCase())
    expect(amount).toBe(BURN.toString())
    expect(opts.useRawAmount).toBe(true)
    expect(opts.withdrawal.swap!.escrowArgs).toMatchObject({
      route: SwapRoute.USDC,
      daiForGas: GAS,
    })
  })

  it("lands DAI with a gas share through an escrow on the DAI route", async () => {
    const d = deps()
    const quote = { ...QUOTE, amountOut: parseUnits("120", 18), decimals: 18 }
    const record = await submitFreshAddressWithdrawal(
      d,
      { ...INPUT, fundsAsset: "DAI", quote },
      vi.fn(),
    )
    expect(record).toMatchObject({ swapOutput: "DAI", swapDaiForGas: GAS.toString() })
    expect(exitCalls(d)[0]![3].withdrawal.swap!.escrowArgs).toMatchObject({
      route: SwapRoute.DAI,
      daiForGas: GAS,
    })
  })

  it("adds the gas share to the ETH route, which already pays ETH", async () => {
    const d = deps()
    const quote = { ...QUOTE, amountOut: parseUnits("0.04", 18), decimals: 18, gasOut: undefined }
    const record = await submitFreshAddressWithdrawal(
      d,
      { ...INPUT, fundsAsset: "ETH", quote },
      vi.fn(),
    )
    expect(record.swapOutput).toBe("ETH")
    expect(record.swapDaiForGas).toBeUndefined()
    expect(exitCalls(d)[0]![1]).toBe(BURN.toString())
    expect(exitCalls(d)[0]![3].withdrawal.swap!.escrowArgs).toMatchObject({
      route: SwapRoute.ETH,
      daiForGas: 0n,
    })
  })

  it("burns DAI with no gas share straight to the address", async () => {
    const d = deps()
    const quote = {
      relayerTip: 0n,
      amountOut: 0n,
      decimals: 18,
      floorAtomic: parseUnits("0.35", 18),
    }
    const record = await submitFreshAddressWithdrawal(
      d,
      { ...INPUT, fundsAsset: "DAI", gasDisplay: "0", quote },
      vi.fn(),
    )
    expect(record.swapOutput).toBeUndefined()
    const [[to, amount, , opts]] = exitCalls(d)
    expect(to.toString().toLowerCase()).toBe(RECIPIENT.toLowerCase())
    expect(amount).toBe((parseUnits("120", 18) + quote.floorAtomic).toString())
    expect(opts.withdrawal.swap).toBeUndefined()
  })

  const blocked = async () => ({ compliant: false, reason: { message: "Sanctioned address" } })
  it.each<[string, Given & { locked?: boolean }, RegExp]>([
    ["the screener blocks the address", { screen: blocked }, /Sanctioned/],
    ["the screener throws", { screen: () => Promise.reject(new Error("screener 503")) }, /503/],
    ["the wallet is locked", { locked: true }, /Unlock/],
  ])("aborts before the passkey opens or any record exists when %s", async (_, given, error) => {
    if (given.locked) mockSecretKey.mockResolvedValueOnce(undefined as never)
    const d = deps(given)
    await expect(submitFreshAddressWithdrawal(d, INPUT, vi.fn())).rejects.toThrow(error)
    expect(exitCalls(d)).toHaveLength(0)
    expect(withdrawals().list.get().records).toHaveLength(0)
  })
})

describe("submitFreshAddressWithdrawal — the per-withdrawal limit", () => {
  const LIMIT_ATOMIC = parseUnits(String(LIMIT), 18)
  // What the recipient should receive so that the burn is `burn`, the gas share and floor on top.
  const funds = (burn: bigint) => formatUnits(burn - GAS - QUOTE.floorAtomic, 18)

  it(`sends a burn of exactly ${LIMIT_USD}, gas share and fees included`, async () => {
    const d = deps()
    await submitFreshAddressWithdrawal(d, { ...INPUT, fundsDisplay: funds(LIMIT_ATOMIC) }, vi.fn())
    expect(exitCalls(d).map(([, amount]) => amount)).toEqual([LIMIT_ATOMIC.toString()])
  })

  it("refuses one atomic unit more before screening, signing or recording", async () => {
    const d = deps()
    const run = submitFreshAddressWithdrawal(
      d,
      { ...INPUT, fundsDisplay: funds(LIMIT_ATOMIC + 1n) },
      vi.fn(),
    )
    await expect(run).rejects.toThrow(
      `This withdrawal is over the ${LIMIT_USD} limit, fees included.`,
    )
    expect(d.screener.screen).not.toHaveBeenCalled()
    expect(exitCalls(d)).toHaveLength(0)
    expect(withdrawals().list.get().records).toHaveLength(0)
  })
})

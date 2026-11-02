/** The factory, the table and the subsidy as the wallet reads them for a sweep route. */
import { describe, expect, it, vi } from "vitest"
import { ForwardingTableAbi, SipaIntent } from "@oxide/l1-contracts"
import { ContractFunctionRevertedError, type Address, type PublicClient } from "viem"
import {
  readBlessedImplementations,
  readDepositSubsidyConfig,
  readSweepRouteLiveness,
} from "../../../src/services/sipa/sipaIntents.js"

const addr = (tag: string) => `0x${tag.padStart(40, "0")}` as Address
const FACTORY = addr("fac")
const TABLE = addr("7ab1e")
const TOKEN = addr("70")
const SUBSIDY = addr("5b5")
const PORTAL = addr("90")
const BENEFICIARY = addr("be")
const IMPL = addr("1491")
const OLD_IMPL = addr("1490")
const DEPOSIT_IMPL = addr("de90")
const ZERO = addr("")
const TIP = 5n * 10n ** 17n
const ONE_ETH = 10n ** 18n

type Config = [bigint, bigint, bigint]
const CONFIG: Config = [TIP, 10_000n * ONE_ETH, ONE_ETH]
const ROW: [Address, Address, bigint, bigint] = [PORTAL, BENEFICIARY, 0n, TIP]
const ROUTE = {
  forwardingTable: TABLE,
  token: TOKEN,
  depositSubsidy: SUBSIDY,
  intent: SipaIntent.UserOp,
}

function fakeClient(
  opts: {
    row?: [Address, Address, bigint, bigint] | null
    config?: Config
    balance?: bigint
    implementation?: Address
    logs?: { implementation: Address; intent: number }[]
  } = {},
) {
  const {
    row = ROW,
    config = CONFIG,
    balance = 50n * ONE_ETH,
    implementation = IMPL,
    logs = [],
  } = opts
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "rowFor":
          if (!row)
            throw new ContractFunctionRevertedError({ abi: ForwardingTableAbi, functionName })
          return row
        case "$depositConfig":
          return config
        case "balanceOf":
          return balance
        case "implementationFor":
          return implementation
        default:
          throw new Error(`unexpected read ${functionName}`)
      }
    }),
    getBlockNumber: vi.fn(async () => 100n),
    getContractEvents: vi.fn<(request: object) => Promise<{ args: unknown }[]>>(async () =>
      logs.map((args) => ({ args })),
    ),
  }
}

const client = (fake: ReturnType<typeof fakeClient>) => fake as unknown as PublicClient

describe("readSweepRouteLiveness", () => {
  it("names the first reason the route is dead", async () => {
    const dead = async (fake: ReturnType<typeof fakeClient>) => {
      const liveness = await readSweepRouteLiveness(client(fake), ROUTE)
      return liveness.live ? "live" : liveness.reason
    }
    expect(await dead(fakeClient({ row: null, balance: 0n }))).toBe(
      "the forwarding table has no row for the token and intent",
    )
    expect(await dead(fakeClient({ config: [0n, 0n, ONE_ETH] }))).toBe(
      "the subsidy pays no relayer profit",
    )
    expect(
      await dead(fakeClient({ row: [PORTAL, BENEFICIARY, 0n, 0n], config: [TIP, 0n, ONE_ETH] })),
    ).toBe("the row's tip is zero, so the subsidy pays no relayer profit")
    expect(await dead(fakeClient({ config: [TIP, 0n, ONE_ETH], balance: 0n }))).toBe(
      "the subsidy's cap is zero",
    )
    expect(await dead(fakeClient({ balance: 0n }))).toBe("the subsidy holds none of the token")
  })
})

describe("readBlessedImplementations", () => {
  const logs = [
    { implementation: OLD_IMPL, intent: SipaIntent.UserOp },
    { implementation: DEPOSIT_IMPL, intent: SipaIntent.Deposit },
    { implementation: IMPL, intent: SipaIntent.UserOp },
    { implementation: ZERO, intent: SipaIntent.UserOp },
    { implementation: OLD_IMPL, intent: SipaIntent.UserOp },
  ]

  it("lists the current implementation first, then every earlier blessing of the intent, once", async () => {
    const fake = fakeClient({ logs })

    const blessed = await readBlessedImplementations(client(fake), FACTORY, SipaIntent.UserOp)

    expect(blessed).toEqual([IMPL, OLD_IMPL])
    expect(fake.getContractEvents).toHaveBeenCalledWith({
      address: FACTORY,
      abi: expect.any(Array),
      eventName: "ImplementationBlessed",
      args: { intent: SipaIntent.UserOp },
      fromBlock: 0n,
      toBlock: 100n,
    })
  })

  it("reads the whole history first, and the given window when the RPC refuses it", async () => {
    const fake = fakeClient({ logs, implementation: ZERO })
    expect(await readBlessedImplementations(client(fake), FACTORY, SipaIntent.UserOp, 40n)).toEqual(
      [OLD_IMPL, IMPL],
    )
    expect(fake.getContractEvents.mock.calls.map((c) => c[0])).toMatchObject([
      { fromBlock: 0n, toBlock: 100n },
    ])

    fake.getContractEvents.mockRejectedValueOnce(
      new Error("query returned more than 10000 results"),
    )
    expect(await readBlessedImplementations(client(fake), FACTORY, SipaIntent.UserOp, 40n)).toEqual(
      [OLD_IMPL, IMPL],
    )
    expect(fake.getContractEvents.mock.calls.slice(1).map((c) => c[0])).toMatchObject([
      { fromBlock: 0n, toBlock: 100n },
      { fromBlock: 40n, toBlock: 100n },
    ])
  })
})

describe("readDepositSubsidyConfig", () => {
  it("names the subsidy's tuple", async () => {
    expect(await readDepositSubsidyConfig(client(fakeClient()), SUBSIDY)).toEqual({
      targetRelayerProfit: TIP,
      maxSubsidyPerOperation: 10_000n * ONE_ETH,
      minCreditedAmount: ONE_ETH,
    })
  })
})

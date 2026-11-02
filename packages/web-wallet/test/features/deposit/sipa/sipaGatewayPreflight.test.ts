/**
 * The gateway's last check runs immediately before any transfer request, on the injected-wallet path and on the
 * desktop hand-off, and again each time the desktop helper is about to send. A failed check requests nothing. With the
 * connected-deposit check, capacity that cannot be established does not stop a USDC or USDT transfer.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { parseUnits, type Address, type Hex } from "viem"
import { createPortalCapacityStore, type PortalCapacityStore } from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  FundingPreflightError,
  runFundingPreflight,
} from "../../../../src/features/deposit/fundingPreflight"
import { seedBootConfig } from "../../../support/seedBootConfig"
import { mockLoadDepositFacts, tokenOption } from "../../../support/depositTokens"

const TOKEN = `0x${"ee".repeat(20)}` as Address
const SIPA = `0x${"ab".repeat(20)}` as Address
const HASH = `0x${"11".repeat(32)}` as Hex
const order = vi.hoisted(() => [] as string[])
/** Each wallet write: the contract called and its arguments. */
const writes = vi.hoisted(() => [] as { address: string; args: unknown[] }[])
const bridge = vi.hoisted(() => ({ active: false, submit: vi.fn() }))
const TX_AMOUNT_CAP = vi.hoisted(() => 5166n * 10n ** 18n)
const USDC = `0x${"a0".repeat(20)}` as Address
const USDT = `0x${"da".repeat(20)}` as Address

vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: `0x${"ee".repeat(20)}`, portal: `0x${"70".repeat(20)}` }),
  l1PublicClient: () => ({
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
}))
// The DAI row, with the USDC and USDT its SIPA swaps into DAI.
vi.mock("../../../../src/features/deposit/loadDepositFacts", (importOriginal) =>
  mockLoadDepositFacts(
    importOriginal,
    () => {
      const settlement = tokenOption("DAI", TOKEN)
      const options = [
        settlement,
        tokenOption("USDC", USDC, 6, TOKEN),
        tokenOption("USDT", USDT, 6, TOKEN),
      ]
      return { options, offered: options, settlement }
    },
    async () => ({
      fee: "0.5",
      token: TOKEN,
      sweepFeeAtomic: parseUnits("0.5", 18),
      txAmountCap: TX_AMOUNT_CAP,
    }),
  ),
)
vi.mock("../../../../src/platform/desktopBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/platform/desktopBridge")>()),
  isDesktopL1SubmitActive: () => bridge.active,
  submitViaDesktopBridge: bridge.submit,
}))
vi.mock("../../../../src/features/deposit/l1DepositTokenBalance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/deposit/l1DepositTokenBalance")>()),
  readL1DepositTokenBalance: async () => {
    order.push("balance")
    return { raw: 10n ** 30n }
  },
}))
vi.mock("../../../../src/features/deposit/l1Wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/deposit/l1Wallet")>()),
  getL1Clients: async () => ({
    account: `0x${"aa".repeat(20)}`,
    chain: {},
    walletClient: {
      writeContract: async (call: { functionName: string; address: string; args: unknown[] }) => {
        order.push(call.functionName)
        writes.push({ address: call.address, args: call.args })
        return `0x${"11".repeat(32)}`
      },
    },
  }),
}))

type Gateway = {
  tokenMeta: () => Promise<{ address: Address; symbol: string; decimals: number }>
  stampFunding: () => Promise<void>
  deposit: (params: Record<string, unknown>) => Promise<unknown>
}
let gateway: Gateway

beforeAll(async () => {
  await seedBootConfig()
  const { getSipaDepositGateway } = await import("../../../../src/features/deposit/sipaGateway")
  gateway = getSipaDepositGateway() as unknown as Gateway
  gateway.tokenMeta = async () => ({ address: TOKEN, symbol: "DAI", decimals: 18 })
  gateway.stampFunding = async () => {}
})

beforeEach(() => {
  order.length = 0
  writes.length = 0
  bridge.active = false
  bridge.submit.mockReset()
})

const send = (
  preflight: (fresh: { feeDisplay: string }) => Promise<void>,
  beforeApprove?: () => Promise<void>,
) =>
  gateway.deposit({
    target: { address: SIPA, name: "alice.oxide.eth" },
    amountDisplay: "2.5",
    from: `0x${"aa".repeat(20)}`,
    tokenSymbol: "DAI",
    preflight,
    beforeApprove,
  })

describe("sipaGateway deposit record", () => {
  it.each([
    ["records the wallet's own deposit", undefined, 1],
    ["records nothing for a payer funding someone else's address", false, 0],
  ] as const)("%s", async (_, record, stamps) => {
    const stamp = vi.fn(async () => {})
    gateway.stampFunding = stamp
    await gateway.deposit({
      target: { address: SIPA, name: "river" },
      amountDisplay: "2.5",
      from: `0x${"aa".repeat(20)}`,
      tokenSymbol: "DAI",
      preflight: async () => {},
      record,
    })
    expect(stamp).toHaveBeenCalledTimes(stamps)
    gateway.stampFunding = async () => {}
  })
})

describe("sipaGateway deposit preflight", () => {
  it("checks right before the wallet transfer, with the fee read for this send", async () => {
    const preflight = vi.fn(async (fresh: { feeDisplay: string }) => {
      order.push(`preflight:${fresh.feeDisplay}`)
    })
    await send(preflight)
    expect(order).toEqual(["balance", "balance", "preflight:0.5", "transfer"])
  })

  it("checks before the desktop hand-off, and hands the helper a recheck of the same kind", async () => {
    bridge.active = true
    const preflight = vi.fn(async () => {
      order.push("preflight")
    })
    const beforeApprove = vi.fn()
    bridge.submit.mockImplementation(
      async (submission: {
        recheck: () => Promise<void>
        display: { lines: [string, string][] }
      }) => {
        order.push("handoff")
        await submission.recheck()
        return HASH
      },
    )
    await send(preflight, beforeApprove)
    expect(order).toEqual(["balance", "preflight", "handoff", "preflight"])
    expect(preflight).toHaveBeenLastCalledWith({ feeDisplay: "0.5" })
    // The bridge client records the approval; the gateway only hands the caller's hook through.
    expect(bridge.submit.mock.calls[0]![0]).toMatchObject({ beforeApprove })
    const { display } = bridge.submit.mock.calls[0]![0] as {
      display: { lines: [string, string][] }
    }
    expect(display.lines.length).toBeLessThanOrEqual(10)
    expect(
      display.lines.every(([label, value]) => label.length <= 200 && value.length <= 200),
    ).toBe(true)
    expect(Object.fromEntries(display.lines)["Network capacity"]).toMatch(
      /doesn't reserve capacity/,
    )
  })
})

describe("sipaGateway deposit of USDT with the connected-deposit check", () => {
  const symbol = "USDT"
  const token = USDT
  const KEY = { chainId: 1, portal: `0x${"11".repeat(20)}`, token: TOKEN } as const
  const storeReading = (read: () => Promise<PortalCapacitySnapshot>) =>
    createPortalCapacityStore(KEY, {
      read,
      visibility: { isVisible: () => true, onResume: () => () => {} },
    })
  const unreadable = () =>
    storeReading(async () => {
      throw new Error("rpc down")
    })
  const empty = () =>
    storeReading(async () => ({
      ...KEY,
      decimals: 18,
      blockNumber: 1n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      rateAtomicPerSecond: 10n ** 18n,
      globalLimitAtomic: 50_000n * 10n ** 18n,
      availableAtomic: 0n,
      txAmountCapAtomic: TX_AMOUNT_CAP,
    }))
  // What the connected deposit form passes: a conversion credit is not known before the swap.
  const connectedCheck = (store?: PortalCapacityStore) => (fresh: { feeDisplay: string }) =>
    runFundingPreflight({
      store,
      required: { status: "unknown" },
      unknownCapacity: "proceed",
      shownFee: "0.5",
      freshFee: fresh.feeDisplay,
    })
  const sendStable = (preflight: (fresh: { feeDisplay: string }) => Promise<void>) =>
    gateway.deposit({
      target: { address: SIPA, name: "alice.oxide.eth" },
      amountDisplay: "2.5",
      from: `0x${"aa".repeat(20)}`,
      tokenSymbol: symbol,
      token: { address: token, decimals: 6, settlesIn: TOKEN },
      preflight,
      beforeApprove: async () => {},
    })

  it.each([
    ["cannot be read", unreadable],
    ["has no known bucket", () => undefined],
  ])("transfers from the connected wallet when capacity %s", async (_case, store) => {
    await sendStable(connectedCheck(store()))
    expect(order).toEqual(["balance", "balance", "transfer"])
    expect(writes).toEqual([{ address: token, args: [SIPA, parseUnits("2.5", 6)] }])
  })

  it("hands off to the desktop helper and passes its recheck when capacity cannot be read", async () => {
    bridge.active = true
    let recheck: Promise<void> | undefined
    bridge.submit.mockImplementation(
      async (submission: { recheck: () => Promise<void>; tx: { to: string } }) => {
        order.push(`handoff:${submission.tx.to}`)
        recheck = submission.recheck()
        await recheck
        return HASH
      },
    )
    await sendStable(connectedCheck(unreadable()))
    expect(order).toEqual(["balance", `handoff:${token}`])
    await expect(recheck).resolves.toBeUndefined()
  })

  it("requests no transfer against an empty bucket, on either path", async () => {
    await expect(sendStable(connectedCheck(empty()))).rejects.toBeInstanceOf(FundingPreflightError)
    expect(order).not.toContain("transfer")
    bridge.active = true
    await expect(sendStable(connectedCheck(empty()))).rejects.toBeInstanceOf(FundingPreflightError)
    expect(bridge.submit).not.toHaveBeenCalled()
  })
})

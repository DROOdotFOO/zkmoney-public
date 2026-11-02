import { memoryBackend } from "../../../src/engine/memoryBackend"
import { openDatabase } from "../../../src/engine/database"
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getAddress, type Hash, type Hex } from "viem"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import { planSwapOnWithdraw, type ScannedWithdrawEvent } from "@obsidion/sdk"
import { createWithdrawals, type Withdrawals } from "../../../src/engine/withdrawals"
import { rebuildWithdrawals } from "../../../src/core/services/bridge/withdrawalRescan"
import { swapEscrowTarget } from "../../../src/core/services/bridge/swapEscrowArgs"
import { withdrawalRecipients } from "../../../src/core/services/bridge/withdrawalRecipients"
import { savingsMoveOfWithdrawal } from "../../../src/oxide/savingsMoves"
import { syncCatchUp } from "../../../src/engine/catchUp"

const RECIPIENT = getAddress(`0x${"b0".repeat(20)}`)
const ESCROW = getAddress(`0x${"e5".repeat(20)}`)
const TIP = 10n ** 17n
const DIRECT_TX = `0x${"11".repeat(32)}` as Hash
const ESCROW_TX = `0x${"22".repeat(32)}` as Hash
const KNOWN_TX = `0x${"33".repeat(32)}` as Hash
const FACTORY = getAddress(`0x${"fa".repeat(20)}`)
const RECOVERY = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }
const NONCE = `0x${"77".repeat(32)}` as Hex
const DEPLOYMENT = {
  portal: `0x${"70".repeat(20)}` as Hex,
  l2Token: "0xl2",
}
const EXECUTOR = getAddress(`0x${"ec".repeat(20)}`)
const SWAPPED_EXECUTOR = getAddress(`0x${"ed".repeat(20)}`)

const EVENTS: ScannedWithdrawEvent[] = [
  {
    txHash: ESCROW_TX,
    blockNumber: 20,
    executor: EXECUTOR,
    withdrawalFee: 0n,
    l1Recipient: ESCROW,
    amount: 100n * 10n ** 18n,
    relayerTip: TIP,
  },
  {
    txHash: DIRECT_TX,
    blockNumber: 10,
    executor: EXECUTOR,
    withdrawalFee: 0n,
    l1Recipient: RECIPIENT,
    amount: 25n * 10n ** 17n,
    relayerTip: TIP,
  },
  {
    txHash: KNOWN_TX,
    blockNumber: 30,
    executor: EXECUTOR,
    withdrawalFee: 0n,
    l1Recipient: RECIPIENT,
    amount: 10n ** 18n,
    relayerTip: TIP,
  },
]

function makeSource(
  events = EVENTS,
  times: Record<number, number | undefined> = { 10: 1_000, 20: 2_000 },
) {
  return {
    headBlock: vi.fn(async () => 40),
    listWithdrawals: vi.fn(async () => events),
    blockTimestampMs: vi.fn(async (block: number) => times[block]),
  }
}

async function newStore(): Promise<Withdrawals> {
  const store = createWithdrawals({ db: openDatabase(memoryBackend()) })
  await store.ready
  return store
}

describe("rebuildWithdrawals", () => {
  it("joins an in-progress chain catch-up until its rows are written", async () => {
    const store = await newStore()
    let open!: () => void
    const gate = new Promise<number>((resolve) => (open = () => resolve(1_000)))
    const source = makeSource()
    source.blockTimestampMs.mockImplementation(() => gate)
    const endScan = syncCatchUp.begin()
    const rebuild = rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })
    await vi.waitFor(() => expect(source.blockTimestampMs).toHaveBeenCalled())
    endScan()
    expect(syncCatchUp.status.get()).toBe(true) // the rescan still holds it
    open()
    await rebuild
    expect(syncCatchUp.status.get()).toBe(false)

    // Without a catch-up in progress the rescan never starts one.
    await rebuildWithdrawals({
      networkId: "0xnet",
      source: makeSource(),
      store: await newStore(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })
    expect(syncCatchUp.status.get()).toBe(false)
  })

  it("creates a mined record per unknown burn, oldest first, and leaves stored ones alone", async () => {
    const store = await newStore()
    await store.create({
      networkId: "0xnet",
      localId: "known",
      l2TxHash: KNOWN_TX,
      recipient: RECIPIENT,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "done",
      startTime: 5,
    })
    const source = makeSource()

    const rebuilt = await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      deployment: DEPLOYMENT,
      now: () => 9_999,
    })

    expect(source.listWithdrawals).toHaveBeenCalledWith(1, 41)
    expect(rebuilt.map((r) => r.l2TxHash)).toEqual([DIRECT_TX, ESCROW_TX])
    expect([...(await store.all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(3)
    expect((await store.get("known"))?.phase).toBe("done")

    const direct = (await store.byHash(DIRECT_TX))!
    expect(direct).toMatchObject({
      phase: "l2_mined",
      blockNumber: 10,
      recipient: RECIPIENT,
      amount: "2.5",
      rawAmount: "2500000000000000000",
      relayerTip: TIP.toString(),
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      startTime: 1_000,
      deployment: { ...DEPLOYMENT, executor: EXECUTOR },
      rebuilt: true,
      recipientProvenance: "saved-recipient",
    })
    expect(direct.swapOutput).toBeUndefined()
    // A burn through an executor that takes no fee records none.
    expect(direct.withdrawalFee).toBeUndefined()
    expect(withdrawalRecipients(direct).viaEscrow).toBe(false)
  })

  it("stamps each rebuilt record with its own burn's executor and fee, over two executors on one portal", async () => {
    const store = await newStore()
    const [escrow, direct] = EVENTS
    const source = makeSource([
      { ...direct!, executor: EXECUTOR, withdrawalFee: TIP },
      { ...escrow!, executor: SWAPPED_EXECUTOR, withdrawalFee: 3n * TIP },
    ])

    await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      deployment: DEPLOYMENT,
    })

    expect(await store.byHash(DIRECT_TX)).toMatchObject({
      deployment: { ...DEPLOYMENT, executor: EXECUTOR },
      withdrawalFee: TIP.toString(),
    })
    expect(await store.byHash(ESCROW_TX)).toMatchObject({
      deployment: { ...DEPLOYMENT, executor: SWAPPED_EXECUTOR },
      withdrawalFee: (3n * TIP).toString(),
    })
  })

  it("stamps a stored record from before executor stamps with the executor its burn paid", async () => {
    const store = await newStore()
    await store.create({
      networkId: "0xnet",
      localId: "known",
      version: 1,
      l2TxHash: KNOWN_TX,
      recipient: RECIPIENT,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "awaiting_proven",
      startTime: 5,
      deployment: DEPLOYMENT,
    })
    const known = EVENTS.find((event) => event.txHash === KNOWN_TX)!
    const source = makeSource([{ ...known, executor: SWAPPED_EXECUTOR, withdrawalFee: TIP }])

    expect(
      await rebuildWithdrawals({
        networkId: "0xnet",
        source,
        store,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
      }),
    ).toEqual([])

    expect(await store.get("known")).toMatchObject({
      version: 2,
      phase: "awaiting_proven",
      deployment: { ...DEPLOYMENT, executor: SWAPPED_EXECUTOR },
      withdrawalFee: TIP.toString(),
    })
  })

  it("rebuilds a swap record from the escrow args of the burn's memo", async () => {
    const store = await newStore()
    const SWAP_TX = `0x${"44".repeat(32)}` as Hash
    const plan = planSwapOnWithdraw({
      swapEscrowFactoryV2: FACTORY,
      output: "USDC",
      l1Recipient: RECIPIENT,
      recovery: RECOVERY,
      amount: 100n * 10n ** 18n,
      withdrawalFee: 0n,
      withdrawalRelayerTip: 0n,
      proverTip: 0n,
      relayerTip: 5n * TIP,
      nonce: NONCE,
    })
    const swap = {
      output: "USDC" as const,
      recipient: RECIPIENT,
      factory: FACTORY,
      recoveryCommitment: plan.escrowArgs.recoveryCommitment,
      relayerTip: 5n * TIP,
      nonce: NONCE,
      daiForGas: 0n,
      minEthForGas: 0n,
    }
    const source = makeSource([
      { ...EVENTS[0]!, txHash: SWAP_TX, l1Recipient: plan.escrow, proverTip: 0n, swap },
    ])

    await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })

    const record = (await store.byHash(SWAP_TX))!
    expect(record).toMatchObject({
      phase: "l2_mined",
      recipient: RECIPIENT,
      swapOutput: "USDC",
      swapEscrow: plan.escrow,
      swapEscrowFactory: FACTORY,
      swapEscrowLayout: "v2",
      swapNonce: NONCE,
      swapRecoveryCommitment: plan.escrowArgs.recoveryCommitment,
      swapRelayerTip: (5n * TIP).toString(),
      rebuilt: true,
    })
    expect(withdrawalRecipients(record)).toEqual({
      release: plan.escrow,
      final: RECIPIENT,
      viaEscrow: true,
    })
    expect(swapEscrowTarget(record)).toEqual({
      factory: FACTORY,
      escrow: plan.escrow,
      layout: "v2",
      args: plan.escrowArgs,
    })
  })

  it("rebuilds a Sky move's args, and the move from them", async () => {
    const store = await newStore()
    const SKY_TX = `0x${"55".repeat(32)}` as Hash
    const sky = {
      route: SkyRoute.Unstake,
      factory: FACTORY,
      recipientCommitment: `0x${"2c".repeat(32)}` as Hex,
      recoveryCommitment: `0x${"4d".repeat(32)}` as Hex,
      relayerTip: TIP,
      nonce: NONCE,
    }
    const source = makeSource([
      { ...EVENTS[0]!, txHash: SKY_TX, amount: 6n * 10n ** 18n, proverTip: 0n, sky },
    ])
    const report = vi.fn()

    await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "sUSDS",
      tokenDecimals: 18,
      report,
    })

    const record = (await store.byHash(SKY_TX))!
    expect(record.skyMove).toEqual({
      direction: "out",
      factory: FACTORY,
      recipientCommitment: sky.recipientCommitment,
      recoveryCommitment: sky.recoveryCommitment,
      relayerTip: TIP.toString(),
      nonce: NONCE,
    })
    expect(savingsMoveOfWithdrawal(record)).toEqual({
      direction: "out",
      withdrawalLocalId: record.localId,
      escrow: ESCROW,
      factory: FACTORY,
      nonce: NONCE,
      recipientCommitment: sky.recipientCommitment,
      amount: (6n * 10n ** 18n).toString(),
    })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ savingsMoves: 1 }))
  })

  it("rebuilds an escrow burn without escrow args as a direct record naming the escrow", async () => {
    const store = await newStore()
    await rebuildWithdrawals({
      networkId: "0xnet",
      source: makeSource(),
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })

    const record = (await store.byHash(ESCROW_TX))!
    expect(record).toMatchObject({ phase: "l2_mined", recipient: ESCROW, startTime: 2_000 })
    expect(record.deployment).toBeUndefined()
    expect(record.swapOutput).toBeUndefined()
    expect(record.skyMove).toBeUndefined()
    expect(withdrawalRecipients(record)).toEqual({
      release: ESCROW,
      final: ESCROW,
      viaEscrow: false,
    })
  })

  it("rebuilds no move from a plain burn", async () => {
    const store = await newStore()
    await rebuildWithdrawals({
      networkId: "0xnet",
      source: makeSource(),
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
    })
    expect(savingsMoveOfWithdrawal((await store.byHash(DIRECT_TX))!)).toBeUndefined()
  })

  it("stamps the fallback time on a burn whose block cannot be read, and creates nothing twice", async () => {
    const store = await newStore()
    const source = makeSource(EVENTS, {})
    const report = vi.fn()
    const first = await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      now: () => 4_242,
      report,
    })
    expect(first.every((r) => r.startTime === 4_242 && r.startTimeEstimated)).toBe(true)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ tokenSymbol: "DAI", unknown: first.length, created: first }),
    )

    const again = await rebuildWithdrawals({
      networkId: "0xnet",
      source,
      store,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      now: () => 4_242,
    })
    expect(again).toEqual([])
    expect([...(await store.all())].sort((a, b) => b.startTime - a.startTime)).toHaveLength(3)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { AccountStorage } from "../../../src/core/storages/AccountStorage"
import { NetworkStorage } from "../../../src/core/storages/NetworkStorage"
import { createActivity, type Activity } from "../../../src/engine/activity"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { scannedRow } from "../../../src/core/services/transactions/TransferEventScanner"
import { createWithdrawals } from "../../../src/engine/withdrawals"
import {
  withdrawalStepper,
  type WithdrawalTrackerNode,
} from "../../../src/engine/withdrawalTracker"
import { SIPADepositStore } from "../../../src/core/services/deposits/SIPADepositStore"
import {
  REORG_MARGIN_MS,
  ReorgMonitor,
  type ConfirmationOutcome,
  type ReorgChain,
  type ReorgMonitorDeps,
} from "../../../src/core/services/coordination/ReorgMonitor"
import type { ReorgTxReceiptLike } from "../../../src/core/services/chain/receiptTypes"
import type { TokenInTxService } from "../../../src/types"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"

vi.mock("@aztec-labs/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec-labs/aztec.js/node")>()
  return { ...actual, createAztecNodeClient: vi.fn() }
})

const TX = "0x" + "ab".repeat(32)
const TX2 = "0x" + "cd".repeat(32)
const TX3 = "0x" + "ef".repeat(32)
const NET = "net-A"
/** The monitor's settle window for a withdrawal burn that reads dropped. */
const BURN_SETTLE_MS = 5 * 60_000

const sampleToken = (): TokenInTxService => ({
  name: "ETH",
  decimals: 18,
  logo: "https://example.com/eth.png",
  price: 1000,
  symbol: "ETH",
  address: "0xtoken",
  amount: 1,
  hasUnknownAmount: false,
})

const resetSingletons = () => {
  resetSingleton(AccountStorage as unknown as { instance: AccountStorage | null })
  resetSingleton(NetworkStorage as unknown as { instance: NetworkStorage | null })
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
}

let activity: Activity

/** Scripted node: per-hash receipt or "throw"; records call order. */
function makeNode() {
  const scripts = new Map<string, ReorgTxReceiptLike | "throw">()
  const calls: string[] = []
  return {
    script(txHash: string, entry: ReorgTxReceiptLike | "throw") {
      scripts.set(txHash.toLowerCase(), entry)
    },
    calls,
    node: {
      async getTxReceipt(txHash: string): Promise<ReorgTxReceiptLike> {
        calls.push(txHash.toLowerCase())
        const entry = scripts.get(txHash.toLowerCase())
        if (!entry || entry === "throw") throw new Error("rpc down / no script for " + txHash)
        return entry
      },
    },
  }
}

async function seedRow(
  txHash: string,
  opts: {
    status?: "pending" | "success" | "failed"
    blockNumber?: number
    blockHash?: string
    networkId?: string
  } = {},
) {
  const status = opts.status ?? "pending"
  await activity.insertPending({
    id: "q-" + txHash.slice(-4),
    action: "send",
    token: sampleToken(),
    amountAtomic: 0n,
    timestamp: Date.now(),
    status,
    txHash,
    to: "0xr",
    blockNumber: opts.blockNumber,
    blockHash: opts.blockHash,
    networkId: opts.networkId ?? NET,
    ...(status === "pending"
      ? {}
      : {
          detailedStatus: status === "success" ? QueueStatus.SUCCESS : QueueStatus.FAILED,
          endTime: 1111,
          progress: 100,
        }),
  })
}

async function rowByHash(txHash: string) {
  return (await activity.byHash(txHash))!
}

const setTier = async (txHash: string, tier: TxStatus) =>
  activity.apply((await rowByHash(txHash)).id, { type: "anchored", tier })

function setup() {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  activity = createActivity({ db: openDatabase(memoryBackend()) })
  const chain = makeNode()
  const outcomes: ConfirmationOutcome[] = []
  const deps: Deps = {
    node: chain.node,
    networkId: NET,
    transactionStorage: activity,
    onOutcome: (o) => outcomes.push(o),
  }
  return { adapter, chain, outcomes, deps }
}

type Deps = ReorgMonitorDeps & ReorgChain

/** A monitor whose passes read `deps`' chain. */
function monitorOver(deps: Deps) {
  const monitor = new ReorgMonitor(deps)
  return { runPass: () => monitor.runPass(deps) }
}

const runPass = (deps: Deps) => monitorOver(deps).runPass()

describe("ReorgMonitor.runPass", () => {
  beforeEach(() => resetSingletons())
  afterEach(() => vi.restoreAllMocks())

  it("confirmed payment dropped while app closed → failed on open, alert outcome", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "dropped" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("failed")
    expect(row.detailedStatus).toBe(QueueStatus.FAILED)
    expect(row.reorgEpoch).toBe(1)
    expect(summary).toMatchObject({ checked: 1, failed: 1, demoted: 0, reConfirmed: 0 })
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("a received payment that fails is flagged incoming", async () => {
    const { chain, outcomes, deps } = setup()
    await activity.record(
      scannedRow({
        amountAtomic: 0n,
        txHash: TX,
        from: "@alice",
        senderL2Address: "0xa11ce",
        to: "0xme",
        token: sampleToken(),
        timestamp: Date.now(),
        blockNumber: 42,
        networkId: NET,
      }),
    )
    chain.script(TX, { status: "dropped" })

    await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("failed")
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1, incoming: true }])
  })

  it("rows on a foreign network are untouched — no receipt fetch, no writes", async () => {
    const { chain, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, networkId: "net-B" })
    chain.script(TX, { status: "dropped" })

    const summary = await runPass({ ...deps, networkId: "net-A" })

    expect(chain.calls).toEqual([])
    expect(summary.checked).toBe(0)
    expect((await rowByHash(TX)).status).toBe("success")
  })

  it("previously-failed row found re-included → re-confirmed with anchor", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "failed" })
    chain.script(TX, {
      status: "proposed",
      blockNumber: 50,
      blockHash: "0xb50",
      executionResult: "success",
    })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("success")
    expect(row.blockNumber).toBe(50)
    expect(row.blockHash).toBe("0xb50")
    expect(row.tier).toBe("proposed")
    expect(summary.reConfirmed).toBe(1)
    expect(outcomes).toEqual([{ type: "re-confirmed", txHash: TX, hadAlerted: true }])
  })

  it("healthy confirmed rows are left unchanged", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    await setTier(TX, TxStatus.PROPOSED)
    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42" })
    const before = await rowByHash(TX)
    expect(before.tier).toBe(TxStatus.PROPOSED)

    const summary = await runPass(deps)

    expect(await rowByHash(TX)).toEqual(before)
    expect(summary).toMatchObject({ checked: 1, demoted: 0, failed: 0, reConfirmed: 0 })
    expect(outcomes).toEqual([])
  })

  it("confirmed row regressed to the mempool → demoted, grace window armed", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("pending")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.demoted).toBe(1)
    expect(outcomes).toEqual([{ type: "demoted", txHash: TX }])
  })

  it("confirmed row re-included at the same height with a new hash → demoted", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42b" })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("pending")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.demoted).toBe(1)
    expect(outcomes).toEqual([{ type: "demoted", txHash: TX }])
  })

  it("rows beyond the four surfaces (faucet, paylink-create) are reconciled", async () => {
    const { chain, deps } = setup()
    await activity.insertPending({
      id: TX,
      networkId: NET,
      action: "faucet",
      token: sampleToken(),
      amountAtomic: 0n,
      timestamp: Date.now(),
      status: "success",
      txHash: TX,
    })
    await activity.insertPending({
      id: TX2,
      networkId: NET,
      amountAtomic: 0n,
      timestamp: Date.now(),
      status: "success",
      txHash: TX2,
      action: "Pay To Email",
      emailPaymentAction: "Pay To Email",
      flavor: "direct",
    })

    chain.script(TX, { status: "dropped" })
    chain.script(TX2, { status: "dropped" })

    const summary = await runPass(deps)

    expect(summary.failed).toBe(2)
    expect((await rowByHash(TX)).status).toBe("failed")
    expect((await rowByHash(TX2)).status).toBe("failed")
  })

  it("reads settled rows within its margin, and pending rows at any age", async () => {
    const { chain, deps } = setup()
    const old = Date.now() - REORG_MARGIN_MS - 1
    for (const [id, txHash, status] of [
      ["old-settled", TX, "success"],
      ["old-pending", TX2, "pending"],
    ] as const) {
      await activity.insertPending({
        id,
        networkId: NET,
        action: "send",
        token: sampleToken(),
        amountAtomic: 0n,
        timestamp: old,
        status,
        txHash,
        to: "0xr",
      })
    }
    chain.script(TX, { status: "dropped" })
    chain.script(TX2, { status: "dropped" })

    await runPass(deps)

    expect(chain.calls).toEqual([TX2])
  })

  it("a throwing receipt lookup skips the row, leaving it unchanged", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42 })
    await seedRow(TX2, { status: "success", blockNumber: 43 })
    chain.script(TX, "throw")
    chain.script(TX2, { status: "dropped" })

    const summary = await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("success")
    expect((await rowByHash(TX2)).status).toBe("failed")
    expect(summary).toMatchObject({ checked: 2, failed: 1 })
    expect(outcomes).toEqual([{ type: "failed", txHash: TX2, reorgEpoch: 1 }])
  })

  it("finalized receipt marks the tier finalized and emits finalized; the row leaves the walk", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "finalized", blockNumber: 42, blockHash: "0xb42" })

    await runPass(deps)

    expect((await rowByHash(TX)).tier).toBe("finalized")
    expect(outcomes).toEqual([{ type: "finalized", txHash: TX }])

    // finalized rows are excluded from later walks — no more receipt reads
    chain.calls.length = 0
    await runPass(deps)
    expect(chain.calls).toEqual([])
  })

  it("reverted included receipt fails a confirmed row — never SUCCESS", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, {
      status: "proposed",
      blockNumber: 42,
      blockHash: "0xb42",
      executionResult: "reverted",
    })

    const summary = await runPass(deps)

    const row = await rowByHash(TX)
    expect(row.status).toBe("failed")
    expect(row.reorgEpoch).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.reConfirmed).toBe(0)
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("reverted finalized receipt fails the row — no SUCCESS write", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "pending" })
    chain.script(TX, { status: "finalized", blockNumber: 42, executionResult: "reverted" })

    await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("failed")
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("undefined executionResult never flips a failed row to SUCCESS (included or finalized)", async () => {
    const { chain, outcomes, deps } = setup()
    await seedRow(TX, { status: "failed" })
    await seedRow(TX2, { status: "failed" })
    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    chain.script(TX2, { status: "finalized", blockNumber: 51, blockHash: "0xb51" })

    const summary = await runPass(deps)

    expect((await rowByHash(TX)).status).toBe("failed")
    expect((await rowByHash(TX2)).status).toBe("failed")
    expect(summary.reConfirmed).toBe(0)
    expect(outcomes).toEqual([])
  })

  it("demote then re-inclusion inside grace re-confirms quietly across passes", async () => {
    const { chain, outcomes, deps } = setup()
    const monitor = monitorOver(deps)
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("pending")

    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    await monitor.runPass()

    const row = await rowByHash(TX)
    expect(row.status).toBe("success")
    expect(row.blockNumber).toBe(50)
    expect(row.reorgEpoch).toBe(1)
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "re-confirmed", txHash: TX, hadAlerted: false, reorgEpoch: 1 },
    ])
  })

  it("grace expiry alerts once, then a late re-inclusion issues the corrective", async () => {
    const { chain, outcomes, deps } = setup()
    let clock = 1_000
    const monitor = monitorOver({ ...deps, graceWindowMs: 500, now: () => clock })
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })

    await monitor.runPass() // demote; grace deadline = 1_500
    clock = 2_000
    await monitor.runPass() // still pending past deadline → grace-expired
    await monitor.runPass() // no duplicate alert
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "grace-expired", txHash: TX, reorgEpoch: 1 },
    ])
    expect((await rowByHash(TX)).status).toBe("pending")

    chain.script(TX, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("success")
    expect(outcomes.at(-1)).toEqual({
      type: "re-confirmed",
      txHash: TX,
      hadAlerted: true,
      reorgEpoch: 1,
    })
  })

  it("holds an in-flight row's first dropped reading for 10 seconds before failing it", async () => {
    const { chain, outcomes, deps } = setup()
    // Pending with a hash: stamped before the node received the tx, so the node reads it as dropped.
    await seedRow(TX)
    chain.script(TX, { status: "dropped" })
    let clock = 1_000_000
    const monitor = monitorOver({ ...deps, now: () => clock })

    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("pending")
    clock += 9_999
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("pending")
    expect(outcomes).toEqual([])

    clock += 1
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("failed")
    expect(outcomes).toEqual([{ type: "failed", txHash: TX, reorgEpoch: 1 }])
  })

  it("an in-flight row the node includes inside the settle window confirms and drops the window", async () => {
    const { chain, deps } = setup()
    await seedRow(TX)
    chain.script(TX, { status: "dropped" })
    let clock = 1_000_000
    const monitor = monitorOver({ ...deps, now: () => clock })
    await monitor.runPass()

    chain.script(TX, { status: "proposed", blockNumber: 42, blockHash: "0xb42" })
    clock += 5_000
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("success")
    // A later dropped reading is a fresh episode, not the tail of the settled one.
    chain.script(TX, { status: "dropped" })
    clock += 200_000
    await monitor.runPass()
    expect((await rowByHash(TX)).status).toBe("failed")
  })

  it("a demoted row whose receipt reads dropped terminal-fails with the alert", async () => {
    const { chain, outcomes, deps } = setup()
    const monitor = monitorOver(deps)
    await seedRow(TX, { status: "success", blockNumber: 42, blockHash: "0xb42" })
    chain.script(TX, { status: "pending" })
    await monitor.runPass()

    chain.script(TX, { status: "dropped" })
    await monitor.runPass()

    expect((await rowByHash(TX)).status).toBe("failed")
    // the failure stays inside the demote's episode: same epoch, so its alert id
    // dedupes against any grace-expired alert already minted for this reorg
    expect(outcomes).toEqual([
      { type: "demoted", txHash: TX },
      { type: "failed", txHash: TX, reorgEpoch: 1 },
    ])
  })

  it("withdrawal and SIPA records reconcile through their own demote paths", async () => {
    const { chain, outcomes, deps } = setup()
    const adapter = new InMemoryStorageAdapter()
    const withdrawals = createWithdrawals({ db: openDatabase(memoryBackend()) })
    await withdrawals.create({
      localId: "wdraw_1",
      networkId: NET,
      recipient: "0x" + "11".repeat(20),
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: 1,
    } as Parameters<typeof withdrawals.create>[0])
    await withdrawals.apply("wdraw_1", {
      type: "mined",
      l2TxHash: TX as `0x${string}`,
      blockNumber: 42,
      rawAmount: "1000",
    })

    const sipa = SIPADepositStore.get(adapter)
    await sipa.upsert(
      ("0x" + "22".repeat(20)) as `0x${string}`,
      { phase: "claimed", claimTxHash: TX2 },
      {
        recipientL2Address: "0xl2",
        messageSecret: "0x1",
        recipientHash: "0x2",
        recoveryAddress: "0x3",
        l1ChainId: 1,
        networkId: NET,
        amount: "1",
        tokenSymbol: "DAI",
        startTime: 1,
      },
    )

    chain.script(TX, { status: "dropped" }) // withdrawal burn dropped
    // SIPA claim re-included but reverted: gone from chain effect-wise, same undo as dropped
    chain.script(TX2, {
      status: "proposed",
      blockNumber: 60,
      blockHash: "0xb60",
      executionResult: "reverted",
    })

    let clock = 1_000_000
    const monitor = monitorOver({
      ...deps,
      withdrawalStorage: withdrawals,
      sipaDepositStore: sipa,
      now: () => clock,
    })
    const first = await monitor.runPass()

    expect((await withdrawals.get("wdraw_1"))?.phase).toBe("l2_mined") // first look only
    expect(sipa.get(("0x" + "22".repeat(20)) as `0x${string}`)?.phase).toBe("pendingClaim")
    expect(first).toMatchObject({ failed: 0, demoted: 1 }) // SIPA

    clock += BURN_SETTLE_MS
    const second = await monitor.runPass()

    expect((await withdrawals.get("wdraw_1"))?.phase).toBe("failed")
    expect(second?.failed).toBe(1) // the burn
    expect(outcomes).toContainEqual({
      type: "failed",
      txHash: TX,
      reorgEpoch: 1,
      source: "withdrawal",
    })
  })
})

describe("ReorgMonitor withdrawal burns", () => {
  beforeEach(() => resetSingletons())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Below the field modulus, so the tracker can parse it. */
  const BURN = `0x${"11".repeat(32)}` as const
  const DROPPED = { code: "withdrawal.reorged" }
  const INCLUDED: ReorgTxReceiptLike = {
    status: "proposed",
    blockNumber: 50,
    blockHash: "0xb50",
    executionResult: "success",
  }

  /** One mined withdrawal and a monitor over it on a hand-driven clock. */
  async function setupWithdrawal(opts: { networkId?: string } = {}) {
    const base = setup()
    const withdrawals = createWithdrawals({ db: openDatabase(memoryBackend()) })
    await withdrawals.create({
      localId: "wdraw_1",
      recipient: "0x" + "11".repeat(20),
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: 1,
      networkId: opts.networkId ?? NET,
    } as Parameters<typeof withdrawals.create>[0])
    await withdrawals.apply("wdraw_1", {
      type: "mined",
      l2TxHash: BURN,
      blockNumber: 42,
      rawAmount: "1000",
    })
    const clock = { now: 1_000_000 }
    const deps: Deps = {
      ...base.deps,
      withdrawalStorage: withdrawals,
      now: () => clock.now,
    }
    const record = async () => (await withdrawals.get("wdraw_1"))!
    return { ...base, deps, withdrawals, clock, record, monitor: monitorOver(deps) }
  }

  it("a first dropped answer leaves the withdrawal tracking", async () => {
    const { chain, outcomes, monitor, record } = await setupWithdrawal()
    chain.script(BURN, { status: "dropped" })

    const summary = await monitor.runPass()

    expect((await record()).phase).toBe("l2_mined")
    expect((await record()).reorgEpoch).toBeUndefined()
    expect(summary?.failed).toBe(0)
    expect(outcomes).toEqual([])
  })

  it.each(["l2_mined", "awaiting_proven", "finalizing_l1"] as const)(
    "a burn at %s still dropped a settle window later fails",
    async (phase) => {
      const { chain, outcomes, monitor, withdrawals, clock, record } = await setupWithdrawal()
      await withdrawals.apply("wdraw_1", { type: "patch", fields: { phase } })
      chain.script(BURN, { status: "dropped" })

      await monitor.runPass()
      clock.now += BURN_SETTLE_MS - 1
      await monitor.runPass()
      expect((await record()).phase).toBe(phase)

      clock.now += 1
      const summary = await monitor.runPass()

      expect(await record()).toMatchObject({
        phase: "failed",
        droppedBurn: true,
        reorgEpoch: 1,
        failure: DROPPED,
      })
      expect(summary?.failed).toBe(1)
      expect(outcomes).toEqual([
        { type: "failed", txHash: BURN, reorgEpoch: 1, source: "withdrawal" },
      ])
    },
  )

  it("the settle window spans monitor instances", async () => {
    const { chain, deps, clock, record } = await setupWithdrawal()
    chain.script(BURN, { status: "dropped" })

    await monitorOver(deps).runPass()
    clock.now += BURN_SETTLE_MS - 1
    await monitorOver(deps).runPass()
    expect((await record()).phase).toBe("l2_mined")

    clock.now += 1
    await monitorOver(deps).runPass()

    expect((await record()).phase).toBe("failed")
  })

  it("a receipt read that throws is not a look", async () => {
    const { chain, outcomes, monitor, clock, record } = await setupWithdrawal()
    await monitor.runPass() // nothing scripted: the read throws

    chain.script(BURN, { status: "dropped" })
    clock.now += BURN_SETTLE_MS
    await monitor.runPass()

    expect((await record()).phase).toBe("l2_mined")
    expect(outcomes).toEqual([])
  })

  it("an included answer inside the window clears the pending failure", async () => {
    const { chain, outcomes, monitor, clock, record } = await setupWithdrawal()
    chain.script(BURN, { status: "dropped" })
    await monitor.runPass()

    chain.script(BURN, INCLUDED)
    clock.now += 30_000
    await monitor.runPass()

    // Past the first window: this dropped answer opens a new one.
    chain.script(BURN, { status: "dropped" })
    clock.now += BURN_SETTLE_MS
    await monitor.runPass()

    expect((await record()).phase).toBe("l2_mined")
    expect(outcomes).toEqual([])
  })

  it("a pending answer inside the window clears the pending failure", async () => {
    const { chain, outcomes, monitor, clock, record } = await setupWithdrawal()
    chain.script(BURN, { status: "dropped" })
    await monitor.runPass()

    chain.script(BURN, { status: "pending" })
    clock.now += 30_000
    await monitor.runPass()

    chain.script(BURN, { status: "dropped" })
    clock.now += BURN_SETTLE_MS
    await monitor.runPass()

    expect((await record()).phase).toBe("l2_mined")
    expect(outcomes).toEqual([{ type: "demoted", txHash: BURN }])
  })

  it("a reverted inclusion fails at once", async () => {
    const { chain, outcomes, monitor, record } = await setupWithdrawal()
    chain.script(BURN, { ...INCLUDED, executionResult: "reverted" })

    const summary = await monitor.runPass()

    expect(await record()).toMatchObject({ phase: "failed", droppedBurn: true, failure: DROPPED })
    expect(summary?.failed).toBe(1)
    expect(outcomes).toEqual([
      { type: "failed", txHash: BURN, reorgEpoch: 1, source: "withdrawal" },
    ])
  })

  it.each(["proposed", "checkpointed", "proven", "finalized"] as const)(
    "a dropped-burn failure whose burn reads %s and succeeded returns to l2_mined",
    async (status) => {
      const { chain, outcomes, monitor, withdrawals, record } = await setupWithdrawal()
      await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
      chain.script(BURN, { ...INCLUDED, status })
      const before = Date.now()

      const summary = await monitor.runPass()

      expect((await record()).phase).toBe("l2_mined")
      expect((await record()).reorgEpoch).toBe(2)
      expect((await record()).phaseEnteredAt).toBeGreaterThanOrEqual(before)
      expect((await record()).endTime).toBeUndefined()
      expect((await record()).failure).toBeUndefined()
      expect((await record()).droppedBurn).toBeUndefined()
      expect(summary?.reConfirmed).toBe(1)
      // the corrective carries the failure's epoch, pairing it with the alert it answers
      expect(outcomes).toEqual([
        {
          type: "re-confirmed",
          txHash: BURN,
          hadAlerted: true,
          reorgEpoch: 1,
          source: "withdrawal",
        },
      ])
    },
  )

  it("a revived withdrawal gets two looks again", async () => {
    const { chain, monitor, clock, record } = await setupWithdrawal()
    chain.script(BURN, { status: "dropped" })
    await monitor.runPass()
    clock.now += BURN_SETTLE_MS
    await monitor.runPass()
    expect((await record()).phase).toBe("failed")

    chain.script(BURN, INCLUDED)
    await monitor.runPass()
    expect((await record()).phase).toBe("l2_mined")

    chain.script(BURN, { status: "dropped" })
    clock.now += 30_000
    await monitor.runPass()

    expect((await record()).phase).toBe("l2_mined")
  })

  it("a dropped-burn failure that still reads dropped stays failed and quiet", async () => {
    const { chain, outcomes, monitor, withdrawals, clock, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, { status: "dropped" })

    await monitor.runPass()
    clock.now += BURN_SETTLE_MS
    const summary = await monitor.runPass()

    expect(await record()).toMatchObject({ phase: "failed", droppedBurn: true, reorgEpoch: 1 })
    expect(summary).toMatchObject({ failed: 0, reConfirmed: 0 })
    expect(outcomes).toEqual([])
  })

  it.each([
    ["reverted", { ...INCLUDED, executionResult: "reverted" }],
    ["pending", { status: "pending", executionResult: "success" }],
  ] as const)("a %s receipt does not revive a dropped-burn failure", async (_, receipt) => {
    const { chain, outcomes, monitor, withdrawals, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, receipt)

    await monitor.runPass()

    expect(await record()).toMatchObject({ phase: "failed", droppedBurn: true, reorgEpoch: 1 })
    expect(outcomes).toEqual([])
  })

  it("a revival the store refuses raises nothing", async () => {
    const { chain, outcomes, deps, withdrawals } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, INCLUDED)
    const refusing: ReorgMonitorDeps["withdrawalStorage"] = {
      all: withdrawals.all,
      apply: async (key, event) =>
        event.type === "revived" ? undefined : withdrawals.apply(key, event),
    }

    const summary = await monitorOver({ ...deps, withdrawalStorage: refusing }).runPass()

    expect(summary?.reConfirmed).toBe(0)
    expect(outcomes).toEqual([])
  })

  it.each([
    ["dropped", { status: "dropped" }],
    ["reverted", { ...INCLUDED, executionResult: "reverted" }],
    ["pending", { status: "pending" }],
  ] as const)("a released withdrawal whose burn reads %s raises nothing", async (_, receipt) => {
    const { chain, outcomes, monitor, withdrawals, clock, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", { type: "patch", fields: { phase: "swapping" } })
    const released = await record()
    chain.script(BURN, receipt)

    await monitor.runPass()
    clock.now += BURN_SETTLE_MS
    const summary = await monitor.runPass()

    expect(await record()).toEqual(released)
    expect(summary).toMatchObject({ failed: 0, demoted: 0 })
    expect(outcomes).toEqual([])
  })

  it("a failure that was not a dropped burn is never revived", async () => {
    const { chain, outcomes, monitor, withdrawals, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", {
      type: "patch",
      fields: { phase: "failed", failure: { code: "withdrawal.failed" } },
    })
    chain.script(BURN, INCLUDED)

    await monitor.runPass()

    expect(await record()).toMatchObject({
      phase: "failed",
      failure: { code: "withdrawal.failed" },
    })
    expect(chain.calls).toEqual([])
    expect(outcomes).toEqual([])
  })

  it("an included answer without executionResult does not revive", async () => {
    const { chain, outcomes, monitor, withdrawals, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, { status: "proposed", blockNumber: 50, blockHash: "0xb50" })

    const summary = await monitor.runPass()

    expect(await record()).toMatchObject({ phase: "failed", droppedBurn: true, reorgEpoch: 1 })
    expect(summary?.reConfirmed).toBe(0)
    expect(outcomes).toEqual([])
  })

  it("a live withdrawal on another network is skipped", async () => {
    const { chain, deps, clock, record } = await setupWithdrawal({ networkId: "net-B" })
    chain.script(BURN, { status: "dropped" })
    const monitor = monitorOver({ ...deps, networkId: "net-A" })

    await monitor.runPass()
    clock.now += BURN_SETTLE_MS
    await monitor.runPass()

    expect(chain.calls).toEqual([])
    expect((await record()).phase).toBe("l2_mined")
  })

  it("a dropped-burn failure on another network is skipped", async () => {
    const { chain, deps, withdrawals, record } = await setupWithdrawal({ networkId: "net-B" })
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, INCLUDED)

    await monitorOver({ ...deps, networkId: "net-A" }).runPass()

    expect(chain.calls).toEqual([])
    expect((await record()).phase).toBe("failed")
  })

  it("a revived withdrawal advances on the tracker's next tick", async () => {
    const { chain, monitor, withdrawals, record } = await setupWithdrawal()
    await withdrawals.apply("wdraw_1", {
      type: "patch",
      fields: {
        phase: "l2_mined",
        withdrawalId: `0x${"77".repeat(32)}`,
      },
    })
    await withdrawals.apply("wdraw_1", { type: "demoted", droppedBurn: true })
    chain.script(BURN, INCLUDED)
    const pass = withdrawalStepper(withdrawals, {
      node: { getTxReceipt: async () => INCLUDED } as unknown as WithdrawalTrackerNode,
      finalizationReader: { isSpent: async () => false, resolveL1TxHash: async () => undefined },
      deployment: { portal: `0x${"aa".repeat(20)}`, l2Token: `0x${"bb".repeat(32)}` },
    })
    await pass() // while the only record is failed

    await monitor.runPass()
    void pass()

    await vi.waitFor(async () =>
      expect(await record()).toMatchObject({ phase: "awaiting_proven", reorgEpoch: 2 }),
    )
  })
})

/**
 * The withdrawal tracker — the chain-watching lifecycle. The relayer is
 * headless (no status endpoint), so the tracker only OBSERVES: lazily derive
 * `withdrawalId`, poll the L2 receipt to proven-or-later, then poll the injected
 * finalization reader's authoritative `isSpent` to `done`.
 * The burn's withdrawal ids come from an injected fake of `fetchWithdrawalIds`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec-labs/stdlib/tx"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import type { Address, Hex } from "viem"
import type { SwapEscrowReader, WithdrawalFinalizationReader } from "@obsidion/sdk"

import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import type { ResourceState } from "../../src/engine/resource"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import { createWithdrawals, type Withdrawals } from "../../src/engine/withdrawals"
import {
  revivePendingWithdrawal,
  trackWithdrawalSubmission,
  withdrawalStepper,
  withdrawalTracker,
  type TrackerRails,
  type TrackerWiring,
  type WithdrawalTrackerNode,
} from "../../src/engine/withdrawalTracker"
import {
  WITHDRAWAL_DELAYED_THRESHOLD_MS,
  SWAP_STUCK_THRESHOLD_MS,
  canRecoverSwap,
  canSelfExecuteSwap,
  canSelfFinalizeWithdrawal,
  isWithdrawalDelayed,
} from "../../src/core/services/bridge/withdrawalPhases"
import type { WithdrawalDeployment, WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { OnNetwork } from "../../src/types/networkStamp"

const mockFetch = vi.fn()

const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address
const L2TX_1 = ("0x" + "11".repeat(32)) as Hex
const L2TX_2 = ("0x" + "22".repeat(32)) as Hex
const WID_1 = ("0x" + "ab".repeat(32)) as Hex
const WID_2 = ("0x" + "cd".repeat(32)) as Hex
const L1TX = ("0x" + "ef".repeat(32)) as Hex

const DEPLOYMENT: WithdrawalDeployment = {
  portal: ("0x" + "aa".repeat(20)) as Hex,
  // Parsed as an AztecAddress, so it must sit below the field modulus.
  l2Token: "0x" + "0b".repeat(32),
}

/** The tracker's pass over `store`, on the live deployment unless given; each `syncOnce` runs one. */
function stepper({
  store,
  now,
  ...wiring
}: Omit<TrackerWiring, "deployment"> & {
  deployment?: WithdrawalDeployment
  store: Withdrawals
  now?: () => number
}) {
  const full = { deployment: DEPLOYMENT, withdrawalIds: mockFetch, ...wiring }
  return { syncOnce: withdrawalStepper(store, full, now) }
}

/** Withdrawal-id per burn tx so the two-identical-withdrawals test can disambiguate. */
function widForTx(l2TxHash: string): Hex {
  return l2TxHash.toLowerCase() === L2TX_1 ? WID_1 : WID_2
}

/** fetchWithdrawalIds stub: derives the mapped id from the passed TxHash. */
function stubDerivation() {
  mockFetch.mockImplementation(async (_node: unknown, txHash: { toString(): string }) => [
    { withdrawalId: { toString: () => widForTx(txHash.toString()) } },
  ])
}

function makeReader(
  overrides: Partial<WithdrawalFinalizationReader> = {},
): WithdrawalFinalizationReader {
  return {
    isSpent: vi.fn(async () => false),
    resolveL1TxHash: vi.fn(async () => undefined),
    ...overrides,
  }
}

const ESCROW = `0x${"e5".repeat(20)}` as Address
const FACTORY = `0x${"fa".repeat(20)}` as Address
const EXEC_TX = ("0x" + "5e".repeat(32)) as Hex

/** A funded escrow whose swap fills: the state right after the release. */
function makeEscrowReader(overrides: Partial<SwapEscrowReader> = {}): SwapEscrowReader {
  return {
    daiBalance: vi.fn(async () => 95n * 10n ** 18n),
    isDeployed: vi.fn(async () => false),
    deploySimulates: vi.fn(async () => true),
    executedTxHash: vi.fn(async () => undefined),
    recoveredTxHash: vi.fn(async () => undefined),
    ...overrides,
  }
}

function swapFields(): Partial<WithdrawalRecord> {
  return {
    swapOutput: "USDC",
    swapEscrow: ESCROW,
    swapEscrowFactory: FACTORY,
    swapNonce: ("0x" + "77".repeat(32)) as Hex,
    swapRecoveryCommitment: `0x${"5a".repeat(32)}` as Hex,
    swapRelayerTip: "5000000000000000000",
  }
}

function makeNode(status: TxStatus = TxStatus.PENDING): WithdrawalTrackerNode {
  return { getTxReceipt: vi.fn(async () => ({ status })) } as unknown as WithdrawalTrackerNode
}

async function seedStore(): Promise<Withdrawals> {
  const store = createWithdrawals({ db: openDatabase(memoryBackend()) })
  await store.ready
  return store
}

function submittingRecord(localId: string): OnNetwork<WithdrawalRecord> {
  return {
    localId,
    networkId: "0xnet",
    recipient: RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "1.0",
    tokenSymbol: "DAI",
    phase: "submitting",
    startTime: 1_700_000_000_000,
  }
}

describe("withdrawal tracker (chain-watching)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockFetch.mockReset()
    stubDerivation()
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe("happy path", () => {
    it.each([TxStatus.DROPPED, TxStatus.PROVEN])(
      "recovers a terminal unsuccessful paylink receipt %s without waiting for a burn log",
      async (status) => {
        const store = await seedStore()
        await store.create({ ...submittingRecord("w1"), source: "paylink", l2TxHash: L2TX_1 })
        const node = makeNode(status)
        vi.mocked(node.getTxReceipt).mockResolvedValue({
          status,
          executionResult: TxExecutionResult.REVERTED,
        } as never)
        const tracker = stepper({ store, node, finalizationReader: makeReader() })
        const active = trackWithdrawalSubmission(store, "w1", "operation")
        try {
          await tracker.syncOnce()
          expect(node.getTxReceipt).not.toHaveBeenCalled()
          expect((await store.get("w1"))?.phase).toBe("submitting")
        } finally {
          await active.stop()
        }
        await tracker.syncOnce()
        expect((await store.get("w1"))?.phase).toBe("failed")
        expect(mockFetch).not.toHaveBeenCalled()
      },
    )

    it("recovers a broadcast burn after the sender loses its receipt", async () => {
      const store = await seedStore()
      await store.create({
        ...submittingRecord("w1"),
        l2TxHash: L2TX_1,
        rawAmount: "1000000",
        relayerTip: "100",
      })
      const node = makeNode(TxStatus.PROVEN)
      vi.mocked(node.getTxReceipt).mockResolvedValue({
        status: TxStatus.PROVEN,
        blockNumber: 100,
      } as never)
      const tracker = stepper({ store, node, finalizationReader: makeReader() })
      mockFetch.mockResolvedValueOnce([])
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("submitting")
      await tracker.syncOnce()
      expect(await store.get("w1")).toMatchObject({
        phase: "finalizing_l1",
        blockNumber: 100,
        rawAmount: "1000000",
        relayerTip: "100",
        withdrawalId: WID_1,
      })
    })

    it("one pass derives, sees the burn proven and released, and reaches done with the L1 link", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
      })
      const node = makeNode(TxStatus.PROVEN)
      const tracker = stepper({ store, node, finalizationReader: reader })

      expect((await store.get("w1"))?.phase).toBe("l2_mined")

      await tracker.syncOnce()
      const done = (await store.get("w1"))!
      expect(done.withdrawalId).toBe(WID_1)
      expect(done.phase).toBe("done")
      expect(done.l1TxHash).toBe(L1TX)
      expect(done.endTime).toBeGreaterThan(0)
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1)
    })

    it("looks the release tx up by withdrawalId alone, whatever the burn paid or netted", async () => {
      // The portal's `WithdrawalOrRefund` log carries the withdrawalId as its nullifier, so neither
      // the escrow a swap burn paid nor the net the portal released keys the lookup.
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), ...swapFields() })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
        relayerTip: "100000",
      })

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
      })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
      })
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect((await store.get("w1"))?.l1TxHash).toBe(L1TX)
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1)
    })

    it("searches for the release from the burn's time and records what arrived", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
        receivedIn: vi.fn(async () => 925_000n),
      })
      const l1BlockAt = vi.fn(async () => 12_345n)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        l1BlockAt,
      })
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect(l1BlockAt).toHaveBeenCalledWith((await store.get("w1"))!.startTime)
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1, { fromBlock: 12_345n })
      expect(reader.receivedIn).toHaveBeenCalledWith(L1TX, RECIPIENT)
      expect((await store.get("w1"))?.receivedAmount).toBe("925000")
    })

    it("keeps the reader's look-back for a rebuilt record whose start time is the rebuild's clock", async () => {
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), rebuilt: true, startTimeEstimated: true })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => L1TX),
      })
      const l1BlockAt = vi.fn(async () => 12_345n)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
        l1BlockAt,
      })
      await tracker.syncOnce()
      await tracker.syncOnce()
      expect(l1BlockAt).not.toHaveBeenCalled()
      expect(reader.resolveL1TxHash).toHaveBeenCalledWith(WID_1)
      expect(await store.get("w1")).toMatchObject({ phase: "done", l1TxHash: L1TX })
    })
  })

  describe("per-deployment bindings", () => {
    it("a record stamped with a retired portal derives and polls against that portal, not the live one", async () => {
      const store = await seedStore()
      const retired = {
        portal: ("0x" + "cc".repeat(20)) as Hex,
        l2Token: "0x" + "0e".repeat(32),
      }
      await store.create({ ...submittingRecord("w1"), deployment: retired })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })

      const liveReader = makeReader()
      const retiredReader = makeReader({ isSpent: vi.fn(async () => true) })
      const readerForDeployment = vi.fn(() => retiredReader)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: liveReader,
        readerForDeployment,
      })

      await tracker.syncOnce()
      await tracker.syncOnce()

      expect((await store.get("w1"))?.phase).toBe("done")
      expect(mockFetch.mock.calls[0]![2].toString()).toBe(retired.l2Token)
      expect(readerForDeployment).toHaveBeenCalledWith(retired)
      expect(retiredReader.isSpent).toHaveBeenCalled()
      expect(liveReader.isSpent).not.toHaveBeenCalled()
    })

    it("a record stamped with the live portal keeps the boot-time reader", async () => {
      const store = await seedStore()
      await store.create({
        ...submittingRecord("w1"),
        deployment: DEPLOYMENT,
      })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      const liveReader = makeReader({ isSpent: vi.fn(async () => true) })
      const readerForDeployment = vi.fn(() => makeReader())
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: liveReader,
        readerForDeployment,
      })
      await tracker.syncOnce()
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
      expect(readerForDeployment).not.toHaveBeenCalled()
    })
  })

  describe("lazy withdrawalId derivation", () => {
    it("a missing-effect throw leaves the record armed at l2_mined; a later tick derives and completes", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => undefined),
      })
      const node = makeNode(TxStatus.PROVEN)
      const tracker = stepper({ store, node, finalizationReader: reader })

      // Tick 1: derivation throws (burn effect not yet indexed) → deferred, not failed.
      mockFetch.mockRejectedValueOnce(new Error("Tx effect not found for hash 0x…"))
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("l2_mined")
      expect((await store.get("w1"))?.withdrawalId).toBeUndefined()
      expect(node.getTxReceipt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()

      // Tick 2: derivation succeeds, and the proven, spent burn reaches done.
      await tracker.syncOnce()
      expect((await store.get("w1"))?.withdrawalId).toBe(WID_1)
      expect((await store.get("w1"))?.phase).toBe("done")
    })
  })

  describe("proven-or-finalized predicate", () => {
    it("advances an awaiting_proven record whose receipt returns finalized (skipped past proven)", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "awaiting_proven", withdrawalId: WID_1 },
      })

      const node = makeNode(TxStatus.FINALIZED)
      const tracker = stepper({ store, node, finalizationReader: makeReader() })

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("finalizing_l1")
    })
  })

  describe("reorg demote", () => {
    it("a demoted record re-advances: the tracker threads the record's epoch through its writes", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "awaiting_proven", withdrawalId: WID_1 },
      })
      await store.apply("w1", { type: "demoted" }) // → l2_mined, epoch 1

      const node = makeNode(TxStatus.FINALIZED)
      const tracker = stepper({
        store,
        node,
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
      })
      await tracker.syncOnce()

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("w1"))?.reorgEpoch).toBe(1)
    })
  })

  describe("delayed presentation (derived, non-terminal)", () => {
    it("flags a post-mine record past the threshold in any post-mine phase, never pre-mine/terminal", () => {
      const now = 10_000_000_000
      const past = now - WITHDRAWAL_DELAYED_THRESHOLD_MS - 1
      const recent = now - 60_000

      const base = submittingRecord("w1")
      for (const phase of ["l2_mined", "awaiting_proven", "finalizing_l1"] as const) {
        expect(isWithdrawalDelayed({ ...base, phase, phaseEnteredAt: past }, now)).toBe(true)
        expect(isWithdrawalDelayed({ ...base, phase, phaseEnteredAt: recent }, now)).toBe(false)
      }
      expect(isWithdrawalDelayed({ ...base, phase: "submitting" }, now)).toBe(false)
      expect(isWithdrawalDelayed({ ...base, phase: "done", phaseEnteredAt: past }, now)).toBe(false)
      expect(isWithdrawalDelayed({ ...base, phase: "failed", phaseEnteredAt: past }, now)).toBe(
        false,
      )
    })

    it("offers the manual finalize only to a delayed finalizing_l1 burn nothing has been sent for", () => {
      const now = 10_000_000_000
      const stuck: WithdrawalRecord = {
        ...submittingRecord("w1"),
        phase: "finalizing_l1",
        phaseEnteredAt: now - WITHDRAWAL_DELAYED_THRESHOLD_MS - 1,
        l2TxHash: L2TX_1,
        withdrawalId: WID_1,
      }
      expect(canSelfFinalizeWithdrawal(stuck, now)).toBe(true)

      // Still finalizing normally: the relayer's window has not run out.
      expect(canSelfFinalizeWithdrawal({ ...stuck, phaseEnteredAt: now - 60_000 }, now)).toBe(false)
      // The L2 leg is not done, so there is nothing on L1 to push through yet.
      expect(canSelfFinalizeWithdrawal({ ...stuck, phase: "awaiting_proven" }, now)).toBe(false)
      // Everything the call re-derives comes from the burn tx hash.
      expect(canSelfFinalizeWithdrawal({ ...stuck, l2TxHash: undefined }, now)).toBe(false)
      // One is already in flight.
      expect(canSelfFinalizeWithdrawal({ ...stuck, finalizeTxHash: L1TX }, now)).toBe(false)
    })

    it("a stalled finalizing_l1 record (isSpent never true) stays non-terminal — never failed, its delay timed from its first pass", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "finalizing_l1", withdrawalId: WID_1 },
      })

      const reader = makeReader({ isSpent: vi.fn(async () => false) })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
      })

      expect((await store.get("w1"))?.phaseEnteredAt).toBeUndefined()
      for (let i = 0; i < 5; i++) await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("finalizing_l1")
      expect((await store.get("w1"))?.phaseEnteredAt).toBeGreaterThan(0)
      expect(reader.isSpent).toHaveBeenCalled()
    })
  })

  describe("pre-mine records", () => {
    // A burn whose tab closed after submit has only its stored hash; the tracker settles it.
    it("fails a submitted wallet withdrawal whose receipt says dropped", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", { type: "patch", fields: { phase: "submitting", l2TxHash: L2TX_1 } })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.DROPPED),
        finalizationReader: makeReader(),
      })
      await tracker.syncOnce()

      expect(await store.get("w1")).toMatchObject({
        phase: "failed",
        failure: { code: "withdrawal.dropped" },
      })
    })

    it("keeps a submitted wallet withdrawal pending while the node has no verdict", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", { type: "patch", fields: { phase: "submitting", l2TxHash: L2TX_1 } })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PENDING),
        finalizationReader: makeReader(),
      })
      await tracker.syncOnce()

      expect((await store.get("w1"))?.phase).toBe("submitting")
    })

    it("never touches a submitting record (no l2TxHash) — failed is a pre-mine local concern", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))

      const node = makeNode(TxStatus.PROVEN)
      const tracker = stepper({ store, node, finalizationReader: makeReader() })
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect((await store.get("w1"))?.phase).toBe("submitting")
      expect(mockFetch).not.toHaveBeenCalled()
      expect(node.getTxReceipt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })

  describe("two identical (recipient, amount) withdrawals", () => {
    it("each binds its own withdrawalId; isSpent advances exactly one; links don't cross", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.create(submittingRecord("w2"))
      await store.apply("w2", {
        type: "mined",
        l2TxHash: L2TX_2,
        blockNumber: 100,
        rawAmount: "1000000",
      })

      const reader = makeReader({
        isSpent: vi.fn(async (id: Hex) => id.toLowerCase() === WID_1),
        resolveL1TxHash: vi.fn(async (id: Hex) => (id.toLowerCase() === WID_1 ? L1TX : undefined)),
      })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
      })
      await tracker.syncOnce()

      // Tick 1: both derive + advance to finalizing_l1. Tick 2: only w1 is spent.
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect((await store.get("w1"))?.withdrawalId).toBe(WID_1)
      expect((await store.get("w2"))?.withdrawalId).toBe(WID_2)
      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("w1"))?.l1TxHash).toBe(L1TX)
      expect((await store.get("w2"))?.phase).toBe("finalizing_l1")
      expect((await store.get("w2"))?.l1TxHash).toBeUndefined()
    })
  })

  describe("a pass", () => {
    it("drives non-terminal records forward, and never regresses a done record", async () => {
      const store = await seedStore()
      // A terminal done, a non-terminal finalizing_l1, and a pre-mine submitting.
      await store.create(submittingRecord("done1"))
      await store.apply("done1", {
        type: "mined",
        l2TxHash: L2TX_2,
        blockNumber: 50,
        rawAmount: "500000",
      })
      await store.apply("done1", {
        type: "patch",
        fields: { phase: "done", withdrawalId: WID_2, l1TxHash: L1TX },
      })

      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "finalizing_l1", withdrawalId: WID_1 },
      })

      await store.create(submittingRecord("pre1"))

      const reader = makeReader({
        isSpent: vi.fn(async () => true),
        resolveL1TxHash: vi.fn(async () => undefined),
      })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: reader,
      })
      await tracker.syncOnce()
      await tracker.syncOnce()

      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("done1"))?.phase).toBe("done")
      expect((await store.get("done1"))?.l1TxHash).toBe(L1TX)
      expect((await store.get("pre1"))?.phase).toBe("submitting")
    })

    it("steps four records at once, and a failed read frees its slot", async () => {
      const store = await seedStore()
      const ids: Hex[] = []
      for (let i = 1; i <= 5; i++) {
        const l2TxHash = ("0x" + String(i).padStart(2, "0").repeat(32)) as Hex
        const withdrawalId = ("0x" + String(i + 50).repeat(32)) as Hex
        await store.create(submittingRecord(`w${i}`))
        await store.apply(`w${i}`, {
          type: "mined",
          l2TxHash: l2TxHash,
          blockNumber: 100 + i,
          rawAmount: "1000000",
        })
        await store.apply(`w${i}`, {
          type: "patch",
          fields: { phase: "finalizing_l1", withdrawalId },
        })
        ids.push(withdrawalId)
      }

      const reads = new Map<
        Hex,
        { resolve: (spent: boolean) => void; reject: (err: Error) => void }
      >()
      const isSpent = vi.fn(
        (id: Hex) => new Promise<boolean>((resolve, reject) => reads.set(id, { resolve, reject })),
      )
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
      })
      const pass = tracker.syncOnce()

      await vi.waitFor(() => expect(reads.size).toBe(4))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reads.has(ids[4])).toBe(false)

      reads.get(ids[0])!.reject(new Error("rpc down"))
      await vi.waitFor(() => expect(reads.has(ids[4])).toBe(true))

      for (const id of ids.slice(1)) reads.get(id)!.resolve(true)
      await pass
      expect((await store.get("w1"))?.phase).toBe("finalizing_l1")
      for (let i = 2; i <= 5; i++) expect((await store.get(`w${i}`))?.phase).toBe("done")
    })
  })

  describe("a wake (post-mine re-poll)", () => {
    it("re-polls a stalled post-mine record and reaches done once spent", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "finalizing_l1", withdrawalId: WID_1 },
      })

      const isSpent = vi.fn(async () => true)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
      })

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
    })

    it("steps no terminal record", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "done", withdrawalId: WID_1, l1TxHash: L1TX },
      })

      const isSpent = vi.fn(async () => true)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
      })

      await tracker.syncOnce()
      expect(isSpent).not.toHaveBeenCalled()
      expect((await store.get("w1"))?.phase).toBe("done")
    })
  })

  describe("RPC errors fail loud and retry", () => {
    it("an isSpent throw keeps the record non-terminal, then completes on the next tick", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "finalizing_l1", withdrawalId: WID_1 },
      })

      const isSpent = vi
        .fn<[Hex], Promise<boolean>>()
        .mockRejectedValueOnce(new Error("RPC down"))
        .mockResolvedValue(true)
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent }),
      })

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("finalizing_l1")
      expect(warnSpy).toHaveBeenCalled()

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
    })

    it("a getTxReceipt throw keeps the record non-terminal and retries", async () => {
      const store = await seedStore()
      await store.create(submittingRecord("w1"))
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      await store.apply("w1", {
        type: "patch",
        fields: { phase: "awaiting_proven", withdrawalId: WID_1 },
      })

      const getTxReceipt = vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC down"))
        .mockResolvedValue({ status: TxStatus.PROVEN })
      const node = { getTxReceipt } as unknown as WithdrawalTrackerNode
      const tracker = stepper({ store, node, finalizationReader: makeReader() })

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("awaiting_proven")

      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("finalizing_l1")
    })
  })
  describe("swap leg", () => {
    /** A swap record released to its escrow, tracked with `reader`; returns the tracker. */
    async function releasedSwap(
      store: Withdrawals,
      reader: SwapEscrowReader,
      fields: Partial<WithdrawalRecord> = swapFields(),
    ) {
      await store.create({ ...submittingRecord("w1"), ...fields })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
        swapEscrowReader: reader,
      })
      await tracker.syncOnce() // derive + proven → finalizing_l1
      await tracker.syncOnce() // released
      return tracker
    }

    it("a release funds the escrow: the record parks at swapping, and a fillable deploy keeps it there", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      expect((await store.get("w1"))?.phase).toBe("swapping")
      expect((await store.get("w1"))?.phaseEnteredAt).toBeGreaterThan(0)
      expect(reader.deploySimulates).toHaveBeenCalledWith(
        FACTORY,
        expect.objectContaining({
          layout: "legacy",
          args: expect.objectContaining({
            route: 0,
            recipient: RECIPIENT,
            nonce: swapFields().swapNonce,
          }),
        }),
      )
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("swapping")
    })

    it("without an escrow reader a swap record settles done at the release, like a direct one", async () => {
      const store = await seedStore()
      await store.create({ ...submittingRecord("w1"), ...swapFields() })
      await store.apply("w1", {
        type: "mined",
        l2TxHash: L2TX_1,
        blockNumber: 100,
        rawAmount: "1000000",
      })
      const tracker = stepper({
        store,
        node: makeNode(TxStatus.PROVEN),
        finalizationReader: makeReader({ isSpent: vi.fn(async () => true) }),
      })
      await tracker.syncOnce()
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
    })

    it("an emptied, deployed escrow means the swap ran: done, with the executed tx", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()

      const done = (await store.get("w1"))!
      expect(done.phase).toBe("done")
      expect(done.swapExecuteTxHash).toBe(EXEC_TX)
      expect(done.endTime).toBeGreaterThan(0)
      expect(reader.executedTxHash).toHaveBeenCalledWith(FACTORY, ESCROW)
    })

    it("an empty escrow with no code is a release not yet visible: the tick defers", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ daiBalance: vi.fn(async () => 0n) })
      await releasedSwap(store, reader)
      expect((await store.get("w1"))?.phase).toBe("swapping")
      expect(reader.deploySimulates).not.toHaveBeenCalled()
    })

    it("a funded escrow whose deploy reverts is recoverable", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      await releasedSwap(store, reader)
      expect((await store.get("w1"))?.phase).toBe("recoverable")
    })

    it("a recoverable escrow whose deploy fills again goes back to swapping", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      expect((await store.get("w1"))?.phase).toBe("recoverable")
      ;(reader.deploySimulates as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("swapping")
    })

    it("a recoverable escrow emptied by a recovery is recovered, from the escrow's log", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.recoveredTxHash as ReturnType<typeof vi.fn>).mockResolvedValue({
        txHash: EXEC_TX,
        target: RECIPIENT,
      })
      await tracker.syncOnce()
      const recovered = (await store.get("w1"))!
      expect(recovered.phase).toBe("recovered")
      expect(recovered.recoveryTxHash).toBe(EXEC_TX)
      expect(recovered.recoveryTarget).toBe(RECIPIENT)
      expect(recovered.endTime).toBeGreaterThan(0)
      expect(reader.recoveredTxHash).toHaveBeenCalledWith(ESCROW)
    })

    it("a recoverable escrow emptied with no log of either kind settles done", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("w1"))?.swapExecuteTxHash).toBeUndefined()
    })

    it("a failed executed-log read defers the verdict to the next tick", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("rpc down"),
      )
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("recoverable")
      expect(warnSpy).toHaveBeenCalled()
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("w1"))?.swapExecuteTxHash).toBe(EXEC_TX)
    })

    it("a recoverable escrow emptied by an execution after all is done", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(reader.executedTxHash as ReturnType<typeof vi.fn>).mockResolvedValue(EXEC_TX)
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
      expect((await store.get("w1"))?.swapExecuteTxHash).toBe(EXEC_TX)
    })

    it("a record without a recovery commitment cannot be simulated: it waits on a relayer", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const incomplete = swapFields()
      delete incomplete.swapRecoveryCommitment
      await releasedSwap(store, reader, incomplete)
      expect((await store.get("w1"))?.phase).toBe("swapping")
      expect(reader.deploySimulates).not.toHaveBeenCalled()
    })

    it("a reader failure leaves the phase untouched and retries next tick", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader()
      const tracker = await releasedSwap(store, reader)

      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rpc down"))
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("swapping")
      expect(warnSpy).toHaveBeenCalled()
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockResolvedValue(0n)
      ;(reader.isDeployed as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      await tracker.syncOnce()
      expect((await store.get("w1"))?.phase).toBe("done")
    })

    it("terminal recovered records are not ticked", async () => {
      const store = await seedStore()
      const reader = makeEscrowReader({ deploySimulates: vi.fn(async () => false) })
      const tracker = await releasedSwap(store, reader)
      await store.apply(L2TX_1, {
        type: "patch",
        fields: { phase: "recovered", recoveryTxHash: EXEC_TX },
      })
      ;(reader.daiBalance as ReturnType<typeof vi.fn>).mockClear()
      await tracker.syncOnce()
      expect(reader.daiBalance).not.toHaveBeenCalled()
    })
  })

  describe("canSelfExecuteSwap / canRecoverSwap", () => {
    const now = 1_700_000_000_000
    const swapping = (): WithdrawalRecord => ({
      ...submittingRecord("w1"),
      ...swapFields(),
      l2TxHash: L2TX_1,
      phase: "swapping",
      phaseEnteredAt: now - SWAP_STUCK_THRESHOLD_MS,
    })

    it("offers the self-run once a swapping record has waited out the relayer's budget", () => {
      expect(canSelfExecuteSwap(swapping(), now)).toBe(true)
      expect(canSelfExecuteSwap({ ...swapping(), phaseEnteredAt: now - 1000 }, now)).toBe(false)
    })

    it("withholds the self-run while one is in flight, and from records that cannot rebuild args", () => {
      expect(canSelfExecuteSwap({ ...swapping(), swapExecuteTxHash: EXEC_TX }, now)).toBe(false)
      expect(canSelfExecuteSwap({ ...swapping(), swapRecoveryCommitment: undefined }, now)).toBe(
        false,
      )
      expect(canSelfExecuteSwap({ ...swapping(), phase: "finalizing_l1" }, now)).toBe(false)
    })

    it("offers recovery on a parked recoverable record with args", () => {
      expect(canRecoverSwap({ ...swapping(), phase: "recoverable" })).toBe(true)
      expect(canRecoverSwap({ ...swapping(), phase: "recoverable", swapNonce: undefined })).toBe(
        false,
      )
      expect(canRecoverSwap(swapping())).toBe(false)
    })

    it("a swapping record is delayed on the same derivation as the other post-mine phases", () => {
      expect(isWithdrawalDelayed(swapping(), now, SWAP_STUCK_THRESHOLD_MS)).toBe(true)
      expect(isWithdrawalDelayed({ ...swapping(), phase: "recoverable" }, now, 0)).toBe(false)
    })
  })
})

// The stamp is the burn's `onTxHash`, which the wallet awaits before the node takes the burn.
describe("trackWithdrawalSubmission's hash stamp", () => {
  it("resolves once the hash persisted", async () => {
    const backend = memoryBackend()
    const store = createWithdrawals({ db: openDatabase(backend) })
    await store.ready
    await store.create(submittingRecord("w1"))
    const submission = trackWithdrawalSubmission(store, "w1", "op")
    try {
      await submission.stamp(L2TX_1)
      const reopened = createWithdrawals({ db: openDatabase(backend) })
      expect((await reopened.get("w1"))?.l2TxHash).toBe(L2TX_1)
      expect([...backend.entries.values()].some((raw) => raw.includes(L2TX_1))).toBe(true)
    } finally {
      submission.stop()
    }
  })

  // Nothing reached the node, so the burn is not in flight.
  it("rejects a hash that did not persist, and leaves nothing to recover", async () => {
    const backend = memoryBackend()
    const store = createWithdrawals({ db: openDatabase(backend) })
    await store.ready
    await store.create(submittingRecord("w1"))
    backend.failing.commits = true
    const submission = trackWithdrawalSubmission(store, "w1", "op")
    try {
      await expect(submission.stamp(L2TX_1)).rejects.toMatchObject({ code: "unknown" })
      expect(await submission.recover({ getTxReceipt: vi.fn() } as never)).toBeNull()
    } finally {
      submission.stop()
    }
  })

  it("does not announce a record that rides another record's tx", async () => {
    const store = await seedStore()
    await store.create(submittingRecord("w1"))
    const heard = vi.fn()
    provingProgress.on("tx-hash-saved", heard)
    const submission = trackWithdrawalSubmission(store, "w1", "op", { announce: false })
    try {
      await submission.stamp(L2TX_1)
      provingProgress.emitStageStart(ProvingStage.Mining, "op", L2TX_1)
      expect((await store.get("w1"))?.l2TxHash).toBe(L2TX_1)
      expect(heard).not.toHaveBeenCalled()
    } finally {
      submission.stop()
      provingProgress.off("tx-hash-saved", heard)
    }
  })
})

// A node that refuses a burn names the one it holds; that withdrawal is pending, whatever it read.
describe("revivePendingWithdrawal", () => {
  it("puts a failed withdrawal back to submitting, and leaves a live one as it is", async () => {
    const store = await seedStore()
    await store.create({ ...submittingRecord("w1"), l2TxHash: L2TX_1 })
    await store.apply("w1", {
      type: "patch",
      fields: { phase: "failed", failure: { code: "withdrawal.dropped" }, droppedBurn: true },
    })
    const revived = await revivePendingWithdrawal(store, L2TX_1.toUpperCase().replace("0X", "0x"))
    expect(revived).toMatchObject({ localId: "w1", phase: "submitting", l2TxHash: L2TX_1 })
    expect(revived?.failure).toBeUndefined()
    expect(revived?.endTime).toBeUndefined()
    expect(revived?.droppedBurn).toBeUndefined()

    await store.create({ ...submittingRecord("w2"), l2TxHash: L2TX_2 })
    await store.apply("w2", {
      type: "mined",
      l2TxHash: L2TX_2,
      blockNumber: 7,
      rawAmount: "1",
      relayerTip: "0",
    })
    expect(await revivePendingWithdrawal(store, L2TX_2)).toMatchObject({ phase: "l2_mined" })
  })

  it("lets the tracker move a revived burn that had been mined back to mined", async () => {
    const store = await seedStore()
    await store.create(submittingRecord("w1"))
    await store.apply("w1", {
      type: "mined",
      l2TxHash: L2TX_1,
      blockNumber: 100,
      rawAmount: "1000000",
    })
    await store.apply("w1", {
      type: "patch",
      fields: { phase: "failed", withdrawalId: WID_1, droppedBurn: true },
    })
    await revivePendingWithdrawal(store, L2TX_1)
    const node = makeNode(TxStatus.PENDING)
    vi.mocked(node.getTxReceipt).mockResolvedValue({
      status: TxStatus.PENDING,
      blockNumber: 120,
    } as never)
    const tracker = stepper({ store, node, finalizationReader: makeReader() })
    await tracker.syncOnce()
    expect(await store.get("w1")).toMatchObject({
      phase: "awaiting_proven",
      blockNumber: 120,
      withdrawalId: WID_1,
    })
  })

  it("answers null for a transaction no withdrawal sent", async () => {
    expect(await revivePendingWithdrawal(await seedStore(), L2TX_1)).toBeNull()
  })
})

describe("withdrawalTracker task", () => {
  const runtimes: Runtime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
    vi.useRealTimers()
  })

  function harness(rails: () => Promise<TrackerRails | null>, store?: Withdrawals) {
    const wallet = memoryStore<ResourceState<{ node: WithdrawalTrackerNode }>>({
      status: "pending",
    })
    const visible = memoryStore(true)
    const db = openDatabase(memoryBackend())
    const tracker = withdrawalTracker({
      wallet: { ...wallet.readonly, name: "wallet", demand() {}, retry() {}, close() {} },
      store: store ?? createWithdrawals({ db }),
      rails,
    })
    let runtime: Runtime | undefined
    const start = () => {
      runtime = startRuntime([tracker], {
        db,
        milestones: { after: async () => true, reached: () => false },
        visible: visible.readonly,
      })
      runtimes.push(runtime)
      return runtime
    }
    const ready = (node = makeNode()) => wallet.set({ status: "ready", value: { node } })
    return { wallet, visible, tracker, start, ready, stop: () => runtime?.stop() }
  }

  it("runs while the wallet is ready: every 20 s, every minute hidden, at once on show", async () => {
    const store = await seedStore()
    await store.create({ ...submittingRecord("w1"), l2TxHash: L2TX_1 })
    vi.useFakeTimers()
    const rails = vi.fn(async () => null)
    const h = harness(rails, store)
    const steps: [string, () => void, number, number][] = [
      ["start without a wallet", () => h.start(), 0, 0],
      ["the wallet is ready", () => h.ready(), 0, 1],
      ["visible", () => {}, 20_000, 2],
      ["hidden: the visible timer stands", () => h.visible.set(false), 20_000, 3],
      ["hidden: a minute apart", () => {}, 59_999, 3],
      ["hidden pace", () => {}, 1, 4],
      ["show", () => h.visible.set(true), 0, 5],
      ["stop", () => h.stop(), 120_000, 5],
      ["restart", () => h.start(), 0, 6],
      ["the wallet leaves", () => h.wallet.set({ status: "pending" }), 60_000, 6],
    ]
    for (const [label, act, ms, runs] of steps) {
      act()
      await vi.advanceTimersByTimeAsync(ms)
      expect(rails, label).toHaveBeenCalledTimes(runs)
    }
  })

  it("reads no rails while no record waits on chain", async () => {
    const rails = vi.fn(async () => null)
    const h = harness(rails)
    const runtime = h.start()
    h.ready()
    await runtime.wake(h.tracker)
    expect(rails).not.toHaveBeenCalled()
  })

  it("steps over the wallet's node; a wake during a pass runs again for records created meanwhile", async () => {
    mockFetch.mockReset()
    stubDerivation()
    const store = await seedStore()
    await store.create(submittingRecord("w1"))
    await store.apply("w1", { type: "mined", l2TxHash: L2TX_1, blockNumber: 100, rawAmount: "1" })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const isSpent = vi.fn(async (id: Hex) => {
      if (id === WID_1) await held
      return true
    })
    const wiring = {
      finalizationReader: makeReader({ isSpent }),
      deployment: DEPLOYMENT,
      withdrawalIds: mockFetch,
    }
    const h = harness(async () => wiring, store)
    const runtime = h.start()
    h.ready(makeNode(TxStatus.PROVEN))
    await vi.waitFor(() => expect(isSpent).toHaveBeenCalledWith(WID_1))

    await store.create(submittingRecord("w2"))
    await store.apply("w2", { type: "mined", l2TxHash: L2TX_2, blockNumber: 101, rawAmount: "1" })
    const woken = runtime.wake(h.tracker)
    release()
    await woken
    expect((await store.get("w1"))?.phase).toBe("done")
    expect((await store.get("w2"))?.phase).toBe("done")
  })
})

import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxExecutionResult } from "@aztec-labs/stdlib/tx"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import {
  FrozenMetadataMigrationSource,
  type FrozenRefundCandidate,
} from "../../../src/services/migration/FrozenMetadataMigrationSource.js"
import { ApprovalNeededError } from "../../../src/services/migration/metadataMigration.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}

const deposit = (id: string, amount = 20n * TIP): FrozenRefundCandidate => ({
  id,
  amount: String(amount),
  kind: "frozen-deposit",
})

function fixture(candidates: FrozenRefundCandidate[]) {
  const saved = new Map<string, MigrationFundingBatch>()
  const build = vi.fn()
  const runtime = {
    identity: "frozen",
    migration: ROUTE,
    minimumMigratedAmount: async () => 3n,
    assertMigrationReady: vi.fn(async () => {}),
    validate: async () => {},
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates,
      waiting: 7n,
    })),
    build,
    refunded: vi.fn(async () => false),
  }
  const options = {
    directDepositClaimed: async () => 0n,
    owner: "0x000000000000000000000000000000000000000a",
    runtime,
    destinationAsset: "0x0000000000000000000000000000000000000001",
    destination: { portal: "0x01", factory: "0x01", rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO, policy: {} },
    client: {
      getBlockNumber: async () => 1n,
      call: async () => ({}),
      readContract: async () => 10n ** 30n,
    },
    wallet: {
      node: { getTxReceipt: async () => ({ executionResult: TxExecutionResult.SUCCESS }) },
      sendTx: vi.fn(),
    },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  }
  const make = () => new FrozenMetadataMigrationSource(options as never)
  return { make, saved, build }
}

describe("sending the planned batches", () => {
  it("never plans a batch itself: uncovered funds wait for the user's approval", async () => {
    const f = fixture([deposit("late")])

    await expect(f.make().recoverRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
  })
})

describe("counting what the source holds", () => {
  it("counts every refundable fund and waiting deposit", async () => {
    const f = fixture([deposit("a"), deposit("dust", TIP)])

    expect(await f.make().holdings()).toBe(21n * TIP + 7n)
  })
})

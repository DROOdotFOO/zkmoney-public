import { describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import {
  FrozenMetadataMigrationSource,
  selectFrozenBatch,
  type FrozenMigrationRuntime as Runtime,
  type FrozenRefundCandidate as Candidate,
} from "../../../src/services/migration/FrozenMetadataMigrationSource.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}

const AMOUNTS: Record<string, bigint> = {
  small: TIP,
  medium: 8n * TIP,
  large: 20n * TIP,
  deposit: 30n * TIP,
  link: 20n * TIP,
}
const note = (id: string, amount = AMOUNTS[id]!): Candidate => ({
  id,
  amount: String(amount),
  kind: "note",
})

/** A frozen source on the migration route, whose subsidy floor is `floor`. */
function fixture(
  candidates: Candidate[] = [note("small"), note("medium"), note("large")],
  floor = 1n,
) {
  const saved = new Map<string, MigrationFundingBatch>()
  const amounts = new Map(candidates.map((c) => [c.id, BigInt(c.amount)]))
  const runtime: Runtime = {
    identity: "isolated-source-toolchain-and-deployment",
    migration: ROUTE,
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates,
    })),
    build: vi.fn(async ({ ids }: { ids: string[] }) => ({
      amount: ids.reduce((sum, id) => sum + (amounts.get(id) ?? AMOUNTS[id] ?? 0n), 0n),
      operation: {
        target: EthAddress.fromString(ROUTE.subsidy),
        payoutToken: EthAddress.fromString(ROUTE.payoutToken),
        calldata: Buffer.from("1234", "hex"),
        condition: L1OperationCondition.immediate(),
      },
    })),
    refunded: vi.fn(async () => false),
    minimumMigratedAmount: vi.fn(async () => floor),
  }
  const options = {
    runtime,
    owner: addr("0a"),
    destinationAsset: addr("55"),
    destination: { portal: ROUTE.destinationPortal, factory: addr("fa"), rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO },
    wallet: { node: {} },
    client: {
      getBlockNumber: async () => 1n,
      call: vi.fn(async () => ({})),
      readContract: vi.fn(async () => 10n ** 30n),
    },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  } as unknown as ConstructorParameters<typeof FrozenMetadataMigrationSource>[0]
  const make = () => new FrozenMetadataMigrationSource(options)
  return { runtime, saved, make }
}

/** Runs selection to exhaustion, as successive recoveries do; returns the batches and what is left. */
function partition(
  amounts: bigint[],
  need: bigint,
  maxNotesPerBatch = 10,
  maxBatchAmount = 10_000n,
) {
  let left = amounts.map((amount, i) => note(`n${i}`, amount))
  const batches: bigint[] = []
  for (;;) {
    const batch = selectFrozenBatch({
      candidates: left,
      maxNotesPerBatch,
      maxBatchAmount,
      minimumAmount: need,
    })
    if (!batch) return { batches, left: left.reduce((sum, c) => sum + BigInt(c.amount), 0n) }
    batches.push(batch.amount)
    left = left.filter((c) => !batch.ids.includes(c.id))
  }
}

const ones = (n: number) => Array.from({ length: n }, () => 1n)

describe("frozen refund batch selection", () => {
  it.each([
    ["60,60,40,40 and 16 dust", [60n, 60n, 40n, 40n, ...ones(16)]],
    ["70,60,45,25 and 16 dust", [70n, 60n, 45n, 25n, ...ones(16)]],
  ])("leaves no affordable value behind for %s", (_, amounts) => {
    const { batches, left } = partition(amounts, 100n)
    expect(batches).toHaveLength(2)
    expect(batches.every((amount) => amount >= 100n)).toBe(true)
    expect(left).toBe(0n)
  })

  it("lets dust ride along up to the note limit", () => {
    expect(partition([150n, ...ones(12)], 100n, 10)).toEqual({ batches: [159n], left: 3n })
  })

  it("moves at least the minimum", () => {
    const at = (amount: bigint) =>
      selectFrozenBatch({
        candidates: [{ id: "d", amount: String(amount), kind: "frozen-deposit" }],
        maxNotesPerBatch: 10,
        maxBatchAmount: 10_000n * TIP,
        minimumAmount: 6n,
      })
    expect(at(5n)).toBeUndefined()
    expect(at(6n)?.ids).toEqual(["d"])
  })

  it("keeps a note batch within the portal's amount cap", () => {
    expect(partition([60n, 50n, 45n], 50n, 10, 95n).batches).toEqual([95n, 60n])
    expect(partition([60n, 50n, 45n], 50n, 10, 94n).batches).toEqual([50n, 60n])
  })

  it("refunds a payment link's notes together, apart from the account's and another link's", () => {
    const link = (id: string, owner: string, amount: bigint): Candidate => ({
      id,
      amount: String(amount),
      kind: "escrow-note",
      owner,
    })
    const candidates = [
      note("small"),
      link("a1", "0xa", 6n * TIP),
      link("a2", "0xa", 6n * TIP),
      link("b1", "0xb", 10n * TIP),
    ]
    const select = (left: Candidate[]) =>
      selectFrozenBatch({
        candidates: left,
        maxNotesPerBatch: 10,
        maxBatchAmount: 1000n * TIP,
        minimumAmount: 5n * TIP + TIP,
      })
    expect(select(candidates)).toEqual({
      kind: "escrow-note",
      ids: ["a1", "a2"],
      amount: 12n * TIP,
    })
    expect(select(candidates.filter((c) => c.owner !== "0xa"))).toEqual({
      kind: "escrow-note",
      ids: ["b1"],
      amount: 10n * TIP,
    })
    expect(() => select([{ id: "x", amount: "1", kind: "escrow-note" }])).toThrow(
      "Invalid frozen-source candidate",
    )
  })

  it("takes a payment link's batch only once no deposit clears the minimum", () => {
    const candidates: Candidate[] = [
      { id: "l", amount: String(20n * TIP), kind: "escrow-note", owner: "0xa" },
      { id: "d", amount: String(10n * TIP), kind: "frozen-deposit" },
    ]
    const select = (minimumNetAmount: bigint) =>
      selectFrozenBatch({
        candidates,
        maxNotesPerBatch: 10,
        maxBatchAmount: 1000n * TIP,
        minimumAmount: minimumNetAmount + TIP,
      })
    expect(select(5n * TIP)).toMatchObject({ kind: "frozen-deposit", ids: ["d"] })
    expect(select(15n * TIP)).toMatchObject({ kind: "escrow-note", ids: ["l"] })
  })

  it("refunds a deposit alone and never with notes", () => {
    const candidates: Candidate[] = [
      note("medium"),
      { id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" },
    ]
    const select = (minimumNetAmount: bigint) =>
      selectFrozenBatch({
        candidates,
        maxNotesPerBatch: 10,
        maxBatchAmount: 1000n * TIP,
        minimumAmount: minimumNetAmount + TIP,
      })
    expect(select(1n)).toMatchObject({ kind: "note", ids: ["medium"] })
    expect(select(10n * TIP)).toMatchObject({ kind: "frozen-deposit", ids: ["deposit"] })
  })
})

describe("a frozen source on the migration route", () => {
  it("refuses a runtime without the destination's migration route", () => {
    const f = fixture()
    delete (f.runtime as { migration?: unknown }).migration
    expect(() => f.make()).toThrow(
      "A frozen source moves funds only through the destination's migration executor",
    )
  })

  it("moves only funds, at the subsidy's floor", async () => {
    const f = fixture([note("medium")], 9n * TIP)
    const source = f.make()
    expect(source.fundsOnly).toBe(true)
    expect(await source.movable()).toBe(false)
    expect(
      await fixture([note("medium")], 8n * TIP)
        .make()
        .movable(),
    ).toBe(true)
  })

  it("settles with a stranded residual below the subsidy's floor, after a fresh scan", async () => {
    const f = fixture([note("dust", TIP)], 2n * TIP)
    const source = f.make()
    await source.recoverRemaining()
    expect(f.runtime.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
    expect(await source.remainingComplete()).toBe(true)
    expect(f.runtime.candidates).toHaveBeenLastCalledWith({ fresh: true })
  })
})

describe("frozen migration quote", () => {
  const link: Candidate = {
    id: "link",
    amount: String(AMOUNTS.link),
    kind: "escrow-note",
    owner: "0xa",
  }

  it("counts no approval for a payment link's batch, which its fallback key signs", async () => {
    const f = fixture([note("large"), link], 15n * TIP)
    expect(await f.make().quote()).toMatchObject({ batches: 2, approvals: 1 })
  })

  it("quotes every batch a run takes and leaves what none can afford stranded", async () => {
    // Two notes per batch: dust rides along with the large note; the rest is below the floor.
    const f = fixture([note("large"), note("d1", 1n), note("d2", 1n), note("d3", 1n)], 15n * TIP)
    expect(await f.make().quote()).toEqual({
      movable: AMOUNTS.large! + 1n,
      stranded: 2n,
      waiting: 0n,
      batches: 1,
      approvals: 1,
    })
  })

  it("splits notes above the portal's amount cap across batches", async () => {
    const f = fixture([note("a", 600n * TIP), note("b", 600n * TIP)])
    expect(await f.make().quote()).toMatchObject({ movable: 1200n * TIP, batches: 2 })
  })

  it("counts a deposit by itself, and the runtime's waiting deposits apart", async () => {
    const candidates = [
      note("small"),
      { id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" as const },
    ]
    const f = fixture(candidates, 15n * TIP)
    vi.mocked(f.runtime.candidates).mockResolvedValue({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates,
      waiting: 7n * TIP,
    })
    expect(await f.make().quote()).toEqual({
      movable: AMOUNTS.deposit,
      stranded: AMOUNTS.small,
      waiting: 7n * TIP,
      batches: 1,
      approvals: 1,
    })
  })
})

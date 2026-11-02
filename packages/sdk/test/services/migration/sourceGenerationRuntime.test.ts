import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { SourceExecutorCall, SourceRefundRuntime } from "@obsidion/core/types"
import { L1OperationConditionKind } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { frozenRuntimeFromSourceGeneration } from "../../../src/services/migration/sourceGenerationRuntime.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const PORTAL = addr("11")
const DAI = addr("22")
const RECIPIENT = addr("33")
const DEST = addr("de")
const EXECUTOR = addr("e1")
const SUBSIDY = addr("5b")
const COMMITMENT = new Fr(1234n).toString() as `0x${string}`
const NOW = 10_000n

const PLAIN_CALL: SourceExecutorCall = {
  executor: addr("9a"),
  userPayload: `0x${"01".repeat(64)}`,
  relayerPayload: `0x${"02".repeat(64)}`,
}

function source(calldata = "0xabcd", amount = "500"): SourceRefundRuntime {
  return {
    identity: "v5-identity",
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 10,
      maxBatchAmount: "2583000000000000000000",
      candidates: [{ id: "0x01", amount, kind: "note" as const }],
    })),
    plainExecutorCall: vi.fn(async () => PLAIN_CALL),
    build: vi.fn(async () => ({
      amount,
      operation: { target: PORTAL, payoutToken: DAI, calldata },
    })),
    refunded: vi.fn(async () => true),
  }
}

const route = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  payoutToken: DAI,
  sourcePortal: PORTAL,
  destinationPortal: DEST,
  operationExecutor: addr("0e"),
}
const OPERATION_EXECUTOR_CODE = "0x6080604052"

/** What the `MigrationExecutor` reports about itself. */
const EXECUTOR_VIEW: Record<string, string> = {
  SUBSIDY,
  SOURCE_PORTAL: PORTAL,
  DESTINATION_PORTAL: DEST,
}

const migration = () => {
  const client = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName in EXECUTOR_VIEW ? EXECUTOR_VIEW[functionName] : undefined,
    ),
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: NOW, baseFeePerGas: 10n ** 9n })),
    getGasPrice: vi.fn(async () => 2n * 10n ** 9n),
    getCode: vi.fn(async () => OPERATION_EXECUTOR_CODE),
  }
  return { route, client: client as never, readContract: client.readContract }
}

const note = { kind: "note" as const, ids: ["0x01"] }

describe("frozenRuntimeFromSourceGeneration", () => {
  it("reads amounts back as bigints and passes plain arguments through", async () => {
    const plain = source()
    const runtime = frozenRuntimeFromSourceGeneration(plain)
    expect(runtime.identity).toBe("v5-identity")
    expect(runtime.migration).toBeUndefined()
    expect(runtime.assertMigrationReady).toBeUndefined()
    await expect(runtime.candidates({ fresh: true })).resolves.toMatchObject({
      maxBatchAmount: 2583000000000000000000n,
    })
    expect(plain.candidates).toHaveBeenCalledWith({ fresh: true })
    await runtime.validate(DAI as never)
    expect(plain.validate).toHaveBeenCalledWith(DAI)
    await expect(runtime.refunded(["0x01"])).resolves.toBe(true)
  })

  it("reads waiting deposits back as a bigint and keeps each payment link's escrow", async () => {
    const plain = source()
    vi.mocked(plain.candidates).mockResolvedValueOnce({
      maxNotesPerBatch: 10,
      maxBatchAmount: "100",
      waiting: "7",
      candidates: [],
    })
    await expect(frozenRuntimeFromSourceGeneration(plain).candidates()).resolves.toEqual({
      maxNotesPerBatch: 10,
      maxBatchAmount: 100n,
      waiting: 7n,
      candidates: [],
    })
    const link = { id: "0x02", amount: "4", kind: "escrow-note" as const, owner: "0xescrow" }
    vi.mocked(plain.candidates).mockResolvedValueOnce({
      maxNotesPerBatch: 10,
      maxBatchAmount: "100",
      candidates: [link],
    })
    const read = await frozenRuntimeFromSourceGeneration(plain).candidates()
    expect(read.candidates).toEqual([link])
    expect(read).not.toHaveProperty("waiting")
  })

  it("refunds an address through the generation's plain executor call", async () => {
    const plain = source()
    const built = await frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, 3n)
    expect(plain.plainExecutorCall).toHaveBeenCalledWith(RECIPIENT, "3")
    expect(plain.build).toHaveBeenCalledWith(note, PLAIN_CALL)
    expect(built.amount).toBe(500n)
    expect(built.operation.target.toString()).toBe(PORTAL)
    expect(built.operation.payoutToken.toString()).toBe(DAI)
    expect(built.operation.calldata).toEqual(Buffer.from("abcd", "hex"))
    expect(built.operation.condition.kind).toBe(L1OperationConditionKind.Immediate)
  })

  it("refuses a commitment without a migration route", async () => {
    const plain = source()
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toThrow(/No migration route serves this source/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("checks on this side that the amount covers the tip", async () => {
    await expect(
      frozenRuntimeFromSourceGeneration(source("0xabcd", "3")).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/cannot cover its relayer tip/)
    const plain = source()
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, -1n),
    ).rejects.toThrow(/cannot cover its relayer tip/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("refuses calldata or an executor call that is not hex", async () => {
    await expect(
      frozenRuntimeFromSourceGeneration(source("abcd")).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/malformed calldata/)
    const plain = source()
    vi.mocked(plain.plainExecutorCall).mockResolvedValueOnce({ ...PLAIN_CALL, userPayload: "01" })
    await expect(
      frozenRuntimeFromSourceGeneration(plain).build(note, RECIPIENT, 3n),
    ).rejects.toThrow(/malformed executor call/)
    expect(plain.build).not.toHaveBeenCalled()
  })

  it("does not open another source approval after the upgrade queue is prepared", async () => {
    const plain = source()
    const runtime = frozenRuntimeFromSourceGeneration(plain, () => {
      throw new Error("approval required")
    })
    await expect(runtime.build(note, RECIPIENT, 3n)).rejects.toThrow("approval required")
    expect(plain.build).not.toHaveBeenCalled()
  })
})

describe("frozenRuntimeFromSourceGeneration on a migration route", () => {
  it("refunds an address through the plain executor with a route present, with no subsidy read", async () => {
    const plain = source()
    const migrating = migration()
    const runtime = frozenRuntimeFromSourceGeneration(plain, undefined, migrating)
    const built = await runtime.build(note, RECIPIENT, 3n)

    expect(plain.plainExecutorCall).toHaveBeenCalledWith(RECIPIENT, "3")
    expect(vi.mocked(plain.build).mock.calls[0]![1]).toEqual(PLAIN_CALL)
    expect(built.operation.target.toString()).toBe(PORTAL)
    expect(built.operation.payoutToken.toString()).toBe(DAI)
    expect(built.operation.condition.kind).toBe(L1OperationConditionKind.Immediate)
    expect(migrating.readContract).not.toHaveBeenCalled()
  })
})

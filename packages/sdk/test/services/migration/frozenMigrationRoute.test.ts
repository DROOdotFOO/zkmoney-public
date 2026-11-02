import { describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  FrozenRefundMigrationRuntime,
  migrationRouteFor,
} from "../../../src/services/migration/FrozenRefundMigrationRuntime.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const SOURCE = addr("51")
const DEST = addr("de")
const EXECUTOR = addr("e1")
const SUBSIDY = addr("5b")
const DAI = addr("da")
const PLAIN = addr("9a")
const COMMITMENT = new Fr(1234n).toString() as `0x${string}`
const NOW = 10_000n
const OPERATION_EXECUTOR = addr("0e")
const OPERATION_EXECUTOR_CODE = "0x6080604052" as const

const route = {
  executor: EXECUTOR,
  subsidy: SUBSIDY,
  payoutToken: DAI,
  sourcePortal: SOURCE,
  destinationPortal: DEST,
  operationExecutor: OPERATION_EXECUTOR,
}

/** What the `MigrationExecutor` reports about itself. */
const executorView = (over: Record<string, string> = {}) =>
  ({ SUBSIDY: SUBSIDY, SOURCE_PORTAL: SOURCE, DESTINATION_PORTAL: DEST, ...over } as Record<
    string,
    string
  >)

function makeRuntime(
  migration?: typeof route,
  over: Record<string, unknown> = {},
  executor = executorView(),
) {
  const portalAddress = EthAddress.fromString(SOURCE)
  const rollup = EthAddress.fromString(addr("77"))
  const tokenAddress = AztecAddress.fromBigIntUnsafe(5n)
  const owner = { address: { equals: () => true, toString: () => "owner" } }
  const client = {
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: NOW, baseFeePerGas: 10n ** 9n })),
    getGasPrice: vi.fn(async () => 2n * 10n ** 9n),
    getCode: vi.fn(async () => OPERATION_EXECUTOR_CODE as `0x${string}`),
    readContract: vi.fn(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() !== EXECUTOR) throw new Error(`unexpected read of ${address}`)
        return executor[functionName]
      },
    ),
  }
  const options = {
    node: {
      getNodeInfo: async () => ({
        nodeVersion: "6.0.0",
        rollupVersion: 1,
        l1ContractAddresses: { rollupAddress: rollup },
      }),
      getBlockNumber: async () => 10,
    },
    pxe: {},
    token: { address: tokenAddress },
    portal: {
      address: portalAddress,
      client,
      getTxAmountCap: async () => 10n ** 24n,
      getUnderlying: async () => EthAddress.fromString(addr("55")),
      getL2Token: async () => tokenAddress,
      getRollup: async () => rollup,
      getRollupVersion: async () => 1n,
      isFrozen: async () => true,
    },
    rollup: rollup.toString(),
    rollupVersion: 1n,
    owner,
    resolveSpendMetadata: async () => ({ masterNullifierHidingKey: new Fr(9n) }),
    depositMetadata: { ownerAddressPreimage: { address: owner.address } },
    depositDescriptors: async () => [],
    executor: EthAddress.fromString(PLAIN),
    tipRecipient: EthAddress.fromString(addr("0e")),
    ...(migration ? { migration } : {}),
    ...over,
  }
  return { runtime: new FrozenRefundMigrationRuntime(options as never), client, options }
}

const NOTE_ID = new Fr(11n).toString()

describe("migrationRouteFor", () => {
  const deployment = (variables: Record<string, string>) => ({
    bridges: [{ id: "brg-susds-v6", portal: DEST }],
    features: [
      {
        id: "fea-migration-susds",
        project: "migration",
        bridges: { destination: "brg-susds-v6" },
        contracts: { migrationExecutor: EXECUTOR, migrationExecutorSubsidy: SUBSIDY },
        variables,
      },
    ],
  })

  it("takes the executor route when the destination publishes a feature for the source portal", () => {
    const found = migrationRouteFor(
      deployment({
        sourcePortal: SOURCE.toUpperCase().replace("0X", "0x"),
        payoutToken: DAI,
      }) as never,
      SOURCE,
      DEST,
      OPERATION_EXECUTOR,
    )
    expect(found).toEqual(route)
  })

  it("keeps the plain route for a source without a feature, or with no destination deployment", () => {
    expect(
      migrationRouteFor(
        deployment({ sourcePortal: addr("99"), payoutToken: DAI }) as never,
        SOURCE,
        DEST,
        OPERATION_EXECUTOR,
      ),
    ).toBeUndefined()
    expect(
      migrationRouteFor({ bridges: [] } as never, SOURCE, DEST, OPERATION_EXECUTOR),
    ).toBeUndefined()
    expect(migrationRouteFor(undefined, SOURCE, DEST, OPERATION_EXECUTOR)).toBeUndefined()
  })

  it("refuses a feature that deposits into another portal", () => {
    expect(() =>
      migrationRouteFor(
        deployment({ sourcePortal: SOURCE, payoutToken: DAI }) as never,
        SOURCE,
        addr("01"),
        OPERATION_EXECUTOR,
      ),
    ).toThrow("does not deposit into the destination portal")
  })
})

describe("FrozenRefundMigrationRuntime on the migration route", () => {
  it("refuses a tip on a commitment refund", async () => {
    const { runtime } = makeRuntime(route)
    await expect(
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 1n),
    ).rejects.toThrow("pays no relayer tip")
  })

  it("refuses an address on a source with no plain withdrawal executor", async () => {
    const { runtime } = makeRuntime(route, { executor: EthAddress.ZERO })
    await expect(runtime.build({ kind: "note", ids: [NOTE_ID] }, addr("33"), 0n)).rejects.toThrow(
      "This source has no plain withdrawal executor, so it cannot refund to an address",
    )
  })

  it("refuses a commitment on a source with no route", async () => {
    const { runtime } = makeRuntime()
    await expect(
      runtime.build({ kind: "note", ids: [NOTE_ID] }, { recipientCommitment: COMMITMENT }, 0n),
    ).rejects.toThrow(
      "No migration route serves this source, so it cannot refund under a commitment",
    )
  })

  it("keeps one identity whether the destination adds, changes or removes the route", () => {
    const plain = makeRuntime().runtime.identity
    expect(makeRuntime(route).runtime.identity).toBe(plain)
    expect(
      makeRuntime({ ...route, executor: addr("01"), subsidy: addr("02") }).runtime.identity,
    ).toBe(plain)
  })
})

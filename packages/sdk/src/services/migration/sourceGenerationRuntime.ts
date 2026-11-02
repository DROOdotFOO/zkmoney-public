import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { buildMigrationOperation } from "@oxide/oxide-client/migration_operation.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { buildMigrationExecutorCall } from "@oxide/oxide-lib/migration_executor.js"
import type {
  FrozenRefundKind,
  SourceExecutorCall,
  SourceRefundRuntime,
} from "@obsidion/core/types"
import type { PublicClient } from "viem"
import { sameAddress } from "../../oxide/address.js"
import type {
  FrozenMigrationRuntime,
  FrozenRefundRecipient,
  MigrationExecutorRoute,
} from "./FrozenMetadataMigrationSource.js"
import { MigrationSubsidyReader } from "./migrationSubsidy.js"

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/

const hex = (bytes: Buffer) => `0x${bytes.toString("hex")}`

/** The destination's migration route for a source generation's portal, and the L1 client that reads its subsidy. */
export interface SourceGenerationMigration {
  route: MigrationExecutorRoute
  client: Pick<PublicClient, "readContract" | "getBlock" | "getGasPrice" | "getCode">
}

/**
 * A source generation's refund runtime, read back into this release's types. This side selects
 * the executor call of each refund by its recipient's kind, on every call. An address refunds
 * through the source's plain withdrawal executor, in the encoding that the generation gives,
 * whether or not a route exists, and the operation calls the old portal. A commitment refunds
 * through the `migration` route's `MigrationExecutor` with no tip, and the operation calls the
 * route's subsidy; without a route it is refused. Before a commitment refund is proven, the
 * subsidy must pay a refund of the selection's amount, read from the candidates.
 */
export function frozenRuntimeFromSourceGeneration(
  source: SourceRefundRuntime,
  beforeBuild?: () => void,
  migration?: SourceGenerationMigration,
): FrozenMigrationRuntime {
  const route = migration?.route
  const reader = migration && new MigrationSubsidyReader(migration.client, migration.route.subsidy)
  const subsidy = () => {
    if (!reader) throw new Error("This source has no migration route")
    return reader
  }
  const executorCall = async (
    recipient: FrozenRefundRecipient,
    relayerTip: bigint,
  ): Promise<SourceExecutorCall> => {
    if (typeof recipient !== "string") {
      if (!route)
        throw new Error(
          "No migration route serves this source, so it cannot refund under a commitment",
        )
      if (relayerTip !== 0n) throw new Error("A migration refund pays no relayer tip")
      const call = buildMigrationExecutorCall({
        executor: EthAddress.fromString(route.executor),
        recipientCommitment: recipient.recipientCommitment,
      })
      return {
        executor: call.executor.toString(),
        userPayload: hex(call.userPayload),
        relayerPayload: hex(call.relayerPayload),
      }
    }
    const call = await source.plainExecutorCall(recipient, relayerTip.toString())
    if (![call.userPayload, call.relayerPayload].every((payload) => HEX.test(payload)))
      throw new Error("The source generation returned a malformed executor call")
    return call
  }
  /** What `selection` refunds, from the generation's candidates. Throws when one is gone. */
  const selectionAmount = async (selection: { kind: FrozenRefundKind; ids: string[] }) => {
    const { candidates } = await source.candidates()
    const available = new Map(
      candidates.filter((c) => c.kind === selection.kind).map((c) => [c.id, BigInt(c.amount)]),
    )
    if (!selection.ids.length || selection.ids.some((id) => !available.has(id)))
      throw new Error("A selected frozen refund is no longer refundable")
    return selection.ids.reduce((sum, id) => sum + available.get(id)!, 0n)
  }
  return {
    // The route is bound per batch (`direct.executor`, `direct.subsidy`), never here: a route
    // change then re-plans unsent batches instead of halting the run.
    identity: source.identity,
    ...(route ? { migration: route } : {}),
    validate: async (destinationAsset) => {
      await source.validate(destinationAsset)
      if (!route) return
      await subsidy().assertServes(route)
    },
    candidates: async (opts) => {
      const { waiting, ...read } = await source.candidates(opts)
      return {
        ...read,
        maxBatchAmount: BigInt(read.maxBatchAmount),
        ...(waiting === undefined ? {} : { waiting: BigInt(waiting) }),
      }
    },
    build: async (selection, recipient, relayerTip) => {
      if (relayerTip < 0n) throw new Error("Frozen refund cannot cover its relayer tip")
      // A commitment refund's subsidy must pay it: checked before any prompt or proof.
      const checked =
        typeof recipient !== "string" && route ? await selectionAmount(selection) : undefined
      if (checked !== undefined) await subsidy().check(selection.kind, checked, false)
      beforeBuild?.()
      const built = await source.build(selection, await executorCall(recipient, relayerTip))
      const { target, payoutToken, calldata } = built.operation
      if (!HEX.test(calldata)) throw new Error("The source generation returned malformed calldata")
      // The generation does not read the payloads, so the tip is checked here.
      const amount = BigInt(built.amount)
      if (amount <= relayerTip) throw new Error("Frozen refund cannot cover its relayer tip")
      if (typeof recipient !== "string" && route) {
        if (!sameAddress(target, route.sourcePortal))
          throw new Error("The source generation's refund does not call the route's source portal")
        if (amount !== checked)
          throw new Error("The source generation's refund amount is not the selection's amount")
        return {
          amount,
          operation: buildMigrationOperation({
            subsidy: EthAddress.fromString(route.subsidy),
            payoutToken: EthAddress.fromString(route.payoutToken),
            calldata: calldata as `0x${string}`,
          }),
        }
      }
      return {
        amount,
        operation: {
          target: EthAddress.fromString(target),
          payoutToken: EthAddress.fromString(payoutToken),
          calldata: Buffer.from(calldata.slice(2), "hex"),
          condition: L1OperationCondition.immediate(),
        },
      }
    },
    refunded: (ids) => source.refunded(ids),
    ...(route
      ? {
          assertMigrationReady: (selection: { kind: FrozenRefundKind }, amount: bigint) =>
            subsidy().check(selection.kind, amount, true),
          minimumMigratedAmount: async (opts: { fresh?: boolean } = {}) =>
            (await (opts.fresh ? subsidy().fresh() : subsidy().read())).config.minMigratedAmount,
        }
      : {}),
  }
}

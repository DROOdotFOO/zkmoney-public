import {
  canMigrate,
  MigrationFlow,
  migrationSubsidyStatus,
  readMigrationSubsidyState,
  readMigrationSubsidyTerms,
  type MigrationSubsidyStatus,
  type MigrationSubsidyTerms,
} from "@oxide/l1-contracts/migration.js"
import { MigrationExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { migratedAmount } from "@oxide/oxide-lib/migration_executor.js"
import type { FrozenRefundKind } from "@obsidion/core/types"
import { keccak256, type Address, type PublicClient } from "viem"
import { sameAddress } from "../../oxide/address.js"
import {
  MigrationSubsidyNotReadyError,
  type MigrationExecutorRoute,
} from "./FrozenMetadataMigrationSource.js"

/** The executor flow of a refund of `kind`. */
export function migrationFlowOf(kind: FrozenRefundKind): MigrationFlow {
  switch (kind) {
    case "frozen-deposit":
      return MigrationFlow.FrozenDepositsRefund
    case "unprocessed-deposit":
      return MigrationFlow.UnprocessedDepositRefund
    default:
      return MigrationFlow.FrozenNotesRefund
  }
}

/**
 * One runtime's view of a migration subsidy. The terms (immutables, ceilings, feed) are read once
 * and kept. The state (balance, config, frozen flag, feed answer) is read with them on first use,
 * and again on a fresh read, as one multicall when the client has one.
 */
export class MigrationSubsidyReader {
  private terms?: Promise<MigrationSubsidyTerms>
  private status?: Promise<MigrationSubsidyStatus>
  private codeHash?: Promise<string>
  private executorTerms?: Promise<{
    subsidy: Address
    sourcePortal: Address
    destinationPortal: Address
  }>

  constructor(
    private readonly client: Pick<
      PublicClient,
      "readContract" | "getBlock" | "getGasPrice" | "getCode"
    > &
      Partial<Pick<PublicClient, "multicall" | "chain">>,
    private readonly subsidy: Address,
  ) {}

  /**
   * The client the state is read with. viem's `multicall` needs the chain's Multicall3 address,
   * which a local chain such as viem's `foundry` does not carry; a client without one reads the
   * state as one call per value instead of throwing.
   */
  private stateClient(): Parameters<typeof readMigrationSubsidyState>[0] {
    const client = this.client
    if (client.multicall && client.chain?.contracts?.multicall3) return client
    return { readContract: client.readContract.bind(client) }
  }

  /**
   * Throws unless the subsidy serves `route`: its executor, its old and new portals, its payout
   * token, and the code of the destination's operation executor, which is the only caller it pays.
   * The executor must also name this subsidy and the same portals. It reads only immutable values,
   * each one time: the subsidy's terms, the executor's terms and the code hash.
   */
  async assertServes(route: MigrationExecutorRoute): Promise<void> {
    const terms = await this.readTerms()
    if (
      !sameAddress(terms.executor, route.executor) ||
      !sameAddress(terms.sourcePortal, route.sourcePortal) ||
      !sameAddress(terms.destinationPortal, route.destinationPortal) ||
      !sameAddress(terms.token, route.payoutToken)
    )
      throw new Error("The migration subsidy does not serve this source and destination")
    const executor = await this.readExecutorTerms(route.executor)
    if (
      !sameAddress(executor.subsidy, this.subsidy) ||
      !sameAddress(executor.sourcePortal, route.sourcePortal) ||
      !sameAddress(executor.destinationPortal, route.destinationPortal)
    )
      throw new Error("The migration executor does not use this subsidy, source and destination")
    if (!this.codeHash) {
      const pending = this.client
        .getCode({ address: route.operationExecutor })
        .then((code) => (code && code !== "0x" ? keccak256(code) : "0x"))
      pending.catch(() => {
        if (this.codeHash === pending) this.codeHash = undefined
      })
      this.codeHash = pending
    }
    if (!sameAddress(await this.codeHash, terms.operationExecutorCodeHash))
      throw new Error("The migration subsidy does not pay the relayer of this deployment")
  }

  /** The `MigrationExecutor`'s subsidy and portals, read one time. They never change. */
  private readExecutorTerms(executor: Address) {
    if (!this.executorTerms) {
      const read = (functionName: "SUBSIDY" | "SOURCE_PORTAL" | "DESTINATION_PORTAL") =>
        this.client.readContract({
          address: executor,
          abi: MigrationExecutorAbi,
          functionName,
        }) as Promise<Address>
      const pending = Promise.all([
        read("SUBSIDY"),
        read("SOURCE_PORTAL"),
        read("DESTINATION_PORTAL"),
      ]).then(([subsidy, sourcePortal, destinationPortal]) => ({
        subsidy,
        sourcePortal,
        destinationPortal,
      }))
      pending.catch(() => {
        if (this.executorTerms === pending) this.executorTerms = undefined
      })
      this.executorTerms = pending
    }
    return this.executorTerms
  }

  /** The subsidy's terms, read once. */
  private readTerms(): Promise<MigrationSubsidyTerms> {
    if (!this.terms) {
      const pending = readMigrationSubsidyTerms(this.client, this.subsidy)
      pending.catch(() => {
        if (this.terms === pending) this.terms = undefined
      })
      this.terms = pending
    }
    return this.terms
  }

  /** The status the runtime keeps, read on first use. */
  read(): Promise<MigrationSubsidyStatus> {
    if (!this.status) this.keep(this.fresh())
    return this.status!
  }

  /** The kept terms with the state read now, as before a broadcast. */
  async fresh(): Promise<MigrationSubsidyStatus> {
    const terms = await this.readTerms()
    const status = migrationSubsidyStatus(
      terms,
      await readMigrationSubsidyState(this.stateClient(), terms),
    )
    this.keep(Promise.resolve(status))
    return status
  }

  /**
   * Throws {@link MigrationSubsidyNotReadyError} with oxide's `canMigrate` reasons unless the
   * subsidy pays the relayer of a refund of `kind` and `amount`, at the latest block's gas price
   * and time. `fresh` reads the state again first. A check on the kept state that fails reads the
   * state once again before it throws, so a pot funded or a feed updated since clears it.
   */
  async check(kind: FrozenRefundKind, amount: bigint, fresh: boolean): Promise<void> {
    const [status, block, gasPriceWei] = await Promise.all([
      fresh ? this.fresh() : this.read(),
      this.client.getBlock({ blockTag: "latest" }),
      this.client.getGasPrice(),
    ])
    const evaluate = (s: MigrationSubsidyStatus) =>
      canMigrate(s, {
        flow: migrationFlowOf(kind),
        migratedAmount: migratedAmount(amount, 0n),
        gasPriceWei,
        ...(block.baseFeePerGas == null ? {} : { baseFeeWei: block.baseFeePerGas }),
        nowSeconds: block.timestamp,
      })
    let result = evaluate(status)
    if (!result.ok && !fresh) result = evaluate(await this.fresh())
    if (!result.ok) throw new MigrationSubsidyNotReadyError(result.reasons)
  }

  private keep(pending: Promise<MigrationSubsidyStatus>) {
    pending.catch(() => {
      if (this.status === pending) this.status = undefined
    })
    this.status = pending
  }
}

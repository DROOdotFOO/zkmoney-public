import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash, TxStatus, TxExecutionResult } from "@aztec-labs/stdlib/tx"
import type { BlockParameter } from "@aztec-labs/stdlib/block"
import type { FunctionCall } from "@aztec-labs/stdlib/abi"
import {
  encodeUserRecordMetadata,
  readMetadataStateHash,
  readNameOf,
  getBootstrapOwner,
  userRecordStateHash,
  type R1PublicKeyArg,
  type UserRecordArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import { readRecordUpdateResult } from "@oxide/oxide-client/record_update.js"
import { keccak256, toHex, type Address, type Hex } from "viem"
import {
  checkRecordUpdate,
  MigrationHaltedError,
  prepareRecordUpdate,
  readMetadataDestinationState,
  restoreRecordUpdate,
  serializeRecordUpdate,
  StalePlanError,
  type PreparedRecordUpdate,
  type RecordUpdateContext,
} from "./metadataMigration.js"
import {
  prepareMigrationBootstrap,
  claimFpcIdentitySubscribed,
  claimFpcRegistrationSubscribed,
  type MigrationBootstrapOptions,
} from "./migrationBootstrap.js"
import {
  buildClaimSubscribePayload,
  buildClaimSponsorPayload,
  type RegistrationWitness,
} from "../../feePaymentMethod/claimFpc/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../../feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import { claimFpcSubscriptionUses, hasClaimFpcSubscription } from "../claimFpc/claimSponsor.js"
import { findRegistrationMessage, registrationInbox } from "../name/registrationMessage.js"
import {
  migrationDepositCalls,
  migrationSipaCoordinates,
  resolveMigrationDeposit,
  type MigrationDestinationContext,
} from "./migrationDeposit.js"

/**
 * Runs one step that sends one transaction, as the operation it names to the step. The host uses it
 * to send each transaction in its turn on the prover. The default runs the step immediately.
 */
export type MigrationSendGate = <T>(step: (operationId?: string) => Promise<T>) => Promise<T>

/** A source generation supplies public DTOs; its Aztec objects/prover never cross into this SDK. */
export interface MetadataMigrationSource {
  /** Includes source rollup, portal, asset and proof generation. */
  identity: string
  /**
   * The source moves only funds, never the record update: its run is a recovery-only run, as with
   * {@link MetadataMigrationServiceOptions.recoveryOnly}. Every frozen source is funds-only.
   */
  readonly fundsOnly?: boolean
  /** Read actual source state. A source that is not frozen moves nothing. */
  state(): Promise<"frozen" | "empty">
  /** Send every planned batch once recurring sponsorship exists. It sends each transaction inside `gate`. */
  recoverRemaining(signal?: AbortSignal, gate?: MigrationSendGate): Promise<void>
  /**
   * Plan and prove every batch inside the user's action, so recovery only sends. A source without it
   * plans each batch during recovery. It chooses its batches by its own minimum.
   */
  prepareRemaining?(opts: {
    /** Coordinates that the run's plan already uses. */
    reserved?: { day: number; nonce: number }[]
    signal?: AbortSignal
    onApproval?: (approved: number, total: number) => Promise<void>
  }): Promise<void>
  /** Whether every planned batch has been sent. */
  remainingSent?(): Promise<boolean>
  /**
   * Bring every sent batch up to date from chain evidence. It asks no approval. It can send again
   * a broadcast that a relayer did not run in time, byte for byte as first sent. A cancelled
   * `signal` stops it before a send records a new hash. It sends each transaction inside `gate`.
   */
  reconcileRemaining?(signal?: AbortSignal, gate?: MigrationSendGate): Promise<void>
  remainingComplete(): Promise<boolean>
  /** What a run moves from here now, by the rules its batches apply. */
  quote?(): Promise<MigrationSourceQuote>
  /** Everything the source holds for the account. */
  holdings?(): Promise<bigint>
}

/** Funds still on the source, read from chain. A refund counts until it executes on L1. */
export interface MigrationSourceQuote {
  /** What a run moves now. */
  movable: bigint
  /** What no batch can afford. */
  stranded: bigint
  /** What the source can't refund yet. */
  waiting: bigint
  /** How many refund batches move it. */
  batches?: number
  /**
   * Approvals a run asks for: the record update until it settles, and one per batch that asks one.
   * A source's own quote counts only its batches.
   */
  approvals?: number
  /** What the batches pay. A frozen batch pays no fee and no relayer tip. */
  fees?: bigint
}

type FpcOptions = MigrationBootstrapOptions["fpc"]

export interface MetadataMigrationServiceOptions
  extends Omit<MigrationDestinationContext, "node" | "recipient" | "recoveryAccount"> {
  wallet: MigrationBootstrapOptions["wallet"]
  /** Ordinary deposits can preserve an asset after the fee-token registration update. */
  depositDestination?: MigrationDestinationContext["destination"]
  /**
   * Another run establishes registration; prepare only the source's batches. A source with
   * `fundsOnly` runs so too, and waits for registration as an asset recovery does.
   */
  recoveryOnly?: boolean
  /** The registered OxideAccount; it recovers every migration SIPA. */
  owner: Address
  record: UserRecordArg
  source: MetadataMigrationSource
  bootstrap: FpcOptions
  registered: FpcOptions
  nameClaim(): Promise<
    Extract<MigrationBootstrapOptions["sponsorship"], { kind: "bootstrap" }>["gate"]
  >
  /** The registration gate's key witnesses for the account's bootstrap key and `nameHash`. */
  registrationKeyProof(nameHash: Hex): Omit<RegistrationWitness, "leafIndex">
  /** The installed passkey that signs the record update. */
  recordPasskey: R1PublicKeyArg
  /** Signs a record update's `userOpHash`; an approval holds only over `expectedStateHash`. */
  signRecordUpdate(userOpHash: Hex, expectedStateHash: Hex): Promise<WebAuthnAuthArg>
  /** Scan bound captured before publication, persisted with the signed plan. */
  fromBlock?: bigint
  /** Whether a balance read begun now is stored. Absent: an import is enough. */
  confirmBalance?(): Promise<boolean>
}

/** What a preparation saves before it signs, so resuming it asks for the same approvals. */
interface Draft {
  day: number
  nonce: number
}

interface Plan {
  /** This source follows the registration run and only moves funds. */
  recoveryOnly?: boolean
  binding: string
  day: number
  nonce: number
  fromBlock: string
  sourceState: "frozen" | "empty"
  /** The signed record update; absent when the destination record was already current. */
  recordUpdate?: string
}

/** Contract adapter used by the shared front-core durable driver. No L1 writes or relayer requests. */
export class MetadataMigrationService {
  private prepared?: { plan: string; batch: Awaited<ReturnType<typeof prepareMigrationBootstrap>> }
  constructor(private readonly options: MetadataMigrationServiceOptions) {}

  private get deposits(): MigrationDestinationContext {
    const o = this.options
    return {
      ...o,
      destination: o.depositDestination ?? o.destination,
      node: o.wallet.node,
      recipient: o.registered.user,
      recoveryAccount: o.owner,
    }
  }

  private get recordContext(): RecordUpdateContext {
    const o = this.options
    return {
      client: o.client,
      destination: o.destination,
      owner: o.owner,
      record: o.record,
      fpc: o.bootstrap.fpcAddress,
    }
  }

  async needsMigration(): Promise<boolean> {
    const o = this.options
    const name = await readNameOf(o.client, o.destination.nameRegistry, o.owner)
    if (/^0x0+$/.test(name)) return false
    return (
      (await readMetadataStateHash(o.client, o.destination.controller, o.owner)) !==
      userRecordStateHash(o.record)
    )
  }

  /** Whether this run moves only funds: another run updates the record, or the source moves only funds. */
  private get fundsOnly(): boolean {
    return !!this.options.recoveryOnly || !!this.options.source.fundsOnly
  }

  /** This asset settles on another bridge than the fee token's, which carries registration. */
  private separateAsset(): boolean {
    const o = this.options
    return (
      !!o.depositDestination &&
      o.depositDestination.token.toLowerCase() !== o.destination.token.toLowerCase()
    )
  }

  async binding(): Promise<string> {
    const o = this.options
    return keccak256(
      toHex(
        JSON.stringify({
          source: o.source.identity,
          destination: Object.values(o.destination).map(String),
          ...(o.depositDestination
            ? { depositDestination: Object.values(o.depositDestination).map(String) }
            : {}),
          owner: o.owner,
          record: encodeUserRecordMetadata(o.record),
          fpc: o.bootstrap.fpcAddress.toString(),
          bootstrap: o.bootstrap.railId,
          registered: o.registered.railId,
        }),
      ),
    )
  }

  /**
   * Prepare from `draft` when one was saved, else from new coordinates. `saveDraft` persists each step
   * before the approval that follows it; `signal` stops before each approval and before returning.
   */
  async prepare(
    draft?: string,
    saveDraft?: (draft: string) => Promise<void>,
    signal?: AbortSignal,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<string> {
    const o = this.options
    if (!o.bootstrap.fpcAddress.equals(o.registered.fpcAddress)) {
      throw new Error("Bootstrap and recurring rails must belong to the same destination FPC")
    }
    if (!o.bootstrap.user.equals(o.registered.user)) {
      throw new Error("Bootstrap and recurring sponsorship must name the same destination account")
    }
    const info = await o.wallet.node.getNodeInfo()
    if (BigInt(info.rollupVersion) !== o.destination.rollupVersion) {
      throw new Error("The wallet is connected to a different destination rollup")
    }
    const saved: Draft = draft ? (JSON.parse(draft) as Draft) : migrationSipaCoordinates()
    if (!draft) await saveDraft?.(JSON.stringify(saved))
    const sourceState = await o.source.state()
    const plan = async (extra: Pick<Plan, "recoveryOnly" | "recordUpdate">): Promise<string> =>
      JSON.stringify({
        binding: await this.binding(),
        day: saved.day,
        nonce: saved.nonce,
        fromBlock: String(o.fromBlock ?? (await o.client.getBlockNumber())),
        sourceState,
        ...extra,
      } satisfies Plan)
    if (this.fundsOnly || this.separateAsset()) {
      if (sourceState !== "frozen") throw new Error("Asset recovery requires a frozen source")
      await this.prepareLater(saved, signal, onApproval)
      return plan({ recoveryOnly: true })
    }
    // The run with no source updates the record; a frozen source moves only funds.
    if (sourceState === "frozen")
      throw new Error("A frozen source moves only funds; it cannot update the record")
    const consent = await this.consentApprovals()
    await onApproval?.(0, consent)
    signal?.throwIfAborted()
    const signed = consent
      ? await prepareRecordUpdate({
          ...this.recordContext,
          passkey: o.recordPasskey,
          sign: o.signRecordUpdate,
        })
      : undefined
    await onApproval?.(consent, consent)
    signal?.throwIfAborted()
    // Preparing the real payload also checks the rails and the call budget before front-core
    // persists the plan. It does not prove or submit a transaction.
    const prepared = signed && (await this.bootstrap(signed))
    const raw = await plan(signed ? { recordUpdate: serializeRecordUpdate(signed) } : {})
    this.prepared = prepared ? { plan: raw, batch: prepared } : undefined
    return raw
  }

  /** The record update counts as an approval until the destination record is current. */
  async consentApprovals(): Promise<number> {
    return (await this.bootstrapSkipped()) ? 0 : 1
  }

  /** Plan and prove every batch, beside the plan's own coordinates. */
  private async prepareLater(
    plan: Pick<Plan, "day" | "nonce">,
    signal?: AbortSignal,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ) {
    const o = this.options
    if (!o.source.prepareRemaining) return
    await o.source.prepareRemaining({
      reserved: [{ day: plan.day, nonce: plan.nonce }],
      signal,
      onApproval,
    })
  }

  /**
   * The user's own step before anything else is sent: rebuild from saved approvals what the next
   * publication needs, approve any planned batch whose approval is missing, and plan and prove funds
   * that reached the source since. A cancel during it sends nothing.
   */
  async ready(
    raw: string,
    signal?: AbortSignal,
    published = false,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<void> {
    const plan = await this.restore(raw)
    if (!published && plan.recordUpdate) {
      const signed = await this.fresh(plan)
      signal?.throwIfAborted()
      if (this.prepared?.plan !== raw)
        this.prepared = { plan: raw, batch: await this.bootstrap(signed) }
    }
    signal?.throwIfAborted()
    // The plan's state is a snapshot: a source empty at preparation can hold refundable funds now.
    await this.prepareLater(plan, signal, onApproval)
  }

  private async restore(raw: string): Promise<Plan> {
    const plan = JSON.parse(raw) as Plan & { intentData?: Hex; sourceBatch?: string }
    if (plan.binding !== (await this.binding()))
      throw new Error("Migration account or deployment changed")
    if (plan.recoveryOnly) {
      // A funds-only plan may carry empty metadata fields.
      if (
        plan.sourceState !== "frozen" ||
        plan.recordUpdate ||
        plan.sourceBatch ||
        (plan.intentData ?? "0x") !== "0x"
      )
        throw new Error("Stored asset recovery does not match the destination")
      return plan
    }
    // A plan that signed a metadata-update SIPA, which this wallet no longer sends.
    if (plan.intentData !== undefined)
      throw new StalePlanError("This upgrade was prepared by an earlier version; prepare it again")
    return plan
  }

  /** The plan's signed record update, checked against the chain before it is published. */
  private async fresh(plan: Plan): Promise<PreparedRecordUpdate> {
    const signed = await restoreRecordUpdate(plan.recordUpdate!, this.recordContext)
    return checkRecordUpdate(this.options.client, this.options.destination, signed)
  }

  /** A current destination record with recurring sponsorship needs no bootstrap: recovery only moves funds. */
  private async bootstrapSkipped(): Promise<boolean> {
    const o = this.options
    return (
      (await this.recurring()) &&
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) ===
        userRecordStateHash(o.record)
    )
  }

  /** What a run moves from the source now, by the rules its batches apply. A frozen batch pays no fee. */
  async quote(): Promise<MigrationSourceQuote> {
    const o = this.options
    if (!o.source.quote) throw new Error("This migration source cannot quote its funds")
    const quote = await o.source.quote()
    return { ...quote, approvals: quote.approvals ?? quote.batches, fees: 0n }
  }

  async movable(): Promise<boolean> {
    return (await this.quote()).movable > 0n
  }

  /** What the source holds for the account, or undefined when it can't say. */
  async holdings(): Promise<bigint | undefined> {
    return this.options.source.holdings?.()
  }

  /** Whether the balance holds everything the run imported, so the run may be done. */
  async confirmBalance(): Promise<boolean> {
    return (await this.options.confirmBalance?.()) ?? true
  }

  private async recurring(): Promise<boolean> {
    const o = this.options
    if (
      (await claimFpcSubscriptionUses(
        o.wallet,
        o.registered.fpcAddress,
        o.registered.fpcArtifact,
        o.registered.user,
        o.registered.railId,
      )) > 0
    )
      return true
    if (
      !(await hasClaimFpcSubscription(
        o.wallet,
        o.registered.fpcAddress,
        o.registered.fpcArtifact,
        o.registered.user,
        o.registered.railId,
      ))
    )
      return false
    // A zero-use note may refill. Ask the contract through a read-only sponsor simulation,
    // using its actual anchor and policy instead of duplicating the refill calculation.
    const innerCalls = await this.receiveCalls(0, 0)
    const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
    try {
      await o.wallet.simulateTx(payload, {
        from: NO_FROM,
        additionalScopes: [o.registered.user],
        fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
      })
      return true
    } catch (error) {
      if (String(error).includes("allowance exhausted")) return false
      throw error
    }
  }

  private async bootstrap(recordUpdate: PreparedRecordUpdate) {
    const o = this.options
    const recurring = await this.recurring()
    return prepareMigrationBootstrap({
      wallet: o.wallet,
      recordUpdate,
      broadcaster: o.broadcaster,
      sponsorship: recurring
        ? { kind: "registered" }
        : { kind: "bootstrap", gate: await o.nameClaim() },
      fpc: recurring ? o.registered : o.bootstrap,
    })
  }

  async broadcast(
    raw: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void> {
    const o = this.options
    const plan = await this.restore(raw)
    if (plan.recoveryOnly) throw new Error("Asset recovery cannot broadcast a record update")
    if (!plan.recordUpdate)
      throw new StalePlanError("The destination record changed; prepare the upgrade again")
    const signed = await this.fresh(plan)
    // Reuse every collected signature in this process. A cold restart re-creates only the
    // unpublished L2 transaction; the signed record update stays in the plan on disk.
    const prepared =
      this.prepared?.plan === raw ? this.prepared.batch : await this.bootstrap(signed)
    await o.wallet.sendTx(prepared.payload, {
      ...prepared.sendOptions,
      operationId,
      onTxHash: async (hash) => {
        await checkRecordUpdate(o.client, o.destination, signed)
        await onTxHash(hash)
      },
    })
  }

  private async attestation(fromBlock: bigint) {
    const o = this.options
    const info = await o.wallet.node.getNodeInfo()
    const nameHash = await readNameOf(o.client, o.destination.nameRegistry, o.owner)
    const message = await findRegistrationMessage(
      registrationInbox(o.client, info.l1ContractAddresses.inboxAddress),
      o.wallet.node,
      {
        fpc: o.registered.fpcAddress,
        namePortal: EthAddress.fromString(o.destination.namePortal),
        bootstrap: EthAddress.fromString(await getBootstrapOwner(o.client, o.owner)),
        nameHash: Buffer.from(nameHash.slice(2), "hex"),
        rollupVersion: info.rollupVersion,
        l1ChainId: Number(o.destination.chainId),
      },
      { fromBlock },
    )
    return { message, nameHash }
  }

  /**
   * Whether the destination record is the upgrade's. A published record update settles once it
   * ran and its record holds. Before the registered subscription exists, so before any refund is
   * sent, an update that can no longer run stops the run.
   */
  private async metadataSettled(
    plan: Plan,
    published: boolean,
    subscribed: boolean,
  ): Promise<boolean> {
    const o = this.options
    const current =
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) ===
      userRecordStateHash(o.record)
    if (!plan.recordUpdate || !published) return current
    const { update } = await restoreRecordUpdate(plan.recordUpdate, this.recordContext)
    const read = () =>
      readRecordUpdateResult(o.client, update, { fromBlock: BigInt(plan.fromBlock) })
    let result = await read()
    // The reader reads the logs, then the nonce: an update that lands between them reads as not run
    // with its nonce used. Read after the nonce moved, its logs show it.
    if (result.status === "not-run" && result.nonceUsed) result = await read()
    if (result.status === "succeeded" && (result.recordHeld || subscribed)) return true
    if (subscribed && current) return true
    if (result.status === "not-run" && !result.nonceUsed) return false
    throw new MigrationHaltedError(
      "reverted",
      result.status === "failed"
        ? "The upgrade's record update failed on Ethereum"
        : "The account's record changed before the upgrade's record update held",
    )
  }

  async observe(record: { plan?: string; bootstrapTx?: string; subscriptionTx?: string }) {
    const o = this.options
    if (!record.plan) throw new Error("Migration has no prepared plan")
    const plan = await this.restore(record.plan)
    const recurringSponsorship = await this.recurring()
    const metadataSettled = plan.recoveryOnly
      ? (await readMetadataDestinationState(o.client, o.destination, o.owner)) ===
        userRecordStateHash(o.record)
      : await this.metadataSettled(
          plan,
          !!record.bootstrapTx,
          // Spent allowance only holds sending back: the subscription still shows refunds may be out.
          recurringSponsorship ||
            (await hasClaimFpcSubscription(
              o.wallet,
              o.registered.fpcAddress,
              o.registered.fpcArtifact,
              o.registered.user,
              o.registered.railId,
            )),
        )
    const { message } = plan.recoveryOnly
      ? { message: undefined }
      : await this.attestation(BigInt(plan.fromBlock))
    return {
      bootstrapStatus: await this.txState(record.bootstrapTx),
      subscriptionStatus: await this.txState(record.subscriptionTx),
      bootstrapSpent: await claimFpcIdentitySubscribed(
        o.wallet.node,
        o.bootstrap.fpcAddress,
        o.owner,
        o.bootstrap.railId,
      ),
      metadataSettled,
      messagesReady: metadataSettled && (message?.status === "ready" || recurringSponsorship),
      recurringSponsorship,
      sent: (await o.source.remainingSent?.()) ?? false,
      complete: metadataSettled && recurringSponsorship && (await o.source.remainingComplete()),
    }
  }

  private async txState(
    hash?: string,
  ): Promise<"unknown" | "pending" | "included" | "reverted" | "dropped" | undefined> {
    if (!hash) return undefined
    const receipt = await this.options.wallet.node.getTxReceipt(TxHash.fromString(hash))
    if (receipt.status === TxStatus.DROPPED) return "dropped"
    if (receipt.status === TxStatus.PENDING) return "pending"
    if (receipt.executionResult === TxExecutionResult.REVERTED) return "reverted"
    if (receipt.executionResult === TxExecutionResult.SUCCESS) return "included"
    return "unknown"
  }

  /**
   * Activate the registered rail. Another flow of the wallet, such as the deposit-address ledger, can subscribe the
   * account first: the run then sends nothing. The rail admits one subscription per key, so a key that subscribed
   * with no note this wallet holds for the account, once it has synced past that subscription, stops the run instead.
   */
  async subscribe(
    raw: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void> {
    const o = this.options
    const plan = await this.restore(raw)
    if (
      (await readMetadataDestinationState(o.client, o.destination, o.owner)) !==
      userRecordStateHash(o.record)
    ) {
      throw new Error("Destination metadata changed before sponsorship activation")
    }
    const { message, nameHash } = await this.attestation(BigInt(plan.fromBlock))
    if (message?.status !== "ready")
      throw new Error("The registration attestation is not available to subscribe")
    const keyProof = o.registrationKeyProof(nameHash)
    const subscribed = (block?: BlockParameter) =>
      claimFpcRegistrationSubscribed(
        o.wallet.node,
        o.registered.fpcAddress,
        keyProof.keyWitness,
        o.registered.railId,
        block,
      )
    if (await subscribed()) {
      // The note and the subscription are read at one anchor.
      const { value } = await o.wallet.getSnapshot(async () => ({
        held: await hasClaimFpcSubscription(
          o.wallet,
          o.registered.fpcAddress,
          o.registered.fpcArtifact,
          o.registered.user,
          o.registered.railId,
        ),
        seen: await subscribed(await (await o.wallet.pxe.getSyncedBlockHeader()).hash()),
      }))
      // An anchor that has not seen the subscription reads again on a later pass.
      if (value.held || !value.seen) return
      throw new Error(
        "The account's key already subscribed on the registered rail, and this wallet holds no subscription note for the account",
      )
    }
    // ClaimFPC requires at least one real batched call: publish the ordinary receive SIPA.
    const innerCalls = await this.receiveCalls(plan.day, plan.nonce)
    const payload = await buildClaimSubscribePayload({
      ...o.registered,
      innerCalls,
      gate: {
        kind: "registration",
        ...keyProof,
        leafIndex: new Fr(message.leafIndex),
      },
    })
    await o.wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: o.registered.user,
      additionalScopes: [o.registered.user],
      fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
      operationId,
      onTxHash,
    })
  }

  private async receiveCalls(day: number, nonce: number): Promise<FunctionCall[]> {
    return migrationDepositCalls(
      this.deposits,
      await resolveMigrationDeposit(this.deposits, day, nonce),
    )
  }

  /**
   * Bring the run's sent batches up to date from chain evidence, and send again each broadcast that
   * is due. It asks no approval. A cancelled `signal` stops it before a send records a new hash.
   * The source sends each transaction inside `gate`.
   */
  async reconcileRemaining(
    raw: string,
    signal?: AbortSignal,
    gate?: MigrationSendGate,
  ): Promise<void> {
    await this.restore(raw)
    await this.options.source.reconcileRemaining?.(signal, gate)
  }

  /** The source sends each transaction inside `gate`. */
  async recoverRemaining(
    raw: string,
    signal?: AbortSignal,
    gate?: MigrationSendGate,
  ): Promise<void> {
    await this.restore(raw)
    if (!(await this.recurring())) throw new Error("Recurring sponsorship is not available")
    await this.options.source.recoverRemaining(signal, gate)
  }
}

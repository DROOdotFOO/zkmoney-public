import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Contract, SimulateInteractionOptions } from "@aztec-labs/aztec.js/contracts"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ViemClient } from "@aztec-labs/ethereum/types"
import { OxidePortalContract, PlainWithdrawalSubsidyAbi } from "@oxide/l1-contracts"
import { resolveFreezeArchive } from "@oxide/oxide-client/archive_ref.js"
import { classifyDepositRefund } from "@oxide/oxide-client/deposit_refund_eligibility.js"
import { readUsdPerEth, weiToUSD } from "@oxide/oxide-client/eth_usd_price_feed.js"
import type {
  DepositSpendMetadata,
  NullificationEffectData,
  SpendMetadataResolver,
} from "@oxide/oxide-client/token_operations_collector.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { assertRefundOwner, signMigrationOf } from "@oxide/oxide-client/sign_migration.js"
import { computeNoteNullifier } from "@oxide/oxide-lib/hash.js"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { MAX_FROZEN_NOTES_PER_REFUND } from "@oxide/oxide-lib/oxide_constants.gen.js"
import { buildPlainExecutorCall } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { buildMigrationExecutorCall } from "@oxide/oxide-lib/migration_executor.js"
import { buildMigrationOperation } from "@oxide/oxide-client/migration_operation.js"
import type { RefundOwner } from "@oxide/oxide-lib/migration_signature.js"
import { keccak256, toHex, type Address, type PublicClient } from "viem"
import type { OxideDeployment } from "@obsidion/core/oxide"
import type { FrozenDepositDescriptor, FrozenRefundKind, OxideEnvTuple } from "@obsidion/core/types"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { ObsidionAccount } from "../../obsidion/alpha/account/ObsidionAccount.js"
import {
  WebAuthnAlphaAuthProvider,
  type SignChallengeOptions,
  type WebAuthnSignResult,
} from "../../obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import {
  FrozenMetadataMigrationSource,
  type FrozenMigrationRuntime,
  type FrozenRefundCandidates,
  type FrozenRefundRecipient,
  type FrozenRefundSelection,
  type MetadataMigrationSourceOptions,
  refundedDeposits,
  selectFrozenBatch,
  type MigrationExecutorRoute,
} from "./FrozenMetadataMigrationSource.js"
import { sameAddress } from "../../oxide/address.js"
import { migrationFeatureFor } from "../../oxide/portal/migrationFeature.js"
import { MigrationSubsidyReader } from "./migrationSubsidy.js"
import { TokenService } from "../token/TokenService.js"

/** The Aztec major version this runtime proves refunds for. Older sources need their own SDK realm. */
const SOURCE_AZTEC_MAJOR = "6"

/** The source PXE a fresh scan syncs before it may establish completion. */
type SourcePxe = Pick<ObsidionWallet["pxe"], "sync" | "getSyncedBlockHeader">

/** A payment link's escrow the account created, as the owner its notes refund under. */
export interface FrozenEscrow {
  owner: RefundOwner
  resolveSpendMetadata: SpendMetadataResolver
}

interface Options {
  node: AztecNode
  pxe: SourcePxe
  token: Contract
  portal: OxidePortalContract
  rollup: Address
  rollupVersion: bigint
  owner: RefundOwner
  resolveSpendMetadata: SpendMetadataResolver
  depositMetadata: DepositSpendMetadata
  /** The owner's swept deposits on the source portal. A failed or partial scan must throw. */
  depositDescriptors(opts: { fresh: boolean }): Promise<FrozenDepositDescriptor[]>
  /** The account's payment link escrows on the source rollup. A failed or partial scan must throw. */
  escrows?(opts: { fresh: boolean }): Promise<FrozenEscrow[]>
  teeSigner: RegisteredTeeSigner
  /**
   * The source deployment's plain withdrawal executor; it pays the tip and forwards the rest. It is
   * part of the identity on both routes, so adding, changing or removing the migration route does
   * not change the identity; the migration route names its own executor.
   */
  executor: EthAddress
  /** Paid the relayer tip: the destination's operation executor, which forwards it to the relayer. */
  tipRecipient: EthAddress
  /**
   * The destination's migration route for this source. Present: every refund deposits straight
   * into the destination portal through the route's executor, with no tip.
   */
  migration?: MigrationExecutorRoute
}

/** The alpha account's passkey as the owner a frozen refund authorizes with. */
export type RefundChallengeSigner = (
  challenge: Buffer,
  opts?: SignChallengeOptions,
) => Promise<WebAuthnSignResult>

/**
 * The owner carries the account's passkey set and signs with the provider's key, which must be a
 * member: any member authorizes a refund. `wrapSigner` lets the host reuse an approval it saved
 * for the same challenge.
 */
export async function passkeyRefundOwner(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  wrapSigner: (sign: RefundChallengeSigner) => RefundChallengeSigner = (sign) => sign,
): Promise<RefundOwner> {
  const auth = account.getAuthProvider()
  if (!(auth instanceof WebAuthnAlphaAuthProvider))
    throw new Error("A frozen refund is authorized with the account's passkey")
  const signChallenge = wrapSigner((challenge, opts) => auth.signChallenge(challenge, opts))
  const address = account.getAddress()
  const instance = await wallet.pxe.getContractInstance(address)
  if (!instance) throw new Error("The account instance is not registered in this PXE")
  const [x, y] = await auth.getPubkeys()
  const owner: RefundOwner = {
    address,
    publicKeys: instance.publicKeys,
    instance: {
      contractClassId: instance.originalContractClassId,
      salt: instance.salt,
      initializationHash: instance.initializationHash,
      deployer: instance.deployer,
    },
    signer: {
      kind: "passkey",
      passkeySet: [...(await auth.getPasskeySet()).slots],
      passkeySigner: {
        publicKey: { x, y },
        sign: async (message) => {
          const signed = await signChallenge(message.toBuffer())
          return {
            authenticatorData: Buffer.from(signed.authenticatorData),
            clientDataJSON: Buffer.from(signed.clientDataJSON),
            signature: Buffer.from(signed.signature),
          }
        },
      },
    },
  }
  await assertRefundOwner(owner)
  return owner
}

/**
 * Oxide's refund modules embed the three refund circuits (about 1.8 MB together), so they and the
 * circuit artifacts load with the first frozen source rather than with the SDK.
 */
const refundCalldata = () => import("@oxide/oxide-client/atlatl/refund.js")

// A scan's concurrent reads share one import: vitest hands concurrent imports of a mocked module
// the real one.
let frozenNotes: Promise<typeof import("@oxide/oxide-client/frozen_notes.js")> | undefined

/** The owner's frozen notes that are still refundable, keyed by refund nullifier. */
export async function readRefundableFrozenNotes(o: {
  portal: OxidePortalContract
  token: Contract
  node: AztecNode
  owner: AztecAddress
  resolveSpendMetadata: SpendMetadataResolver
  /** How to reach the notes of an owner with no account entrypoint. */
  simulateOptions?: SimulateInteractionOptions
}) {
  frozenNotes ??= import("@oxide/oxide-client/frozen_notes.js")
  const { getRefundableFrozenNotes } = await frozenNotes
  const notes = await getRefundableFrozenNotes(
    o.portal,
    o.token,
    o.node,
    o.owner,
    o.resolveSpendMetadata,
    undefined,
    o.simulateOptions,
  )
  return Promise.all(
    notes.map(async (note) => ({
      note,
      id: (
        await computeNoteNullifier(
          note.provenNoteHash,
          o.token.address,
          (
            await o.resolveSpendMetadata(note)
          ).masterNullifierHidingKey,
        )
      ).toString(),
    })),
  )
}

/** The escrows' frozen notes that are still refundable, keyed by refund nullifier. */
export async function readRefundableEscrowNotes(o: {
  portal: OxidePortalContract
  token: Contract
  node: AztecNode
  escrows: FrozenEscrow[]
}) {
  const read = await Promise.all(
    o.escrows.map(async (escrow) => {
      const owner = escrow.owner.address
      const notes = await readRefundableFrozenNotes({
        ...o,
        owner,
        resolveSpendMetadata: escrow.resolveSpendMetadata,
        simulateOptions: { from: NO_FROM, additionalScopes: [owner] },
      })
      return notes.map((note) => ({ ...note, escrow }))
    }),
  )
  return read.flat()
}

/**
 * The owner's deposits that the frozen portal can still refund, keyed by refund nullifier. A deposit
 * an L2 transaction claimed before the freeze drops: its notes are frozen notes. Any classifier
 * error propagates, so a scan never reads as empty.
 *
 * A deposit in an L1 block that is not final is `waiting`: the portal refunds only a deposit message
 * it recorded in a final block.
 */
export async function readRefundableFrozenDeposits(o: {
  portal: OxidePortalContract
  node: AztecNode
  depositMetadata: DepositSpendMetadata
  descriptors: FrozenDepositDescriptor[]
}) {
  if (!o.descriptors.length) return { refundable: [], waiting: 0, waitingAmount: 0n }
  const [archive, finalized] = await Promise.all([
    resolveFreezeArchive(o.portal, o.node),
    o.portal.client.getBlock({ blockTag: "finalized" }),
  ])
  const waiting = new Map<string, bigint>()
  const final: FrozenDepositDescriptor[] = []
  for (const descriptor of o.descriptors) {
    if (BigInt(descriptor.l1BlockNumber) > finalized.number)
      waiting.set(descriptor.messageKey, BigInt(descriptor.amount))
    else final.push(descriptor)
  }
  const classified = await Promise.all(
    final.map(async (descriptor) => ({
      descriptor,
      ...(await classifyDepositRefund(
        o.portal,
        o.node,
        {
          messageKey: Fr.fromString(descriptor.messageKey),
          messageLeafIndex: BigInt(descriptor.messageLeafIndex),
          sharedSecretSalt: Fr.fromString(descriptor.sharedSecretSalt),
          amount: BigInt(descriptor.amount),
          recipient: o.depositMetadata.ownerAddressPreimage,
          recipientMasterNullifierHidingKey: o.depositMetadata.masterNullifierHidingKey,
        },
        archive,
      )),
    })),
  )
  const seen = new Set<string>()
  const refundable: Array<{
    id: string
    kind: "frozen-deposit" | "unprocessed-deposit"
    descriptor: FrozenDepositDescriptor
  }> = []
  for (const { descriptor, kind, nullifier } of classified) {
    const id = nullifier.toString()
    if ((kind !== "frozen-deposit" && kind !== "unprocessed-deposit") || seen.has(id)) continue
    seen.add(id)
    refundable.push({ id, kind, descriptor })
  }
  return {
    refundable,
    waiting: waiting.size,
    waitingAmount: [...waiting.values()].reduce((sum, amount) => sum + amount, 0n),
  }
}

/**
 * Brings the source PXE to its node's tip. A sync that resolves behind it is an incomplete scan: the
 * block stream swallows its own failures, and an old anchor reads fewer events and notes.
 */
export async function syncSourcePxe(o: {
  node: Pick<AztecNode, "getBlockNumber">
  pxe: SourcePxe
  rollupVersion: bigint
}) {
  const tip = await o.node.getBlockNumber()
  await o.pxe.sync()
  const header = await o.pxe.getSyncedBlockHeader()
  if (
    header.globalVariables.blockNumber < tip ||
    header.globalVariables.version.toBigInt() !== o.rollupVersion
  )
    throw new Error("The source wallet did not sync to the source rollup's tip")
}

/**
 * What the account can still refund from a frozen source portal, or `undefined` while it is live. A
 * refund pays on L1 and leaves the L2 notes in place, so the token balance overstates a frozen source.
 */
export async function frozenSourceSummary(o: {
  client: unknown
  wallet: ObsidionWallet
  account: ObsidionAccount
  tuple: OxideEnvTuple
  /** Read only once the portal is known frozen. */
  depositDescriptors: () => Promise<FrozenDepositDescriptor[]>
  /** The account's payment link escrows; read only once the portal is known frozen. */
  escrows?: () => Promise<FrozenEscrow[]>
}): Promise<
  | { notes: bigint; links: bigint; deposits: number; waiting: number; waitingAmount: bigint }
  | undefined
> {
  const client = o.client as ViemClient
  const portal = new OxidePortalContract(client, o.tuple.portal as Address)
  if (!(await portal.isFrozen())) return undefined
  await syncSourcePxe({
    node: o.wallet.node,
    pxe: o.wallet.pxe,
    rollupVersion: await portal.getRollupVersion(),
  })
  const tokenService = await TokenService.create(
    o.wallet,
    o.account,
    AztecAddress.fromStringUnsafe(o.tuple.l2Token),
  )
  const token = await tokenService.getTokenContract()
  // Inputs resolve before any read starts, so a failing input leaves no read unhandled.
  const resolveSpendMetadata = await o.account.makeSpendMetadataResolver()
  const escrows = (await o.escrows?.()) ?? []
  const depositMetadata = await (
    await o.account.makeDepositSpendMetadataResolver()
  )(o.account.getAddress())
  const descriptors = await o.depositDescriptors()
  const [notes, links, deposits] = await Promise.all([
    readRefundableFrozenNotes({
      portal,
      token,
      node: o.wallet.node,
      owner: o.account.getAddress(),
      resolveSpendMetadata,
    }),
    readRefundableEscrowNotes({ portal, token, node: o.wallet.node, escrows }),
    readRefundableFrozenDeposits({
      portal,
      node: o.wallet.node,
      depositMetadata,
      descriptors,
    }),
  ])
  return {
    notes: notes.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n),
    links: links.reduce((sum, { note }) => sum + note.amount.toBigInt(), 0n),
    deposits: deposits.refundable.length,
    waiting: deposits.waiting,
    waitingAmount: deposits.waitingAmount,
  }
}

/** Current-generation refund adapter. Older source generations must run their own SDK realm. */
export class FrozenRefundMigrationRuntime implements FrozenMigrationRuntime {
  readonly identity: string
  readonly migration?: MigrationExecutorRoute
  private descriptors?: Promise<FrozenDepositDescriptor[]>
  private escrows?: Promise<FrozenEscrow[]>
  private readonly subsidy?: MigrationSubsidyReader

  constructor(private readonly o: Options) {
    this.migration = o.migration
    if (o.migration)
      this.subsidy = new MigrationSubsidyReader(
        o.portal.client as PublicClient,
        o.migration.subsidy,
      )
    this.identity = keccak256(
      toHex(
        JSON.stringify({
          generation: `aztec-${SOURCE_AZTEC_MAJOR}`,
          portal: o.portal.address.toString(),
          rollup: o.rollup,
          version: String(o.rollupVersion),
          token: o.token.address.toString(),
          owner: o.owner.address.toString(),
          executor: o.executor.toString(),
          // The route is bound per batch (`direct.executor`, `direct.subsidy`), never here: a
          // route change then re-plans unsent batches instead of halting the run.
        }),
      ),
    )
  }

  private get subsidyReader(): MigrationSubsidyReader {
    if (!this.subsidy) throw new Error("This source has no migration route")
    return this.subsidy
  }

  /** The subsidy serves this route and this source portal, and pays this deployment's relayer. */
  private async validateMigration(route: MigrationExecutorRoute) {
    if (!sameAddress(route.sourcePortal, this.o.portal.address.toString()))
      throw new Error("The migration subsidy does not serve this source and destination")
    await this.subsidyReader.assertServes(route)
  }

  /** A commitment refund's subsidy pays it: checked before any prompt or proof. */
  private async checkBeforeProof(kind: FrozenRefundKind, amount: bigint, direct: boolean) {
    if (direct) await this.subsidyReader.check(kind, amount, false)
  }

  async assertMigrationReady(selection: FrozenRefundSelection, amount: bigint): Promise<void> {
    await this.subsidyReader.check(selection.kind, amount, true)
  }

  async minimumMigratedAmount(opts: { fresh?: boolean } = {}): Promise<bigint> {
    const reader = this.subsidyReader
    return (await (opts.fresh ? reader.fresh() : reader.read())).config.minMigratedAmount
  }

  async validate(destinationAsset: Address): Promise<void> {
    const o = this.o
    const circuits = await Promise.all([
      import("@oxide/refund-proof/frozen_notes_refund/artifact.js").then((m) => m.RefundCircuit),
      import("@oxide/refund-proof/frozen_deposits_refund/artifact.js").then(
        (m) => m.FrozenDepositsRefundCircuit,
      ),
      import("@oxide/refund-proof/unprocessed_deposit_refund/artifact.js").then(
        (m) => m.UnprocessedDepositRefundCircuit,
      ),
    ])
    if (circuits.some((circuit) => typeof circuit.bytecode !== "string"))
      throw new Error(
        "A frozen refund circuit is a build stub: run `pnpm --filter @obsidion/oxide-build build:refund-circuits`",
      )
    if (!o.owner.address.equals(o.depositMetadata.ownerAddressPreimage.address))
      throw new Error("The refund owner is not the deposit recipient")
    const [info, token, rollup, version, asset, frozen] = await Promise.all([
      o.node.getNodeInfo(),
      o.portal.getL2Token(),
      o.portal.getRollup(),
      o.portal.getRollupVersion(),
      o.portal.getUnderlying(),
      o.portal.isFrozen(),
    ])
    if (
      info.nodeVersion.replace(/^v/, "").split(".")[0] !== SOURCE_AZTEC_MAJOR ||
      !frozen ||
      !token.equals(o.token.address) ||
      rollup.toString().toLowerCase() !== o.rollup.toLowerCase() ||
      !rollup.equals(info.l1ContractAddresses.rollupAddress) ||
      version !== o.rollupVersion ||
      BigInt(info.rollupVersion) !== version ||
      asset.toString().toLowerCase() !== destinationAsset.toLowerCase()
    ) {
      throw new Error(
        "Frozen source does not match its pinned proof generation or destination funding asset",
      )
    }
    if (o.migration) await this.validateMigration(o.migration)
  }

  /** Brings the source PXE to the node's tip; a sync that resolves behind it is an incomplete scan. */
  private readDescriptors(fresh: boolean) {
    if (fresh || !this.descriptors) {
      const pending = this.o.depositDescriptors({ fresh })
      pending.catch(() => {
        if (this.descriptors === pending) this.descriptors = undefined
      })
      this.descriptors = pending
    }
    return this.descriptors
  }

  private readEscrows(fresh: boolean) {
    if (fresh || !this.escrows) {
      const pending = this.o.escrows?.({ fresh }) ?? Promise.resolve([])
      pending.catch(() => {
        if (this.escrows === pending) this.escrows = undefined
      })
      this.escrows = pending
    }
    return this.escrows
  }

  private notes() {
    return readRefundableFrozenNotes({ ...this.o, owner: this.o.owner.address })
  }

  private async escrowNotes(fresh = false) {
    return readRefundableEscrowNotes({ ...this.o, escrows: await this.readEscrows(fresh) })
  }

  private async deposits(fresh = false) {
    return readRefundableFrozenDeposits({
      ...this.o,
      descriptors: await this.readDescriptors(fresh),
    })
  }

  async candidates(opts: { fresh?: boolean } = {}): Promise<FrozenRefundCandidates> {
    if (opts.fresh) await syncSourcePxe(this.o)
    const [notes, { refundable, waitingAmount }, escrowNotes, maxBatchAmount] = await Promise.all([
      this.notes(),
      this.deposits(!!opts.fresh),
      this.escrowNotes(!!opts.fresh),
      this.o.portal.getTxAmountCap(),
    ])
    return {
      maxNotesPerBatch: MAX_FROZEN_NOTES_PER_REFUND,
      maxBatchAmount,
      waiting: waitingAmount,
      candidates: [
        ...notes.map(({ id, note }) => ({
          id,
          amount: String(note.amount.toBigInt()),
          kind: "note" as const,
        })),
        ...escrowNotes.map(({ id, note, escrow }) => ({
          id,
          amount: String(note.amount.toBigInt()),
          kind: "escrow-note" as const,
          owner: escrow.owner.address.toString(),
        })),
        ...refundable.map(({ id, kind, descriptor }) => ({
          id,
          amount: descriptor.amount,
          kind,
          leafIndex: descriptor.messageLeafIndex,
        })),
      ],
    }
  }

  /**
   * The executor call, chosen by the recipient's kind on every call. A commitment refunds through
   * the migration route's executor with no tip. An address refunds through the source's plain
   * withdrawal executor with `relayerTip` paid to `tipRecipient`, whether or not a route exists,
   * so a self-refund to the user's own L1 address works on a source the upgrade migrates.
   */
  private executorCall(recipient: FrozenRefundRecipient, relayerTip: bigint) {
    const o = this.o
    if (typeof recipient !== "string") {
      if (!o.migration)
        throw new Error(
          "No migration route serves this source, so it cannot refund under a commitment",
        )
      if (relayerTip !== 0n) throw new Error("A migration refund pays no relayer tip")
      return buildMigrationExecutorCall({
        executor: EthAddress.fromString(o.migration.executor),
        recipientCommitment: recipient.recipientCommitment,
      })
    }
    if (o.executor.isZero())
      throw new Error(
        "This source has no plain withdrawal executor, so it cannot refund to an address",
      )
    return buildPlainExecutorCall({
      executor: o.executor,
      recipient: EthAddress.fromString(recipient),
      relayerTip,
      tipRecipient: o.tipRecipient,
    })
  }

  async build(
    { kind, ids }: FrozenRefundSelection,
    recipient: FrozenRefundRecipient,
    relayerTip: bigint,
  ) {
    const o = this.o
    const ctx = { portal: o.portal, chain: o.node, signer: o.teeSigner, l2Token: o.token.address }
    const direct = typeof recipient !== "string"
    // Refuses a recipient this source cannot pay before anything is read or proven.
    const executorCall = this.executorCall(recipient, relayerTip)
    let amount: bigint
    let calldata: `0x${string}`
    if (kind === "note" || kind === "escrow-note") {
      if (
        !ids.length ||
        ids.length > MAX_FROZEN_NOTES_PER_REFUND ||
        new Set(ids).size !== ids.length
      ) {
        throw new Error("Invalid frozen refund selection")
      }
      const candidates: Array<{
        id: string
        note: NullificationEffectData
        escrow?: FrozenEscrow
      }> = kind === "note" ? await this.notes() : await this.escrowNotes()
      const available = new Map(candidates.map((c) => [c.id, c]))
      const picked = ids.map((id) => {
        const candidate = available.get(id)
        if (!candidate) throw new Error("A selected frozen note is no longer refundable")
        return candidate
      })
      // The circuit and the enclave refund one owner's notes at a time.
      const escrow = picked[0]!.escrow
      if (picked.some((c) => c.escrow !== escrow))
        throw new Error("A frozen refund selection spans payment links")
      const notes = picked.map((c) => c.note)
      amount = notes.reduce((sum, note) => sum + note.amount.toBigInt(), 0n)
      if (relayerTip < 0n || amount <= relayerTip)
        throw new Error("Frozen refund cannot cover its relayer tip")
      await this.checkBeforeProof(kind, amount, direct)
      const owner = escrow?.owner ?? o.owner
      const { buildRefundFrozenNotesCalldata } = await refundCalldata()
      calldata = await buildRefundFrozenNotesCalldata(ctx, {
        executorCall,
        notesToRefund: notes,
        owner,
        resolveSpendMetadata: escrow?.resolveSpendMetadata ?? o.resolveSpendMetadata,
        migrationSignature: await signMigrationOf(owner, executorCall),
      })
    } else {
      const deposit =
        ids.length === 1 &&
        (await this.deposits()).refundable.find((d) => d.id === ids[0] && d.kind === kind)
      if (!deposit) throw new Error("The selected frozen deposit is no longer refundable")
      const { descriptor } = deposit
      amount = BigInt(descriptor.amount)
      if (relayerTip < 0n || amount <= relayerTip)
        throw new Error("Frozen refund cannot cover its relayer tip")
      await this.checkBeforeProof(kind, amount, direct)
      const refund = {
        executorCall,
        l2Recipient: o.owner,
        l2RecipientMasterNullifierHidingKey: o.depositMetadata.masterNullifierHidingKey,
        migrationSignature: await signMigrationOf(o.owner, executorCall),
      }
      const sharedSecretSalt = Fr.fromString(descriptor.sharedSecretSalt)
      const messageLeafIndex = BigInt(descriptor.messageLeafIndex)
      const { buildRefundFrozenDepositsCalldata, buildRefundUnprocessedDepositCalldata } =
        await refundCalldata()
      calldata =
        deposit.kind === "frozen-deposit"
          ? await buildRefundFrozenDepositsCalldata(ctx, {
              ...refund,
              deposits: [
                {
                  amount,
                  sharedSecretSalt,
                  messageKey: Fr.fromString(descriptor.messageKey),
                  messageLeafIndex,
                },
              ],
            })
          : await buildRefundUnprocessedDepositCalldata(ctx, {
              ...refund,
              amount,
              sharedSecretSalt,
              messageLeafIndex,
            })
    }
    const route = o.migration
    if (direct && route) {
      return {
        amount,
        operation: buildMigrationOperation({
          subsidy: EthAddress.fromString(route.subsidy),
          payoutToken: EthAddress.fromString(route.payoutToken),
          calldata,
        }),
      }
    }
    return {
      amount,
      operation: {
        target: o.portal.address,
        payoutToken: await o.portal.getUnderlying(),
        calldata: Buffer.from(calldata.slice(2), "hex"),
        condition: L1OperationCondition.immediate(),
      },
    }
  }

  async refunded(ids: string[]): Promise<boolean> {
    return (
      ids.length > 0 &&
      (
        await Promise.all(ids.map((id) => this.o.portal.isRefundNullifierSpent(Fr.fromString(id))))
      ).every(Boolean)
    )
  }
}

/**
 * The migration route `destinationDeployment` publishes for the source portal, or undefined when it
 * publishes none. Throws when the feature's destination bridge is not `destinationPortal`.
 */
export function migrationRouteFor(
  destinationDeployment: Pick<OxideDeployment, "features" | "bridges"> | undefined,
  sourcePortal: Address,
  destinationPortal: Address,
  /** The destination's operation executor, whose code the subsidy must pay. */
  operationExecutor: Address,
): MigrationExecutorRoute | undefined {
  const feature = destinationDeployment && migrationFeatureFor(destinationDeployment, sourcePortal)
  if (!feature) return undefined
  const bridge = destinationDeployment.bridges.find((b) => b.id === feature.destinationBridge)
  if (!bridge || !sameAddress(bridge.portal, destinationPortal))
    throw new Error(`Migration feature ${feature.id} does not deposit into the destination portal`)
  return {
    executor: feature.executor,
    subsidy: feature.subsidy,
    payoutToken: feature.payoutToken,
    sourcePortal,
    destinationPortal,
    operationExecutor,
  }
}

/** A frozen source of this generation; a portal that is not frozen moves nothing. */
export async function createLocalMetadataMigrationSource(
  options: MetadataMigrationSourceOptions & {
    teeSigner: RegisteredTeeSigner
    /** The account on the source's rollup; on one rollup it is the destination's. */
    sourceChain?: { wallet: ObsidionWallet; account: ObsidionAccount }
    /** The source account's swept deposits on the source portal, read on the source rollup. */
    depositDescriptors(opts: { fresh: boolean }): Promise<FrozenDepositDescriptor[]>
    /** The source account's payment link escrows, registered in the source chain's wallet. */
    escrows?(opts: { fresh: boolean }): Promise<FrozenEscrow[]>
    wrapRefundSigner?: (sign: RefundChallengeSigner) => RefundChallengeSigner
    /** Takes the deployment's subsidy; the destination's executor unless the user submits. */
    tipRecipient?: Address
    /** A withdrawal to L1 in place of the upgrade, which needs no migration route. */
    withdrawal?: boolean
    /**
     * The destination's deployment. A frozen source migrates only through the migration feature it
     * publishes for the source portal; see {@link migrationRouteFor}. Without one, a frozen source
     * is refused.
     */
    destinationDeployment?: Pick<OxideDeployment, "features" | "bridges">
  } & Pick<
      ConstructorParameters<typeof FrozenMetadataMigrationSource>[0],
      "directDepositClaimed" | "reservedCoordinates" | "approvalPass" | "approvalsOnly"
    >,
) {
  const client = options.client as unknown as ViemClient
  const tuple = options.source.tuple
  const portal = new OxidePortalContract(client, tuple.portal as Address)
  if (!(await portal.isFrozen())) throw new Error("The old version is not frozen yet")
  const migration = migrationRouteFor(
    options.destinationDeployment,
    tuple.portal as Address,
    options.destination.portal,
    options.destination.operationExecutor,
  )
  // A frozen source moves funds only through the destination's migration executor. A withdrawal to
  // the user's own address needs none.
  if (!migration && !options.withdrawal)
    throw new Error(
      "A frozen source moves funds only through the destination's migration executor, and the destination publishes no migration feature for it",
    )
  const chain = options.sourceChain ?? { wallet: options.wallet, account: options.account }
  const info = await chain.wallet.node.getNodeInfo()
  const destination = new OxidePortalContract(client, options.destination.portal)
  return new FrozenMetadataMigrationSource({
    ...options,
    destinationAsset: (await destination.getUnderlying()).toString() as Address,
    runtime: new FrozenRefundMigrationRuntime({
      node: chain.wallet.node,
      pxe: chain.wallet.pxe,
      token: await options.source.tokenService.getTokenContract(),
      portal,
      rollup: info.l1ContractAddresses.rollupAddress.toString() as Address,
      rollupVersion: BigInt(info.rollupVersion),
      owner: await passkeyRefundOwner(chain.wallet, chain.account, options.wrapRefundSigner),
      resolveSpendMetadata: await chain.account.makeSpendMetadataResolver(),
      depositMetadata: await (
        await chain.account.makeDepositSpendMetadataResolver()
      )(chain.account.getAddress()),
      depositDescriptors: options.depositDescriptors,
      escrows: options.escrows,
      teeSigner: options.teeSigner,
      executor: tuple.plainWithdrawalExecutor
        ? EthAddress.fromString(tuple.plainWithdrawalExecutor)
        : EthAddress.ZERO,
      tipRecipient: EthAddress.fromString(
        options.tipRecipient ?? options.destination.operationExecutor,
      ),
      ...(migration ? { migration } : {}),
    }),
  })
}

/**
 * The next refund of a frozen portal that `recipient` submits itself, paid to it in full: no relayer
 * tip, so the runtime must name `recipient` as its tip recipient to take the deployment's subsidy.
 * None once nothing refundable is left; `waiting` is what the portal cannot refund yet.
 */
export async function nextFrozenSelfRefund(
  runtime: Pick<FrozenMigrationRuntime, "candidates" | "build">,
  recipient: Address,
  opts: { fresh?: boolean } = {},
) {
  const candidates = await runtime.candidates(opts)
  const waiting = candidates.waiting ?? 0n
  const remaining = candidates.candidates.reduce((sum, c) => sum + BigInt(c.amount), 0n)
  const batch = selectFrozenBatch({ ...candidates, minimumAmount: 1n })
  if (!batch) return { remaining, waiting }
  const { amount, operation } = await runtime.build(batch, recipient, 0n)
  return {
    remaining,
    waiting,
    refund: {
      ids: batch.ids,
      deposits: refundedDeposits(candidates.candidates, batch.ids),
      amount,
      to: operation.target.toString() as Address,
      data: toHex(operation.calldata),
    },
  }
}

/**
 * Every refund a self refund of `o.candidates` sends, in the order {@link nextFrozenSelfRefund} sends them.
 * `minimumAmount` (default 1) is the least a batch moves, such as more than its relayer tip.
 */
export function planFrozenSelfRefunds(
  o: Omit<Parameters<typeof selectFrozenBatch>[0], "minimumAmount"> & { minimumAmount?: bigint },
) {
  const batches: NonNullable<ReturnType<typeof selectFrozenBatch>>[] = []
  for (let left = o.candidates; ; ) {
    const batch = selectFrozenBatch({
      ...o,
      candidates: left,
      minimumAmount: o.minimumAmount ?? 1n,
    })
    if (!batch) return batches
    batches.push(batch)
    const sent = new Set(batch.ids)
    left = left.filter((c) => !sent.has(c.id))
  }
}

const REFUND_TX_GAS = {
  "note": "FROZEN_NOTES_REFUND_TX_GAS",
  "escrow-note": "FROZEN_NOTES_REFUND_TX_GAS",
  "frozen-deposit": "FROZEN_DEPOSITS_REFUND_TX_GAS",
  "unprocessed-deposit": "UNPROCESSED_DEPOSIT_REFUND_TX_GAS",
} as const

/**
 * What sending refunds of `kinds` costs their sender, in wei and 18-decimal USD: the gas the withdrawal
 * subsidy models for each refund, at the current gas price and the subsidy's ETH/USD feed. A model, not a
 * simulation, since a refund's calldata needs its proof.
 */
export async function estimateFrozenSelfRefundCost(
  client: PublicClient,
  subsidy: Address,
  kinds: readonly FrozenRefundKind[],
) {
  const names = [...new Set(kinds.map((kind) => REFUND_TX_GAS[kind]))]
  const read = <F extends (typeof names)[number] | "PRICE_FEED">(functionName: F) =>
    client.readContract({ address: subsidy, abi: PlainWithdrawalSubsidyAbi, functionName })
  const [gas, feed, gasPrice] = await Promise.all([
    Promise.all(names.map((name) => read(name) as Promise<bigint>)),
    read("PRICE_FEED") as Promise<Address>,
    client.getGasPrice(),
  ])
  const gasOf = new Map(names.map((name, i) => [name, gas[i]!]))
  const wei = kinds.reduce((sum, kind) => sum + gasOf.get(REFUND_TX_GAS[kind])! * gasPrice, 0n)
  return { wei, usd: weiToUSD(wei, await readUsdPerEth(client, EthAddress.fromString(feed))) }
}

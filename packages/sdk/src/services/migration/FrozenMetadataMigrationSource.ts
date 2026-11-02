import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { TxHash, TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { broadcastL1Operation } from "@oxide/oxide-client/broadcaster_calls.js"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import {
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import type {
  FrozenMigrationFundingBatch,
  FrozenRefundKind,
  MigrationFundingBatch,
  MigrationSavedOperation,
  OxideEnvTuple,
} from "@obsidion/core/types"
import { keccak256, parseAbi, toHex, type Address, type Hex } from "viem"
import { sameAddress } from "../../oxide/address.js"
import { provingProgress } from "@obsidion/proving-progress"
import type {
  MetadataMigrationSource,
  MetadataMigrationServiceOptions,
  MigrationSendGate,
  MigrationSourceQuote,
} from "./MetadataMigrationService.js"
import type { ObsidionAccount } from "../../obsidion/alpha/account/ObsidionAccount.js"
import type { TokenService } from "../token/TokenService.js"
import { buildClaimSponsorPayload } from "../../feePaymentMethod/claimFpc/claimSponsoredCall.js"
import { claimFpcSponsoredFee } from "../../feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import {
  ApprovalNeededError,
  ApprovalSavedError,
  MigrationHaltedError,
  StalePlanError,
} from "./metadataMigration.js"
import {
  migrationDirectAnnouncementCalls,
  migrationDirectCommitment,
  migrationSipaCoordinates,
  type MigrationDestinationContext,
} from "./migrationDeposit.js"

/** What a migration source reads and pays on the destination, and where it keeps its batches. */
export interface MetadataMigrationSourceOptions
  extends Omit<MigrationDestinationContext, "node" | "recipient" | "recoveryAccount"> {
  wallet: MetadataMigrationServiceOptions["wallet"]
  account: ObsidionAccount
  /** The registered OxideAccount; it recovers every migration SIPA. */
  owner: Address
  source: { tuple: OxideEnvTuple; tokenService: TokenService }
  /** The destination token, which the source route must deliver to. */
  tokenService: TokenService
  registered: MetadataMigrationServiceOptions["registered"]
  /** front-core owns persistence; the controller holds the account-scoped lock. */
  batches: {
    get(id: string): Promise<MigrationFundingBatch | undefined>
    set(id: string, batch: MigrationFundingBatch): Promise<void>
  }
}

export interface FrozenRefundCandidate {
  /** The portal refund nullifier. */
  id: string
  amount: string
  kind: FrozenRefundKind
  /** The escrow an `escrow-note` belongs to. */
  owner?: string
  /** A deposit's Inbox leaf index, which names it on L1. */
  leafIndex?: string
}

export interface FrozenRefundSelection {
  kind: FrozenRefundKind
  ids: string[]
}

export interface FrozenRefundCandidates {
  maxNotesPerBatch: number
  /** The portal's per-refund amount cap. */
  maxBatchAmount: bigint
  candidates: FrozenRefundCandidate[]
  /** Raw amount in deposits the portal refunds once their L1 block is final. */
  waiting?: bigint
}

/**
 * The destination's migration route for one source portal, from its migration feature. A refund on it names the
 * `MigrationExecutor`, which deposits the refund straight into the destination portal under a recipient commitment.
 * Its L1 operation targets the `MigrationSubsidy`, which pays the relayer in `payoutToken`. The relayer tip is 0.
 */
export interface MigrationExecutorRoute {
  executor: Address
  subsidy: Address
  payoutToken: Address
  /** The old portal: the subsidy forwards the refund calldata to it unchanged. */
  sourcePortal: Address
  /** The new portal the executor deposits into. */
  destinationPortal: Address
  /**
   * The destination's operation executor, which runs the relayer's L1 operations. The subsidy pays
   * only a caller with the code hash it was deployed with.
   */
  operationExecutor: Address
}

/**
 * Where a refund pays. A commitment: the destination's migration executor deposits it, which is how
 * a migration moves frozen funds. An address: the source's plain withdrawal executor pays it on
 * L1, as a self-refund to the user's own address does.
 */
export type FrozenRefundRecipient = Address | { recipientCommitment: Hex }

/** A refund to an L1 address, sent in a sponsored broadcast. `txHash` is the L2 transaction. */
export interface FrozenAddressRefund {
  ids: string[]
  deposits: RefundedDeposit[]
  amount: bigint
  txHash: string
}

/** A deposit a refund returns, by its Inbox leaf index and its amount. */
export interface RefundedDeposit {
  leafIndex: string
  amount: string
}

/** The deposits among `candidates` that `ids` select. */
export function refundedDeposits(
  candidates: readonly FrozenRefundCandidate[],
  ids: readonly string[],
): RefundedDeposit[] {
  const picked = new Set(ids)
  return candidates.flatMap((c) =>
    picked.has(c.id) && c.leafIndex !== undefined
      ? [{ leafIndex: c.leafIndex, amount: c.amount }]
      : [],
  )
}

/** A short user-facing message for one of oxide's `canMigrate` reasons. It names no amounts. */
export function migrationSubsidyMessage(reason: string): string {
  if (reason.includes("not frozen")) return "The old version is not closed yet."
  if (reason.includes("below the subsidy minimum")) return "This amount is too small to move."
  if (reason.includes("price feed")) return "Price data is out of date. Try again later."
  if (reason.includes("balance")) return "The fund that pays for moves is low. Try again later."
  if (reason.includes("pays nothing")) return "Moves are paused. Try again later."
  return "Moves are not available now. Try again later."
}

/**
 * The migration subsidy would not pay the relayer of this refund now, so no relayer is expected to
 * run it. `reasons` are oxide's raw `canMigrate` reasons; `messages` and the error message are
 * their short user-facing forms. It can clear by itself, for example when the price feed updates.
 */
export class MigrationSubsidyNotReadyError extends Error {
  readonly messages: string[]

  constructor(readonly reasons: string[]) {
    const messages = [...new Set(reasons.map(migrationSubsidyMessage))]
    super(messages.join(" "))
    this.messages = messages
    this.name = "MigrationSubsidyNotReadyError"
  }
}

/** Implemented inside the source generation. No source Aztec objects cross this boundary. */
export interface FrozenMigrationRuntime {
  /** Pins the source account, chain, portal, asset, executor and proof generation. */
  identity: string
  /**
   * The destination's migration route for this source. A migration needs it; a runtime without it
   * can only refund to an address.
   */
  readonly migration?: MigrationExecutorRoute
  /** Validate the source deployment, freeze state, and destination funding asset on chain. */
  validate(destinationAsset: Address): Promise<void>
  /**
   * Fresh source data of the kinds this runtime refunds, excluding nullifiers already refunded on
   * L1. Errors must propagate. `fresh` re-reads what the runtime may memoize between calls.
   */
  candidates(opts?: { fresh?: boolean }): Promise<FrozenRefundCandidates>
  /**
   * Prove this exact selection. The runtime validates recipient, tip, and source spentness. A
   * commitment refunds through the migration route with tip 0; an address through the source's
   * plain withdrawal executor.
   */
  build(
    selection: FrozenRefundSelection,
    recipient: FrozenRefundRecipient,
    relayerTip: bigint,
  ): Promise<{
    amount: bigint
    operation: BroadcastL1Operation
  }>
  /** Positive on-chain refund evidence for every selected identifier. */
  refunded(ids: string[]): Promise<boolean>
  /**
   * Throws {@link MigrationSubsidyNotReadyError} unless a fresh read shows that the route's subsidy
   * pays the relayer of this refund. Called right before a commitment refund is broadcast.
   */
  assertMigrationReady?(selection: FrozenRefundSelection, amount: bigint): Promise<void>
  /** The least one commitment refund must move for the route's subsidy to pay. */
  minimumMigratedAmount?(opts?: { fresh?: boolean }): Promise<bigint>
}

/** The covering note subset is searched exactly over this many of the largest notes. */
const EXACT_COVER_NOTES = 16

type Note = { id: string; amount: bigint }

const largestFirst = (a: Note, b: Note) =>
  a.amount === b.amount ? (a.id < b.id ? -1 : 1) : a.amount > b.amount ? -1 : 1

/** One batch per escrow: its largest notes within the count and amount caps. */
function escrowBatches(candidates: FrozenRefundCandidate[], maxCount: number, cap: bigint) {
  const byOwner = new Map<string, Note[]>()
  for (const c of candidates) {
    if (c.kind !== "escrow-note") continue
    const notes = byOwner.get(c.owner!) ?? []
    notes.push({ id: c.id, amount: BigInt(c.amount) })
    byOwner.set(c.owner!, notes)
  }
  return [...byOwner.values()].map((notes) => {
    const ids: string[] = []
    let amount = 0n
    for (const note of notes.sort(largestFirst)) {
      if (ids.length === maxCount) break
      if (amount + note.amount > cap) continue
      ids.push(note.id)
      amount += note.amount
    }
    return { kind: "escrow-note" as const, ids, amount }
  })
}

/** The smallest-total subset of `notes` (largest first) reaching `need` within the count and amount caps. */
function coverNotes(notes: Note[], need: bigint, maxCount: number, cap: bigint) {
  const pool = notes.slice(0, EXACT_COVER_NOTES)
  const suffix = pool.map((_, i) => pool.slice(i).reduce((sum, n) => sum + n.amount, 0n))
  let best: Note[] | undefined
  let bestSum = 0n
  const chosen: Note[] = []
  const visit = (i: number, sum: bigint) => {
    if (sum >= need) {
      if (!best || sum < bestSum || (sum === bestSum && chosen.length < best.length)) {
        best = [...chosen]
        bestSum = sum
      }
      return
    }
    if (i === pool.length || chosen.length === maxCount || sum + suffix[i]! < need) return
    if (best && sum >= bestSum) return
    const note = pool[i]!
    if (sum + note.amount <= cap) {
      chosen.push(note)
      visit(i + 1, sum + note.amount)
      chosen.pop()
    }
    visit(i + 1, sum)
  }
  visit(0, 0n)
  return best
}

/**
 * The next refund batch that moves at least `minimumAmount`, or none.
 *
 * A deposit is refunded alone, and a payment link's escrow on its own once no deposit clears the
 * minimum: a link's refund asks no approval, so it never holds back one. The account's notes take the
 * covering subset with the smallest total, so later batches stay affordable, then the smallest
 * remaining notes ride along up to the caps. This is a heuristic, not an optimal partition: whatever
 * no batch can take is a stranded residual.
 */
export function selectFrozenBatch(o: {
  candidates: FrozenRefundCandidate[]
  maxNotesPerBatch: number
  maxBatchAmount: bigint
  minimumAmount: bigint
}): { kind: FrozenRefundKind; ids: string[]; amount: bigint } | undefined {
  if (
    !Number.isSafeInteger(o.maxNotesPerBatch) ||
    o.maxNotesPerBatch < 1 ||
    o.maxBatchAmount <= 0n ||
    o.minimumAmount <= 0n
  ) {
    throw new Error("Invalid frozen-source batch limit or minimum")
  }
  const ids = new Set<string>()
  for (const c of o.candidates) {
    if (BigInt(c.amount) <= 0n || ids.has(c.id) || (c.kind === "escrow-note" && !c.owner))
      throw new Error("Invalid frozen-source candidate")
    ids.add(c.id)
  }
  const need = o.minimumAmount
  const notes = o.candidates
    .filter((c) => c.kind === "note")
    .map((c) => ({ id: c.id, amount: BigInt(c.amount) }))
    .sort(largestFirst)
  const cover = coverNotes(notes, need, o.maxNotesPerBatch, o.maxBatchAmount)
  if (cover) {
    let amount = cover.reduce((sum, n) => sum + n.amount, 0n)
    const batch = cover.map((n) => n.id)
    for (const note of [...notes].reverse()) {
      if (batch.length === o.maxNotesPerBatch) break
      if (batch.includes(note.id) || amount + note.amount > o.maxBatchAmount) continue
      batch.push(note.id)
      amount += note.amount
    }
    return { kind: "note", ids: batch, amount }
  }
  const largest = (batches: Array<{ kind: FrozenRefundKind; ids: string[]; amount: bigint }>) =>
    batches
      .filter((batch) => batch.amount >= need && batch.amount <= o.maxBatchAmount)
      .sort((a, b) =>
        largestFirst({ id: a.ids[0]!, amount: a.amount }, { id: b.ids[0]!, amount: b.amount }),
      )[0]
  return (
    largest(
      o.candidates
        .filter((c) => c.kind === "frozen-deposit" || c.kind === "unprocessed-deposit")
        .map((c) => ({ kind: c.kind, ids: [c.id], amount: BigInt(c.amount) })),
    ) ?? largest(escrowBatches(o.candidates, o.maxNotesPerBatch, o.maxBatchAmount))
  )
}

/** A payment link's refund is signed by the link's fallback key, so it asks the user nothing. */
const asksApproval = (kind?: FrozenRefundKind) => kind !== "escrow-note"

type Options = Pick<
  MetadataMigrationSourceOptions,
  | "client"
  | "wallet"
  | "destination"
  | "selfResolver"
  | "token"
  | "broadcaster"
  | "registered"
  | "owner"
  | "batches"
> & {
  /** Must carry the destination's migration route for the source. */
  runtime: FrozenMigrationRuntime
  destinationAsset: Address
  /**
   * The total that the deposit rail has claimed from the direct deposits under
   * `recipientCommitment` on the destination, in raw units. The rail finds and records those
   * deposits itself. A batch settles only once this total reaches the batch's amount: the
   * commitment is public, so a smaller deposit from another sender does not settle it. Without
   * it, no batch settles.
   */
  directDepositClaimed?(recipientCommitment: Hex): Promise<bigint>
  /**
   * The coordinates of every direct batch that the account saved in any run, planned or sent. A
   * new batch never takes them, so two runs of the account (for example DAI and sUSDS) never
   * deposit under the same commitment. It must read no chain.
   */
  reservedCoordinates?(): Promise<{ day: number; nonce: number }[]>
  /**
   * Runs `step` with a signer that throws {@link ApprovalSavedError} once it saved an approval, so
   * every batch is approved before any is proven. Without it, each batch is approved as it is proven.
   */
  approvalPass?<T>(step: () => Promise<T>): Promise<T>
  /** The current pass only saves approvals: it proves nothing. */
  approvalsOnly?(): boolean
}

const TX_AMOUNT_CAP_ABI = parseAbi(["function TX_AMOUNT_CAP() view returns (uint256)"])

/**
 * How long a sent batch may wait with its refund nullifier unspent before the wallet sends its
 * broadcast again. A batch pays the relayer only through the migration subsidy, and the relayer
 * drops an operation that it cannot run at a profit once the operation is older than its pending
 * age, for example while the subsidy pot is empty or its price feed is stale. A new send of the same
 * broadcast gives the relayer the operation again.
 */
export const MIGRATION_RESEND_AFTER_MS = 2 * 60 * 60 * 1000

/** The most times a batch's broadcast is sent again. */
export const MAX_MIGRATION_RESENDS = 3

type CarrierState = "pending" | "failed" | "included"

/**
 * A carrier's state from its receipt. A dropped carrier never landed; a reverted one broadcast
 * nothing.
 */
function carrierState(receipt: {
  status?: TxStatus
  executionResult?: TxExecutionResult
}): CarrierState {
  if (receipt.status === TxStatus.DROPPED || receipt.executionResult === TxExecutionResult.REVERTED)
    return "failed"
  return receipt.executionResult === undefined ? "pending" : "included"
}

/** `operation` in the form a batch record saves. */
export function saveOperation(operation: BroadcastL1Operation): MigrationSavedOperation {
  const { kind, token, recipient } = operation.condition
  return {
    target: operation.target.toString() as `0x${string}`,
    payoutToken: operation.payoutToken.toString() as `0x${string}`,
    calldata: `0x${operation.calldata.toString("hex")}`,
    condition: {
      kind,
      token: token.toString() as `0x${string}`,
      recipient: recipient.toString() as `0x${string}`,
    },
  }
}

/** The operation a batch record saved, byte for byte. */
export function savedOperation(saved: MigrationSavedOperation): BroadcastL1Operation {
  return {
    target: EthAddress.fromString(saved.target),
    payoutToken: EthAddress.fromString(saved.payoutToken),
    calldata: Buffer.from(saved.calldata.slice(2), "hex"),
    condition: L1OperationCondition.decode(
      saved.condition.kind,
      EthAddress.fromString(saved.condition.token),
      EthAddress.fromString(saved.condition.recipient),
    ),
  }
}

/**
 * A frozen source's funds, moved only through the destination's migration executor. Each batch is a
 * direct deposit into the destination portal under a recipient commitment, with no SIPA and no
 * relayer tip: the route's subsidy pays the relayer. Frozen funds are released only by broadcasts on
 * the destination; no old-L2 transaction. The source moves only funds and never funds a metadata
 * update.
 */
export class FrozenMetadataMigrationSource implements MetadataMigrationSource {
  readonly identity: string
  /** A frozen source moves only funds. */
  readonly fundsOnly = true
  private readonly route: MigrationExecutorRoute
  private prepared = new Map<string, Awaited<ReturnType<FrozenMigrationRuntime["build"]>>>()

  constructor(private readonly o: Options) {
    if (!o.runtime.migration)
      throw new Error(
        "A frozen source moves funds only through the destination's migration executor, and the destination publishes no migration feature for it",
      )
    this.route = o.runtime.migration
    this.identity = keccak256(
      toHex(
        JSON.stringify({
          source: o.runtime.identity,
          destination: [
            o.destination.portal,
            o.destination.factory,
            String(o.destination.rollupVersion),
            o.destinationAsset,
            o.registered.user.toString(),
          ],
        }),
      ),
    )
  }

  /** What the commitment and its announcement derive from. */
  private get account(): Pick<
    MigrationDestinationContext,
    "selfResolver" | "token" | "recipient" | "recoveryAccount"
  > {
    const o = this.o
    return {
      selfResolver: o.selfResolver,
      token: o.token,
      recipient: o.registered.user,
      recoveryAccount: o.owner,
    }
  }

  /** The least a batch moves: the subsidy's minimum migrated amount, and at least 1. */
  private async batchMinimum(): Promise<bigint> {
    const least = (await this.o.runtime.minimumMigratedAmount?.()) ?? 0n
    return least > 0n ? least : 1n
  }

  private destinationCap?: Promise<bigint>

  /**
   * The runtime's candidates and limits. The refund deposits into the destination portal in the same
   * call, so a batch also stays within that portal's per-transaction cap, read once. Its rate limit
   * changes over time and stays a retry.
   */
  private async candidates(opts?: { fresh?: boolean }): Promise<FrozenRefundCandidates> {
    const read = await this.o.runtime.candidates(opts)
    if (!this.destinationCap) {
      const pending = this.o.client.readContract({
        address: this.route.destinationPortal,
        abi: TX_AMOUNT_CAP_ABI,
        functionName: "TX_AMOUNT_CAP",
      })
      pending.catch(() => {
        if (this.destinationCap === pending) this.destinationCap = undefined
      })
      this.destinationCap = pending
    }
    const cap = await this.destinationCap
    return { ...read, maxBatchAmount: cap < read.maxBatchAmount ? cap : read.maxBatchAmount }
  }

  /** What the source can refund, read against a validated deployment. */
  private async inventory(fresh = false) {
    await this.o.runtime.validate(this.o.destinationAsset)
    return this.candidates({ fresh })
  }

  async state(): Promise<"frozen" | "empty"> {
    return (await this.inventory()).candidates.length ? "frozen" : "empty"
  }

  /** Whether one batch moves at least the subsidy's minimum. */
  async movable(fresh = false): Promise<boolean> {
    const candidates = await this.inventory(fresh)
    return !!selectFrozenBatch({ ...candidates, minimumAmount: await this.batchMinimum() })
  }

  /** Everything the source holds for the account, dust and waiting deposits included. */
  async holdings(): Promise<bigint> {
    const { candidates, waiting = 0n } = await this.inventory(true)
    return candidates.reduce((sum, c) => sum + BigInt(c.amount), waiting)
  }

  /**
   * Nothing more arrives for a batch: it is received, or it is sent and the rail has claimed at
   * least its amount under its commitment. A batch pays no fee, so its deposit is its amount. The
   * rail records the executor's portal deposit itself, so the claim is the only signal and no L1
   * read is made here.
   */
  private async settled(batch: MigrationFundingBatch): Promise<boolean> {
    if (batch.received) return true
    if (!batch.broadcastTx || !batch.direct || !this.o.directDepositClaimed) return false
    const claimed = await this.o.directDepositClaimed(batch.direct.recipientCommitment)
    return claimed >= BigInt(batch.amount)
  }

  private async allSettled(): Promise<boolean> {
    for (const { batch } of await this.remaining()) if (!(await this.settled(batch))) return false
    return true
  }

  /** Every batch a run takes, chosen as recovery chooses them, by the subsidy's minimum. */
  async quote(): Promise<MigrationSourceQuote> {
    const { candidates, waiting = 0n, ...limits } = await this.inventory()
    const minimumAmount = await this.batchMinimum()
    let left = candidates
    let movable = 0n
    let batches = 0
    let approvals = 0
    for (;;) {
      const batch = selectFrozenBatch({ ...limits, candidates: left, minimumAmount })
      if (!batch) break
      movable += batch.amount
      batches++
      if (asksApproval(batch.kind)) approvals++
      left = left.filter((c) => !batch.ids.includes(c.id))
    }
    const stranded = left.reduce((sum, c) => sum + BigInt(c.amount), 0n)
    return { movable, stranded, waiting, batches, approvals }
  }

  /** The refund runtime, for a withdrawal the user submits on L1 in place of the upgrade. */
  get runtime(): FrozenMigrationRuntime {
    return this.o.runtime
  }

  /**
   * Withdraw in place of the upgrade, with no ETH: refund every batch to the L1 address `to`, each
   * in a broadcast that the account's recurring sponsorship pays. The relayer that runs a refund
   * takes `relayerTip` from it. Each send waits for L2 inclusion, not for the refund on L1. A batch
   * never takes an id in `skip`, such as one sent earlier whose refund has not run yet. `onSent`
   * runs once a refund is submitted, before its inclusion, and must save it: a send whose receipt
   * read fails may still land.
   */
  async refundTo(
    to: Address,
    relayerTip: bigint,
    {
      skip = new Set<string>(),
      onSent,
      signal,
      gate = (step) => step(),
    }: {
      skip?: ReadonlySet<string>
      onSent?: (batch: FrozenAddressRefund) => Promise<void> | void
      signal?: AbortSignal
      gate?: MigrationSendGate
    } = {},
  ) {
    const o = this.o
    await o.runtime.validate(o.destinationAsset)
    const sent: FrozenAddressRefund[] = []
    const taken = new Set(skip)
    for (let fresh = true; ; fresh = false) {
      signal?.throwIfAborted()
      const { candidates, waiting = 0n, ...limits } = await o.runtime.candidates({ fresh })
      const left = candidates.filter((c) => !taken.has(c.id))
      const batch = selectFrozenBatch({
        ...limits,
        candidates: left,
        minimumAmount: relayerTip + 1n,
      })
      if (!batch)
        return { sent, stranded: left.reduce((sum, c) => sum + BigInt(c.amount), 0n), waiting }
      const { amount, operation } = await o.runtime.build(batch, to, relayerTip)
      // A refund that would revert on L1 must not spend a sponsored send.
      await o.client.call({
        account: o.owner,
        to: operation.target.toString() as Address,
        data: `0x${operation.calldata.toString("hex")}`,
      })
      const innerCalls = (await broadcastL1Operation(o.broadcaster, operation).request()).calls
      const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
      await gate(async (operationId) => {
        signal?.throwIfAborted()
        await o.wallet.sendTx(payload, {
          from: NO_FROM,
          sendMessagesAs: o.registered.user,
          additionalScopes: [o.registered.user],
          fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
          operationId,
          onTxHash: async (txHash) => {
            batch.ids.forEach((id) => taken.add(id))
            const refund = {
              ids: batch.ids,
              deposits: refundedDeposits(candidates, batch.ids),
              amount,
              txHash,
            }
            sent.push(refund)
            await onSent?.(refund)
            if (operationId) provingProgress.emitTxHashSaved(operationId, txHash)
          },
        })
      })
    }
  }

  /** Keys a proof by what it commits to, so a batch stored under another id reuses it. */
  private proofKey(recipientCommitment: Hex, kind: FrozenRefundKind, selection: string[]) {
    return keccak256(
      toHex(JSON.stringify([this.identity, recipientCommitment.toLowerCase(), kind, selection])),
    )
  }

  private async read(id: string, recipient?: string): Promise<FrozenMigrationFundingBatch> {
    const batch = await this.o.batches.get(id)
    if (
      !batch ||
      batch.binding !== this.identity ||
      !batch.direct ||
      !batch.sourceSelection?.length ||
      !sameAddress(batch.recipient, batch.direct.recipientCommitment) ||
      (recipient && !sameAddress(batch.recipient, recipient)) ||
      BigInt(batch.amount) <= 0n
    ) {
      throw new StalePlanError("Stored frozen batch does not match this migration")
    }
    return batch as FrozenMigrationFundingBatch
  }

  /**
   * The commitment a batch deposits under, re-derived from its coordinates. Throws `StalePlanError`
   * when the batch is not on the current route, and halts when its coordinates no longer derive it.
   */
  private async directRecipient(
    batch: MigrationFundingBatch,
  ): Promise<{ recipientCommitment: Hex }> {
    const direct = batch.direct!
    if (!this.onRoute(batch))
      throw new StalePlanError("Stored frozen batch does not match the migration route")
    const { recipientCommitment } = await migrationDirectCommitment(
      this.account,
      direct.day,
      direct.nonce,
    )
    if (!sameAddress(recipientCommitment, direct.recipientCommitment))
      throw new MigrationHaltedError("recipient", "Direct deposit commitment changed")
    return { recipientCommitment }
  }

  /** Whether a batch names the current route's executor and subsidy. */
  private onRoute(batch: MigrationFundingBatch): boolean {
    const direct = batch.direct
    return (
      !!direct &&
      sameAddress(direct.executor ?? "", this.route.executor) &&
      sameAddress(direct.subsidy, this.route.subsidy)
    )
  }

  /** Rebuild from source data and verify the batch still deposits under `recipient`, its commitment. */
  async restore(id: string, recipient: Address) {
    const batch = await this.read(id, recipient)
    const kind = batch.sourceKind ?? "note"
    const ids = batch.sourceSelection!
    const target = await this.directRecipient(batch)
    await this.o.runtime.validate(this.o.destinationAsset)
    if (await this.o.runtime.refunded(ids))
      throw new StalePlanError("The selected frozen batch has already been refunded")
    // A cached proof must not bypass fresh spentness checks when only part of a selection was
    // refunded elsewhere. The aggregate refunded() check above proves only that ALL were spent.
    const { candidates, maxNotesPerBatch, maxBatchAmount } = await this.candidates()
    const available = new Map(
      candidates.filter((c) => c.kind === kind).map((c) => [c.id, BigInt(c.amount)]),
    )
    if (
      ids.length > (kind === "note" || kind === "escrow-note" ? maxNotesPerBatch : 1) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !available.has(id))
    ) {
      throw new StalePlanError("A selected source candidate is no longer refundable")
    }
    const amount = ids.reduce((sum, id) => sum + available.get(id)!, 0n)
    if (amount !== BigInt(batch.amount) || amount > maxBatchAmount)
      throw new StalePlanError("Restored source selection amount changed")
    const key = this.proofKey(target.recipientCommitment, kind, ids)
    const built = this.prepared.get(key) ?? (await this.o.runtime.build({ kind, ids }, target, 0n))
    if (built.amount !== BigInt(batch.amount))
      throw new Error("Restored source proof amount changed")
    await this.validateOperation(built.operation)
    this.prepared.set(key, built)
    return {
      netAmount: built.amount,
      operation: built.operation,
      asksApproval: asksApproval(kind),
    }
  }

  /** Throws unless `operation` calls the route's subsidy and pays out in the route's token. */
  private assertOperationOnRoute(operation: BroadcastL1Operation) {
    if (!sameAddress(operation.target.toString(), this.route.subsidy))
      throw new Error("The refund's operation does not call the route's migration subsidy")
    if (!sameAddress(operation.payoutToken.toString(), this.route.payoutToken))
      throw new Error("The refund's operation does not pay out in the route's payout token")
  }

  /**
   * Verify the refund against the deployed source portal and verifier before consuming destination
   * sponsorship. The operation must call the route's subsidy in its payout token. The migration
   * subsidy accepts only the operation executor as caller, so the refund is checked against the old
   * portal it forwards to unchanged. eth_call discards all effects.
   */
  private async validateOperation(operation: BroadcastL1Operation) {
    this.assertOperationOnRoute(operation)
    await this.o.client.call({
      account: this.o.owner,
      to: this.route.sourcePortal,
      data: `0x${operation.calldata.toString("hex")}`,
    })
  }

  /** Every saved `remaining-N` still in play, in order; an abandoned one is skipped. */
  private async remaining(): Promise<{ id: string; batch: FrozenMigrationFundingBatch }[]> {
    const out: { id: string; batch: FrozenMigrationFundingBatch }[] = []
    for (let index = 0; ; index++) {
      const id = `remaining-${index}`
      const batch = await this.o.batches.get(id)
      if (!batch) return out
      if (!batch.abandoned) out.push({ id, batch: await this.read(id) })
    }
  }

  private async nextIndex() {
    for (let index = 0; ; index++)
      if (!(await this.o.batches.get(`remaining-${index}`))) return index
  }

  /**
   * Plan every batch and prove it. Each batch's selection, coordinates and commitment are saved
   * before its approval; the batches still to approve go first, so a refused prompt never waits
   * behind proofs that ask nothing. With an `approvalPass`, every approval comes before any proof.
   * Re-running it resumes: saved batches keep their ids, coordinates and commitments, and only
   * funds no saved batch covers are planned anew. The minimum is the subsidy's, read fresh. New
   * coordinates avoid every saved batch of this run, `reserved`, and the coordinates that the
   * account's other runs saved (the `reservedCoordinates` option).
   */
  async prepareRemaining(
    opts: {
      /** Coordinates another SIPA of this migration already uses. */
      reserved?: { day: number; nonce: number }[]
      signal?: AbortSignal
      onApproval?: (approved: number, total: number) => Promise<void>
    } = {},
  ): Promise<void> {
    const o = this.o
    const route = this.route
    await o.runtime.validate(o.destinationAsset)
    const { candidates, waiting: _, ...limits } = await this.candidates()
    const available = new Map(candidates.map((c) => [c.id, BigInt(c.amount)]))
    // The subsidy's floor read now: its owner can raise it.
    await o.runtime.minimumMigratedAmount?.({ fresh: true })
    const minimumAmount = await this.batchMinimum()
    // An unsent batch whose selection lost an id, or that is not on the current route, or that is
    // below the subsidy's floor now, is planned again. A sent batch stays: its refund is valid on
    // chain.
    // TODO: A sent batch whose feature the manifest has since replaced keeps its ids covered here,
    // and it is never sent again (see `resendDue`). There is no plan to replace a feature now.
    // Handle this case if a migration feature is ever updated.
    const saved: { id: string; batch: FrozenMigrationFundingBatch }[] = []
    for (const entry of await this.remaining()) {
      const ids = entry.batch.sourceSelection!
      const holds =
        ids.every((id) => available.has(id)) &&
        ids.reduce((sum, id) => sum + available.get(id)!, 0n) === BigInt(entry.batch.amount) &&
        this.onRoute(entry.batch) &&
        BigInt(entry.batch.amount) >= minimumAmount
      if (entry.batch.broadcastTx || holds) saved.push(entry)
      else await o.batches.set(entry.id, { ...entry.batch, abandoned: true })
    }
    const covered = new Set(saved.flatMap(({ batch }) => batch.sourceSelection!))
    let left = candidates.filter((c) => !covered.has(c.id))
    const taken: { day: number; nonce: number }[] = [
      ...saved.map(({ batch }) => batch.direct),
      ...(opts.reserved ?? []),
      ...((await o.reservedCoordinates?.()) ?? []),
    ]
    const open = saved.filter(({ batch }) => !batch.broadcastTx)
    let index = await this.nextIndex()
    for (;;) {
      const selected = selectFrozenBatch({ ...limits, candidates: left, minimumAmount })
      if (!selected) break
      left = left.filter((c) => !selected.ids.includes(c.id))
      let coordinates = migrationSipaCoordinates()
      while (taken.some((t) => t.day === coordinates.day && t.nonce === coordinates.nonce))
        coordinates = migrationSipaCoordinates()
      taken.push(coordinates)
      const { recipientCommitment } = await migrationDirectCommitment(
        this.account,
        coordinates.day,
        coordinates.nonce,
      )
      const batch: FrozenMigrationFundingBatch = {
        binding: this.identity,
        recipient: recipientCommitment,
        amount: String(selected.amount),
        exitFee: "0",
        depositFee: "0",
        sourceSelection: selected.ids,
        sourceKind: selected.kind,
        fromBlock: String(await o.client.getBlockNumber()),
        createdAt: Date.now(),
        direct: {
          executor: route.executor,
          subsidy: route.subsidy,
          ...coordinates,
          recipientCommitment,
        },
      }
      const id = `remaining-${index++}`
      await o.batches.set(id, batch)
      open.push({ id, batch })
    }
    const toApprove = (batch: MigrationFundingBatch) =>
      asksApproval(batch.sourceKind) && !batch.approved
    const order = [
      ...open.filter(({ batch }) => toApprove(batch)),
      ...open.filter(({ batch }) => !toApprove(batch)),
    ]
    let approved = open.filter(
      ({ batch }) => asksApproval(batch.sourceKind) && batch.approved,
    ).length
    let total = open.filter(({ batch }) => asksApproval(batch.sourceKind)).length
    await opts.onApproval?.(approved, total)
    // Its funds moved while it was prepared: the next plan covers what is left of them.
    const abandon = async (entry: (typeof order)[number]) => {
      entry.batch = { ...entry.batch, abandoned: true }
      await o.batches.set(entry.id, entry.batch)
      if (asksApproval(entry.batch.sourceKind)) {
        if (entry.batch.approved) approved--
        total--
      }
      await opts.onApproval?.(approved, total)
    }
    const { approvalPass } = o
    if (approvalPass) {
      for (const entry of order.filter(({ batch }) => toApprove(batch))) {
        opts.signal?.throwIfAborted()
        try {
          await approvalPass(() => this.restore(entry.id, entry.batch.recipient as Address))
        } catch (error) {
          if (error instanceof StalePlanError) {
            await abandon(entry)
            continue
          }
          if (!(error instanceof ApprovalSavedError)) throw error
        }
        entry.batch = { ...entry.batch, approved: true }
        await o.batches.set(entry.id, entry.batch)
        approved++
        await opts.onApproval?.(approved, total)
      }
    }
    if (o.approvalsOnly?.()) return
    for (const entry of order) {
      if (entry.batch.abandoned) continue
      opts.signal?.throwIfAborted()
      try {
        await this.restore(entry.id, entry.batch.recipient as Address)
      } catch (error) {
        if (!(error instanceof StalePlanError)) throw error
        await abandon(entry)
        continue
      }
      if (!entry.batch.approved) {
        entry.batch = { ...entry.batch, approved: true }
        await o.batches.set(entry.id, entry.batch)
        if (asksApproval(entry.batch.sourceKind)) approved++
      }
      await opts.onApproval?.(approved, total)
    }
  }

  /**
   * Send every planned, unsent batch, one after another: each sponsored send waits for inclusion,
   * since the next spends the subscription note it re-inserts. A send never waits for a refund on
   * L1. Proofs come from memory or a rebuild from saved approvals; this never plans a batch. A sent
   * batch whose carrier failed, or whose refund has not executed in time, is sent again; see
   * {@link resendDue}. A failed carrier never holds up the batches after it. Each send runs inside
   * `gate`.
   */
  async recoverRemaining(signal?: AbortSignal, gate?: MigrationSendGate): Promise<void> {
    const o = this.o
    // L1 refund evidence first: a refunded batch's carrier landed, whatever its receipt says now.
    await this.reconcileBatches()
    await this.resendDueBatches(signal, true, gate)
    await this.assertNoNewFunds()
    for (const { id, batch } of await this.remaining()) {
      if (batch.broadcastTx) {
        // A carrier not yet included may still spend the note the next send needs, even once its
        // batch is refunded: wait for it.
        const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(batch.broadcastTx))
        if (carrierState(receipt) === "pending") return
        continue
      }
      signal?.throwIfAborted()
      const carrier = await this.carrier(id, batch)
      const { state } = await this.send(
        id,
        batch,
        carrier.calls,
        signal,
        { sentAt: Date.now(), operation: carrier.operation },
        gate,
      )
      if (state === "pending") return
    }
    await this.reconcileRemaining(signal, gate)
  }

  /**
   * Whether a sent batch's broadcast is sent again: its carrier `failed`, or its refund has not
   * executed {@link MIGRATION_RESEND_AFTER_MS} after its last send. Either way it is sent again
   * fewer than {@link MAX_MIGRATION_RESENDS} times. A batch whose route changed is never sent again
   * here.
   */
  private resendDue(batch: MigrationFundingBatch, failed: boolean): boolean {
    if (batch.refunded || batch.received || !batch.broadcastTx || !batch.direct) return false
    // TODO: A batch sent under a feature that the manifest has since replaced is never sent again
    // here, and `prepareRemaining` never plans its funds again. There is no plan to replace a
    // feature now. Handle this case if a migration feature is ever updated.
    if (!this.onRoute(batch)) return false
    if ((batch.resends ?? 0) >= MAX_MIGRATION_RESENDS) return false
    if (failed) return true
    const last = batch.resentAt ?? batch.sentAt
    return last !== undefined && Date.now() - last >= MIGRATION_RESEND_AFTER_MS
  }

  /**
   * Send again, in order, each sent batch that {@link resendDue} selects, and a failed one again at
   * once while it has sends left. Call it after the reconcile, which marks a batch whose refund
   * nullifier is spent. It sends nothing while any carrier is not yet included, a refunded batch's
   * too, since a send now may spend the note that carrier needs. `rebuild` lets a batch sent before
   * operations were saved prove its operation again; without it, such a batch is not sent again.
   * Without `rebuild`, or once a failed carrier has no send left, a subsidy that would not pay stops
   * the pass with no error, and a later pass tries again. Returns whether a failed carrier, whose
   * refund never ran, is never sent again.
   */
  private async resendDueBatches(
    signal: AbortSignal | undefined,
    rebuild: boolean,
    gate: MigrationSendGate | undefined,
  ): Promise<boolean> {
    const o = this.o
    const sent = (await this.remaining()).filter(({ batch }) => batch.broadcastTx)
    const exhausted = (batch: MigrationFundingBatch, state: CarrierState) =>
      state === "failed" && !batch.refunded && !batch.received && !this.resendDue(batch, true)
    const states: CarrierState[] = []
    let stuck = false
    for (const { batch } of sent) {
      const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(batch.broadcastTx!))
      const state = carrierState(receipt)
      if (state === "pending") return false
      states.push(state)
      stuck ||= exhausted(batch, state)
    }
    for (const [i, { id, batch: first }] of sent.entries()) {
      let batch: MigrationFundingBatch = first
      let state = states[i]!
      while (this.resendDue(batch, state === "failed") && (rebuild || batch.operation)) {
        signal?.throwIfAborted()
        let carrier
        try {
          carrier = await this.carrier(id, batch)
        } catch (error) {
          // Refunded or no longer refundable since the reconcile: nothing to send again.
          if (error instanceof StalePlanError) break
          if ((!rebuild || stuck) && error instanceof MigrationSubsidyNotReadyError) return stuck
          throw error
        }
        ;({ batch, state } = await this.send(
          id,
          batch,
          carrier.calls,
          signal,
          {
            resends: (batch.resends ?? 0) + 1,
            resentAt: Date.now(),
            operation: carrier.operation,
          },
          gate,
        ))
        if (state === "pending") return false
      }
      stuck ||= exhausted(batch, state)
    }
    return stuck
  }

  /**
   * Sends a batch's carrier under recurring sponsorship and saves its hash with `update`. The send
   * and the save of its hash run inside `gate`, as the operation that `gate` names. Returns the
   * saved batch and its carrier's state: a send that fails once its hash is saved is read from its
   * receipt, not thrown.
   */
  private async send(
    id: string,
    batch: MigrationFundingBatch,
    innerCalls: Awaited<ReturnType<FrozenMetadataMigrationSource["carrier"]>>["calls"],
    signal: AbortSignal | undefined,
    update: Partial<MigrationFundingBatch>,
    gate: MigrationSendGate = (step) => step(),
  ): Promise<{ batch: MigrationFundingBatch; state: CarrierState }> {
    const o = this.o
    const payload = await buildClaimSponsorPayload({ ...o.registered, innerCalls })
    let saved = undefined as MigrationFundingBatch | undefined
    try {
      await gate(async (operationId) => {
        // A send cancelled while it waited its turn never starts.
        signal?.throwIfAborted()
        await o.wallet.sendTx(payload, {
          from: NO_FROM,
          sendMessagesAs: o.registered.user,
          additionalScopes: [o.registered.user],
          fee: claimFpcSponsoredFee(o.registered.policy, innerCalls),
          operationId,
          onTxHash: async (hash) => {
            signal?.throwIfAborted()
            const next = { ...batch, ...update, broadcastTx: hash }
            await o.batches.set(id, next)
            saved = next
            // The batch holds the hash, so the operation is safe to reload over.
            if (operationId) provingProgress.emitTxHashSaved(operationId, hash)
          },
        })
      })
    } catch (error) {
      if (!saved || signal?.aborted) throw error
      const receipt = await o.wallet.node.getTxReceipt(TxHash.fromString(saved.broadcastTx!))
      signal?.throwIfAborted()
      return { batch: saved, state: carrierState(receipt) }
    }
    return { batch: saved ?? batch, state: "included" }
  }

  /**
   * A batch's carrier, sent once a fresh read shows the subsidy pays its relayer: the deposit's
   * announcement to the account on L2, then the refund's broadcast, in one transaction. No SIPA
   * exists; the announcement lets any device of the account find the deposit by its commitment and
   * claim it. A re-send carries the same announcement, with the same salt, and the operation saved
   * at the first send byte for byte, so the relayer sees the same operation id; a batch sent before
   * operations were saved is rebuilt instead. Returns the calls and the operation to save.
   */
  private async carrier(id: string, batch: MigrationFundingBatch) {
    const operation = batch.operation
      ? savedOperation(batch.operation)
      : (await this.restore(id, batch.recipient as Address)).operation
    this.assertOperationOnRoute(operation)
    await this.o.runtime.assertMigrationReady?.(
      { kind: batch.sourceKind ?? "note", ids: batch.sourceSelection! },
      BigInt(batch.amount),
    )
    const { day, nonce, recipientCommitment } = batch.direct!
    return {
      calls: [
        ...(await migrationDirectAnnouncementCalls(this.account, day, nonce, recipientCommitment)),
        ...(await broadcastL1Operation(this.o.broadcaster, operation).request()).calls,
      ],
      operation: saveOperation(operation),
    }
  }

  /**
   * Bring every sent batch up to date from chain evidence, then send again each broadcast that is
   * due ({@link resendDue}), byte for byte as first sent. A re-send asks no approval: a batch with
   * no saved operation is not sent again here. A failed carrier with no send left stops the run for
   * the user. Funds that reach the source once every batch settled wait for the user's approval. A
   * cancelled `signal` stops it before a send records a new hash. Each send runs inside `gate`.
   */
  async reconcileRemaining(signal?: AbortSignal, gate?: MigrationSendGate): Promise<void> {
    await this.reconcileBatches()
    if (await this.resendDueBatches(signal, false, gate))
      throw new MigrationHaltedError(
        "reverted",
        "A remaining-funds broadcast failed on every send; its saved refund requires attention",
      )
    await this.assertNoNewFunds()
  }

  /**
   * Bring every sent batch up to date from chain evidence. It never signs and never sends. The
   * rail's claim of a batch's amount is its receipt and proves its refund. A spent refund
   * nullifier on L1 is the refund, whatever its carrier's receipt says.
   */
  private async reconcileBatches(): Promise<void> {
    const o = this.o
    for (const { id, batch } of await this.remaining()) {
      if (!batch.broadcastTx || batch.received) continue
      if (await this.settled(batch)) {
        await o.batches.set(id, { ...batch, refunded: true, received: true })
      } else if (!batch.refunded && (await o.runtime.refunded(batch.sourceSelection!))) {
        await o.batches.set(id, { ...batch, refunded: true })
      }
    }
  }

  /** Funds that reach the source once every batch settled wait for the user's approval. */
  private async assertNoNewFunds(): Promise<void> {
    if ((await this.allSettled()) && (await this.movable(true)))
      throw new ApprovalNeededError("More funds reached the old version; approve moving them")
  }

  /** Whether every planned batch has been sent. */
  async remainingSent(): Promise<boolean> {
    return (await this.remaining()).every(({ batch }) => !!batch.broadcastTx)
  }

  /** Complete once every planned batch settled and a fresh scan finds no batch to move. */
  async remainingComplete(): Promise<boolean> {
    if (!(await this.allSettled())) return false
    return !(await this.movable(true))
  }
}

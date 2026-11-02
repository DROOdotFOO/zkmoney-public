/**
 * Drives a backup-passkey rotation through its phases: one step per transition over injected
 * dependencies, and `resume` for a record found on load. A resume trusts nothing the record says
 * about the chain: it checks the record is well formed and the root key's, reconciles what the
 * chain and the other stores already show, and only then judges a precondition or runs a step.
 * No UI, no ceremony, no React.
 */
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import {
  BackupSetConflictError,
  isSpendEnvelopeRefusal,
  VerificationUnavailableError,
  type PersistedRotation,
  type PersistedRotationVerdict,
  type RotationFundability,
  type SpendShape,
  type TxHashCallback,
} from "@obsidion/sdk"
import type { Address, Hex } from "viem"
import { INCLUDED_TIERS, type ReorgTxReceiptLike } from "../services/chain/receiptTypes"
import {
  fundingLanding,
  fundingLocalId,
  fundingStarted,
  moveDeclined,
  persistedRotation,
  storeRotation,
  stripSettled,
  type BackupFunding,
  type BackupPublish,
  type BackupRotationPhase,
  type BackupRotationPlan,
  type BackupRotationRecord,
  type BackupRotationStore,
  type MoveChunkRecord,
  type MoveRun,
} from "../storages/BackupRotationStore"
import { planMove, type MoveDeposits } from "./planMove"

export const PUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Republishes before a funded, unswept deposit address is reported as stranded. */
export const PUBLISH_BOUND = 12

// ---------------------------------------------------------------------------------------------
// The one classifier of an L2 transaction, by hash alone.

export type TxOutcome =
  | {
      kind: "included"
      blockNumber: number
      blockHash: string
      effect: "success" | "reverted"
      /** In an L1 checkpoint: past the tiers the sequencer alone can drop. */
      checkpointed: boolean
    }
  | { kind: "mined" }
  | { kind: "reverted" }
  | { kind: "pending" }
  | { kind: "dead" }
  | { kind: "unknown" }

export interface OutcomeNode {
  getTxReceipt(txHash: string): Promise<ReorgTxReceiptLike>
  /** The block timestamp of the node's finalized tip, ms. */
  finalizedTimestampMs(): Promise<number>
}

/**
 * `included` at a reorgable tier, with the block kept for re-reading and whether an L1 checkpoint
 * holds it; `mined` once final; `reverted`
 * only when final; a transaction the node does not hold is `pending` until both the wallet's clock
 * and the finalized tip are past its expiry (for good, with no expiry known), and `dead` once a
 * read taken after that still misses it. The expiry is capped by the wallet's clock, so a chain
 * whose clock runs ahead of the wallet's cannot kill a transaction it has yet to receive. A read
 * that fails answers `unknown` and moves nothing.
 */
export async function txOutcome(
  node: OutcomeNode,
  txHash: string,
  expiresAtMs: number | undefined,
  nowMs: number = Date.now(),
): Promise<TxOutcome> {
  try {
    const seen = held(await node.getTxReceipt(txHash))
    if (seen) return seen
    if (expiresAtMs === undefined || nowMs <= expiresAtMs) return { kind: "pending" }
    if ((await node.finalizedTimestampMs()) <= expiresAtMs) return { kind: "pending" }
    return held(await node.getTxReceipt(txHash)) ?? { kind: "dead" }
  } catch {
    return { kind: "unknown" }
  }
}

/** The outcome of a transaction the node holds; nothing for one it does not. */
function held(receipt: ReorgTxReceiptLike): TxOutcome | undefined {
  const reverted = receipt.executionResult === TxExecutionResult.REVERTED
  if (receipt.status === TxStatus.FINALIZED) return { kind: reverted ? "reverted" : "mined" }
  if (INCLUDED_TIERS.has(receipt.status)) {
    return {
      kind: "included",
      blockNumber: receipt.blockNumber ?? 0,
      blockHash: receipt.blockHash ?? "",
      effect: reverted ? "reverted" : "success",
      checkpointed: receipt.status !== TxStatus.PROPOSED,
    }
  }
  return receipt.status === TxStatus.PENDING ? { kind: "pending" } : undefined
}

// ---------------------------------------------------------------------------------------------
// Dependencies.

/** The withdrawal tracker's row for a funding, as the reconciliation reads it. */
export interface FundingRow {
  phase: string
  l2TxHash?: string
  /** The portal's id for the withdrawal, known from `finalizing_l1` on. */
  withdrawalId?: string
  /** When the row was seeded, before its burn. */
  startTime: number
  recipient: string
}

export interface SweepSeen {
  index: string
  blockNumber: number
  blockHash: Hex
  credited: bigint
}

export interface RotationL1 {
  finalizedBlock(): Promise<{ number: number; hash: Hex }>
  /** Whether the block is still in the finalized chain. */
  isFinal(block: { blockNumber: number; blockHash: Hex }): Promise<boolean>
  /** The deposit address's balance at the finalized block, or at the latest one when asked. */
  sipaBalance(sipa: Address, at?: "finalized" | "latest"): Promise<bigint>
  /** The deposit address's sweep since `fromBlock`, if one ran. */
  sweep(sipa: Address, fromBlock: number): Promise<SweepSeen | undefined>
  /**
   * The latest transfer out of the deposit address since `fromBlock` in a transaction with no sweep.
   * Only a sweep or a recovery moves tokens out, so it is a recovery.
   */
  recovery(sipa: Address, fromBlock: number): Promise<Hex | undefined>
  /** Whether the portal shows the withdrawal spent at the finalized block. */
  releaseFinal(withdrawalId: string): Promise<boolean>
}

export interface MoveDeps {
  tokens(): Promise<string[]>
  /** The one-key account's shape on `token`, read while no chunk is in flight. */
  shape(token: string): Promise<SpendShape>
  deposits(token: string, shape: SpendShape): Promise<MoveDeposits>
  cap: bigint
  usesLeft(): Promise<boolean>
  /**
   * One sponsored transfer of `amount` to the two-key account; the root key signs it. Once `signal`
   * aborts, the root key is not asked and the send rejects with its reason.
   */
  send(token: string, amount: bigint, onTxHash: TxHashCallback, signal?: AbortSignal): Promise<void>
  /** Whether `send` failed because the user closed the root key's prompt. */
  declined(err: unknown): boolean
}

export interface RotationFlowDeps {
  store: BackupRotationStore
  now(): number
  mintAttemptId(): string
  /** When this tab became the active one; a row seeded before it belongs to no live burn. */
  activeSince: number
  /** An id for this life of the wallet; a funding seeded or a chunk claimed under another has no send behind it. */
  session: string
  /** The structural check: the sdk's verification plus the signer's decode, over this device's truth. */
  verify(rotation: PersistedRotation): Promise<PersistedRotationVerdict>
  /** Whether the signed change can still run. Throws `BackupSetConflictError`. */
  fundability(rotation: PersistedRotation): Promise<RotationFundability>
  /** The sweep route read live and the signed sweep quoted again. */
  route(rotation: PersistedRotation): Promise<"ok" | "route">
  l1: RotationL1
  node: OutcomeNode
  tracker: {
    row(localId: string): Promise<FundingRow | undefined>
    /** Stamps the row with its hash at the submit boundary, as the tracker does later. */
    stamp(localId: string, txHash: string): Promise<void>
  }
  sign(rotation: Omit<PersistedRotation, "signature">): Promise<Hex>
  /** Writes the deposit address's rail record and enqueues its broadcast. */
  publish(record: BackupRotationRecord, rotation: PersistedRotation): Promise<void>
  /** Sends the landed broadcast again from the current block, so the relayer takes the sweep up again. */
  republish(record: BackupRotationRecord): Promise<void>
  /** The funding withdrawal to the deposit address; `onTxHash` is awaited before the node takes it. */
  fund(
    record: BackupRotationRecord,
    funding: BackupFunding,
    onTxHash: TxHashCallback,
  ): Promise<void>
  /** Runs the wallet on the two-key account, writing each checkpoint as it completes; answers them all. */
  reroot(
    record: BackupRotationRecord,
    checkpoint: (fields: RerootCheckpoints) => Promise<void>,
  ): Promise<RerootCheckpoints>
  move: MoveDeps
}

export type RerootCheckpoints = NonNullable<BackupRotationRecord["reroot"]>

/** Why a step stopped without a transition. */
export type FlowWait =
  | "unverifiable"
  | "applied-pending"
  | "funding"
  | "sweep"
  | "burn"
  | "chunk"
  | "uses"
  | "recovery"
  | "declined"
  /** A planned chunk waits for the user to approve its send. */
  | "approval"

export interface FlowResult {
  record: BackupRotationRecord
  wait?: FlowWait
}

export type FlowRefusal = "gone" | "phase" | "funding-open" | "not-cancellable"

export interface RunOptions {
  /** Whether a step may ask for the root passkey: set only for a run the user's tap started. */
  prompt?: boolean
  /** Aborted once the screen the tap came from closes: a send that has not asked yet waits instead. */
  signal?: AbortSignal
}

/** A step the record's state refuses. */
export class RotationFlowError extends Error {
  constructor(readonly code: FlowRefusal, message: string) {
    super(`backup rotation: ${message}`)
    this.name = "RotationFlowError"
  }
}

/** A refusal because the record changed under the step; the store's change already shows the outcome. */
export const recordMoved = (error: unknown): boolean =>
  error instanceof RotationFlowError && (error.code === "phase" || error.code === "gone")

/** A funding's hash could not be written durably; the send is aborted before the node takes it. */
export class FundingCheckpointError extends Error {
  constructor(cause: unknown) {
    super("backup rotation: the funding's hash was not saved", { cause })
    this.name = "FundingCheckpointError"
  }
}

// ---------------------------------------------------------------------------------------------
// Record writes.

type Patch = (current: BackupRotationRecord) => Partial<BackupRotationRecord> | null

/**
 * Patches the attempt over what the store holds. A replaced or removed attempt throws `gone`; a
 * patch the stored record declines throws `phase`, so no step goes on over a record that moved.
 */
async function save(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  patch: Patch,
): Promise<BackupRotationRecord> {
  let applied = false
  const stored = await deps.store.update(record.owner, (current) => {
    if (!current || current.attemptId !== record.attemptId) return null
    const fields = patch(current)
    if (!fields) return null
    applied = true
    return { ...current, ...fields, updatedAt: deps.now() }
  })
  if (stored?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  if (!applied) throw new RotationFlowError("phase", "the record moved on")
  return stored
}

/** The side state, keeping the phase it interrupts so the record can return there. */
const attention = (
  current: BackupRotationRecord,
  reason: NonNullable<BackupRotationRecord["attention"]>,
): Partial<BackupRotationRecord> => ({
  phase: "attention",
  attention: reason,
  suspended: current.phase === "attention" ? current.suspended : current.phase,
})
const CLEARED = { attention: undefined, suspended: undefined } as const
/** Back to `created`, the backup kept: the signed change is dropped for a fresh one. */
const RESTART: Partial<BackupRotationRecord> = {
  phase: "created",
  plan: undefined,
  rotation: undefined,
  fromBlock: undefined,
  publish: undefined,
  ...CLEARED,
}
/** The account's keys changed elsewhere, so the signed change cannot run; nothing of it was funded. */
const CONFLICT: Partial<BackupRotationRecord> = { phase: "conflict", ...CLEARED }

const SETTLED: readonly BackupRotationPhase[] = ["funded", "swept", "rerooted", "moved", "done"]
const rank = (phase: BackupRotationPhase) => SETTLED.indexOf(phase)
/** A side state ranks below every settled phase, so a settled phase supersedes it. */
const before = (record: BackupRotationRecord, phase: BackupRotationPhase) =>
  rank(record.phase) < rank(phase)

const whole = (record: BackupRotationRecord): PersistedRotation | undefined =>
  record.rotation?.signature && record.rotation.sharedSecretSalt && record.rotation.add.envelope
    ? persistedRotation(record.rotation)
    : undefined

const inFlight = (record: BackupRotationRecord) => record.fundings.some(fundingLanding)

/** The phase the record's money is judged in: a parked route's is the one it left. */
const acting = (record: BackupRotationRecord): BackupRotationPhase =>
  record.phase === "attention" && record.attention === "route" && record.suspended
    ? record.suspended
    : record.phase

const sameFunding = (a: BackupFunding, b: BackupFunding) =>
  a.attemptId === b.attemptId &&
  a.txHash === b.txHash &&
  a.outcome === b.outcome &&
  a.expiresAtMs === b.expiresAtMs

/**
 * Whether the store still reads as the snapshot a step decided over, so the decision applies: the
 * same phase and side state, the same signed change, and the same fundings entry for entry.
 */
const unmoved = (c: BackupRotationRecord, snapshot: BackupRotationRecord) =>
  c.phase === snapshot.phase &&
  c.attention === snapshot.attention &&
  c.suspended === snapshot.suspended &&
  c.rotation?.sipa === snapshot.rotation?.sipa &&
  c.fundings.length === snapshot.fundings.length &&
  c.fundings.every((f, i) => sameFunding(f, snapshot.fundings[i]!))

/** Whether the move runs still read as the snapshot a cut was taken over. */
const sameRuns = (c: BackupRotationRecord, snapshot: BackupRotationRecord) =>
  JSON.stringify(c.move?.runs ?? []) === JSON.stringify(snapshot.move?.runs ?? [])

const sweepKept = (sweep: SweepSeen): NonNullable<BackupRotationRecord["sweep"]> => ({
  index: sweep.index,
  blockHash: sweep.blockHash,
  credited: sweep.credited.toString(),
})

/** The sweep recorded; which funding it took is judged by the reconciliation, not here. */
const sweptPatch = (sweep: SweepSeen): Patch => {
  const kept = sweepKept(sweep)
  return (c) => ({
    ...(before(c, "swept") ? { phase: "swept", ...CLEARED } : {}),
    sweep: kept,
    recovery: undefined,
  })
}

/** The fundability read, a conflict answered as a verdict. */
async function readFundability(
  deps: RotationFlowDeps,
  rotation: PersistedRotation,
): Promise<RotationFundability | "conflict"> {
  try {
    return await deps.fundability(rotation)
  } catch (err) {
    if (err instanceof BackupSetConflictError) return "conflict"
    throw err
  }
}

/** The change ran without this wallet's funding; money already held at the deposit address stays the user's to recover. */
const installedPatch = async (
  deps: RotationFlowDeps,
  rotation: PersistedRotation,
): Promise<Patch> => {
  const block = await deps.l1.finalizedBlock()
  const held = await depositHeld(deps, rotation.sipa)
  return () => ({
    phase: "installed",
    installed: { blockHash: block.hash },
    ...CLEARED,
    ...(held ? { unswept: true } : {}),
    recovery: undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// Steps.

export interface SignInput {
  prepared: Omit<PersistedRotation, "signature">
  plan: BackupRotationPlan
  /** The L1 block now: where every read of the deposit address starts. */
  fromBlock: number
}

/** `created` → `signed`: the root key signs the prepared change; the record keeps it whole. */
export async function signRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  input: SignInput,
): Promise<BackupRotationRecord> {
  if (record.phase !== "created") throw new RotationFlowError("phase", "already signed")
  const signature = await deps.sign(input.prepared)
  return save(deps, record, (c) =>
    c.phase === "created"
      ? {
          phase: "signed",
          plan: input.plan,
          rotation: storeRotation({ ...input.prepared, signature }),
          fromBlock: input.fromBlock,
        }
      : null,
  )
}

/**
 * The checks before anything is published or funded: the route and the quote, then the
 * fundability read. Answers the phase the record goes to instead, or nothing to proceed. A change
 * the factory no longer clones restarts the attempt at `created`, since a funding of it would
 * strand; money already at its deposit address strands it instead. Every answer is written over
 * the record as read here, so a record that moved during the reads declines it.
 */
async function preconditions(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  rotation: PersistedRotation,
): Promise<{ patch: Patch; wait?: FlowWait } | undefined> {
  const fenced =
    (patch: Patch): Patch =>
    (c) =>
      unmoved(c, record) ? patch(c) : null
  if ((await deps.route(rotation)) !== "ok") return { patch: fenced((c) => attention(c, "route")) }
  switch (await readFundability(deps, rotation)) {
    case "conflict":
      return { patch: fenced(() => CONFLICT) }
    case "applied":
      return { patch: fenced(await installedPatch(deps, rotation)) }
    case "applied-pending":
      return { patch: fenced(() => ({})), wait: "applied-pending" }
    case "superseded": {
      const held = await depositHeld(deps, rotation.sipa)
      return { patch: fenced((c) => (held ? attention(c, "stranded") : RESTART)) }
    }
    default:
      return undefined
  }
}

/**
 * `signed` → `published`: the deposit address is written to the rail and its broadcast enqueued; what
 * the executor already counted stays.
 */
export async function publishRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const rotation = whole(record)
  if (!rotation || record.phase !== "signed") throw new RotationFlowError("phase", "not signed")
  const stop = await preconditions(deps, record, rotation)
  if (stop) return { record: await save(deps, record, stop.patch), wait: stop.wait }
  await deps.publish(record, rotation)
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record)
        ? { phase: "published", publish: c.publish ?? { count: 0, history: [] } }
        : null,
    ),
  }
}

/**
 * `published` → `funded`: one funding send, its entry appended before it goes out. The hash is
 * written to the record and the tracker's row before the node takes the transaction; a write that
 * fails aborts the send, as does a record a resume parked meanwhile. A throw before the hash marks
 * the entry `never-sent`; the phase moves on the hash alone. A deposit address that already holds
 * settled money moves on with no send.
 */
export async function fundRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const rotation = whole(record)
  if (!rotation || record.phase !== "published")
    throw new RotationFlowError("phase", "not published")
  if (inFlight(record)) throw new RotationFlowError("funding-open", "a funding may still land")
  const stop = await preconditions(deps, record, rotation)
  if (stop) return { record: await save(deps, record, stop.patch), wait: stop.wait }
  if (await depositFunded(deps, record)) {
    return {
      record: await save(deps, record, (c) => (unmoved(c, record) ? { phase: "funded" } : null)),
    }
  }
  const attemptId = fundingStarted(record) ? deps.mintAttemptId() : record.attemptId
  const entry: BackupFunding = {
    attemptId,
    localId: fundingLocalId(attemptId),
    sentAt: deps.now(),
    session: deps.session,
    outcome: "pending",
  }
  const seeded = await save(deps, record, (c) =>
    unmoved(c, record) ? { fundings: [...c.fundings, entry] } : null,
  )
  const pending = (c: BackupRotationRecord) =>
    c.fundings.some((f) => f.attemptId === attemptId && f.outcome === "pending")
  const withEntry = (c: BackupRotationRecord, fields: Partial<BackupFunding>) =>
    c.fundings.map((f) => (f.attemptId === attemptId ? { ...f, ...fields } : f))
  /** Writes `fields` on the entry while it is still pending; a resolved entry declines the write. */
  const patchEntry = (fields: Partial<BackupFunding>) =>
    save(deps, seeded, (c) => (pending(c) ? { fundings: withEntry(c, fields) } : null))
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    try {
      await save(deps, seeded, (c) =>
        pending(c) && c.phase === "published"
          ? { phase: "funded", fundings: withEntry(c, { txHash: txHash as Hex, expiresAtMs }) }
          : null,
      )
    } catch (err) {
      throw new FundingCheckpointError(err)
    }
    try {
      await deps.tracker.stamp(entry.localId, txHash)
    } catch (err) {
      await save(deps, seeded, (c) =>
        pending(c)
          ? {
              ...(c.phase === "funded" ? { phase: "published" } : {}),
              fundings: withEntry(c, { outcome: "never-sent" }),
            }
          : null,
      ).catch(() => undefined)
      throw new FundingCheckpointError(err)
    }
  }
  try {
    await deps.fund(seeded, entry, onTxHash)
  } catch (err) {
    try {
      const current = await deps.store.get(record.owner)
      const sent = current?.fundings.find((f) => f.attemptId === attemptId)
      if (sent && !sent.txHash && sent.outcome === "pending") {
        await patchEntry({ outcome: "never-sent" })
      }
    } catch {
      // The entry stays pending; a resume ends it.
    }
    throw err
  }
  const after = await deps.store.get(record.owner)
  if (after?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  return { record: after }
}

/**
 * `funded` → `swept`: the deposit address's sweep, counted once its block is final; it supersedes a
 * stranded report, except on a finished attempt, which keeps nothing to move on with. A sweep gone
 * before finality returns the record to `funded`; the publish bound reached with the funding
 * unswept, a route that died, or a withdrawal row naming another address are reported as attention.
 */
export async function watchRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const watching =
    record.phase === "funded" ||
    record.phase === "swept" ||
    (record.phase === "attention" &&
      record.attention === "stranded" &&
      record.suspended !== "done" &&
      record.suspended !== "recovered")
  const sipa = record.rotation?.sipa
  if (!watching || !sipa || record.fromBlock === undefined)
    throw new RotationFlowError("phase", "nothing to watch")
  /** Every write is over the record as this watch read it; one that moved since declines. */
  const fenced =
    (patch: Patch): Patch =>
    (c) =>
      unmoved(c, record) ? patch(c) : null
  const sweep = await deps.l1.sweep(sipa, record.fromBlock)
  if (sweep) {
    if (!(await deps.l1.isFinal(sweep))) return { record, wait: "sweep" }
    const { fundings, corrupt } = await reconcileFundings(deps, record)
    return {
      record: await save(
        deps,
        record,
        fenced((c) => ({
          fundings,
          ...(corrupt ? attention(c, "corrupt") : sweptPatch(sweep)(c)),
        })),
      ),
    }
  }
  if (record.sweep) {
    return {
      record: await save(
        deps,
        record,
        fenced(() => ({ phase: "funded", sweep: undefined, ...CLEARED })),
      ),
    }
  }
  const rotation = whole(record)
  // A stranded report stays: nothing is sent from there, and a route park could be cancelled.
  const stranded = record.phase === "attention" && record.attention === "stranded"
  if (rotation && !stranded && (await deps.route(rotation)) !== "ok") {
    return {
      record: await save(
        deps,
        record,
        fenced((c) => attention(c, "route")),
      ),
    }
  }
  const count = record.publish?.count ?? 0
  if (count >= PUBLISH_BOUND && (await readDeposit(deps, sipa)).settled) {
    return {
      record: await save(
        deps,
        record,
        fenced((c) => attention(c, "stranded")),
      ),
    }
  }
  // The relayer drops a waiting sweep on its own clock; a funded address is published again on the interval.
  if (
    record.phase === "funded" &&
    count < PUBLISH_BOUND &&
    publishLanded(record, 0) &&
    publishDue(record.publish, deps.now()).due
  )
    await deps.republish(record)
  return { record, wait: "sweep" }
}

/** `swept` or `installed` → `rerooted`: the wallet runs on the two-key account. */
export async function rerootRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  if (record.phase !== "swept" && record.phase !== "installed") {
    throw new RotationFlowError("phase", "not swept")
  }
  const checkpoint = async (fields: RerootCheckpoints) => {
    await save(deps, record, (c) =>
      c.phase === record.phase ? { reroot: { ...c.reroot, ...fields } } : null,
    )
  }
  const reroot = await deps.reroot(record, checkpoint)
  return save(deps, record, (c) =>
    c.phase === record.phase ? { phase: "rerooted", reroot: { ...c.reroot, ...reroot } } : null,
  )
}

const chunkDone = (c: MoveChunkRecord) =>
  c.state === "mined" || (c.state === "included" && c.effect !== "reverted")
/** A chunk a send holds or the node still decides: claimed, submitted, or included with its transfer reverted and not checkpointed. */
const chunkOpen = (c: MoveChunkRecord) =>
  c.state === "claimed" ||
  c.state === "submitted" ||
  (c.state === "included" && c.effect === "reverted")

/** The latest run with `fields` written on its chunk at `at`, and `run` on the run. */
const runsWith = (
  c: BackupRotationRecord,
  at: number,
  fields: Partial<MoveChunkRecord>,
  run: Partial<MoveRun> = {},
): Partial<BackupRotationRecord> => {
  const runs = c.move?.runs ?? []
  const latest = runs.at(-1)!
  const chunks = latest.chunks.map((x, i) => (i === at ? { ...x, ...fields } : x))
  return { move: { runs: [...runs.slice(0, -1), { ...latest, ...run, chunks }] } }
}

/**
 * The run's chunks after their transactions are read again; nothing is read for a chunk with no
 * hash, and one saved with no expiry ends by receipt alone. A chunk is `mined` once an L1 checkpoint
 * holds it; one that reverted there is planned again. A claim from another life of the wallet has
 * no send behind it and is planned again.
 */
async function readChunks(deps: RotationFlowDeps, run: MoveRun): Promise<MoveChunkRecord[]> {
  return Promise.all(
    run.chunks.map(async (chunk): Promise<MoveChunkRecord> => {
      if (chunk.state === "claimed") {
        return chunk.claim?.session === deps.session
          ? chunk
          : { token: chunk.token, amount: chunk.amount, state: "planned" }
      }
      if (!chunk.txHash || chunk.state === "mined") return chunk
      const outcome = await txOutcome(deps.node, chunk.txHash, chunk.expiresAtMs, deps.now())
      switch (outcome.kind) {
        case "included":
          if (outcome.checkpointed) {
            return outcome.effect === "reverted"
              ? { token: chunk.token, amount: chunk.amount, state: "planned" }
              : { ...chunk, state: "mined", effect: undefined }
          }
          return {
            ...chunk,
            state: "included",
            inclusion: { blockNumber: outcome.blockNumber, blockHash: outcome.blockHash },
            ...(outcome.effect === "reverted"
              ? { effect: "reverted" as const }
              : { effect: undefined }),
          }
        case "mined":
          return { ...chunk, state: "mined", effect: undefined }
        case "reverted":
        case "dead":
          return { token: chunk.token, amount: chunk.amount, state: "planned" }
        case "pending":
          return chunk.state === "included"
            ? { ...chunk, state: "submitted", inclusion: undefined, effect: undefined }
            : chunk
        default:
          return chunk
      }
    }),
  )
}

/** A fresh cut of what the run still owes, over the live shape. */
async function cut(deps: RotationFlowDeps, token: string, owed: bigint) {
  const shape = await deps.move.shape(token)
  const deposits = await deps.move.deposits(token, shape)
  const balance = owed < shape.balance ? owed : shape.balance
  return planMove({ ...shape, balance }, deps.move.cap, deposits)
}

/**
 * `rerooted` → `moved` → `done`: the one-key account's balance forwarded in chunks, one sponsored
 * transfer per chunk, each re-cut from the live shape and sent only while no chunk of the run is
 * in flight and the user has not closed the run's last prompt. `moved` once every chunk is
 * included; `done` once every chunk is checkpointed and nothing is left to move. With `prompt` off, or
 * its `signal` aborted, the next send waits at `approval`.
 */
export async function moveRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt = true, signal }: RunOptions = {},
): Promise<FlowResult> {
  if (record.phase !== "rerooted" && record.phase !== "moved") {
    throw new RotationFlowError("phase", "not rerooted")
  }
  let runs = record.move?.runs ?? []
  let run = runs.at(-1)
  let current = record
  /** Writes over the runs as this step read them; a chunk another step moved since declines it. */
  const write =
    (snapshot: BackupRotationRecord, fields: Partial<BackupRotationRecord>): Patch =>
    (c) =>
      c.phase === snapshot.phase && sameRuns(c, snapshot) ? fields : null
  if (run) {
    const chunks = await readChunks(deps, run)
    run = { ...run, chunks }
    runs = [...runs.slice(0, -1), run]
    current = await save(deps, current, write(current, { move: { runs } }))
    if (chunks.some(chunkOpen)) return { record: current, wait: "chunk" }
    const planned = chunks.filter((c) => c.state === "planned")
    if (planned.length > 0) {
      const kept = chunks.filter(chunkDone)
      const recut: MoveChunkRecord[] = []
      let depositBound = run.depositBound
      for (const token of new Set(planned.map((c) => c.token))) {
        const owed = planned
          .filter((c) => c.token === token)
          .reduce((t, c) => t + BigInt(c.amount), 0n)
        const fresh = await cut(deps, token, owed)
        depositBound ||= fresh.bound === "upper"
        recut.push(
          ...fresh.chunks.map((c) => ({
            token,
            amount: c.amount.toString(),
            state: "planned" as const,
          })),
        )
      }
      run = {
        ...run,
        m: kept.length + recut.length,
        depositBound,
        // A decline holds only over a chunk still to send.
        declined: recut.length > 0 ? run.declined : undefined,
        chunks: [...kept, ...recut],
      }
      runs = [...runs.slice(0, -1), run]
      current = await save(deps, current, write(current, { move: { runs } }))
    }
  }
  if (!run || run.chunks.every(chunkDone)) {
    if (run && !run.chunks.every((c) => c.state === "mined")) {
      // Nothing new until the run is checkpointed: a chunk that drops out is resent in this run.
      return {
        record: await save(deps, current, (c) =>
          c.phase === "rerooted" ? { phase: "moved" } : {},
        ),
        wait: "chunk",
      }
    }
    const fresh: MoveChunkRecord[] = []
    let depositBound = false
    for (const token of await deps.move.tokens()) {
      const shape = await deps.move.shape(token)
      const plan = planMove(shape, deps.move.cap, await deps.move.deposits(token, shape))
      depositBound ||= plan.bound === "upper"
      fresh.push(
        ...plan.chunks.map((c) => ({
          token,
          amount: c.amount.toString(),
          state: "planned" as const,
        })),
      )
    }
    if (fresh.length === 0) return { record: await finishRotation(deps, current) }
    run = { plannedAt: deps.now(), m: fresh.length, depositBound, chunks: fresh }
    runs = [...runs, run]
    current = await save(deps, current, write(current, { phase: "rerooted", move: { runs } }))
  }
  return sendNextChunk(deps, current, { prompt, signal })
}

async function sendNextChunk(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt, signal }: RunOptions,
): Promise<FlowResult> {
  const runs = record.move!.runs
  const run = runs.at(-1)!
  const at = run.chunks.findIndex((c) => c.state === "planned")
  if (at < 0) return { record, wait: "chunk" }
  if (run.declined) return { record, wait: "declined" }
  if (!(await deps.move.usesLeft())) return { record, wait: "uses" }
  if (!prompt || signal?.aborted) return { record, wait: "approval" }
  const chunk = run.chunks[at]!
  // The claim is the send's ownership: a second send of the same chunk finds it taken and stops here.
  const claim = { id: deps.mintAttemptId(), session: deps.session }
  const claimed = await save(deps, record, (c) =>
    sameRuns(c, record) ? runsWith(c, at, { state: "claimed", claim }) : null,
  )
  /**
   * Writes `fields` on the chunk, and `runFields` on its run, while this send still holds the chunk,
   * over the rest as it reads now.
   */
  const patchHeld = (fields: Partial<MoveChunkRecord>, runFields?: Partial<MoveRun>) =>
    save(deps, claimed, (c) =>
      c.move?.runs.at(-1)?.chunks[at]?.claim?.id === claim.id
        ? runsWith(c, at, fields, runFields)
        : null,
    )
  const onTxHash: TxHashCallback = async (txHash, { expiresAtMs }) => {
    await patchHeld({ state: "submitted", claim: undefined, txHash: txHash as Hex, expiresAtMs })
  }
  let withdrawn = false
  try {
    await deps.move.send(chunk.token, BigInt(chunk.amount), onTxHash, signal)
  } catch (err) {
    // The screen the tap came from closed before the passkey answered: the chunk waits for the next tap.
    withdrawn = !!signal?.aborted && err === signal.reason
    const declined = !withdrawn && deps.move.declined(err)
    // A chunk that got its hash is past the claim; the write over it declines.
    await patchHeld(
      { state: "planned", claim: undefined },
      declined ? { declined: true } : undefined,
    ).catch(() => undefined)
    if (isSpendEnvelopeRefusal(err)) {
      return { record: await save(deps, record, (c) => attention(c, "move")) }
    }
    if (!declined && !withdrawn) throw err
  }
  const after = await deps.store.get(record.owner)
  if (after?.attemptId !== record.attemptId) throw new RotationFlowError("gone", "attempt is gone")
  return {
    record: after,
    wait: withdrawn ? "approval" : moveDeclined(after) ? "declined" : "chunk",
  }
}

/**
 * `moved` → `done`: the signature and the envelope leave the record, and the salt once no funding
 * can land unswept and the deposit address holds nothing, read now. An attempt with money there and
 * no sweep to take it parks over `done` as stranded.
 */
export async function finishRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  const sipa = record.rotation?.sipa
  const held = !!sipa && (await depositHeld(deps, sipa))
  return save(deps, record, (c) => {
    if (!sameRuns(c, record)) return null
    const unswept = c.unswept || held
    const done = stripSettled({
      ...c,
      phase: "done",
      ...CLEARED,
      ...(unswept ? { unswept: true } : {}),
    })
    return unswept || inFlight(c) ? { ...done, ...attention(done, "stranded") } : done
  })
}

/** Runs the move again once the user asks: from `attention: move`, or after a declined prompt. */
export async function retryMove(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { signal }: RunOptions = {},
): Promise<FlowResult> {
  if (moveDeclined(record)) {
    return moveRotation(
      deps,
      await save(deps, record, (c) => {
        if (!moveDeclined(c)) return null
        const runs = c.move!.runs
        return { move: { runs: [...runs.slice(0, -1), { ...runs.at(-1)!, declined: undefined }] } }
      }),
      { signal },
    )
  }
  const suspended = record.suspended
  if (record.attention !== "move" || !suspended)
    throw new RotationFlowError("phase", "not a paused move")
  return moveRotation(
    deps,
    await save(deps, record, (c) => (unmoved(c, record) ? { phase: suspended, ...CLEARED } : null)),
    { signal },
  )
}

// ---------------------------------------------------------------------------------------------
// Resume.

/** Whether anything shows a funding may have gone out for this record. */
export async function fundingEvidence(
  deps: Pick<RotationFlowDeps, "tracker" | "l1">,
  record: BackupRotationRecord,
): Promise<boolean> {
  if (record.fundings.some((f) => f.txHash || f.outcome === "mined" || f.outcome === "swept"))
    return true
  for (const funding of record.fundings) {
    const row = await deps.tracker.row(funding.localId)
    if (row?.l2TxHash) return true
  }
  return depositSeen(deps, record)
}

/**
 * The deposit address, read once at both block tags. Every decision about money there takes one of
 * two answers: `held` (money on the latest or the finalized block) guards whatever drops or strips
 * the salt; `settled` (money on the finalized block) is what the flow counts on past the sweep
 * window.
 */
interface Deposit {
  held: boolean
  settled: boolean
}

async function readDeposit(deps: Pick<RotationFlowDeps, "l1">, sipa: Address): Promise<Deposit> {
  const latest = await deps.l1.sipaBalance(sipa, "latest")
  const finalized = await deps.l1.sipaBalance(sipa)
  return { held: latest > 0n || finalized > 0n, settled: finalized > 0n }
}

async function depositHeld(deps: Pick<RotationFlowDeps, "l1">, sipa: Address): Promise<boolean> {
  return (await readDeposit(deps, sipa)).held
}

/**
 * Whether this wallet's funding already reached the deposit address, so none need go out. Nothing
 * else pays that address, and what lands is the plan's amount less the withdrawal's fees, so any
 * settled balance is the funding.
 */
async function depositFunded(
  deps: Pick<RotationFlowDeps, "l1">,
  record: BackupRotationRecord,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa) return false
  return (await readDeposit(deps, sipa)).settled
}

/** Whether money sits at the deposit address, or a sweep took some since the attempt began. */
async function depositSeen(
  deps: Pick<RotationFlowDeps, "l1">,
  record: BackupRotationRecord,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa) return false
  if (await depositHeld(deps, sipa)) return true
  return (await deps.l1.sweep(sipa, record.fromBlock ?? 0)) !== undefined
}

/**
 * The fundings as the tracker and the node show them now. A funding mined on L2 is swept once the
 * portal shows its withdrawal spent at the finalized block (its money reached the deposit address)
 * and nothing is held there; before that the sweep may have taken someone else's money and left
 * this one to land later.
 */
async function reconcileFundings(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<{ fundings: BackupFunding[]; corrupt: boolean; burn: boolean }> {
  const sipa = record.rotation?.sipa
  let corrupt = false
  let burn = false
  const released = new Set<string>()
  const judged = await Promise.all(
    record.fundings.map(async (funding): Promise<BackupFunding> => {
      if (!fundingLanding(funding)) return funding
      const row = await deps.tracker.row(funding.localId)
      const misfiled =
        row !== undefined &&
        ((sipa !== undefined && row.recipient.toLowerCase() !== sipa.toLowerCase()) ||
          (row.l2TxHash !== undefined &&
            funding.txHash !== undefined &&
            row.l2TxHash.toLowerCase() !== funding.txHash.toLowerCase()))
      if (misfiled) corrupt = true
      /** A funding mined on L2 whose withdrawal is spent at the finalized block had its money at the address. */
      const judge = async (f: BackupFunding) => {
        const releasing =
          f.outcome === "mined" && !misfiled && row?.phase === "done" && row.withdrawalId
        if (releasing && (await deps.l1.releaseFinal(row.withdrawalId!))) released.add(f.attemptId)
        return f
      }
      if (funding.outcome === "mined") return judge(funding)
      // A hash only the row holds comes with no expiry: a receipt alone ends that funding.
      const txHash = funding.txHash ?? (row?.l2TxHash as Hex | undefined)
      if (txHash) {
        const outcome = await txOutcome(deps.node, txHash, funding.expiresAtMs, deps.now())
        const next =
          outcome.kind === "mined" || outcome.kind === "reverted" || outcome.kind === "dead"
            ? outcome.kind
            : "pending"
        return judge({ ...funding, txHash, outcome: next })
      }
      // A send this life of the wallet started may still be between its entry and its row.
      const seededHere = funding.session === deps.session
      const burning = row?.phase === "submitting" && row.startTime >= deps.activeSince
      if (seededHere || burning) {
        burn = true
        return funding
      }
      return { ...funding, outcome: "never-sent" }
    }),
  )
  if (released.size === 0 || !sipa || (await readDeposit(deps, sipa)).settled) {
    return { fundings: judged, corrupt, burn }
  }
  const fundings = judged.map((f) =>
    released.has(f.attemptId) ? { ...f, outcome: "swept" as const } : f,
  )
  return { fundings, corrupt, burn }
}

/**
 * Runs the next step for a saved record, in a fixed order: the structural check, then what the
 * chain and the other stores already show, then the step the phase calls for. A read that cannot
 * complete leaves the record as it is. Without `prompt` a chunk's send stops at `approval`.
 */
export async function resumeRotation(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  { prompt = false, signal }: RunOptions = {},
): Promise<FlowResult> {
  let current = record
  for (let reads = 1; ; reads++) {
    const result = await resumeOnce(deps, current, { prompt, signal })
    if (result !== MOVED) return result
    const fresh = await deps.store.get(record.owner)
    if (fresh?.attemptId !== record.attemptId)
      throw new RotationFlowError("gone", "attempt is gone")
    if (reads >= RESUME_READS) return { record: fresh }
    current = fresh
  }
}

const RESUME_READS = 3
const MOVED = Symbol("moved")

/**
 * One resume over the record as read. What the chain and the stores show is decided over that
 * snapshot and written in one step that declines once the store no longer matches it: `MOVED`,
 * and the caller reads again.
 */
async function resumeOnce(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  options: RunOptions,
): Promise<FlowResult | typeof MOVED> {
  let current = record
  // A damaged record is not checked again: the check reads the same record and keys, so it would fail
  // again and return before the record can end at `recovered`.
  const rotation = current.attention === "corrupt" ? undefined : whole(current)
  if (rotation) {
    let verdict: PersistedRotationVerdict
    try {
      verdict = await deps.verify(rotation)
    } catch (err) {
      if (err instanceof VerificationUnavailableError)
        return { record: current, wait: "unverifiable" }
      throw err
    }
    if (verdict.verdict === "corrupt") {
      return { record: await save(deps, current, (c) => attention(c, "corrupt")) }
    }
  }
  if (current.rotation && current.fromBlock !== undefined && current.phase !== "created") {
    const snapshot = current
    const sipa = current.rotation.sipa
    const fromBlock = current.fromBlock
    const { fundings, corrupt, burn } = await reconcileFundings(deps, snapshot)
    let wait: FlowWait | undefined
    let decided: Patch
    if (corrupt) {
      decided = (c) => ({ fundings, ...attention(c, "corrupt") })
    } else {
      const phase = acting(snapshot)
      const awaitingFunds = phase === "published" || phase === "funded"
      const beforeSweep = awaitingFunds || phase === "signed"
      const landed = fundings.some((f) => f.txHash && fundingLanding(f))
      const funded = beforeSweep && !landed && !burn && (await depositFunded(deps, snapshot))
      const to =
        phase === "funded" && !landed && !burn && !funded
          ? "published"
          : phase === "published" && (landed || funded)
          ? "funded"
          : undefined
      const moved: Partial<BackupRotationRecord> = {
        fundings,
        ...(to ? (snapshot.phase === "attention" ? { suspended: to } : { phase: to }) : {}),
      }
      let then: Patch = () => ({})
      if (burn && acting({ ...snapshot, ...moved }) === "published") {
        wait = "burn"
      } else if (rotation && beforeSweep) {
        const sweep = await deps.l1.sweep(sipa, fromBlock)
        if (sweep && (await deps.l1.isFinal(sweep))) {
          then = sweptPatch(sweep)
        } else if (!sweep) {
          const verdict = await readFundability(deps, rotation)
          if (verdict === "applied") {
            then = await installedPatch(deps, rotation)
          } else if (verdict === "superseded" || verdict === "conflict") {
            // Money already sent to the deposit address of a change that cannot run is the user's to recover.
            const held = await depositHeld(deps, sipa)
            const stop = verdict === "conflict" ? CONFLICT : RESTART
            then = (c) => (acting(c) === "funded" || held ? attention(c, "stranded") : stop)
          }
        }
      }
      decided = (c) => ({ ...moved, ...(then({ ...c, ...moved }) ?? {}) })
    }
    const finished = snapshot.phase === "done" || snapshot.phase === "recovered"
    const held = finished && (await depositHeld(deps, sipa))
    try {
      current = await save(deps, snapshot, (c) => {
        if (!unmoved(c, snapshot)) return null
        const patch = decided(c)
        return finished
          ? stripSettled({ ...c, ...patch, ...(held ? { unswept: true } : {}) })
          : patch
      })
    } catch (err) {
      if (err instanceof RotationFlowError && err.code === "phase") return MOVED
      throw err
    }
    if (wait) return { record: current, wait }
    if (corrupt) return { record: current }
  }
  switch (current.phase) {
    case "signed":
      return publishRotation(deps, current)
    case "published":
      return { record: current, wait: "funding" }
    case "funded":
      return watchRotation(deps, current)
    case "swept":
    case "installed":
      return { record: await rerootRotation(deps, current) }
    case "rerooted":
    case "moved":
      return moveRotation(deps, current, options)
    case "attention":
      return resumeAttention(deps, current, options)
    case "done":
    case "recovered":
      return lateFunding(deps, current)
    default:
      return { record: current }
  }
}

/**
 * A parked record returns to the phase it left when the reason has passed: the route paying again,
 * a late sweep, money gone from the deposit address, nothing left to land there. Money gone by a
 * recovery ends the attempt at `recovered` instead, unless the signed change ran anyway: then the
 * backup is installed and the attempt goes on. A finished attempt stays parked while money may sit
 * there, with nothing run twice. A paused move waits for the user; a corrupt record waits until its
 * money is recovered.
 */
async function resumeAttention(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  options: RunOptions,
): Promise<FlowResult> {
  const suspended = record.suspended
  if (!suspended) return { record }
  const finished = suspended === "done" || suspended === "recovered"
  switch (record.attention) {
    case "route": {
      const rotation = whole(record)
      if (!rotation || (await deps.route(rotation)) !== "ok") return { record }
      return resumeRotation(
        deps,
        await save(deps, record, (c) =>
          unmoved(c, record) ? { phase: suspended, ...CLEARED } : null,
        ),
        options,
      )
    }
    case "stranded": {
      if (finished) return strandedStanding(deps, record, suspended)
      if (await nothingLanding(deps, record)) {
        const recovery = record.recovery ?? (await recoverySeen(deps, record))
        if (recovery) {
          const rotation = whole(record)
          const live = rotation ? await readFundability(deps, rotation) : undefined
          if (live !== "applied" && live !== "applied-pending") {
            return { record: await save(deps, record, endRecovered(record, recovery)) }
          }
        }
        return resumeRotation(
          deps,
          await save(deps, record, (c) =>
            unmoved(c, record) ? { phase: suspended, ...CLEARED, recovery: undefined } : null,
          ),
          options,
        )
      }
      const watched = await watchRotation(deps, record)
      const rotation = whole(watched.record)
      if (
        watched.record.phase !== "attention" ||
        watched.record.attention !== "stranded" ||
        !rotation ||
        (await readFundability(deps, rotation)) !== "applied"
      ) {
        return watched
      }
      const install = await installedPatch(deps, rotation)
      const installed = await save(deps, watched.record, (c) =>
        unmoved(c, watched.record) ? install(c) : null,
      )
      return { record: await rerootRotation(deps, installed) }
    }
    case "corrupt": {
      // A damaged record never moves on, and cancelling refuses it over a funding, so it would block
      // every new add: once its money is recovered, end it.
      if (finished) return { record }
      // Read the recovery before the balance: the panel re-checks a damaged record only while this
      // returns a `wait`, so a recovery still settling must return one.
      const recovery = record.recovery ?? (await recoverySeen(deps, record))
      if (!recovery) return { record }
      if (!(await nothingLanding(deps, record))) return { record, wait: "recovery" }
      return { record: await save(deps, record, endRecovered(record, recovery)) }
    }
    default:
      return { record }
  }
}

/**
 * The recovery's L1 transaction, read from the chain: none is noted when the tab closed before its
 * receipt.
 */
async function recoverySeen(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord["recovery"]> {
  const sipa = record.rotation?.sipa
  if (!sipa || record.fromBlock === undefined) return undefined
  const txHash = await deps.l1.recovery(sipa, record.fromBlock)
  return txHash && { txHash }
}

/**
 * Ends the attempt at `recovered`. Callers check that nothing can land first, so `stripSettled`
 * drops the salt along with the signature and the envelope.
 */
const endRecovered =
  (record: BackupRotationRecord, recovery: NonNullable<BackupRotationRecord["recovery"]>): Patch =>
  (c) =>
    unmoved(c, record)
      ? stripSettled({ ...c, phase: "recovered", ...CLEARED, unswept: undefined, recovery })
      : null

/** Whether nothing can reach the deposit address any more: no funding landing, no sweep, nothing held. */
async function nothingLanding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<boolean> {
  const sipa = record.rotation?.sipa
  if (!sipa || record.fromBlock === undefined || inFlight(record) || record.sweep) return false
  if (await deps.l1.sweep(sipa, record.fromBlock)) return false
  return !(await depositHeld(deps, sipa))
}

/**
 * A finished attempt parked over money at its deposit address returns to its phase once nothing can
 * land there and nothing is held; the salt leaves with it.
 */
async function strandedStanding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
  suspended: BackupRotationPhase,
): Promise<FlowResult> {
  const sipa = record.rotation?.sipa
  if (!sipa || inFlight(record) || (await depositHeld(deps, sipa))) return { record }
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record)
        ? stripSettled({ ...c, phase: suspended, ...CLEARED, unswept: undefined })
        : null,
    ),
  }
}

/**
 * A finished attempt with money that may sit at its deposit address is reported: a funding final
 * with no sweep to take it, money held after the change ran, or money at the address now.
 */
async function lateFunding(
  deps: RotationFlowDeps,
  record: BackupRotationRecord,
): Promise<FlowResult> {
  const sipa = record.rotation?.sipa
  if (!sipa) return { record }
  const held = inFlight(record) || record.unswept || (await depositHeld(deps, sipa))
  if (!held) return { record }
  // Drop the earlier recovery: kept, it would read as sent for this new money and end the new park on
  // the old transaction.
  return {
    record: await save(deps, record, (c) =>
      unmoved(c, record) ? { ...attention(c, "stranded"), recovery: undefined } : null,
    ),
  }
}

/**
 * Whether the user may send the deposit address's money back out: from a stranded record, or a
 * damaged one that cannot be cancelled. A damaged record that can be cancelled is started over.
 * The panel shows its recovery card on the same test, so it never offers what `noteRecovery`
 * would refuse.
 */
export const recoverable = (record: BackupRotationRecord): boolean =>
  record.phase === "attention" &&
  (record.attention === "stranded" || (record.attention === "corrupt" && !cancellable(record)))

/**
 * Keeps the L1 transaction that sent the deposit address's money back out on a parked attempt. The
 * attempt stays parked until the recovery is final: a resume ends it once nothing can land and the
 * address holds nothing.
 */
export async function noteRecovery(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  txHash: Hex,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => (recoverable(c) ? { recovery: { txHash } } : null))
}

/** Whether the user may still drop the attempt from this state. */
export function cancellable(record: BackupRotationRecord): boolean {
  if (inFlight(record)) return false
  switch (record.phase) {
    case "created":
    case "signed":
    case "conflict":
      return true
    case "published":
      return !record.fundings.some(fundingLanding)
    case "attention":
      return (
        (record.attention === "route" || record.attention === "corrupt") &&
        record.suspended !== undefined &&
        cancellable({ ...record, phase: record.suspended, ...CLEARED })
      )
    default:
      return false
  }
}

/**
 * Drops the attempt. The stored record decides: it is read, judged and removed as read. The salt
 * leaves with the record, so one is dropped only while nothing shows money at its deposit address; a
 * corrupt record also stays over any trace of a funding.
 */
export async function cancelRotation(
  deps: Pick<RotationFlowDeps, "store" | "tracker" | "l1">,
  record: BackupRotationRecord,
): Promise<void> {
  const current = await deps.store.get(record.owner)
  if (!current) return
  if (current.attemptId !== record.attemptId)
    throw new RotationFlowError("gone", "the attempt moved on")
  if (inFlight(current)) throw new RotationFlowError("funding-open", "a funding may still land")
  if (!cancellable(current))
    throw new RotationFlowError("not-cancellable", `${current.phase} cannot be cancelled`)
  const seen =
    current.attention === "corrupt" ? fundingEvidence(deps, current) : depositSeen(deps, current)
  if (await seen) {
    throw new RotationFlowError("not-cancellable", "money may have reached the deposit address")
  }
  const removed = await deps.store.removeIf(
    record.owner,
    (c) => c.attemptId === current.attemptId && unmoved(c, current) && cancellable(c),
  )
  if (removed) return
  if (!(await deps.store.get(record.owner))) return
  throw new RotationFlowError("phase", "the record moved on")
}

// ---------------------------------------------------------------------------------------------
// The republish accounting the broadcast executor keeps on the record. Each write is for the signed
// change the executor read; a record re-signed since declines it.

/** Whether the broadcast may be sent again now, else when. */
export function publishDue(
  publish: BackupPublish | undefined,
  now: number,
): { due: true } | { due: false; at: number } {
  const lastAt = publish?.lastAt
  if (lastAt === undefined || now >= lastAt + PUBLISH_INTERVAL_MS) return { due: true }
  return { due: false, at: lastAt + PUBLISH_INTERVAL_MS }
}

const sameChange = (c: BackupRotationRecord, record: BackupRotationRecord) =>
  c.rotation?.sipa !== undefined && c.rotation.sipa === record.rotation?.sipa

/** Counts a send before it goes out, so an interrupted publication counts. */
export async function recordPublishSend(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => {
    if (!sameChange(c, record)) return null
    const publish = c.publish ?? { count: 0, history: [] }
    return { publish: { ...publish, count: publish.count + 1, lastAt: deps.now() } }
  })
}

export async function recordPublishHash(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  txHash: Hex,
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) =>
    sameChange(c, record)
      ? { publish: { ...(c.publish ?? { count: 0, history: [] }), txHash } }
      : null,
  )
}

export async function recordPublishLanded(
  deps: Pick<RotationFlowDeps, "store" | "now">,
  record: BackupRotationRecord,
  landed: { txHash: Hex; l2Block: number },
): Promise<BackupRotationRecord> {
  return save(deps, record, (c) => {
    if (!sameChange(c, record)) return null
    const publish = c.publish ?? { count: 0, history: [] }
    return {
      publish: {
        ...publish,
        txHash: landed.txHash,
        l2Block: landed.l2Block,
        history: [...publish.history, { ...landed, at: deps.now() }],
      },
    }
  })
}

/** Whether a publication landed at or past `since`, the scheduler's floor for the job. */
export function publishLanded(record: BackupRotationRecord, since: number): boolean {
  return (record.publish?.history ?? []).some((h) => h.l2Block >= since)
}

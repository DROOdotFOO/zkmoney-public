/**
 * The one record of a user-started transaction, from its first proof to its fate on chain. Every
 * surface that says whether the tab may close (the flow's modal, the bell, the leave guard) reads
 * it, the notifications panel lists it running and ended, and one boot pass settles it after a
 * reload.
 */
import {
  provingProgress,
  type ProvingProgressEvent,
  type TxHashSavedEvent,
} from "@obsidion/proving-progress"
import { TxHash } from "@aztec-labs/stdlib/tx"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { IStorageAdapter } from "../../storages/adapter"
import { RecordStorage } from "../bridge/RecordStorage"
import { logger } from "../../../utils/logger"
import { isFailedSubmission } from "../transactions/trackSubmission"

/**
 * `local`: proving or submitting in this tab, which closing loses. `sent`: the hash is on the flow's
 * own record, so the chain decides from here and the tab may close. Only a page that is still
 * running an operation can advance it past `local`, so a `local` record from a page that no longer
 * runs the wallet was interrupted.
 */
export type OperationState = "local" | "sent" | "settled" | "failed"

/**
 * Why the store failed a record itself: `interrupted` ended before it was sent, `dropped` was sent
 * and the network turned it down. A failure the flow threw carries its `error` instead.
 */
export type OperationFailureCause = "interrupted" | "dropped"

export interface OperationRecord {
  operationId: string
  /** The caller's flow key; the store attaches no meaning to it. */
  flow: string
  /** One line naming the transaction, e.g. "$25 to @alice". */
  summary: string
  /** The storage namespace the flow's own records live in; null for a visitor. */
  scope: string | null
  /** The operation this one runs inside, e.g. a claim's deposit address. */
  parent?: string
  /**
   * Its owner retries it after a reload: a `local` one interrupted, or a `sent` one the chain
   * dropped, goes back to its owner instead of failing.
   */
  resumable?: boolean
  /**
   * Bookkeeping the user never asked for, such as a deposit address's broadcast: no notification
   * shows it, and leaving the page does not lose it.
   */
  background?: boolean
  state: OperationState
  startedAt: number
  /**
   * When the wallet began proving it. A record that never got here lost nothing when it stopped,
   * so it is dropped rather than failed.
   */
  provingStartedAt?: number
  /**
   * When its screen handed the user off to the notifications panel. From then on the record, not the
   * screen, reports a failure, so one that ends before proving is failed rather than dropped.
   */
  handedOffAt?: number
  txHash?: string
  /** The message a flow failed with. */
  error?: string
  cause?: OperationFailureCause
  endedAt?: number
  /** The notifications panel showed its ending. */
  readAt?: number
  /** Cleared from the notifications panel. */
  dismissedAt?: number
}

export const OPERATIONS_STORAGE_KEY = "@obsidion/operations"

/** Ended records older than this are dropped at boot; until then the notifications panel lists them. */
const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class OperationStore {
  private static instance: OperationStore | null = null
  private store: RecordStorage<OperationRecord>
  /** Operations a running flow in this page owns; the resolver leaves them to it. */
  private live = new Set<string>()
  private liveListeners = new Set<() => void>()
  private readonly onTxHashSaved = (ev: TxHashSavedEvent) =>
    void this.markSent(ev.operationId, ev.txHash).catch((err) =>
      logger.warn("[OperationStore] hash saved but the record write failed; still tab-bound:", err),
    )
  // Every proof opens with a `stage-start` under its operation's id, after the passkey signed.
  private readonly onStageStart = (ev: ProvingProgressEvent) => {
    if (ev.operationId) void this.markProving(ev.operationId, ev.startTime).catch(() => {})
  }

  private constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<OperationRecord>({
      storage,
      storageKey: OPERATIONS_STORAGE_KEY,
      keyOf: (r) => r.operationId,
      sortBy: (r) => r.startedAt,
      label: "OperationStore",
      // A write that did not land must not read as landed: "safe to leave" is a claim about
      // storage, so a failed write rejects and the in-memory record rolls back.
      strict: true,
    })
    // The flow's record holds the hash once this fires, so this is the one way into `sent`.
    provingProgress.on("tx-hash-saved", this.onTxHashSaved)
    provingProgress.on("stage-start", this.onStageStart)
  }

  static get(storage?: IStorageAdapter): OperationStore {
    if (!OperationStore.instance) {
      if (!storage) throw new Error("First call to OperationStore.get() requires a storage adapter")
      OperationStore.instance = new OperationStore(storage)
    }
    return OperationStore.instance
  }

  /** Test-only. */
  static reset(): void {
    const instance = OperationStore.instance
    if (instance) {
      provingProgress.off("tx-hash-saved", instance.onTxHashSaved)
      provingProgress.off("stage-start", instance.onStageStart)
    }
    OperationStore.instance = null
  }

  load(): Promise<void> {
    return this.store.load()
  }

  list(): OperationRecord[] {
    return this.store.list()
  }

  get(operationId: string): OperationRecord | null {
    return this.store.getByKey(operationId)
  }

  onListChanged(listener: (records: OperationRecord[]) => void): () => void {
    return this.store.onListChanged(listener)
  }

  isLive(operationId: string): boolean {
    return this.live.has(operationId)
  }

  /** Fires when an operation starts or stops being owned by a flow in this page. */
  onLiveChanged(listener: () => void): () => void {
    this.liveListeners.add(listener)
    return () => this.liveListeners.delete(listener)
  }

  private setLive(operationId: string, live: boolean): void {
    if (this.live.has(operationId) === live) return
    if (live) this.live.add(operationId)
    else this.live.delete(operationId)
    for (const listener of this.liveListeners) listener()
  }

  async begin(
    input: Pick<
      OperationRecord,
      "operationId" | "flow" | "summary" | "scope" | "parent" | "resumable" | "background"
    >,
    now: number = Date.now(),
  ): Promise<OperationRecord> {
    const record = await this.store.setRecord(input.operationId, {
      ...input,
      state: "local",
      startedAt: now,
    })
    this.setLive(input.operationId, true)
    return record
  }

  /**
   * A resumable record's owner runs it again in this page: it is `local` and owned until sent, as a
   * fresh attempt. Its start and summary stay.
   */
  async resume(operationId: string): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r?.resumable && r.endedAt === undefined
        ? {
            ...r,
            state: "local",
            provingStartedAt: undefined,
            handedOffAt: undefined,
            txHash: undefined,
          }
        : null,
    )
    if (this.store.getByKey(operationId)?.state === "local") this.setLive(operationId, true)
  }

  /** Renames a record whose summary needed data the flow read after it began. */
  async describe(operationId: string, summary: string): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r && r.summary !== summary ? { ...r, summary } : null,
    )
  }

  /** The flow stopped running in this page; a `sent` record passes to {@link resolveSent}. */
  release(operationId: string): void {
    this.setLive(operationId, false)
  }

  async markProving(operationId: string, now: number = Date.now()): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r?.state === "local" && r.provingStartedAt === undefined
        ? { ...r, provingStartedAt: now }
        : null,
    )
  }

  async markHandedOff(operationId: string, now: number = Date.now()): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r?.state === "local" && r.handedOffAt === undefined ? { ...r, handedOffAt: now } : null,
    )
  }

  /** Sent: the chain settles it. Without a hash the flow's own reads end it; `resolveSent` skips it. */
  async markSent(operationId: string, txHash?: string): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r?.state === "local" ? { ...r, state: "sent", txHash } : null,
    )
  }

  async settle(operationId: string, txHash?: string, now: number = Date.now()): Promise<void> {
    await this.end(operationId, { state: "settled", txHash }, now)
  }

  async fail(operationId: string, error: string, now: number = Date.now()): Promise<void> {
    await this.end(operationId, { state: "failed", error }, now)
  }

  /** The notifications panel showed these endings. */
  async markRead(operationIds: readonly string[], now: number = Date.now()): Promise<void> {
    for (const operationId of operationIds) {
      await this.store.updateRecord(operationId, (r) =>
        r?.endedAt !== undefined && r.readAt === undefined ? { ...r, readAt: now } : null,
      )
    }
  }

  /** Clear an ending from the notifications panel. */
  async dismiss(operationId: string, now: number = Date.now()): Promise<void> {
    await this.store.updateRecord(operationId, (r) =>
      r?.endedAt !== undefined && r.dismissedAt === undefined
        ? { ...r, readAt: r.readAt ?? now, dismissedAt: now }
        : null,
    )
  }

  /** Clear every ending of `scope` from the notifications panel; running operations stay. */
  async dismissEnded(scope: string | null, now: number = Date.now()): Promise<void> {
    await this.store.load()
    for (const record of this.list()) {
      if (record.scope !== scope || record.endedAt === undefined || record.dismissedAt) continue
      await this.dismiss(record.operationId, now)
    }
  }

  /** Nothing was sent and nothing is worth reporting, e.g. the passkey prompt was closed. */
  async remove(operationId: string): Promise<void> {
    this.setLive(operationId, false)
    await this.store.removeByKey(operationId)
  }

  private async end(
    operationId: string,
    patch: Pick<OperationRecord, "state"> & Partial<OperationRecord>,
    now: number,
  ): Promise<void> {
    this.setLive(operationId, false)
    await this.store.updateRecord(operationId, (r) =>
      r && r.state !== "settled" && r.state !== "failed"
        ? { ...r, ...patch, txHash: patch.txHash ?? r.txHash, endedAt: now }
        : null,
    )
  }

  /**
   * End every `local` record that started by `activeSince`, whatever its scope: one tab runs the
   * wallet and starts nothing before it becomes the active tab at `activeSince`, so the tab that
   * owned the record has stopped. One that began proving fails; one that did not lost nothing and
   * is dropped. A resumable one waits for its owner. Drops ended records past retention.
   */
  async failInterrupted(activeSince: number, now: number = Date.now()): Promise<void> {
    await this.store.load()
    for (const record of this.list()) {
      try {
        if (record.endedAt !== undefined && now - record.endedAt > ENDED_RETENTION_MS) {
          await this.store.removeByKey(record.operationId)
          continue
        }
        if (record.state !== "local" || record.startedAt > activeSince || record.resumable) continue
        if (record.provingStartedAt === undefined && record.handedOffAt === undefined) {
          await this.store.removeByKey(record.operationId)
          continue
        }
        await this.end(record.operationId, { state: "failed", cause: "interrupted" }, now)
      } catch (err) {
        logger.warn("[OperationStore] boot sweep could not write a record; next load retries:", err)
      }
    }
  }

  /** `sent` records no running flow owns and no owner resumes: the chain settles these. */
  unowned(): OperationRecord[] {
    return this.list().filter(
      (r) => r.state === "sent" && !r.resumable && !this.live.has(r.operationId),
    )
  }

  /**
   * Settle unowned `sent` records from their receipts: included → settled, dropped or reverted →
   * failed, anything else is left for the next pass. An unreachable node changes nothing.
   */
  async resolveSent(
    node: Pick<AztecNode, "getTxReceipt">,
    now: number = Date.now(),
  ): Promise<void> {
    await this.store.load()
    for (const record of this.unowned()) {
      if (!record.txHash) continue
      try {
        const receipt = await node.getTxReceipt(TxHash.fromString(record.txHash))
        if (isFailedSubmission(receipt)) {
          await this.end(record.operationId, { state: "failed", cause: "dropped" }, now)
        } else if (receipt.blockNumber !== undefined) {
          await this.settle(record.operationId, record.txHash, now)
        }
      } catch {
        // No receipt is not evidence either way; a failed write waits for the next pass.
      }
    }
  }
}

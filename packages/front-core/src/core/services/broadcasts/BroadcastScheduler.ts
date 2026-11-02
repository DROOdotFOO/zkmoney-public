/**
 * Runs the ledger's broadcasts, one at a time, in `nextBroadcast`'s order, until each has landed.
 * A shown job's attempts run as one resumable operation, which a reload re-queues instead of
 * failing. A failed attempt is retried after a backoff, without end. Each attempt first asks whether
 * the broadcast already landed, so a broadcast an earlier page sent is never proven twice.
 */
import type { OperationStore } from "../operations/OperationStore"
import { logger } from "../../../utils/logger"
import type { BroadcastJob, BroadcastLedger, BroadcastSource } from "./BroadcastLedger"
import { nextBroadcast, nextRetryAt } from "./broadcastOrder"

/** Thrown by an executor that cannot run the job yet: a locked wallet, a rail not open yet. */
export class BroadcastDeferred extends Error {
  constructor(readonly until: number, reason: string) {
    super(reason)
    this.name = "BroadcastDeferred"
  }
}

/**
 * Thrown by an executor whose job has nothing left to publish: the name was lost, or its owner
 * restarted it at another address. The job and its operation leave without a trace.
 */
export class BroadcastAbandoned extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "BroadcastAbandoned"
  }
}

export interface BroadcastExecutor {
  /** The broadcast already landed: an earlier page sent it, or another device did. */
  landed(job: BroadcastJob): Promise<boolean>
  /**
   * Build and send it. `onTxHash` must resolve before the node takes the tx: it saves the hash, so
   * a page that stops mid-send leaves the chain to decide. Resolves once the node accepted the tx.
   */
  send(
    job: BroadcastJob,
    attempt: { operationId?: string; onTxHash: (txHash: string) => Promise<void> },
  ): Promise<string>
  /** The broadcast landed, however the scheduler learned it: the owner's records follow. */
  onLanded?(job: BroadcastJob): Promise<void> | void
}

export type BroadcastTxState = "included" | "pending" | "dropped"

export interface BroadcastSchedulerDeps {
  ledger: BroadcastLedger
  operations: Pick<
    OperationStore,
    "begin" | "resume" | "markSent" | "settle" | "remove" | "release" | "get"
  >
  /** A source type with no executor yet waits. */
  executors: Partial<Record<BroadcastSource["type"], BroadcastExecutor>>
  /** Where a sent tx stands. An unreachable node reads as `pending`. */
  txState(txHash: string): Promise<BroadcastTxState>
  /** Runs one attempt behind the wallet's one-proof-at-a-time gate. */
  runExclusive<T>(job: BroadcastJob, attempt: () => Promise<T>): Promise<T>
  /** The account scope whose jobs run. */
  scope(): string | null
  /**
   * True while the user's own transaction, or another background proof, runs: local proving is
   * single-flight, so no attempt starts under it. The owner kicks the scheduler when it ends.
   */
  busy?(): boolean
  /** The operation a job's attempts run as; none for a job nobody has seen. */
  describe(job: BroadcastJob): { flow: string; summary: string; background?: boolean } | undefined
  now?(): number
}

/** How often a sent broadcast's receipt is read. */
export const SENT_POLL_MS = 5_000

export class BroadcastScheduler {
  private readonly now: () => number
  private running: Promise<number | undefined> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true

  constructor(private readonly deps: BroadcastSchedulerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A reload's first step: jobs an earlier page was building are owed again. */
  async recover(): Promise<void> {
    await this.deps.ledger.recoverInterrupted()
  }

  /** Runs jobs as they come due, and again whenever the ledger changes. */
  start(): () => void {
    this.stopped = false
    const off = this.deps.ledger.onListChanged(() => this.kick())
    this.kick()
    return () => {
      this.stopped = true
      off()
      clearTimeout(this.timer)
    }
  }

  /** Run now instead of at the next scheduled wake. */
  kick(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.loop(), 0)
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return
    let delay: number | undefined
    try {
      delay = await this.tick()
    } catch (err) {
      logger.warn("[BroadcastScheduler] tick failed; retrying:", err)
      delay = SENT_POLL_MS
    }
    if (this.stopped) return
    clearTimeout(this.timer)
    if (delay !== undefined) this.timer = setTimeout(() => void this.loop(), delay)
  }

  /**
   * One step: decide a sent broadcast, or run the next due job. Resolves with how long until the
   * next step is worth taking; undefined when nothing is owed or everything waits on the user.
   */
  tick(): Promise<number | undefined> {
    this.running ??= this.step().finally(() => (this.running = undefined))
    return this.running
  }

  private async step(): Promise<number | undefined> {
    const { ledger } = this.deps
    await ledger.load()
    const scope = this.deps.scope()
    const jobs = ledger.list().filter((job) => job.scope === scope && !ledger.isHeld(job.address))
    // Steps run one at a time, so a proving job with a hash is one whose sent write failed.
    const sent = jobs.find((job) => job.state === "sent" || (job.state === "proving" && job.txHash))
    if (sent) return this.decide(sent)
    const now = this.now()
    if (this.deps.busy?.()) return undefined
    const job = nextBroadcast(jobs, now, {
      runnable: (j) => this.deps.executors[j.source.type] !== undefined,
    })
    if (!job) {
      const at = nextRetryAt(jobs, now)
      return at === undefined ? undefined : at - now
    }
    await this.attempt(job)
    return 0
  }

  private async decide(job: BroadcastJob): Promise<number | undefined> {
    const state = await this.deps.txState(job.txHash!)
    if (state === "pending") return SENT_POLL_MS
    if (state === "included") {
      if (!(await this.landed(job))) return SENT_POLL_MS
    } else {
      await this.deps.ledger.markFailed(
        job.address,
        "The network dropped the broadcast",
        this.now(),
      )
    }
    return 0
  }

  private async attempt(job: BroadcastJob): Promise<void> {
    const { ledger, operations } = this.deps
    const executor = this.deps.executors[job.source.type]!
    if (await executor.landed(job).catch(() => false)) {
      if (!(await this.landed(job)))
        await ledger.defer(job.address, this.now() + SENT_POLL_MS, "Recording the broadcast")
      return
    }
    let operationId: string | undefined
    let txHash: string
    try {
      operationId = await this.own(job)
      await ledger.markProving(job.address)
      txHash = await this.deps.runExclusive(job, () =>
        executor.send(job, {
          operationId,
          onTxHash: (hash) => ledger.noteTxHash(job.address, hash),
        }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof BroadcastDeferred) {
        await ledger.defer(job.address, err.until, message)
      } else if (err instanceof BroadcastAbandoned) {
        // Nothing was lost and nothing is worth reporting: the owner moved on.
        await ledger.remove(job.address)
        if (operationId) await operations.remove(operationId)
      } else {
        // A hash means the node may hold the tx (a wait that timed out): the chain decides it.
        const noted = ledger.get(job.address)?.txHash
        if (noted) await ledger.markSent(job.address, noted)
        else await ledger.markFailed(job.address, message, this.now())
      }
      return
    } finally {
      if (operationId) operations.release(operationId)
    }
    await ledger.markSent(job.address, txHash)
    // The ledger holds the hash; the operation's copy only feeds the bell.
    if (operationId)
      await operations
        .markSent(operationId, txHash)
        .catch((err) =>
          logger.warn("[BroadcastScheduler] sent, but its operation did not record it:", err),
        )
  }

  /**
   * The owner's records follow first, so whatever waits on the ledger finds them current. False when
   * they could not: the job stays open and the owner is asked again.
   */
  private async landed(job: BroadcastJob): Promise<boolean> {
    try {
      // The job as it stands now: it may have been shown while the chain was being asked.
      await this.deps.executors[job.source.type]?.onLanded?.(
        this.deps.ledger.get(job.address) ?? job,
      )
    } catch (err) {
      logger.warn("[BroadcastScheduler] the owner could not record a landed broadcast:", err)
      return false
    }
    await this.deps.ledger.markLanded(job.address, this.now())
    if (job.operationId) await this.deps.operations.settle(job.operationId, job.txHash)
    return true
  }

  /** The job's operation, owned by this page for the attempt: resumed, or begun once. */
  private async own(job: BroadcastJob): Promise<string | undefined> {
    const shown = this.deps.describe(job)
    if (!shown) return undefined
    const { operations, ledger } = this.deps
    if (job.operationId && operations.get(job.operationId)) {
      await operations.resume(job.operationId)
      return job.operationId
    }
    const operationId = job.operationId ?? `broadcast_${job.address}_${this.now()}`
    // Linked first: an operation begun but never linked would hold the leave guard with no owner.
    await ledger.setOperation(job.address, operationId)
    await operations.begin({ operationId, ...shown, scope: job.scope, resumable: true }, this.now())
    return operationId
  }
}

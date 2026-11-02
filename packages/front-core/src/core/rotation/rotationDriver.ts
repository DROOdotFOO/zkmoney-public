/**
 * Drives the saved backup-passkey rotations of the session's account for as long as the session
 * lives, so a rotation advances whichever screen is open. No UI, no React.
 */
import type { BackupRotationRecord, BackupRotationStore } from "../storages/BackupRotationStore"
import {
  recordMoved,
  resumeRotation,
  retryMove,
  type FlowResult,
  type FlowWait,
  type RotationFlowDeps,
} from "./backupRotationFlow"

/** How long the driver waits before asking the chain again while a step is pending on it. */
export const RESUME_POLL_MS = 15_000

/** Waits only a user's tap ends (Fund, Approve, Try again), so none is polled. */
const USER_WAITS: ReadonlySet<FlowWait> = new Set(["funding", "approval", "declined"])

/** What a resume answered. */
export interface ResumeAnswer {
  wait?: FlowWait
  error?: unknown
}

/** One account's record as the driver holds it. */
export interface RotationDrive {
  record: BackupRotationRecord
  /** The last resume's answer for the record as it stands; none while one runs. */
  resume?: ResumeAnswer
  /** A step the user started is running. */
  approving: boolean
}

export interface RotationDriveSource {
  store: Pick<BackupRotationStore, "list" | "onChanged">
  /** The flow's dependencies for `owner`, in the record's casing; kept until `stop`, built again after a failed build. */
  deps(owner: string): Promise<RotationFlowDeps>
  /** Whether the record changes the session's account. */
  owns(record: BackupRotationRecord): boolean
  report?(what: string, error: unknown): void
  pollMs?: number
}

interface Lane {
  owner: string
  drive: RotationDrive
  /** False once the store no longer holds a record the driver acts on. */
  active: boolean
  /** `resumeKey` of the record the last run read; a record with another key is resumed again. */
  ran?: string
  /** A resume waits behind the current run. */
  queued: boolean
  tail: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  deps?: Promise<RotationFlowDeps>
}

/** What a resume reads off the record: a record whose key changed is resumed again. */
const resumeKey = (record: BackupRotationRecord) =>
  [
    record.attemptId,
    record.phase,
    record.attention,
    record.suspended,
    record.publish?.count,
    record.recovery?.txHash,
    ...record.fundings.map((funding) => `${funding.localId}:${funding.outcome}`),
  ].join("|")

/** A park the chain alone can lift. */
const parked = (record: BackupRotationRecord) =>
  record.attention === "route" || record.attention === "stranded"

/**
 * One run at a time per account: a resume whenever the record's key changes, and again after
 * `pollMs` while a step waits on the chain, a park the chain alone can lift, or a resume failed. A
 * resume never asks for a passkey; `approve` and `retry`, which do, run only from the user's tap.
 */
export class RotationDriver {
  private source?: RotationDriveSource
  private generation = 0
  private lanes = new Map<string, Lane>()
  private snapshot: ReadonlyMap<string, RotationDrive> = new Map()
  private listeners = new Set<() => void>()
  private unsubscribe?: () => void
  private readTimer?: ReturnType<typeof setTimeout>

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Every record driven, by lowercased owner. */
  getSnapshot = (): ReadonlyMap<string, RotationDrive> => this.snapshot

  drive(owner: string): RotationDrive | undefined {
    return this.snapshot.get(owner.toLowerCase())
  }

  start(source: RotationDriveSource): void {
    this.stop()
    this.source = source
    const generation = this.generation
    this.unsubscribe = source.store.onChanged((records) => this.sync(records))
    // A read that fails is tried again on the poll: with no record read, nothing else would.
    const read = () =>
      source.store.list().then(
        (records) => {
          if (generation === this.generation) this.sync(records)
        },
        (err: unknown) => {
          if (generation !== this.generation) return
          source.report?.("rotation read failed", err)
          this.readTimer = setTimeout(read, source.pollMs ?? RESUME_POLL_MS)
        },
      )
    void read()
  }

  /** Ends the session's driving; a run in flight finishes unobserved. */
  stop(): void {
    this.generation++
    this.unsubscribe?.()
    this.unsubscribe = undefined
    clearTimeout(this.readTimer)
    for (const lane of this.lanes.values()) clearTimeout(lane.timer)
    this.lanes.clear()
    this.source = undefined
    this.publish()
  }

  /** Resumes the record now, for the user's recheck. */
  check(owner: string): void {
    const lane = this.lanes.get(owner.toLowerCase())
    if (lane) this.kick(lane)
  }

  /**
   * Runs the record's next step, which may prompt for the passkey a chunk's send needs. `signal`
   * aborts when the tapping screen closes, so no prompt arrives after it.
   */
  approve(owner: string, signal?: AbortSignal): Promise<FlowResult> {
    return this.userStep(owner, (deps, record) =>
      resumeRotation(deps, record, { prompt: true, signal }),
    )
  }

  /** Runs the move again after a declined prompt or a pause; its send may prompt, as `approve`'s. */
  retry(owner: string, signal?: AbortSignal): Promise<FlowResult> {
    return this.userStep(owner, (deps, record) => retryMove(deps, record, { signal }))
  }

  private sync(records: readonly BackupRotationRecord[]): void {
    const source = this.source
    if (!source) return
    const seen = new Set<string>()
    for (const record of records) {
      if (record.phase === "created" || !source.owns(record)) continue
      const owner = record.owner.toLowerCase()
      seen.add(owner)
      let lane = this.lanes.get(owner)
      if (!lane) {
        lane = {
          owner,
          drive: { record, approving: false },
          active: true,
          queued: false,
          tail: Promise.resolve(),
        }
        this.lanes.set(owner, lane)
      }
      lane.active = true
      if (resumeKey(record) === lane.ran) {
        if (lane.drive.record !== record) lane.drive = { ...lane.drive, record }
      } else {
        // The last answer was for the record's previous key.
        lane.drive = { ...lane.drive, record, resume: undefined }
        this.kick(lane)
      }
    }
    for (const lane of this.lanes.values()) {
      if (seen.has(lane.owner)) continue
      lane.active = false
      lane.ran = undefined
      clearTimeout(lane.timer)
    }
    this.publish()
  }

  private kick(lane: Lane): void {
    clearTimeout(lane.timer)
    lane.timer = undefined
    if (!lane.active || lane.queued) return
    lane.queued = true
    const generation = this.generation
    void this.enqueue(lane, () => this.resume(lane, generation))
  }

  private enqueue<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
    const next = lane.tail.then(task)
    lane.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async resume(lane: Lane, generation: number): Promise<void> {
    lane.queued = false
    if (generation !== this.generation || !lane.active) return
    const record = lane.drive.record
    lane.ran = resumeKey(record)
    this.update(lane, generation, { resume: undefined })
    try {
      const deps = await this.depsFor(lane)
      if (generation !== this.generation || !lane.active) return
      const result = await resumeRotation(deps, record)
      this.answer(lane, generation, { wait: result.wait })
    } catch (err) {
      if (recordMoved(err)) return this.answer(lane, generation, undefined)
      this.source?.report?.("resume failed", err)
      this.answer(lane, generation, { error: err })
    }
  }

  private userStep(
    owner: string,
    step: (deps: RotationFlowDeps, record: BackupRotationRecord) => Promise<FlowResult>,
  ): Promise<FlowResult> {
    const lane = this.lanes.get(owner.toLowerCase())
    if (!lane?.active) return Promise.reject(new Error("backup rotation: nothing to drive"))
    clearTimeout(lane.timer)
    const generation = this.generation
    return this.enqueue(lane, async () => {
      this.assertLive(lane, generation)
      this.update(lane, generation, { approving: true })
      try {
        const deps = await this.depsFor(lane)
        this.assertLive(lane, generation)
        const result = await step(deps, lane.drive.record)
        this.answer(lane, generation, { wait: result.wait })
        return result
      } catch (err) {
        // Resume what the failed step left, without a prompt.
        if (generation === this.generation) this.kick(lane)
        throw err
      } finally {
        this.update(lane, generation, { approving: false })
      }
    })
  }

  /** Throws once the session ended or the store no longer holds the record. */
  private assertLive(lane: Lane, generation: number): void {
    if (generation !== this.generation) throw new Error("backup rotation: the session ended")
    if (!lane.active) throw new Error("backup rotation: nothing to drive")
  }

  private depsFor(lane: Lane): Promise<RotationFlowDeps> {
    const source = this.source
    if (!source) return Promise.reject(new Error("backup rotation: the session ended"))
    lane.deps ??= source.deps(lane.drive.record.owner).catch((err: unknown) => {
      lane.deps = undefined
      throw err
    })
    return lane.deps
  }

  /** Shows a run's answer unless a newer run is queued, and polls again when the wait is the chain's. */
  private answer(lane: Lane, generation: number, resume: ResumeAnswer | undefined): void {
    if (generation !== this.generation || lane.queued || !lane.active) return
    if (resume) this.update(lane, generation, { resume })
    const due =
      !resume ||
      resume.error !== undefined ||
      (resume.wait !== undefined && !USER_WAITS.has(resume.wait)) ||
      parked(lane.drive.record)
    if (!due) return
    clearTimeout(lane.timer)
    lane.timer = setTimeout(() => this.kick(lane), this.source?.pollMs ?? RESUME_POLL_MS)
  }

  private update(lane: Lane, generation: number, fields: Partial<RotationDrive>): void {
    if (generation !== this.generation) return
    lane.drive = { ...lane.drive, ...fields }
    this.publish()
  }

  private publish(): void {
    const next = new Map<string, RotationDrive>()
    for (const lane of this.lanes.values()) if (lane.active) next.set(lane.owner, lane.drive)
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

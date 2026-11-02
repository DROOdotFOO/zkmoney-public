import { EventEmitter } from "eventemitter3"

import type { TxKind } from "./race.js"

export type { OriginalFlowKind, TxKind } from "./race.js"

// ─── Stages (existing) ────────────────────────────────────────────────────────

export const ProvingStage = {
  Simulating: "simulating",
  Witgen: "witgen",
  Proving: "proving",
  Mining: "mining",
} as const

export type ProvingStage = (typeof ProvingStage)[keyof typeof ProvingStage]

export interface ProvingProgressEvent {
  stage: ProvingStage
  startTime: number
  /** Correlates stage events with the in-flight operation. */
  operationId?: string
  /**
   * Real on-chain `txHash`, populated only on `Mining` (the wallet computes
   * it from the proven tx before `aztecNode.sendTx` runs). `trackSubmission`
   * stamps it onto the flow's row at once, so the row holds its real hash
   * while the receipt is still pending.
   */
  txHash?: string
}

/** Payload for `tx-hash-saved`: the operation's stored record now holds its tx hash. */
export interface TxHashSavedEvent {
  operationId: string
  txHash: string
}

// ─── Operation context ──────────────────────────────────────────────────────

/**
 * The wallet-process-wide single-flight registry for in-flight local proves.
 * The id correlates stage events with the operation that produced them.
 */
export interface ProvingOperationContext {
  operationId: string
  kind: TxKind
}

/** Payload for the `operation-context-change` event. `context: undefined` signals the registry was cleared. */
export interface OperationContextChangeEvent {
  context: ProvingOperationContext | undefined
}

/**
 * Per-op stage snapshot. The detail-sheet stage feed reads this on mount so
 * it can render the live timeline even after dismiss/re-mount during prove,
 * because `EventEmitter.on('stage-start' | 'stage-complete')` only delivers
 * NEW events — listeners that mounted late would otherwise miss the history.
 */
export interface StageSnapshot {
  /** Last `stage-start` event seen for this op id, if any. */
  stage: ProvingStage | null
  /** Stages that have fired `stage-complete` for this op id. */
  completed: Record<ProvingStage, boolean>
}

const emptyCompletedStages = (): Record<ProvingStage, boolean> => ({
  [ProvingStage.Simulating]: false,
  [ProvingStage.Witgen]: false,
  [ProvingStage.Proving]: false,
  [ProvingStage.Mining]: false,
})

class ProvingProgressEmitter extends EventEmitter {
  // ─── Per-op stage snapshot map ──────────────────────────────────────────────
  //
  // Tracks the last-known stage + completed-stages set for each op id so the
  // detail sheet's stage-feed hook can rebuild identical UI on re-mount.
  // Lifecycle:
  //   - `emitStageStart(stage, opId)`     → updates snapshot[opId].stage
  //   - `emitStageComplete(stage, opId)`  → updates snapshot[opId].completed
  //   - `registerOperationContext({...})` → resets snapshot for that op id
  //   - `emitReset()`                     → clears all snapshots
  //   - `clearOperationContext()`         → does NOT clear the snapshot. The
  //     normal-path `withProvingScope.finally` clears the registry context
  //     before the wallet's submit/mining work completes; clearing snapshots
  //     here would lose the user-visible stage history while the wallet is
  //     still progressing.
  //
  // `emitReset` and a re-registration of the same op id are the only ways a
  // snapshot is dropped. Memory is bounded by the wallet's single-flight
  // invariant.
  private stageSnapshots: Map<string, StageSnapshot> = new Map()

  private getOrCreateSnapshot(operationId: string): StageSnapshot {
    let snap = this.stageSnapshots.get(operationId)
    if (snap === undefined) {
      snap = { stage: null, completed: emptyCompletedStages() }
      this.stageSnapshots.set(operationId, snap)
    }
    return snap
  }

  /**
   * Read a per-op-id stage snapshot for hook re-mount continuity. Returns
   * `null` if no snapshot exists for this op id (no stage events have fired
   * yet). Callers should fall back to reading the synth row's persisted
   * `detailedStatus` in that case.
   */
  getCurrentStageSnapshot(operationId: string): StageSnapshot | null {
    const snap = this.stageSnapshots.get(operationId)
    if (snap === undefined) return null
    return { stage: snap.stage, completed: { ...snap.completed } }
  }

  // ─── Stage events ──────────────────────────────────────────────────────────

  emitStageStart(stage: ProvingStage, operationId?: string, txHash?: string) {
    const ev: ProvingProgressEvent = { stage, startTime: Date.now() }
    if (operationId !== undefined) {
      ev.operationId = operationId
      const snap = this.getOrCreateSnapshot(operationId)
      snap.stage = stage
    }
    if (txHash !== undefined) ev.txHash = txHash
    this.emit("stage-start", ev)
  }

  /**
   * The flow wrote the submitted tx hash onto its stored record, so a reload can still settle the
   * transaction. Emitted by front-core's `trackSubmission` only; UIs use it to stop guarding.
   */
  emitTxHashSaved(operationId: string, txHash: string) {
    const ev: TxHashSavedEvent = { operationId, txHash }
    this.emit("tx-hash-saved", ev)
  }

  emitStageComplete(stage: ProvingStage, operationId?: string) {
    const payload: { stage: ProvingStage; operationId?: string } = { stage }
    if (operationId !== undefined) {
      payload.operationId = operationId
      const snap = this.getOrCreateSnapshot(operationId)
      snap.completed[stage] = true
    }
    this.emit("stage-complete", payload)
  }

  emitReset() {
    this.stageSnapshots.clear()
    this.emit("reset")
  }

  /**
   * Bracket a manual signing ceremony — emitted around the passkey /
   * WebAuthn assertion (a system modal whose duration depends on the user, not
   * the prover). UIs that show a time-based proving affordance (e.g. a fixed
   * "Cancel (Ns)" countdown) should PAUSE it between `signing-start` and
   * `signing-end` so the manual signature isn't counted against the estimate.
   * Best-effort and stage-agnostic; `signing-end` fires even if the assertion throws or is
   * cancelled, with `failed` set so a UI that leaves on it can stay for the error instead.
   */
  emitSigningStart(operationId?: string) {
    this.emit("signing-start", { operationId })
  }

  emitSigningEnd(operationId?: string, failed?: boolean) {
    this.emit("signing-end", { operationId, failed })
  }

  // ─── Operation-context registry ────────────────────────────────────────────
  //
  // Single-flight enforcement for local proves.

  private operationContext: ProvingOperationContext | undefined

  /**
   * Register a context atomically. Throws `LocalProvingInFlight` if a context
   * is already present. The wallet's `withProvingScope` is the only legitimate
   * caller; everyone else reads via `getCurrentOperationContext`.
   *
   * Emits `operation-context-change` AFTER the registration succeeds, marking
   * the start of a local prove.
   */
  registerOperationContext(ctx: ProvingOperationContext): void {
    if (this.operationContext !== undefined) {
      const err = new Error("LocalProvingInFlight")
      err.name = "LocalProvingInFlight"
      throw err
    }
    this.operationContext = ctx
    // Reset the snapshot for this op id so a re-confirm with the same op id
    // starts fresh. Normal usage mints a new id every send, but a caller
    // could in theory reuse one across retries.
    this.stageSnapshots.delete(ctx.operationId)
    this.emit("operation-context-change", { context: ctx })
  }

  /**
   * Read accessor. Returns the live context object — callers must NOT
   * mutate it directly.
   */
  getCurrentOperationContext(): ProvingOperationContext | undefined {
    return this.operationContext
  }

  /** Convenience reader for callers that only need the operationId. */
  getCurrentOperationId(): string | undefined {
    return this.operationContext?.operationId
  }

  /**
   * Clear the registered context. Invariant: only the registering caller
   * (wallet's `withProvingScope` finally) calls this in its cleanup path.
   *
   * Emits `operation-context-change` with `context: undefined` once the prove
   * has fully unwound, so a caller can wait for it to drain before releasing.
   */
  clearOperationContext(): void {
    if (this.operationContext === undefined) return
    this.operationContext = undefined
    this.emit("operation-context-change", { context: undefined })
  }
}

// ─── Hot-reload-safe singleton ───────────────────────────────────────────────
//
// Hot-reload re-evaluates this module, which would orphan any context
// registered by the prior module instance. Pin the singleton to globalThis so
// it survives re-evaluation; where `module.hot` exists the dispose hook clears
// any stale context before the next module instance boots. Production builds
// skip the dispose hook entirely.

const GLOBAL_KEY = "__obsidionProvingProgress" as const

interface GlobalWithProvingProgress {
  [GLOBAL_KEY]?: ProvingProgressEmitter
}

const globalWithProvingProgress = globalThis as unknown as GlobalWithProvingProgress

export const provingProgress: ProvingProgressEmitter =
  globalWithProvingProgress[GLOBAL_KEY] ??
  (globalWithProvingProgress[GLOBAL_KEY] = new ProvingProgressEmitter())

// Best-effort hot-reload safety. `module.hot` is only present under bundlers
// that expose the `module.hot` HMR API (webpack dev); production builds skip this.
const maybeModule = (globalThis as unknown as { module?: { hot?: { dispose?: (cb: () => void) => void } } }).module
if (maybeModule?.hot?.dispose) {
  maybeModule.hot.dispose(() => {
    provingProgress.clearOperationContext()
  })
}

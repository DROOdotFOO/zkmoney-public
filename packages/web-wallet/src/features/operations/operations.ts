/**
 * The web side of front-core's `OperationStore`: every user-started transaction runs through
 * {@link runOperation}, and everything that says whether the tab may close reads the store.
 */
import { useCallback, useSyncExternalStore } from "react"
import {
  OperationStore,
  TxInFlightError,
  type OperationRecord,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getActiveStorageId, onActiveStorageIdChange } from "../../platform/storage/activeStorage"
import { createExternalState } from "../../lib/externalState"
import { runUserFlow, trackBackgroundProve } from "../provingGate"
import { flowCopy } from "./operationCopy"

/** Named as the analytics `flow` prop, so events about an operation forward as they are. */
export type OperationFlow =
  | "send"
  | "withdraw"
  | "paylink-create"
  | "paylink-claim"
  | "paylink-claim-l1"
  | "paylink-reclaim"
  | "deposit"
  | "request-link"
  | "migration"
  | "migration-arrival"
  | "savings"

/** The user stopped the flow before anything was sent: a closed passkey prompt, or a cancel. */
export function isFlowCancelled(err: unknown): boolean {
  return isPasskeyCancelled(err) || (err instanceof Error && err.message === "Cancelled")
}

export function getOperationStore(): OperationStore {
  return OperationStore.get(webStorage)
}

export interface OperationInput {
  operationId: string
  flow: OperationFlow
  summary: string
  /** The operation this one runs inside. */
  parent?: string
}

export interface OperationHandle {
  operationId: string
  /** Renames the operation once the flow has read what the summary names, e.g. a link's amount. */
  describe(summary: string): void
  /**
   * The flow returns with its transaction sent but not yet included: the chain settles the record
   * instead of the flow. Only `runBurn` returns this way; other flows throw `TxInFlightError`.
   */
  leaveToChain(txHash: string | undefined): void
}

/**
 * Run `run` as one user operation, behind the single-flight gate: it is `local` until the flow's
 * record holds the hash, and settles when `run` resolves. A failure before proving began, or a
 * cancel, sent nothing, so the record goes. A `TxInFlightError` leaves it `sent` for the chain; any
 * other failure is definite, and fails it even once sent. The record begins ahead of the gate, so
 * the bell lists the operation while a background proof finishes first.
 */
export function runOperation<T>(
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
  txHashOf?: (result: T) => string | undefined,
): Promise<T> {
  const store = getOperationStore()
  const begun = store.begin({ ...input, scope: getActiveStorageId() })
  // Awaited inside the gate; this only keeps a failed write from reading as unhandled meanwhile.
  begun.catch(() => {})
  return runUserFlow(async () => {
    await begun
    return operate(store, input.operationId, run, txHashOf)
  })
}

/**
 * Run `run` as one user operation that is NOT behind the gate: the bell lists it and it keeps the
 * tab, as {@link runOperation} does, but it raises no user flow. Use it for a long flow that sends
 * each transaction as its own gated step, such as an upgrade's send pass that waits for chain
 * events: a user flow held for that time would stop every background proof. `run` may call
 * {@link runUserFlow} for its own prompts, and may send through {@link runBackgroundOperation}
 * outside of that call. It ends as a user operation would.
 */
export async function runListedOperation<T>(
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
): Promise<T> {
  const store = getOperationStore()
  await store.begin({ ...input, scope: getActiveStorageId() })
  return operate(store, input.operationId, run)
}

/**
 * Run `run` as one automatic operation no user started, such as an upgrade's transaction step: it
 * waits its turn on the background proving reservation, and its record is background, so nothing
 * lists it and leaving the page loses nothing. It ends as a user operation would.
 */
export function runBackgroundOperation<T>(
  input: OperationInput,
  run: (op: OperationHandle) => Promise<T>,
): Promise<T> {
  const store = getOperationStore()
  return trackBackgroundProve(async () => {
    await store.begin({ ...input, scope: getActiveStorageId(), background: true })
    return operate(store, input.operationId, run)
  })
}

/** Runs a begun operation's flow and ends its record by how the flow ended. */
async function operate<T>(
  store: OperationStore,
  operationId: string,
  run: (op: OperationHandle) => Promise<T>,
  txHashOf?: (result: T) => string | undefined,
): Promise<T> {
  // On chain but unsettled. A hash the flow's record failed to save still takes it to `sent`.
  const toChain = async (txHash: string | undefined) => {
    if (txHash && store.get(operationId)?.state === "local")
      await store.markSent(operationId, txHash).catch(console.warn)
  }
  let inFlight: { txHash: string | undefined } | undefined
  try {
    const result = await run({
      operationId,
      describe: (summary) => void store.describe(operationId, summary).catch(console.warn),
      leaveToChain: (txHash) => void (inFlight = { txHash }),
    })
    if (inFlight) await toChain(inFlight.txHash)
    else await store.settle(operationId, txHashOf?.(result)).catch(console.warn)
    return result
  } catch (err) {
    const record = store.get(operationId)
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof TxInFlightError) {
      await toChain(err.txHash)
    } else if (record?.state === "sent") {
      // The flow saw the chain turn it down: its message is the specific one.
      await store.fail(operationId, message).catch(console.warn)
    } else if (record?.state === "local") {
      // Nothing was lost before the proof began (a closed passkey prompt, a failed read): the
      // flow's screen reports it, and the record goes. Once the screen has handed off, the
      // record is the only report left.
      if (
        isFlowCancelled(err) ||
        (record.provingStartedAt === undefined && record.handedOffAt === undefined)
      ) {
        await store.remove(operationId).catch(console.warn)
      } else {
        await store.fail(operationId, message).catch(console.warn)
      }
    }
    throw err
  } finally {
    store.release(operationId)
  }
}

/** This scope's operations that have not ended, newest first. */
const inProgress = createExternalState<OperationRecord[]>([])
/** This scope's ended operations, dismissed ones included, newest first. */
const endedRecords = createExternalState<OperationRecord[]>([])
/** The store has been read, so an empty list means none. */
const loadedState = createExternalState(false)
/** The operations flows in this page run, in any scope. */
const tabBound = createExternalState<OperationRecord | undefined>(undefined)
let watching = false
/** Which records a flow in this page owns, as of the last snapshot. */
let liveKey = ""

/** Keeps every snapshot current with the store, the live set and the active scope. */
function watchOperations(): void {
  if (watching) return
  watching = true
  const store = getOperationStore()
  const refresh = () => {
    const scope = getActiveStorageId()
    // Background operations are the wallet's own bookkeeping: no notification lists them.
    const scoped = store.list().filter((r) => r.scope === scope && !r.background)
    const next = scoped.filter((r) => r.state === "local" || r.state === "sent")
    const ended = scoped.filter((r) => r.endedAt !== undefined)
    if (JSON.stringify(ended) !== JSON.stringify(endedRecords.get())) endedRecords.set(ended)
    const current = inProgress.get()
    const live = next.map((r) => store.isLive(r.operationId)).join()
    const same =
      live === liveKey &&
      next.length === current.length &&
      next.every((r, i) => r === current[i] || JSON.stringify(r) === JSON.stringify(current[i]))
    liveKey = live
    if (!same) inProgress.set(next)
    const bound = tabBoundOperation(store.list())
    if (bound?.operationId !== tabBound.get()?.operationId) tabBound.set(bound)
  }
  store.onListChanged(refresh)
  store.onLiveChanged(refresh)
  onActiveStorageIdChange(refresh)
  void store.load().then(() => {
    refresh()
    loadedState.set(true)
  })
  refresh()
}

export function getOperationsInProgress(): OperationRecord[] {
  watchOperations()
  return inProgress.get()
}

export function useOperationsInProgress(): OperationRecord[] {
  watchOperations()
  return useSyncExternalStore(inProgress.subscribe, inProgress.get)
}

const watched = <T>(state: { get(): T; subscribe(listener: () => void): () => void }) => ({
  get(): T {
    watchOperations()
    return state.get()
  },
  subscribe: state.subscribe,
})

/** This scope's unfinished operations, newest first. */
export const runningOperations: ReadonlyStore<OperationRecord[]> = watched(inProgress)

/**
 * This scope's ended operations, dismissed ones included: an entry one covers stays hidden after the
 * user clears it.
 */
export const endedOperations: ReadonlyStore<OperationRecord[]> = watched(endedRecords)

/** The store has been read, so an empty list means none. */
export const operationsLoaded: ReadonlyStore<boolean> = watched(loadedState)

/**
 * A `local` operation this page is running: closing, reloading or logging out would lose it. A
 * `local` record no flow owns belongs to a page that no longer runs the wallet, and fails at boot.
 * A background operation resumes after a reload, so leaving loses nothing.
 */
export function tabBoundOperation(records: OperationRecord[]): OperationRecord | undefined {
  const store = getOperationStore()
  return records.find((r) => r.state === "local" && !r.background && store.isLive(r.operationId))
}

/** Whatever its scope: the page that runs it is this one. */
export function getTabBoundOperation(): OperationRecord | undefined {
  watchOperations()
  return tabBound.get()
}

export function leavingLosesTransaction(): boolean {
  return !!getTabBoundOperation()
}

export function useTabBoundOperation(): OperationRecord | undefined {
  watchOperations()
  return useSyncExternalStore(tabBound.subscribe, tabBound.get)
}

export function useLeavingLosesTransaction(): boolean {
  return !!useTabBoundOperation()
}

/** Whether the tab may close for one operation: `keep` while this page proves it, `safe` once sent. */
export type TabLine = "keep" | "safe"

export function tabLineOf(record: OperationRecord | null, live: boolean): TabLine | undefined {
  if (record?.state === "sent") return "safe"
  return record?.state === "local" && live ? "keep" : undefined
}

/** In any scope: a visitor's operation has none. */
export function useTabLine(operationId: string | undefined): TabLine | undefined {
  watchOperations()
  const store = getOperationStore()
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offList = store.onListChanged(onChange)
      const offLive = store.onLiveChanged(onChange)
      return () => {
        offList()
        offLive()
      }
    },
    [store],
  )
  return useSyncExternalStore(subscribe, () =>
    operationId ? tabLineOf(store.get(operationId), store.isLive(operationId)) : undefined,
  )
}

/**
 * The outermost operation a flow in this page runs: a live record with no parent, or whose parent
 * no longer runs. A child such as a claim's deposit address shows under it.
 */
export function currentOperation(records: OperationRecord[]): OperationRecord | undefined {
  const store = getOperationStore()
  return records.find(
    (r) => !r.background && store.isLive(r.operationId) && (!r.parent || !store.isLive(r.parent)),
  )
}

export function useCurrentOperation(): OperationRecord | undefined {
  return currentOperation(useOperationsInProgress())
}

/** A transaction button's label while another transaction proves, named after it. */
export function useBusyLabel(): string {
  const current = useCurrentOperation()
  return current ? flowCopy(current.flow).busy : "Another transaction in progress…"
}

/**
 * An in-memory stand-in for `features/operations/operations`, for suites that mock front-core
 * whole and so cannot load the real store. Same surface and the same outcomes as the real module;
 * `operationsParity.test.tsx` runs both through the same scenarios.
 */
import { useSyncExternalStore } from "react"
import { provingProgress } from "@obsidion/proving-progress"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { createExternalState } from "../../src/lib/externalState"
import { flowCopy } from "../../src/features/operations/operationCopy"

/**
 * `isFlowCancelled` from the real module, which these suites cannot load (it reads front-core at
 * import); the parity test holds the two to the same answers.
 */
export function isFlowCancelled(err: unknown): boolean {
  return isPasskeyCancelled(err) || (err instanceof Error && err.message === "Cancelled")
}

interface FakeRecord {
  operationId: string
  flow: string
  summary: string
  scope: string | null
  parent?: string
  state: "local" | "sent" | "settled" | "failed"
  startedAt: number
  provingStartedAt?: number
  handedOffAt?: number
  txHash?: string
  error?: string
  endedAt?: number
  readAt?: number
  dismissedAt?: number
}

export function fakeOperationsModule() {
  const records = createExternalState<FakeRecord[]>([])
  const live = new Set<string>()
  const liveListeners = new Set<() => void>()
  const setLive = (operationId: string, on: boolean) => {
    if (live.has(operationId) === on) return
    if (on) live.add(operationId)
    else live.delete(operationId)
    for (const listener of liveListeners) listener()
  }
  const get = (operationId: string) =>
    records.get().find((r) => r.operationId === operationId) ?? null
  const patch = (operationId: string, change: Partial<FakeRecord>) =>
    records.set(records.get().map((r) => (r.operationId === operationId ? { ...r, ...change } : r)))
  const end = (operationId: string, change: Partial<FakeRecord>) => {
    setLive(operationId, false)
    const record = get(operationId)
    if (!record || record.state === "settled" || record.state === "failed") return
    patch(operationId, { ...change, txHash: change.txHash ?? record.txHash, endedAt: Date.now() })
  }
  const store = {
    begin: async (input: Omit<FakeRecord, "state" | "startedAt">) => {
      records.set([{ ...input, state: "local", startedAt: Date.now() }, ...records.get()])
      setLive(input.operationId, true)
    },
    markProving: async (operationId: string) => {
      const record = get(operationId)
      if (record?.state === "local" && record.provingStartedAt === undefined)
        patch(operationId, { provingStartedAt: Date.now() })
    },
    markHandedOff: async (operationId: string) => {
      const record = get(operationId)
      if (record?.state === "local" && record.handedOffAt === undefined)
        patch(operationId, { handedOffAt: Date.now() })
    },
    markSent: async (operationId: string, txHash: string) => {
      if (get(operationId)?.state === "local") patch(operationId, { state: "sent", txHash })
    },
    settle: async (operationId: string, txHash?: string) =>
      end(operationId, { state: "settled", txHash }),
    fail: async (operationId: string, error: string) =>
      end(operationId, { state: "failed", error }),
    remove: async (operationId: string) => {
      setLive(operationId, false)
      records.set(records.get().filter((r) => r.operationId !== operationId))
    },
    release: (operationId: string) => setLive(operationId, false),
    markRead: async (operationIds: readonly string[]) => {
      for (const id of operationIds) {
        const r = get(id)
        if (r?.endedAt !== undefined && r.readAt === undefined) patch(id, { readAt: Date.now() })
      }
    },
    dismiss: async (operationId: string) => {
      const r = get(operationId)
      if (r?.endedAt !== undefined && r.dismissedAt === undefined) {
        patch(operationId, { readAt: r.readAt ?? Date.now(), dismissedAt: Date.now() })
      }
    },
    dismissEnded: async (scope: string | null) => {
      for (const r of records.get()) {
        if (r.scope === scope && r.endedAt !== undefined) await store.dismiss(r.operationId)
      }
    },
    isLive: (operationId: string) => live.has(operationId),
    get,
    list: () => records.get(),
    onListChanged: (listener: (list: FakeRecord[]) => void) =>
      records.subscribe(() => listener(records.get())),
    onLiveChanged: (listener: () => void) => {
      liveListeners.add(listener)
      return () => void liveListeners.delete(listener)
    },
  }
  provingProgress.on("stage-start", (ev) => {
    if (ev.operationId) void store.markProving(ev.operationId)
  })
  provingProgress.on("tx-hash-saved", (ev) => void store.markSent(ev.operationId, ev.txHash))

  const inProgress = () => records.get().filter((r) => r.state === "local" || r.state === "sent")
  const currentOperation = (list: FakeRecord[]) =>
    list.find((r) => live.has(r.operationId) && (!r.parent || !live.has(r.parent)))
  const tabBoundOperation = (list: FakeRecord[]) =>
    list.find((r) => r.state === "local" && live.has(r.operationId))
  const use = () => useSyncExternalStore(records.subscribe, records.get)
  const tabLineOf = (record: FakeRecord | null, on: boolean) =>
    record?.state === "sent" ? "safe" : record?.state === "local" && on ? "keep" : undefined
  const ended = () => records.get().filter((r) => r.endedAt !== undefined)
  const busyLabel = () => {
    const current = currentOperation(inProgress())
    return current ? flowCopy(current.flow).busy : "Another transaction in progress…"
  }
  /** A store over the records, keeping its reference until they change. */
  const view = <T>(compute: () => T) => {
    let input: FakeRecord[] | undefined
    let output!: T
    return {
      get: () => {
        if (records.get() !== input) {
          input = records.get()
          output = compute()
        }
        return output
      },
      subscribe: records.subscribe,
    }
  }
  let nextId = 0
  return {
    runningOperations: view(inProgress),
    endedOperations: view(ended),
    operationsLoaded: { get: () => true, subscribe: () => () => {} },
    getOperationStore: () => store,
    getOperationsInProgress: inProgress,
    useOperationsInProgress: () => (use(), inProgress()),
    currentOperation,
    tabBoundOperation,
    useCurrentOperation: () => (use(), currentOperation(inProgress())),
    getTabBoundOperation: () => tabBoundOperation(records.get()),
    useTabBoundOperation: () => (use(), tabBoundOperation(records.get())),
    useLeavingLosesTransaction: () => (use(), !!tabBoundOperation(records.get())),
    leavingLosesTransaction: () => !!tabBoundOperation(records.get()),
    isFlowCancelled,
    tabLineOf,
    useTabLine: (operationId: string | undefined) => (
      use(), operationId ? tabLineOf(get(operationId), live.has(operationId)) : undefined
    ),
    useBusyLabel: () => (use(), busyLabel()),
    /** Mirrors the real one: see `runOperation` in `features/operations/operations`. */
    runOperation: async <T>(
      input: { operationId?: string; flow: string; summary: string; parent?: string },
      run: (op: unknown) => Promise<T>,
      txHashOf?: (result: T) => string | undefined,
    ): Promise<T> => {
      const operationId = input.operationId ?? `fake-op-${++nextId}`
      await store.begin({ ...input, operationId, scope: null })
      const toChain = async (txHash: string | undefined) => {
        if (txHash && get(operationId)?.state === "local") await store.markSent(operationId, txHash)
      }
      let inFlight: { txHash: string | undefined } | undefined
      try {
        const result = await run({
          operationId,
          describe: (summary: string) => patch(operationId, { summary }),
          leaveToChain: (txHash: string | undefined) => void (inFlight = { txHash }),
        })
        if (inFlight) await toChain(inFlight.txHash)
        else await store.settle(operationId, txHashOf?.(result))
        return result
      } catch (err) {
        const record = get(operationId)
        const message = err instanceof Error ? err.message : String(err)
        // The suites mock front-core, so its `TxInFlightError` is matched by name.
        if (err instanceof Error && err.constructor.name === "TxInFlightError") {
          await toChain((err as Error & { txHash?: string }).txHash)
        } else if (record?.state === "sent") {
          await store.fail(operationId, message)
        } else if (record?.state === "local") {
          if (
            isFlowCancelled(err) ||
            (record.provingStartedAt === undefined && record.handedOffAt === undefined)
          ) {
            await store.remove(operationId)
          } else {
            await store.fail(operationId, message)
          }
        }
        throw err
      } finally {
        store.release(operationId)
      }
    },
  }
}

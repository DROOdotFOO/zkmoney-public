import { selectNotifications, type OperationRecord } from "@obsidion/front-core"
import { getActiveStorageId } from "../../src/platform/storage/activeStorage"
import { getOperationStore } from "../../src/features/operations/operations"
import { listsEnding, operationText } from "../../src/features/operations/operationEntries"

/** A `local` operation this page runs, as a flow's `runOperation` holds it; resolves to its end. */
export async function startTabBoundOperation(
  operationId = "op-test",
  flow = "withdraw",
): Promise<() => Promise<void>> {
  const store = getOperationStore()
  await store.begin({ operationId, flow, summary: "$25 to Ethereum", scope: getActiveStorageId() })
  return () => store.remove(operationId)
}

/** The panel's entry for an ended operation, with its words. */
export function operationEntry(record: OperationRecord) {
  if (!listsEnding(record)) return null
  const none = { records: [], hydrated: true }
  const [entry] = selectNotifications(
    {
      rows: [],
      oldVersionWithdrawals: [],
      deposits: none,
      withdrawals: none,
      upgrades: { items: [], recipients: new Set<string>(), loaded: true },
      processing: new Map(),
      registrations: [],
      operations: { ended: [record], running: [] },
      loaded: true,
    },
    new Map(),
    new Map(),
    0,
  )
  return entry ? { ...entry, ...operationText(record) } : null
}

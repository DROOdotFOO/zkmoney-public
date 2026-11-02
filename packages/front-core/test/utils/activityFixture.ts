import { createActivity, type Activity } from "../../src/engine/activity"
import { openDatabase, type Database } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord } from "../../src/engine/persistentStore"
import type { Transaction } from "../../src/types/transactions"

/**
 * A real activity store over memory, holding `rows` as saved records. A row without an id is keyed
 * by its hash, as a scanned row is; one without either by its position. `db` is the database it
 * writes, for writes that join it.
 */
export function seededActivity(
  rows: readonly Partial<Transaction>[] = [],
  opts: { backend?: MemoryBackend } = {},
): Activity & { db: Database; backend: MemoryBackend } {
  const backend = opts.backend ?? memoryBackend()
  // Saved as the previous version holds them: the open builds their indexes.
  backend.entries.set("acct/meta/activity", "1")
  rows.forEach((row, i) => {
    const id = row.id ?? (row.txHash ? row.txHash.toLowerCase() : `row-${i}`)
    backend.entries.set(`acct/activity/${id}`, encodeRecord({ amountAtomic: 0n, ...row, id }))
  })
  const db = openDatabase(backend)
  return Object.assign(createActivity({ db }), { db, backend })
}

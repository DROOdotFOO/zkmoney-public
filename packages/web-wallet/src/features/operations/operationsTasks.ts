/**
 * The session's tasks for user transactions: once the wallet is ready, whatever an earlier tab left
 * `local` ends with its flow's record, and `sent` operations settle from the chain.
 */
import {
  bestEffort,
  task,
  type Activity,
  type Database,
  type OperationStore,
  type Resource,
  type Task,
  type Withdrawals,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"

const RESOLVE_SENT_MS = 10_000

const warn = (err: unknown) =>
  console.warn("[operations] could not recover interrupted operations:", err)

/** The session's flow records and its operations. */
interface Stores {
  db: Database
  activity: Activity
  withdrawals: Withdrawals
  operations: OperationStore
}

/** Settles `sent` operations from the chain every 10 s while the page is visible. */
export function operationsSettle({
  wallet,
  operations,
}: {
  wallet: Resource<Pick<ObsidionWallet, "node">>
  operations: Pick<OperationStore, "resolveSent">
}): Task {
  return task("operationsSettle", {
    needs: { wallet },
    every: RESOLVE_SENT_MS,
    run: async ({ wallet }) =>
      void (await bestEffort("unknown", operations.resolveSent(wallet.node))),
  })
}

/** Ends what an earlier tab left before submit, once per session: {@link recoverInterrupted}. */
export function interruptedSweep({
  wallet,
  activeSince,
  ...stores
}: Stores & { wallet: Resource<unknown>; activeSince: () => number }): Task {
  return task("interruptedSweep", {
    needs: { wallet },
    every: "once",
    run: () => recoverInterrupted(stores, activeSince()),
  })
}

/**
 * End what an earlier tab left before submit: every operation, and the session's flow records.
 * One tab runs the wallet and this one starts nothing before `activeSince`, when it became the
 * active tab, so a record that started by then and holds no hash can never be sent. First the
 * operation and its flow's record are made to agree on a hash either one holds, so neither is
 * failed while the other says it is on chain.
 */
export async function recoverInterrupted(
  { db, activity, withdrawals, operations }: Stores,
  activeSince: number,
  now: number = Date.now(),
): Promise<void> {
  // Hashes are reconciled before anything is failed; a store that did not open is not empty, so
  // nothing is failed until a later boot reads it.
  const reconciled = await bestEffort(
    "unknown",
    Promise.all([activity.ready, withdrawals.ready])
      .then(() => reconcileHashes({ db, activity, withdrawals, operations }, activeSince))
      .then(() => true),
  )
  if (!reconciled) return
  const age = now - activeSince
  await Promise.all([
    activity.failInterrupted(now, age).catch(warn),
    operations.failInterrupted(activeSince, now).catch(warn),
    withdrawals.failInterrupted(now, age).catch(warn),
  ])
}

async function reconcileHashes(
  { db, activity, withdrawals, operations: ops }: Stores,
  activeSince: number,
) {
  await ops.load()
  const burns = await withdrawals.all()
  for (const op of ops.list()) {
    const row = await activity.get(op.operationId)
    const burn = burns.find((w) => w.operationId === op.operationId)
    if (op.state === "sent" && op.txHash) {
      const txHash = op.txHash
      // The row's hash and its burn's are one fact.
      await db.write(async (w) => {
        if (row && !row.txHash) await activity.setHash(op.operationId, txHash, w)
        if (burn?.phase === "submitting" && !burn.l2TxHash) {
          await withdrawals.apply(
            burn.localId,
            {
              type: "patch",
              fields: {
                phase: "submitting",
                l2TxHash: txHash as `0x${string}`,
                reorgEpoch: burn.reorgEpoch,
              },
            },
            w,
          )
        }
      })
    } else if (op.state === "local" && op.startedAt <= activeSince) {
      const txHash = row?.txHash || burn?.l2TxHash
      if (txHash) await ops.markSent(op.operationId, txHash)
    }
  }
}

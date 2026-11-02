import type { OldVersionWithdrawal } from "../core/migration/OldVersionWithdrawalStorage"
import { bestEffort } from "./errors"
import { BOOT_WAIT_MS } from "./milestones"
import type { Loaded } from "./recordSource"
import type { Resource } from "./resource"
import { task, within, type Task } from "./runtime"
import type { ReadonlyStore } from "./store"

/** Longest one refund check may take; one that takes longer counts as failed. */
export const REFUND_CHECK_TIMEOUT_MS = 60_000

/** Checks each sending old-version withdrawal for its refunds every 15 s; `settle` saves them. */
export function oldVersionWithdrawalTask<W>(deps: {
  wallet: Resource<W>
  records: ReadonlyStore<Loaded<OldVersionWithdrawal>>
  settle(id: string, wallet: W): Promise<unknown>
}): Task {
  return task("oldVersionWithdrawals", {
    needs: { wallet: deps.wallet },
    after: { firstBalance: BOOT_WAIT_MS },
    every: 15_000,
    async run({ wallet, signal }) {
      const sending = deps.records.get().records.filter((r) => r.phase === "sending")
      const check = (id: string) =>
        within(deps.settle(id, wallet), "refund check", { ms: REFUND_CHECK_TIMEOUT_MS, signal })
      await Promise.all(sending.map((r) => bestEffort("refund.unchecked", check(r.id))))
    },
  })
}

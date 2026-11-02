import { useCallback, useEffect } from "react"
import { useStore } from "@obsidion/front-core"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { reportWithdrawFunnel } from "./withdrawFunnel"
import { reportPaylinkClaims } from "../paylink/paylinkClaimReport"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { useSession } from "../../platform/session"

export interface WithdrawalsState {
  records: readonly WithdrawalRecord[]
  /** True once the last-known records were read back from storage. */
  hydrated: boolean
  /** Post-mine "Check again": a tracker pass now. */
  checkAgain: (l2TxHash: string) => Promise<void>
}

/** Live view over the persisted withdrawal records. The session runs the tracker. */
export function useWithdrawals(): WithdrawalsState {
  const session = useSession()
  const { records, hydrated } = useStore(session.withdrawals.list)

  // Gated on `hydrated`: the pre-hydration empty list would prune the persisted reported-phase
  // map and re-report every finalization. An L1 leg that completed while no tab was open is
  // reported from the record's own timestamps.
  useEffect(() => {
    if (!hydrated) return
    reportWithdrawFunnel(records, webStorage)
    void reportPaylinkClaims(records, webStorage)
  }, [records, hydrated])
  const checkAgain = useCallback(() => session.wake(session.tasks.withdrawalTracker), [session])

  return { records, hydrated, checkAgain }
}

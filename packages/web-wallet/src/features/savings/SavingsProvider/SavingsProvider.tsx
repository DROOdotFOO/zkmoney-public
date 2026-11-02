import { useEffect, useMemo, type ReactNode } from "react"
import {
  SavingsProvider,
  isSavingsMovePending,
  needsVaultFigures,
  useAfter,
  useCachedRecords,
  useResource,
  useStore,
  type After,
} from "@obsidion/front-core"
import { getSavingsMoveStore } from "../savingsMoveStore"
import { useSession } from "../../../platform/session"

/** How often a pending move's deposit is looked for. */
const SAVINGS_SETTLE_INTERVAL_MS = 30_000

/** The Savings token and its position. */
const LOOKUP_AFTER: After = { firstBalance: true }

/**
 * Hands the session's Savings to the screens after the first balance, and runs the settle pass
 * while a move is pending. Without a sUSDS deployment the source is null and every Savings surface
 * stays hidden.
 */
export function WebSavingsProvider({ children }: { children: ReactNode }) {
  const { milestones, withdrawals, balances, savings } = useSession()
  const ready = useAfter(milestones, LOOKUP_AFTER)
  const built = useResource(savings)
  const source = ready && built ? built : null
  const { records } = useCachedRecords(useMemo(getSavingsMoveStore, []))
  const { records: burns, hydrated: burnsLoaded } = useStore(withdrawals.list)
  // Burns with Sky meta the store does not know: a rescan rebuilt them, and the pass adopts them.
  const unadopted = burns.filter(
    (burn) =>
      burn.skyMove &&
      burn.phase !== "failed" &&
      !records.some((move) => move.withdrawalLocalId === burn.localId),
  ).length
  // A failed burn funded nothing; the pass leaves its move alone, so it does not keep the poll alive.
  const failed = new Set(
    burns.filter((burn) => burn.phase === "failed").map((burn) => burn.localId),
  )
  // Until the burns load, an unadopted one may be among them: the poll stays alive.
  const pending =
    !burnsLoaded ||
    unadopted > 0 ||
    records.some(
      (move) =>
        !failed.has(move.withdrawalLocalId) &&
        (isSavingsMovePending(move) || needsVaultFigures(move)),
    )
  useEffect(() => {
    if (!source) return
    const pass = () =>
      void source.settle().catch((err) => console.warn("[savings] settle pass failed:", err))
    pass()
    if (!pending) return
    const timer = setInterval(pass, SAVINGS_SETTLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, pending, unadopted])
  return (
    <SavingsProvider source={source} balances={balances.records}>
      {children}
    </SavingsProvider>
  )
}

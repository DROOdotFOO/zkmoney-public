import { useSyncExternalStore } from "react"
import { createExternalState } from "../../lib/externalState"

/** The latest paylink rescan on this page: the account it ran for and whether it read every link. */
const latest = createExternalState<{ account: string; complete: boolean } | undefined>(undefined)
let rerun: (() => void) | undefined

/** Records a finished pass. One that failed or deferred a link is not complete. */
export function markPaylinksRescanned(account: string, complete: boolean): void {
  latest.set({ account: account.toLowerCase(), complete })
}

/** Lets `rescanPaylinks` start `run`; returns the call that withdraws it. */
export function providePaylinkRescan(run: () => void): () => void {
  rerun = run
  return () => {
    if (rerun === run) rerun = undefined
  }
}

/** Starts a rescan pass now, for a user who asked to check again. */
export function rescanPaylinks(): void {
  rerun?.()
}

/**
 * Whether this page's stored rows hold every paylink `account` made: undefined before a pass has
 * ended, false while the latest pass failed or deferred a link. A fresh device stores none until a
 * pass rebuilds them from chain.
 */
export function usePaylinksRescanned(account: string | undefined): boolean | undefined {
  const pass = useSyncExternalStore(latest.subscribe, latest.get, latest.get)
  return account && pass?.account === account.toLowerCase() ? pass.complete : undefined
}

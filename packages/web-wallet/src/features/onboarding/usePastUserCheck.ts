import { useSyncExternalStore } from "react"
import type { Hex } from "viem"
import { useResource } from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { isWalletRejection } from "../deposit/l1Wallet"
import { claimPastUser, PastUserAlreadyUsedError, provePastUserForGrant } from "./pastUserClaim"
import {
  clearPastUserVerified,
  loadPastUserVerified,
  pastUserReducer,
  recallPastUser,
  rememberPastUser,
  savePastUserVerified,
  subscribePastUserVerified,
  type PastUserEvent,
  type PastUserState,
} from "./pastUserCheck"
import { NotPastUserError, signPastUserMessage } from "./pastUserProver"
import { useSession } from "../../platform/session"

// One check per tab, outside any component: closing the modal leaves it running, and its result
// reopens the modal.
type Live = PastUserState & { owner?: string }
let live: Live | undefined
let running = false
let open = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** With an account the check is recorded for it; before one, the owner-less proof waits for a tag. */
function initial(owner: string | undefined): Live {
  if (owner) return { owner, ...recallPastUser(owner) }
  const verified = loadPastUserVerified()
  return verified ? { step: "confirmed", account: verified.account } : { step: "connect" }
}

function current(owner: string | undefined): Live {
  if (!live || (!running && live.owner !== owner)) live = initial(owner)
  return live
}

function dispatch(owner: string | undefined, event: PastUserEvent) {
  live = { owner, ...pastUserReducer(current(owner), event) }
  if (owner) rememberPastUser(owner, live)
  notify()
}

export function setVerifyOpen(next: boolean): void {
  open = next
  notify()
}

export function useVerifyOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open)
}

function errorCopy(err: unknown): string {
  if (isWalletRejection(err)) return "The wallet did not sign the message. Try again."
  return "The check did not finish. Try again."
}

async function runCheck(account: Hex, obsidionAccount: ObsidionAccount | undefined) {
  const owner = obsidionAccount?.getAddress().toString()
  running = true
  dispatch(owner, { type: "connected", account })
  try {
    const signature = await signPastUserMessage(account)
    dispatch(owner, { type: "signed" })
    if (obsidionAccount) await claimPastUser(obsidionAccount, signature)
    else savePastUserVerified({ account, ...(await provePastUserForGrant(signature)) })
    dispatch(owner, { type: "confirmed" })
  } catch (err) {
    if (err instanceof NotPastUserError) dispatch(owner, { type: "ended", step: "not_found" })
    else if (err instanceof PastUserAlreadyUsedError)
      dispatch(owner, { type: "ended", step: "claimed" })
    else dispatch(owner, { type: "failed", error: errorCopy(err) })
  } finally {
    running = false
    setVerifyOpen(true)
  }
}

/** A grant refused the owner-less proof as spent: the check ends as claimed and says so. */
export function pastUserClaimedAtGrant(): void {
  clearPastUserVerified()
  dispatch(undefined, { type: "ended", step: "claimed" })
  setVerifyOpen(true)
}

/** The tab's past-user verification from before any passkey, if one ran. */
export function usePastUserVerified() {
  return useSyncExternalStore(subscribePastUserVerified, loadPastUserVerified)
}

/** "Used zk.money before": the old wallet signs, this browser proves. */
export function usePastUserCheck() {
  const obsidionAccount = useResource(useSession().account)
  const owner = obsidionAccount?.getAddress().toString()
  const state = useSyncExternalStore(subscribe, () => current(owner))
  return {
    state,
    check: (account: Hex) => void runCheck(account, obsidionAccount ?? undefined),
    /** Starts over unless a check is running or has passed. */
    reset: () => {
      if (!running && state.step !== "confirmed") dispatch(owner, { type: "reset" })
    },
  }
}

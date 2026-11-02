/**
 * Whether the signed-in account may start an action now, and why not. One policy for the action
 * routes and the presses that start an action: a name first, then the tag claim, then the upgrade,
 * then a backup passkey's balance move, then the sponsored rail. A new link also waits while a
 * backup passkey add has yet to switch the account. A deposit stays open to the registration that
 * owes it. Withdraw refunds an old version's funds to L1 before anything else, since that needs none
 * of them.
 */
import { useCallback, useEffect, useRef } from "react"
import { isDemoMode } from "../dev/demoFlag"
import { showErrorModal } from "../errors/errorModal"
import { balanceMovingCopy } from "./backupPasskey/backupPasskeyCopy"
import { useBalanceMoving, useRerootPending } from "./backupPasskey/backupRotationStore"
import { useUpgradeLock } from "./migration/upgradeLock"
import { loadWalletIdentity } from "./identity/walletIdentity"
import {
  openMigrationDialog,
  useUpgradeStatus,
  type UpgradeState,
} from "./migration/migrationDialog"
import { useWithdrawableSources } from "./migration/oldVersionWithdraw"
import { useNameClaimPending, useRegistrationDepositOwed } from "./onboarding/openRegistration"
import { useSponsoredRailPending } from "./onboarding/sponsoredRailReadiness"

export type WalletAction =
  | "send"
  | "receive"
  | "deposit"
  | "withdraw"
  | "link"
  | "requests"
  | "savings"
  | "claim"

/**
 * - `name`: the account needs a name first.
 * - `home`: the tag claim is still landing; Home shows how far it is.
 * - `upgrade`: the account must upgrade first.
 * - `holding`: whether it must upgrade is not known yet.
 * - `moving`: a backup passkey rotation moves the balance, paying with the note the action pays with.
 * - `checking`: whether the sponsored rail carries the account is not known yet.
 * - `registering`: the account's registration has yet to reach the rollup.
 * - `refund`: withdraw refunds an old version's funds to L1.
 * - `backup`: a backup passkey add has yet to switch the account; a link made now stays the old one's.
 */
export type ActionVerdict =
  | "open"
  | "name"
  | "home"
  | "upgrade"
  | "holding"
  | "moving"
  | "checking"
  | "registering"
  | "refund"
  | "backup"

export interface ActionState {
  /** No identity reads as named. */
  named: boolean
  claimPending: boolean
  depositOwed: boolean
  railPending: boolean | undefined
  upgrade: UpgradeState
  /** A backup passkey add has yet to switch the account onto its two-key account. */
  rerootPending: boolean
  /** The account's upgrade lock is released: it is current on this version. */
  current: boolean
  /** The account's upgrade lock is held: an upgrade it started is not done. */
  locked: boolean
  /** This page has read the account's upgrade runs, so the lock can be trusted. */
  lockChecked: boolean
  demo: boolean
  /** A frozen old version holds funds that withdraw can refund to L1. */
  oldWithdrawable: boolean
  /** A backup passkey rotation on this device moves the account's balance. */
  moving: boolean
}

/**
 * What each action needs besides the upgrade. `sponsor`: the action pays with the subscription note,
 * so it waits while a backup passkey rotation's balance move spends that note.
 */
const NEEDS: Record<WalletAction, { name?: true; claim?: true; rail?: true; sponsor?: true }> = {
  send: { name: true, claim: true, rail: true, sponsor: true },
  withdraw: { name: true, claim: true, rail: true, sponsor: true },
  link: { name: true, claim: true, rail: true, sponsor: true },
  deposit: { name: true, claim: true },
  receive: { claim: true },
  requests: { claim: true },
  savings: { sponsor: true },
  claim: { sponsor: true },
}

export function actionVerdict(action: WalletAction, s: ActionState): ActionVerdict {
  const needs = NEEDS[action]
  if (action === "withdraw" && s.oldWithdrawable && !s.demo) return "refund"
  if (needs.name && !s.named) return "name"
  if (action === "deposit" && s.depositOwed) return "open"
  if (needs.claim && s.claimPending) return "home"
  const upgrade = s.demo ? undefined : upgradeVerdict(s)
  if (upgrade) return upgrade
  if (needs.sponsor && s.moving && !s.demo) return "moving"
  if (action === "link" && s.rerootPending && !s.demo) return "backup"
  if (!needs.rail || s.demo) return "open"
  if (s.railPending === undefined) return "checking"
  return s.railPending ? "registering" : "open"
}

/** A held lock waits for its upgrade; an account current here waits only on one it is known to need. */
export function upgradeVerdict({
  upgrade,
  current,
  locked,
  lockChecked,
}: Pick<ActionState, "upgrade" | "current" | "locked" | "lockChecked">):
  | "upgrade"
  | "holding"
  | undefined {
  if (locked) return "upgrade"
  if (!lockChecked) return "holding"
  switch (upgrade) {
    case "offered":
    case "running":
    case "stopped":
      return "upgrade"
    case "finishing":
    case "failed":
      return current ? undefined : "upgrade"
    case "checking":
      return current ? undefined : "holding"
    case "none":
      return undefined
  }
}

export function useActionState(): ActionState {
  const identity = loadWalletIdentity()
  const lock = useUpgradeLock(identity?.address)
  return {
    named: !identity || !!identity.handle,
    claimPending: useNameClaimPending(),
    depositOwed: useRegistrationDepositOwed(),
    railPending: useSponsoredRailPending(),
    upgrade: useUpgradeStatus().state,
    rerootPending: useRerootPending(identity?.address),
    current: lock.state === "released",
    locked: lock.state === "held",
    lockChecked: lock.checked,
    demo: isDemoMode(),
    oldWithdrawable: useWithdrawableSources().length > 0,
    moving: useBalanceMoving(identity?.address),
  }
}

export function useActionVerdict(action: WalletAction): ActionVerdict {
  return actionVerdict(action, useActionState())
}

/**
 * Starts an action from a press. An upgrade the account must make opens first, titled for the
 * action; while that is not known the sheet holds the action and starts it if no upgrade is needed,
 * unless the screen that pressed it is gone. A balance move says why the action waits. Anything
 * else the action's own route answers.
 */
export function useActionGuard(): (action: WalletAction, run: () => void) => void {
  const state = useRef<ActionState>(undefined as never)
  state.current = useActionState()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback((action, run) => {
    const verdict = actionVerdict(action, state.current)
    if (verdict === "upgrade") openMigrationDialog({ action })
    else if (verdict === "holding")
      openMigrationDialog({ action, then: () => mounted.current && run() })
    else if (verdict === "moving") showErrorModal(balanceMovingCopy)
    else run()
  }, [])
}

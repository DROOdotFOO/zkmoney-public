import { useEffect } from "react"
import {
  SponsoredAllowanceStore,
  useAllowanceSnapshot,
  useContractServiceContext,
  type AllowanceSnapshot,
  useResource,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { readSponsoredAllowance } from "./readAllowance"
import { readAllowanceUsage } from "./readAllowanceUsage"
import { useSession } from "../../platform/session"

const store = new SponsoredAllowanceStore()

/** The account and deployment the allowance belongs to; undefined while no account is signed in. */
function scopeKey(account: string | undefined): string | undefined {
  if (!account) return undefined
  const config = getConfig()
  return [account, config.network, config.oxideProfile.portal, config.claimFpcAddress ?? ""].join(
    "|",
  )
}

/**
 * The signed-in account's sponsored-transaction allowance on the current deployment. A snapshot
 * that belongs to another account or deployment never renders: it reads as loading until this
 * scope's own read lands. An inactive consumer starts no read.
 */
export function useSponsoredAllowance(active = true): {
  snapshot: AllowanceSnapshot
  refresh: () => void
} {
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const { contractService } = useContractServiceContext()
  const key = scopeKey(obsidionAccount?.getAddress().toString())

  useEffect(() => {
    if (!active) return
    if (!key || !obsidionWallet || !obsidionAccount || !contractService) {
      store.setScope(undefined)
      return
    }
    const deps = { wallet: obsidionWallet, account: obsidionAccount, contractService }
    store.setScope({
      key,
      read: () => readSponsoredAllowance(deps),
      readUsage: (read) => readAllowanceUsage(deps, read),
    })
  }, [active, key, obsidionWallet, obsidionAccount, contractService])

  const snapshot = useAllowanceSnapshot(store)
  const current: AllowanceSnapshot = !key
    ? { status: "signed-out" }
    : "scope" in snapshot && snapshot.scope === key
    ? snapshot
    : { status: "loading", scope: key }
  return { snapshot: current, refresh: () => void store.refresh() }
}

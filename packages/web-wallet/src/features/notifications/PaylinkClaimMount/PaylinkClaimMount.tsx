/**
 * Creator-side paylink upkeep: rebuilds the sent paylink rows this browser never had from the
 * account's own funding `Transfer` copies, then sweeps sent rows against the on-chain nullifier —
 * once the wallet is live, whenever the tab becomes visible, and on a timer while it stays visible.
 * The reconciler flips sent rows to claimed, which stamps the `claimedAt` the bell's entry reads,
 * and fires the `paylinkClaimed` event an open detail sheet listens to.
 */

import { useEffect } from "react"
import {
  PaylinkClaimReconciler,
  checkSpentViaPaylinkService,
  createTransferEventSource,
  rebuildPaylinks,
  useContractServiceContext,
  type After,
  useResource,
} from "@obsidion/front-core"
import { PaylinkService, encodePaylinkInline } from "@obsidion/sdk"
import { getConfig } from "../../../config/env"
import { getAuthService } from "../../../platform/auth/useAuthenticator"
import { useSession } from "../../../platform/session"
import { markPaylinksRescanned, providePaylinkRescan } from "../../paylink/paylinkRescanState"

const SWEEP_MS = 60_000
const RESCAN_AFTER: After = { firstBalance: true, depositsReplayed: true, movesReplayed: true }

let active: PaylinkClaimReconciler | undefined

/** Recheck one sent paylink row against the chain through the mounted sweep; no-op before it mounts. */
export function recheckPaylinkClaim(txHash: string): Promise<void> {
  return active?.reconcileTxHash(txHash) ?? Promise.resolve()
}

export function PaylinkClaimMount(): null {
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const tokenService = useResource(useSession().token)
  const { contractService } = useContractServiceContext()
  const { activity, db, milestones } = useSession()

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !tokenService || !contractService) return
    const controller = new AbortController()
    const accountAddress = obsidionAccount.getAddress().toString()
    const paylinkService = new PaylinkService(
      obsidionWallet,
      obsidionAccount,
      tokenService,
      contractService,
    )
    const reconciler = new PaylinkClaimReconciler({
      checkSpent: checkSpentViaPaylinkService(paylinkService),
      storage: activity,
      getActiveAccount: () => accountAddress,
    })
    active = reconciler
    /** Whether the pass read every link the account made. */
    const rescan = async (): Promise<boolean> => {
      if (!(await milestones.after(RESCAN_AFTER, controller.signal))) return false
      // Cached once the account is unlocked; a locked wallet skips this pass.
      const masterSecret = await getAuthService().getSecretKey()
      if (!masterSecret || controller.signal.aborted) return false
      // The rows this rebuild writes are scoped to the wallet's network.
      const { networkId } = obsidionWallet
      const token = await tokenService.fetchTokenInformation()
      const { complete } = await rebuildPaylinks({
        source: createTransferEventSource({
          wallet: obsidionWallet,
          tokenAddress: token.address,
          accountAddress,
          contractService,
        }),
        accountAddress,
        masterSecret,
        networkId,
        endpointScope: getConfig().nodeEndpointDigest,
        signal: controller.signal,
        paylinkService,
        linkFor: (params) => `${location.origin}/link#${encodePaylinkInline(params)}`,
        store: activity,
        db,
        token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      })
      return complete
    }
    const run = () => {
      if (controller.signal.aborted || document.visibilityState !== "visible") return
      void rescan()
        .catch((err) => {
          console.warn("[PaylinkClaimMount] paylink rescan failed", err)
          return false
        })
        .then((complete) => {
          if (controller.signal.aborted) return
          markPaylinksRescanned(accountAddress, complete)
          return reconciler.reconcile(obsidionWallet.networkId)
        })
    }
    const withdrawRescan = providePaylinkRescan(run)
    run()
    document.addEventListener("visibilitychange", run)
    const timer = setInterval(run, SWEEP_MS)
    return () => {
      controller.abort()
      withdrawRescan()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", run)
      if (active === reconciler) active = undefined
    }
  }, [obsidionWallet, obsidionAccount, tokenService, contractService, activity, db, milestones])

  return null
}

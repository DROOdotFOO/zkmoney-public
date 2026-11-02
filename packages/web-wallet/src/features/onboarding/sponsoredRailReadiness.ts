/**
 * Whether the sponsored rail can carry a subscribe for this account yet, and why not when it cannot.
 *
 * This answers readiness, not billability: it asks whether this account can ride the sponsored rail
 * at all, and it supplies no operation calls, so it cannot say that any particular batch will be
 * paid for. The route gate uses it to hold flows that would only be refused on chain, and the
 * upgrade to tell an account still being set up on this version.
 */
import { useEffect, useSyncExternalStore } from "react"
import { waitForRegistrationMessage } from "@obsidion/sdk"
import { useContractServiceContext, useResource } from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import { claimSponsorContext } from "./claimSponsorship"
import { RegistrationPendingError, type RegistrationPending } from "./registrationRail"
import { RAIL_REGISTERED } from "./rails"
import { useSession } from "../../platform/session"

/**
 * Why this account cannot ride the sponsored rail yet, or false when it can: it holds a subscription
 * note, or its registration message is ready. A read that cannot answer is `read-error`, which
 * blocks the route and is re-asked on the same timer, so an outage never reads as ready.
 */
export async function sponsoredRailPending(
  deps: Parameters<typeof claimSponsorContext>[0],
): Promise<RegistrationPending | false> {
  try {
    await claimSponsorContext(deps, RAIL_REGISTERED)
    return false
  } catch (error) {
    if (error instanceof RegistrationPendingError) return error.state
    return { pending: "read-error" }
  }
}

/** How long the owner waits before re-asking L1 or the PXE; the sweep takes a few L1 blocks. */
const RECHECK_INTERVAL_MS = 12_000

const railPending = createExternalState<RegistrationPending | false | undefined>(undefined)

/**
 * The one owner of {@link sponsoredRailPending} for the signed-in account: the route gate and the
 * upgrade read its answer, so the wallet asks once. `undefined` until the wallet services exist and
 * the reads answer (a registered account is not pending in that window, only unknown), then
 * re-asked while pending so a held screen opens on its own. A message the rollup has yet to import
 * is waited on through the node rather than re-scanned from L1.
 */
export function SponsoredRailReadinessMount(): null {
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const { contractService } = useContractServiceContext()
  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount || !contractService) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true
    const check = async () => {
      const waiting = await sponsoredRailPending({
        wallet: obsidionWallet,
        account: obsidionAccount,
        contractService,
      })
      if (!live) return
      railPending.set(waiting)
      if (!waiting) return
      if (waiting.pending === "import") {
        await waitForRegistrationMessage(obsidionWallet.node, waiting.messageHash, {
          timeoutSeconds: RECHECK_INTERVAL_MS / 1000,
        }).catch(() => undefined)
        if (live) void check()
      } else {
        timer = setTimeout(() => void check(), RECHECK_INTERVAL_MS)
      }
    }
    void check()
    return () => {
      live = false
      clearTimeout(timer)
      railPending.set(undefined)
    }
  }, [obsidionWallet, obsidionAccount, contractService])
  return null
}

/**
 * Whether the account still waits to ride the sponsored rail, from {@link SponsoredRailReadinessMount}.
 * A `false` means the account can ride the rail, not that any given batch is paid for.
 */
export function useSponsoredRailPending(): boolean | undefined {
  return useSyncExternalStore(railPending.subscribe, () => {
    const waiting = railPending.get()
    return waiting === undefined ? undefined : waiting !== false
  })
}

/** The last read failed: pending above means unknown, not a registration on its way. */
export function useSponsoredRailReadFailed(): boolean {
  return useSyncExternalStore(railPending.subscribe, () => {
    const waiting = railPending.get()
    return !!waiting && waiting.pending === "read-error"
  })
}

/**
 * Runs the broadcast ledger in the active tab once the PXE is up and the first balance is in: every
 * SIPA broadcast this wallet owes is proven, one at a time, until it lands, including those an
 * earlier page left unfinished.
 */
import { useEffect } from "react"
import { useAfter, type After, useResource } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { useSession } from "../../platform/session"
import { usePxeBoot } from "../../ui/PxeBoot"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { startBroadcasts } from "./broadcasts"
import { registrationExecutor } from "./registrationExecutor"
import { rotationExecutor } from "./rotationBroadcastExecutor"

const AFTER: After = { firstBalance: true }
export function BroadcastsMount(): null {
  const obsidionWallet = useResource(useSession().wallet)
  const booted = usePxeBoot().bootStatus === "ready"
  const ready = useAfter(useSession().milestones, AFTER)
  useEffect(() => {
    if (!booted || !ready || !obsidionWallet) return
    return startBroadcasts(obsidionWallet, {
      registration: registrationExecutor(obsidionWallet, getConfig()),
      rotation: rotationExecutor(obsidionWallet, getConfig()),
      slot: getSipaDepositGateway().slotExecutor(obsidionWallet),
    })
  }, [booted, ready, obsidionWallet])
  return null
}

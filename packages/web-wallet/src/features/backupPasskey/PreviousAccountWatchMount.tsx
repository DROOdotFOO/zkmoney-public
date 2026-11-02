import { useEffect } from "react"
import { PREVIOUS_MOVE_POLL_MS, useResource } from "@obsidion/front-core"
import { getPreviousAccountWatcher } from "./previousAccountWatcher"
import { useSession } from "../../platform/session"

/**
 * Watches a rotated wallet's previous account on every wallet route, so a stored move chunk settles
 * without Home. It ticks at the move's own poll, the most frequent of the watcher's checks.
 */
export function PreviousAccountWatchMount(): null {
  const obsidionWallet = useResource(useSession().wallet)
  useEffect(() => {
    if (!obsidionWallet) return
    const watcher = getPreviousAccountWatcher()
    watcher.start(obsidionWallet)
    const timer = setInterval(() => void watcher.tick(), PREVIOUS_MOVE_POLL_MS)
    return () => {
      clearInterval(timer)
      watcher.stop()
    }
  }, [obsidionWallet])
  return null
}

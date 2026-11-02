/**
 * Whether this version's network has proven a checkpoint. Until it has, the upgrade and the zk.money
 * withdrawal wait ("Waiting for network"); the own-wallet route does not. Final once seen.
 */
import { useEffect, useSyncExternalStore } from "react"
import { useResource } from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import { useSession } from "../../platform/session"

const POLL_MS = 30_000

const ready = createExternalState(false)
let polling = false

type ProvenReader = { getCheckpointNumber: (tag: "proven") => Promise<number | bigint> }

export async function readNetworkReady(node: ProvenReader): Promise<boolean> {
  if (ready.get()) return true
  if (BigInt(await node.getCheckpointNumber("proven")) >= 1n) ready.set(true)
  return ready.get()
}

function poll(node: ProvenReader) {
  if (polling) return
  polling = true
  const tick = async () => {
    const done = await readNetworkReady(node).catch(() => false)
    if (!done) setTimeout(() => void tick(), POLL_MS)
  }
  void tick()
}

/** True once the network has proven a checkpoint. */
export function useNetworkReady(): boolean {
  const node = useResource(useSession().wallet)?.node as ProvenReader | undefined
  useEffect(() => {
    if (node) poll(node)
  }, [node])
  return useSyncExternalStore(ready.subscribe, ready.get)
}

/** For tests. */
export const __resetNetworkReady = () => {
  ready.set(false)
  polling = false
}

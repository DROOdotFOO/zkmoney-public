import { useEffect } from "react"
import { balanceScope, BalanceStorage } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { demoScenario } from "../demoFlag"
import { DEMO_COMPLETE_ADDRESS, DEMO_L2_TOKEN } from "../demoFixtures"

/** A cached zero is no figure; the offline fixture has no sync, so it stands in for one's read. */
export default function DemoEmptyBalance() {
  useEffect(() => {
    if (demoScenario() !== "empty") return
    const scope = balanceScope(getConfig().network, DEMO_COMPLETE_ADDRESS)
    void BalanceStorage.get(webStorage).updateBalance(scope, DEMO_L2_TOKEN, 0n)
  }, [])
  return null
}

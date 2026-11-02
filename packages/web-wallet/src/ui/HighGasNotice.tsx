import { useEffect, useMemo, useState } from "react"
import { Network } from "@obsidion/core/constants"
import { useResource } from "@obsidion/front-core"
import { formatGwei, parseGwei } from "viem"
import { getConfig } from "../config/env"
import { l1PublicClient } from "../config/oxideTuple"
import { pauseWhenHidden } from "../platform/visibilityScheduler"
import { Warning } from "./Warning"
import { useSession } from "../platform/session"

const HIGH_GAS = parseGwei("1")
const POLL_MS = 60_000

/** Polls `read` while the tab is visible; null before the first read and after a failed one. */
function usePolled<T>(read: (() => Promise<T>) | undefined): T | null {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    if (!read) return
    // Only the latest read may land, so a slow reply never overwrites a newer one.
    let seq = 0
    const poll = () => {
      const n = ++seq
      read().then(
        (v) => n === seq && setValue(v),
        () => n === seq && setValue(null),
      )
    }
    poll()
    const timer = pauseWhenHidden.setInterval(poll, POLL_MS)
    return () => {
      seq++
      pauseWhenHidden.clearInterval(timer)
    }
  }, [read])
  return value
}

/** Warns while L1 gas is high, since deposits, withdrawals and L2 fees all pay for it. */
export function HighGasNotice() {
  const read = useMemo(() => {
    const config = getConfig()
    // The sandbox L1's price says nothing about real fees.
    if (config.network === Network.SANDBOX) return undefined
    const client = l1PublicClient(config)
    return () => client.getGasPrice()
  }, [])
  const gasPrice = usePolled(read)

  if (gasPrice === null || gasPrice <= HIGH_GAS) return null
  return (
    <Warning
      title={`Ethereum gas is high (${Number(formatGwei(gasPrice)).toFixed(1)} gwei)`}
      style={{ marginTop: -16, marginBottom: -16 }}
    >
      Deposits and withdrawals may take longer than usual, and fees may be higher.
    </Warning>
  )
}

/** Says the app is unavailable while Aztec fees are above what the ClaimFPC sponsors. */
export function HighL2FeeNotice() {
  const obsidionWallet = useResource(useSession().wallet)
  const read = useMemo(
    () => obsidionWallet && (() => obsidionWallet.sponsoredFeesAboveCap()),
    [obsidionWallet],
  )
  if (!usePolled(read)) return null
  return (
    <Warning
      tone="error"
      title="zk.money is unavailable while network fees are high"
      style={{ marginTop: -16, marginBottom: 24 }}
    >
      Aztec network fees are too high for transactions to go through. Your funds are safe, and full
      functionality will be available when network fees stabilize.
    </Warning>
  )
}

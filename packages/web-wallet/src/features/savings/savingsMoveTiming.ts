/**
 * What a move's time note is built from: the slot grid the deposit screen reads, and
 * the release ETA the withdrawal flow's estimator gives for a burn landing at a given time.
 */
import { useEffect, useState } from "react"
import {
  estimateWithdrawalSpeedup,
  type SavingsMoveEta,
  type SavingsMoveTiming,
  useResource,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { loadArrivalGrid } from "../deposit/depositArrival"
import { etaLabel } from "../withdraw/WithdrawalSpeedPicker"
import { speedupEstimator } from "../withdraw/useFasterWithdrawal"
import { useSession } from "../../platform/session"

/** A burn that has landed: its release is estimated from where it sits in its epoch. */
const LANDED = { expected: 0, earliest: 0, latest: 0 }

let loading: Promise<SavingsMoveTiming> | undefined

type SavingsNode = ObsidionWallet["node"]

async function loadTiming(node: SavingsNode | undefined): Promise<SavingsMoveTiming> {
  if (!node) throw new Error("Savings timing needs the node")
  const config = getConfig()
  const estimator = speedupEstimator(config.network, node, l1PublicClient(config))
  const [grid, constants, calibration] = await Promise.all([
    loadArrivalGrid(node),
    node.getL1Constants(),
    estimator.calibrate(),
  ])
  return {
    grid,
    releaseSeconds: (landedAtSeconds: number) =>
      estimateWithdrawalSpeedup({ constants, now: landedAtSeconds, landing: LANDED, calibration })
        .standardEtaSeconds,
  }
}

/** The timing every move's note shares; undefined while it loads or where a read failed. */
export function useSavingsMoveTiming(): SavingsMoveTiming | undefined {
  const node = useResource(useSession().wallet)?.node
  const [timing, setTiming] = useState<SavingsMoveTiming>()
  useEffect(() => {
    if (!node) return
    let live = true
    loading ??= loadTiming(node).catch((err) => {
      loading = undefined
      throw err
    })
    loading.then(
      (loaded) => live && setTiming(loaded),
      () => {},
    )
    return () => {
      live = false
    }
  }, [node])
  return timing
}

/** "About 12 min left" while a leg counts down, "Usually about 25 min" for a typical duration. */
export const savingsEtaCopy = (eta: SavingsMoveEta): string =>
  eta.remaining
    ? `${etaLabel(eta.seconds)} left`
    : `Usually ${etaLabel(eta.seconds).replace(/^About/, "about")}`

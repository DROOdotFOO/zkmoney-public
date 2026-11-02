/**
 * Drives the session's saved backup-passkey rotation on every wallet route once the PXE is up and
 * the first balance is in, so it advances with Settings closed and after a reload.
 */
import { useEffect } from "react"
import { useAfter, type After, useResource } from "@obsidion/front-core"
import type { Address } from "viem"
import { handOffAccount, useSession } from "../../platform/session"
import { usePxeBoot } from "../../ui/PxeBoot"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { warnFailure } from "./BackupPasskeyPanel"
import { buildBackupFlowDeps } from "./backupPasskeyRuntime"
import { getBackupRotationStore } from "./backupRotationStore"
import { getRotationDriver, ownsRotation } from "./rotationDrive"

const AFTER: After = { firstBalance: true }
export function BackupRotationMount(): null {
  const obsidionWallet = useResource(useSession().wallet)
  const booted = usePxeBoot().bootStatus === "ready"
  const ready = useAfter(useSession().milestones, AFTER)
  useEffect(() => {
    if (!booted || !ready || !obsidionWallet) return
    const driver = getRotationDriver()
    driver.start({
      store: getBackupRotationStore(),
      deps: (owner) =>
        buildBackupFlowDeps({
          wallet: obsidionWallet,
          owner: owner as Address,
          switchAccount: handOffAccount,
        }),
      owns: (record) => ownsRotation(record, loadWalletIdentity()?.address),
      report: warnFailure,
    })
    return () => driver.stop()
  }, [booted, ready, obsidionWallet])
  return null
}

import { useSyncExternalStore } from "react"
import { RotationDriver, type BackupRotationRecord, type RotationDrive } from "@obsidion/front-core"

const driver = new RotationDriver()

/** The page's one driver of saved rotations; `BackupRotationMount` starts it for the session. */
export function getRotationDriver(): RotationDriver {
  return driver
}

/** What the driver holds for `owner`'s record; undefined while it drives none. */
export function useRotationDrive(owner: string): RotationDrive | undefined {
  return useSyncExternalStore(driver.subscribe, () => driver.drive(owner))
}

export function useRotationDrives(): ReadonlyMap<string, RotationDrive> {
  return useSyncExternalStore(driver.subscribe, driver.getSnapshot)
}

/**
 * Whether the record changes the account at `address`: the one-key account its change was built
 * over, or the two-key account the re-root moves the wallet to.
 */
export function ownsRotation(record: BackupRotationRecord, address: string | undefined): boolean {
  if (!address) return false
  const own = address.toLowerCase()
  return (
    record.rotation?.builtOver.l2Address.toLowerCase() === own ||
    record.plan?.address.toLowerCase() === own
  )
}

/** A step waiting on the user's tap: a chunk's send, or a retry of a paused or declined move. */
export const awaitsApproval = (drive: RotationDrive) =>
  drive.resume?.wait === "approval" ||
  drive.resume?.wait === "declined" ||
  drive.record.attention === "move"

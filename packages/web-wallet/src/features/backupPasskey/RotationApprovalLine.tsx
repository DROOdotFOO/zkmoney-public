import { useState } from "react"
import { PasskeysModal } from "../../ui/PasskeysModal"
import { moveCopy } from "./backupPasskeyCopy"
import { awaitsApproval, useRotationDrives } from "./rotationDrive"

/** Home's line while a rotation's move waits for the user's tap; the tap itself is in Settings. */
export function RotationApprovalLine() {
  const drives = useRotationDrives()
  const [sheet, setSheet] = useState(false)
  const waiting = [...drives.values()].some((drive) => awaitsApproval(drive) && !drive.approving)
  return (
    <>
      {waiting && (
        <div
          className="ww-banner ww-banner--static"
          data-testid="rotation-approval-line"
          aria-live="polite"
        >
          <span className="ww-banner__text">
            <span className="ww-banner__title">{moveCopy.home}</span>
            <span className="ww-banner__body">{moveCopy.homeDetail}</span>
          </span>
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            onClick={() => setSheet(true)}
          >
            {moveCopy.resume}
          </button>
        </div>
      )}
      {sheet && <PasskeysModal onClose={() => setSheet(false)} />}
    </>
  )
}

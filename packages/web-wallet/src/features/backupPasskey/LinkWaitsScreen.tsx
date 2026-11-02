import { useNavigate } from "react-router-dom"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { ActionWaitScreen } from "../../ui/screens/ActionWaitScreen"
import { linkWaitsCopy } from "./backupPasskeyCopy"

/** Shown in place of a new paylink while a backup passkey add has yet to switch the account. */
export function LinkWaitsScreen() {
  const navigate = useNavigate()
  return (
    <ActionWaitScreen
      testId="link-waits"
      title={linkWaitsCopy.title}
      message={linkWaitsCopy.message}
      action={<PrimaryGradientButton title="Open Settings" onClick={() => navigate("/settings")} />}
    />
  )
}

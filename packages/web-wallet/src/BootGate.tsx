import React from "react"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { ActiveTabGate } from "./ActiveTabGate/ActiveTabGate"
import type { WebBootConfig } from "./config/env"
import { GOOGLE_CALLBACK_PATH, GoogleCallbackScreen } from "./features/paylink/googleAuth"
import { getDesktopSettingsPath } from "./platform/desktopBridge"
import { BOOT_ERROR_LAYOUT } from "./ui/BootErrorScreen"
import { PreBootLayer } from "./ui/PreBootLayer"
import { BootSplash } from "./ui/PxeBoot"
import { PreviewDraftRecovery } from "./dev/PreviewDraftRecovery"

export function BootGate({ resolveBoot }: { resolveBoot: () => Promise<WebBootConfig> }) {
  const [boot, setBoot] = React.useState<WebBootConfig>()
  const [error, setError] = React.useState<Error>()
  const [attempt, setAttempt] = React.useState(0)
  const bootAttempt = React.useRef<Promise<WebBootConfig> | undefined>(undefined)

  React.useEffect(() => {
    let live = true
    // StrictMode's repeated effect shares the same configuration attempt.
    void (bootAttempt.current ??= resolveBoot()).then(
      (resolved) => live && setBoot(resolved),
      (e: Error) => live && setError(e),
    )
    return () => {
      live = false
    }
  }, [attempt, resolveBoot])

  const retry = () => {
    bootAttempt.current = undefined
    setError(undefined)
    setAttempt((n) => n + 1)
  }

  if (error) {
    const settingsPath = getDesktopSettingsPath()
    return (
      <div role="alert" style={BOOT_ERROR_LAYOUT}>
        <span className="zkm-type-card-title">zk.money could not load its configuration</span>
        <span
          className="zkm-type-body"
          style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}
        >
          {error.message}
        </span>
        {settingsPath && (
          <span className="zkm-type-body" style={{ color: "var(--text-secondary)" }}>
            If zk.money's services are down, <a href={settingsPath}>Endpoint Settings</a> can point
            the wallet at other services or start it from the configuration it shipped with.
          </span>
        )}
        <PrimaryGradientButton title="Retry" onClick={retry} />
        {import.meta.env.VITE_CONFIG_EDITOR === "true" && <PreviewDraftRecovery />}
      </div>
    )
  }
  if (!boot) {
    return <BootSplash />
  }
  // Google's OAuth popup only relays a token to its opener, the active tab, so it skips the gate,
  // which would stop it at the other-tab screen. It still waits for the configuration: the relay
  // writes to the partition of the rollup the configuration names.
  if (location.pathname === GOOGLE_CALLBACK_PATH) return <GoogleCallbackScreen />
  return (
    <>
      <ActiveTabGate boot={boot} />
      <PreBootLayer />
    </>
  )
}

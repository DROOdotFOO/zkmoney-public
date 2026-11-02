import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { showReportableError } from "../errors/errorModal"
import { failureCode, fireEvent } from "../lib/analytics"
import { holdSigningFlow } from "../lib/passkeyTelemetry"

/**
 * History-aware back for ScreenNavBar arrows: pop the browser history when this isn't the first
 * in-app entry, else replace it with the screen's structural parent (deep link / refresh / new tab),
 * so browser back cannot return to the screen just left.
 * react-router's BrowserRouter stamps `idx` (entry depth) into history.state.
 */
export function useBack(fallback: string): () => void {
  const navigate = useNavigate()
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }, [navigate, fallback])
}

/**
 * Where to land once entry finishes, carried as router state by whoever sent the visitor to /enter
 * or /claim. Absent for a direct visit, which lands on the wallet home.
 */
export function useNextRoute(): string | undefined {
  const { state } = useLocation()
  return (state as { next?: string } | null)?.next
}

/**
 * Busy state around a screen action; failures open the reportable error modal and reach analytics.
 * `busy` follows the latest run: an earlier run that settles while a newer one is still going
 * (an attempt aborted and restarted) does not clear it.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  const run = useCallback(
    async (fn: () => Promise<void>, actionName?: string, reportContext?: string) => {
      const mine = ++latest.current
      setBusy(true)
      try {
        await fn()
      } catch (e) {
        // Same context convention as the screens that own their own catch (e.g. "withdraw:submit");
        // reportContext groups several actions under one triage label without renaming them.
        showReportableError(e, reportContext ?? actionName ?? "action")
        if (actionName) fireEvent("action_failed", { action: actionName, code: failureCode(e) })
      } finally {
        if (latest.current === mine) setBusy(false)
      }
    },
    [],
  )

  return { busy, run }
}

/**
 * Put `text` on the clipboard. The async Clipboard API exists only in secure contexts (https or
 * localhost); a dev server reached over plain http by another host has none, so the legacy
 * selection-based copy, which still works inside a click, is the fallback.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/**
 * Track one attempt while this screen owns it. Finish tracking before a background handoff,
 * completion, or failure; cancel only when the flow accepts a user cancellation. These updates
 * are synchronous because navigation can unmount the screen before a state update renders.
 * Leaving an unfinished attempt reports cancellation (in-app) or abandonment (page teardown).
 * Stages include preparation and submission as well as proving.
 */
export function useProvingOutcome(flow: string) {
  const attempt = useRef<{ stage: string } | undefined>(undefined)
  // Lets go of the flow this attempt's passkey signatures are reported under.
  const releaseFlow = useRef<(() => void) | undefined>(undefined)
  const report = useCallback(
    (event: "proving_cancelled" | "proving_abandoned") => {
      releaseFlow.current?.()
      if (!attempt.current) return
      const { stage } = attempt.current
      attempt.current = undefined
      fireEvent(event, { flow, stage })
    },
    [flow],
  )

  useEffect(() => {
    const onPageHide = () => report("proving_abandoned")
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      report("proving_cancelled")
    }
  }, [report])

  return useMemo(
    () => ({
      start: (stage: string) => {
        attempt.current = { stage }
        releaseFlow.current?.()
        releaseFlow.current = holdSigningFlow(flow)
      },
      updateStage: (stage: string) => {
        if (attempt.current) attempt.current.stage = stage
      },
      finish: () => {
        attempt.current = undefined
        releaseFlow.current?.()
      },
      cancel: () => report("proving_cancelled"),
    }),
    [report, flow],
  )
}

/** Clipboard write with a 2s "Copied!" indicator; the timer dies with the component. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  // A refused clipboard (permission denied, no gesture, insecure context) is ordinary and
  // recoverable: swallow it so it cannot reach the global unhandled-rejection handler and
  // surface as a crash dialog. The unchanged label is the signal nothing was copied.
  const copy = useCallback(async (text: string) => {
    if (!(await writeClipboard(text))) return false
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
    return true
  }, [])

  return { copied, copy }
}

/** Web Share of a link, with clipboard fallback where the API is absent or declines. `text` rides
 * along so the message is a sentence with a link in it rather than a bare URL. */
export function useLinkSharing(url?: string, title = "Payment request", text?: string) {
  const { copied, copy: copyText } = useCopy()

  const copy = useCallback(async () => {
    if (url) await copyText(url)
  }, [copyText, url])

  const share = useCallback(async () => {
    if (!url) return
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, ...(text ? { text } : {}), url })
        return
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return
      }
    }
    await copyText(url)
  }, [copyText, text, title, url])

  return { copied, copy, share }
}

/** Keeps the screen on while `active`. The browser drops the lock when the page hides, so it is taken again on return. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return
    let lock: WakeLockSentinel | undefined
    let done = false
    const take = () => {
      if (document.visibilityState !== "visible") return
      navigator.wakeLock.request("screen").then(
        (l) => (done ? void l.release().catch(() => {}) : (lock = l)),
        () => {},
      )
    }
    take()
    document.addEventListener("visibilitychange", take)
    return () => {
      done = true
      document.removeEventListener("visibilitychange", take)
      void lock?.release().catch(() => {})
    }
  }, [active])
}

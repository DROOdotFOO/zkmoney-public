/**
 * What a background tab costs the screen's own loops. A poll nobody reads while the tab is hidden
 * still bills the node, so a screen's loop takes an interval scheduler that stops while hidden.
 * Showing the page runs a catch-up tick at once, so what a returning user reads is current.
 */

/** The interval surface front-core services and the wallet's own loops take. */
export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

interface Entry {
  callback: () => void
  ms: number
  handle: ReturnType<typeof setInterval> | null
}

const entries = new Set<Entry>()
let listening = false

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden"

function reschedule(entry: Entry): void {
  if (entry.handle !== null) {
    clearInterval(entry.handle)
    entry.handle = null
  }
  if (isHidden()) return
  entry.handle = setInterval(entry.callback, entry.ms)
}

function onVisibilityChange(): void {
  const showing = !isHidden()
  for (const entry of entries) {
    if (showing) entry.callback()
    reschedule(entry)
  }
}

function listen(): void {
  if (listening || typeof document === "undefined") return
  document.addEventListener("visibilitychange", onVisibilityChange)
  listening = true
}

/**
 * Stops while the page is hidden. For work whose only consumer is the screen — a clock behind a
 * label, a check whose result is a notification the user reads on return.
 */
export const pauseWhenHidden: IntervalScheduler = {
  setInterval(callback, ms) {
    listen()
    const entry: Entry = { callback, ms, handle: null }
    entries.add(entry)
    reschedule(entry)
    return entry
  },
  clearInterval(handle) {
    const entry = handle as Entry | null
    if (!entry || !entries.delete(entry)) return
    if (entry.handle !== null) clearInterval(entry.handle)
    entry.handle = null
  },
}

/**
 * For a loop that owns its own start/stop rather than an interval — a service told to run, a
 * watcher that re-reads on return. Both handlers see the current state immediately, so a caller
 * does not also have to ask.
 */
export function whenVisibilityChanges(handlers: {
  onShow?: () => void
  onHide?: () => void
}): () => void {
  const fire = () => (isHidden() ? handlers.onHide?.() : handlers.onShow?.())
  fire()
  if (typeof document === "undefined") return () => {}
  document.addEventListener("visibilitychange", fire)
  return () => document.removeEventListener("visibilitychange", fire)
}

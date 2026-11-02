// Process-wide record of the paylink refunds this page is running, keyed by the paylink `secret`.
// It guards against a double refund, and tells the activity views a refund is under way before its
// hash reaches the create row. It dies with the page, as the refund's local operation does.

/** Running refunds per secret: an overlapping one keeps the link in flight until both end. */
const inFlight = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

export function isRefundInFlight(secret: string): boolean {
  return inFlight.has(secret)
}

export function markRefundInFlight(secret: string): void {
  const count = inFlight.get(secret) ?? 0
  inFlight.set(secret, count + 1)
  if (count === 0) changed()
}

export function clearRefundInFlight(secret: string): void {
  const count = inFlight.get(secret)
  if (count === undefined) return
  if (count > 1) return void inFlight.set(secret, count - 1)
  inFlight.delete(secret)
  changed()
}

/** Holds the refund of `secret` in flight for as long as `run` runs. */
export async function withRefundInFlight<T>(secret: string, run: () => Promise<T>): Promise<T> {
  markRefundInFlight(secret)
  try {
    return await run()
  } finally {
    clearRefundInFlight(secret)
  }
}

let snapshot: { version: number; secrets: ReadonlySet<string> } | undefined

/** The secrets whose refund runs now; the same set until one starts or ends. */
export function refundsInFlight(): ReadonlySet<string> {
  if (snapshot?.version !== version) snapshot = { version, secrets: new Set(inFlight.keys()) }
  return snapshot.secrets
}

/** Bumps on every change; a `useSyncExternalStore` snapshot. */
export function refundInFlightVersion(): number {
  return version
}

export function onRefundInFlightChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

import { allowanceBlocksSponsoredAction, type AllowanceSnapshot } from "@obsidion/front-core"

/** A refill period as a plain duration: "24 hours", "7 days". */
export function formatPeriod(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  if (seconds % 86_400 === 0 && seconds > 86_400) return unit(seconds / 86_400, "day")
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, "hour")
  if (seconds % 60 === 0) return unit(seconds / 60, "minute")
  return unit(seconds, "second")
}

/**
 * Why a sponsored action cannot be sent, when the allowance proves it; undefined otherwise. Only a
 * stored zero on a rail that never renews proves it. A zero that may renew, a failed read, or a read
 * being replaced blocks nothing: the chain decides.
 */
export function sponsoredActionBlock(snapshot: AllowanceSnapshot): string | undefined {
  if (
    snapshot.status !== "ready" ||
    snapshot.refreshing ||
    !allowanceBlocksSponsoredAction(snapshot.state)
  )
    return undefined
  return "No sponsored transactions left. This allowance does not renew."
}

/** The Settings row's value: "42 left", or what stands in for a count. */
export function allowanceRowValue(snapshot: AllowanceSnapshot): string {
  if (snapshot.status === "unavailable") return "Unavailable"
  if (snapshot.status !== "ready") return "Checking…"
  const { state } = snapshot
  switch (state.kind) {
    case "not-subscribed":
      return "Not started"
    case "available":
      return `${state.available} left`
    case "renewal-unknown":
      return "Unknown"
    case "does-not-renew":
      return "0 left"
  }
}

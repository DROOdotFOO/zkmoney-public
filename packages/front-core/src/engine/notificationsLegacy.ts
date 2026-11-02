import type { NotificationEvent, NotificationState, UpgradeStop } from "./notifications"

/** The legacy bell: one JSON object of entries keyed by id, English text included. */
export const APP_NOTIFICATION_STORAGE_KEY = "@obsidion/app-notifications/records"

interface LegacyEntry {
  id: string
  title?: string
  description?: string
  timestampMs: number
  read?: boolean
  readAt?: number
  dismissedAt?: number
  target?: { type?: string; txHash?: string; contactId?: string }
}

/** The fixed sentences older builds stored, which name what an id alone does not. */
const REORG_INCOMING = "This payment to you was reverted by the network and did not complete"
const REORG_OUTGOING = "Your transaction was reverted by the network and did not complete"
const RESUMED = "Withdrawal resumed"
const CONFIRMED = "Payment confirmed"
const STOPS: Record<string, UpgradeStop> = {
  "We couldn't check your old funds. Open it to try again.": "failed",
  "Your upgrade needs another approval. Open it to continue.": "needsApproval",
  "Your upgrade stopped. Open it to see why and continue.": "needsAttention",
  "Your upgrade is paused. Open it to continue.": "paused",
}

function entries(raw: string | undefined): LegacyEntry[] {
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return []
    return Object.values(parsed as Record<string, LegacyEntry>).filter(
      (e) => typeof e?.id === "string" && typeof e.timestampMs === "number",
    )
  } catch {
    return []
  }
}

export function legacyNotificationState(raw: string | undefined): [string, NotificationState][] {
  return entries(raw).map((e) => {
    const readAt = e.read || e.dismissedAt !== undefined ? e.readAt ?? e.timestampMs : undefined
    const row: NotificationState = { id: e.id, firstSeenAt: e.timestampMs }
    if (readAt !== undefined) row.readAt = readAt
    if (e.dismissedAt !== undefined) row.dismissedAt = e.dismissedAt
    return [e.id, row]
  })
}

/** The entries whose facts no record holds. One whose data cannot be rebuilt keeps its state only. */
export function legacyNotificationEvents(raw: string | undefined): [string, NotificationEvent][] {
  return entries(raw).flatMap((e): [string, NotificationEvent][] => {
    const event = eventOf(e)
    return event ? [[e.id, event]] : []
  })
}

function eventOf(e: LegacyEntry): NotificationEvent | undefined {
  const [kind, sub, key] = e.id.split(":")
  const at = e.timestampMs
  const id = e.id
  const txHash = e.target?.txHash ?? key
  if (kind === "reorg" && sub === "failed") {
    const incoming = e.description === REORG_INCOMING
    if (!incoming && e.description !== REORG_OUTGOING) return undefined
    return { id, at, kind: "reorg", data: { outcome: "failed", txHash, incoming } }
  }
  if (kind === "reorg" && sub === "reconfirmed") {
    if (e.title !== RESUMED && e.title !== CONFIRMED) return undefined
    return {
      id,
      at,
      kind: "reorg",
      data: { outcome: "reconfirmed", txHash, withdrawal: e.title === RESUMED },
    }
  }
  if (kind === "contact" && sub === "added" && key && e.target?.contactId) {
    const contactId = e.target.contactId
    const tag = contactId.toLowerCase() === key ? undefined : contactId
    return { id, at, kind: "contactAdded", data: { address: key, contactId, ...(tag && { tag }) } }
  }
  if (kind === "paylink" && sub === "claim-reversed" && key) {
    return { id, at, kind: "claimReversed", data: { txHash } }
  }
  if (kind === "paylink" && sub === "reclaimable" && key) {
    return { id, at, kind: "reclaimable", data: { txHash } }
  }
  if (id === "migration:run") {
    const stop = STOPS[e.description ?? ""]
    return stop ? { id, at, kind: "migrationRun", data: { stop } } : undefined
  }
  return undefined
}

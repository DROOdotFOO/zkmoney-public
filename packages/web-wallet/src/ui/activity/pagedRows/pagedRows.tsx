import { useEffect, useRef } from "react"
import type { ActivityPages, FeedItem, Transaction } from "@obsidion/front-core"

/** Calls `onReach` whenever the end of the list scrolls into view. */
export function PageEnd({ onReach }: { onReach: () => void }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = end.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) onReach()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onReach])
  return <div ref={end} aria-hidden style={{ height: 1 }} />
}

/** The items a paged feed lists: while older rows are unread, older items wait for them. */
export function pagedItems<T extends Pick<FeedItem, "ts">>(
  items: readonly T[],
  page: ReturnType<ActivityPages["rows"]["get"]>,
): readonly T[] {
  if (page.complete) return items
  const oldest = Math.min(...page.records.map((row: Transaction) => row.timestamp))
  return items.filter((item) => item.ts >= oldest)
}

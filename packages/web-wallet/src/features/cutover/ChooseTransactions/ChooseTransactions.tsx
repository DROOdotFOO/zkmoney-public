/** The transactions sheet over the wallet's activity feed. */
import { useMemo } from "react"
import {
  activityPages,
  formatDateLabel,
  useStore,
  type ActivityPages,
  type FeedItem,
} from "@obsidion/front-core"
import { useSession } from "../../../platform/session"
import {
  ActivityDetailHost,
  useActivityHost,
} from "../../../ui/activity/ActivityDetailHost/ActivityDetailHost"
import { PageEnd, pagedItems } from "../../../ui/activity/pagedRows/pagedRows"
import { mergedRows } from "../../../ui/activity/feedSources"
import { ActivityRow } from "../../../ui/activity/ActivityRow/ActivityRow"
import { TransactionsSheet, type TransactionGroup } from "../TransactionsSheet"

/** Newest-first items under their day label. */
export function groupByDay(items: readonly FeedItem[]): TransactionGroup[] {
  const groups = new Map<string, FeedItem[]>()
  for (const item of items) {
    const label = formatDateLabel(item.ts)
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups].map(([label, rows]) => ({
    label,
    rows: rows.map((item) => <ActivityRow key={item.id} item={item} />),
  }))
}

export function ChooseTransactions({ onClose }: { onClose: () => void }) {
  const { activity, reads } = useSession()
  const pages = useMemo(() => activityPages(activity), [activity])
  // A paid link's row dates it, wherever the row sits.
  const rows = useMemo(() => mergedRows([pages.rows, reads.paying]), [pages, reads])
  return (
    <ActivityDetailHost rows={rows}>
      <Transactions pages={pages} onClose={onClose} />
    </ActivityDetailHost>
  )
}

function Transactions({ pages, onClose }: { pages: ActivityPages; onClose: () => void }) {
  const { feed } = useActivityHost()
  const page = useStore(pages.rows)
  return (
    <TransactionsSheet
      groups={groupByDay(pagedItems(feed.items, page))}
      hydrated={feed.hydrated}
      end={page.complete ? undefined : <PageEnd key={page.records.length} onReach={pages.more} />}
      onClose={onClose}
    />
  )
}

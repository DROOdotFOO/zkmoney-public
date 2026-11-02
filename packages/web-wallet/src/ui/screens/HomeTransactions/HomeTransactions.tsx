import { Fragment, useState, type ReactNode } from "react"
import { ActivityListSkeleton } from "../../Skeletons"
import copy from "./HomeTransactions.copy"
import styles from "./HomeTransactions.module.css"

const TABS = ["transactions", "pending"] as const

/** The wallet card's recent-activity widget: two tabs over a feed, three newest rows. */
export function HomeTransactions<T extends { id: string; pending: boolean }>({
  items,
  hydrated,
  row,
  onViewAll,
}: {
  items: readonly T[]
  hydrated: boolean
  row: (item: T) => ReactNode
  onViewAll: () => void
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("transactions")
  const visible = (tab === "pending" ? items.filter((i) => i.pending) : items).slice(0, 3)

  return (
    <div className="ww-home-txns">
      <div className={styles.homeTxnsBar}>
        <div className={styles.homeTxnsTabs}>
          {TABS.map((t) => (
            <button
              aria-pressed={tab === t}
              key={t}
              type="button"
              className="zkm-btn-reset"
              data-active={tab === t || undefined}
              onClick={() => setTab(t)}
            >
              {copy.tabs[t]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`zkm-btn-reset ${styles.homeTxnsViewall}`}
          onClick={onViewAll}
        >
          {copy.viewAll}
        </button>
      </div>
      <div className={styles.homeTxnsRows}>
        {!hydrated && <ActivityListSkeleton rows={3} />}
        {hydrated && visible.map((item) => <Fragment key={item.id}>{row(item)}</Fragment>)}
        {hydrated && visible.length === 0 && (
          <span className={styles.homeTxnsEmpty}>
            {tab === "pending" ? copy.emptyPending : copy.empty}
          </span>
        )}
      </div>
    </div>
  )
}

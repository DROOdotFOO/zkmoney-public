/**
 * The Choose page's transactions sheet (Figma 489:38896): everything on the balance before the
 * upgrade, as the wallet's own activity rows grouped by day. Presentational: the groups come in.
 */
import type { ReactNode } from "react"
import { ActivityListSkeleton } from "../../ui/Skeletons"
import { transactionsCopy as copy } from "./cutoverCopy"
import { Badge, CutoverSheet, Lead, SheetTitle } from "./parts"

export interface TransactionGroup {
  /** "Today", "Yesterday", or the date. */
  label: string
  rows: ReactNode[]
}

export function TransactionsSheet({
  groups,
  hydrated,
  end,
  onClose,
  children,
}: {
  groups: TransactionGroup[]
  hydrated: boolean
  /** Shown after the last group: what reads the next page. */
  end?: ReactNode
  onClose: () => void
  /** The rows' detail sheets, which open over this one. */
  children?: ReactNode
}) {
  return (
    <>
      <CutoverSheet
        label={copy.title}
        className="ww-cutover-sheet--transactions"
        testId="cutover-transactions"
        onClose={onClose}
      >
        <Badge icon="history-clock" />
        <SheetTitle>{copy.title}</SheetTitle>
        <Lead>{copy.body}</Lead>
        <div className="ww-cutover__txns">
          {!hydrated && <ActivityListSkeleton rows={4} />}
          {hydrated && groups.length === 0 && (
            <span className="ww-cutover__txns-empty">{copy.empty}</span>
          )}
          {hydrated &&
            groups.map((group) => (
              <div key={group.label} className="ww-cutover__txns-day">
                <span>{group.label}</span>
                <div className="ww-cutover__txns-rows">{group.rows}</div>
              </div>
            ))}
          {hydrated && end}
        </div>
      </CutoverSheet>
      {children}
    </>
  )
}

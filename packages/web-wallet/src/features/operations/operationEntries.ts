/**
 * An ended operation as the notifications panel lists it, read straight off the record: nothing is
 * written for it, so the list follows the store and the active scope with nothing to reconcile.
 */
import type { OperationRecord } from "@obsidion/front-core"
import { sponsorshipErrorCopy } from "../allowance/sponsorshipError"
import { flowCopy } from "./operationCopy"

const PREFIX = "operation:"

/** The operation an entry stands for; undefined for any other entry. */
export function operationIdOf(entryId: string): string | undefined {
  return entryId.startsWith(PREFIX) ? entryId.slice(PREFIX.length) : undefined
}

/** The context each flow's screen reports its failures under, which the allowance copy keys on. */
const REPORT_CONTEXT: Partial<Record<string, string>> = {
  "send": "contact:send",
  "withdraw": "withdraw:submit",
  "paylink-create": "paylink:create",
  "deposit": "deposit:resolve",
  "request-link": "request-link:create",
}

function failureText(record: OperationRecord, copy: ReturnType<typeof flowCopy>): string {
  if (record.error !== undefined) {
    const named = copy.describeError?.(record.error)
    if (named) return named
    const refused = sponsorshipErrorCopy(record.error, REPORT_CONTEXT[record.flow] ?? record.flow)
    if (refused) return `${record.summary}. ${refused.message}`
  }
  return `${record.summary}. ${(record.cause && copy.causes[record.cause]) || copy.thrown}`
}

/**
 * Whether the panel lists the operation's ending: not while it runs, not for a flow whose own
 * record's rows report it, and not where there is nothing to say.
 */
export function listsEnding(record: OperationRecord): boolean {
  const copy = flowCopy(record.flow)
  if (record.endedAt === undefined || copy.outcome === "record") return false
  // A cause the flow declares as `null` is not news: the next load takes it up again.
  if (record.state === "failed" && record.cause && copy.causes[record.cause] === null) return false
  return record.state !== "settled" || !!copy.settled
}

/** The ended operation's words. */
export function operationText(record: OperationRecord): { title: string; description: string } {
  const copy = flowCopy(record.flow)
  return record.state === "settled"
    ? { title: copy.settled ?? "", description: record.summary }
    : { title: copy.failed, description: failureText(record, copy) }
}

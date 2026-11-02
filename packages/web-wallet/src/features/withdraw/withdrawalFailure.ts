import type { WithdrawalRecord } from "@obsidion/front-core"
import copy from "./withdrawalFailure.copy"

/** What a failed withdrawal says about its failure; a code without words of its own reads failed. */
export function withdrawalFailureText(
  record: Pick<WithdrawalRecord, "failure" | "source">,
): string | undefined {
  const code = record.failure?.code
  if (code === undefined) return undefined
  if (code === "withdrawal.dropped" && record.source === "paylink")
    return copy["withdrawal.droppedLink"]
  return code in copy ? copy[code as keyof typeof copy] : copy["withdrawal.failed"]
}

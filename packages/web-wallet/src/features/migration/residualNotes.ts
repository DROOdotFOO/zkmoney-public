/** What a retired version still holds, in a few words each: for the bell and "Also there". */
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { ResidualItem } from "@obsidion/front-core"
import { usd } from "../../ui/format"

// Dust under a cent still counts: never show it as nothing.
export function money(amount: bigint): string {
  const n = Number(formatUnits(amount, DEFAULT_DECIMALS))
  return n > 0 && n < 0.005 ? "<$0.01" : usd(n)
}

export const lockedUntil = (until: number) => new Date(until * 1000).toLocaleDateString()

export function itemNote(item: ResidualItem): string {
  const sum = item.amount === undefined ? undefined : money(item.amount)
  switch (item.kind) {
    case "balance":
      return item.stranded === "small" ? `${sum} too small to move` : `${sum} on a frozen version`
    case "other":
      return `${sum} on another old version`
    case "awaiting":
    case "awaitingFeature": {
      const held = [sum, item.deposits ? `${item.deposits} unclaimed deposit(s)` : undefined]
      const once =
        item.kind === "awaiting" ? "once that version freezes" : "once the new version is ready"
      return `${held.filter(Boolean).join(" and ")} on the old version. You can upgrade ${
        item.deposits ? "them" : "it"
      } ${once}.`
    }
    case "unclaimed":
      return sum ? `${sum} in unclaimed deposits` : `${item.count} unclaimed deposit(s)`
    case "transit":
      return sum ? `${sum} in transit` : `${item.count} deposit(s) in transit`
    case "waiting":
      return sum
        ? `${sum} waiting on the old network`
        : `${item.count} deposit(s) waiting on the old network`
    case "link":
      return sum ? `${sum} in open paylink(s)` : `${item.count} open paylink(s)`
    case "unverified":
      return `${item.count} Savings move(s) this device can't verify`
    case "locked":
      return `${sum ? `${sum} in` : item.count} paylink(s) locked until ${lockedUntil(item.until)}`
  }
}

/**
 * Funds an old version still holds that no balance here shows: a Savings move that version closed
 * before it finished, and a payment link nobody claimed there.
 */
import { PaylinkActionEnum } from "@obsidion/core/constants"
import {
  isOtherRollupLink,
  isStrandedSavingsMove,
  paylinkStatusIsUnspent,
  type FeedItem,
  type PaylinkTransaction,
  type SavingsItem,
} from "@obsidion/front-core"
import { savingsMoveDestination, savingsMoveFigure } from "../savings/SavingsMoveRow"
import type { SavingsAccount } from "../savings/AccountSwitcher"

export interface OldVersionLeftovers {
  /** What stranded Savings moves left there, in 18-decimal USD. */
  savings: bigint
  /** Whether some of those moves reached their destination's old portal, where Withdraw can refund them. */
  deposited: Record<SavingsAccount, boolean>
  /** What unclaimed payment links hold there, in 18-decimal USD. */
  links: bigint
  linkCount: number
}

const CENT = 10n ** 16n

/** `moves`: every Savings move with its burn; `items`: the feed's; `network`: the wallet's. */
export function oldVersionLeftovers(o: {
  moves: readonly Pick<SavingsItem, "move" | "burn">[]
  items: readonly FeedItem[]
  sharePrice?: bigint
  network: string | undefined
}): OldVersionLeftovers {
  let savings = 0n
  const deposited = { main: false, savings: false }
  for (const { move, burn } of o.moves) {
    if (!isStrandedSavingsMove(move, burn)) continue
    // What the destination holds, not what left the source with its fees.
    const destination = savingsMoveDestination(move)
    savings +=
      savingsMoveFigure(move, destination, o.sharePrice, burn) ??
      savingsMoveFigure(move, "main", o.sharePrice, burn) ??
      0n
    deposited[destination] ||= !!move.deposit
  }
  const { network } = o
  const links = o.items.flatMap((item) =>
    item.kind === "tx" &&
    item.tx.status === "success" &&
    item.tx.action === PaylinkActionEnum.PAY &&
    !!item.paylinkStatus &&
    paylinkStatusIsUnspent(item.paylinkStatus) &&
    isOtherRollupLink(item.tx as PaylinkTransaction, network)
      ? [item.tx as PaylinkTransaction]
      : [],
  )
  const linkUsd = links.reduce((sum, row) => {
    const token = row.token
    return sum + BigInt(Math.round((token?.amount ?? 0) * (token?.price || 1) * 100)) * CENT
  }, 0n)
  return { savings, deposited, links: linkUsd, linkCount: links.length }
}

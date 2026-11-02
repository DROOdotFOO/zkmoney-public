import type { ChunkFit } from "@obsidion/front-core"

/** Where the user goes to clear a condition. */
export type EntryAction = "sponsorship" | "activity" | "migration"

/** What the entry checks, in the order the first unmet one is shown. */
export interface EntryConditions {
  /** The session's credential is the account's first passkey. */
  sessionIsRoot: boolean
  verified: boolean
  routeLive: boolean
  /** The account holds the sponsored-transaction subscription. */
  registered: boolean
  withdrawalInFlight: boolean
  /** A paylink the account made still holds escrow only the account can take back. */
  openLink: boolean
  historicBalance: boolean
  balance: bigint
  fundingAmount: bigint
  chunk: ChunkFit
  /** A move plan exists over the live balances. */
  plan: boolean
  /** Sponsored uses left for the whole flow. */
  usesLeft: boolean
}

export type EntryBlock = { line: string; action?: EntryAction }

/** The first unmet condition, or undefined when the entry is ready to press. */
export function entryBlock(
  c: EntryConditions,
  amount: (atomic: bigint) => string,
): EntryBlock | undefined {
  if (!c.sessionIsRoot) return { line: "Use your first passkey to add a backup" }
  if (!c.verified) return { line: "This account is not registered yet" }
  if (!c.routeLive) return { line: "Not available on this network yet" }
  if (!c.registered) return { line: "Sponsored transactions are not set up", action: "sponsorship" }
  if (c.withdrawalInFlight) return { line: "Finish your withdrawal first", action: "activity" }
  if (c.openLink)
    return {
      line: "Finish your open paylinks first. Once a backup is added, links you made before can't be cancelled or reclaimed.",
      action: "activity",
    }
  if (c.historicBalance) return { line: "Finish your migration first", action: "migration" }
  if (c.balance < c.fundingAmount)
    return { line: `You need at least ${amount(c.fundingAmount)} to add a backup` }
  if (c.chunk.kind === "short")
    return {
      line: `Your balance is in too many small pieces to fund this. Send yourself ${amount(
        c.chunk.chunk,
      )} first.`,
    }
  if (!c.plan) return { line: "Part of your balance is still syncing. Try again in a moment." }
  if (!c.usesLeft) return { line: "Not enough sponsored transactions left this period" }
  return undefined
}

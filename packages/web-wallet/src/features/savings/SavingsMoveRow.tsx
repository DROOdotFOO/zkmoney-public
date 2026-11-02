import { ActivityListRow, type StatusLabel } from "@obsidion/web-ds"
import {
  isStrandedSavingsMove,
  savingsMoveBasis,
  savingsMoveLabel,
  savingsValue,
  type SavingsMoveEta,
  type SavingsMoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { rowTimestamp, shortL1Addr, usdAtomicFloor } from "../../ui/format"
import type { SavingsAccount } from "./AccountSwitcher"
import { savingsEtaCopy } from "./savingsMoveTiming"

const LABEL: Record<SavingsAccount, Record<SavingsMoveRecord["direction"], string>> = {
  main: { in: "To Savings", out: "From Savings" },
  savings: { in: "From Main Account", out: "To Main Account" },
}

/** The account a move's deposit lands in. */
export const savingsMoveDestination = (move: SavingsMoveRecord): SavingsAccount =>
  move.direction === "in" ? "savings" : "main"

/**
 * One state from submit until the destination claims the deposit, like a deposit's row; nothing
 * once claimed. A move whose escrow's DAI was recovered ends there.
 */
export function savingsMoveStatus(
  move: SavingsMoveRecord,
  burn?: WithdrawalRecord,
): StatusLabel | undefined {
  if (burn?.phase === "failed") return "Failed"
  if (move.recovered) return "Recovered"
  if (move.deposit?.claimed) return undefined
  if (isStrandedSavingsMove(move, burn)) return "Needs recovery"
  return savingsMoveLabel(move.direction)
}

/** Where a recovered move's funds went, for its row and its sheet. */
export const recoveredTo = (move: SavingsMoveRecord): string | undefined =>
  move.recovered && `Recovered to ${shortL1Addr(move.recovered.to)}`

/**
 * The dollars a row shows for a move, as `perspective` sees it. A credit into Savings is what the
 * move put in, fixed from its record; sUSDS shares are priced at the vault's share price, never
 * shown as a count, and a figure with no price or record yet is unknown.
 */
export function savingsMoveFigure(
  move: SavingsMoveRecord,
  perspective: SavingsAccount,
  sharePrice?: bigint,
  burn?: WithdrawalRecord,
): bigint | undefined {
  const into = move.direction === "in"
  const credit = into === (perspective === "savings")
  const priced = (shares: string) =>
    sharePrice === undefined ? undefined : savingsValue(BigInt(shares), sharePrice)
  const quoted = (figure?: string) => (figure === undefined ? undefined : BigInt(figure))
  if (into && credit) {
    return (
      savingsMoveBasis(move, burn) ??
      (move.deposit ? priced(move.deposit.amount) : BigInt(move.amount))
    )
  }
  if (credit && move.deposit) return BigInt(move.deposit.amount)
  // A move out's debit: the USDS the vault paid for its shares, once read.
  if (!into && move.vault) return BigInt(move.vault.assets)
  const fallback = into ? BigInt(move.amount) : priced(move.amount)
  return quoted(credit ? move.net : move.value) ?? fallback
}

/**
 * One move as the account `perspective` sees it: a credit on the side the funds land. The time is
 * when the user moved (a rebuilt move's burn time from chain), the same on every device.
 */
export function SavingsMoveRow({
  move,
  burn,
  perspective,
  sharePrice,
  eta,
  onOpen,
}: {
  move: SavingsMoveRecord
  /** The burn's record, for its leg and a failure. */
  burn?: WithdrawalRecord
  perspective: SavingsAccount
  /** The vault's share price, once the position has been read. */
  sharePrice?: bigint
  /** How long the move still takes, while it is in flight. */
  eta?: SavingsMoveEta
  onOpen: () => void
}) {
  const credit = (move.direction === "in") === (perspective === "savings")
  const figure = savingsMoveFigure(move, perspective, sharePrice, burn)
  const status = savingsMoveStatus(move, burn)
  // While the move is in flight the pill names the route, so the subline carries the time left.
  const note =
    recoveredTo(move) ??
    (eta && status === savingsMoveLabel(move.direction) ? savingsEtaCopy(eta) : undefined)
  const route = move.direction === "in" ? "Main Account → Savings" : "Savings → Main Account"
  return (
    <ActivityListRow
      counterparty={LABEL[perspective][move.direction]}
      timestamp={`${note ?? route} · ${rowTimestamp(move.startTime)}`}
      amount={figure === undefined ? "—" : `${credit ? "+" : "-"}${usdAtomicFloor(figure)}`}
      statusLabel={status}
      avatarIcon="earn"
      className="ww-savings-move-row"
      onClick={onOpen}
      ariaLabel="Open move details"
    />
  )
}

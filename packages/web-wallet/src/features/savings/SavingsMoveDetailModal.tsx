import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  claimCheckCopy,
  REORGED_ERROR,
  savingsMoveLabel,
  shortHex,
  type SavingsDirection,
  type SavingsMoveEta,
  type SavingsMoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, type StatusBadgeStyle } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { l2TxUrl } from "../../lib/explorer"
import { l1AddressUrl, l1TxUrl, whenLabel } from "../../ui/detailRows"
import { rowTimestamp, tokenAmount, usdAtomic, usdAtomicFloor } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { DepositFact } from "../../ui/screens/DepositFact"
import { DepositHashFact } from "../../ui/screens/DepositHashFact"
import { DepositStatusValue } from "../../ui/screens/DepositStatusValue"
import { TabLine } from "../operations/TabLine"
import { useWithdrawableSources } from "../migration/oldVersionWithdraw"
import {
  recoveredTo,
  savingsMoveDestination,
  savingsMoveFigure,
  savingsMoveStatus,
} from "./SavingsMoveRow"
import { savingsEtaCopy } from "./savingsMoveTiming"
import { withdrawalFailureText } from "../withdraw/withdrawalFailure"

/** The sheet's status: the row's one state, or the done state once the deposit is claimed. */
function moveStatus(
  move: SavingsMoveRecord,
  burn?: WithdrawalRecord,
): { label: string; badge: StatusBadgeStyle } {
  const status = savingsMoveStatus(move, burn)
  if (status === "Failed") return { label: "Failed", badge: "failed" }
  if (status === "Recovered") return { label: "Recovered", badge: "cancelled" }
  if (status === "Needs recovery") return { label: "Didn't finish", badge: "failed" }
  if (status === undefined) return { label: "Credited", badge: "awaitingClaim" }
  return { label: savingsMoveLabel(move.direction), badge: "pending" }
}

/** The burn's error names the active-tab takeover: another tab became the wallet before the send. */
/**
 * Why a failed burn failed, for the sheet's status: a reorg that took it back or a burn that never
 * got sent (no L2 hash), both leaving the funds in `direction`'s source, else
 * the error's first line, or a plain drop by the network when it recorded none.
 */
function burnFailureReason(
  burn: WithdrawalRecord,
  direction: SavingsDirection,
): string | undefined {
  if (burn.phase !== "failed") return undefined
  const kept = `Funds still in ${direction === "in" ? "Main Account" : "Savings"}.`
  if (burn.droppedBurn) return `${REORGED_ERROR} ${kept}`
  const code = burn.failure?.code
  const dropped =
    burn.burnDroppedAt !== undefined ||
    code === "withdrawal.dropped" ||
    code === "withdrawal.reorged"
  if (!dropped && !burn.l2TxHash) {
    const why =
      code === "withdrawal.inactiveTab"
        ? "Another zk.money tab took over before this move was sent."
        : "Transaction not sent."
    return `${why} ${kept}`
  }
  const failure = withdrawalFailureText(burn)
  if (failure) return shortHex(failure)
  return dropped ? "Dropped by the network." : undefined
}

/** A move between Main and Savings: its legs, figures and status, with its burn and escrow as links. */
export function SavingsMoveDetailModal({
  move,
  burn,
  sharePrice,
  eta,
  onCheckAgain,
  exit,
  onWithdraw,
  onClose,
}: {
  move: SavingsMoveRecord
  /** The burn's withdrawal record, for its leg and its transactions. */
  burn?: WithdrawalRecord
  /** The vault's share price; prices the shares a move into Savings lands. */
  sharePrice?: bigint
  /** How long the move still takes, while it is in flight. */
  eta?: SavingsMoveEta
  onCheckAgain?: () => void
  /** The withdrawal sheet's exit for a burn the relayer has not released: finalize it by hand. */
  exit?: { title: string; onStart: () => void }
  /** Opens Withdraw, for a move an old version closed before it finished. */
  onWithdraw?: () => void
  onClose: () => void
}) {
  const config = getConfig()
  const into = move.direction === "in"
  const from = into ? "Main Account" : "Savings"
  const to = into ? "Savings" : "Main Account"
  const status = moveStatus(move, burn)
  const value = move.value ? usdAtomicFloor(BigInt(move.value)) : undefined
  const net = move.net ? usdAtomicFloor(BigInt(move.net)) : undefined
  const fee = move.value && move.net ? usdAtomic(BigInt(move.value) - BigInt(move.net)) : undefined
  // What the source gave up, in dollars: the quote's value, else the shares at the vault's price.
  const moved = savingsMoveFigure(move, into ? "main" : "savings", sharePrice, burn)
  // What the destination got, in dollars, once the deposit is found: what the row credits.
  const landed = move.deposit
    ? savingsMoveFigure(move, into ? "savings" : "main", sharePrice, burn)
    : undefined
  const received = landed === undefined ? undefined : usdAtomicFloor(landed)
  const shares =
    into && move.deposit
      ? `${tokenAmount(formatUnits(BigInt(move.deposit.amount), DEFAULT_DECIMALS))} sUSDS`
      : undefined
  const escrowUrl = l1AddressUrl(move.escrow)
  // Once the burn is out, what remains is the settle pass: its last check and a way to run it now.
  const crediting = status.badge === "pending" && burn?.phase === "done"
  const stranded = savingsMoveStatus(move, burn) === "Needs recovery"
  // Withdraw refunds a deposit on an old portal this version reads, not an escrow that never ran.
  const destinationWithdrawable = useWithdrawableSources().some(
    (source) => source.savings === (savingsMoveDestination(move) === "savings"),
  )
  const withdrawable = !!onWithdraw && !!move.deposit && destinationWithdrawable
  return (
    <Modal
      variant="create"
      label="Move details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="earn" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {moved === undefined ? "—" : usdAtomicFloor(moved)}
        </GradientText>
        <small>
          {from} → {to} · {whenLabel(move.startTime)}
        </small>
      </div>

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue
            {...status}
            reason={
              burn && status.badge === "failed"
                ? burnFailureReason(burn, move.direction)
                : undefined
            }
          />
        </DepositFact>
        {eta && status.badge === "pending" && (
          <DepositFact label="Time">
            <b>{savingsEtaCopy(eta)}</b>
          </DepositFact>
        )}
        {move.deposit?.claimed && move.endTime !== undefined && (
          <DepositFact label="Completed">
            <b>{whenLabel(move.endTime)}</b>
          </DepositFact>
        )}
        <DepositFact label="From">
          <b>{from}</b>
        </DepositFact>
        <DepositFact label="To">
          <b>{to}</b>
        </DepositFact>
        {value && (
          <DepositFact label="Amount moved">
            <b>{value}</b>
          </DepositFact>
        )}
        {fee && (
          <DepositFact label="L1 fee">
            <b>-{fee}</b>
          </DepositFact>
        )}
        <hr className="ww-divider" />
        <DepositFact label={move.deposit?.claimed ? `${to} received` : `${to} receives`}>
          <b>{received ?? (net ? `≈ ${net}` : "--")}</b>
        </DepositFact>
        {shares && (
          <DepositFact label="Shares">
            <b>{shares}</b>
          </DepositFact>
        )}
        {burn?.l2TxHash && (
          <DepositHashFact
            label="Aztec tx"
            hash={burn.l2TxHash}
            url={l2TxUrl(config.network, config.nodeUrl, burn.l2TxHash)}
          />
        )}
        {burn?.finalizeTxHash && (
          <DepositHashFact
            label="Release tx"
            hash={burn.finalizeTxHash}
            url={l1TxUrl(burn.finalizeTxHash)}
          />
        )}
        <DepositHashFact label="Escrow" hash={move.escrow} url={escrowUrl} />
        {move.recovered?.txHashes[0] && (
          <DepositHashFact
            label="Recovery tx"
            hash={move.recovered.txHashes[0]}
            url={l1TxUrl(move.recovered.txHashes[0])}
          />
        )}
      </div>
      {move.recovered && <p className="ww-sheet__note">{recoveredTo(move)}.</p>}
      {stranded && (
        <p className="ww-sheet__note ww-sheet__note--check">
          The old version closed before this move finished, so it can&apos;t finish here. The funds
          stay on the old version.{" "}
          {withdrawable
            ? "Withdraw sends them to an Ethereum address."
            : "This version can't return them yet."}
        </p>
      )}

      {crediting && move.lastCheck && (
        <p className="ww-sheet__note ww-sheet__note--check">
          Last check {rowTimestamp(move.lastCheck.at)}: {claimCheckCopy(move.lastCheck.message)}
        </p>
      )}
      <TabLine operationId={burn?.operationId} />
      {crediting && onCheckAgain && (
        <PrimaryGradientButton title="Check again" onClick={onCheckAgain} />
      )}
      {exit && <PrimaryGradientButton title={exit.title} onClick={exit.onStart} />}
      {stranded && withdrawable && <PrimaryGradientButton title="Withdraw" onClick={onWithdraw} />}
    </Modal>
  )
}

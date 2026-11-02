/**
 * Withdrawal detail — the L2→L1 counterpart of the deposit detail sheet: hero amount over a facts
 * card whose Status row names the leg the tracker is on and flips to Paid when the L1 release
 * lands. The sheet stays open on the live store row, so the status updates as phases advance.
 *
 * The re-check and the exit it offers are the row's own, handed back so one owner drives the chain
 * watcher and the exit handoff.
 */
import {
  swapWithdrawalAmounts,
  WITHDRAWAL_PHASE_COPY,
  withdrawalAmounts,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { formatUnits } from "viem"
import { GradientText, Icon, PrimaryGradientButton, type StatusBadgeStyle } from "@obsidion/web-ds"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { getConfig } from "../../config/env"
import { migrationAmounts } from "@obsidion/front-core"
import { TabLine } from "../../features/operations/TabLine"
import { waitingNote } from "../../features/withdraw/waitingNote"
import {
  WITHDRAWAL_RECEIVE_ASSETS,
  withdrawalNetworkLabel,
  withdrawalReceiveAsset,
} from "../../features/withdraw/withdrawAssets"
import { l2TxUrl } from "../../lib/explorer"
import { l1AddressUrl, l1TxUrl, whenLabel } from "../detailRows"
import { tokenAmount, usdFigure } from "../format"
import { L1AddressLabel } from "../L1AddressLabel"
import { Modal } from "../Modal"
import { DepositFact } from "./DepositFact"
import { DepositHashFact } from "./DepositHashFact"
import { DepositStatusValue } from "./DepositStatusValue"

const PHASE_BADGE: Record<WithdrawalRecord["phase"], StatusBadgeStyle> = {
  submitting: "pending",
  l2_mined: "pending",
  awaiting_proven: "pending",
  finalizing_l1: "pending",
  swapping: "pending",
  recoverable: "failed",
  recovered: "cancelled",
  done: "awaitingClaim",
  failed: "failed",
}

export function withdrawalStatus(
  record: Pick<
    WithdrawalRecord,
    "phase" | "l2TxHash" | "finalizeTxHash" | "swapExecuteTxHash" | "recoveryTxHash"
  >,
): {
  label: string
  badge: StatusBadgeStyle
} {
  const status = {
    label: WITHDRAWAL_PHASE_COPY[record.phase].status,
    badge: PHASE_BADGE[record.phase],
  }
  if (record.phase === "submitting" && !record.l2TxHash) {
    return { ...status, label: WITHDRAWAL_PHASE_COPY.submitting.proving ?? status.label }
  }
  if (record.phase === "finalizing_l1" && record.finalizeTxHash) {
    return { ...status, label: "Waiting for your finalization" }
  }
  if (record.phase === "swapping" && record.swapExecuteTxHash) {
    return { ...status, label: "Waiting for your swap" }
  }
  if (record.phase === "recoverable" && record.recoveryTxHash) {
    return { ...status, label: "Waiting for your recovery", badge: "pending" }
  }
  return status
}

/** Detail-sheet hero: the burn in dollars, the unit the balance and the Sent/Fee rows are in. */
export function withdrawalHeroAmount(record: Pick<WithdrawalRecord, "amount">): string {
  return `-${usdFigure(record.amount)}`
}

export function WithdrawalDetailModal({
  record,
  amount,
  onCheckAgain,
  exit,
  notice,
  onClose,
}: {
  /** Full text of the notification that opened this detail. */
  notice?: string
  record: WithdrawalRecord
  /** Headline figure, as the feed row shows it. */
  amount: string
  /** The re-check the row offers, if any. */
  onCheckAgain?: () => void
  /** The exit the row offers, if any: finalize manually, run the swap yourself, or recover. */
  exit?: { title: string; onStart: () => void }
  onClose: () => void
}) {
  const config = getConfig()
  const note = waitingNote(record)
  const amounts = withdrawalAmounts(record)
  const swap = swapWithdrawalAmounts(record)
  const swapOption = record.swapOutput ? withdrawalReceiveAsset(record.swapOutput) : undefined
  const tokenOption =
    swapOption ?? WITHDRAWAL_RECEIVE_ASSETS.find((o) => o.symbol === record.tokenSymbol)
  // A failed exit released nothing, and a recovered one swapped nothing, so neither names a fee or
  // an output figure.
  const unpaid = record.phase === "failed" || record.phase === "recovered"
  // A migration's recipient is the new balance, which also pays the arrival's fee.
  const migration = record.intent === "migration" ? migrationAmounts(record) : undefined
  // A registration's or a backup passkey's burn has no recipient to receive a net: the address it
  // pays is swept for the name or the key, so the sheet states what was sent and leaves the
  // withdrawal arithmetic out.
  const showBreakdown =
    !swap &&
    record.intent !== "migration" &&
    record.intent !== "registration" &&
    record.intent !== "backup" &&
    amounts.feeKnown &&
    amounts.netAtomic > 0n &&
    !unpaid
  const showMigration = migration && migration.netAtomic > 0n && !unpaid
  const showSwapFee = swap && swap.feeKnown && swap.swapInputAtomic > 0n && !unpaid
  const estimate = !unpaid ? swap?.estimate : undefined
  // The burn less the gas share, which the escrow swaps to ETH apart from the route.
  const routeGross = swap
    ? formatUnits(swap.grossAtomic - (swap.gas?.daiAtomic ?? 0n), record.tokenDecimals)
    : "0"
  const recipientUrl = l1AddressUrl(record.recipient)
  // A registration's or a backup passkey's burn pays this wallet's own deposit address, not a recipient.
  const registration = record.intent === "registration"
  const backup = record.intent === "backup"
  const recipientAlias = registration
    ? "Registration address"
    : backup
    ? "Backup passkey deposit address"
    : record.recipientAlias

  return (
    <Modal
      variant="create"
      label={
        registration
          ? "Registration details"
          : backup
          ? "Backup passkey funding"
          : record.source === "paylink"
          ? "Paylink withdrawal details"
          : "Withdrawal details"
      }
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="tray-withdraw" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {amount}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...withdrawalStatus(record)} />
        </DepositFact>
        <DepositFact label="To">
          {/* A migration pays this wallet's own arrival address, which means nothing to a user. */}
          {record.intent === "migration" ? (
            <b>{record.recipientAlias}</b>
          ) : (
            <b>
              {recipientAlias && `${recipientAlias} · `}
              {recipientUrl ? (
                <a href={recipientUrl} target="_blank" rel="noreferrer">
                  <L1AddressLabel address={record.recipient} />
                </a>
              ) : (
                <L1AddressLabel address={record.recipient} />
              )}
            </b>
          )}
        </DepositFact>
        {record.l2TxHash ? (
          <DepositHashFact
            label="Tx hash"
            hash={record.l2TxHash}
            url={l2TxUrl(config.network, config.nodeUrl, record.l2TxHash)}
          />
        ) : (
          <DepositFact label="Tx hash">
            <b>--</b>
          </DepositFact>
        )}
        {record.source === "paylink" && (
          <DepositFact label="From">
            <b>Payment link</b>
          </DepositFact>
        )}
        <DepositFact label="Token">
          <b>
            {tokenOption && <img src={tokenOption.icon} alt="" width={16} height={16} />}
            {tokenOption?.symbol ?? record.tokenSymbol}
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <img src={ethIcon} alt="" width={16} height={16} />
            {withdrawalNetworkLabel(record.swapOutput)}
          </b>
        </DepositFact>
        <DepositFact label="Sent">
          <b>{estimate ? tokenAmount(estimate.outDisplay) : usdFigure(amounts.grossDisplay)}</b>
        </DepositFact>
        {estimate && (
          <DepositFact label="Exchange rate">
            <b>$1 = {tokenAmount(String(estimate.rate))}</b>
          </DepositFact>
        )}
        {swap?.gas && !unpaid && (
          <DepositFact label="Arrives as gas">
            <b>
              {usdFigure(swap.gas.daiDisplay)}
              {swap.gas.ethOutDisplay && ` ≈ ${tokenAmount(swap.gas.ethOutDisplay)} ETH`}
            </b>
          </DepositFact>
        )}
        {showBreakdown && (
          <DepositFact label="Fee">
            <b>-{usdFigure(amounts.feeDisplay)}</b>
          </DepositFact>
        )}
        {showMigration && (
          <>
            <DepositFact label="Old version fee">
              <b>-{usdFigure(migration.exitFeeDisplay)}</b>
            </DepositFact>
            <DepositFact label="New version fee">
              <b>-{usdFigure(migration.arrivalFeeDisplay)}</b>
            </DepositFact>
          </>
        )}
        {showSwapFee && (
          <DepositFact label="Fee">
            <b>-{usdFigure(swap.feeDisplay)}</b>
          </DepositFact>
        )}
        {record.l1TxHash && (
          <DepositHashFact label="L1 tx" hash={record.l1TxHash} url={l1TxUrl(record.l1TxHash)} />
        )}
        {record.finalizeTxHash && (
          <DepositHashFact
            label="Finalization tx"
            hash={record.finalizeTxHash}
            url={l1TxUrl(record.finalizeTxHash)}
          />
        )}
        {record.swapExecuteTxHash && (
          <DepositHashFact
            label="Swap tx"
            hash={record.swapExecuteTxHash}
            url={l1TxUrl(record.swapExecuteTxHash)}
          />
        )}
        {record.recoveryTarget && (
          <DepositFact label="Recovered to">
            <b>
              <L1AddressLabel address={record.recoveryTarget} />
            </b>
          </DepositFact>
        )}
        {record.recoveryTxHash && (
          <DepositHashFact
            label="Recovery tx"
            hash={record.recoveryTxHash}
            url={l1TxUrl(record.recoveryTxHash)}
          />
        )}
        {showBreakdown && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="Recipient receives">
              <b>
                {tokenAmount(amounts.netDisplay)} {record.tokenSymbol}
              </b>
            </DepositFact>
          </>
        )}
        {showMigration && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="You'll receive">
              <b>~{usdFigure(migration.netDisplay)}</b>
            </DepositFact>
          </>
        )}
        {estimate && swapOption && (
          <>
            <hr className="ww-divider" />
            {/* What the route got of the burn at the quote rate — the fee gap to the row above is the fee
                in output units. */}
            <DepositFact label="Sent">
              <b>
                {usdFigure(routeGross)} = {tokenAmount(String(Number(routeGross) * estimate.rate))}{" "}
                {swapOption.symbol}
              </b>
            </DepositFact>
          </>
        )}
      </div>

      {note && <p className="ww-sheet__note">{note}</p>}
      <TabLine operationId={record.operationId} />
      {onCheckAgain && (
        <PrimaryGradientButton
          title="Check again"
          buttonStyle={exit ? "dark" : undefined}
          onClick={onCheckAgain}
        />
      )}
      {exit && <PrimaryGradientButton title={exit.title} onClick={exit.onStart} />}
    </Modal>
  )
}

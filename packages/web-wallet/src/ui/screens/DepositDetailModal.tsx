/**
 * Deposit detail — the SIPA-deposit counterpart of the activity TxDetail modal: source wallet over
 * a facts card (amounts, deposit address, and every on-chain leg). The exit it offers is the row's
 * own, handed back so the exit sheet keeps one owner. A registration deposit additionally names the
 * identity it claimed (`registrationTag`).
 */
import {
  depositAmounts,
  depositPhaseCopy,
  isNativeEth,
  neverCreditsL2,
  type SIPADepositPhase,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, type StatusBadgeStyle } from "@obsidion/web-ds"
import walletLineIcon from "../../assets/deposit/wallet-line.svg"
import ethIcon from "../../assets/deposit/ethereum.webp"
import {
  settlementDecimals,
  settlementSymbol as settledSymbol,
  settlementToken,
  useDepositTokens,
} from "../../features/deposit/loadDepositFacts"
import { getConfig } from "../../config/env"
import { Modal } from "../Modal"
import { unsweepableCopy } from "../../features/deposit/unsweepableCopy"
import { DepositProcessingNotice } from "../../features/deposit/DepositProcessingNotice"
import { useSipaProcessing } from "../../features/deposit/sipaProcessing"
import { PendingLimitsLink } from "../../features/limits/AboutLimitsSheet"
import { l2TxUrl } from "../../lib/explorer"
import { l1AddressUrl, l1TxUrl, whenLabel } from "../detailRows"
import { tokenFigure, usdFigure } from "../format"
import { L1AddressLabel } from "../L1AddressLabel"
import { depositAttribution, depositGrossFigure, depositHeadline } from "./activityView"
import { DepositFact } from "./DepositFact"
import { DepositHashFact } from "./DepositHashFact"
import { DepositStatusValue } from "./DepositStatusValue"
import { useRowTxAmountCap } from "../../features/token/useTxAmountCap"

/** The sheet's badge per phase; the word is front-core's `DEPOSIT_PHASE_COPY`. */
const PHASE_BADGE: Record<SIPADepositPhase, StatusBadgeStyle> = {
  resolved: "pending",
  funding: "pending",
  funded: "pending",
  broadcast: "pending",
  sweeping: "pending",
  pendingClaim: "pending",
  claimed: "awaitingClaim",
  recovered: "cancelled",
  recoverable: "failed",
  failed: "failed",
}

export function depositStatus(record: SIPADepositRecord): {
  label: string
  badge: StatusBadgeStyle
} {
  return { label: depositPhaseCopy(record).status, badge: PHASE_BADGE[record.phase] }
}

export function DepositDetailModal({
  record,
  registrationTag,
  exit,
  notice,
  onBack,
  onClose,
}: {
  /** Full text of the notification that opened this detail. */
  notice?: string
  record: SIPADepositRecord
  /** Set when this SIPA registered a name: the detail names the registration identity. */
  registrationTag?: string
  /** The exit the row offers, if any. A sweep is an escape hatch, so it is not the gradient button. */
  exit?: { title: string; onStart: () => void; sweep?: boolean }
  /** Returns to the sheet that opened this one, such as an upgrade's. */
  onBack?: () => void
  onClose: () => void
}) {
  const config = getConfig()
  const depositTokens = useDepositTokens()
  const txAmountCap = useRowTxAmountCap(settlementToken(depositTokens, record.tokenAddress))
  const rowDecimals = settlementDecimals(depositTokens, record.tokenAddress)
  const amounts = depositAmounts(record, rowDecimals)
  // A deposit that never credits L2 was charged no fee and receives nothing.
  const showBreakdown = !neverCreditsL2(record.phase) && amounts.feeKnown && amounts.netAtomic > 0n
  const status = depositStatus(record)
  const { fundingTxHash } = depositAttribution(record)
  const { title, address } = depositHeadline(record)
  const sentFigure =
    amounts.grossAtomic > 0n ? depositGrossFigure(record, "full", rowDecimals) : "--"
  // The sheet leads with what lands on L2; the gross the wallet was charged is the Sent row. A
  // deposit that never credits L2 has no net anyone is owed, so it leads with that gross instead.
  const headline =
    !neverCreditsL2(record.phase) && amounts.netAtomic > 0n
      ? usdFigure(amounts.netDisplay)
      : sentFigure
  const funderUrl = address ? l1AddressUrl(address) : undefined
  const sipaUrl = l1AddressUrl(record.sipaAddress)
  // What the funder sent; a swept record's `tokenSymbol` is the credited token.
  const fundingSymbol = record.fundingTokenSymbol ?? record.tokenSymbol
  const tokenIcon = depositTokens?.options.find((t) => t.symbol === fundingSymbol)?.icon
  const { shown: processing, capacityKey } = useSipaProcessing(record.sipaAddress)
  const settlementSymbol = settledSymbol(depositTokens, record.tokenAddress, record.tokenSymbol)

  return (
    <Modal
      variant="create"
      label={registrationTag ? "Registration deposit details" : "Deposit details"}
      className="ww-sheet ww-sheet--detail"
      onBack={onBack}
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <img src={walletLineIcon} alt="" width={32} height={29} />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          {headline}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>

      {notice && <p className="ww-txd__notice">{notice}</p>}
      {processing && (
        <DepositProcessingNotice
          sipaAddress={record.sipaAddress}
          state={processing}
          symbol={settlementSymbol}
          help={(detail) => (
            <PendingLimitsLink
              sipaAddress={record.sipaAddress}
              capacityKey={capacityKey}
              settlementSymbol={settlementSymbol}
              detail={detail}
            />
          )}
        />
      )}

      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...status} />
        </DepositFact>
        {registrationTag && (
          <DepositFact label="Name">
            <b>{registrationTag}.zk.money</b>
          </DepositFact>
        )}
        {/* A direct migration deposit has no funder: the upgrade made it. */}
        {!record.direct && (
          <DepositFact label="From">
            <b>
              {title}
              {title && address && " · "}
              {address &&
                (funderUrl ? (
                  <a href={funderUrl} target="_blank" rel="noreferrer">
                    <L1AddressLabel address={address} />
                  </a>
                ) : (
                  <L1AddressLabel address={address} />
                ))}
              {!title && !address && "--"}
            </b>
          </DepositFact>
        )}
        {fundingTxHash ? (
          <DepositHashFact label="Tx hash" hash={fundingTxHash} url={l1TxUrl(fundingTxHash)} />
        ) : (
          <DepositFact label="Tx hash">
            <b>--</b>
          </DepositFact>
        )}
        <DepositFact label="Token">
          <b>
            {tokenIcon && <img src={tokenIcon} alt="" width={16} height={16} />}
            {fundingSymbol}
          </b>
        </DepositFact>
        <DepositFact label="Network">
          <b>
            <img src={ethIcon} alt="" width={16} height={16} />
            {isNativeEth(record.tokenAddress) ? "Ethereum" : "Ethereum (ERC20)"}
          </b>
        </DepositFact>
        <DepositFact label="Sent">
          <b>{sentFigure}</b>
        </DepositFact>
        {showBreakdown && (
          <DepositFact label="Fee">
            <b data-testid="deposit-detail-fee">
              {tokenFigure(amounts.feeDisplay, settlementSymbol)}
            </b>
          </DepositFact>
        )}
        {/* A direct migration deposit has no deposit address: its key holds nothing on L1. */}
        {!record.direct && (
          <DepositHashFact label="Deposit address" hash={record.sipaAddress} url={sipaUrl} />
        )}
        {record.sweepTxHash && !record.direct && (
          <DepositHashFact
            label="Sweep tx"
            hash={record.sweepTxHash}
            url={l1TxUrl(record.sweepTxHash)}
          />
        )}
        {record.recoveryTxHash && (
          <DepositHashFact
            label="Recovery tx"
            hash={record.recoveryTxHash}
            url={l1TxUrl(record.recoveryTxHash)}
          />
        )}
        {record.claimTxHash && (
          <DepositHashFact
            label="Claim tx"
            hash={record.claimTxHash}
            url={l2TxUrl(config.network, config.nodeUrl, record.claimTxHash)}
          />
        )}
        {showBreakdown && (
          <>
            <hr className="ww-divider" />
            <DepositFact label="Received">
              <b data-testid="deposit-detail-received">
                {tokenFigure(amounts.netDisplay, settlementSymbol)}
              </b>
            </DepositFact>
          </>
        )}
      </div>

      {record.phase === "recoverable" && (
        <p className="ww-sheet__note">{unsweepableCopy(record, txAmountCap, rowDecimals)}</p>
      )}
      {exit && (
        <PrimaryGradientButton
          title={exit.title}
          buttonStyle={exit.sweep ? "dark" : undefined}
          onClick={exit.onStart}
        />
      )}
    </Modal>
  )
}

/** The tag a registration deposit paid for, apart from the deposit that carried the payment. */
export function TagPurchaseModal({
  record,
  tag,
  price,
  onClose,
}: {
  record: SIPADepositRecord
  tag: string
  /** Display units. */
  price: string
  onClose: () => void
}) {
  return (
    <Modal
      variant="create"
      label="Tag purchase details"
      className="ww-sheet ww-sheet--detail"
      onClose={onClose}
    >
      <span className="ww-deposit__connect-icon ww-sheet__icon">
        <Icon name="at" size={32} color="#fff" />
      </span>
      <div className="ww-sheet__title">
        <GradientText size={32} weight={700}>
          -{usdFigure(price)}
        </GradientText>
        <small>{whenLabel(record.endTime ?? record.startTime)}</small>
      </div>
      <div className="ww-sheet__facts">
        <DepositFact label="Status">
          <DepositStatusValue {...depositStatus(record)} />
        </DepositFact>
        <DepositFact label="Name">
          <b>{tag}.zk.money</b>
        </DepositFact>
        <DepositHashFact
          label="Paid from deposit"
          hash={record.sipaAddress}
          url={l1AddressUrl(record.sipaAddress)}
        />
      </div>
    </Modal>
  )
}

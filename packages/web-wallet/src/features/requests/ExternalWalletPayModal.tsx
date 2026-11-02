import { Modal } from "../../ui/Modal"
/**
 * The external-wallet leg of an accountless request payment: what to send, where to send it, and
 * the L1 connect entry. The payer never touches a zk.money account, so this leg is public on
 * Ethereum and the chain is the only feedback channel.
 *
 * The address and its EIP-681 URI arrive pre-resolved from the landing. Only the manifest token is
 * offered: the quoted fee and the URI's amount are both in its units, so any other token would need
 * its own fee read and URI.
 */
import { useEffect, useState } from "react"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { formatUnits, type Address } from "viem"
import {
  addressShareDecision,
  depositTokenValuation,
  fixedAmountLimits,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  type AddressRoute,
  type RequestInlinePacket,
  type RequiredCredit,
} from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { usdBalance, shortL1Addr, tokenFigure } from "../../ui/format"
import { useCopy } from "../../ui/hooks"
import { DepositFromWalletModal } from "../deposit/DepositFromWalletModal"
import { DepositQrSheet } from "../deposit/DepositQrSheet"
import { useL1Wallet } from "../deposit/l1Wallet"
import {
  settlementToken,
  useDepositTokens,
  type DepositTokenOption,
} from "../deposit/loadDepositFacts"
import testIcon from "../../assets/deposit/ethereum.webp"
import {
  OneTimeAddressPoints,
  oneTimeAddressPoints,
  OneTimeAddressWarning,
} from "../deposit/OneTimeAddressWarning"
import { AddressLimits, AddressLimitsDetail, tokenAmountLabel } from "../deposit/AddressLimits"
import { AddressCapacityPanel, capacityShareWarning } from "../deposit/AddressCapacity"
import { ADDRESS_RECHECK_NOTE } from "../limits/limitsCopy"
import { WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"
import { sourceFromTarget } from "../limits/capacitySources"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import {
  capacityHold,
  targetEligibility,
  useTargetCapacity,
  type CapacityTarget,
} from "../deposit/targetCapacity"
import { fundingCapacityView } from "../deposit/fundingCapacity"
import { formatPublicLimit } from "../limits/publicLimit"
import type { AccountlessResolveResult } from "./accountlessRequest"
import { requestAmountDisplay } from "./requestLink"
import { clearPayment, holdPayment, paymentHeld } from "./unresolvedPayment"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { useRowTxAmountCap } from "../token/useTxAmountCap"

/** Why a fixed request cannot be paid. It never suggests more transfers to the same address. */
const OVER_LIMIT_COPY = {
  public: `Over the ${formatPublicLimit()} limit. Ask the requester for a new request with a smaller amount.`,
  protocol:
    "Over the network's maximum per deposit. Ask the requester for a new request with a smaller amount.",
  // The capacity line says why; this says what it holds.
  capacity: "Copy and scan are paused until this payment fits current capacity.",
  ceiling: "Ask the requester for a new request with a smaller amount.",
}

export function ExternalWalletPayModal({
  packet,
  result,
  onClose,
  onFeeChanged,
  onPaid,
}: {
  packet: RequestInlinePacket
  result: AccountlessResolveResult
  onClose: () => void
  /** The deposit fee moved under a send; the caller quotes again. */
  onFeeChanged: () => void
  /** The payment confirmed on Ethereum. */
  onPaid?: () => void
}) {
  const depositTokens = useDepositTokens()
  // The request names the token it is paid in: the cap and bucket of the row that token settles on apply.
  const rowToken = settlementToken(depositTokens, result.token) ?? result.token
  const txAmountCap = useRowTxAmountCap(rowToken)
  const config = getConfig()
  const { copied, copy } = useCopy()
  const [qr, setQr] = useState(false)
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  // Copy or Show QR waiting on the capacity warning.
  const [warning, setWarning] = useState<"copy" | "qr">()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  const canFund = bridgeMode || !!l1.account
  const [fundOpen, setFundOpen] = useState(false)
  // A pay click made while disconnected, waiting on the wallet the picker is asking for.
  const [payOnConnect, setPayOnConnect] = useState(false)
  const [sent, setSent] = useState(false)
  const payee = result.sipaAddress as Address
  // A payment from this browser that nothing here can show settled: paying again could pay twice.
  const [unresolved, setUnresolved] = useState(() => paymentHeld(config.network, payee))
  const [infoOpen, setInfoOpen] = useState(false)

  const listed = depositTokens?.offered.find(
    (t) => !t.swapped && t.address.toLowerCase() === result.token.toLowerCase(),
  )
  const token: DepositTokenOption = listed ?? {
    address: result.token,
    symbol: packet.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
    decimals: result.decimals,
    icon: testIcon,
    settlesIn: result.token,
    swapped: false,
  }
  // The token's own decimals; the resolve refuses a link that declares others.
  const decimals = result.decimals
  const amountDisplay = requestAmountDisplay(packet)
  const fee = formatUnits(result.feeAtomic, decimals)
  // A fixed-amount request is paid gross, and the sheet shows that total as the amount.
  const total = packet.amountAtomic > 0n ? formatUnits(result.grossAtomic, decimals) : undefined
  // The link pins the payee's address, so the "changes every time" point is a deposit-screen fact.
  const points = oneTimeAddressPoints(token.symbol).filter((p) => p.id !== "rotates")
  const route: AddressRoute =
    packet.amountAtomic > 0n
      ? {
          kind: "fixed-request",
          decimals,
          requestedAtomic: packet.amountAtomic,
          feeAtomic: result.feeAtomic,
          txAmountCap,
        }
      : { kind: "open-request", decimals, feeAtomic: result.feeAtomic, txAmountCap }
  const valuation = depositTokenValuation({
    accepted: depositTokens?.offered.map((t) => t.address) ?? [],
    token: result.token,
  })
  const fixed = packet.amountAtomic > 0n
  const maxSend = maximumSendAtomic(route, valuation)
  const expired = result.deployment === "expired"
  const target: CapacityTarget =
    result.deployment === "active" ? { kind: "active", token: rowToken } : { kind: "unproven" }
  const capacity = useTargetCapacity(target)
  const required: RequiredCredit =
    fixed && capacity.store
      ? {
          status: "known",
          atomic: packet.amountAtomic,
          token: capacity.store.key.token,
          decimals,
        }
      : { status: "unknown" }
  const eligibility = targetEligibility(capacity, required)
  const capacityView = fundingCapacityView({
    eligibility,
    mode: fixed ? "fixed" : "address",
    symbol: token.symbol,
    sentSymbol: token.symbol,
    exactCredit: true,
  })
  const share = addressShareDecision(eligibility, fixed)
  const capacityWarning = capacityShareWarning(share)
  const fitsNow =
    !fixed && eligibility.kind === "amount-unknown" && !eligibility.zero
      ? maximumSendForCapacity(route, eligibility.snapshot.availableAtomic, valuation)
      : undefined
  const fitsLabel =
    fitsNow !== undefined && maxSend !== undefined && fitsNow < maxSend
      ? tokenAmountLabel(fitsNow, decimals, token.symbol)
      : undefined
  const capacityDetail = fitsLabel && `To fit current capacity, send at most ${fitsLabel}.`
  // The address stays on screen, but nothing offers to pay an amount the limits or known capacity
  // refuse. The amount is never changed to fit.
  const over = fixedAmountLimits(route, valuation)?.over ?? capacityHold(eligibility)
  const limits = (
    <>
      <AddressLimits onInfo={() => setAboutLimits("limit")} />
      <AddressCapacityPanel
        view={capacityView}
        onRetry={capacity.retry}
        detail={capacityDetail}
        onAboutLimits={() => setAboutLimits("capacity")}
      />
    </>
  )
  const limitsDetails = {
    limit: (
      <AddressLimitsDetail
        symbol={token.symbol}
        decimals={decimals}
        maxSendAtomic={maxSend}
        maxCreditAtomic={maximumCreditAtomic(route, valuation)}
      />
    ),
    capacity: <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>,
  }
  // Every share is checked when it happens: a reading can change while a sheet or warning is open.
  const copyAddress = () => {
    if (over) return
    if (capacityWarning) setWarning("copy")
    else void copy(result.sipaAddress)
  }
  const showQr = () => {
    if (over) return
    if (capacityWarning) setWarning("qr")
    else setQr(true)
  }
  const payWithWallet = () => {
    if (over) return
    if (canFund) return setFundOpen(true)
    setPayOnConnect(true)
    void l1.connect()
  }
  // As on the deposit screen: the click that opened the picker pays once a wallet connects.
  useEffect(() => {
    if (!payOnConnect) return
    if (canFund) {
      setPayOnConnect(false)
      if (!over) setFundOpen(true)
    } else if (!l1.pickerOpen) {
      setPayOnConnect(false)
    }
  }, [payOnConnect, canFund, l1.pickerOpen, over])
  // A payment that becomes known not to fit is no longer offered: its QR and warning close.
  useEffect(() => {
    if (!over) return
    setQr(false)
    setWarning(undefined)
  }, [over])

  return (
    <>
      <Modal
        variant="bare"
        label="Pay with an Ethereum wallet"
        className="ww-deposit-warning ww-reqpay"
        onClose={onClose}
      >
        <div className="ww-deposit-warning__close">
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
        </div>
        <GradientText size={24} weight={700} className="ww-reqpay__title">
          Pay with Ethereum
        </GradientText>

        <div className="ww-paylink-summary">
          <span className="ww-paylink-summary__label">Pay @{packet.requesterTag}</span>
          <span className="ww-paylink-summary__amount">
            {total ? usdBalance(total) : amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
          </span>
          {total && (
            <span className="ww-paylink-summary__note" data-testid="request-fee">
              Includes a {tokenFigure(fee, token.symbol)} deposit fee
            </span>
          )}
          {packet.note && <span className="ww-paylink-summary__note">{packet.note}</span>}
        </div>

        {expired ? (
          <p className="ww-limit-reason" role="alert" data-testid="request-expired">
            This link has expired. Ask @{packet.requesterTag} for a new one.
          </p>
        ) : sent ? (
          <p className="ww-deposit__note" role="status" data-testid="request-sent">
            Payment sent. @{packet.requesterTag} receives it once Ethereum confirms it.
          </p>
        ) : unresolved ? (
          <div className="ww-deposit__stealth" data-testid="request-unresolved">
            <p className="ww-limit-reason" role="status">
              A payment to this address may already be on its way. Check your wallet&apos;s activity
              before you pay again.
            </p>
            <PrimaryGradientButton
              title="Pay again"
              buttonStyle="dark"
              onClick={() => {
                clearPayment(config.network, payee)
                setUnresolved(false)
              }}
            />
          </div>
        ) : (
          <div className="ww-deposit__stealth">
            <div className="ww-deposit__fields">
              <div className="ww-deposit__facts">
                <div className="ww-deposit__fact">
                  <span>Token</span>
                  <b>
                    <img src={token.icon} alt="" width={16} height={16} />
                    {token.symbol}
                  </b>
                </div>
                <div className="ww-deposit__fact">
                  <span>Network</span>
                  <b>
                    <img src={ethIcon} alt="" width={16} height={16} />
                    Ethereum (ERC20)
                  </b>
                </div>
                {!total && (
                  <>
                    <hr className="ww-divider" />
                    <div className="ww-deposit__fact">
                      <span>Fee</span>
                      <b>{tokenFigure(fee, token.symbol)}</b>
                    </div>
                  </>
                )}
              </div>
              <div className="ww-deposit__input">
                <span>Pay to</span>
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__addr"
                  disabled={!!over}
                  onClick={copyAddress}
                  title={result.sipaAddress}
                >
                  {shortL1Addr(result.sipaAddress)}
                  <Icon name={copied ? "check" : "copy"} size={16} />
                </button>
              </div>
              {limits}
            </div>

            <div className="ww-deposit__actions">
              <button
                type="button"
                className={`zkm-btn-reset ww-deposit__btn${over ? "" : " zkm-pressable"}`}
                disabled={!!over}
                onClick={showQr}
              >
                Show <Icon name="qr-code" size={24} />
              </button>
              <button
                type="button"
                className={`zkm-btn-reset ww-deposit__btn${over ? "" : " zkm-pressable"}`}
                disabled={!!over}
                onClick={copyAddress}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <PrimaryGradientButton
              title={bridgeMode ? "Pay from your browser" : "Pay with wallet"}
              leadingIcon="wallet"
              isDisabled={!!over}
              onClick={payWithWallet}
              testId="request-pay-with-wallet"
            />

            {over ? (
              <p className="ww-limit-reason" role="alert" data-testid="request-over-limit">
                {OVER_LIMIT_COPY[over]}
              </p>
            ) : !total ? (
              <p className="ww-deposit__note">
                Send more than {tokenFigure(fee, token.symbol)}. That much is kept as the deposit
                fee. Anything at or below it is lost.
              </p>
            ) : (
              result.feeAtomic >= packet.amountAtomic && (
                <p className="ww-deposit__note">The fee exceeds what was requested.</p>
              )
            )}
          </div>
        )}

        {!expired && !sent && !unresolved && (
          <section className="ww-deposit__info">
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__info-head"
              aria-expanded={infoOpen}
              onClick={() => setInfoOpen((o) => !o)}
            >
              Important information
              <Icon name={infoOpen ? "chevron-up" : "chevron-down"} size={16} />
            </button>
            {infoOpen && <OneTimeAddressPoints points={points} />}
          </section>
        )}
      </Modal>

      {fundOpen && canFund && (
        <DepositFromWalletModal
          l1={l1}
          deposit={{ address: payee, name: packet.requesterTag }}
          token={token}
          fee={fee}
          valuation={valuation}
          payee={packet.requesterTag}
          fixedAmount={fixed ? formatUnits(packet.amountAtomic, decimals) : undefined}
          onClose={() => setFundOpen(false)}
          onSent={({ txHash }) => {
            // Kept until the payer chooses to pay again: the transfer may still be pending.
            try {
              holdPayment(config.network, payee, txHash)
            } catch (err) {
              console.warn("[pay] could not keep the sent payment", err)
            }
            setFundOpen(false)
            setSent(true)
          }}
          onSendFailed={() => {
            // A failed receipt read does not prove nothing was sent.
            setSent(false)
            setUnresolved(true)
          }}
          onSendUnresolved={() => {
            setUnresolved(true)
            setFundOpen(false)
          }}
          onApproving={async (submission) => holdPayment(config.network, payee, submission)}
          onNotApproved={(submission) => clearPayment(config.network, payee, submission)}
          onFeeChanged={onFeeChanged}
          onConfirmed={onPaid}
        />
      )}

      {qr && !expired && (
        <DepositQrSheet
          title="Payment address"
          address={result.sipaAddress}
          paymentUri={result.paymentUri}
          copied={copied}
          limits={limits}
          onCopy={copyAddress}
          onClose={() => setQr(false)}
        />
      )}

      {warning && (
        <OneTimeAddressWarning
          capacityWarning={capacityWarning}
          onClose={() => setWarning(undefined)}
          onGotIt={() => {
            setWarning(undefined)
            if (over) return
            if (warning === "qr") setQr(true)
            else void copy(result.sipaAddress)
          }}
        />
      )}
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={limitsDetails}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={token.symbol}
          // The request page sits outside the account context; a visitor may have no account.
          account={false}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )
}

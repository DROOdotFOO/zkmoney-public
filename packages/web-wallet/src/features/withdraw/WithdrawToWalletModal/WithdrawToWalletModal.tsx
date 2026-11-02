import { Modal } from "../../../ui/Modal"
import { useRef, useState } from "react"
import { formatUnits, parseUnits, type Address } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  NOMINAL_USD_VALUATION,
  exceedsBalance,
  upsertSavedL1WalletContact,
  useContractServiceContext,
  useStore,
  withdrawalMaxNet,
  useResource,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { chargedAmount } from "../../deposit/DepositFromWalletModal"
import { showReportableError } from "../../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../../lib/analytics"
import { amountError, decimalInput, fixedCents, parseAmount, usdFigure } from "../../../ui/format"
import { useProvingOutcome } from "../../../ui/hooks"
import { useUserFlowActive } from "../../provingGate"
import { useBusyLabel } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { LocalPasskeyHint } from "../../../ui/LocalPasskeyHint"
import {
  SponsoredActionNotice,
  useSponsoredActionBlock,
} from "../../allowance/SponsoredActionNotice"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { Warning } from "../../../ui/Warning"
import { submitSponsoredWithdrawal, type WithdrawStage } from "../withdrawGateway"
import { getConfig } from "../../../config/env"
import {
  FEE_UNAVAILABLE_COPY,
  settledFloor,
  ExecutorFeeNote,
  SwapFeeNote,
  SwapGasWarning,
  useSwapSimulation,
  WithdrawalEstimate,
} from "../withdrawQuote"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "../withdrawAssets"
import { WithdrawalAssetPicker } from "../WithdrawalAssetPicker"
import { estimateText, WithdrawReview } from "../WithdrawReview"
import { recordBurnDuration } from "../burnTiming"
import {
  BALANCE_TIP_BLOCKED_COPY,
  LIMIT_TIP_BLOCKED_COPY,
  SpeedRow,
  useSpeedChoice,
  useSpeedOutcome,
} from "../speedChoice"
import {
  LimitNotice,
  OperationLimits,
  usdFigureGrouped,
  type LimitProblem,
} from "../../limits/publicLimit"
import { LimitsInfoButton } from "../../limits/AboutLimitsSheet"
import { withdrawalLimitProblem } from "../../limits/withdrawalLimit"
import { useTxAmountCap } from "../../token/useTxAmountCap"
import { useSession } from "../../../platform/session"
import copy from "./WithdrawToWalletModal.copy"
import { fmt } from "../../../lib/fmt"

/**
 * Amount entry → confirmation → sponsored L2 burn to the given L1 recipient. The typed amount is
 * what the recipient should receive; the route's floor is burned on top of it.
 *
 * The passkey ceremony is the last beat needing the user: the modal holds them through the prepare
 * and sign beats, then `OperationHandOff` closes it while the burn carries on under the bell, with
 * no cancel since the burn is away. Cancel is only honoured while
 * the burn is still building; past that the passkey sheet's own dismiss is the way out, and it fails
 * the withdrawal pre-mine. `onDone` fires once per burn: at the hand-off, or when it mines first.
 */
export function WithdrawToWalletModal({
  recipient,
  walletName,
  receiveAsset: initialAsset = "DAI",
  receiveAssets,
  assetNote,
  recipientIsContract,
  onClose,
  onDone,
}: {
  recipient: Address
  /** User label for the destination; saved with the contact on success. */
  walletName?: string
  /** The output the sheet opens on: DAI burns straight to the recipient; anything else routes
   *  through oxide's swap escrow (see `submitSponsoredWithdrawal`). */
  receiveAsset?: WithdrawalReceiveAsset
  /** The outputs the destination accepts; the picker offers nothing else. */
  receiveAssets?: readonly WithdrawalReceiveAsset[]
  /** Why the outputs are narrowed, shown under the amount. */
  assetNote?: string
  /** The ETH route pays with a plain transfer, which a contract can reject. */
  recipientIsContract?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const txAmountCap = useTxAmountCap()
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const tokenService = useResource(useSession().token)
  const balances = useSession().balances
  const { contractService } = useContractServiceContext()
  const wallet = useStore(balances.view)
  const decimals = tokenService?.metadata.decimals ?? DEFAULT_DECIMALS
  const { screener, verdict, cleared, rescreen } = useScreenedAddress(recipient, "withdraw")

  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [stage, setStage] = useState<WithdrawStage>("building")
  const [amount, setAmount] = useState("")
  // MAX sticks: the amount follows the asset and the priced fee until it is edited.
  const [maxed, setMaxed] = useState(false)
  const [receiveAsset, setReceiveAsset] = useState(initialAsset)
  const [failedOnce, setFailedOnce] = useState(false)
  const cancelled = useRef(false)
  const left = useRef(false)

  const outcome = useProvingOutcome("withdraw")

  const leave = () => {
    left.current = true
    outcome.finish()
    onDone()
  }

  const parsed = parseAmount(amount)
  const receiveOption = withdrawalReceiveAsset(receiveAsset)
  // The typed amount is what the recipient should receive and the route's floor rides on top, so
  // the burn is the two together. `charged` is the decimal-safe parse: undefined for anything the
  // burn would reject, which gates the exact-units comparisons below that would otherwise throw.
  const charged = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const sendAtomic = charged !== undefined ? parseUnits(charged, DEFAULT_DECIMALS) : undefined
  // The floor the route charges, as last learned from its own quote. The floor comes from pricing
  // the very burn that carries it, so a change prices the route twice: once to learn the floor,
  // once with it included.
  const [floor, setFloor] = useState(0n)
  const burnAtomic = sendAtomic !== undefined ? sendAtomic + floor : undefined
  // Kept through the working phase, so a failed or cancelled burn comes back to the same choice.
  const speed = useSpeedChoice({
    active: phase !== "amount",
    node: obsidionWallet?.node,
    amount: sendAtomic,
  })
  // A swap simulation nets its own fees off its input, so it is priced on the burn.
  const quote = useSwapSimulation({
    receiveAsset,
    amountAtomic: burnAtomic,
    recipient,
    network: getConfig().network,
    proverTip: speed.pricedTip,
  })
  // A floor learned this render re-prices the burn at once, before anything is committed. The fee
  // shown is the floor the burn carries, which a quote within a cent of it does not move.
  const learned = settledFloor(floor, quote.fee?.floorAtomic)
  if (learned !== floor) setFloor(learned)
  const feeAtomic = quote.fee === undefined ? undefined : learned
  const minimum = parseUnits("1", DEFAULT_DECIMALS)
  // The balance is the deployment's settlement token, which policy values at a stated $1.
  const valuation = NOMINAL_USD_VALUATION
  // A floor not yet priced counts nothing, so only a known excess shows.
  const problem: LimitProblem | undefined =
    burnAtomic !== undefined ? withdrawalLimitProblem(burnAtomic, txAmountCap) : undefined
  // A route that cannot be priced has no fee to charge and no tip to commit to, so it never
  // validates.
  const valid = charged !== undefined && parsed >= 1 && quote.fee !== undefined && !problem
  // The tip the burn commits to is the one on screen: a swap confirms only off a settled simulation.
  const swapCommit =
    !receiveOption.direct && quote.status === "ready" && quote.fee && quote.estimate
      ? { relayerTip: quote.fee.swapRelayerTip, ...quote.estimate }
      : undefined
  const balance = wallet.main?.atomic ?? 0n
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  // Checked apart from `valid`: an amount over both the balance and the limit names the balance.
  const overspent = exceedsBalance(wallet, burnAtomic)
  // The fee rides on top, so MAX leaves room for it and keeps the burn within the limit; a fee not
  // yet priced takes nothing until it lands. The tip is not in MAX: a maxed amount never moves for
  // it, and Faster is refused below when it would not fit.
  const tipInFee = quote.fee?.proverTip ?? 0n
  const max = wallet.main
    ? withdrawalMaxNet({
        spendableAtomic: balance,
        feeAtomic: learned - tipInFee,
        decimals: DEFAULT_DECIMALS,
        valuation,
        txAmountCap,
      })
    : undefined
  const maxAmount =
    max?.status === "available" && max.atomic >= minimum
      ? formatUnits(max.atomic, DEFAULT_DECIMALS)
      : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  const feeFigure =
    feeAtomic === undefined ? "$--" : usdFigure(formatUnits(feeAtomic, DEFAULT_DECIMALS))
  // Under the $1 minimum there is nothing to send, and the sheet says why.
  const short =
    wallet.live &&
    wallet.main &&
    feeAtomic !== undefined &&
    balance - (feeAtomic - tipInFee) < minimum
      ? fmt(copy.short, { fee: feeFigure })
      : undefined
  // The tip rides on top too, so what can fall short is the balance or the limit. Judged on the
  // untipped fee, so the answer holds while a tipped quote loads.
  let tipBlocked: string | undefined
  if (speed.offer && feeAtomic !== undefined && sendAtomic !== undefined) {
    const extra = speed.offer.proverTip - tipInFee
    if (balance - (feeAtomic + extra) < sendAtomic) tipBlocked = BALANCE_TIP_BLOCKED_COPY
    else if (withdrawalLimitProblem(sendAtomic + learned + extra, txAmountCap))
      tipBlocked = LIMIT_TIP_BLOCKED_COPY
  }
  const speedOutcome = useSpeedOutcome(
    speed,
    speed.offer && feeAtomic !== undefined && sendAtomic !== undefined ? !tipBlocked : undefined,
    tipBlocked,
  )
  const { proverTip } = speedOutcome
  // The fee on screen was priced with the tip the burn will carry.
  const confirmable =
    (receiveOption.direct || swapCommit !== undefined) && quote.fee?.proverTip === proverTip
  const ready = !!(obsidionWallet && obsidionAccount && tokenService && contractService)
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  // What the recipient should receive, in the burned asset; a swap route swaps it.
  const sent = charged !== undefined ? usdFigure(charged) : "$--"
  const total =
    burnAtomic !== undefined && feeAtomic !== undefined
      ? usdFigure(formatUnits(burnAtomic, DEFAULT_DECIMALS))
      : "$--"
  const unsponsored = useSponsoredActionBlock(phase === "confirm")

  const run = async () => {
    if (!valid || burnAtomic === undefined) return
    if (failedOnce) fireEvent("retry_clicked", { flow: "withdraw" })
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    fireEvent("withdraw_confirmed")
    const elapsed = lapTimer()
    try {
      // The confirm CTA gates on `ready`, so the four context values are present here.
      const record = await submitSponsoredWithdrawal(
        {
          wallet: obsidionWallet!,
          account: obsidionAccount!,
          tokenService: tokenService!,
          contractService: contractService!,
          screener,
        },
        recipient,
        formatUnits(burnAtomic, DEFAULT_DECIMALS),
        (s) => {
          // Only here. `submitting` lands after the burn has mined, and the gateway answers a
          // cancel by dropping the record — past this point that would erase a real withdrawal.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
        walletName,
        receiveAsset,
        swapCommit,
        proverTip,
      )
      outcome.finish()
      // `submitting`: sent, receipt still pending. Only a mined burn's duration spans confirm → mine
      // (the prove-phase split rides tx_timing, flow "withdraw").
      const mined = record.phase !== "submitting"
      const durationMs = elapsed()
      if (mined) void recordBurnDuration(durationMs)
      fireEvent("withdraw_submitted", {
        duration_ms: mined ? durationMs : undefined,
        amount_bucket: amountBucket(BigInt(record.rawAmount ?? 0), record.tokenDecimals),
      })
      void upsertSavedL1WalletContact({ address: recipient, name: walletName })
      if (!left.current) onDone()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      fireEvent("action_failed", { action: "withdraw:submit", code: failureCode(e) })
      if (left.current) return
      showReportableError(e, "withdraw:submit")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  // No dismissing mid-burn: the record is already seeded and the proof cannot be abandoned safely.
  const dismiss = phase === "working" ? undefined : onClose

  return (
    <Modal
      variant="bare"
      label={copy.title}
      className={phase === "confirm" ? "ww-deposit-warning ww-sheet--detail" : "ww-deposit-warning"}
      onClose={dismiss}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={dismiss} />
          </div>
          {phase === "confirm" && (
            <span className="ww-deposit__connect-icon">
              <Icon name="tray-withdraw" size={24} color="#fff" />
            </span>
          )}
          <GradientText size={24} weight={700}>
            {copy.title}
          </GradientText>
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>{copy.amountToSend}</span>
              <span>
                {copy.available}{" "}
                <b>{usdFigureGrouped(fixedCents(wallet.main && { ...wallet.main, decimals }))}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label={copy.amountToSend}
                  inputMode="decimal"
                  autoFocus
                  data-autofocus
                  placeholder={copy.minimum}
                  value={amount}
                  onChange={(e) => {
                    setMaxed(false)
                    setAmount(decimalInput(e.target.value))
                  }}
                />
                <small>{usdFigureGrouped(String(Number.isFinite(parsed) ? parsed : 0))}</small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  disabled={!maxAmount}
                  onClick={() => setMaxed(true)}
                >
                  {copy.max}
                </button>
                <WithdrawalAssetPicker
                  inline
                  value={receiveAsset}
                  only={receiveAssets}
                  onChange={setReceiveAsset}
                />
              </span>
            </label>
            {assetNote && <span className="ww-fund__label">{assetNote}</span>}
            <OperationLimits
              operation="withdrawal"
              minimum="$1"
              info={
                <LimitsInfoButton
                  topic="limit"
                  label={copy.limitInfo}
                  capacity={{ kind: "active" }}
                />
              }
            />
            {short ? (
              <span className="ww-pay__error">{short}</span>
            ) : problem && !overspent ? (
              <LimitNotice
                operation="withdrawal"
                problem={problem}
                maximum={
                  maxAmount && max?.status === "available" && max.bound !== "protocol-ceiling"
                    ? usdFigureGrouped(maxAmount)
                    : undefined
                }
                onUseMaximum={maxAmount ? () => setMaxed(true) : undefined}
              />
            ) : (
              overspent && <span className="ww-pay__error">{copy.overspent}</span>
            )}
            {amountError(amount) && <span className="ww-pay__error">{amountError(amount)}</span>}
            <div className="ww-deposit__input ww-sheet__fact">
              <span>{copy.fee}</span>
              <b style={{ fontSize: 14 }}>{feeFigure}</b>
            </div>
            <ExecutorFeeNote state={quote} />
            {receiveOption.direct ? (
              quote.status === "unavailable" && <Warning title={FEE_UNAVAILABLE_COPY} />
            ) : (
              <>
                <SwapFeeNote state={quote} />
                <div className="ww-fund__label">
                  <WithdrawalEstimate receiveAsset={receiveAsset} state={quote} />
                </div>
                <SwapGasWarning state={quote} amountAtomic={sendAtomic} />
              </>
            )}
            {recipientIsContract && receiveAsset === "ETH" && (
              <Warning title={copy.contract.title}>{copy.contract.body}</Warning>
            )}
            {!cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy={copy.screening.checking}
                blockedFallback={copy.screening.blocked}
                errorCopy={copy.screening.error}
                onRetry={rescreen}
              />
            )}
          </div>
          <PrimaryGradientButton
            title={copy.review}
            isDisabled={!valid || overspent || !cleared}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            <WithdrawReview
              recipient={recipient}
              walletName={walletName}
              asset={receiveAsset}
              send={
                receiveOption.direct ? sent : `${sent} ≈ ${estimateText(swapCommit, receiveAsset)}`
              }
              fee={feeFigure}
              total={total}
              speed={<SpeedRow choice={speed} outcome={speedOutcome} />}
            />
            {/* Reachable when the balance lands after review — the CTA is dead without this. */}
            {overspent && <span className="ww-pay__error">{copy.overspent}</span>}
          </div>
          <SponsoredActionNotice reason={unsponsored} />
          <LocalPasskeyHint />
          <PrimaryGradientButton
            title={busy ? busyLabel : ready ? copy.confirm : copy.connecting}
            isDisabled={!ready || !valid || overspent || !confirmable || busy || !!unsponsored}
            onClick={run}
            style={{ width: "100%" }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={
            stage === "building"
              ? () => {
                  cancelled.current = true
                }
              : undefined
          }
        />
      )}
    </Modal>
  )
}

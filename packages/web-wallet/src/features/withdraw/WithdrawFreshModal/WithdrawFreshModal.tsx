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
import {
  AmountChipRow,
  GradientText,
  Icon,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { chargedAmount } from "../../deposit/DepositFromWalletModal"
import { showReportableError } from "../../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../../lib/analytics"
import {
  amountError,
  decimalInput,
  fixedCents,
  parseAmount,
  tokenAmount,
  usdFigure,
  shortL1Addr,
} from "../../../ui/format"
import { useProvingOutcome } from "../../../ui/hooks"
import { DepositFact } from "../../../ui/screens/DepositFact"
import { useUserFlowActive } from "../../provingGate"
import { useBusyLabel } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { LocalPasskeyHint } from "../../../ui/LocalPasskeyHint"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { Warning } from "../../../ui/Warning"
import { getConfig } from "../../../config/env"
import {
  FEE_UNAVAILABLE_COPY,
  ExecutorFeeNote,
  SwapFeeNote,
  settledFloor,
  useSwapSimulation,
  type SwapEstimate,
} from "../withdrawQuote"
import { networkHasSwapStack } from "../freshAddressAvailability"
import {
  freshBurnAmount,
  freshDaiForGas,
  submitFreshAddressWithdrawal,
  type FreshQuote,
} from "../freshAddressGateway"
import { AssetPicker } from "../WithdrawalAssetPicker"
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
  WITHDRAWAL_RECEIVE_ASSETS,
  withdrawalReceiveAsset,
  type WithdrawalReceiveAsset,
} from "../withdrawAssets"
import { LimitLine, LimitNotice, usdFigureGrouped } from "../../limits/publicLimit"
import { LimitsInfoButton } from "../../limits/AboutLimitsSheet"
import { withdrawalLimitProblem } from "../../limits/withdrawalLimit"
import { useTxAmountCap } from "../../token/useTxAmountCap"
import { useSession } from "../../../platform/session"
import copy from "./WithdrawFreshModal.copy"
import { fmt } from "../../../lib/fmt"

/** Dollars of the wallet asset that land as ETH, on top of the funds. Each is at most `MAX_DAI_FOR_GAS`. */
export const GAS_CHIPS = [0, 1, 5, 10, 15]
const DEFAULT_GAS = 5

const dollars = (atomic?: bigint) =>
  atomic === undefined ? "$--" : usdFigure(formatUnits(atomic, DEFAULT_DECIMALS))

/**
 * Amount entry → review → one sponsored burn to a fresh L1 address. The burn pays one swap escrow,
 * which lands the funds as the picked asset and swaps the gas share to ETH; on the ETH route the gas
 * share is more ETH, and DAI with no gas share is a direct withdrawal. The burn is the funds and the
 * gas share plus the route's floor, and the floor comes from pricing that very burn, so a change
 * prices the route twice: once to learn the floor, once with it included. The burn, gas share and
 * floor included, is one withdrawal under the per-withdrawal limit.
 *
 * The passkey ceremony is the last beat needing the user: `OperationHandOff` closes the sheet when
 * it ends, and the burn carries on under the bell, which reports its outcome. Cancel is honored only
 * while the burn is still building. A failure or a closed passkey prompt while the sheet is up
 * returns to confirm. `onDone` fires once: at the hand-off, or when the flow ends first.
 */
export function WithdrawFreshModal({
  recipient,
  walletName,
  onClose,
  onDone,
}: {
  recipient: Address
  /** User label for the destination; saved with the contact on success. */
  walletName?: string
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
  const [cancellable, setCancellable] = useState(true)
  const [amount, setAmount] = useState("")
  // MAX sticks: the amount follows the chip, the asset and the priced fee until it is edited.
  const [maxed, setMaxed] = useState(false)
  const [fundsAsset, setFundsAsset] = useState<WithdrawalReceiveAsset>("DAI")
  const [gas, setGas] = useState(DEFAULT_GAS)
  const [failedOnce, setFailedOnce] = useState(false)
  // The floor the route charges, as last learned from its own quote; the burn carries it on top.
  const [floor, setFloor] = useState(0n)
  const cancelled = useRef(false)
  const left = useRef(false)

  const outcome = useProvingOutcome("withdraw")
  const network = getConfig().network

  const leave = () => {
    left.current = true
    outcome.finish()
    onDone()
  }

  const parsed = parseAmount(amount)
  // The decimal-safe parse: undefined for anything the burn would reject.
  const charged = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const fundsAtomic = charged !== undefined ? parseUnits(charged, DEFAULT_DECIMALS) : undefined
  const gasAtomic = parseUnits(String(gas), DEFAULT_DECIMALS)
  const daiForGas = freshDaiForGas(fundsAsset, gasAtomic)
  // DAI with no gas share is a direct withdrawal: no escrow, no swap tip.
  const direct = withdrawalReceiveAsset(fundsAsset).direct && daiForGas === 0n

  // Kept through the working phase, so a failed or cancelled flow comes back to the same choice.
  const speed = useSpeedChoice({
    active: phase !== "amount",
    node: obsidionWallet?.node,
    amount: fundsAtomic,
  })
  const quote = useSwapSimulation({
    receiveAsset: fundsAsset,
    amountAtomic:
      charged !== undefined
        ? freshBurnAmount(charged, String(gas), floor, DEFAULT_DECIMALS)
        : undefined,
    recipient,
    network,
    proverTip: speed.pricedTip,
    daiForGas,
  })
  // A floor learned this render re-prices the burn at once, before anything is committed; a quote
  // within a cent of the floor the burn carries does not move it.
  const learned = settledFloor(floor, quote.fee?.floorAtomic)
  if (learned !== floor) setFloor(learned)

  // What the burn commits to at confirm; undefined until the route has priced the exact burn. The
  // floor is the settled one the burn was priced on, not the quote's own.
  const committed: FreshQuote | undefined =
    quote.status === "ready" && quote.fee && quote.estimate
      ? {
          ...quote.estimate,
          relayerTip: quote.fee.swapRelayerTip,
          floorAtomic: learned,
          proverTip: quote.fee.proverTip,
        }
      : undefined
  const feeAtomic = quote.fee ? learned : undefined
  const totalAtomic =
    fundsAtomic !== undefined && feeAtomic !== undefined
      ? fundsAtomic + gasAtomic + feeAtomic
      : undefined
  const complete = charged !== undefined && parsed >= 1 && committed !== undefined
  // A floor not yet priced counts nothing, so only a known excess shows.
  const problem =
    fundsAtomic !== undefined
      ? withdrawalLimitProblem(fundsAtomic + gasAtomic + learned, txAmountCap)
      : undefined
  const valid = complete && !problem
  const balance = wallet.main?.atomic ?? 0n
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  const overspent = complete && exceedsBalance(wallet, totalAtomic)
  // The gas share and the fee ride on top, so MAX leaves room for them within the balance and the
  // limit; a fee not yet priced takes nothing until it lands. The tip is not in MAX: a maxed amount
  // never moves for it, and Faster is refused below when it would not fit. Under the $1 minimum
  // there is nothing to send, and the sheet says why.
  const tipInFee = quote.fee?.proverTip ?? 0n
  const untippedFee = feeAtomic === undefined ? undefined : feeAtomic - tipInFee
  const room = balance - gasAtomic - (untippedFee ?? 0n)
  const minimum = parseUnits("1", DEFAULT_DECIMALS)
  const short =
    wallet.live && untippedFee !== undefined && wallet.main !== null && room < minimum
      ? fmt(copy.short, {
          what: gas > 0 ? copy.shortGasAndFees : copy.shortFees,
          amount: dollars(gasAtomic + untippedFee),
        })
      : undefined
  const max = wallet.main
    ? withdrawalMaxNet({
        spendableAtomic: balance,
        feeAtomic: gasAtomic + learned - tipInFee,
        decimals: DEFAULT_DECIMALS,
        valuation: NOMINAL_USD_VALUATION,
        txAmountCap,
      })
    : undefined
  const maxAmount =
    max?.status === "available" && max.atomic >= minimum
      ? formatUnits(max.atomic, DEFAULT_DECIMALS)
      : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  // The burn carries its tip on top, so what can fall short is the balance or the limit. Judged on
  // the untipped fee, so the answer holds while a tipped quote loads.
  let tipBlocked: string | undefined
  if (speed.offer && feeAtomic !== undefined && fundsAtomic !== undefined) {
    const extra = speed.offer.proverTip - tipInFee
    if (balance - gasAtomic - (feeAtomic + extra) < fundsAtomic)
      tipBlocked = BALANCE_TIP_BLOCKED_COPY
    else if (withdrawalLimitProblem(fundsAtomic + gasAtomic + learned + extra, txAmountCap))
      tipBlocked = LIMIT_TIP_BLOCKED_COPY
  }
  const speedOutcome = useSpeedOutcome(
    speed,
    speed.offer && feeAtomic !== undefined && fundsAtomic !== undefined ? !tipBlocked : undefined,
    tipBlocked,
  )
  const { proverTip } = speedOutcome
  // The fee on screen was priced with the tip the burn will carry.
  const confirmable = quote.fee?.proverTip === proverTip
  const ready = !!(obsidionWallet && obsidionAccount && tokenService && contractService)
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const destination = walletName
    ? `${walletName} · ${shortL1Addr(recipient)}`
    : shortL1Addr(recipient)

  const run = async () => {
    if (!valid || !committed || charged === undefined) return
    if (failedOnce) fireEvent("retry_clicked", { flow: "withdraw" })
    outcome.start("building")
    setPhase("working")
    setCancellable(true)
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    fireEvent("withdraw_confirmed")
    const elapsed = lapTimer()
    try {
      // The confirm CTA gates on `ready`, so the four context values are present here.
      const record = await submitFreshAddressWithdrawal(
        {
          wallet: obsidionWallet!,
          account: obsidionAccount!,
          tokenService: tokenService!,
          contractService: contractService!,
          screener,
        },
        {
          recipient,
          recipientAlias: walletName,
          fundsDisplay: charged,
          gasDisplay: String(gas),
          fundsAsset,
          quote: committed,
        },
        (s) => {
          // Only here. `submitting` lands after the burn has mined, and the gateway answers a
          // cancel by dropping the record — past this point that would erase a real withdrawal.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          if (!left.current) setCancellable(s === "building")
        },
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
        if (!left.current) setPhase("confirm")
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

  // No dismissing while working: Cancel is the way out until the passkey opens.
  const dismiss = phase === "working" ? undefined : onClose

  return (
    <Modal
      variant="bare"
      label={copy.title}
      className="ww-deposit-warning ww-fund"
      onClose={dismiss}
    >
      {phase !== "working" && (
        <>
          {phase === "confirm" && (
            <div className="ww-deposit-warning__back">
              <TopNavIconButton
                icon="chevron-left"
                ariaLabel={copy.back}
                onClick={() => setPhase("amount")}
              />
            </div>
          )}
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={dismiss} />
          </div>
          <span className="ww-deposit__connect-icon">
            <Icon name="tray-withdraw" size={24} color="#fff" />
          </span>
          <div>
            <GradientText size={24} weight={700}>
              {copy.title}
            </GradientText>
            <div className="ww-fund__addr">{destination}</div>
          </div>
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>
                {copy.available} <b>${fixedCents(wallet.main && { ...wallet.main, decimals })}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label={copy.amount}
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
                <small>${complete ? parsed : 0}</small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  onClick={() => setMaxed(true)}
                >
                  {copy.max}
                </button>
              </span>
            </label>
            <LimitLine
              kind="eachWithdrawal"
              minimum="$1"
              testId="operation-limits"
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
            <div className="ww-sheet__facts">
              <div className="ww-sheet__fact">
                <b>{copy.gas.title}</b>
                <span className="ww-withdraw__tag ww-withdraw__tag--private">{copy.gas.mode}</span>
              </div>
              <p className="ww-sheet__note">{copy.gas.body}</p>
              <AmountChipRow
                values={GAS_CHIPS}
                glass={false}
                selectedValue={gas}
                onSelect={setGas}
              />
              <small>
                {gas > 0
                  ? fmt(copy.gas.share, { amount: usdFigure(String(gas)) })
                  : fundsAsset === "ETH"
                  ? copy.gas.noneEth
                  : copy.gas.none}
              </small>
            </div>
            <div className="ww-deposit__facts">
              <AssetPicker
                value={fundsAsset}
                options={WITHDRAWAL_RECEIVE_ASSETS}
                onChange={setFundsAsset}
              />
              <DepositFact label={copy.fee}>
                <b>{dollars(feeAtomic)}</b>
              </DepositFact>
              <ExecutorFeeNote state={quote} />
              {/* An escrow's swap tip is the bulk of the fee: say what it was priced on, once the
                  whole fee above it is. */}
              {!direct && feeAtomic !== undefined && <SwapFeeNote state={quote} />}
              {quote.status === "unavailable" && (
                <Warning
                  title={networkHasSwapStack(network) ? FEE_UNAVAILABLE_COPY : copy.noSwapStack}
                />
              )}
            </div>
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
              asset={fundsAsset}
              send={sendText(fundsAsset, fundsAtomic, gasAtomic, committed)}
              gas={gasText(fundsAsset, gas, committed)}
              fee={dollars(feeAtomic)}
              total={dollars(totalAtomic)}
              speed={<SpeedRow choice={speed} outcome={speedOutcome} />}
            />
            {/* Reachable when the balance lands or a fee moves after review — the CTA is dead
                without these. */}
            {overspent ? (
              <span className="ww-pay__error">{copy.overspent}</span>
            ) : (
              problem && <LimitNotice operation="withdrawal" problem={problem} />
            )}
          </div>
          <LocalPasskeyHint />
          <PrimaryGradientButton
            title={busy ? busyLabel : ready ? copy.confirm : copy.connecting}
            isDisabled={!ready || !valid || overspent || !confirmable || busy}
            onClick={run}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={cancellable ? () => (cancelled.current = true) : undefined}
        />
      )}
    </Modal>
  )
}

/** What the funds land as. On the ETH route the gas share is part of the same ETH. */
function sendText(
  asset: WithdrawalReceiveAsset,
  fundsAtomic: bigint | undefined,
  gasAtomic: bigint,
  estimate: SwapEstimate | undefined,
): string {
  if (withdrawalReceiveAsset(asset).direct) return dollars(fundsAtomic)
  const sent = asset === "ETH" && fundsAtomic !== undefined ? fundsAtomic + gasAtomic : fundsAtomic
  return `${dollars(sent)} ≈ ${estimateText(estimate, asset)}`
}

/** What the gas share lands as: its own ETH from the escrow's gas swap, or part of the ETH route. */
function gasText(
  asset: WithdrawalReceiveAsset,
  gas: number,
  estimate: SwapEstimate | undefined,
): string | undefined {
  if (gas === 0) return undefined
  if (asset === "ETH") return fmt(copy.gas.inEth, { amount: usdFigure(String(gas)) })
  const eth =
    estimate?.gasOut === undefined
      ? "…"
      : fmt(copy.gas.eth, { amount: tokenAmount(formatUnits(estimate.gasOut, 18)) })
  return `${usdFigure(String(gas))} ≈ ${eth}`
}

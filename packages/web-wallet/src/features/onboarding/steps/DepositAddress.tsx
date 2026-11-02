import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { erc20Abi, formatUnits, type Address, type Hex } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  addressShareDecision,
  fixedAmountLimits,
  NOMINAL_USD_VALUATION,
  isCapacityAffirmative,
  type PortalCapacityStore,
  type RequiredCredit,
} from "@obsidion/front-core"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../../config/env"
import { l1PublicClient } from "../../../config/oxideTuple"
import { showErrorModal, showReportableError } from "../../../errors/errorModal"
import { shortL1Addr } from "../../../ui/format"
import { Blockie, L1AddressText } from "../../../ui/L1AddressText"
import { useCopy } from "../../../ui/hooks"
import { Modal } from "../../../ui/Modal"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import {
  getL1Clients,
  isWalletDisconnect,
  isWalletRejection,
  isWrongNetwork,
  useL1Wallet,
} from "../../deposit/l1Wallet"
import { useDepositTokensRead, type DepositTokenOption } from "../../deposit/loadDepositFacts"
import { DepositTokensStatus } from "../../deposit/DepositCoinModal"
import {
  capacityHold,
  registrationRequiredCredit,
  targetEligibility,
  useTargetCapacity,
  type CapacityHold,
  type TargetCapacity,
} from "../../deposit/targetCapacity"
import { capacityShareWarning } from "../../deposit/AddressCapacity"
import { fundingCapacityView, type FundingCapacityView } from "../../deposit/fundingCapacity"
import { FundingPreflightError, runFundingPreflight } from "../../deposit/fundingPreflight"
import { readL1DepositTokenBalance } from "../../deposit/l1DepositTokenBalance"
import { OneTimeAddressWarning } from "../../deposit/OneTimeAddressWarning"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "../../deposit/walletPrompt"
import { formatPublicLimit } from "../../limits/publicLimit"
import { reportRegistrationDepositShown } from "../registrationFunnel"
import {
  DEPOSIT_TERMS_PENDING,
  depositTermsSplit,
  formatDepositAmount,
  formatDepositDue,
  type DepositTerms,
} from "./DepositTermsRows"
import connectIcon from "../../../assets/deposit/eth-fill.svg"
import ethIcon from "../../../assets/deposit/ethereum.webp"

type OverLimit = "public" | "protocol"

const OVER_LIMIT_COPY: Record<OverLimit | CapacityHold, string> = {
  public: `This deposit is over the ${formatPublicLimit()} limit.`,
  protocol: "This deposit is over the network's maximum per deposit.",
  // The capacity line says why; this says what it holds.
  capacity: "Copy is paused until this deposit fits current capacity.",
  ceiling: "This deposit can't fit the network's deposit capacity, even when it is full.",
}

const CAPACITY_UNCONFIRMED = "Paying from your wallet waits until network capacity is confirmed."
const WALLET_HOLDING = "Your wallet still holds this payment. Approve or reject it there."

/** What a connected payment to a registration address needs from shared capacity. */
export interface RegistrationFunding {
  /** The bucket of the portal the address forwards to; unset while it is not known. */
  store?: PortalCapacityStore
  required: RequiredCredit
  /** A fresh reading fits the ask, so a new payment may start. */
  canFund: boolean
  /** Why a new payment is held, when it is. */
  reason?: string
}

/**
 * Shared capacity for a registration address, from the bucket of the portal its recorded origin
 * names. The ask counts whole, whatever part of it has arrived: the sweep forwards the balance.
 */
export function useRegistrationFunding(input: {
  address?: Address
  askAtomic?: bigint
  decimals: number
  /** The settlement token the ask is quoted in. */
  tokenSymbol: string
}): {
  capacity: TargetCapacity
  view: FundingCapacityView
  /** Known capacity cannot take the ask. */
  hold?: CapacityHold
  capacityWarning?: string
  funding: RegistrationFunding
} {
  const capacity = useTargetCapacity(
    input.address ? { kind: "recorded", sipaAddress: input.address } : { kind: "unproven" },
  )
  const required = registrationRequiredCredit(capacity, input.askAtomic, input.decimals)
  const eligibility = targetEligibility(capacity, required)
  const view = fundingCapacityView({
    eligibility,
    mode: "fixed",
    symbol: input.tokenSymbol,
    sentSymbol: input.tokenSymbol,
    exactCredit: true,
  })
  const share = addressShareDecision(eligibility, true)
  const canFund = isCapacityAffirmative(eligibility)
  return {
    capacity,
    view,
    hold: capacityHold(eligibility),
    capacityWarning: capacityShareWarning(share),
    funding: {
      store: capacity.store,
      required,
      canFund,
      reason: canFund ? undefined : view.statusText ?? CAPACITY_UNCONFIRMED,
    },
  }
}

/**
 * Which per-deposit limit a registration ask is over, if any. The token is the portal token the
 * ask is quoted in. Figures not read yet leave their check open rather than failing it.
 */
export function registrationOverLimit(input: {
  token?: Address
  chainId?: number
  decimals: number
  askAtomic?: bigint
  scheduleFeeAtomic?: bigint
  txAmountCap?: bigint
}): OverLimit | undefined {
  const { token, chainId, decimals, askAtomic, scheduleFeeAtomic, txAmountCap } = input
  // The ask is in the fee token, which the table always accepts.
  const valuation = token && chainId !== undefined ? NOMINAL_USD_VALUATION : undefined
  return fixedAmountLimits(
    { kind: "registration", decimals, askAtomic, scheduleFeeAtomic, txAmountCap },
    valuation,
  )?.over
}

/**
 * Where to send: one ringed row, the address short enough to check against a wallet's own display
 * and one tap to copy in full. The live check sits at its right.
 */
export function DepositAddressRow({
  address,
  note,
  overLimit,
  capacityHold: hold,
  capacityWarning,
}: {
  address: Address
  /** Under the row: the live check of the address. */
  note?: ReactNode
  /** The ask is over a per-deposit limit: the address stays visible but is not offered to copy. */
  overLimit?: OverLimit
  /** Known capacity cannot take the ask: copy is held like `overLimit`. */
  capacityHold?: CapacityHold
  /** Said on every copy while capacity is zero or unconfirmed. */
  capacityWarning?: string
}) {
  const { copied, copy } = useCopy()
  const [warning, setWarning] = useState(false)
  const held = overLimit ?? hold
  // An address that becomes known not to fit is no longer offered: an open warning closes.
  useEffect(() => {
    if (held) setWarning(false)
  }, [held])
  useEffect(() => {
    reportRegistrationDepositShown(address)
  }, [address])
  return (
    <>
      <div className="ww-send-to">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-send-to__copy"
          aria-label={`Copy deposit address ${address}`}
          title={address}
          disabled={!!held}
          onClick={() => (capacityWarning ? setWarning(true) : copy(address))}
        >
          <span className="ww-send-to__label">Send to</span>
          <span className="ww-send-to__value">
            <Blockie address={address} />
            <L1AddressText address={address} cut />
          </span>
          <span className="ww-send-to__icon" aria-live="polite">
            {copied ? (
              <Icon name="check-circle" size={16} color="var(--accent-green)" />
            ) : (
              <Icon name="copy" size={16} color="#fff" />
            )}
          </span>
        </button>
      </div>
      {note != null && <div className="ww-send-to__note">{note}</div>}
      {held && (
        <p className="ww-limit-reason" role="alert" data-testid="registration-over-limit">
          {OVER_LIMIT_COPY[held]}
        </p>
      )}
      {warning && (
        <OneTimeAddressWarning
          capacityWarning={capacityWarning}
          onClose={() => setWarning(false)}
          onGotIt={() => {
            setWarning(false)
            if (!held) void copy(address)
          }}
        />
      )}
    </>
  )
}

interface PayTarget {
  address: Address
  token: Address
  chainId: number
  /** Base units; zero means the sender picks the amount. */
  total: bigint
  /** The ask is over a per-deposit limit, so no new payment starts. */
  overLimit?: OverLimit
  funding: RegistrationFunding
  /** A top-up is paid in the token already at the address: the sweep reads each token on its own. */
  heldToken?: Address
  /** What `total` covers, shown before the wallet is asked; unset for a top-up. */
  terms?: DepositTerms
}

/** The network warning, then the deposit screen's connect row. */
export function DepositPayBlock({
  note,
  ...target
}: PayTarget & {
  /** Sits above the row, where the design puts the network warning. */
  note?: ReactNode
}) {
  return (
    <>
      {note}
      <ConnectedWalletPay {...target} />
    </>
  )
}

/**
 * `total` (fee-token base units) in `pick`'s base units, rounded up so a coarser token never
 * underpays. The ask sits above the floor by more than the sweep swap's slippage, so parity holds.
 */
export function pickedAmount(
  total: bigint,
  feeDecimals: number,
  pick: { decimals: number },
): bigint {
  const scale = 10n ** BigInt(Math.max(feeDecimals - pick.decimals, 0))
  return (total + scale - 1n) / scale
}

// Session-scoped: closing a sheet or disconnecting must not forget an in-flight payment.
// The target, not the payer or quoted amount, owns the lock across both registration surfaces.
// `holding`: the sheet stopped waiting on the wallet, which still has the transfer to answer.
type Payment = {
  state: "checking" | "sending" | "holding" | "confirming" | "check" | "sent"
  hash?: Hex
}
const payments = new Map<string, Payment>()
const paymentListeners = new Set<() => void>()
function subscribePayments(listener: () => void) {
  paymentListeners.add(listener)
  return () => {
    paymentListeners.delete(listener)
  }
}
function setPayment(key: string, payment?: Payment) {
  if (payment) payments.set(key, payment)
  else payments.delete(key)
  paymentListeners.forEach((listener) => listener())
}

/**
 * The deposit screen's connect row: RainbowKit to connect, then one click transfers `total` from
 * the screened account, in whichever accepted token the user picks (the sweep swaps it into the
 * fee token). The sheet's own check spots the deposit landing.
 */
function ConnectedWalletPay({
  address,
  token,
  chainId,
  total,
  overLimit,
  funding,
  heldToken,
  terms,
}: PayTarget) {
  const l1 = useL1Wallet({ expectedChainId: chainId })
  const { verdict, cleared, rescreen } = useScreenedAddress(l1.account, "deposit")
  const key = `${chainId}:${token.toLowerCase()}:${address.toLowerCase()}`
  const payment = useSyncExternalStore(subscribePayments, () => payments.get(key))
  const state = payment?.state ?? "idle"
  // The last check refused this payment; nothing was sent.
  const [refusal, setRefusal] = useState<string>()
  // The fee token, and the tokens the sweep swaps into it. Nothing is paid before they are read.
  const tokensRead = useDepositTokensRead("registration")
  const registrationTokens = tokensRead.tokens
  const feeToken = registrationTokens?.settlement ?? {
    address: token,
    symbol: "",
    decimals: tokenDecimalsForNetwork(getConfig().network),
    icon: ethIcon,
    settlesIn: token,
    swapped: false,
  }
  const tokens = registrationTokens?.offered ?? [feeToken]
  const [picked, setPicked] = useState<DepositTokenOption>()
  const [confirming, setConfirming] = useState(false)
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(state === "sending")
  // Back to the ask; the target stays locked until the wallet answers the transfer it still holds.
  const cancelPrompt = () => {
    prompt.cancel()
    setPayment(key, { state: "holding" })
    setConfirming(false)
  }
  const held = heldToken
    ? tokens.find((t) => t.address.toLowerCase() === heldToken.toLowerCase())
    : undefined
  const pick = held ?? picked ?? feeToken
  const swapped = pick.swapped
  const amount = pickedAmount(total, feeToken.decimals, pick)

  const pay = async () => {
    const current = payments.get(key)
    if (current && current.state !== "check") return
    if (!current && (overLimit || !funding.canFund || !l1.account || !cleared || total <= 0n)) {
      return
    }
    let hash = current?.hash
    let failed = false
    if (!current && prompt.openElsewhere) {
      setRefusal(prompt.openElsewhere)
      return
    }
    let request: WalletPromptToken | undefined
    setRefusal(undefined)
    setPayment(key, { state: hash ? "confirming" : "checking", hash })
    try {
      const config = getConfig()
      if (config.l1ChainId !== chainId) throw new Error("Switch to the registration network first.")
      const publicClient = l1PublicClient(config)
      if (!hash) {
        const balance = await readL1DepositTokenBalance(l1.account!, pick.address)
        if (balance.raw < amount) {
          setPayment(key, undefined)
          setRefusal(
            `This wallet holds ${balance.display}, and this payment needs ${formatUnits(
              amount,
              balance.decimals,
            )} ${balance.symbol}. Add ${
              balance.symbol
            } to it, or send from another wallet to the address above.`,
          )
          return
        }
        // A new read of the address's own bucket right before the wallet prompt. It reserves nothing.
        if (!funding.store) throw new FundingPreflightError("capacity", CAPACITY_UNCONFIRMED)
        await runFundingPreflight({ store: funding.store, required: funding.required })
        request = prompt.begin()
        setPayment(key, { state: "sending" })
        const { walletClient, account, chain } = await getL1Clients(chainId, l1.account!)
        hash = await walletClient.writeContract({
          address: pick.address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [address, amount],
          account,
          chain,
        })
        prompt.settle(request)
      }
      setPayment(key, { state: "confirming", hash })
      setConfirming(false)
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        onReplaced: ({ reason, transaction }) => {
          hash = transaction.hash
          failed = reason !== "repriced"
        },
      })
      failed ||= receipt.status !== "success"
      if (failed) throw new Error("The funding transaction failed or was replaced. Try again.")
      setPayment(key, { state: "sent", hash })
    } catch (e) {
      // An RPC error or timeout does not prove failure: recheck the same hash, never resend it.
      setPayment(key, hash && !failed ? { state: "check", hash } : undefined)
      if (e instanceof WalletPromptOpenError) setRefusal(e.message)
      else if (prompt.cancelled(request)) return
      else if (e instanceof FundingPreflightError) setRefusal(e.message)
      else if (isWalletDisconnect(e)) {
        showErrorModal({
          title: "Wallet disconnected",
          message: "Your wallet disconnected during the payment. Connect it again to pay.",
        })
      } else if (isWrongNetwork(e)) {
        const network = l1ChainFor(chainId).name
        setRefusal(`Your wallet is on another network. Switch it to ${network} and try again.`)
      } else if (!isWalletRejection(e)) showReportableError(e, "registration:fund")
    } finally {
      prompt.settle(request)
    }
  }

  // ponytail: an open amount has no one-click send; the connected wallet pays the address by hand.
  const title =
    state === "sent"
      ? "Payment sent"
      : state === "checking"
      ? "Checking network capacity…"
      : state === "sending"
      ? "Approve in your wallet…"
      : state === "confirming"
      ? "Confirming payment…"
      : state === "check"
      ? "Check payment status"
      : l1.connecting && !l1.account
      ? "Connecting…"
      : !l1.account
      ? "Connect your wallet"
      : total === 0n
      ? "Wallet connected"
      : `Pay ${formatDepositDue(total, feeToken.decimals)} from ${l1.walletName ?? "wallet"}`
  const subtitle = !l1.account
    ? "Use Rainbow, MetaMask, Rabby, or WalletConnect"
    : total === 0n
    ? "Send any amount to the address above"
    : shortL1Addr(l1.account)
  // A payment already sent can still be rechecked; only a new one is held.
  const disabled =
    state !== "check" &&
    (state !== "idle" ||
      !!overLimit ||
      (!!l1.account && (!cleared || total === 0n || !funding.canFund || !registrationTokens)))
  const reason =
    state === "holding"
      ? WALLET_HOLDING
      : state === "idle" && l1.account && total > 0n && !overLimit
      ? refusal ?? funding.reason
      : undefined
  const rowBusy = state === "checking" || state === "sending" || (l1.connecting && !l1.account)
  const stallNote = stalled && (
    <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />
  )
  return (
    <>
      <div className="ww-deposit__or">
        <hr className="ww-divider" />
        <span>or</span>
        <hr className="ww-divider" />
      </div>
      {l1.account && !cleared && (
        <ScreeningNotice
          verdict={verdict}
          checkingCopy="Checking your wallet…"
          blockedFallback="This wallet can't be used to pay. Connect a different one."
          errorCopy="Couldn't verify your wallet. Check your internet connection or try another wallet."
          onRetry={rescreen}
        />
      )}
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-deposit__connect"
        disabled={disabled}
        aria-busy={rowBusy || undefined}
        onClick={() =>
          void (state === "check" ? pay() : l1.account ? setConfirming(true) : l1.connect())
        }
      >
        <span className="ww-deposit__connect-icon">
          <img src={connectIcon} alt="" width={24} height={24} />
        </span>
        <span className="ww-deposit__connect-text">
          <b>{title}</b>
          <span>{subtitle}</span>
        </span>
        {rowBusy ? (
          <Spinner size={16} />
        ) : (
          <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
        )}
      </button>
      {l1.account && !registrationTokens && state === "idle" && (
        <DepositTokensStatus failed={tokensRead.failed} onRetry={tokensRead.retry} />
      )}
      {!confirming && stallNote}
      {reason && (
        <p className="ww-capacity__reason" role="status" data-testid="registration-pay-reason">
          {reason}
        </p>
      )}
      {l1.account && state !== "sending" && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__disconnect"
          onClick={l1.disconnect}
        >
          Disconnect
        </button>
      )}
      {/* Once the transfer is broadcast the row tracks it; the modal is only the ask. */}
      {confirming && l1.account && registrationTokens && state in PAY_STAGE_LABEL && (
        <PayConfirmModal
          from={`${l1.walletName ?? "Wallet"} · ${shortL1Addr(l1.account)}`}
          to={address}
          total={total}
          feeToken={feeToken}
          tokens={held ? [held] : tokens}
          pick={pick}
          onPick={setPicked}
          amount={amount}
          swapped={swapped}
          topUp={!!held}
          terms={terms}
          state={state as keyof typeof PAY_STAGE_LABEL}
          canStart={!overLimit && cleared && funding.canFund}
          reason={reason}
          note={stallNote}
          onConfirm={() => void pay()}
          onClose={() => {
            setRefusal(undefined)
            setConfirming(false)
          }}
        />
      )}
    </>
  )
}

const PAY_STAGE_LABEL = {
  idle: "Confirm payment",
  checking: "Checking network capacity…",
  sending: "Approve the transfer in your wallet",
}

/** The deposit screen's confirmation step for a fixed registration ask: what is sent, and what it buys. */
function PayConfirmModal({
  from,
  to,
  total,
  feeToken,
  tokens,
  pick,
  onPick,
  amount,
  swapped,
  topUp,
  terms,
  state,
  canStart,
  reason,
  note,
  onConfirm,
  onClose,
}: {
  from: string
  to: Address
  /** Fee-token base units. */
  total: bigint
  feeToken: DepositTokenOption
  tokens: DepositTokenOption[]
  pick: DepositTokenOption
  onPick: (token: DepositTokenOption) => void
  /** `total` in `pick`'s base units. */
  amount: bigint
  swapped: boolean
  topUp: boolean
  terms?: DepositTerms
  state: keyof typeof PAY_STAGE_LABEL
  /** A new payment may start. */
  canStart: boolean
  reason?: string
  /** Sits under the button: the stall note while the wallet holds the transfer. */
  note?: ReactNode
  onConfirm: () => void
  onClose: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const busy = state !== "idle"
  const usd = (v?: bigint) =>
    v === undefined ? DEPOSIT_TERMS_PENDING : formatDepositAmount(v, feeToken.decimals)
  const split = terms && !terms.scheduleUnavailable ? depositTermsSplit(terms) : undefined
  const tokenIcon = <img src={pick.icon} alt="" width={16} height={16} />
  return (
    <Modal
      variant="bare"
      label="Pay from wallet"
      className="ww-deposit-warning ww-fund"
      onClose={busy ? undefined : onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={() => !busy && onClose()} />
      </div>
      <span className="ww-deposit__connect-icon">
        <Icon name="coins" size={24} color="#fff" />
      </span>
      <div>
        <GradientText size={32} weight={700}>
          {formatDepositDue(total, feeToken.decimals)}
        </GradientText>
        <div className="ww-fund__addr">
          {topUp ? "Registration top-up" : "Registration payment"}
        </div>
      </div>
      <div className="ww-fund__fields">
        <div className="ww-deposit__facts" data-testid="registration-pay-breakdown">
          <div className="ww-deposit__fact">
            <span>From</span>
            <b>{from}</b>
          </div>
          <div className="ww-deposit__fact">
            <span id="registration-pay-with">Token</span>
            {tokens.length > 1 && !busy ? (
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__pill"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-labelledby="registration-pay-with"
                onClick={() => setPickerOpen((o) => !o)}
              >
                {tokenIcon}
                {pick.symbol}
                <Icon name={pickerOpen ? "chevron-up" : "chevron-down"} size={16} />
              </button>
            ) : (
              <b>
                {tokenIcon}
                {pick.symbol}
              </b>
            )}
            {pickerOpen && !busy && (
              <div
                className="ww-deposit__picker"
                role="listbox"
                aria-labelledby="registration-pay-with"
              >
                {tokens.map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    role="option"
                    className="zkm-btn-reset ww-deposit__picker-row"
                    aria-selected={t.symbol === pick.symbol}
                    onClick={() => {
                      onPick(t)
                      setPickerOpen(false)
                    }}
                  >
                    <img src={t.icon} alt="" width={30} height={30} />
                    <span>
                      <b>{t.symbol}</b>
                      <small>1 {t.symbol} ≈ $1</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ww-deposit__fact">
            <span>Network</span>
            <b>
              <img src={ethIcon} alt="" width={16} height={16} />
              Ethereum (ERC20)
            </b>
          </div>
          <div className="ww-deposit__fact">
            <span>To</span>
            <b title={to}>
              <Blockie address={to} />
              {shortL1Addr(to)}
            </b>
          </div>
          <hr className="ww-divider" />
          <div className="ww-deposit__fact">
            <span>You send</span>
            <b data-testid="registration-pay-amount">
              {formatUnits(amount, pick.decimals)} {pick.symbol}
            </b>
          </div>
          {split && (
            <>
              <div className="ww-deposit__fact">
                <span>Tag price</span>
                <b>
                  {terms!.kind === "earned_tag" ? (
                    <span style={{ color: "var(--accent-green)" }}>Waived</span>
                  ) : (
                    usd(split.price)
                  )}
                </b>
              </div>
              <div className="ww-deposit__fact">
                <span>Network funding</span>
                <b>{usd(split.funding)}</b>
              </div>
              <hr className="ww-divider" />
              <div className="ww-deposit__fact">
                <span>Opening balance</span>
                <b data-testid="registration-pay-opening">
                  {/* A swap settles at the market rate, so the figure is an estimate. */}
                  {swapped && split.opening !== undefined ? "~" : ""}
                  {usd(split.opening)}
                </b>
              </div>
            </>
          )}
          {swapped && (
            <p className="ww-limits__note">
              {pick.symbol} is swapped to {feeToken.symbol} at the market rate
              {split ? ", so the opening balance can differ" : ""}.
            </p>
          )}
        </div>
      </div>
      {reason && !busy && (
        <p
          className="ww-capacity__reason"
          role="status"
          data-testid="registration-pay-confirm-reason"
        >
          {reason}
        </p>
      )}
      <PrimaryGradientButton
        title={PAY_STAGE_LABEL[state]}
        isLoading={busy}
        isDisabled={!busy && !canStart}
        onClick={onConfirm}
        style={{ width: "100%", height: 48 }}
      />
      {note}
    </Modal>
  )
}

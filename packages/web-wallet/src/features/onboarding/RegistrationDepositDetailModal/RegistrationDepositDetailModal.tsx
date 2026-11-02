import { Modal } from "../../../ui/Modal"
import { useEffect, useRef, useState, type MutableRefObject } from "react"
import { Link } from "react-router-dom"
import { useDepositAdmission } from "../../identity/admission"
import type { Address } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import type { RegistrationKind } from "@obsidion/core/types"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  depositOwed,
  fundsIn,
  isTerminalRegistrationPhase,
  sipaSweepAllowed,
  truncateMiddle,
  useScreener,
  type PendingRegistrationRecord,
  type RegistrationStage,
  useResource,
} from "@obsidion/front-core"
import { errorCopy } from "../../../errors/catalog"
import { useRegistrationStage } from "../openRegistration"
import { useSipaRecord } from "../useDepositWatch"
import {
  ConfirmationSheetDetailRow,
  StatusBadge,
  TopNavIconButton,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import { getConfig } from "../../../config/env"
import {
  AddressRow,
  CopyableValue,
  DetectingRow,
  HashRow,
  l1TxUrl,
  whenLabel,
} from "../../../ui/detailRows"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { useL1Wallet } from "../../deposit/l1Wallet"
import type { L1ExitStage } from "../../deposit/sipaRecovery"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "../../deposit/walletPrompt"
import { isGateCancelled, useCeremonyGate } from "../../identity/ceremonyGate"
import { PasskeyRefusal, type RefusalState } from "../../identity/PasskeyRefusal"
import { isPasskeyPolicyError, type PasskeyAttemptHandle } from "@obsidion/passkey-web"
import { GateStep } from "../../identity/PhoneSteps"
import { reusePasskeyAccount } from "../oxideOnboarding"
import { reloadIfSessionSwitched } from "../sessionReload"
import { failureCode, fireEvent } from "../../../lib/analytics"
import { passkeyTelemetry } from "../../../lib/passkeyTelemetry"
import { canManualRegistrationSweep } from "@obsidion/front-core"
import { manualRegistrationSweep } from "../registrationSweep"
import { reservedUntil, type RegistrationTerms } from "../registrationTerms"
import { registrationNeedsRefund, useRegistrationRefunded } from "../registrationQuoteRecovery"
import { DepositProcessingNotice } from "../../deposit/DepositProcessingNotice"
import exitCopy from "../../deposit/DepositExitModal/DepositExitModal.copy"
import { useSipaProcessing } from "../../deposit/sipaProcessing"
import { useDepositTokens } from "../../deposit/loadDepositFacts"
import { useOweRegistrationBroadcast } from "../../broadcasts/useOweRegistrationBroadcast"
import { BroadcastStatusRow } from "../../broadcasts/BroadcastStatusRow"
import { registrationAddressPublished } from "../webRegistration"
import {
  DepositAddressRow,
  DepositPayBlock,
  registrationOverLimit,
  useRegistrationFunding,
} from "../steps/DepositAddress"
import { AddressCapacityPanel } from "../../deposit/AddressCapacity"
import { ADDRESS_RECHECK_NOTE } from "../../limits/limitsCopy"
import { PendingLimitsLink, WalletAboutLimitsSheet } from "../../limits/AboutLimitsSheet"
import { sourceFromTarget } from "../../limits/capacitySources"
import { DepositLimitRows, type DepositTerms } from "../steps/DepositTermsRows"
import { InfoButton } from "../../limits/InfoButton"
import type { LimitsTopic } from "../../limits/aboutLimitsView"
import type { RegistrationFunding } from "../registrationFunding"
import { useSession } from "../../../platform/session"
import copy from "./RegistrationDepositDetailModal.copy"
import { fmt } from "../../../lib/fmt"

/** Where the registration stands once a deposit is at the address, in the feed's words. */
export function registrationDepositStatus(
  tag: string,
  stage: RegistrationStage,
): {
  label: string
  badge: StatusBadgeStyle
} {
  if (stage === "registered") return { label: copy.status.registered, badge: "pending" }
  if (stage === "claiming" || stage === "crediting")
    return { label: copy.status.confirming, badge: "pending" }
  if (fundsIn(stage)) return { label: fmt(copy.status.registering, { tag }), badge: "pending" }
  return { label: copy.status.received, badge: "pending" }
}

/** The sweep that emptied the SIPA: the record's, else the one the rail saw. */
function useSweepTx(record: PendingRegistrationRecord) {
  const rail = useSipaRecord(record.sipaAddress)
  return record.sweepTxHash ?? rail?.sweepTxHash
}

/**
 * Registration-deposit detail, the registration counterpart of DepositDetailModal: the amount and
 * where the registration stands, over the same facts a deposit shows (funder, funding and sweep
 * transactions with explorer links, the address) plus the terms the claim carried. While the
 * address still needs funds, the pay QR and copyable address render right here.
 */
export function RegistrationDepositDetailModal({
  record,
  terms,
  funding,
  sweepFee,
  amount,
  deposited,
  feeLabel,
  pay,
  onClose,
}: {
  record: PendingRegistrationRecord
  terms: RegistrationTerms | null
  /** Undefined while the funding read is out; null when nothing reached the address. The gross row
   *  waits for a value. */
  funding?: RegistrationFunding | null
  /** The relayer's cut on a sweep. Undefined until it is known; the refund verdict waits on it
   *  rather than guessing. */
  sweepFee?: bigint
  /** Headline figure, as the feed row shows it: the credit the sweep produces. */
  amount: string
  /** What the sender actually put at the address (gross), when known. */
  deposited?: string
  /** The fee the deposit covers; an earned tag's says the tag price was waived. Absent until the
   *  schedule that prices it is known. */
  feeLabel?: string
  /** Set while the address still needs funds: renders the pay QR + address inline. */
  pay?: {
    token: Address
    chainId: number
    total: bigint
    tokenSymbol: string
    kind?: RegistrationKind
    /** The token already at the address; a top-up stays in it. */
    heldToken?: Address
    /** What `total` covers, for a first payment. */
    terms?: DepositTerms
  }
  onClose: () => void
}) {
  const feeSymbol = useDepositTokens("registration")?.settlement.symbol ?? WALLET_TOKEN_SYMBOL
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const stage = useRegistrationStage(record)
  const needsRefund = registrationNeedsRefund(record, terms, depositAdmitted || refunded, sweepFee)
  const status = needsRefund
    ? { label: copy.status.refund, badge: "pending" as const }
    : stage && registrationDepositStatus(record.tag, stage)
  // The detail shows the address, so it owes the address's broadcast; one whose deposit must be
  // recovered instead is not published.
  useOweRegistrationBroadcast(record, !needsRefund)
  // Only once funds wait on it.
  const publishing =
    stage !== undefined &&
    fundsIn(stage) &&
    !needsRefund &&
    !registrationAddressPublished(record) &&
    !isTerminalRegistrationPhase(record.phase) &&
    record.sweptAt === undefined
  const fundingTxHash = record.fundingTxHash ?? funding?.txHash
  const { shown: processing, capacityKey } = useSipaProcessing(record.sipaAddress)
  const sweepTxHash = useSweepTx(record)
  // The manual sweep's passkey attempt: closing the modal is the user's cancel of it.
  const sweepAttempt = useRef<PasskeyAttemptHandle | undefined>(undefined)
  const close = () => {
    sweepAttempt.current?.userCancelled()
    onClose()
  }
  // Unknown while the withdrawals load; the row that opens this waits for them too.
  if (!stage || !status) return null
  // While the address still takes funds, its only copy is the pay block's, which the limits and
  // capacity gate; the record row shows the address without offering it. Every state that shows
  // the pay block is one of these.
  const fundingOpen = depositOwed(stage) && !depositAdmitted && !needsRefund
  const holdEnds = isTerminalRegistrationPhase(record.phase)
    ? undefined
    : reservedUntil(terms, Date.now())
  return (
    <Modal variant="bare" label={copy.label} onClose={close}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span className="zkm-type-title-md" style={{ color: "var(--text-primary)" }}>
          {copy.title}
        </span>
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={close} />
      </div>
      <div style={{ textAlign: "center", padding: "16px 0 20px" }}>
        <div style={{ fontSize: 36, fontWeight: 700 }}>{amount}</div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
          <StatusBadge label={status.label} badgeStyle={status.badge} />
        </div>
      </div>
      {processing && (
        <DepositProcessingNotice
          sipaAddress={record.sipaAddress}
          state={processing}
          symbol={feeSymbol}
          help={(detail) => (
            <PendingLimitsLink
              sipaAddress={record.sipaAddress}
              capacityKey={capacityKey}
              settlementSymbol={feeSymbol}
              detail={detail}
            />
          )}
        />
      )}
      <ConfirmationSheetDetailRow
        label={copy.rows.name}
        value={fmt(copy.rows.tag, { tag: record.tag })}
      />
      <ConfirmationSheetDetailRow label={copy.rows.started} value={whenLabel(record.startTime)} />
      {record.fundedAt !== undefined && (
        <ConfirmationSheetDetailRow label={copy.rows.seen} value={whenLabel(record.fundedAt)} />
      )}
      {record.sweptAt !== undefined && (
        <ConfirmationSheetDetailRow label={copy.rows.swept} value={whenLabel(record.sweptAt)} />
      )}
      {deposited === undefined ? (
        <DetectingRow label={copy.rows.deposited} />
      ) : (
        <ConfirmationSheetDetailRow
          label={copy.rows.deposited}
          value={<span data-testid="registration-detail-deposited">{deposited}</span>}
        />
      )}
      {feeLabel && (
        <ConfirmationSheetDetailRow
          label={copy.rows.fee}
          value={<span data-testid="registration-detail-fee">{feeLabel}</span>}
        />
      )}
      {holdEnds !== undefined && (
        <ConfirmationSheetDetailRow label={copy.rows.reserved} value={whenLabel(holdEnds)} />
      )}
      <ConfirmationSheetDetailRow
        label={copy.rows.address}
        value={
          fundingOpen ? (
            <span title={record.sipaAddress} data-testid="registration-detail-address">
              {truncateMiddle(record.sipaAddress, 12)}
            </span>
          ) : (
            <CopyableValue text={record.sipaAddress} />
          )
        }
      />
      {publishing && <BroadcastStatusRow address={record.sipaAddress} />}
      {/* Where the funds came from identifies the deposit, so both rows hold their place
          until the Transfer log read lands. */}
      {funding ? (
        <AddressRow label={copy.rows.funder} address={funding.from} />
      ) : (
        <DetectingRow label={copy.rows.funder} />
      )}
      {fundingTxHash ? (
        <HashRow label={copy.rows.funding} hash={fundingTxHash} url={l1TxUrl(fundingTxHash)} />
      ) : (
        <DetectingRow label={copy.rows.funding} />
      )}
      {sweepTxHash && (
        <HashRow label={copy.rows.sweep} hash={sweepTxHash} url={l1TxUrl(sweepTxHash)} />
      )}
      {pay && !depositAdmitted && !needsRefund && (
        <PayAtAddress address={record.sipaAddress as Address} pay={pay} />
      )}
      <p className="zkm-type-body-sm" style={{ color: "var(--text-secondary)", marginTop: 12 }}>
        {copy.sweepNote}
      </p>
      {(depositAdmitted || refunded) && record.phase === "awaiting_deposit" && (
        <p className="zkm-type-body-sm" style={{ color: "var(--text-secondary)", marginTop: 12 }}>
          {needsRefund
            ? refunded
              ? copy.admitted.recovered
              : copy.admitted.recover
            : copy.admitted.pending}{" "}
          <Link to={`/claim/${record.tag}?recovery=1`} onClick={onClose}>
            {needsRefund
              ? refunded
                ? copy.admitted.register
                : copy.admitted.recoverAction
              : copy.admitted.check}
          </Link>
        </p>
      )}
      {!needsRefund && canManualRegistrationSweep(record) && (
        <ManualSweepAction record={record} attempt={sweepAttempt} showReason={false} />
      )}
    </Modal>
  )
}

/** The address and the pay action, held when the ask is over a per-deposit limit. */
function PayAtAddress({
  address,
  pay,
}: {
  address: Address
  pay: {
    token: Address
    chainId: number
    total: bigint
    tokenSymbol: string
    kind?: RegistrationKind
    heldToken?: Address
    terms?: DepositTerms
  }
}) {
  const { network } = getConfig()
  const decimals = tokenDecimalsForNetwork(network)
  const feeSymbol = useDepositTokens("registration")?.settlement.symbol ?? pay.tokenSymbol
  const overLimit = registrationOverLimit({
    token: pay.token,
    chainId: pay.chainId,
    decimals,
    askAtomic: pay.total,
  })
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  const { capacity, view, hold, capacityWarning, funding } = useRegistrationFunding({
    address,
    askAtomic: pay.total,
    decimals,
    tokenSymbol: pay.tokenSymbol,
  })
  return (
    <div style={{ marginTop: 16 }}>
      <DepositAddressRow
        address={address}
        overLimit={overLimit}
        capacityHold={hold}
        capacityWarning={capacityWarning}
      />
      <AddressCapacityPanel
        view={view}
        onRetry={capacity.retry}
        onAboutLimits={() => setAboutLimits("capacity")}
      />
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={{ capacity: <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p> }}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={feeSymbol}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
      <DepositLimitRows
        info={<InfoButton label={copy.limitInfo} onClick={() => setAboutLimits("limit")} />}
      />
      <DepositPayBlock
        address={address}
        token={pay.token}
        chainId={pay.chainId}
        total={pay.total}
        heldToken={pay.heldToken}
        terms={pay.terms}
        overLimit={overLimit}
        funding={funding}
      />
    </div>
  )
}

const SWEEP_STAGE_LABELS: Record<L1ExitStage, string> = {
  "signing": copy.sweepStage.signing,
  "awaiting-browser": copy.sweepStage.browser,
  "confirming": copy.sweepStage.confirming,
}

/**
 * The small escape hatch: submit the registration sweep yourself instead of waiting for a relayer.
 * One passkey assertion recovers the keys; manual skips the relayer, never the fee.
 */
export function ManualSweepAction({
  record,
  attempt,
  showReason = true,
}: {
  record: PendingRegistrationRecord
  /** This action's passkey attempt, held where the modal's close can mark it. */
  attempt: MutableRefObject<PasskeyAttemptHandle | undefined>
  /** Whether to say why the sweep is held; false where the surface already states the reason. */
  showReason?: boolean
}) {
  const feeSymbol = useDepositTokens("registration")?.settlement.symbol ?? WALLET_TOKEN_SYMBOL
  const obsidionWallet = useResource(useSession().wallet)
  const screener = useScreener()
  const { gate, state: gateState, cancel: cancelGate } = useCeremonyGate()
  // Closing the modal is the user's cancel: a sign-in still short of its keys must not go on to
  // sweep, whether it is at a prompt or adopting the key this tab already holds. The close has
  // already marked that cancel; any other removal is only an unmount.
  const op = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      attempt.current?.unmounted()
      cancelGate()
      op.current?.abort()
    },
    [attempt, cancelGate],
  )
  const [stage, setStage] = useState<"idle" | "destination" | "passkey" | L1ExitStage>("idle")
  const [destination, setDestination] = useState("")
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<RefusalState>()
  const [nudged, setNudged] = useState(false)
  const l1 = useL1Wallet()
  const busy = stage !== "idle" && stage !== "destination"
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(stage === "signing")
  // Back to idle; the sweep the wallet still holds is handled when it answers.
  const cancelPrompt = () => {
    prompt.cancel()
    setStage("idle")
  }
  // Capacity gates the sweep live; recovery never waits on it.
  const { state: processing, capacityKey } = useSipaProcessing(record.sipaAddress)
  const sweepBlocked = !sipaSweepAllowed(processing)

  const run = async () => {
    setError(undefined)
    setNotice(undefined)
    setRefusal(undefined)
    if (isDesktopL1SubmitActive() && stage !== "destination") {
      setStage("destination")
      return
    }
    // Ask for the wallet before the passkey, not after it.
    if (!isDesktopL1SubmitActive() && !l1.account) {
      setNudged(true)
      void l1.connect()
      return
    }
    if (!obsidionWallet) {
      setError(copy.walletStarting)
      return
    }
    if (prompt.openElsewhere) {
      setError(prompt.openElsewhere)
      return
    }
    let request: WalletPromptToken | undefined
    // Confirming means the wallet answered; the slot frees before the receipt lands.
    const onStage = (next: L1ExitStage) => {
      setStage(next)
      if (next === "confirming") prompt.settle(request)
    }
    try {
      request = prompt.begin()
      setStage("passkey")
      op.current?.abort()
      op.current = new AbortController()
      const signal = op.current.signal
      const signIn = passkeyTelemetry.begin({ ceremony: "unlock", flow: "deposit" })
      attempt.current = signIn
      const keys = await signIn.run((own) =>
        reusePasskeyAccount(obsidionWallet, record.l2Address, undefined, gate, signal, own),
      )
      if (reloadIfSessionSwitched(null, record.l2Address)) return
      const opts = isDesktopL1SubmitActive() ? { destination: destination as Address } : {}
      // The paid address (typed destination or the connected account) is only known once the
      // channel resolves, so it is screened at submit rather than in the form.
      await manualRegistrationSweep(record, {
        keys,
        ...opts,
        screen: (a) => screener.screen(a),
        onStage,
        onNotice: setNotice,
      })
      setStage("idle")
    } catch (err) {
      setStage("idle")
      if (err instanceof WalletPromptOpenError) {
        setError(err.message)
        return
      }
      if (isGateCancelled(err) || prompt.cancelled(request)) return
      fireEvent("action_failed", { action: "registration_deposit", code: failureCode(err) })
      if (isPasskeyPolicyError(err)) {
        setRefusal({ name: err.name, message: err.message })
        return
      }
      setError(
        errorCopy(err) ?? (err instanceof Error ? err.message.split("\n")[0] : copy.sweepFailed), // slice-check-ignore: an uncoded error keeps its own words until its source throws a code
      )
    } finally {
      prompt.settle(request)
    }
  }

  if (gateState.kind === "awaiting-action") {
    return (
      <GateStep
        state={gateState}
        onCancel={() => {
          attempt.current?.userCancelled()
          cancelGate()
        }}
      />
    )
  }

  return (
    <div style={{ marginTop: 10, textAlign: "center" }}>
      {sweepBlocked && showReason && processing && (
        <DepositProcessingNotice
          sipaAddress={record.sipaAddress}
          state={processing}
          symbol={feeSymbol}
          help={(detail) => (
            <PendingLimitsLink
              sipaAddress={record.sipaAddress}
              capacityKey={capacityKey}
              settlementSymbol={feeSymbol}
              detail={detail}
            />
          )}
        />
      )}
      {stage === "destination" && (
        <input
          className="ww-manual-sweep__destination"
          placeholder={copy.destination}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      )}
      {!refusal && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit-actions__link"
          data-testid="manual-sweep"
          onClick={() => void run()}
          disabled={busy || sweepBlocked || (stage === "destination" && !destination)}
        >
          {busy
            ? stage === "passkey"
              ? notice ?? copy.passkey
              : SWEEP_STAGE_LABELS[stage as L1ExitStage]
            : copy.sweep}
        </button>
      )}
      {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />}
      {!refusal && !busy && (
        <p
          className="zkm-type-body-sm"
          data-testid="manual-sweep-privacy"
          style={{ color: "var(--text-secondary)", marginTop: 6 }}
        >
          {exitCopy.selfSweepPrivacy}
        </p>
      )}
      {refusal && (
        <PasskeyRefusal
          error={refusal}
          onRetry={() => void run()}
          testId="manual-sweep-refused"
          retryTestId="manual-sweep-retry"
        />
      )}
      {nudged && !l1.account && (
        <p role="alert" className="zkm-type-body-sm" data-testid="manual-sweep-connect-first">
          {copy.connectFirst}
        </p>
      )}
      {error && (
        <p
          className="zkm-type-body-sm"
          data-testid="manual-sweep-error"
          style={{ color: "var(--accent-red, #e5484d)", marginTop: 6 }}
        >
          {error}
        </p>
      )}
    </div>
  )
}

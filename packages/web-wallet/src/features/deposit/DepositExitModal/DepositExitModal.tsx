import { Modal } from "../../../ui/Modal"
import { shortL1Addr } from "../../../ui/format"
/**
 * The two exits from a deposit the relayer has not moved, behind one surface: finish the sweep
 * yourself (funds continue into the private balance, the deposit fee comes back) or recover
 * (`recoverERC20` / `recoverETH` sends them back out to an L1 address). A stuck deposit offers both, sweep first;
 * one no sweep can ever move offers recovery alone.
 *
 * In a browser the connected wallet both pays and is paid; in the desktop launcher there is no
 * injected wallet, so the paid address is typed and the transaction is approved on a helper page in
 * the user's default browser.
 */
import { useEffect, useRef, useState } from "react"
import { isAddress, type Address, type Hex } from "viem"
import {
  depositAmounts,
  sipaSweepAllowed,
  type SIPADepositRecord,
  type SipaFundingToken,
  useResource,
  WalletError,
} from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../../config/env"
import { showErrorModal, showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../../lib/analytics"
import { passkeyTelemetry } from "../../../lib/passkeyTelemetry"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { HashRow, l1TxUrl, whenLabel } from "../../../ui/detailRows"
import { useCopy } from "../../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { isGateCancelled, useCeremonyGate } from "../../identity/ceremonyGate"
import { PasskeyRefusal, type RefusalState } from "../../identity/PasskeyRefusal"
import {
  isPasskeyCancelled,
  isPasskeyPolicyError,
  type PasskeyAttemptHandle,
} from "@obsidion/passkey-web"
import { GateStep } from "../../identity/PhoneSteps"
import { reusePasskeyAccount } from "../../onboarding/oxideOnboarding"
import { reloadIfSessionSwitched } from "../../onboarding/sessionReload"
import { canManualRegistrationSweep, type RecoveryReason } from "@obsidion/front-core"
import { manualRegistrationSweep } from "../../onboarding/registrationSweep"
import { registrationRecordForSipa } from "../../onboarding/webRegistration"
import { isWalletRejection, useL1Wallet } from "../l1Wallet"
import { recoverDeposit, type L1ExitStage } from "../sipaRecovery"
import { AlreadySweptError, selfSweep, SweepRefusedError } from "../sipaSweep"
import { unsweepableCopy } from "../unsweepableCopy"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "../walletPrompt"
import { DepositProcessingNotice } from "../DepositProcessingNotice"
import { useSipaProcessing } from "../sipaProcessing"
import { heldDepositLine } from "../processingCopy"
import { PendingLimitsLink } from "../../limits/AboutLimitsSheet"
import {
  settlementDecimals,
  settlementSymbol,
  settlementToken,
  useDepositTokens,
} from "../loadDepositFacts"
import { useRowTxAmountCap } from "../../token/useTxAmountCap"
import { useSession } from "../../../platform/session"
import styles from "./DepositExitModal.module.css"
import copy from "./DepositExitModal.copy"
import { fmt } from "../../../lib/fmt"

/** Which exit the user is running. */
type ExitAction = "sweep" | "recover"

const STAGE_LABEL: Record<ExitAction, Record<L1ExitStage, string>> = {
  sweep: {
    "signing": copy.stage.sweep.signing,
    "awaiting-browser": copy.stage.sweep.browser,
    "confirming": copy.stage.confirming,
  },
  recover: {
    "signing": copy.stage.recover.signing,
    "awaiting-browser": copy.stage.recover.browser,
    "confirming": copy.stage.confirming,
  },
}

/** How long the deposit has been waiting: "12m" under the hour, "3h 05m" over it. */
export function waitedLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours
    ? fmt(copy.waited.hours, { hours, minutes: String(minutes % 60).padStart(2, "0") })
    : fmt(copy.waited.minutes, { minutes })
}

export function DepositExitModal({
  record,
  reason,
  canSweep: offered,
  sweepable = false,
  stranded,
  onRecovered,
  onClose,
}: {
  record: SIPADepositRecord
  /** The recovery exit's grounds, or null when only the sweep is on offer. */
  reason: RecoveryReason | null
  /** Whether the sheet opens with the sweep on offer. */
  canSweep: boolean
  /** A sweep could land but for capacity: a recovery sheet offers it once a read clears that. */
  sweepable?: boolean
  /** A token named in Settings, with its balance at the address; the sheet recovers it. */
  stranded?: { token: SipaFundingToken; balance: string }
  /** Called with the recovery's hash once its receipt confirms it; never after a sweep. */
  onRecovered?: (hash: Hex) => void
  onClose: () => void
}) {
  const config = getConfig()
  const depositTokens = useDepositTokens()
  const settled = settlementSymbol(depositTokens, record.tokenAddress, record.tokenSymbol)
  const txAmountCap = useRowTxAmountCap(settlementToken(depositTokens, record.tokenAddress))
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const obsidionWallet = useResource(useSession().wallet)
  const { copied, copy: copyLink } = useCopy()
  // Routes the sweep action; see registrationRecordForSipa for why registration SIPAs differ.
  const registration = registrationRecordForSipa(record.sipaAddress)

  const [destination, setDestination] = useState("")
  const [phase, setPhase] = useState<"form" | "working" | "done">("form")
  const { gate, state: gateState, cancel: cancelGate } = useCeremonyGate()
  // Leaving the sheet ends a registration sign-in wherever it is, prompt or held key, before it
  // sweeps, and closes the passkey attempt it was reported as.
  const attemptRef = useRef<PasskeyAttemptHandle | undefined>(undefined)
  const op = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      attemptRef.current?.unmounted()
      cancelGate()
      op.current?.abort()
    },
    [cancelGate],
  )
  const [refusal, setRefusal] = useState<RefusalState>()
  const [action, setAction] = useState<ExitAction>(offered ? "sweep" : "recover")
  const [stage, setStage] = useState<L1ExitStage>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()
  const [refused, setRefused] = useState<string>()
  const [nudged, setNudged] = useState(false)
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(phase === "working" && stage === "signing")
  // Back to the form; the transaction the wallet still holds is handled when it answers.
  const cancelPrompt = () => {
    prompt.cancel()
    setStage(undefined)
    setPhase("form")
  }
  const {
    state: processingState,
    shown: processing,
    capacityKey,
  } = useSipaProcessing(record.sipaAddress)
  // Capacity gates the sweep live; recovery never waits on it.
  const sweepBlocked = !sipaSweepAllowed(processingState)
  // Only a live state with no blocker counts; a swept or settled deposit has no state at all.
  const sweepCleared = sweepable && processingState !== undefined && !sweepBlocked
  const recoveryStarted = useRef(false)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (sweepCleared && phase === "form" && !recoveryStarted.current) setRevealed(true)
  }, [sweepCleared, phase])
  const canSweep = offered || revealed

  const typedValid = isAddress(destination)
  const target = bridgeMode ? (typedValid ? (destination as Address) : null) : l1.account
  // The paid address — the connected account or the typed destination — is screened like the
  // deposit source and withdrawal recipient are.
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "deposit-exit")
  const gross = depositAmounts(
    record,
    settlementDecimals(depositTokens, record.tokenAddress),
  ).grossDisplay
  const amount = stranded
    ? `${stranded.balance} ${stranded.token.symbol}`
    : `${gross} ${record.tokenSymbol}`
  const ready = !!target && (bridgeMode || !l1.wrongChain) && cleared
  // Held only for the wallet: the exits look disabled but a click says what to do first.
  const needsWallet = !bridgeMode && (!l1.account || l1.wrongChain)
  const heldClass = needsWallet ? "zkm-primary-btn--disabled" : undefined
  const press = (next: ExitAction) => (needsWallet ? setNudged(true) : void submit(next))
  const paidLabel = canSweep ? copy.paid.tip : copy.paid.recovered
  // A deposit a sweep can still land on is waiting; an unsweepable one is in a permanent state.
  const waiting = canSweep || reason === "stuck"
  // The notice says no sweep can move it; the stuck copy says one may yet land.
  const permanent =
    processingState?.blocker?.kind === "ceiling" ||
    processingState?.blocker?.kind === "operation-cap"

  // Names the buttons a missing or mis-chained wallet holds disabled.
  const heldExits =
    canSweep && reason
      ? copy.heldExits.both
      : canSweep
      ? copy.heldExits.sweep
      : copy.heldExits.recover

  const submit = async (next: ExitAction) => {
    if (!ready) return
    if (prompt.openElsewhere) {
      setRefused(prompt.openElsewhere)
      return
    }
    if (next === "recover") recoveryStarted.current = true
    setAction(next)
    setRefusal(undefined)
    setRefused(undefined)
    setPhase("working")
    setStage(undefined)
    setNotice(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    let request: WalletPromptToken | undefined
    const opts = {
      destination: bridgeMode ? (destination as Address) : undefined,
      from: l1.account ?? undefined,
      onHelperOpened: setSubmitUrl,
      // Confirming means the wallet answered; the slot frees before the receipt lands.
      onStage: (next: L1ExitStage) => {
        setStage(next)
        if (next === "confirming") prompt.settle(request)
      },
      stranded: stranded?.token,
    }
    // One passkey assertion recovers the keys the registration sweep re-derives and signs with.
    // The registration is re-read at submit: the detection tick can settle it (swept, failed_taken)
    // while the sheet is open, and a stale record would sign a doomed sweep.
    const runRegistrationSweep = async () => {
      if (!obsidionWallet) throw new WalletError("wallet.notReady")
      const reg = registrationRecordForSipa(record.sipaAddress)
      if (!reg || !canManualRegistrationSweep(reg))
        throw new WalletError("deposit.registrationMoved")
      op.current?.abort()
      op.current = new AbortController()
      const signal = op.current.signal
      const signIn = passkeyTelemetry.begin({ ceremony: "unlock", flow: "deposit" })
      attemptRef.current = signIn
      const keys = await signIn.run((own) =>
        reusePasskeyAccount(obsidionWallet, reg.l2Address, undefined, gate, signal, own),
      )
      // The page is reloading: nothing settles before it goes.
      if (reloadIfSessionSwitched(null, reg.l2Address)) return new Promise<never>(() => {})
      return manualRegistrationSweep(reg, { keys, ...opts, onNotice: setNotice })
    }
    try {
      request = prompt.begin()
      const hash =
        next === "recover"
          ? await recoverDeposit(record, opts)
          : registration
          ? await runRegistrationSweep()
          : await selfSweep(record, opts)
      setTxHash(hash)
      setPhase("done")
      if (next === "recover") onRecovered?.(hash)
      // Reason and timing only — the paid address is as identifying as the deposit address.
      if (next === "sweep")
        fireEvent("deposit_self_swept", {
          duration_ms: elapsed(),
          reason: registration ? "registration" : "stuck",
        })
      else fireEvent("deposit_recovered", { duration_ms: elapsed(), reason: reason ?? "stuck" })
    } catch (e) {
      setPhase("form")
      if (e instanceof WalletPromptOpenError) {
        setRefused(e.message)
        return
      }
      if (prompt.cancelled(request)) return
      if (isGateCancelled(e) || isPasskeyCancelled(e) || isWalletRejection(e)) return
      const scope = next === "sweep" ? "deposit:self-sweep" : "deposit:recover"
      fireEvent("action_failed", { action: scope, code: failureCode(e) })
      if (isPasskeyPolicyError(e)) {
        setRefusal({ name: e.name, message: e.message })
        return
      }
      if (e instanceof SweepRefusedError) {
        setRefused(e.message)
        return
      }
      if (e instanceof AlreadySweptError) {
        onClose()
        showErrorModal({
          title: copy.errors.alreadySwept,
          message: e.message, // slice-check-ignore: the error's own words, as before; only the title moved
        })
        return
      }
      showReportableError(
        e,
        next === "sweep"
          ? registration
            ? "registration:sweep"
            : "deposit:sweep"
          : "deposit:recovery",
        {
          title: next === "sweep" ? copy.errors.sweep : copy.errors.recovery,
        },
      )
    } finally {
      prompt.settle(request)
    }
  }

  const title =
    phase === "done"
      ? action === "sweep"
        ? copy.title.onItsWay
        : copy.title.recovered
      : canSweep
      ? copy.title.tooLong
      : stranded
      ? fmt(copy.title.recoverToken, { symbol: stranded.token.symbol })
      : copy.title.recover

  return (
    <Modal variant="bare" label={copy.label} onClose={phase === "working" ? undefined : onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          {title}
        </span>
        {phase !== "working" && (
          <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={onClose} />
        )}
      </div>

      {phase === "form" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {refusal && (
            <PasskeyRefusal
              error={refusal}
              onRetry={() => void submit(action)}
              testId="deposit-refused"
              retryTestId="deposit-retry"
            />
          )}
          {processing && (
            <DepositProcessingNotice
              sipaAddress={record.sipaAddress}
              state={processing}
              symbol={settled}
              help={(detail) => (
                <PendingLimitsLink
                  sipaAddress={record.sipaAddress}
                  capacityKey={capacityKey}
                  settlementSymbol={settled}
                  detail={detail}
                />
              )}
            />
          )}
          <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {canSweep
              ? sweepBlocked
                ? copy.sweepSummary
                : fmt(copy.sweepYourself, {
                    summary: copy.sweepSummary,
                    privacy: copy.selfSweepPrivacy,
                  })
              : reason === "registration-quote"
              ? copy.registrationQuote
              : reason === "unsweepable"
              ? unsweepableCopy(
                  record,
                  txAmountCap,
                  settlementDecimals(depositTokens, record.tokenAddress),
                )
              : stranded
              ? copy.stranded
              : permanent
              ? copy.unsweepableRecover
              : copy.stuck}
          </p>
          {canSweep && (
            <details className={styles.exitMore} data-testid="sweep-details">
              <summary>{copy.howSweepWorks}</summary>
              <p>
                {fmt(registration ? copy.registrationSweepDetail : copy.sweepDetail, {
                  shared: copy.sweepShared,
                })}
              </p>
            </details>
          )}

          {bridgeMode ? (
            <>
              <TextField
                label={copy.address.label}
                placeholder={copy.address.placeholder}
                autoFocus
                className="ww-autofocus"
                value={destination}
                onChange={setDestination}
                error={destination && !typedValid ? copy.address.invalid : undefined}
              />
              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                {canSweep ? copy.address.tipNote : copy.address.fundsNote}
              </span>
            </>
          ) : !l1.account ? (
            <>
              <PrimaryGradientButton
                title={l1.connecting ? copy.connecting : copy.connect}
                isLoading={l1.connecting}
                onClick={l1.connect}
              />
              <span
                style={{ color: "var(--text-secondary)", fontSize: 12 }}
                data-testid="exit-needs-wallet"
              >
                {fmt(copy.needsConnect, { exits: heldExits })}
              </span>
            </>
          ) : l1.wrongChain ? (
            <>
              <PrimaryGradientButton
                title={
                  l1.connecting
                    ? copy.switching
                    : fmt(copy.switchTo, { chain: config.l1Chain.name })
                }
                buttonStyle="dark"
                isLoading={l1.connecting}
                onClick={l1.switchNetwork}
              />
              <span
                style={{ color: "var(--text-secondary)", fontSize: 12 }}
                data-testid="exit-needs-wallet"
              >
                {fmt(copy.needsSwitch, { exits: heldExits, chain: config.l1Chain.name })}
              </span>
            </>
          ) : null}

          {target && !cleared && (
            <ScreeningNotice
              verdict={verdict}
              checkingCopy={copy.screening.checking}
              blockedFallback={copy.screening.blocked}
              errorCopy={bridgeMode ? copy.screening.errorAddress : copy.screening.errorWallet}
              onRetry={rescreen}
            />
          )}

          <div>
            <ConfirmationSheetDetailRow label={copy.rows.amount} value={amount} />
            {waiting && (
              <>
                <ConfirmationSheetDetailRow
                  label={copy.rows.started}
                  value={whenLabel(record.startTime)}
                />
                <ConfirmationSheetDetailRow
                  label={copy.rows.waiting}
                  value={waitedLabel(Date.now() - record.startTime)}
                />
              </>
            )}
            <ConfirmationSheetDetailRow
              label={copy.rows.address}
              value={shortL1Addr(record.sipaAddress)}
            />
            <ConfirmationSheetDetailRow
              label={paidLabel}
              value={target ? shortL1Addr(target) : "—"}
            />
            <ConfirmationSheetDetailRow
              label={copy.rows.network}
              value={l1ChainFor(config.l1ChainId).name}
            />
          </div>

          {nudged && needsWallet && (
            <p
              role="alert"
              className="ww-sheet__note"
              style={{ textAlign: "center" }}
              data-testid="exit-connect-first"
            >
              {l1.account
                ? fmt(copy.switchFirst, { chain: config.l1Chain.name })
                : copy.connectFirst}
            </p>
          )}
          {refused && (
            <p role="alert" className="ww-sheet__note" data-testid="deposit-sweep-refused">
              {refused}
            </p>
          )}
          {canSweep && !refusal && (
            <>
              <PrimaryGradientButton
                title={copy.sweepNow}
                isDisabled={(!ready && !needsWallet) || sweepBlocked}
                className={heldClass}
                onClick={() => press("sweep")}
              />
              {sweepBlocked && (
                <p className={styles.exitHeld} data-testid="sweep-held">
                  {heldDepositLine(processingState)}
                </p>
              )}
              <p className={styles.exitGas} data-testid="sweep-gas">
                {copy.sweepGas}
              </p>
            </>
          )}
          {reason && (
            <>
              {canSweep && (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  {copy.recoverSecondary}
                </p>
              )}
              <PrimaryGradientButton
                title={
                  canSweep
                    ? copy.recoverToAddress
                    : target
                    ? fmt(copy.recoverTo, { address: shortL1Addr(target) })
                    : copy.recover
                }
                buttonStyle={canSweep ? "dark" : undefined}
                isDisabled={!ready && !needsWallet}
                className={heldClass}
                onClick={() => press("recover")}
              />
            </>
          )}
        </div>
      )}

      {phase === "working" && gateState.kind === "awaiting-action" && (
        <GateStep
          state={gateState}
          onCancel={() => {
            attemptRef.current?.userCancelled()
            cancelGate()
          }}
        />
      )}
      {phase === "working" && gateState.kind !== "awaiting-action" && (
        <div style={{ padding: "24px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Spinner size={20} />
            <span style={{ fontSize: 15 }}>
              {stage ? STAGE_LABEL[action][stage] : notice ?? copy.preparing}
            </span>
          </div>
          {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />}
          {stage === "awaiting-browser" && submitUrl && (
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 13,
                lineHeight: 1.5,
                margin: "12px 0 0 32px",
              }}
            >
              {copy.browser.opened} <span style={{ fontFamily: "monospace" }}>{submitUrl}</span>
              {copy.browser.missing}{" "}
              <span
                role="button"
                onClick={() => copyLink(submitUrl)}
                style={{ color: "var(--accent-green, #6c9)", cursor: "pointer" }}
              >
                {copied ? copy.browser.copied : copy.browser.copy}
              </span>{" "}
              {copy.browser.openThere}
            </p>
          )}
        </div>
      )}

      {phase === "done" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ textAlign: "center", padding: "16px 0 0" }}>
            <DoubleCheckIcon size={40} />
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 14,
                lineHeight: 1.45,
                margin: "12px 0 0",
              }}
            >
              {action === "sweep"
                ? registration
                  ? fmt(copy.done.registration, { amount })
                  : fmt(copy.done.sweep, { amount })
                : fmt(copy.done.recovered, {
                    amount,
                    target: target ? shortL1Addr(target) : copy.done.yourWallet,
                  })}
            </p>
          </div>
          {txHash && <HashRow label={copy.done.tx} hash={txHash} url={l1TxUrl(txHash)} />}
          <PrimaryGradientButton title={copy.done.action} onClick={onClose} />
        </div>
      )}
    </Modal>
  )
}

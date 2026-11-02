import { useEffect, useRef, useState } from "react"
import { Icon, IconCircle, PrimaryGradientButton, Spinner, StatusBadge } from "@obsidion/web-ds"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  cancelRotation,
  cancellable,
  fundingLanding,
  fundRotation,
  moveDeclined,
  moveProgress,
  noteRecovery,
  recordMoved,
  RotationFlowError,
  signRotation,
  type BackupRotationRecord,
  type FlowRefusal,
} from "@obsidion/front-core"
import { passkeyWritten } from "@obsidion/passkey-web"
import { BackupCredentialIdLengthError, RotationRouteNotLiveError } from "@obsidion/sdk"
import { formatUnits } from "viem"
import { l1AddressUrl, l1TxUrl, whenLabel } from "../../ui/detailRows"
import { shortAddr, tokenFigure } from "../../ui/format"
import { DepositFact } from "../../ui/screens/DepositFact"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow"
import { DepositExitModal } from "../deposit/DepositExitModal/DepositExitModal"
import { DepositReadError, EmptyDepositError } from "../deposit/depositReadErrors"
import type { StrandedToken } from "../deposit/sipaRecovery"
import { BackupStepError, LeftoverPasskeyError, passkeyDeclined } from "./backupPasskeyAdd"
import {
  approveCopy,
  attentionCopy,
  entryCopy,
  fundCopy,
  moveCopy,
  panelCopy,
  recoveryCopy,
  recoveryState,
  rotationSteps,
  stepDetail,
  stepIndex,
  type NamedLine,
  type RecoveryState,
} from "./backupPasskeyCopy"
import type { BackupFlowDeps } from "./backupPasskeyRuntime"
import { getRotationDriver, useRotationDrive } from "./rotationDrive"
import "./backupPasskey.css"

export const formatDai = (atomic: bigint) =>
  tokenFigure(formatUnits(atomic, DEFAULT_DECIMALS), "DAI")

/**
 * Logs a failure by its name and, for a step the record refused, its code. No message, cause or
 * field reaches the console: the driver's and the flow's errors are not a secrecy boundary.
 */
export function warnFailure(what: string, error: unknown): void {
  if (error instanceof LeftoverPasskeyError)
    return warnFailure(`${what} after creation`, error.cause)
  const name = error instanceof Error ? error.name : typeof error
  const code =
    error instanceof BackupStepError || error instanceof RotationFlowError ? ` ${error.code}` : ""
  console.warn(`[backup-passkey] ${what}: ${name}${code}`)
}

/**
 * What an action's failure says, in the user's terms, with the leftover line once when a passkey
 * was written before the failure: by the driver's own marker, or by a step after it returned.
 */
export function errorLine(error: unknown): string {
  if (error instanceof LeftoverPasskeyError)
    return `${failureLine(error.cause)} ${panelCopy.leftoverPasskey}`
  const line = failureLine(error)
  return written(error) ? `${line} ${panelCopy.leftoverPasskey}` : line
}

function written(error: unknown): boolean {
  try {
    return passkeyWritten(error)
  } catch {
    return false
  }
}

/** What a refusal of the flow's says; `phase` and `gone` are shown by the record itself. */
const refusalLine: Partial<Record<FlowRefusal, string>> = {
  "funding-open": panelCopy.fundingOnItsWay,
  "not-cancellable": panelCopy.notCancellable,
}

function failureLine(error: unknown): string {
  if (error instanceof DepositReadError) return error.message
  if (error instanceof RotationRouteNotLiveError) return panelCopy.routeNotLive
  if (error instanceof BackupCredentialIdLengthError) return panelCopy.credentialIdTooLong
  if (error instanceof RotationFlowError && refusalLine[error.code]) return refusalLine[error.code]!
  return passkeyDeclined(error) ? panelCopy.declined : panelCopy.unverifiable
}

function Named({ line: [before, name, after] }: { line: NamedLine }) {
  return (
    <>
      {before}
      {name && <b>{name}</b>}
      {after}
    </>
  )
}

function Steps({
  record,
  approver,
  waiting,
}: {
  record: BackupRotationRecord
  approver?: string
  /** The line for a step that waits on the user, in place of the step's own. */
  waiting?: string
}) {
  const current =
    record.phase === "attention" || record.phase === "conflict" ? -1 : stepIndex(record)
  const detail =
    waiting ??
    (record.phase === "created" ? (
      <Named line={approveCopy.detail(approver)} />
    ) : (
      stepDetail(record)
    ))
  return (
    <ol className="ww-backup__steps" aria-label="Backup passkey steps">
      {rotationSteps.map((label, i) => {
        const state = current > i ? "done" : current === i ? "current" : "todo"
        return (
          <li
            key={label}
            className={`zkm-step-row ww-backup__step ww-backup__step--${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="zkm-step-row__bullet">
              {state === "done" ? (
                <Icon name="check" size={14} color="var(--accent-green)" />
              ) : (
                i + 1
              )}
            </span>
            <span className="zkm-step-row__text">
              <span className="ww-backup__step-label">{label}</span>
              {state === "current" && detail && <span className="ww-backup__detail">{detail}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function FundScreen({
  record,
  busy,
  onFund,
  onCancel,
}: {
  record: BackupRotationRecord
  busy: boolean
  onFund: () => void
  onCancel: () => void
}) {
  const plan = record.plan!
  const amount = BigInt(plan.fundingAmount)
  const credited = BigInt(plan.credited)
  return (
    <div className="ww-backup__fund" data-testid="backup-fund">
      <div className="ww-sheet__facts">
        <DepositFact label={fundCopy.destination}>
          <b>{shortAddr(plan.address)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.fees}>
          <b>{formatDai(amount - credited)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.approvals}>
          <b>{fundCopy.approvalsValue(plan.approvals, plan.moves)}</b>
        </DepositFact>
        <DepositFact label={fundCopy.takes}>
          <b>{fundCopy.takesValue}</b>
        </DepositFact>
        <hr className="ww-divider" />
        <DepositFact label={fundCopy.receive}>
          <b>{formatDai(credited)}</b>
        </DepositFact>
      </div>
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={fundCopy.fund}
          isLoading={busy}
          onClick={onFund}
          testId="backup-fund-continue"
        />
        <SecondaryButton label={panelCopy.cancel} onClick={onCancel} disabled={busy} />
      </div>
      <p className="ww-sheet__note ww-backup__fine">{fundCopy.afterSend}</p>
    </div>
  )
}

/** An address or a hash, linked to its explorer where the L1 has one. */
function ExplorerValue({ value, url }: { value: string; url?: string }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {shortAddr(value)}
      <Icon name="share-box" size={12} color="currentColor" />
    </a>
  ) : (
    <b>{shortAddr(value)}</b>
  )
}

/** The card's own action, sized like the Activity row's so the card reads as one object. */
function CardAction({
  label,
  busy,
  onClick,
  testId,
}: {
  label: string
  busy: boolean
  onClick: () => void
  testId: string
}) {
  // The action bar wrapper gives the button its height: alone in the card's column, its flex basis
  // of 0 would collapse it.
  return (
    <div className="zkm-activity-row__actions">
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable zkm-activity-action zkm-activity-action--gradient"
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={busy ? label : undefined}
        onClick={onClick}
        data-testid={testId}
      >
        {busy ? <Spinner size={16} color="#fff" /> : label}
      </button>
    </div>
  )
}

const RECOVERY_BADGE = { held: "failed", sent: "pending", recovered: "cancelled" } as const

/**
 * An attempt whose funding has to go back, shown in place of the steps: none of the five steps is
 * true of an attempt that will not add its backup. Once sent there is no main button, so it does not
 * read as "press again"; a link still recovers funding that lands later.
 */
function RecoveryCard({
  record,
  state,
  busy,
  empty,
  onRecover,
  onDone,
}: {
  record: BackupRotationRecord
  state: RecoveryState
  busy: boolean
  /** The address held nothing when the user last asked to recover it. */
  empty: boolean
  onRecover: () => void
  onDone: () => void
}) {
  // A funding that landed after the backup was added: the backup stands, only that funding is held.
  const extra = record.suspended === "done"
  const line =
    state !== "held"
      ? recoveryCopy.line[state]
      : extra
      ? recoveryCopy.line.extra
      : record.attention === "corrupt"
      ? recoveryCopy.line.damaged
      : recoveryCopy.line.held
  const sipa = record.rotation?.sipa
  const recovery = state !== "held" ? record.recovery?.txHash : undefined
  return (
    <div className="zkm-activity-row ww-backup__recovery" data-testid="backup-recovery">
      <div className="zkm-activity-row__top">
        <IconCircle name="shield-exclamation" size={44} />
        <div className="zkm-activity-row__who">
          <span className="zkm-activity-row__name">
            {extra ? recoveryCopy.extraTitle : recoveryCopy.title}
          </span>
          <span className="zkm-activity-row__time">
            {extra ? recoveryCopy.extraSubtitle : recoveryCopy.started(whenLabel(record.createdAt))}
          </span>
        </div>
        <StatusBadge label={recoveryCopy.badge[state]} badgeStyle={RECOVERY_BADGE[state]} />
      </div>
      <p className="ww-backup__recovery-line">{line}</p>
      <div className="ww-backup__recovery-facts">
        {record.plan?.deposited && (
          <DepositFact label={recoveryCopy.funding}>
            <b>{formatDai(BigInt(record.plan.deposited))}</b>
          </DepositFact>
        )}
        {recovery ? (
          <DepositFact label={recoveryCopy.recovery}>
            <ExplorerValue value={recovery} url={l1TxUrl(recovery)} />
          </DepositFact>
        ) : (
          sipa && (
            <DepositFact label={recoveryCopy.depositAddress}>
              <ExplorerValue value={sipa} url={l1AddressUrl(sipa)} />
            </DepositFact>
          )
        )}
      </div>
      {state === "held" && (
        <>
          <p className="ww-backup__recovery-note" aria-live="polite">
            {empty ? recoveryCopy.nothingYet : recoveryCopy.gas}
          </p>
          <CardAction
            label={recoveryCopy.recover}
            busy={busy}
            onClick={onRecover}
            testId="backup-recover"
          />
        </>
      )}
      {state === "sent" && (
        // The link stays after an empty check: funding that lands later keeps the same recovery, so
        // the empty note would never clear on its own.
        <p className="ww-backup__recovery-note" aria-live="polite">
          {empty ? (
            <span className="ww-backup__recovery-checked">
              <Icon name="check-circle" size={14} color="currentColor" />
              {recoveryCopy.nothingNew}
            </span>
          ) : (
            recoveryCopy.later
          )}{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            onClick={onRecover}
            disabled={busy}
            data-testid="backup-recover-later"
          >
            {recoveryCopy.checkAddress}
          </button>
        </p>
      )}
      {state === "recovered" && (
        <CardAction label={recoveryCopy.done} busy={busy} onClick={onDone} testId="backup-done" />
      )}
    </div>
  )
}

/** A step's way out, under its primary action. */
function SecondaryButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <PrimaryGradientButton
      title={label}
      buttonStyle="dark"
      isDisabled={disabled}
      onClick={onClick}
    />
  )
}

/**
 * A pending rotation from its saved record: the step it is on, what the user can do there, and
 * the side states. The session's driver resumes it; the panel shows the driver's answer and runs
 * the steps the user taps, the move's passkey prompts included. A declined move prompt waits for
 * the user's Try again.
 */
export function BackupPasskeyPanel({
  record,
  deps,
  approver,
  onCancelled,
  onFinished,
}: {
  record: BackupRotationRecord
  deps: BackupFlowDeps
  /** The approving passkey's custom or manager name; unnamed where it has neither. */
  approver?: string
  /** The attempt was dropped; the caller shows the leftover-passkey line. */
  onCancelled: () => void
  onFinished: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<{ error: unknown; approving: boolean }>()
  const [recovering, setRecovering] = useState<StrandedToken>()
  // The recovery the address was found empty under, so the note clears once another is sent.
  const [emptyUnder, setEmptyUnder] = useState<string>()
  const drive = useRotationDrive(record.owner)
  // Closing the panel withdraws its taps: a send that has not asked for the passkey yet stops.
  const open = useRef<AbortController>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    open.current = controller
    return () => controller.abort()
  }, [])

  const run = async (step: () => Promise<unknown>, approving = false) => {
    setBusy(true)
    setStepError(undefined)
    try {
      await step()
    } catch (err) {
      if (recordMoved(err)) return
      warnFailure("step failed", err)
      setStepError({ error: err, approving })
    } finally {
      setBusy(false)
    }
  }

  // An answer for another attempt is not shown.
  const resume = drive?.record.attemptId === record.attemptId ? drive.resume : undefined
  const wait = resume?.wait
  const approving = drive?.approving ?? false
  const checking = record.phase !== "created" && resume === undefined
  // Only once the driver answers `declined`: an earlier chunk in flight comes first.
  const declinedMove = moveDeclined(record) && wait === "declined"
  // Worded here so a declined approval names the approver as it stands. A wrong passkey ends the
  // prompt the way a closed one does.
  const stepLine =
    stepError &&
    (stepError.approving && passkeyDeclined(stepError.error) ? (
      <Named line={approveCopy.declined(approver)} />
    ) : (
      errorLine(stepError.error)
    ))
  const error =
    stepLine ??
    (declinedMove
      ? panelCopy.declined
      : resume?.error === undefined
      ? undefined
      : errorLine(resume.error))
  const driver = getRotationDriver()
  const checkAgain = () => {
    setStepError(undefined)
    driver.check(record.owner)
  }
  const cancel = () =>
    run(async () => {
      await cancelRotation(deps, record)
      onCancelled()
    })
  const retry = () => run(() => driver.retry(record.owner, open.current?.signal))
  const approveMove = () => run(() => driver.approve(record.owner, open.current?.signal))
  const recovery = recoveryState(record)
  const recoveryKey = record.recovery?.txHash ?? "held"
  const recover = () =>
    run(async () => {
      setEmptyUnder(undefined)
      let found: StrandedToken
      try {
        found = await deps.strandedDeposit(record)
      } catch (err) {
        // Nothing to recover is not a failure: the card says so in its own neutral line.
        if (err instanceof EmptyDepositError) return setEmptyUnder(recoveryKey)
        throw err
      }
      setRecovering(found)
    })
  const finish = () =>
    run(async () => {
      await deps.store.remove(record.owner)
      onFinished()
    })

  const landing = record.fundings.some(fundingLanding)
  // The error is part of the line where the step itself is the check.
  let errorInline = false
  let body: React.ReactNode
  if (recovery) {
    body = (
      <RecoveryCard
        record={record}
        state={recovery}
        busy={busy}
        empty={emptyUnder === recoveryKey}
        onRecover={recover}
        onDone={finish}
      />
    )
  } else if (record.phase === "created") {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={busy ? panelCopy.approving : approveCopy.button(approver)}
          isLoading={busy}
          onClick={() =>
            run(async () => signRotation(deps, record, await deps.prepare(record)), true)
          }
          testId="backup-approve"
        />
        <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
      </div>
    )
  } else if (record.phase === "signed" && record.rotation) {
    body = (
      <>
        <BroadcastStatusRow address={record.rotation.sipa.toLowerCase()} />
        <div className="ww-backup__actions">
          {error && (
            <PrimaryGradientButton
              title={panelCopy.tryAgain}
              isLoading={checking}
              onClick={checkAgain}
              testId="backup-watch-retry"
            />
          )}
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        </div>
      </>
    )
  } else if (record.phase === "published" && !landing) {
    if (wait === "funding") {
      body = (
        <FundScreen
          record={record}
          busy={busy}
          onFund={() => run(() => fundRotation(deps, record))}
          onCancel={cancel}
        />
      )
    } else {
      errorInline = true
      body = (
        <>
          <p className="ww-sheet__note" aria-live="polite">
            {error ? (
              <>
                {error}{" "}
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit__link"
                  onClick={checkAgain}
                >
                  {panelCopy.tryAgain}
                </button>
              </>
            ) : (
              entryCopy.checking
            )}
          </p>
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        </>
      )
    }
  } else if (record.phase === "done") {
    body = (
      <>
        <p className="ww-sheet__note">{panelCopy.doneLine}</p>
        <PrimaryGradientButton title={panelCopy.done} onClick={finish} testId="backup-done" />
      </>
    )
  } else if (record.phase === "conflict") {
    body = (
      <>
        <p className="ww-sheet__note">{panelCopy.conflict}</p>
        {cancellable(record) && (
          <SecondaryButton label={panelCopy.startOver} onClick={cancel} disabled={busy} />
        )}
      </>
    )
  } else if (record.phase === "attention" && record.attention && record.attention !== "stranded") {
    const copy = attentionCopy(record.attention, record)
    // A recheck that could not complete says so; the parked verdict is not repeated as current.
    errorInline = record.attention === "route"
    const line = errorInline && error ? panelCopy.unverifiable : copy.line
    body = (
      <>
        <p className="ww-sheet__note">{line}</p>
        <div className="ww-backup__actions">
          {copy.actions.map((action) =>
            action === "checkAgain" ? (
              <PrimaryGradientButton
                key={action}
                title={panelCopy.checkAgain}
                isLoading={busy || checking}
                onClick={checkAgain}
              />
            ) : action === "retry" ? (
              <PrimaryGradientButton
                key={action}
                title={panelCopy.tryAgain}
                isLoading={busy || checking || approving}
                onClick={retry}
                testId="backup-move-retry"
              />
            ) : (
              <SecondaryButton
                key={action}
                label={action === "cancel" ? panelCopy.cancel : panelCopy.startOver}
                onClick={cancel}
                disabled={busy}
              />
            ),
          )}
        </div>
      </>
    )
  } else if (declinedMove) {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={panelCopy.tryAgain}
          isLoading={busy || checking || approving}
          onClick={retry}
          testId="backup-move-retry"
        />
      </div>
    )
  } else if (wait === "approval" || approving) {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={busy || approving ? panelCopy.approving : approveCopy.button(approver)}
          isLoading={busy || approving}
          onClick={approveMove}
          testId="backup-move-approve"
        />
      </div>
    )
  } else if (error) {
    body = (
      <div className="ww-backup__actions">
        <PrimaryGradientButton
          title={panelCopy.tryAgain}
          isLoading={checking}
          onClick={checkAgain}
          testId="backup-watch-retry"
        />
        {cancellable(record) && (
          <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
        )}
      </div>
    )
  } else if (cancellable(record)) {
    body = <SecondaryButton label={panelCopy.cancel} onClick={cancel} disabled={busy} />
  }

  return (
    <section className="ww-contacts__section ww-backup" data-testid="backup-panel">
      <span className="ww-contacts__label">Backup passkey</span>
      {!recovery && (
        <Steps
          record={record}
          approver={approver}
          waiting={
            wait === "approval" || declinedMove ? moveCopy.line(moveProgress(record)) : undefined
          }
        />
      )}
      <p
        className="ww-search__error ww-backup__error"
        aria-live="assertive"
        data-testid="backup-error"
      >
        {errorInline ? undefined : error}
      </p>
      {body}
      {recovering && (
        <DepositExitModal
          record={recovering.record}
          reason="stranded"
          canSweep={false}
          stranded={recovering}
          onRecovered={(hash) => void run(() => noteRecovery(deps, record, hash))}
          onClose={() => setRecovering(undefined)}
        />
      )}
      {record.phase !== "created" && cancellable(record) && (
        <p className="ww-sheet__note ww-backup__fine">{panelCopy.approvalStays}</p>
      )}
    </section>
  )
}

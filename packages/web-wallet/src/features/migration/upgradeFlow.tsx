/** The upgrade's screens (Figma "Migration" page, LobEQ1bmcPDw0ahexKy1iI). */
import { useState, type ReactNode } from "react"
import { GradientSpinner, PrimaryGradientButton } from "@obsidion/web-ds"
import doneBadge from "../../assets/cutover/done-badge.png"
import { usdAtomicFloor } from "../../ui/format"
import { useWakeLock } from "../../ui/hooks"
import {
  chooseCopy,
  finishCopy,
  stoppedCopy,
  upgradeDoneCopy,
  upgradingCopy,
} from "../cutover/cutoverCopy"
import {
  Badge,
  BalanceCard,
  CutoverPage,
  DetailsCard,
  Eyebrow,
  Fact,
  Lead,
  Pills,
  TextButton,
  Title,
  type Step,
} from "../cutover/parts"
import { cutoverAccount } from "../cutover/account"
import { SLOW_AFTER_MS, useElapsed } from "../cutover/elapsed"
import { ChooseTransactions } from "../cutover/ChooseTransactions/ChooseTransactions"
import { ProgressScreen } from "../cutover/ProgressScreen"
import { LeaveSheet, MoveFundsSheet, WorkingSheet } from "../cutover/sheets"
import type { UpgradeRing } from "../cutover/upgradeProgress"

/** Where a run step stands. */
export type StepState = "done" | "active" | "todo" | "failed"

/** Spendable and Savings, in base units; undefined while not read. */
export interface UpgradeBalance {
  main?: bigint
  savings?: bigint
}

const usd = (amount: bigint | undefined) =>
  amount === undefined ? undefined : usdAtomicFloor(amount)

/** Undefined while not read, for a card that shows them loading. */
function amounts({ main, savings }: UpgradeBalance) {
  return {
    total: usd(main === undefined ? undefined : main + (savings ?? 0n)),
    spendable: usd(main),
    savings: usd(main === undefined ? undefined : savings ?? 0n),
  }
}

function figures(balance: UpgradeBalance) {
  const { total = "…", spendable = "…", savings = "…" } = amounts(balance)
  return { total, spendable, savings }
}

/** What the run moves, over its steps; nothing when it moves no funds. */
function moving({ balance, updateOnly }: { balance: UpgradeBalance; updateOnly?: boolean }) {
  return updateOnly ? undefined : { label: upgradingCopy.moving, value: figures(balance).total }
}

const account = cutoverAccount

const CHECK_SLOW_AFTER_MS = 30_000

const PILLS = [
  { icon: "bolt", label: chooseCopy.pills[0]! },
  { icon: "bolt", label: chooseCopy.pills[1]! },
  { icon: "arrow-up", label: chooseCopy.pills[2]! },
]

/**
 * The run's three steps; a waiting step says why. An upgrade that moves no funds has only the first,
 * the account's update, which stands where the whole run does.
 */
function runSteps(states: StepState[], waitReason?: string, updateOnly = false): Step[] {
  if (updateOnly) {
    const state = states.every((s) => s === "done")
      ? "done"
      : states.includes("failed")
      ? "failed"
      : "active"
    return stepsFor([state], upgradingCopy.steps.slice(0, 1), waitReason)
  }
  return stepsFor(states, upgradingCopy.steps, waitReason)
}

function stepsFor(states: StepState[], titles: readonly string[], waitReason?: string): Step[] {
  return titles.map((title, i) => {
    const state = states[i]!
    return {
      title,
      state: state === "todo" ? "pending" : state === "failed" ? "active" : state,
      failed: state === "failed",
      status:
        state === "done"
          ? upgradingCopy.done
          : state === "failed"
          ? upgradingCopy.didNotComplete
          : state === "active"
          ? waitReason ?? upgradingCopy.inProgress(2)
          : undefined,
    }
  })
}

/** 1 · Choose (Figma 350:23847 / 409:33893). */
export function UpgradeChoose(props: {
  balance: UpgradeBalance
  /** The account had open paylinks, which the upgrade refunds. */
  paylinks: boolean
  onUpgrade: () => void
  /** Absent while a stopped run holds the funds. */
  onWithdraw?: () => void
  /** The network has no proven checkpoint yet, so the upgrade waits until about `until`. */
  waiting?: { until: string }
  /** The check that offers the upgrade is still running, so neither choice can start yet. */
  checking?: boolean
  overlay?: ReactNode
}) {
  // A phone that sleeps suspends the run, so every migration screen keeps it awake.
  useWakeLock(true)
  const shown = amounts(props.balance)
  const { waiting } = props
  const [transactionsOpen, setTransactionsOpen] = useState(false)
  const checkingFor = useElapsed(!!props.checking)
  const slow = checkingFor !== undefined && checkingFor >= CHECK_SLOW_AFTER_MS
  return (
    <>
      <CutoverPage
        account={account()}
        testId="cutover-choose"
        footer={
          <div className="ww-cutover__actions">
            {props.checking && (
              <span className="ww-cutover__caption ww-cutover__checking" role="status">
                <GradientSpinner size={14} />
                <span>
                  {shown.total === undefined ? chooseCopy.reading : chooseCopy.preparing}
                  {slow && `. ${chooseCopy.slow}`}
                </span>
              </span>
            )}
            <PrimaryGradientButton
              title={chooseCopy.upgrade}
              isDisabled={!!waiting || !!props.checking}
              testId="cutover-upgrade"
              onClick={props.onUpgrade}
            />
            {props.onWithdraw && (
              <TextButton
                testId="cutover-withdraw"
                disabled={props.checking}
                onClick={props.onWithdraw}
              >
                {chooseCopy.withdraw}
              </TextButton>
            )}
          </div>
        }
      >
        <Title>{waiting ? chooseCopy.waitingTitle(waiting.until) : chooseCopy.title}</Title>
        <BalanceCard
          label={chooseCopy.balance}
          {...shown}
          note={waiting ? chooseCopy.waitingNote : props.paylinks ? chooseCopy.note : undefined}
          noteAction={
            !waiting && props.paylinks
              ? {
                  label: chooseCopy.seeTransactions,
                  testId: "cutover-see-transactions",
                  onClick: () => setTransactionsOpen(true),
                }
              : undefined
          }
          stamp={waiting ? chooseCopy.waitingStamp : chooseCopy.stamp}
        />
        <Pills items={PILLS} />
      </CutoverPage>
      {transactionsOpen && <ChooseTransactions onClose={() => setTransactionsOpen(false)} />}
      {props.overlay}
    </>
  )
}

/** 2 · Sign: the sheet over 1 or S1. */
export function UpgradeSign(props: {
  balance: UpgradeBalance
  /** Passkey approvals the upgrade asks for, and how many a stopped run saved. */
  approvals: { approved: number; total: number }
  /** The figures are not read yet, or another flow runs. */
  disabled: boolean
  updateOnly?: boolean
  onSign: () => void
  onClose: () => void
}) {
  useWakeLock(true)
  return (
    <MoveFundsSheet
      figures={props.updateOnly ? undefined : figures(props.balance)}
      approvals={props.approvals.total - props.approvals.approved}
      disabled={props.disabled}
      onConfirm={props.onSign}
      onClose={props.onClose}
    />
  )
}

/** 3 Upgrading while the run proves on this device, with the working beat over it. */
export function UpgradePreparing(props: {
  balance: UpgradeBalance
  ring: UpgradeRing
  steps: [StepState, StepState, StepState]
  /** The run waits for this approval's tap. */
  ask?: { number: number; total: number } | null
  /** The browser's passkey prompt is open. */
  signing?: boolean
  /** Why the run waits, in the user's terms. */
  waitReason?: string
  /** Leave upgrade?: the user pressed Back or Cancel. */
  leaving?: boolean
  /** Every proof is done; the sends still need this tab. */
  sending?: boolean
  updateOnly?: boolean
  onSign: () => void
  onCancel: () => void
  onStay: () => void
  onLeave: () => void
}) {
  useWakeLock(true)
  const { percent } = props.ring
  return (
    <ProgressScreen
      account={account()}
      testId="cutover-upgrading"
      percent={percent}
      tip={upgradingCopy.tip}
      spin
      title={upgradingCopy.title}
      body={props.updateOnly ? upgradingCopy.updateBody : upgradingCopy.body}
      banner={{ tone: "warn", ...upgradingCopy.keepOpen }}
      header={moving(props)}
      steps={runSteps(props.steps, props.waitReason, props.updateOnly)}
      footer={upgradingCopy.footer}
      overlay={
        props.leaving ? (
          <LeaveSheet sending={props.sending} onStay={props.onStay} onStop={props.onLeave} />
        ) : (
          !props.sending && (
            <WorkingSheet
              ask={props.ask}
              signing={props.signing}
              onSign={props.onSign}
              onCancel={props.onCancel}
            />
          )
        )
      }
    />
  )
}

/** 4 Upgrading once the sends no longer need this tab. */
export function UpgradeMoving(props: {
  balance: UpgradeBalance
  ring: UpgradeRing
  steps: [StepState, StepState, StepState]
  /** Why the run waits, in the user's terms. */
  waitReason?: string
  updateOnly?: boolean
}) {
  useWakeLock(true)
  const { percent } = props.ring
  const elapsed = useElapsed(true)
  const longer = elapsed !== undefined && elapsed > SLOW_AFTER_MS
  return (
    <ProgressScreen
      account={account()}
      testId="cutover-upgrading"
      percent={percent}
      caption={longer ? upgradingCopy.longerRing : undefined}
      tip={upgradingCopy.tip}
      spin
      title={upgradingCopy.title}
      body={
        props.waitReason ??
        (longer
          ? upgradingCopy.longerBody
          : props.updateOnly
          ? upgradingCopy.updateBody
          : upgradingCopy.body)
      }
      banner={
        longer ? { tone: "warn", ...upgradingCopy.longer } : { tone: "ok", ...upgradingCopy.safe }
      }
      header={moving(props)}
      steps={runSteps(props.steps, props.waitReason, props.updateOnly)}
      footer={upgradingCopy.sentFooter}
      notify
    />
  )
}

/** 5 Done (Figma 389:31770 / 409:35096). */
export function UpgradeDone(props: {
  balance: UpgradeBalance
  updateOnly?: boolean
  onClose: () => void
}) {
  useWakeLock(true)
  const shown = figures(props.balance)
  return (
    <CutoverPage account={account()} testId="cutover-upgrade-done" center>
      <span className="ww-cutover__hero" aria-hidden>
        <img src={doneBadge} alt="" />
      </span>
      <div className="ww-cutover__intro">
        <Title>{upgradeDoneCopy.title}</Title>
        <Lead>
          {props.updateOnly ? upgradeDoneCopy.updated : upgradeDoneCopy.body(shown.total)}
        </Lead>
      </div>
      {!props.updateOnly && (
        <DetailsCard
          rows={[
            { label: "Spendable", value: shown.spendable },
            { label: "Savings", value: shown.savings },
          ]}
        />
      )}
      <div className="ww-cutover__intro">
        <Eyebrow>{upgradeDoneCopy.unlocked}</Eyebrow>
        <Pills items={[...PILLS, { icon: "megaphone", label: upgradeDoneCopy.newFeatures }]} />
      </div>
      <PrimaryGradientButton
        title={upgradeDoneCopy.button}
        trailingIcon="arrow-right"
        testId="cutover-go-to-wallet"
        onClick={props.onClose}
      />
    </CutoverPage>
  )
}

/**
 * S1: the user left while the run proved, so nothing moved (Figma 401:1947 / 409:38283). Without
 * the Figma's "Withdraw funds instead": the stopped run holds its source, so withdrawal cannot open.
 */
export function UpgradeLeft(props: {
  balance: UpgradeBalance
  onStart: () => void
  overlay?: ReactNode
}) {
  useWakeLock(true)
  return (
    <>
      <CutoverPage account={account()} testId="cutover-stopped" center>
        <div className="ww-cutover__intro">
          <Badge icon="refresh" />
          <Title>{stoppedCopy.title}</Title>
          <Lead>{stoppedCopy.body}</Lead>
        </div>
        <BalanceCard label={stoppedCopy.balance} {...amounts(props.balance)} />
        <div className="ww-cutover__card ww-cutover__facts">
          {stoppedCopy.facts.map((fact) => (
            <Fact key={fact}>{fact}</Fact>
          ))}
        </div>
        <PrimaryGradientButton
          title={stoppedCopy.again}
          testId="cutover-start-again"
          onClick={props.onStart}
        />
      </CutoverPage>
      {props.overlay}
    </>
  )
}

/** S2: the run started moving funds, and a later step stopped (Figma 401:2054 / 425:2030). */
export function UpgradeFinish(props: { balance: UpgradeBalance; onResume: () => void }) {
  useWakeLock(true)
  const steps = runSteps(["done", "done", "failed"])
  steps[1]!.status = finishCopy.started
  return (
    <ProgressScreen
      account={account()}
      testId="cutover-finish"
      title={finishCopy.title}
      body={finishCopy.body}
      banner={{ tone: "warn", ...finishCopy.banner }}
      header={{ label: upgradingCopy.moving, value: figures(props.balance).total }}
      steps={steps}
      action={{ label: finishCopy.resume, onClick: props.onResume, testId: "cutover-resume" }}
    />
  )
}

import { useState, type ReactNode } from "react"
import type { InviteNotice } from "./steps/TagAvailabilityNotes"
import { formatUnits } from "viem"
import { depositOwed, useResource } from "@obsidion/front-core"
import { GradientHeroCard, GradientSpinner, Icon, TopNavIconButton } from "@obsidion/web-ds"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { fireOnboardingEvent } from "../../lib/analytics"
import pastUserArt from "../../assets/onboarding/past-user-banner.webp"
import pastUserVerifiedArt from "../../assets/onboarding/past-user-banner-verified.webp"
import { usdFigure, shortL1Addr } from "../../ui/format"
import {
  ACTIVATION_STEP_COUNT,
  activationStepNumber,
  activationSteps,
  type ActivationStep,
} from "./activationSteps"
import { PAY_PRICE } from "./ChooseNameSheet"
import { chooseOwnName } from "./chooseOwnName"
import { OwnTagSheet } from "./OwnTagSheet"
import {
  setVerifyOpen,
  usePastUserCheck,
  usePastUserVerified,
  useVerifyOpen,
} from "./usePastUserCheck"
import { registrationRouteFor, rememberRegistrationRoute } from "./registrationFunnel"
import { useRegistrationAsk } from "./RegistrationAskLine"
import { formatDepositDue, formatDepositSeen } from "./steps/DepositTermsRows"
import { askedTotal, registrationOffer } from "./registrationAsk"
import { useRegistrationTerms } from "./registrationTerms"
import {
  confirmRegistrationTag,
  useOpenRegistration,
  useRegistrationTagConfirmed,
} from "./openRegistration"
import { SecureNameNoticeCard } from "./SecureNameNoticeCard"
import { saveTagDraft } from "./tagPick"
import { VerifyPastUserModal } from "./VerifyPastUserModal"
import { DepositScreen } from "../deposit/DepositScreen"
import { useSession } from "../../platform/session"

// A drawn tag is free, so its deposit is the earned-tag total.
const RANDOM_TAG_DEPOSIT = usdFigure(formatUnits(askedTotal("earned_tag"), 18))
const PAID_TAG_DEPOSIT = usdFigure(formatUnits(askedTotal("standard"), 18))
const TITLES: Record<ActivationStep["id"], string> = {
  passkey: "Save your account",
  deposit: "Deposit funds",
}
const TAG_PITCH = "Complete these 2 steps to use private payments."
const PASSKEY_PITCH = "No password, syncs across your devices."
const depositPitch = (amount: string) => `Activate your account with a ${amount} deposit.`

/**
 * The welcome card: done steps and the ones after it as rows, the current step as `current`.
 * `detail` is each row's second line.
 */
function ActivationSteps(props: {
  testId: string
  tag: string
  /** Beside the tag while it can still change. */
  tagActions?: ReactNode
  /** Replaces the lede under the tag. */
  subtitle?: string
  steps: ActivationStep[]
  detail: Record<ActivationStep["id"], string>
  /** Shown beside a row. */
  beside?: Partial<Record<ActivationStep["id"], ReactNode>>
  current: ReactNode
  children?: ReactNode
  onBack?: () => void
}) {
  const at = props.steps.findIndex((step) => !step.done)
  return (
    <section className="ww-activation" data-testid={props.testId}>
      {props.onBack && (
        <span className="ww-activation__back">
          <TopNavIconButton icon="chevron-left" ariaLabel="Back" onClick={props.onBack} />
        </span>
      )}
      <header className="ww-activation__head">
        <div className="ww-activation__title">
          <h2 className="ww-activation__welcome">
            Hi, you’re
            <br />
            <span key={props.tag} className="ww-tag-swap">
              @{props.tag}
            </span>
          </h2>
          {props.tagActions}
        </div>
        <p className="ww-activation__lede">{props.subtitle ?? TAG_PITCH}</p>
      </header>
      <div className="ww-activation__list">
        {props.steps.map((step, i) =>
          i === at ? (
            <div key={step.id}>{props.current}</div>
          ) : (
            <WithPastUser key={step.id} banner={props.beside?.[step.id]}>
              <div className="ww-activation__step" data-step-done={step.done}>
                <Icon
                  name="check-circle"
                  size={24}
                  color={step.done ? "var(--accent-green)" : "var(--text-secondary)"}
                />
                <span>
                  <b>{TITLES[step.id]}</b>
                  <span>{props.detail[step.id]}</span>
                </span>
              </div>
            </WithPastUser>
          ),
        )}
      </div>
      {props.children}
    </section>
  )
}

function StepHero(props: {
  step: ActivationStep["id"]
  title: string
  body: ReactNode
  cta: ReactNode
}) {
  return (
    <div className="ww-activation__hero">
      <GradientHeroCard
        avatar={
          <span className="ww-activation__eyebrow">
            Step {activationStepNumber(props.step)} of {ACTIVATION_STEP_COUNT}
          </span>
        }
        title={props.title}
        subtitle={props.body}
        footer={props.cta}
      />
    </div>
  )
}

/** Shuffle and own-tag chips beside the drawn tag. */
function TagActions(props: {
  tag: string
  free: boolean
  onChooseOwn: () => void
  /** Absent once a re-roll would forfeit a past user's spent grant. */
  onReroll?: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const reroll = props.onReroll
  return (
    <span className="ww-activation__tag-actions">
      {reroll && (
        <button
          type="button"
          className="zkm-btn-reset ww-activation__chip"
          data-testid="activation-reroll-tag"
          aria-label={`Swap @${props.tag} for another random tag`}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void reroll().finally(() => setBusy(false))
          }}
        >
          <Icon name="refresh" size={12} />
          Shuffle tag
        </button>
      )}
      <button
        type="button"
        className="zkm-btn-reset ww-activation__chip"
        data-testid="activation-choose-own"
        onClick={props.onChooseOwn}
      >
        {props.free ? "Choose your own for free" : `Choose your own · ${PAY_PRICE}`}
      </button>
    </span>
  )
}

function PasskeyHero(props: { onCreate: () => void }) {
  return (
    <StepHero
      step="passkey"
      title={TITLES.passkey}
      body={PASSKEY_PITCH}
      cta={
        <button
          type="button"
          className="zkm-btn-reset ww-activation__cta"
          data-testid="activation-create-passkey"
          onClick={props.onCreate}
        >
          Add passkey
          <Icon name="key" size={14} />
        </button>
      }
    />
  )
}

/** The past-user offer beside a step: Verify until the old wallet checks out, then a welcome back. */
function PastUserBanner(props: { verified: boolean }) {
  const { step, error } = usePastUserCheck().state
  const checking = (step === "sign" || step === "check") && !error
  return (
    // The whole card verifies; the button's click bubbles up and keeps it keyboard reachable.
    <div
      className="ww-past-user"
      data-verified={props.verified || undefined}
      onClick={props.verified ? undefined : () => setVerifyOpen(true)}
    >
      <img
        className="ww-past-user__art"
        src={props.verified ? pastUserVerifiedArt : pastUserArt}
        alt=""
      />
      <b>{props.verified ? "Verified as past zk.money user" : "Used zk.money before?"}</b>
      <span>
        {props.verified
          ? "Welcome back old friend, activate your account to continue."
          : "Verify your old wallet and choose your own tag for free."}
      </span>
      {!props.verified && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-past-user__verify"
          data-testid="past-user-verify"
        >
          {checking ? "Checking…" : "Verify"}
          {checking ? <GradientSpinner size={12} /> : <Icon name="wallet" size={14} />}
        </button>
      )}
    </div>
  )
}

/** A step with the past-user banner beside it. */
function WithPastUser(props: { banner: ReactNode; children: ReactNode }) {
  return (
    <div className="ww-activation__pair">
      {props.children}
      {props.banner}
    </div>
  )
}

/** Home before any account: the drawn tag in the header, then the passkey named after it. */
export function ActivationDraft(props: {
  /** The tag the claim server drew. */
  drawn: string
  /** The tag picked; the passkey step is next. */
  chosen?: string
  /** Why the last pick was refused, shown over the choice it reopens. */
  notice?: InviteNotice
  onKeep: () => void
  onChooseOwn: () => void
  onCreate: () => void
  onReroll: () => Promise<void>
  /** Drops the drawn tag and returns to the landing. */
  onBack: () => void
}) {
  const verifying = useVerifyOpen()
  // Verified and not yet spent: the own tag is free.
  const verified = usePastUserVerified()
  const free = verified !== undefined && verified.tag === undefined
  // A chosen name is paid unless it is the drawn one kept, or this past user's proof earned it.
  const earned =
    free ||
    props.chosen === props.drawn ||
    (verified !== undefined && verified.tag === props.chosen)
  // A past user's free pick spent their proof: a re-roll would lose it for good.
  const pastUserPick = props.chosen !== undefined && verified?.tag === props.chosen
  const tag = props.chosen ?? props.drawn
  const steps = activationSteps({ account: false, deposited: false })
  // Every choice stays open until the passkey exists: a cancelled ceremony leaves them all here.
  return (
    <ActivationSteps
      testId="activation-draft"
      tag={tag}
      onBack={props.onBack}
      tagActions={
        <TagActions
          tag={tag}
          free={free}
          onChooseOwn={props.onChooseOwn}
          onReroll={pastUserPick ? undefined : props.onReroll}
        />
      }
      steps={steps}
      detail={{
        passkey: PASSKEY_PITCH,
        deposit: depositPitch(props.chosen && !earned ? PAID_TAG_DEPOSIT : RANDOM_TAG_DEPOSIT),
      }}
      current={
        <>
          {props.notice?.kind === "error" && (
            <p className="ww-invite__error" role="alert">
              {props.notice.message}
            </p>
          )}
          <WithPastUser banner={<PastUserBanner verified={verified !== undefined} />}>
            <PasskeyHero
              onCreate={() => {
                if (!props.chosen) props.onKeep()
                props.onCreate()
              }}
            />
          </WithPastUser>
        </>
      }
    >
      {verifying && (
        <VerifyPastUserModal onChoose={props.onChooseOwn} onKeepRandom={props.onKeep} />
      )}
    </ActivationSteps>
  )
}

/** Home's lead while the account is unfunded: the passkey done and the deposit at hand. */
export function ActivationHome() {
  const open = useOpenRegistration()
  const confirmed = useRegistrationTagConfirmed(open?.record ?? null)
  const ask = useRegistrationAsk()
  const terms = useRegistrationTerms(open?.record.account, open?.record.tag)
  const verified = usePastUserVerified()
  const verifying = useVerifyOpen()
  const free = usePastUserCheck().state.step === "confirmed"
  const obsidionAccount = useResource(useSession().account)
  const obsidionWallet = useResource(useSession().wallet)
  const [own, setOwn] = useState(false)
  const [depositing, setDepositing] = useState(false)
  // Unknown while the withdrawals load: Home waits rather than ask for a deposit already funded.
  if (!open || open.stage === undefined || open.stage === "failed") return null
  const { record } = open
  const route = registrationRouteFor(record.tag)
  const pastUser = route === "past_user"
  const verifiedAccount = verified?.tag === record.tag ? verified.account : undefined
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  // A paid tag waiting on activation: a past-user pass makes it free.
  const paidPending = route === "paid" && !confirmed
  const steps = activationSteps({
    account: true,
    deposited: !depositOwed(open.stage),
    ticket: registrationOffer(terms).funding === "paylink",
  })
  // Whole dollars read as "$5", as the deposit screen's ask does.
  const total =
    ask?.total === undefined
      ? RANDOM_TAG_DEPOSIT
      : formatDepositDue(ask.total, decimals).replace(/\.00$/, "")

  return (
    <ActivationSteps
      testId="activation-home"
      tag={record.tag}
      subtitle={
        pastUser
          ? `Your own tag, free as a past zk.money user.${
              verifiedAccount ? ` Verified ${shortL1Addr(verifiedAccount)}.` : ""
            }`
          : undefined
      }
      steps={steps}
      detail={{
        passkey: PASSKEY_PITCH,
        deposit: depositPitch(total),
      }}
      beside={{
        passkey: pastUser ? (
          <PastUserBanner verified />
        ) : paidPending ? (
          <PastUserBanner verified={false} />
        ) : null,
      }}
      current={
        <SecureNameNoticeCard
          ask={(note) => (
            <StepHero
              step="deposit"
              title={TITLES.deposit}
              body={
                <>
                  {ask?.total !== undefined && ask.remaining !== undefined
                    ? `${formatDepositSeen(
                        ask.seen,
                        decimals,
                      )} of ${total} received. Deposit at least ${formatDepositDue(
                        ask.remaining,
                        decimals,
                      )} more to activate your account.`
                    : depositPitch(total)}
                  {note && <span className="ww-activation__note">{note}</span>}
                </>
              }
              cta={
                <button
                  type="button"
                  className="zkm-btn-reset ww-activation__cta"
                  data-testid="activation-deposit"
                  onClick={() => {
                    if (!confirmed) confirmRegistrationTag(record)
                    setDepositing(true)
                  }}
                >
                  Deposit{" "}
                  {ask?.total !== undefined && ask.remaining !== undefined
                    ? formatDepositDue(ask.remaining, decimals).replace(/\.00$/, "")
                    : total}
                  <Icon name="arrow-right" size={14} />
                </button>
              }
            />
          )}
        />
      }
    >
      {depositing && <DepositScreen onClose={() => setDepositing(false)} />}
      {verifying && (
        <VerifyPastUserModal
          tag={paidPending ? record.tag : undefined}
          onChoose={() => setOwn(true)}
        />
      )}
      {own && !verifying && (
        <OwnTagSheet
          free={free}
          current={record.tag}
          submitLabel={free ? "Claim for free" : `Make my deposit ${PAY_PRICE}`}
          onVerify={() => setVerifyOpen(true)}
          onClose={() => setOwn(false)}
          onPick={async (name) => {
            if (!obsidionAccount || !obsidionWallet)
              throw new Error("The wallet is still starting.")
            await chooseOwnName(name, obsidionAccount, obsidionWallet, free)
            rememberRegistrationRoute(name, free ? "past_user" : "paid")
            fireOnboardingEvent("name_route_chosen", { route: free ? "past_user" : "pay" })
            saveTagDraft("")
            setOwn(false)
          }}
        />
      )}
    </ActivationSteps>
  )
}

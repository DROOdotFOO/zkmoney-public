import { useEffect, useLayoutEffect, useState, useRef } from "react"
import {
  Icon,
  LiquidGlassPill,
  PrimaryGradientButton,
  ProgressSpinner,
  Spinner,
} from "@obsidion/web-ds"
import {
  type SavingsDirection,
  type SavingsPosition,
  savingsEarned,
  savingsEarningsPending,
  selectHome,
  selectHomeMain,
  useSavings,
  useStore,
  useResource,
} from "@obsidion/front-core"
import { useLocation, useNavigate } from "react-router-dom"
import { DepositArt } from "../../DepositArt"
import { HighGasNotice, HighL2FeeNotice } from "../../HighGasNotice"
import { PhoneIcon } from "../../PhoneIcon"
import { usePhoneLayout } from "../../usePhoneLayout"
import { LostRegistrationNoticeCard } from "../../../features/onboarding/LostRegistrationNoticeCard"
import { inviteLink, useInvite } from "../../../features/invite/useInvite"
import { RegisterNameCard } from "../../../features/onboarding/SecureNameNoticeCard"
import { ActivationHome } from "../../../features/onboarding/ActivationHome"
import { useNameClaimPending } from "../../../features/onboarding/openRegistration"
import { useActionGuard } from "../../../features/actionGate"
import { getConfig } from "../../../config/env"
import { useSession } from "../../../platform/session"
import { healRegistrationDeposits } from "../../../features/onboarding/registrationDepositSeed"
import { discoverRegistrationDeposits } from "../../../features/onboarding/registrationRederive"
import { peekClaimStash } from "../../../features/paylink/claimStash"
import {
  takeClaimPromptRequest,
  useClaimPromptRequest,
} from "../../../features/paylink/claimPrompt"
import { useClaimLinkFlow } from "../../../features/paylink/useClaimLinkFlow"
import { AccountSwitcher, type SavingsAccount } from "../../../features/savings/AccountSwitcher"
import { EarningsCalculatorSheet, apyPercent } from "../../../features/savings/EarningsCalculator"
import { MoveFundsSheet } from "../../../features/savings/MoveFundsSheet/MoveFundsSheet"
import { SavingsArt } from "../../../features/savings/SavingsArt"
import { SavingsCards } from "../../../features/savings/SavingsCards"
import {
  ESTIMATE_TITLE,
  splitTicking,
  useSavingsEstimate,
} from "../../../features/savings/savingsEstimate"
import { RequestsUnavailableNotice } from "../../../features/requests/RequestsUnavailableNotice"
import { usdAtomicFloor } from "../../format"
import { useHideBalances } from "../../prefs"
import { BalanceSkeleton } from "../../Skeletons"
import { customEndpointsLabel } from "../../EndpointsModal"
import { HomeActions, type HomeAction } from "../HomeActions"
import { HomeTransactions } from "../HomeTransactions/HomeTransactions"
import {
  ActivityDetailHost,
  useActivityHost,
} from "../../activity/ActivityDetailHost/ActivityDetailHost"
import { ActivityRow, SavingsActivityRow } from "../../activity/ActivityRow/ActivityRow"
import earnCoin from "../../../assets/home/earn-coin.webp"
import gift from "../../../assets/home/gift.webp"
import { UpgradeBanner } from "../../../features/migration/UpgradeIntro"
import { PreviousAccountLine } from "../../../features/backupPasskey/PreviousAccountLine"
import { RotationApprovalLine } from "../../../features/backupPasskey/RotationApprovalLine"
import { useOldVersionHoldings } from "../../../features/migration/oldVersionBalance"
import { OldVersionLeftoversNotice } from "../../../features/migration/OldVersionLeftoversNotice"
import { oldVersionLeftovers } from "../../../features/migration/oldVersionLeftovers"
import { useUpgradeLock } from "../../../features/migration/upgradeLock"
import { loadWalletIdentity } from "../../../features/identity/walletIdentity"
import iosApp from "../../../assets/home/ios-app.webp"
import quickFresh from "../../../assets/home/quick-fresh.webp"
import quickPaylink from "../../../assets/home/quick-paylink.webp"
import shareTag from "../../../assets/home/share-tag.webp"
import { useFreshAddressAvailable } from "../../../features/withdraw/freshAddressAvailability"
import { useCopy, useLinkSharing } from "../../hooks"
import styles from "./HomeScreen.module.css"
import copy from "./HomeScreen.copy"
import { fmt } from "../../../lib/fmt"

/**
 * Home. Reached through the identity and unlock gates. Balance comes from
 * the session's balances. Where a savings deployment exists the card switches between
 * Main and Savings; `/savings` is Home on the Savings account, with its cards under the card.
 */
const QUICK_SLIDES = [
  {
    id: "fresh",
    label: copy.quick.fresh.label,
    title: copy.quick.fresh.title,
    body: copy.quick.fresh.body,
    className: styles.quickSlideFresh,
    art: quickFresh,
    path: "/withdraw/fresh",
    action: "withdraw" as const,
  },
  {
    id: "paylink",
    label: copy.quick.paylink.label,
    title: copy.quick.paylink.title,
    body: copy.quick.paylink.body,
    className: styles.quickSlidePaylink,
    art: quickPaylink,
    path: "/links/new",
    action: "link" as const,
  },
]

/** The rail's promo slides, one per view. The row scrolls natively; the arrows only move it. */
function QuickActions() {
  const navigate = useNavigate()
  const guard = useActionGuard()
  const row = useRef<HTMLDivElement>(null)
  const fresh = useFreshAddressAvailable() === true
  const savings = useSavings()
  const apy = savings.position?.apy
  const slides = [
    ...(savings.available
      ? [
          {
            id: "savings",
            label: copy.quick.savings.label,
            title:
              apy === undefined
                ? copy.quick.savings.title
                : fmt(copy.quick.savings.titleApy, { apy: apyPercent(apy) }),
            body: copy.quick.savings.body,
            className: styles.quickSlideSavings,
            art: earnCoin,
            path: "/savings",
          },
        ]
      : []),
    ...QUICK_SLIDES.filter((slide) => slide.id !== "fresh" || fresh),
  ]
  const paged = slides.length > 1
  // Savings and the fresh-address slide arrive after first paint, ahead of the paylink slide the
  // row snapped to; Chromium then re-snaps to that same slide, which is now the last. Lead with
  // the first slide whenever the set changes.
  const slideSet = slides.map((slide) => slide.id).join()
  useLayoutEffect(() => {
    if (row.current) row.current.scrollLeft = 0
  }, [slideSet])
  const scrollRow = (views: number) =>
    row.current?.scrollBy({ left: views * row.current.clientWidth, behavior: "smooth" })

  return (
    <div className={styles.quick}>
      <div className={styles.quickHead}>
        <span>{copy.quick.title}</span>
        {paged && (
          <span className="ww-quick__arrows">
            <button
              type="button"
              className="zkm-btn-reset"
              aria-label={copy.quick.back}
              onClick={() => scrollRow(-1)}
            >
              <Icon name="chevron-right" size={8.5} color="#fff" />
            </button>
            <button
              type="button"
              className="zkm-btn-reset"
              aria-label={copy.quick.forward}
              onClick={() => scrollRow(1)}
            >
              <Icon name="chevron-right" size={8.5} color="#fff" />
            </button>
          </span>
        )}
      </div>
      <div className={styles.quickSlides} ref={row}>
        {slides.map((slide, i) => (
          <button
            key={slide.id}
            type="button"
            className={`zkm-btn-reset ww-banner ${styles.quickSlide} ${slide.className}`}
            aria-label={slide.label}
            onClick={() =>
              "action" in slide
                ? guard(slide.action, () => navigate(slide.path))
                : navigate(slide.path)
            }
          >
            <span className="ww-banner__text">
              <span className="ww-banner__title">{slide.title}</span>
              <span className="ww-banner__body">{slide.body}</span>
            </span>
            {paged && (
              <span className={styles.quickStepper}>
                <span className={styles.quickTrack}>
                  <span style={{ width: `${(100 * (i + 1)) / slides.length}%` }} />
                </span>
                {i + 1}/{slides.length}
              </span>
            )}
            <img src={slide.art} alt="" />
          </button>
        ))}
      </div>
    </div>
  )
}

const HIDDEN = "$••••••"

/** Stays up while any endpoint is not the default; leads to where the endpoints are set. */
function CustomEndpointsPill({
  label,
  onOpenSettings,
}: {
  label: string
  onOpenSettings: () => void
}) {
  return (
    <button
      type="button"
      className="zkm-btn-reset"
      style={{ textDecoration: "none" }}
      onClick={onOpenSettings}
    >
      <LiquidGlassPill label={label} icon="settings" iconLeading labelFontSize={12} />
    </button>
  )
}

/**
 * A Savings figure carried to now at its rate, its small digits ticking (more of them on a small
 * balance); the tick re-renders only this. `at` maps the carried value to the figure shown.
 */
function TickingUsd({
  position,
  at,
}: {
  position: SavingsPosition | null
  at: (value: bigint) => bigint
}) {
  const estimate = useSavingsEstimate(position, true)
  if (estimate.value === undefined) return null
  const value = at(estimate.value)
  if (!estimate.ticking) return <>{usdAtomicFloor(value)}</>
  const { whole, ticking } = splitTicking(value)
  return (
    <>
      {whole}
      <small aria-hidden title={ESTIMATE_TITLE}>
        {ticking}
      </small>
    </>
  )
}

export function HomeScreen() {
  return (
    <ActivityDetailHost>
      <Home />
    </ActivityDetailHost>
  )
}

function Home() {
  const { milestones } = useSession()
  const networkId = useResource(useSession().wallet)?.networkId
  // Track registration deposits once their claim inputs are available.
  useEffect(() => {
    if (!networkId) return
    const warn = (err: unknown) => console.warn("[home] registration deposits not tracked:", err)
    const heal = () => void healRegistrationDeposits(getConfig(), networkId).catch(warn)
    const timer = setTimeout(heal, 4_000) // slice-check-ignore: a one-shot delay Home owns until the heal is a task
    void discoverRegistrationDeposits(getConfig(), networkId, milestones).catch(warn)
    return () => clearTimeout(timer)
  }, [milestones, networkId])

  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const [inviteOpen, setInviteOpen] = useState(true)
  const { code: inviteCode } = useInvite()
  const inviteText = inviteCode && inviteLink(inviteCode)
  const inviteUrl = inviteText && `https://${inviteText}`
  const { copied: inviteCopied, copy: copyInvite } = useCopy()
  // Share falls back to the clipboard where the Web Share API is absent, and says so.
  const { copied: inviteShared, share: shareInvite } = useLinkSharing(inviteUrl, copy.invite.title)

  const balance = useStore(useSession().balances.view)
  // A first look at what old versions hold, with nothing recorded yet, could only show too little.
  const oldHoldings = useOldVersionHoldings()
  const address = loadWalletIdentity()?.address
  const lock = useUpgradeLock(address)
  // Held, Main stays at what the upgrade will land, with nothing from the new version.
  const frozen = lock.state === "held"
  const savingsFrozen = frozen && lock.savings !== undefined
  const [hideBal, setHideBal] = useHideBalances()
  const savings = useSavings()
  const { pathname } = useLocation()
  // The route picks the account, so the Savings nav item and slide are shortcuts to this view.
  const account: SavingsAccount = savings.available && pathname === "/savings" ? "savings" : "main"
  const setAccount = (next: SavingsAccount) => navigate(next === "savings" ? "/savings" : "/")
  const [sheet, setSheet] = useState<SavingsDirection | { amount?: string } | "calculator" | null>(
    null,
  )
  const guard = useActionGuard()
  const openMove = (direction: SavingsDirection, amount?: string) =>
    guard("savings", () =>
      setSheet(direction === "in" && amount !== undefined ? { amount } : direction),
    )
  const onSavings = account === "savings"
  const apy = savings.position?.apy
  const apyLabel = apy === undefined ? undefined : fmt(copy.apy, { apy: apyPercent(apy) })
  const { feed } = useActivityHost()
  const { arriving, upgradesLoaded, hydrated, requestsUnavailable } = feed
  const { items: savingsItems, hydrated: savingsHydrated, ledger: savingsLedger } = feed.savings
  // What old versions still hold that no balance here shows.
  const oldVersionLeft = oldVersionLeftovers({
    moves: savingsItems,
    items: feed.items,
    sharePrice: savings.position?.sharePrice,
    network: networkId,
  })
  // Funds on their way count where they land, flat: they neither tick nor earn until they arrive.
  const { shown: mainShown, known: mainKnown } = selectHomeMain(balance, {
    arriving: arriving.main,
    lock: { checked: lock.checked, held: frozen, main: frozen ? lock.main : undefined },
    upgradesLoaded,
  })
  const mainText = hideBal ? HIDDEN : mainShown === undefined ? "—" : usdAtomicFloor(mainShown)
  // The last read value; the ticking figures carry it to now in their own components.
  const estimate = useSavingsEstimate(savings.position, false)
  const savingsShown = savingsFrozen
    ? lock.savings
    : estimate.value === undefined
    ? undefined
    : estimate.value + arriving.savings
  const savingsValueText = savingsShown === undefined ? undefined : usdAtomicFloor(savingsShown)
  const totalValue =
    savingsShown !== undefined && mainKnown && mainShown !== undefined
      ? mainShown + savingsShown
      : undefined
  const savingsText = hideBal ? HIDDEN : savingsValueText ?? "—"
  // What the shares held now have earned: their value (ticking when it ticks) less what they cost.
  // Shown once the position's value is read, while there is a position or a counted move.
  const earnable =
    savingsLedger !== undefined &&
    estimate.value !== undefined &&
    ((savings.position?.shares ?? 0n) > 0n || savingsLedger.counted > 0)
  const sharesHeld = savings.position?.shares ?? 0n
  const earned =
    earnable && savingsLedger && estimate.value !== undefined
      ? savingsEarned(savingsLedger, estimate.value, sharesHeld)
      : undefined
  // Figures still being read from the escrow runs: the slot says so instead of going blank.
  const calculating =
    earnable && !!savingsLedger && earned === undefined && savingsEarningsPending(savingsLedger)
  // Nothing in the slot: the console says why, with every input, once per change.
  const hiddenKey =
    onSavings && !hideBal && earned === undefined && !calculating
      ? [
          savings.hydrated,
          savings.position?.shares,
          savings.position?.value,
          estimate.value,
          savingsLedger?.counted,
          savingsLedger?.shares,
          savingsLedger?.basis,
          savingsLedger?.excluded.map((e) => `${e.withdrawalLocalId}:${e.reason}:${e.backfilling}`),
        ].join("|")
      : undefined
  useEffect(() => {
    if (hiddenKey === undefined) return
    console.info(
      `[savings] earnings hidden: hydrated=${savings.hydrated} position=${
        savings.position
          ? `${savings.position.shares} shares, value ${savings.position.value}`
          : "none"
      } estimate=${estimate.value ?? "none"} ledger=${
        savingsLedger
          ? `counted ${savingsLedger.counted}, shares ${savingsLedger.shares}, basis ${
              savingsLedger.basis
            }, excluded [${savingsLedger.excluded
              .map(
                (e) =>
                  `${e.withdrawalLocalId} (${e.reason}${e.backfilling ? ", backfilling" : ""})`,
              )
              .join(", ")}]`
          : "not read yet"
      }`,
    )
    // Keyed on what the line would say, so it prints once per change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey])
  const totalText = hideBal ? HIDDEN : totalValue === undefined ? "—" : usdAtomicFloor(totalValue)
  const balanceText = onSavings ? savingsText : mainText
  const balanceShown = onSavings ? savingsFrozen || savings.hydrated : mainKnown
  // A device catching up can be short on either account: a rebuilt move's deposit lands in either.
  const syncing = balanceShown && balance.syncing
  const openDeposit = () => guard("deposit", () => navigate("/deposit"))
  // An inbound paylink stashed by /link — prompts until claimed or dismissed.
  const [claimFragment, setClaimFragment] = useState(peekClaimStash)
  // An activation surface asked for the claim of a link that funds the pending name: its review
  // opens whatever the claim's state, as the place that reports it.
  const requestedClaim = useClaimPromptRequest()
  const [claimAsked, setClaimAsked] = useState(false)
  useEffect(() => {
    if (!requestedClaim) return
    setClaimFragment(takeClaimPromptRequest())
    setClaimAsked(true)
  }, [requestedClaim])
  const claim = useClaimLinkFlow(
    claimFragment,
    () => {
      setClaimFragment(null)
      setClaimAsked(false)
    },
    claimAsked,
    () => setClaimAsked(false),
  )
  const customEndpoints = customEndpointsLabel(getConfig().endpoints)
  const { requests: requestItems, feed: feedItems } = selectHome(feed)

  const receive: HomeAction = {
    title: copy.actions.receive,
    icon: "arrow-down",
    phoneIcon: "arrow-down",
    run: () => guard("receive", () => navigate("/receive")),
  }
  const send: HomeAction = {
    title: copy.actions.send,
    icon: "send",
    phoneIcon: "send",
    run: () => guard("send", () => navigate("/send")),
  }
  const withdraw: HomeAction = {
    title: copy.actions.withdraw,
    icon: "tray-withdraw",
    phoneIcon: "tray-withdraw",
    run: () => guard("withdraw", () => navigate("/withdraw")),
  }
  const actions: HomeAction[] = onSavings
    ? [
        {
          title: copy.actions.addToSavings,
          icon: "earn",
          phoneIcon: "earn",
          run: () => openMove("in"),
        },
        {
          title: copy.actions.moveToMain,
          icon: "payments-arrows-horizontal",
          run: () => openMove("out"),
        },
      ]
    : phone
    ? [
        { title: copy.actions.deposit, icon: "coins", phoneIcon: "coins", run: openDeposit },
        receive,
        send,
        withdraw,
      ]
    : [
        { title: copy.actions.deposit, icon: "coins", phoneIcon: "coins", run: openDeposit },
        send,
        receive,
        withdraw,
      ]

  const claimPending = useNameClaimPending()
  const card = (
    <section className={styles.homeWallet}>
      <div className="ww-home__balance">
        <div className={styles.homeBalanceLabel}>
          {savings.available ? (
            <AccountSwitcher
              selected={account}
              onSelect={setAccount}
              mainBalance={mainKnown ? mainText : "—"}
              savingsBalance={savingsText}
              total={totalText}
              apyLabel={apyLabel}
            />
          ) : (
            <span>{copy.balance}</span>
          )}
          <button
            type="button"
            className="zkm-btn-reset"
            aria-label={copy.toggleBalance}
            style={{ display: "inline-flex", color: "inherit" }}
            onClick={() => setHideBal(!hideBal)}
          >
            {phone && !hideBal ? (
              <PhoneIcon name="eye" size={18} />
            ) : (
              <Icon name={hideBal ? "eye-off" : "eye"} size={18} />
            )}
          </button>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            {syncing && (
              <LiquidGlassPill
                label={
                  balance.progress === null
                    ? copy.syncing
                    : fmt(copy.syncingProgress, { percent: Math.round(balance.progress * 100) })
                }
                customIcon={
                  balance.progress === null ? (
                    <Spinner size={12} color="currentColor" />
                  ) : (
                    <ProgressSpinner progress={balance.progress} size={12} color="currentColor" />
                  )
                }
                iconLeading
                labelFontSize={12}
              />
            )}
            {customEndpoints && (
              <CustomEndpointsPill
                label={customEndpoints}
                onOpenSettings={() => navigate("/settings")}
              />
            )}
          </span>
        </div>
        {!hideBal && !balanceShown ? (
          <BalanceSkeleton />
        ) : (
          <span
            className={`ww-home__balance-value${
              phone && balanceText.length > 12 ? ` ${styles.homeBalanceValueLong}` : ""
            }${syncing ? " ww-home__balance-value--syncing" : ""}`}
            data-testid={onSavings ? "savings-balance" : "wallet-balance"}
            aria-busy={syncing}
          >
            {onSavings && !hideBal && savingsValueText !== undefined && !savingsFrozen ? (
              <TickingUsd position={savings.position} at={(value) => value + arriving.savings} />
            ) : (
              balanceText
            )}
          </span>
        )}
        {onSavings && (apyLabel || (!hideBal && (earned !== undefined || calculating))) && (
          <div className={styles.homeBalanceMeta}>
            {apyLabel && (
              <span className={`${styles.pill} ${styles.pillGreen}`} title={copy.apyTitle}>
                {apyLabel}
              </span>
            )}
            {!hideBal && earned !== undefined && (
              <span className="ww-home__earned" title={copy.earnedTitle}>
                <b data-positive={earned > 0n || undefined}>
                  {earned > 0n ? "+" : ""}
                  {earned < 0n || !savingsLedger ? (
                    usdAtomicFloor(earned)
                  ) : (
                    <TickingUsd
                      position={savings.position}
                      at={(value) => savingsEarned(savingsLedger, value, sharesHeld) ?? earned}
                    />
                  )}{" "}
                  {copy.earned}
                </b>
              </span>
            )}
            {!hideBal && earned === undefined && calculating && (
              <span className="ww-home__earned" title={copy.earnedTitle}>
                <b data-testid="earned-calculating">{copy.calculating}</b>
              </span>
            )}
          </div>
        )}
      </div>
      <UpgradeBanner />
      <RotationApprovalLine />
      <PreviousAccountLine />
      <HomeActions actions={actions} phone={phone} />
      {onSavings ? (
        savingsHydrated && savingsItems.length === 0 ? (
          <div className={styles.homeCta}>
            <SavingsArt />
            <PrimaryGradientButton
              title={copy.actions.addToSavings}
              onClick={() => openMove("in")}
            />
          </div>
        ) : (
          <HomeTransactions
            items={savingsItems}
            hydrated={savingsHydrated}
            row={(item) => <SavingsActivityRow item={item} />}
            onViewAll={() => navigate("/activity?account=savings")}
          />
        )
      ) : (
        <>
          {hydrated && requestsUnavailable && <RequestsUnavailableNotice />}
          {/* Until the account is upgraded, the upgrade still moves these funds. */}
          {hydrated && lock.state === "released" && (
            <OldVersionLeftoversNotice left={oldVersionLeft} />
          )}
          {hydrated &&
            requestItems.map((item) => (
              <div key={item.id} className={styles.homeRequest}>
                <ActivityRow item={item} />
              </div>
            ))}
          {/* Funds an upgrade still moves are the account's: no invitation to deposit over them. */}
          {hydrated &&
          feedItems.length === 0 &&
          !frozen &&
          !oldHoldings.pending &&
          oldHoldings.total === 0n ? (
            <div className={styles.homeCta}>
              <DepositArt />
              <PrimaryGradientButton title={copy.depositFunds} onClick={openDeposit} />
            </div>
          ) : (
            <HomeTransactions
              items={feedItems}
              hydrated={hydrated}
              row={(item) => <ActivityRow item={item} />}
              onViewAll={() => navigate("/activity")}
            />
          )}
        </>
      )}
    </section>
  )

  return (
    <>
      <HighL2FeeNotice />
      <HighGasNotice />
      <LostRegistrationNoticeCard />
      {!claimPending && <ActivationHome />}
      <RegisterNameCard />
      <div className={styles.home}>
        {claimPending ? (
          <ActivationHome />
        ) : onSavings ? (
          <div className={styles.savingsMain}>
            {card}
            <SavingsCards onCalculator={() => setSheet("calculator")} />
          </div>
        ) : (
          card
        )}

        {/* The onboarding takes the full width until the name is claimed. */}
        {!phone && !claimPending && (
          <aside className={styles.homeRail}>
            <QuickActions />

            <button
              type="button"
              className={`zkm-btn-reset ww-banner ${styles.bannerRow}`}
              onClick={() => guard("receive", () => navigate("/receive"))}
            >
              <img src={shareTag} alt="" />
              <span className="ww-banner__text">
                <span className="ww-banner__title">{copy.shareTag.title}</span>
                <span className="ww-banner__body">{copy.shareTag.body}</span>
              </span>
              <span className="ww-banner__chevron">
                <Icon name="chevron-right" size={8.5} color="#fff" />
              </span>
            </button>

            {inviteOpen && inviteUrl && (
              <div className={styles.inviteCard}>
                <span className={styles.inviteCardTitle}>{copy.invite.title}</span>
                <button
                  type="button"
                  className={`zkm-btn-reset ${styles.inviteCardClose}`}
                  aria-label={copy.invite.dismiss}
                  onClick={() => setInviteOpen(false)}
                >
                  <Icon name="x" size={14} />
                </button>
                <img className={styles.inviteCardArt} src={gift} alt="" />
                <div className={styles.inviteCardField}>
                  <span>{copy.invite.referral}</span>
                  <code>{inviteText}</code>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    aria-label={inviteCopied ? copy.invite.copied : copy.invite.copyReferral}
                    onClick={() => void copyInvite(inviteUrl)}
                  >
                    <Icon name={inviteCopied ? "check" : "copy"} size={16} />
                  </button>
                </div>
                <div className={styles.inviteCardButtons}>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    onClick={() => void copyInvite(inviteUrl)}
                  >
                    {inviteCopied ? copy.invite.linkCopied : copy.invite.copyLink}
                  </button>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    onClick={() => void shareInvite()}
                  >
                    {inviteShared ? copy.invite.shared : copy.invite.share}
                    <Icon name="share-box" size={20} color="#fff" />
                  </button>
                </div>
              </div>
            )}

            <div className={`ww-banner ${styles.bannerRow} ${styles.bannerIos}`}>
              <img src={iosApp} alt="" />
              <span className="ww-banner__text">
                <span className="ww-banner__title">{copy.ios.title}</span>
                <span className="ww-banner__body">{copy.ios.body}</span>
              </span>
            </div>
          </aside>
        )}
      </div>

      {claim.modal}
      {(sheet === "in" || sheet === "out") && (
        <MoveFundsSheet direction={sheet} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && typeof sheet === "object" && (
        <MoveFundsSheet
          direction="in"
          initialAmount={sheet.amount}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "calculator" && (
        <EarningsCalculatorSheet
          apy={apy}
          balances={{
            savings: savings.position?.value,
            main: balance.known ? balance.main?.atomic ?? 0n : undefined,
          }}
          onMove={(amount) => openMove("in", String(amount))}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}

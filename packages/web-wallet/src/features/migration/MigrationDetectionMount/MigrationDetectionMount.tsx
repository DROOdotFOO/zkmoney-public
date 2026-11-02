import { upgradeApprovals, type MigrationQueueJob } from "../runMigrationQueue"
import { backgroundSend, runGatedMigrationQueue } from "../gatedMigration"
import { reloadPage, walletStoreIsPersistent } from "../../../platform/storage/walletStorage"
import { peekAuthService } from "../../../platform/auth/useAuthenticator"
import { Modal } from "../../../ui/Modal"
/**
 * Boot-time migration detection: derives where the signed-in account's upgrade stands from what it
 * still holds on a retired oxide deployment (`probeAccountResiduals`), its saved runs, the sponsored
 * rail's readiness and the registration check, and publishes it (`setUpgradeStatus`) for Home's
 * banner and the bell. The dialog opens only on a request. Mounted inside WalletGate (post-PXE,
 * post-unlock) because the probes need the wallet + account.
 *
 * Paylinks still inside their claim window cannot be refunded yet; `probeAccountResiduals` hands
 * them to `PendingPaylinkMigrationService`, which waits out the window and mints a reclaim
 * notification once chain time passes it.
 *
 * A failed check never breaks the wallet's boot: the state reads `failed`, and trying again checks
 * once more. Residuals with nothing to do right now become a notification.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useLocation, useNavigate } from "react-router-dom"
import {
  BalanceStorage,
  bestEffort,
  checkSpentViaPaylinkService,
  type After,
  dataKey,
  useContractServiceContext,
  useSavingsPosition,
  useStore,
  retryableStop,
  readSavingsPrice,
  readSavingsVault,
  runMetadataMigration,
  savingsValue,
  type MetadataMigrationRecord,
  type MetadataMigrationSummary,
  paylinkRefundEligibility,
  type ResidualItem,
  useResource,
  WalletSyncCoordinator,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  PaylinkService,
  TokenService,
  type MigrationSourceQuote,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  ConfirmationSheetDetailRow,
  GradientText,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { formatUnits, type Address } from "viem"
import { fetchLiveProfilePortal, getConfig } from "../../../config/env"
import { l1PublicClient } from "../../../config/oxideTuple"
import { showReportableError } from "../../../errors/errorModal"
import { BootSplash } from "../../../ui/PxeBoot"
import { fireEvent } from "../../../lib/analytics"
import { webStorage } from "../../../platform/storage/WebStorageAdapter"
import type { HistoricResidualSummary } from "../historicResiduals"
import {
  migrationFeatureListed,
  probeAccountResiduals,
  reconcilePendingPaylinks,
  type ResidualDestination,
} from "../probeAccountResiduals"
import {
  FREEZE_POLL_MS,
  ManifestUnavailableError,
  watchForFeature,
  watchForFreeze,
} from "../freezeWatch"
import { itemNote, lockedUntil, money } from "../residualNotes"
import { useSession } from "../../../platform/session"
import {
  isFlowCancelled,
  runListedOperation,
  useBusyLabel,
  useLeavingLosesTransaction,
} from "../../operations/operations"
import { runUserFlow, useUserFlowActive } from "../../provingGate"
import { upgradeVerdict } from "../../actionGate"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { PayWorking } from "../../contacts/PayWorking"
import { UpgradeIntro, UpgradeKeepOpen } from "../UpgradeIntro"
import { beforeApproval, grantApproval, resetApprovals, useApprovalAsk } from "../approvalGate"
import {
  UpgradeChoose,
  UpgradeDone,
  UpgradeFinish,
  UpgradeLeft,
  UpgradeMoving,
  UpgradePreparing,
  UpgradeSign,
} from "../upgradeFlow"
import { BugReportModal } from "../../../ui/FeedbackModals"
import { ErrorSheet } from "../../cutover/sheets"
import { upgradeDoneCopy, upgradingCopy } from "../../cutover/cutoverCopy"
import { useNetworkReady } from "../../cutover/networkReady"
import { notifyIfArmed } from "../../cutover/notify"
import { queueProgress, upgradeProgress, upgradeSteps } from "../../cutover/upgradeProgress"
import { WINDOW_ENDS } from "../../../upgradeFreeze"
import { useBackGuard } from "../backGuard"
import {
  actionUpgradeTitle,
  checkingLead,
  continueLabel,
  finishingCopy,
  followingLead,
  migrationSummary,
  offerCopy,
  reopenScreen,
  upgradePhaseText,
  upgradeStopReason,
  upgradeStopText,
} from "../upgradeCopy"
import "../migration.css"
import {
  createWebMetadataMigration,
  createWebMetadataMigrationQuietly,
  webAccountRecordStale,
  webMetadataMigrationKey,
} from "../createWebMetadataMigration"
import {
  migrationDialogReason,
  setUpgradeStatus,
  useMigrationDialogRequest,
  type MigrationDialogReason,
  type UpgradeState,
} from "../migrationDialog"
import { setWithdrawableSources, useOldVersionWithdrawals } from "../oldVersionWithdraw"
import { loadWalletIdentity } from "../../identity/walletIdentity"
import {
  useSponsoredRailPending,
  useSponsoredRailReadFailed,
} from "../../onboarding/sponsoredRailReadiness"
import { getPendingStore } from "../../onboarding/webRegistration"
import {
  markOldHoldingsRead,
  markUpgradeMovesFunds,
  oldHoldingsRead,
  oldVersionScope,
  releaseOldHoldingsWait,
  setOldVersionDestinations,
  upgradeMovedFunds,
  useOldVersionHoldings,
} from "../oldVersionBalance"
import {
  acquireUpgradeLock,
  checkUpgradeLock,
  releaseUpgradeLock,
  useUpgradeLock,
} from "../upgradeLock"
import styles from "./MigrationDetectionMount.module.css"
import copy from "./MigrationDetectionMount.copy"
import { fmt } from "../../../lib/fmt"

export const PROFILE_REPOINT_POLL_MS = 5 * 60_000
/** The probe of old versions waits for the v6 balance. */
const PROBE_AFTER: After = { firstBalance: true }
/** How long boot waits for the record check before it shows Home. */
export const RECORD_CHECK_WAIT_MS = 3_000
/** How long a failed read or release of the upgrade lock waits before it is tried again. */
const LOCK_RETRY_MS = 12_000

const RESIDUALS_NOTIFICATION_ID = "migration:residuals"
const RUN_NOTIFICATION_ID = "migration:run"
const NO_DESTINATIONS: ReadonlyMap<string, ResidualDestination> = new Map()

/** The upgrade stopped for the user: the dialog and the bell say why. */
class UpgradeStopped extends Error {}

function useProfileRepoint(): boolean {
  const booted = getConfig().oxideProfile.portal.toLowerCase()
  const { data } = useQuery({
    queryKey: ["profile-portal", booted],
    queryFn: () => fetchLiveProfilePortal(),
    initialData: booted,
    staleTime: PROFILE_REPOINT_POLL_MS,
    refetchInterval: PROFILE_REPOINT_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  })
  return data.toLowerCase() !== booted
}

/** The new version signs this session in from its cached key, which only a persistent store keeps. */
const reloadKeepsSession = () => walletStoreIsPersistent() && !!peekAuthService()?.keyCached()

/** A frozen paylink the upgrade refunds: its escrow still holds funds. */
function escrowed(row: HistoricResidualSummary["frozenLinks"][number]): boolean {
  const { eligible, reason } = paylinkRefundEligibility(row, 0)
  return eligible || reason === "within-window"
}

export function MigrationDetectionMount() {
  const obsidionWallet = useResource(useSession().wallet)
  const obsidionAccount = useResource(useSession().account)
  const tokenService = useResource(useSession().token)
  const { balances } = useSession()
  const { contractService } = useContractServiceContext()
  const { notifications, milestones } = useSession()
  const [residuals, setResiduals] = useState<HistoricResidualSummary[]>([])
  const [historic, setHistoric] = useState<OxideEnvTuple[]>()
  const [current, setCurrent] = useState<OxideEnvTuple | null>(null)
  const [destinations, setDestinations] =
    useState<ReadonlyMap<string, ResidualDestination>>(NO_DESTINATIONS)
  const [pendingWithdrawals, setPendingWithdrawals] = useState(0)
  const [migrating, setMigrating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scanRevision, setScanRevision] = useState(0)
  // The last probe ran to a result: a locked wallet or a manifest with no history reads nothing.
  const [scanned, setScanned] = useState(false)
  // The boot probe answered, with or without history.
  const [probed, setProbed] = useState(false)
  // A check could not read the manifest. It reads it again with nothing shown, so 1 Choose waits
  // for the offer.
  const [manifestUnread, setManifestUnread] = useState(false)
  // A check of the old versions failed; `checks` runs them all again.
  const [checkFailed, setCheckFailed] = useState(false)
  const [checks, setChecks] = useState(0)
  const [chainTimeUnknown, setChainTimeUnknown] = useState(false)
  // The dialog opens only on request; with nothing to move or register it lists what is left.
  const [requested, setRequested] = useState(false)
  // The residuals row asked: the dialog lists what is left unless it offers the upgrade.
  const [residualsAsked, setResidualsAsked] = useState(false)
  // An action asked: the sheet is titled for it, and a held one starts once no upgrade is needed.
  const [actionAsked, setActionAsked] = useState<Exclude<MigrationDialogReason, string>>()
  const repointed = useProfileRepoint()
  const [repointDismissed, setRepointDismissed] = useState(false)
  // Its Reload would end a running proof, so the prompt waits for the transaction to settle.
  const losesTransaction = useLeavingLosesTransaction()
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const [resumeSource, setResumeSource] = useState<OxideEnvTuple | null>(null)
  const [metadataRecord, setMetadataRecord] = useState<MetadataMigrationRecord | null>(null)
  // The approvals of every run of the upgrade, counted as one; unset, the shown run's own count.
  const [upgradeCount, setUpgradeCount] = useState<{ approved: number; total: number }>()
  // Every queued run's record while a queue runs; the ring is drawn over all of them.
  const [queueRecords, setQueueRecords] = useState<(MetadataMigrationRecord | null)[]>()
  // The highest figure the ring showed since the run started here; it never goes back.
  const ringShown = useRef(0)
  // No unfinished migration record was found for this account.
  const [recordChecked, setRecordChecked] = useState(false)
  // What the registration check answered, for the inventory and session it was asked under, and the
  // approvals the record update asks for once read.
  const [registrationAnswer, setRegistrationAnswer] = useState<{
    ask: object
    needed?: boolean
    failed?: boolean
    approvals?: number
  }>()
  const railPending = useSponsoredRailPending()
  const railReadFailed = useSponsoredRailReadFailed()
  // A failed readiness read is no answer: the account is neither finishing nor settled on it.
  const railUnread = railPending === undefined || railReadFailed
  // This browser registered the account on this version, so it is not finishing an upgrade.
  const [registeredHere, setRegisteredHere] = useState<boolean>()
  // Followers of each arriving upgrade's source: its funds already move, so it is not offered.
  const [following, setFollowing] = useState<ReadonlyMap<string, number>>(new Map())
  const migrationRun = useRef<AbortController | undefined>(undefined)
  // Scans that follow a run; quotes wait for the last one.
  const rescans = useRef(0)
  // The user's start has approved and proven everything: the dialog hands the run to the bell.
  const [prepared, setPrepared] = useState(false)
  const [handedOff, setHandedOff] = useState(false)
  // The run itself, not the scan that follows it.
  const [runActive, setRunActive] = useState(false)
  // The upgrade's screens (Figma "Migration"): 2 Sign over 1 or S1, and a run the user started here.
  const [signOpen, setSignOpen] = useState(false)
  const [flowRun, setFlowRun] = useState(false)
  // The run started here updates the account, or waits for a background run that does.
  const [updatesAccount, setUpdatesAccount] = useState(false)
  // "Stop upgrade" on Leave upgrade?: the run stops and the flow closes.
  const abandoned = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [errorClosed, setErrorClosed] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [celebrate, setCelebrate] = useState(false)
  // Whether the run the user started here moves no funds, fixed at its start: a funded run's
  // sources read empty once its funds land, before Done shows.
  const [startedUpdateOnly, setStartedUpdateOnly] = useState(false)
  const navigate = useNavigate()
  // The withdrawal opens from 1 Choose, so the upgrade's screens step aside for it.
  const withdrawing = useLocation().pathname.startsWith("/withdraw")
  const networkReady = useNetworkReady()
  const ask = useApprovalAsk()
  useEffect(() => () => migrationRun.current?.abort(), [obsidionWallet, obsidionAccount])
  useEffect(() => {
    if (!obsidionAccount) return
    const account = obsidionAccount.getAddress().toString()
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () =>
      checkUpgradeLock(account).catch((error) => {
        console.warn("[migration] upgrade lock check failed:", error)
        if (live) timer = setTimeout(check, LOCK_RETRY_MS)
      })
    void check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [obsidionAccount])
  // Boot decides once, before the wallet shows, whether 1 Choose stands in for Home while the check
  // runs: from this browser's last answer, else whether the account's L1 record still waits for the
  // upgrade, read within `RECORD_CHECK_WAIT_MS`.
  const account = obsidionAccount?.getAddress().toString()
  const [bootChoice, setBootChoice] = useState<{ account: string; choose: boolean }>()
  useEffect(() => {
    if (!obsidionAccount) return
    const account = obsidionAccount.getAddress().toString()
    let live = true
    const decide = (choose: boolean) => {
      if (live) setBootChoice((now) => (now?.account === account ? now : { account, choose }))
    }
    const answered = upgradeMovedFunds(account)
    if (answered !== undefined) decide(answered)
    const wait = setTimeout(() => decide(false), RECORD_CHECK_WAIT_MS)
    webAccountRecordStale(obsidionAccount)
      .then((stale) => {
        console.info(`[migration] record stale=${stale} at ${Math.round(performance.now())}ms`)
        decide(stale)
      })
      .catch((error) => {
        console.warn("[migration] record check failed:", error)
        decide(false)
      })
    return () => {
      live = false
      clearTimeout(wait)
    }
  }, [obsidionAccount])
  const chooseFirst =
    account === undefined
      ? undefined
      : bootChoice?.account === account
      ? bootChoice.choose
      : upgradeMovedFunds(account)
  const mainBalance = useStore(balances.view)
  const oldHoldings = useOldVersionHoldings()
  // Old versions not read yet hold the boot sync open.
  useEffect(() => {
    if (!oldHoldings.pending) milestones.mark("oldVersionsRead")
  }, [oldHoldings.pending, milestones])
  const savings = useSavingsPosition()

  // A source moves into the pinned deployment, or into the product of its asset.
  const destinationOf = useCallback(
    (tuple: OxideEnvTuple) => destinations.get(tuple.portal.toLowerCase())?.tuple ?? current,
    [destinations, current],
  )

  const checkSpent = useMemo(
    () =>
      obsidionWallet && obsidionAccount && tokenService && contractService
        ? checkSpentViaPaylinkService(
            new PaylinkService(obsidionWallet, obsidionAccount, tokenService, contractService),
          )
        : undefined,
    [obsidionWallet, obsidionAccount, tokenService, contractService],
  )

  // Only the latest scan answers for the inventory.
  const scans = useRef(0)
  // Probes in flight, and the timer that probes again after the manifest could not be read.
  const probing = useRef(0)
  const probeRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * Probes again. `ifIdle` (a timer's probe) starts nothing while a probe is in flight, so a probe
   * slower than the timer still lands. A manifest that cannot be read keeps the last scan, shows
   * nothing, and is read again soon.
   */
  const refresh = useCallback(
    async ({ ifIdle = false }: { ifIdle?: boolean } = {}): Promise<void> => {
      if (!obsidionWallet || !obsidionAccount) return
      if (ifIdle && probing.current > 0) return
      const scan = ++scans.current
      probing.current++
      setRefreshing(true)
      let found: Awaited<ReturnType<typeof probeAccountResiduals>>
      try {
        found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
      } catch (error) {
        console.warn("[migration] re-probe failed:", error)
        if (error instanceof ManifestUnavailableError && scan === scans.current) {
          clearTimeout(probeRetry.current)
          probeRetry.current = setTimeout(() => void refresh({ ifIdle: true }), FREEZE_POLL_MS)
        }
        return
      } finally {
        probing.current--
        if (scan === scans.current) setRefreshing(false)
      }
      if (scan !== scans.current) return
      setScanRevision((n) => n + 1)
      setScanned(!!found)
      if (!found) {
        setResiduals([])
        return
      }
      setCurrent(found.current)
      setOldVersionDestinations(found.current.portal, found.destinations ?? NO_DESTINATIONS)
      setDestinations(found.destinations ?? NO_DESTINATIONS)
      setResiduals(found.residuals)
      setPendingWithdrawals(found.pendingWithdrawals)
      setChainTimeUnknown(!!found.chainTimeUnknown)
      // A source that froze since the last probe is historic now.
      setHistoric(found.historic ?? [])
    },
    [obsidionWallet, obsidionAccount],
  )
  useEffect(() => () => clearTimeout(probeRetry.current), [refresh])

  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // A retry's probe holds every Try again, as a re-probe does.
    setRefreshing(true)
    void (async () => {
      if (!(await milestones.after(PROBE_AFTER)) || cancelled) return
      logStep("probe start")
      const found = await probeAccountResiduals(obsidionWallet, obsidionAccount)
      logStep("probe answer")
      if (cancelled) return
      setScanRevision((n) => n + 1)
      setScanned(!!found)
      setProbed(true)
      if (!found) return
      setCurrent(found.current)
      setOldVersionDestinations(found.current.portal, found.destinations ?? NO_DESTINATIONS)
      setDestinations(found.destinations ?? NO_DESTINATIONS)
      setResiduals(found.residuals)
      setPendingWithdrawals(found.pendingWithdrawals)
      setChainTimeUnknown(!!found.chainTimeUnknown)
      setHistoric(found.historic ?? [])
    })()
      .catch((error) => {
        console.warn("[migration] boot probe failed:", error)
        if (cancelled) return
        // A manifest that cannot be read is no failed check: the check runs again soon, and
        // nothing shows meanwhile.
        if (error instanceof ManifestUnavailableError) {
          setManifestUnread(true)
          retry = setTimeout(() => setChecks((n) => n + 1), FREEZE_POLL_MS)
        } else setCheckFailed(true)
      })
      .finally(() => !cancelled && setRefreshing(false))
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [obsidionWallet, obsidionAccount, checks, milestones])

  // The sources that wait for their migration feature: a saved run of one waits with it.
  const featurePending = residuals
    .filter((r) => r.awaitingFeature)
    .map((r) => r.tuple.portal.toLowerCase())
    .join(",")
  // Follows a source's saved run to its end, one follower per source; the dialog's start hands its
  // run here once what is left needs no user. A `shown` run is the one the dialog shows.
  const followRun = useRef<(source: OxideEnvTuple, promptless: boolean, shown?: boolean) => void>(
    () => {},
  )
  useEffect(() => {
    // A follower needs both services, so the saved runs are read only once it can start.
    if (!obsidionWallet || !obsidionAccount || !current || !historic) return
    if (!contractService || !tokenService) return
    let cancelled = false
    const observing = new AbortController()
    const followed = new Set<string>()
    const isCurrent = (source: OxideEnvTuple) =>
      source.portal.toLowerCase() === current.portal.toLowerCase()
    // An arriving run finishes from chain evidence with no click, no prompt and no send. A
    // `promptless` one also sends what needs no prompt, one step at a time in the background, and,
    // unless it is not `shown`, is the run the dialog shows. Either asks for the dialog only if it
    // stops for the user.
    const follow = async (source: OxideEnvTuple, promptless: boolean, shown = promptless) => {
      const portal = source.portal.toLowerCase()
      if (followed.has(portal)) return
      followed.add(portal)
      const count = (by: number) => (now: ReadonlyMap<string, number>) =>
        new Map(now).set(portal, (now.get(portal) ?? 0) + by)
      setFollowing(count(1))
      try {
        const destination = destinationOf(source)!
        const session = await createWebMetadataMigrationQuietly(
          {
            wallet: obsidionWallet,
            account: obsidionAccount,
            contractService,
            toTokenService: await destinationTokenService(
              obsidionWallet,
              obsidionAccount,
              destination,
              current,
              tokenService,
            ),
            historic: source,
            current: destination,
            // An old version's run moves only funds, and waits for the registration run.
            ...(isCurrent(source) ? {} : { recoveryOnly: true }),
          },
          observing.signal,
        )
        const unsubscribe = shown
          ? session.controller.subscribe(() => {
              if (observing.signal.aborted) return
              setResumeSource(source)
              setMetadataRecord(session.controller.getSnapshot())
            })
          : () => {}
        try {
          await session.controller.load()
          const record = await runMetadataMigration(
            session.controller,
            promptless
              ? {
                  signal: observing.signal,
                  promptless: true,
                  exclusive: backgroundSend,
                }
              : // A re-send of a late batch waits its turn on the prover too.
                { signal: observing.signal, observeOnly: true, exclusive: backgroundSend },
          )
          if (observing.signal.aborted || !record) return
          if (record.phase === "done") {
            if (shown) setResumeSource(null)
            await WalletSyncCoordinator.refresh()
            await refresh()
            return
          }
          setResumeSource(source)
          setMetadataRecord(record)
        } finally {
          unsubscribe()
        }
      } finally {
        followed.delete(portal)
        setFollowing(count(-1))
      }
    }
    followRun.current = (source, promptless, shown) =>
      void follow(source, promptless, shown).catch((error) => {
        console.warn("[migration] upgrade follow failed:", error)
        if (cancelled) return
        // Not known to be paused: the failed check's retry reads the run again.
        if (shown ?? promptless) {
          setResumeSource(null)
          setMetadataRecord(null)
        }
        setCheckFailed(true)
      })
    const awaitsFeature = (source: OxideEnvTuple) =>
      featurePending.split(",").includes(source.portal.toLowerCase())
    void (async () => {
      // Every saved run is read before one is chosen. The registration run comes first: an old
      // version's run waits for it, so it is the run resumed when it waits on the user, unless
      // another run still has approvals to ask. Continue leads with it either way.
      const saved: { source: OxideEnvTuple; record: MetadataMigrationRecord }[] = []
      for (const source of [current, ...historic]) {
        // Its run waits with the source: the source shows as waiting, and nothing offers to continue
        // the run until the migration route is back.
        if (awaitsFeature(source)) continue
        const raw = await webStorage.getItem(
          webMetadataMigrationKey(destinationOf(source) ?? current, source, obsidionAccount),
        )
        if (cancelled) return
        if (!raw) continue
        const record = JSON.parse(raw) as MetadataMigrationRecord
        if (record.phase !== "done") saved.push({ source, record })
      }
      const onItsOwn = ({ source, record }: (typeof saved)[number]) =>
        record.phase === "waiting" ||
        record.phase === "arriving" ||
        (isCurrent(source) && unattended(record))
      const waitsOnUser = saved.filter((run) => !onItsOwn(run))
      const resume =
        waitsOnUser.find(
          ({ record: { approvals } }) => approvals && approvals.approved < approvals.total,
        ) ?? waitsOnUser[0]
      for (const run of saved.filter(onItsOwn)) {
        // A waiting run goes on in the background by itself; the dialog keeps showing what it shows.
        if (run.record.phase === "waiting") followRun.current(run.source, true, false)
        else if (run.record.phase === "arriving") followRun.current(run.source, false)
        // The registration run the dialog shows, unless another run waits on the user.
        else followRun.current(run.source, true, !resume)
      }
      if (resume) {
        setResumeSource(resume.source)
        setMetadataRecord(resume.record)
        setUpgradeCount(upgradeApprovals(saved))
      } else setRecordChecked(true)
    })().catch((error) => {
      console.warn("[migration] metadata probe failed:", error)
      if (!cancelled) setCheckFailed(true)
    })
    return () => {
      cancelled = true
      observing.abort()
      followRun.current = () => {}
    }
    // A finished run's refreshes need not restart the follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    obsidionWallet,
    obsidionAccount,
    current,
    historic,
    contractService,
    tokenService,
    destinationOf,
    featurePending,
  ])

  useEffect(() => {
    if (!obsidionWallet) return
    void reconcilePendingPaylinks(obsidionWallet, checkSpent).catch((error) =>
      console.warn("[migration] paylink reconcile failed:", error),
    )
  }, [obsidionWallet, checkSpent, scanRevision])

  // A destination with a metadata registry settles every source through the record update.
  const metadataFlow = !!current?.accountMetadataRegistry
  // Through the metadata flow a source moves what its batches afford, quoted from chain. A quote
  // belongs to the scan it was taken for; a newer scan's sources are unquoted until it lands.
  const [checked, setChecked] = useState<{
    residuals: HistoricResidualSummary[]
    quotes: ReadonlyMap<string, MigrationSourceQuote>
    /** The sUSDS share price of each destination other than the pinned one, by portal. */
    prices: ReadonlyMap<string, bigint>
    failed: boolean
  }>()
  // The last scan left an old version's holdings unread.
  const [holdingsUnread, setHoldingsUnread] = useState(false)
  useEffect(() => {
    // A running migration moves the funds it would quote; it quotes them again once it stops.
    if (migrating) return
    const funded = residuals.filter(holdsFunds)
    if (
      !scanned ||
      !historic ||
      !metadataFlow ||
      !obsidionWallet ||
      !obsidionAccount ||
      !current ||
      !tokenService ||
      !contractService
    ) {
      setChecked(undefined)
      return
    }
    let cancelled = false
    // A manifest that cannot be read holds the quote, which reads as still checking, until it can.
    const reading = new AbortController()
    void (async () => {
      const next = new Map<string, MigrationSourceQuote>()
      const prices = new Map<string, bigint>()
      let failed = false
      // A product destination holds sUSDS: its share price values its sources in dollars.
      for (const r of funded) {
        const destination = destinationOf(r.tuple)!
        const portal = destination.portal.toLowerCase()
        if (destination === current || prices.has(portal)) continue
        try {
          const client = l1PublicClient(getConfig())
          const vault = await readSavingsVault(client, destination.portal as `0x${string}`)
          prices.set(portal, (await readSavingsPrice(client, vault)).sharePrice)
        } catch (error) {
          failed = true
          console.warn(`[migration] share price read failed for ${destination.portal}:`, error)
        }
      }
      let unread = false
      const quoteOrder = [...historic].sort(
        (a, b) =>
          Number(destinationOf(b) === current) - Number(destinationOf(a) === current) ||
          Number(b.portal === resumeSource?.portal) - Number(a.portal === resumeSource?.portal),
      )
      for (const [read, tuple] of quoteOrder.entries()) {
        if (!cancelled) milestones.progress("oldVersions", read, quoteOrder.length)
        const portal = tuple.portal.toLowerCase()
        const r = residuals.find((x) => x.tuple.portal.toLowerCase() === portal)
        const quoting = !!r && holdsFunds(r)
        // A source waiting for its migration feature is not quoted until the feature appears.
        if (r && (liveSource(r) || r.awaitingFeature)) continue
        if (!quoting && !(r && holdsBalance(r))) {
          // Only a complete scan says a source holds nothing.
          if (r?.incomplete) {
            unread = true
            continue
          }
          await BalanceStorage.get(webStorage)
            .updateBalance(
              oldVersionScope(tuple.portal, obsidionAccount.getAddress().toString()),
              tuple.l2Token,
              0n,
              undefined,
              { strict: true },
            )
            .catch((error) => {
              unread = true
              console.warn("[migration] holdings write failed:", error)
            })
          continue
        }
        try {
          const destination = destinationOf(tuple)!
          const session = await createWebMetadataMigrationQuietly(
            {
              wallet: obsidionWallet,
              account: obsidionAccount,
              contractService,
              toTokenService: await destinationTokenService(
                obsidionWallet,
                obsidionAccount,
                destination,
                current,
                tokenService,
              ),
              historic: tuple,
              current: destination,
              // A frozen source moves only funds, through its destination's migration executor.
              ...(r?.frozen ? { recoveryOnly: true } : {}),
            },
            reading.signal,
            FREEZE_POLL_MS,
            () => setManifestUnread(true),
          )
          if (!(await session.holdings())) unread = true
          if (quoting) next.set(portal, await session.service.quote())
          logStep(`quote ${tuple.portal}`)
        } catch (error) {
          unread = true
          if (quoting) failed = true
          console.warn(`[migration] old version read failed for ${tuple.portal}:`, error)
        }
      }
      if (cancelled) return
      setChecked({ residuals, quotes: next, prices, failed })
      setHoldingsUnread(unread)
      if (!unread) markOldHoldingsRead(obsidionAccount.getAddress().toString())
    })()
    return () => {
      cancelled = true
      reading.abort()
    }
  }, [
    residuals,
    historic,
    scanned,
    destinationOf,
    metadataFlow,
    resumeSource,
    migrating,
    obsidionWallet,
    obsidionAccount,
    current,
    tokenService,
    contractService,
    milestones,
  ])
  const quoted = checked?.residuals === residuals ? checked : undefined
  const quoteOf = (r: HistoricResidualSummary) =>
    metadataFlow ? quoted?.quotes.get(r.tuple.portal.toLowerCase()) : undefined
  // A source's amount in DAI: an sUSDS source's at its destination's share price.
  const valueOf = (r: HistoricResidualSummary, amount: bigint) => {
    const destination = destinationOf(r.tuple)
    const price = destination ? quoted?.prices.get(destination.portal.toLowerCase()) : undefined
    return price === undefined ? amount : savingsValue(amount, price)
  }
  const followed = (r: HistoricResidualSummary) =>
    (following.get(r.tuple.portal.toLowerCase()) ?? 0) > 0
  // Only a frozen source moves, through the metadata flow: the old portal is frozen before this
  // version reaches users. Nothing moves a source awaiting its freeze.
  const movableState = (r: HistoricResidualSummary) =>
    !metadataFlow || r.awaitingFreeze || r.awaitingFeature
      ? false
      : holdsFunds(r) && r.frozen && !followed(r)
      ? quoteOf(r) && quoteOf(r)!.movable > 0n
      : false

  // The freeze turns a source awaiting it into a frozen one, which the next probe offers to move.
  const awaitingPortals = residuals
    .filter((r) => r.awaitingFreeze)
    .map((r) => r.tuple.portal.toLowerCase())
    .join(",")
  useEffect(() => {
    if (!awaitingPortals) return
    const awaiting = residuals.filter((r) => r.awaitingFreeze).map((r) => r.tuple)
    return watchForFreeze(awaiting, () => void refresh())
    // `awaitingPortals` names the watched set; a new residuals array alone does not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPortals, refresh])
  // Withdraw refunds a frozen source to L1 instead, while no upgrade run holds its funds.
  const withdrawable = useMemo(
    () =>
      metadataFlow &&
      obsidionWallet &&
      obsidionAccount &&
      current &&
      tokenService &&
      contractService &&
      recordChecked &&
      !resumeSource &&
      !migrating
        ? residuals
            .filter((r) => r.frozen && !r.incomplete && holdsFunds(r) && !followed(r))
            .map((r) => ({
              source: r.tuple,
              savings: destinationOf(r.tuple) !== current,
              open: async (tipRecipient?: Address) => {
                const destination = destinationOf(r.tuple)!
                return createWebMetadataMigration({
                  wallet: obsidionWallet,
                  account: obsidionAccount,
                  contractService,
                  toTokenService: await destinationTokenService(
                    obsidionWallet,
                    obsidionAccount,
                    destination,
                    current,
                    tokenService,
                  ),
                  historic: r.tuple,
                  current: destination,
                  withdrawal: true,
                  tipRecipient,
                })
              },
              registration: () =>
                createWebMetadataMigration({
                  wallet: obsidionWallet,
                  account: obsidionAccount,
                  contractService,
                  toTokenService: tokenService,
                  historic: current,
                  current,
                }),
            }))
        : [],
    // `following` is what `followed` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      metadataFlow,
      obsidionWallet,
      obsidionAccount,
      current,
      tokenService,
      contractService,
      recordChecked,
      resumeSource,
      migrating,
      residuals,
      following,
      destinationOf,
    ],
  )
  useEffect(() => setWithdrawableSources(withdrawable), [withdrawable])
  useEffect(() => () => setWithdrawableSources([]), [])
  const withdrawn = useOldVersionWithdrawals()
  useEffect(() => {
    if (withdrawn) void refresh()
  }, [withdrawn, refresh])
  // A frozen source waits for its destination's migration feature: each poll reads only the
  // manifest again, and probes again once a waiting source has a route, with no reload.
  useEffect(() => {
    if (!featurePending || !current) return
    const waiting = residuals
      .filter((r) => r.awaitingFeature)
      .map((r) => ({ source: r.tuple, destination: destinationOf(r.tuple) ?? current }))
    return watchForFeature(
      () => migrationFeatureListed(waiting),
      () => void refresh({ ifIdle: true }),
    )
    // `featurePending` names the watched set; a new residuals array alone does not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featurePending, current, destinationOf, refresh])
  // A run waits with its source for the migration feature, as at boot; the saved runs are read
  // again once the feature is back.
  useEffect(() => {
    if (migrating || !resumeSource) return
    if (!featurePending.split(",").includes(resumeSource.portal.toLowerCase())) return
    setResumeSource(null)
    setMetadataRecord(null)
  }, [migrating, resumeSource, featurePending])
  // Every movable source is frozen and moves only funds, through its destination's migration
  // executor. None updates the record: the registration run does.
  const fundsOnly = residuals.filter((r) => movableState(r) === true)
  // A source still being checked is neither offered nor written off yet.
  const checkingMovable = residuals.some((r) => movableState(r) === undefined)
  const probeIncomplete = residuals.some((r) => r.incomplete)
  const scanFailed = probeIncomplete || !!quoted?.failed
  // Only a complete inventory with nothing to move or resume falls through to the registration
  // update, so an unreadable source never reads as an empty one.
  const nothingToMove = scanned && recordChecked && !scanFailed && !checkingMovable && !resumeSource
  // The registration check for this scan. Its answer does not depend on the quotes, so it runs
  // alongside them; it counts only once they find nothing to move.
  const registrationAsk = useMemo(
    () =>
      scanned &&
      recordChecked &&
      !probeIncomplete &&
      !resumeSource &&
      metadataFlow &&
      obsidionWallet &&
      obsidionAccount &&
      current &&
      tokenService &&
      contractService
        ? { obsidionWallet, obsidionAccount, current, tokenService, contractService, scanRevision }
        : undefined,
    [
      scanned,
      recordChecked,
      probeIncomplete,
      resumeSource,
      scanRevision,
      metadataFlow,
      obsidionWallet,
      obsidionAccount,
      current,
      tokenService,
      contractService,
    ],
  )
  // The account still has to update its registration on this version. Undefined until this
  // scan's own check answers, so an earlier answer never stands in.
  const registrationNeeded =
    nothingToMove && metadataFlow
      ? registrationAnswer?.ask === registrationAsk
        ? registrationAnswer?.needed
        : undefined
      : false
  // Like its answer, a failed check counts only once the quotes find nothing to move.
  const registrationFailed =
    nothingToMove &&
    metadataFlow &&
    registrationAnswer?.ask === registrationAsk &&
    !!registrationAnswer?.failed
  useEffect(() => {
    if (!registrationAsk) return
    const ask = registrationAsk
    let cancelled = false
    // A manifest that cannot be read holds the check, which reads as still checking, until it can.
    const reading = new AbortController()
    void (async () => {
      const session = await createWebMetadataMigrationQuietly(
        {
          wallet: ask.obsidionWallet,
          account: ask.obsidionAccount,
          contractService: ask.contractService,
          toTokenService: ask.tokenService,
          historic: ask.current,
          current: ask.current,
        },
        reading.signal,
        FREEZE_POLL_MS,
        () => setManifestUnread(true),
      )
      const needed = await session.service.needsMigration()
      logStep("registration answer")
      if (!cancelled) setRegistrationAnswer({ ask, needed })
      // Display only: a failed read leaves the sheet without its approvals and never fails the check.
      if (needed)
        void (async () => {
          const approvals = await session.service.consentApprovals()
          if (!cancelled)
            setRegistrationAnswer((now) => (now?.ask === ask ? { ...now, approvals } : now))
        })().catch((error) => console.warn("[migration] approvals read failed:", error))
    })().catch((error) => {
      console.warn("[migration] registration check failed:", error)
      if (!cancelled) setRegistrationAnswer({ ask, failed: true })
    })
    return () => {
      cancelled = true
      reading.abort()
    }
  }, [registrationAsk])
  // Only a named account that would otherwise read as finishing needs this browser's records. A
  // nameless one has no registration to finish.
  const askRegisteredHere =
    metadataFlow &&
    nothingToMove &&
    registrationNeeded === false &&
    railPending === true &&
    !railUnread &&
    !!loadWalletIdentity()?.handle
  useEffect(() => {
    if (!obsidionAccount || !askRegisteredHere) return
    let cancelled = false
    const address = obsidionAccount.getAddress().toString().toLowerCase()
    const store = getPendingStore()
    void store
      .load()
      .then(() => {
        if (cancelled) return
        setRegisteredHere(store.list().some((r) => r.l2Address.toLowerCase() === address))
      })
      .catch((error) => console.warn("[migration] registration record read failed:", error))
    return () => {
      cancelled = true
    }
  }, [obsidionAccount, askRegisteredHere])
  // Home waits until a check reads every old version, unless the deployment counts none. With the
  // wallet locked nothing can be read in this page.
  useEffect(() => {
    if (!obsidionAccount) return
    if (probed && scanned && !metadataFlow)
      markOldHoldingsRead(obsidionAccount.getAddress().toString())
    releaseOldHoldingsWait(probed && !scanned)
  }, [obsidionAccount, probed, scanned, metadataFlow])
  useEffect(() => () => releaseOldHoldingsWait(false), [])
  // No check has read every old version yet, and the last one left one unread.
  const holdingsMissing =
    holdingsUnread && !!obsidionAccount && !oldHoldingsRead(obsidionAccount.getAddress().toString())
  const source =
    resumeSource ??
    (registrationNeeded ? current : registrationNeeded === false ? fundsOnly[0]?.tuple : undefined)
  const request = useMigrationDialogRequest()
  const seenRequest = useRef(request)
  useEffect(() => {
    if (request === seenRequest.current) return
    seenRequest.current = request
    const reason = migrationDialogReason()
    setRequested(true)
    setResidualsAsked(reason === "residuals")
    setActionAsked(typeof reason === "object" ? reason : undefined)
  }, [request])
  // The source this run moves, and what its quote moves.
  const executing = residuals.find(
    (r) => !!source && r.tuple.portal.toLowerCase() === source.portal.toLowerCase(),
  )
  const moving = (executing && quoteOf(executing)?.movable) ?? 0n
  // The run whose source is this version updates the account's record, with no funds. It goes first,
  // and the old versions' funds follow it in one queue.
  const registers = !!source && source.portal.toLowerCase() === current?.portal.toLowerCase()
  const followers = registers ? fundsOnly.map((r) => r.tuple) : []
  const funded = !registers || followers.length > 0
  // The upgrade only updates the account: no old version's funds are offered, still being checked,
  // held by a stopped run or moving in a run that goes on.
  const oldVersion = (portal: string) => portal.toLowerCase() !== current?.portal.toLowerCase()
  const oldRunGoesOn = [...following].some(([portal, n]) => n > 0 && oldVersion(portal))
  const movesNoFunds =
    metadataFlow &&
    fundsOnly.length === 0 &&
    !checkingMovable &&
    !(resumeSource && oldVersion(resumeSource.portal)) &&
    !oldRunGoesOn
  // An old version's run moves a frozen source's funds only. As in the registration run's queue, the
  // user's pass only prepares, and each send is a background operation.
  const handsOff = metadataFlow && !registers
  // What a fresh run's batches pay, and the approvals they ask for. A resumed run keeps the
  // selections it saved, which the quote can't see, so it shows what its start was quoted.
  const upgradeSources =
    registers && source
      ? [source, ...followers]
      : handsOff && source
      ? [
          source,
          ...residuals
            .filter(
              (r) =>
                r.frozen &&
                !r.incomplete &&
                holdsFunds(r) &&
                r.tuple.portal.toLowerCase() !== source.portal.toLowerCase() &&
                !followed(r) &&
                quoteOf(r)?.movable,
            )
            .map((r) => r.tuple),
        ].sort(
          (a, b) => Number(destinationOf(b) === current) - Number(destinationOf(a) === current),
        )
      : []
  // Starting now queues only this version's run, which moves nothing.
  const queuesUpdateOnly = metadataFlow && registers && upgradeSources.length === 1 && !oldRunGoesOn
  const sourceQuote = !(resumeSource && metadataRecord) && executing && quoteOf(executing)
  const singleSummary: MetadataMigrationSummary | undefined =
    sourceQuote && sourceQuote.fees !== undefined && sourceQuote.approvals !== undefined
      ? { fees: valueOf(executing!, sourceQuote.fees).toString(), approvals: sourceQuote.approvals }
      : undefined
  // The registration run has no quote: it asks the record update's approval and moves nothing. A
  // resumed one shows what its start was quoted.
  const registrationApprovals = !registers
    ? 0
    : resumeSource && metadataRecord
    ? metadataRecord.summary?.approvals
    : registrationAnswer?.approvals
  const queueQuotes = upgradeSources
    .slice(registers ? 1 : 0)
    .map((tuple) =>
      residuals.find((r) => r.tuple.portal.toLowerCase() === tuple.portal.toLowerCase()),
    )
    .map((r) => r && { r, quote: quoteOf(r) })
  const quotedSummary =
    (upgradeSources.length > 1 || registers) &&
    registrationApprovals !== undefined &&
    queueQuotes.every(
      (entry) => entry?.quote?.approvals !== undefined && entry.quote.fees !== undefined,
    )
      ? {
          fees: queueQuotes
            .reduce((total, entry) => total + valueOf(entry!.r, entry!.quote!.fees!), 0n)
            .toString(),
          approvals: queueQuotes.reduce(
            (total, entry) => total + entry!.quote!.approvals!,
            registrationApprovals,
          ),
        }
      : singleSummary
  const summary =
    upgradeSources.length === 1 && resumeSource && metadataRecord
      ? metadataRecord.summary
      : quotedSummary
  // Each account holds what will land, less its fees, dust and deposits waiting on the old network.
  const lost = { main: 0n, savings: 0n }
  for (const r of residuals) {
    const q = quoteOf(r)
    if (q) {
      const account = destinationOf(r.tuple) === current ? "main" : "savings"
      lost[account] += valueOf(r, (q.fees ?? 0n) + q.stranded + q.waiting)
    }
  }
  const landing =
    mainBalance.known && !oldHoldings.pending
      ? (mainBalance.main?.atomic ?? 0n) + oldHoldings.recordedMain - lost.main
      : undefined
  const heldMain = landing !== undefined && landing < 0n ? 0n : landing
  const savingsLanding =
    oldHoldings.recordedSavings > 0n && !oldHoldings.pending && savings.position
      ? savings.position.value + oldHoldings.recordedSavings - lost.savings
      : undefined
  const heldSavings = savingsLanding !== undefined && savingsLanding < 0n ? 0n : savingsLanding
  // A fresh start takes the lock at that figure, so it waits until the figure is known.
  const figurePending =
    metadataFlow &&
    !(resumeSource && metadataRecord) &&
    (heldMain === undefined || (oldHoldings.recordedSavings > 0n && heldSavings === undefined))

  // What this run won't move: "Also there", and the notification. Residuals with nothing to do (a
  // deposit in transit, a paylink still in its claim window) are a notification, not a boot modal:
  // the modal asks only for an action.
  const stuck = residuals.flatMap((r) =>
    residualItems(r, {
      metadataFlow,
      quote: quoteOf(r),
      executing:
        r === executing ||
        followed(r) ||
        followers.includes(r.tuple) ||
        (upgradeSources.length > 1 &&
          upgradeSources.some(
            (tuple) => tuple.portal.toLowerCase() === r.tuple.portal.toLowerCase(),
          )),
      value: (amount) => valueOf(r, amount),
    }),
  )
  const notes = stuck.map(itemNote)
  const stuckKey = dataKey(stuck)
  // Only a complete scan judges the row; an incomplete one leaves it as it is.
  const scanComplete = scanned && !scanFailed && !checkingMovable && !chainTimeUnknown
  useEffect(() => {
    if (!scanComplete) return
    if (stuck.length === 0)
      return void bestEffort("unknown", notifications.retract(RESIDUALS_NOTIFICATION_ID))
    // Unchanged items keep their time, so a row the user dismissed stays dismissed.
    void bestEffort(
      "unknown",
      notifications.report({
        id: RESIDUALS_NOTIFICATION_ID,
        at: Date.now(),
        kind: "migrationResiduals",
        data: { items: stuck },
      }),
    )
    // `stuck` is read whenever its data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanComplete, stuckKey, notifications])

  // The run the dialog shows goes on without the user, from before its saved record is read.
  const sourceFollowed = !!source && (following.get(source.portal.toLowerCase()) ?? 0) > 0
  // A background run sends the account's update.
  const updateFollowed = !!current && (following.get(current.portal.toLowerCase()) ?? 0) > 0
  // A stopped or interrupted upgrade waits for the user: the bell keeps it until the run moves on.
  const waiting =
    !runActive &&
    !sourceFollowed &&
    !!resumeSource &&
    metadataRecord &&
    !SENT.has(metadataRecord.phase)
      ? metadataRecord.phase
      : undefined
  // A run the boot follows to the end, with no dialog.
  const followingRun = [...following.values()].some((n) => n > 0)
  // The account's registration is current but not active yet, and nothing here is running it.
  const finishing = askRegisteredHere && registeredHere === false
  // Every check answered, and none found anything to do.
  // A probe that read nothing (a sign-out mid-check) settles nothing.
  const settled =
    probed &&
    nothingToMove &&
    fundsOnly.length === 0 &&
    (!metadataFlow ||
      (registrationNeeded === false &&
        !railUnread &&
        (!askRegisteredHere || registeredHere === true)))
  const state: UpgradeState = runActive
    ? "running"
    : // A run that waits for the user shows over another source's followed run, as a follower
    // that stopped after the registration run was handed to the background does.
    waiting
    ? "stopped"
    : followingRun
    ? "running"
    : // An unread run, registration or holdings is never offered over; an unread residual can wait.
    checkFailed || registrationFailed || holdingsMissing
    ? "failed"
    : // A movable source waits until the saved runs are read, so no run is started over one.
    source && (recordChecked || resumeSource)
    ? "offered"
    : scanFailed
    ? "failed"
    : finishing
    ? "finishing"
    : settled
    ? "none"
    : "checking"
  // A stop while the run is going is one it is trying again: the user sees only the one it ends on.
  const retrying = (runActive || sourceFollowed) && metadataRecord?.phase === "needsAttention"
  const runPhase =
    state === "running"
      ? runActive || sourceFollowed
        ? retrying
          ? undefined
          : metadataRecord?.phase
        : "arriving"
      : state === "stopped"
      ? metadataRecord?.phase
      : undefined
  // The metadata flow is what registers the account on this version.
  const registration = metadataFlow && (!!source || finishing)
  // A run's operation keeps the tab, as the bell says.
  const keepOpen = metadataFlow && runActive && losesTransaction
  useEffect(
    () =>
      setUpgradeStatus({
        state,
        phase: runPhase,
        registration,
        keepOpen: keepOpen || undefined,
      }),
    [state, runPhase, registration, keepOpen],
  )
  useEffect(() => () => setUpgradeStatus({ state: "checking", registration: false }), [])
  // What an answered check found, so the next boot shows 1 Choose before its probe answers.
  useEffect(() => {
    if (!obsidionAccount || !metadataFlow) return
    if (state === "offered" || state === "finishing" || state === "none")
      markUpgradeMovesFunds(obsidionAccount.getAddress().toString(), state === "offered" && funded)
  }, [obsidionAccount, metadataFlow, state, funded])
  // A run the user started here ends: a stop asks for the user, an upgraded account shows 5 Done, and
  // a declined prompt 2 Sign again. A run still arriving stays the user's until one of these.
  const runStopped =
    metadataRecord?.phase === "needsAttention" || metadataRecord?.phase === "needsApproval"
  useEffect(() => {
    if (!flowRun || runActive) return
    setLeaving(false)
    if (abandoned.current) {
      abandoned.current = false
      setFlowRun(false)
      setSignOpen(false)
      setRequested(false)
      setResidualsAsked(false)
      setActionAsked(undefined)
    } else if (runStopped || state === "stopped" || state === "failed") {
      setFlowRun(false)
      setRequested(true)
    } else if (metadataRecord?.phase === "done" || state === "none") {
      setFlowRun(false)
      setCelebrate(true)
    } else if (state === "offered") {
      setFlowRun(false)
      setSignOpen(true)
    }
  }, [flowRun, runActive, state, runStopped, metadataRecord?.phase])
  // Any finished upgrade, a followed run's too.
  useEffect(() => {
    if (state === "none" || metadataRecord?.phase === "done")
      notifyIfArmed(upgradeDoneCopy.title, upgradingCopy.doneNotice)
  }, [state, metadataRecord?.phase])
  // 3 shows while the run proves, and while a send still needs this tab.
  const preparingShown =
    flowRun &&
    runActive &&
    (keepOpen || (!handedOff && !prepared && !SENT.has(metadataRecord?.phase ?? "")))
  useBackGuard(preparingShown, () => setLeaving(true))
  // Fully upgraded here: Home shows the live balance again.
  const [releaseRetries, setReleaseRetries] = useState(0)
  useEffect(() => {
    if (state !== "none" || !obsidionAccount) return
    let timer: ReturnType<typeof setTimeout> | undefined
    releaseUpgradeLock(obsidionAccount.getAddress().toString()).catch((error) => {
      console.warn("[migration] upgrade lock release failed:", error)
      timer = setTimeout(() => setReleaseRetries((n) => n + 1), LOCK_RETRY_MS)
    })
    return () => clearTimeout(timer)
  }, [state, obsidionAccount, releaseRetries])
  // A held action goes ahead once the gate would let a press through now.
  const lock = useUpgradeLock(obsidionAccount?.getAddress().toString())
  const cleared = !upgradeVerdict({
    upgrade: state,
    current: lock.state === "released",
    locked: lock.state === "held",
    lockChecked: lock.checked,
  })
  useEffect(() => {
    if (!requested || !cleared || !actionAsked?.then) return
    const run = actionAsked.then
    setRequested(false)
    setActionAsked(undefined)
    run()
  }, [requested, cleared, actionAsked])
  // While the check runs, 1 Choose stands in, its figures loading, if boot chose it. Once it is off
  // screen, Home keeps the screen until the check answers.
  const expected =
    !!chooseFirst &&
    state === "checking" &&
    !manifestUnread &&
    lock.state !== "held" &&
    (!probed || (metadataFlow && residuals.some((r) => movableState(r) !== false)))
  const repointAsked = repointed && !repointDismissed && !losesTransaction
  const onScreen = expected && !withdrawing && !repointAsked
  useEffect(() => {
    if (account && chooseFirst && !(onScreen && !actionAsked))
      setBootChoice({ account, choose: false })
  }, [account, chooseFirst, onScreen, actionAsked])
  // It shows before Home, which holds every way to ask for the dialog, so no request can reach it.
  // One that does is reported, and still answered.
  const askedOverChoose = onScreen && requested
  useEffect(() => {
    if (!askedOverChoose) return
    console.warn("[migration] a dialog request reached boot's 1 Choose")
    fireEvent("action_failed", { action: "upgrade:open", code: "unknown" })
  }, [askedOverChoose])

  const movedOn =
    runActive ||
    recordChecked ||
    (probed && !scanned) ||
    SENT.has(metadataRecord?.phase ?? "preparing")
  const needsYou = waiting ?? (state === "failed" ? "failed" : undefined)
  useEffect(() => {
    if (!needsYou) {
      const retract = async () => {
        if (await notifications.has(RUN_NOTIFICATION_ID))
          await notifications.retract(RUN_NOTIFICATION_ID)
      }
      if (movedOn) void bestEffort("unknown", retract())
      return
    }
    const stop =
      needsYou === "failed" || needsYou === "needsApproval" || needsYou === "needsAttention"
        ? needsYou
        : "paused"
    void bestEffort(
      "unknown",
      notifications.report({
        id: RUN_NOTIFICATION_ID,
        at: Date.now(),
        kind: "migrationRun",
        data: { stop },
      }),
    )
  }, [needsYou, movedOn, notifications])

  // Past the hand-off the migration outlives the modal: its activity rows and the bell report it.
  const left = useRef(false)
  const onLeave = useCallback(() => {
    left.current = true
    setHandedOff(true)
    setRequested(false)
  }, [])

  type QueueJob = MigrationQueueJob & { tuple: OxideEnvTuple }
  /**
   * One source of a queued run. This version's run updates the record; an old version's moves only
   * funds, through its migration executor.
   */
  const queueJob = async (tuple: OxideEnvTuple, signal: AbortSignal): Promise<QueueJob> => {
    const destination = destinationOf(tuple)!
    const registration = tuple.portal.toLowerCase() === current!.portal.toLowerCase()
    const session = await createWebMetadataMigrationQuietly(
      {
        wallet: obsidionWallet!,
        account: obsidionAccount!,
        contractService: contractService!,
        toTokenService: await destinationTokenService(
          obsidionWallet!,
          obsidionAccount!,
          destination,
          current!,
          tokenService!,
        ),
        historic: tuple,
        current: destination,
        ...(registration ? {} : { recoveryOnly: true }),
      },
      signal,
    )
    await session.controller.load()
    const residual = residuals.find(
      (r) => r.tuple.portal.toLowerCase() === tuple.portal.toLowerCase(),
    )
    const quote = residual && quoteOf(residual)
    return {
      tuple,
      controller: session.controller,
      summary: registration
        ? registers && registrationApprovals !== undefined
          ? { fees: "0", approvals: registrationApprovals }
          : undefined
        : quote?.fees !== undefined && quote.approvals !== undefined
        ? { fees: valueOf(residual!, quote.fees).toString(), approvals: quote.approvals }
        : undefined,
    }
  }
  /**
   * This version's unfinished run, which old versions' runs wait on, unless a background follower
   * sends it. A queue saves it before any old version's run, so none saved means the tag needed none.
   */
  const registrationLead = async (signal: AbortSignal) => {
    if (!obsidionAccount || (following.get(current!.portal.toLowerCase()) ?? 0) > 0)
      return undefined
    const raw = await webStorage.getItem(
      webMetadataMigrationKey(current!, current!, obsidionAccount),
    )
    if (!raw || (JSON.parse(raw) as MetadataMigrationRecord).phase === "done") return undefined
    return queueJob(current!, signal)
  }
  /** The queue's jobs. An old version's source that can't be opened waits for the next check. */
  const queueJobs = async (lead: QueueJob | undefined, signal: AbortSignal) => {
    const jobs = lead ? [lead] : []
    let unavailable: unknown
    for (const tuple of upgradeSources) {
      try {
        jobs.push(await queueJob(tuple, signal))
      } catch (error) {
        if (signal.aborted || tuple.portal.toLowerCase() === current!.portal.toLowerCase())
          throw error
        console.warn(`[migration] upgrade source unavailable: ${tuple.portal}`, error)
        unavailable ??= error
      }
    }
    if (!jobs.length) throw unavailable
    return jobs
  }

  const onMigrate = async () => {
    if (migrationRun.current || sourceFollowed || figurePending || !networkReady || !metadataFlow)
      return
    if (
      !source ||
      !current ||
      !obsidionWallet ||
      !obsidionAccount ||
      !tokenService ||
      !contractService
    ) {
      return
    }
    const run = new AbortController()
    migrationRun.current = run
    // The click that started the run opens its first prompt.
    resetApprovals()
    grantApproval()
    setFlowRun(metadataFlow)
    setUpdatesAccount(registers || updateFollowed)
    setStartedUpdateOnly(queuesUpdateOnly)
    setSignOpen(false)
    setErrorClosed(false)
    setUpgradeCount(undefined)
    setQueueRecords(undefined)
    ringShown.current = 0
    setMigrating(true)
    setRunActive(true)
    setPrepared(false)
    setHandedOff(false)
    left.current = false
    try {
      const address = obsidionAccount.getAddress().toString()
      await acquireUpgradeLock(address, heldMain, heldSavings)
      const lead = registers ? undefined : await registrationLead(run.signal)
      if (lead) setUpdatesAccount(true)
      if (upgradeSources.length > 1 || registers || lead) {
        const jobs = await queueJobs(lead, run.signal)
        const count = () => {
          const records = jobs.map((job) => job.controller.getSnapshot())
          setQueueRecords(records)
          setUpgradeCount(
            upgradeApprovals(jobs.map((job, i) => ({ record: records[i], summary: job.summary }))),
          )
        }
        try {
          // Only the prepare pass is a user flow; each send is its own background operation.
          let approved = false
          const sent = await runGatedMigrationQueue(
            {
              operationId: `migration_${crypto.randomUUID()}`,
              flow: "migration",
              summary: copy.summary,
            },
            jobs,
            {
              signal: run.signal,
              onPrepared: () => {
                approved = true
                setPrepared(true)
              },
              onRecord: (_job, record) => {
                if (run.signal.aborted) return
                setMetadataRecord(record)
                count()
              },
              onActive: (job) => {
                // Until every source is approved, a retry starts again from the first source.
                setResumeSource((approved ? job : jobs[0]!).tuple)
                count()
                return job.controller.subscribe(() => {
                  if (run.signal.aborted) return
                  setMetadataRecord(job.controller.getSnapshot())
                  count()
                })
              },
              onArriving: (job) => followRun.current(job.tuple, false),
              // Numbered over the whole queue: each run counts only its own approvals.
              beforeApproval: () => {
                const { approved, total } = upgradeApprovals(
                  jobs.map((job) => ({
                    record: job.controller.getSnapshot(),
                    summary: job.summary,
                  })),
                )!
                return beforeApproval(approved, total, run.signal)
              },
              onEnd: (sent) => {
                if (!sent) throw new UpgradeStopped("Upgrade stopped before every source was sent")
              },
            },
          )
          if (sent) {
            setResumeSource(null)
            setMetadataRecord(null)
          }
        } finally {
          await refresh()
        }
        return
      }
      const destination = destinationOf(source)!
      const session = await createWebMetadataMigrationQuietly(
        {
          wallet: obsidionWallet,
          account: obsidionAccount,
          contractService,
          toTokenService: await destinationTokenService(
            obsidionWallet,
            obsidionAccount,
            destination,
            current,
            tokenService,
          ),
          historic: source,
          current: destination,
          // A funds-only source prepares only ordinary deposits, whatever registration it finds.
          recoveryOnly: true,
        },
        run.signal,
      )
      const unsubscribe = session.controller.subscribe(() => {
        if (!run.signal.aborted) setMetadataRecord(session.controller.getSnapshot())
      })
      try {
        await session.controller.load()
        setResumeSource(source)
        const progress = {
          signal: run.signal,
          summary: quotedSummary,
          beforeApproval: (approved: number, total: number) =>
            beforeApproval(approved, total, run.signal),
        }
        const sent = await runListedOperation(
          {
            operationId: `migration_${crypto.randomUUID()}`,
            flow: "migration",
            summary: migrationSummary(formatUnits(moving, DEFAULT_DECIMALS)),
          },
          async () => {
            const stopped = (record: MetadataMigrationRecord | null) => {
              run.signal.throwIfAborted()
              if (record?.phase === "needsAttention" || record?.phase === "needsApproval") {
                console.warn("[migration] stopped:", record.error)
                throw new UpgradeStopped(record.error)
              }
            }
            // The user's own pass asks for the approvals and builds the proofs. It sends
            // nothing, and it ends before the send pass starts.
            const prepared = await runUserFlow(() =>
              runMetadataMigration(session.controller, {
                ...progress,
                prepareOnly: true,
                retry: true,
                onPrepared: () => setPrepared(true),
              }),
            )
            // As in a queue, a stop while preparing is the user's: nothing was sent.
            stopped(prepared)
            if (!prepared) return prepared
            // The send pass can wait for the subsidy or for the registration run's
            // sponsorship. Thus it is not a user flow, and each send is a background step.
            const record = await runMetadataMigration(session.controller, {
              ...progress,
              beforeApproval: undefined,
              retry: true,
              prompts: false,
              untilArriving: true,
              exclusive: backgroundSend,
              onPrepared: () => setPrepared(true),
            })
            stopped(record)
            return record
          },
        )
        // The rest follows from chain evidence, with no prompt. Only a late batch is sent again.
        const record =
          sent?.phase === "arriving"
            ? await runMetadataMigration(session.controller, {
                signal: run.signal,
                observeOnly: true,
                exclusive: backgroundSend,
              })
            : sent
        if (run.signal.aborted) return
        if (record?.phase === "done") {
          setResumeSource(null)
          await WalletSyncCoordinator.refresh()
        }
      } finally {
        unsubscribe()
        // The run is over: the dialog shows how it stopped while the scan after it runs.
        if (migrationRun.current === run) migrationRun.current = undefined
        setRunActive(false)
        // The run moved funds the old quote counted.
        setChecked(undefined)
        rescans.current++
        try {
          await refresh()
        } finally {
          rescans.current--
        }
      }
    } catch (error) {
      // Back to the prompt: a closed passkey prompt or a cancel is the user's own no, and a stopped
      // upgrade says why itself; anything else is shown.
      if (
        !left.current &&
        !run.signal.aborted &&
        !isFlowCancelled(error) &&
        !(error instanceof UpgradeStopped)
      ) {
        showReportableError(error, "migration:upgrade")
      }
    } finally {
      if (migrationRun.current === run) migrationRun.current = undefined
      // Unless a press during the scan after this run started another.
      if (!migrationRun.current) {
        setRunActive(false)
        setChecked(undefined)
      }
      if (!migrationRun.current && !rescans.current) setMigrating(false)
    }
  }

  // The boot screen covers the wallet until boot decides.
  if (account !== undefined && chooseFirst === undefined) return <BootSplash covers />
  if (repointAsked) {
    return (
      <Modal
        variant="bare"
        label={copy.repoint.label}
        className="ww-modal--create ww-logout"
        onClose={() => setRepointDismissed(true)}
      >
        <div data-testid="migration-repoint-modal" className={styles.migration}>
          <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
            {copy.repoint.title}
          </GradientText>
          <p className="ww-logout__body">
            {reloadKeepsSession() ? copy.repoint.reload : copy.repoint.reloadSignIn}
          </p>
          <div className="ww-logout__actions">
            <PrimaryGradientButton
              title={copy.repoint.later}
              buttonStyle="dark"
              onClick={() => setRepointDismissed(true)}
            />
            <PrimaryGradientButton title={copy.repoint.action} onClick={() => void reloadPage()} />
          </div>
        </div>
      </Modal>
    )
  }

  // Savings the upgrade already moved count too: the old holdings no longer show them. While the
  // lock is held, its figure stands: arrivals land before the old holdings are read again.
  const held = lock.state === "held" ? lock : undefined
  const balance = {
    main: held?.main ?? heldMain,
    savings: held?.savings ?? heldSavings ?? savings.position?.value,
  }
  // Before the quotes, the probe's figure: fees aside, and without deposits still waiting, as `lost`
  // leaves them out. A deposit or Savings source it cannot value leaves it loading.
  const counted = residuals.filter((r) => !liveSource(r) && !r.awaitingFeature && holdsFunds(r))
  const probeBalance =
    probed &&
    mainBalance.known &&
    counted.every((r) => r.sweptDeposits === 0 && destinationOf(r.tuple) === current)
      ? {
          main: counted.reduce((total, r) => total + r.balance, mainBalance.main?.atomic ?? 0n),
          savings: savings.position?.value,
        }
      : {}
  const flowApprovals = metadataRecord?.approvals && (upgradeCount ?? metadataRecord.approvals)
  // A queue's records stand until its dialog closes: the check after the run reads no phase.
  const queued = flowRun ? queueRecords : undefined
  const steps = upgradeSteps(
    queued ? queued.map((record) => record?.phase) : [runPhase],
    !(flowRun ? updatesAccount : updateFollowed),
  )
  const updateOnly = flowRun || celebrate ? startedUpdateOnly : movesNoFunds
  const updating = updateOnly || steps[0] === "active"
  const drawn = queued
    ? queueProgress(queued, flowApprovals, updating)
    : upgradeProgress(runPhase, flowApprovals, updating)
  if (flowRun) ringShown.current = Math.max(ringShown.current, drawn.percent)
  const ring = flowRun ? { ...drawn, percent: ringShown.current } : drawn
  if (celebrate) {
    return (
      <UpgradeDone
        balance={balance}
        updateOnly={updateOnly}
        onClose={() => {
          setCelebrate(false)
          navigate("/")
        }}
      />
    )
  }
  if (flowRun && !(!runActive && (runStopped || abandoned.current))) {
    const waitReason = metadataRecord?.phase === "waiting" ? metadataRecord.waitReason : undefined
    const preparing = (signing = false) => (
      <UpgradePreparing
        balance={balance}
        ring={ring}
        steps={steps}
        ask={ask}
        signing={signing}
        waitReason={waitReason}
        leaving={leaving}
        sending={prepared}
        updateOnly={updateOnly}
        onStay={() => setLeaving(false)}
        onLeave={() => {
          abandoned.current = true
          setLeaving(false)
          resetApprovals()
          migrationRun.current?.abort()
        }}
        onSign={grantApproval}
        onCancel={() => setLeaving(true)}
      />
    )
    if (runActive && !handedOff) {
      return (
        <OperationHandOff
          until="prepared"
          prepared={prepared}
          onLeave={onLeave}
          renderWorking={(beat) => preparing(beat === "signing")}
        />
      )
    }
    if (preparingShown || (!handedOff && !prepared && !SENT.has(metadataRecord?.phase ?? "")))
      return preparing()
    return (
      <UpgradeMoving
        balance={balance}
        ring={ring}
        steps={steps}
        waitReason={waitReason}
        updateOnly={updateOnly}
      />
    )
  }
  if (metadataFlow && state === "running" && !runActive && !actionAsked && !residualsAsked) {
    return (
      <UpgradeMoving
        balance={balance}
        ring={ring}
        steps={steps}
        waitReason={metadataRecord?.phase === "waiting" ? metadataRecord.waitReason : undefined}
        updateOnly={updateOnly}
      />
    )
  }
  const sign = (
    <UpgradeSign
      balance={balance}
      approvals={
        state === "stopped" && flowApprovals
          ? flowApprovals
          : { approved: 0, total: summary?.approvals ?? 1 }
      }
      disabled={busy || figurePending || sourceFollowed || !networkReady}
      updateOnly={queuesUpdateOnly}
      onSign={() => {
        setRequested(false)
        void onMigrate()
      }}
      onClose={() => {
        setSignOpen(false)
        setRequested(false)
        setActionAsked(undefined)
      }}
    />
  )
  const paylinks = residuals.some(
    (r) =>
      r.paylinkCandidates.some((row) => !r.lockedPaylinks.includes(row)) ||
      r.frozenLinks.some(escrowed),
  )
  // Until the network proves a checkpoint, 1 Choose waits, as the Figma's D1 does.
  const networkWait = networkReady
    ? undefined
    : { until: fmt(copy.utc, { time: new Date(WINDOW_ENDS).toISOString().slice(11, 16) }) }
  const reopen = state === "stopped" && metadataRecord ? reopenScreen(metadataRecord) : undefined
  if (metadataFlow && reopen && metadataRecord && !actionAsked && !withdrawing) {
    const resume = () => void onMigrate()
    const support = supportOpen && <BugReportModal onClose={() => setSupportOpen(false)} />
    if (reopen === "finish") {
      return (
        <>
          <UpgradeFinish balance={balance} onResume={resume} />
          {support}
        </>
      )
    }
    if (reopen === "left") {
      return (
        <UpgradeLeft
          balance={balance}
          onStart={() => setSignOpen(true)}
          overlay={signOpen && sign}
        />
      )
    }
    // S3 is a sheet over 1 Choose, without its withdrawal: the stopped run holds the funds.
    return (
      <UpgradeChoose
        balance={balance}
        paylinks={paylinks}
        waiting={networkWait}
        onUpgrade={() => setSignOpen(true)}
        overlay={
          signOpen
            ? sign
            : supportOpen
            ? support
            : !errorClosed && (
                <ErrorSheet
                  what={upgradeStopReason(metadataRecord)}
                  reference={(metadataRecord.id ?? "").slice(0, 8).toUpperCase()}
                  onRetry={resume}
                  onSupport={() => setSupportOpen(true)}
                  onClose={() => setErrorClosed(true)}
                />
              )
        }
      />
    )
  }
  // 1 Choose stands in for Home while an upgrade has funds to move. A record update alone shows only
  // on request. An action's request keeps its own sheet.
  const choose = metadataFlow && state === "offered" && (funded || requested || signOpen)
  if ((choose || expected) && !withdrawing && !actionAsked) {
    return (
      <UpgradeChoose
        balance={expected ? (quoted ? balance : probeBalance) : balance}
        paylinks={paylinks}
        waiting={networkWait}
        checking={expected}
        onUpgrade={() => setSignOpen(true)}
        onWithdraw={
          updateOnly && withdrawable.length === 0 ? undefined : () => navigate("/withdraw")
        }
        overlay={!expected && (signOpen || requested) && sign}
      />
    )
  }

  if (!requested) return null
  const offer = !!source && (state === "offered" || state === "running" || state === "stopped")
  // With nothing to offer or follow, or when the residuals row asked, the dialog lists what is left.
  // An action held while the check runs waits in the sheet rather than in the list.
  const holding = !!actionAsked && state === "checking"
  const listing =
    !offer &&
    !holding &&
    (state === "none" || state === "checking" || (residualsAsked && state !== "failed"))
  // A saved run may still hold funds the scan no longer sees.
  const runsUnread = !recordChecked && !resumeSource
  const retryChecks = () => {
    setCheckFailed(false)
    setChecks((n) => n + 1)
  }

  const close = () => {
    // Before the hand-off a close cancels the run; after it, the run goes on without the dialog.
    if (!left.current) migrationRun.current?.abort()
    setRequested(false)
    setResidualsAsked(false)
    setActionAsked(undefined)
  }
  if (listing) {
    return (
      <Modal
        variant="bare"
        label={copy.residuals.title}
        className="ww-modal--create"
        onClose={close}
      >
        <div data-testid="migration-residuals-modal" className={styles.migration}>
          <div className="ww-modal__close">
            <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={close} />
          </div>
          <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
            {copy.residuals.title}
          </GradientText>
          {stuck.length > 0 && (
            <ul className={styles.migrationResiduals}>
              {stuck.map((item, i) => (
                <li key={i}>{itemLine(item)}</li>
              ))}
            </ul>
          )}
          {!scanComplete || runsUnread ? (
            <p className="ww-migration__lead">{copy.residuals.checking}</p>
          ) : (
            !stuck.length && <p className="ww-migration__lead">{copy.residuals.none}</p>
          )}
          <PrimaryGradientButton
            title={copy.tryAgain}
            isDisabled={refreshing}
            onClick={() => void refresh()}
          />
          <button
            type="button"
            className={`zkm-btn-reset ${styles.migrationLater}`}
            onClick={close}
          >
            {copy.close}
          </button>
        </div>
      </Modal>
    )
  }
  const phase = metadataRecord && !retrying ? upgradePhaseText(metadataRecord) : undefined
  const title = actionAsked ? actionUpgradeTitle[actionAsked.action] : offerCopy.title
  const working = runActive && !handedOff
  // Counted over the upgrade once the shown run asks: a run yet to ask keeps its own label.
  const approvals = metadataRecord?.approvals && (upgradeCount ?? metadataRecord.approvals)
  return (
    <Modal variant="bare" label={copy.label} className="ww-modal--create" onClose={close}>
      <div data-testid="migration-detected-modal" className={styles.migration}>
        {working ? (
          <OperationHandOff
            until="prepared"
            prepared={prepared}
            onLeave={onLeave}
            renderWorking={(beat, _label, hint) => (
              <>
                <PayWorking beat={beat} hint={hint} onCancel={close} warn={false} />
                {approvals && approvals.approved < approvals.total && (
                  <p className="ww-migration__note">
                    {fmt(copy.approve, { n: approvals.approved + 1, total: approvals.total })}
                  </p>
                )}
                <UpgradeKeepOpen />
              </>
            )}
          />
        ) : (
          <>
            <div className="ww-modal__close">
              <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={close} />
            </div>
            {offer ? (
              <UpgradeIntro title={title} lead={offerCopy.lead} />
            ) : holding ? (
              <UpgradeIntro title={title} lead={checkingLead} />
            ) : state === "finishing" ? (
              <UpgradeIntro title={finishingCopy.title} lead={finishingCopy.lead} />
            ) : state === "running" ? (
              <UpgradeIntro title={title} lead={followingLead} />
            ) : (
              <>
                <GradientText
                  gradient="title"
                  size={24}
                  weight={700}
                  style={{ textAlign: "center" }}
                >
                  {copy.checkFailed.title}
                </GradientText>
                <p className="ww-migration__lead">{copy.checkFailed.body}</p>
              </>
            )}
            {/* The upgrade charges no fee: the sheet counts only the approvals, the record update's
                and one for each batch of the account's own funds. */}
            {offer && metadataFlow && summary && (
              <div className="ww-pay__summary">
                <ConfirmationSheetDetailRow
                  label={copy.approvals}
                  value={String(summary.approvals)}
                />
              </div>
            )}
            {(keepOpen || (metadataFlow && !runActive && offer)) && <UpgradeKeepOpen />}
            {phase && <p className="ww-migration__note">{phase}</p>}
            {metadataRecord?.error && !retrying && (
              <p className="ww-migration__note" role="alert">
                {upgradeStopText(metadataRecord)}
              </p>
            )}
            {offer && metadataFlow && notes.length > 0 && (
              <p className="ww-migration__note">
                {fmt(copy.alsoThere, { notes: notes.join(" · ") })}
              </p>
            )}
            {pendingWithdrawals > 0 && (
              <p className="ww-migration__note" data-testid="migration-pending-withdrawals">
                {fmt(copy.pendingWithdrawals, { count: pendingWithdrawals })}
              </p>
            )}
            {offer ? (
              <PrimaryGradientButton
                title={
                  runActive || sourceFollowed
                    ? copy.upgrading
                    : busy
                    ? busyLabel
                    : figurePending
                    ? copy.checkingBalances
                    : resumeSource && metadataRecord
                    ? continueLabel(metadataRecord, approvals)
                    : copy.upgradeNow
                }
                isDisabled={busy || runActive || sourceFollowed || figurePending || !networkReady}
                onClick={() => void onMigrate()}
              />
            ) : (
              state === "failed" && (
                <PrimaryGradientButton
                  title={copy.tryAgain}
                  isDisabled={refreshing}
                  onClick={() =>
                    checkFailed || registrationFailed ? retryChecks() : void refresh()
                  }
                />
              )
            )}
            <button
              type="button"
              className={`zkm-btn-reset ${styles.migrationLater}`}
              onClick={close}
            >
              {runActive || sourceFollowed || !offer ? copy.close : copy.maybeLater}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * What is left of the registration run, whose source is this version, needs no user once its
 * record update is signed and its bootstrap sent, unless it stopped for the user.
 */
function unattended(record: MetadataMigrationRecord): boolean {
  return (
    !!record.bootstrapTx &&
    record.phase !== "needsApproval" &&
    (record.phase !== "needsAttention" || retryableStop(record))
  )
}

/** Every batch is sent: what is left needs no tab and no user. */
const SENT: ReadonlySet<string> = new Set(["arriving", "done"])

const logStep = (step: string) =>
  console.log(`[migration] ${step} at ${Math.round(performance.now())}ms`)

/** A source still taking transactions. The metadata flow neither reads nor moves one without a run. */
function liveSource(r: HistoricResidualSummary): boolean {
  return !r.frozen && !r.incomplete
}

/** Funds a source's first batch could move: a balance, or a frozen source's unclaimed deposits. */
function holdsFunds(r: HistoricResidualSummary): boolean {
  return r.balance > 0n || (r.frozen && r.sweptDeposits > 0)
}

/** Funds Home counts on a source: what a batch could move, and deposits still waiting to. */
function holdsBalance(r: HistoricResidualSummary): boolean {
  return holdsFunds(r) || (r.frozen && r.waitingDeposits > 0)
}

/** A payment link's amount is its row's; one without a known amount leaves the total unknown. */
function linkTotal(rows: HistoricResidualSummary["paylinkCandidates"]): bigint | undefined {
  if (rows.some((row) => !row.token || row.token.hasUnknownAmount)) return undefined
  return rows.reduce(
    (sum, row) => sum + row.amountAtomic * 10n ** BigInt(DEFAULT_DECIMALS - row.token!.decimals),
    0n,
  )
}

/**
 * What a residual holds that a run won't move now, kind by kind. A quoted source shows what no batch
 * affords, and, unless the run takes it (`executing`), what it moves later. A quote counts a frozen
 * source's swept deposits. A live balance counts only the swept deposits stored in this PXE, so with
 * no balance none of them is in it.
 */
function residualItems(
  r: HistoricResidualSummary,
  v: {
    metadataFlow: boolean
    quote?: MigrationSourceQuote
    executing: boolean
    /** A source amount in DAI. */
    value: (amount: bigint) => bigint
  },
): ResidualItem[] {
  const items: ResidualItem[] = []
  const awaiting = r.awaitingFreeze ? "awaiting" : r.awaitingFeature ? "awaitingFeature" : undefined
  if (awaiting) {
    if (r.balance > 0n || r.sweptDeposits > 0)
      items.push({
        kind: awaiting,
        amount: r.balance > 0n ? v.value(r.balance) : undefined,
        deposits: r.sweptDeposits,
      })
  } else if (v.quote) {
    if (!v.executing && v.quote.movable > 0n)
      items.push({ kind: "other", amount: v.value(v.quote.movable) })
    if (v.quote.stranded > 0n)
      items.push({ kind: "balance", amount: v.value(v.quote.stranded), stranded: "small" })
  } else if (r.balance > 0n && r.frozen) {
    const stranded = v.metadataFlow ? "small" : "frozen"
    items.push({ kind: "balance", amount: v.value(r.balance), stranded })
  } else if (r.balance > 0n && !v.executing) {
    items.push({ kind: "other", amount: v.value(r.balance) })
  }
  if (r.sweptDeposits > 0 && !awaiting && (r.frozen ? !v.quote : r.balance === 0n))
    items.push({ kind: "unclaimed", count: r.sweptDeposits })
  if (r.inTransitDeposits > 0) {
    const amount = r.inTransitAmount > 0n ? v.value(r.inTransitAmount) : undefined
    items.push({ kind: "transit", count: r.inTransitDeposits, amount })
  }
  // A quote reads the Inbox later than the scan did, so a quoted source's waiting is its quote's.
  const waiting = v.quote ? v.quote.waiting : r.waitingAmount
  if (r.waitingDeposits > 0 && (!v.quote || waiting > 0n)) {
    const amount = waiting > 0n ? v.value(waiting) : undefined
    items.push({ kind: "waiting", count: r.waitingDeposits, amount })
  }
  if (r.unverifiedMoves) items.push({ kind: "unverified", count: r.unverifiedMoves })
  // With the chain clock unread, a still-escrowed link is neither refundable nor locked yet.
  const open = r.paylinkCandidates.filter((row) => !r.lockedPaylinks.includes(row))
  if (open.length > 0) items.push({ kind: "link", count: open.length, amount: linkTotal(open) })
  if (r.lockedPaylinks.length > 0) {
    items.push({
      kind: "locked",
      count: r.lockedPaylinks.length,
      amount: linkTotal(r.lockedPaylinks),
      until: Math.max(...r.lockedPaylinks.map((row) => row.untilClaimable ?? 0)),
    })
  }
  return items
}

const { items: itemCopy } = copy
const deposits = (n: number) => (n === 1 ? itemCopy.deposit : fmt(itemCopy.deposits, { n }))
const links = (n: number) => (n === 1 ? itemCopy.link : fmt(itemCopy.links, { n }))

/** Why each kind is still there, for the dialog's list. */
function itemLine(item: ResidualItem): string {
  const one = "count" in item && item.count === 1
  const sum = item.amount === undefined ? undefined : money(item.amount)
  switch (item.kind) {
    case "balance":
      return fmt(itemCopy.balance, { sum: String(sum) })
    case "other":
      return fmt(itemCopy.other, { sum: String(sum) })
    case "awaiting":
    case "awaitingFeature": {
      const many = fmt(itemCopy.unclaimedMany, { n: item.deposits })
      const held = sum
        ? item.deposits
          ? fmt(itemCopy.heldWith, {
              sum,
              unclaimed: item.deposits === 1 ? itemCopy.unclaimedOne : many,
            })
          : sum
        : item.deposits === 1
        ? itemCopy.unclaimedOneStart
        : many
      const once = item.kind === "awaiting" ? itemCopy.onceFrozen : itemCopy.onceReady
      const one = sum ? !item.deposits : item.deposits === 1
      return fmt(one ? itemCopy.awaitingOne : itemCopy.awaitingMany, { held, once })
    }
    case "unclaimed":
      return sum
        ? fmt(itemCopy.unclaimedSum, { sum })
        : fmt(itemCopy.unclaimedCount, {
            deposits: one
              ? itemCopy.unclaimedOneStart
              : fmt(itemCopy.unclaimedMany, { n: item.count }),
          })
    case "transit":
      return fmt(one ? itemCopy.transitOne : itemCopy.transitMany, {
        what: sum ?? deposits(item.count),
      })
    case "waiting":
      return fmt(one ? itemCopy.waitingOne : itemCopy.waitingMany, {
        what: sum ?? deposits(item.count),
      })
    case "link":
      return sum
        ? fmt(itemCopy.linkSum, { sum, links: links(item.count) })
        : fmt(itemCopy.linkFunds, { links: links(item.count) })
    case "unverified":
      return fmt(itemCopy.unverified, {
        moves:
          item.count === 1 ? itemCopy.savingsMove : fmt(itemCopy.savingsMoves, { n: item.count }),
      })
    case "locked":
      return sum
        ? fmt(itemCopy.lockedSum, { sum, links: links(item.count), until: lockedUntil(item.until) })
        : one
        ? fmt(itemCopy.lockedOne, { until: lockedUntil(item.until) })
        : fmt(itemCopy.lockedMany, { n: item.count, until: lockedUntil(item.until) })
  }
}

/** The destination's token service: the wallet's own for the pinned deployment. */
async function destinationTokenService(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  destination: OxideEnvTuple,
  current: OxideEnvTuple,
  tokenService: TokenService,
): Promise<TokenService> {
  if (destination === current) return tokenService
  return TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(destination.l2Token))
}

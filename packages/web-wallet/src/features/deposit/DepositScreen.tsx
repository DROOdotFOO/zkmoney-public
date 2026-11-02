import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import {
  isUnfundedSipaDeposit,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  SIPADepositStore,
  type AddressRoute,
  type SIPADepositRecord,
  useCachedRecords,
  useContractServiceContext,
  useResource,
} from "@obsidion/front-core"
import type { SipaIntentName } from "@obsidion/core/oxide"
import { GradientText, Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import paylinkCoins from "../../assets/home/paylink-coins.webp"
import { getConfig } from "../../config/env"
import { useUserFlowActive } from "../provingGate"
import { showReportableError } from "../../errors/errorModal"
import {
  amountBucket,
  failureCode,
  fireEvent,
  fireOnboardingEvent,
  lapTimer,
} from "../../lib/analytics"
import { useCopy } from "../../ui/hooks"
import { shortL1Addr, tokenFigure } from "../../ui/format"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useRegistrationEscalated, useTagPresentationPending } from "../onboarding/webRegistration"
import { RegistrationPendingError } from "../onboarding/registrationRail"
import { useOwedRegistration } from "../onboarding/owedRegistration"
import { useRegistrationDepositTarget } from "../onboarding/registrationDepositTarget"
import { OweRegistrationBroadcast } from "../broadcasts/useOweRegistrationBroadcast"
import { RegistrationAskLine, useRegistrationAsk } from "../onboarding/RegistrationAskLine"
import { formatDepositDue } from "../onboarding/steps/DepositTermsRows"
import { ChooseNameSheet } from "../onboarding/ChooseNameSheet"
import {
  confirmRegistrationTag,
  useOpenRegistration,
  useRegistrationTagConfirmed,
} from "../onboarding/openRegistration"
import { buildErc20TransferUriWithoutAmount } from "../requests/eip681"
import { DepositFromWalletModal, type SentDeposit } from "./DepositFromWalletModal"
import { DepositCoinModal, DepositTokensStatus } from "./DepositCoinModal"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { isDemoMode } from "../../dev/demoFlag"
import { DepositDetailModal } from "../../ui/screens/DepositDetailModal"
import {
  depositCreditNote,
  loadDepositDisplayFacts,
  settlementOf,
  useDepositTokensRead,
  type DepositDisplayFacts,
  type DepositTokenOption,
  type DepositTokens,
} from "./loadDepositFacts"
import { sentDepositRecord } from "./sentDepositRecord"
import { AddressLimitsDetail } from "./AddressLimits"
import { ADDRESS_RECHECK_NOTE, swapCapacityNote } from "../limits/limitsCopy"
import { WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"
import { InfoButton } from "../limits/InfoButton"
import { formatPublicLimit, usdFigureGrouped } from "../limits/publicLimit"
import { sourceFromTarget } from "../limits/capacitySources"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import { targetEligibility, useTargetCapacity } from "./targetCapacity"
import { fundingCapacityView } from "./fundingCapacity"
import { useL1Wallet } from "./l1Wallet"
import { useDepositWatch } from "../onboarding/useDepositWatch"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { OneTimeAddressPoints, type OneTimeAddressPoint } from "./OneTimeAddressWarning"
import {
  DepositPrivacyDisclaimer,
  isDepositPrivacyDisclaimerHidden,
} from "./DepositPrivacyDisclaimer"
import {
  CoinIcon,
  DepositAddressSheet,
  LimitsRow,
  type DepositSheetPhase,
  type DepositSpottedProblem,
} from "./DepositAddressSheet"
import { CheckAgainPill } from "./WaitingBlock"
import { getSipaDepositGateway, type DepositStage } from "./sipaGateway"
import type { ShownAddress } from "./depositTarget"
import { AddressesPublishingError, addressesPublishing } from "./addressesPublishing"
import { getBroadcastLedger } from "../broadcasts/broadcasts"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import {
  clearUnresolvedSend,
  holdUnresolvedSend,
  readUnresolvedSend,
  UnresolvedSendHeldError,
  type UnresolvedSendState,
} from "./unresolvedSend"
import { depositValuation } from "./depositValuation"
import { useDepositArrivalMinutes } from "./depositArrival"
import { useSession } from "../../platform/session"

/** Shown, unfunded addresses still publishing above which the screen waits instead of deriving. */
const PUBLISHING_LIMIT = 2

/** How long the sheet says "Address copied!" before it waits for the funds. */
const COPIED_MS = 2_000

/** The smallest deposit the relayer sweeps, as the limits drawer states it. */
const MINIMUM_DEPOSIT = "$1"

/** The coin row's subtitle. */
const COIN_NAMES: Record<string, string> = { USDT: "Tether" }
const coinName = (token: DepositTokenOption) => COIN_NAMES[token.symbol] ?? token.symbol

const DEPOSIT_INFO_POINTS: OneTimeAddressPoint[] = [
  {
    id: "loss",
    icon: "coins",
    title: "Risk of loss",
    body: "Only send available tokens on Ethereum. Anything else is not credited, and getting it back requires manual recovery.",
  },
  {
    id: "rotates",
    icon: "shield-check",
    title: "Each deposit gets a new address",
    body: "Addresses you already shared keep working. Use each one only once for the best privacy.",
  },
]

/** Map raw errors to something a user can act on (esp. the stale-identity resolve revert). */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/UserNotFound|User not found/i.test(msg)) {
    return "This @tag isn't registered on the current network — your saved login is likely from a previous deployment. Clear site data and claim again."
  }
  return msg
}

/** The Fee row while the quote is still being read. */
export const QUOTE_PENDING = "Checking…"

/** What to do when the fee read failed and the funding controls are held. */
export const FEE_UNAVAILABLE_NOTE = "Use Retry to load the fee and continue."

/**
 * Deposit: pick a coin, then a sheet hands out a single-use SIPA address for THIS wallet's
 * `<tag>.<ensDomain>` to copy or scan, or funds it from a connected wallet. Anything sent there is
 * discovered and credited automatically by the SIPA sync loop mounted in WalletGate; the screen
 * watches the address itself so the sheet can say when funds are spotted. With `onClose` it is a
 * modal over Home instead of a page: the coin pick, then the same address sheet. An owed
 * registration's address takes the place of a fresh deposit address.
 */
export function DepositScreen(props: { onClose?: () => void } = {}) {
  const owed = useOwedRegistration() !== null
  // Unknown while the withdrawals load: the screen waits rather than offer a plain deposit.
  const open = useOpenRegistration()
  const known = open === null || open.stage !== undefined
  // A registration settles on the fee token's row.
  const intent = owed ? "registration" : "deposit"
  const { tokens, failed, retry } = useDepositTokensRead(intent)
  if (known && tokens?.offered.length)
    return <DepositScreenBody {...props} tokens={tokens} intent={intent} />
  const title = owed ? "Deposit to activate your account" : "Deposit funds"
  // A table that offers Main no token has nothing to deposit, as when it cannot be read.
  const status = (
    <DepositTokensStatus failed={failed || (!!tokens && !tokens.offered.length)} onRetry={retry} />
  )
  if (props.onClose) {
    return <DepositCoinModal title={title} status={status} onClose={props.onClose} />
  }
  return (
    <div className="ww-panel ww-deposit">
      <div className="ww-deposit__stealth ww-deposit__stealth--top">
        <GradientText size={24} weight={700}>
          {title}
        </GradientText>
        {status}
      </div>
    </div>
  )
}

function DepositScreenBody({
  onClose,
  tokens,
  intent,
}: {
  onClose?: () => void
  tokens: DepositTokens
  intent: SipaIntentName
}) {
  const navigate = useNavigate()
  const handle = loadWalletIdentity()?.handle
  // The gate is effectful, not cosmetic: while the registration is unconfirmed, deriving and
  // publishing a deposit address for a name that may be lost must not happen at all.
  const claiming = useTagPresentationPending()
  const escalated = useRegistrationEscalated()
  const owedRegistration = useOwedRegistration()
  const owed = owedRegistration !== null
  const registration = owedRegistration?.needsCheck === false ? owedRegistration.record : null
  const [choosingName, setChoosingName] = useState(false)
  const tagConfirmed = useRegistrationTagConfirmed(registration)
  const registrationAsk = useRegistrationAsk()
  // The registration's funds landed: Home carries its progress, so this screen does not turn into
  // a plain deposit (and its privacy disclaimer) under the user.
  const wasOwed = useRef(owed)
  useEffect(() => {
    if (owed) wasOwed.current = true
    else if (wasOwed.current) {
      if (onClose) onClose()
      else navigate("/", { replace: true })
    }
  }, [owed, navigate, onClose])
  const obsidionWallet = useResource(useSession().wallet)
  const { contractService } = useContractServiceContext()
  const gateway = getSipaDepositGateway()
  const config = getConfig()
  const { l1Chain, l1ChainId, l1RpcUrl, network, oxideProfile } = config
  const manifestUrl = oxideProfile.manifestUrl
  const chainName = l1ChainId === 1 ? "Ethereum Mainnet" : l1Chain.name

  const [deposit, setDeposit] = useState<ShownAddress>()
  const target = useRegistrationDepositTarget(registration, handle, registrationAsk)
  // Read by callbacks the funding poll holds, so a new ask does not restart the poll.
  const targetRef = useRef(target)
  targetRef.current = target
  const shown = target ? target.address : deposit
  const [generating, setGenerating] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [capped, setCapped] = useState(false)
  const busy = useUserFlowActive()
  const l1 = useL1Wallet({ expectedChainId: l1ChainId, rpcUrl: l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  const canFund = bridgeMode || !!l1.account
  const [sheetOpen, setSheetOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  // Copying hands the address over; the sheet then waits for the funds.
  const [step, setStep] = useState<"address" | "awaiting">("address")
  // The balance seen at the shown address; set once, no new address appears after it.
  const [funded, setFunded] = useState<bigint>()
  const [balance, setBalance] = useState(0n)
  const [lastReadAt, setLastReadAt] = useState<number>()
  const [readError, setReadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fundOpen, setFundOpen] = useState(false)
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  // A funding click made while disconnected, waiting on the wallet the picker is asking for.
  const [fundOnConnect, setFundOnConnect] = useState(false)
  // A desktop send may have been approved without a known hash: that address may still be funded, so
  // new funding waits until funds reach it or the user starts again.
  const unresolvedScope = loadWalletIdentity()?.address ?? "unknown"
  const [hold, setHold] = useState<UnresolvedSendState>(() =>
    readUnresolvedSend(network, unresolvedScope),
  )
  const unresolved = hold.status === "held" ? hold.send : undefined
  const [holdError, setHoldError] = useState(false)
  const [discovered, setDiscovered] = useState<SIPADepositRecord>()
  // After the wallet broadcasts a deposit the detail sheet tracks it: a client-side `funding` view
  // until event discovery creates the store record, then that record as it advances.
  const [sent, setSent] = useState<SentDeposit>()
  const depositStore = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(depositStore)
  const stored = sent
    ? records.find((r) => r.sipaAddress.toLowerCase() === sent.address.toLowerCase())
    : undefined
  // The user's explicit choice; the hold stays until the saved marker is really gone.
  const startNewDeposit = useCallback(() => {
    clearUnresolvedSend(network, unresolvedScope).then(
      () => {
        setHoldError(false)
        setHold({ status: "none" })
      },
      () => setHoldError(true),
    )
  }, [network, unresolvedScope])
  // Funds reached the address the unresolved send was going to: show that deposit. A published
  // address already has an unfunded record from discovery, which proves nothing.
  useEffect(() => {
    if (!unresolved) return
    const record = records.find(
      (r) =>
        r.sipaAddress.toLowerCase() === unresolved.address.toLowerCase() &&
        !isUnfundedSipaDeposit(r),
    )
    if (!record) return
    // The funded record ends the hold; a marker left behind ends the same way on the next mount.
    clearUnresolvedSend(network, unresolvedScope).catch((err: unknown) =>
      console.warn("[deposit] could not remove the unresolved send", err),
    )
    setHold({ status: "none" })
    setDiscovered(record)
  }, [unresolved, records, network, unresolvedScope])
  const coins = tokens.offered
  // The default pick, when Main offers it: a pinned product row is never offered.
  const [token, setToken] = useState<DepositTokenOption>(
    () => coins.find((t) => t.address === tokens.settlement.address) ?? coins[0]!,
  )
  const settlement = settlementOf(tokens, token)
  const [disclaimer, setDisclaimer] = useState(() => !isDepositPrivacyDisclaimerHidden())
  const [facts, setFacts] = useState<DepositDisplayFacts>()
  const [factsFailed, setFactsFailed] = useState(false)
  const [factsAttempt, setFactsAttempt] = useState(0)
  const fee = facts?.fee
  // A target's sweep takes its own fee, so a deposit sent to it is shown at that fee.
  const sentFacts =
    facts && target?.fee !== undefined ? { ...facts, sweepFeeAtomic: target.fee } : facts
  const sentRecord = sent ? sentDepositRecord(sent, stored, l1ChainId, sentFacts) : undefined
  const { copied, copy } = useCopy()
  // Without the fee nothing may be funded: the wallet path would charge amount + 0 while the sweep
  // still takes the real fee. Copy/Deposit stay disabled until it loads.
  const quoteFailed = fee == null && factsFailed
  const quoteLoading = fee == null && !factsFailed
  const reloadFacts = () => setFactsAttempt((n) => n + 1)

  useEffect(() => {
    fireEvent("deposit_sheet_opened", owed ? { registration: true } : undefined)
  }, [])
  const reportedOwed = useRef(false)
  useEffect(() => {
    if (!owed || reportedOwed.current) return
    reportedOwed.current = true
    fireOnboardingEvent("registration_deposit_opened")
  }, [owed])

  // The quote is the picked token's row for the screen's intent, read again on Retry and when the row, the intent or
  // the deployment changes.
  useEffect(() => {
    let stale = false
    setFacts(undefined)
    setFactsFailed(false)
    void loadDepositDisplayFacts(token, intent)
      .then((next) => {
        if (!stale) setFacts(next)
      })
      .catch((e) => {
        if (stale) return
        console.warn("[deposit] fee quote failed:", e)
        fireEvent("action_failed", { action: "deposit:facts", code: failureCode(e) })
        setFactsFailed(true)
      })
    return () => {
      stale = true
    }
  }, [factsAttempt, l1RpcUrl, l1ChainId, manifestUrl, token.settlesIn, intent])

  // Dev demo: the fixture address stands in for a derived one. `import.meta.env.DEV` is a
  // build-time literal, so a production build drops this body and the dynamic import with it.
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || claiming || deposit || !handle) return
    let stale = false
    void import("../../dev/demoDeposit")
      .then(({ demoDepositAddress }) => {
        if (!stale) setDeposit(demoDepositAddress(handle))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [claiming, deposit, handle])

  // One resolve at a time: a second would derive, and owe a proof for, an address nobody sees. The
  // open reads the pool only (limit 0); the coin row may derive, after a pool read still in flight.
  const resolving = useRef<{ limit: number; run: Promise<boolean> } | null>(null)
  const resolveAddress = useCallback(
    (limit: number = PUBLISHING_LIMIT): Promise<boolean> => {
      if (!handle || !obsidionWallet || !contractService || claiming) return Promise.resolve(false)
      if (resolving.current) {
        const current = resolving.current
        if (current.limit >= limit) return current.run
        return current.run.then((ok) => (ok ? true : resolveAddress(limit)))
      }
      // The open's pool read fails quietly and stays out of the derive funnel; the coin row reports.
      const quiet = limit === 0
      setGenerating(true)
      setResolveFailed(false)
      setCapped(false)
      const elapsed = lapTimer()
      const stageLap = lapTimer()
      let sawResolving = false
      if (!quiet) fireEvent("address_resolve_started", { fresh: false })
      const onStage = (next: DepositStage) => {
        if (next === "resolving") sawResolving = true
        fireEvent("deposit_resolve_stage", { stage: next, prev_stage_ms: stageLap() })
      }
      const run = (async () => {
        const next = await gateway.depositAddress(obsidionWallet, contractService, handle, {
          onStage,
          publishingLimit: limit,
        })
        if (!quiet)
          fireEvent("address_resolve_succeeded", {
            duration_ms: elapsed(),
            cached: !sawResolving,
            fresh: false,
          })
        const { publish, owe, source } = next
        setDeposit({ address: next.address, name: next.name, owe, source, publishing: !!publish })
        if (publish) {
          const publishLap = lapTimer()
          // The ledger keeps it owed whatever this reports; the status row shows where it stands.
          void publish().then(
            () => {
              if (!quiet) fireEvent("address_published", { duration_ms: publishLap() })
              setDeposit((d) => (d?.address === next.address ? { ...d, publishing: false } : d))
            },
            (e) => {
              if (e instanceof RegistrationPendingError) {
                fireEvent("address_publish_deferred", { reason: e.state.pending })
              } else {
                fireEvent("address_publish_failed", {
                  duration_ms: publishLap(),
                  code: failureCode(e),
                })
              }
            },
          )
        }
        return true
      })()
        .catch((e) => {
          if (e instanceof AddressesPublishingError) {
            if (!quiet) setCapped(true)
            return false
          }
          if (!quiet) {
            fireEvent("address_resolve_failed", { duration_ms: elapsed(), code: failureCode(e) })
            showReportableError(e, "deposit:resolve", { message: friendlyError(e) })
            setResolveFailed(true)
          }
          return false
        })
        .finally(() => {
          resolving.current = null
          setGenerating(false)
        })
      resolving.current = { limit, run }
      return run
    },
    [gateway, handle, obsidionWallet, contractService, claiming],
  )

  // The address appears on open: one nobody was shown from the pool, else a fresh derivation. While
  // a sent deposit's detail is open, the next address waits for the user to come back to the sheet.
  useEffect(() => {
    if (target || claiming || deposit || capped || resolveFailed || busy || sent) return
    if (hold.status !== "none" || !handle || !obsidionWallet || !contractService) return
    void resolveAddress(0)
  }, [
    target,
    claiming,
    deposit,
    capped,
    resolveFailed,
    busy,
    sent,
    hold.status,
    handle,
    obsidionWallet,
    contractService,
    resolveAddress,
  ])

  // Held by the limit until one of the counted addresses lands or is funded.
  useEffect(() => {
    if (!capped) return
    const ledger = getBroadcastLedger()
    return ledger.onListChanged((jobs) => {
      if (addressesPublishing(jobs, getActiveStorageId()) >= PUBLISHING_LIMIT) return
      setCapped(false)
      // The sheet is waiting on it: derive now.
      if (sheetOpen) void resolveAddress()
    })
  }, [capped, sheetOpen, resolveAddress])

  /** Open the funding sheet. Funding needs the address the user is shown, so derive one first. */
  const beginFunding = useCallback(() => {
    if (fee == null || (claiming && !target)) return
    // The sheet moves the wallet's money, so it opens only for an address whose broadcast landed.
    if (shown) return void setFundOpen(true)
    if (!generating) void resolveAddress().then((ok) => ok && setFundOpen(true))
  }, [fee, shown, generating, resolveAddress, claiming, target])

  // `l1.connect` only opens the wallet picker; the account lands renders later, so the click that
  // asked to fund would otherwise stop at "Wallet connected" and need a second one. A picker that
  // closes without a wallet takes the click with it, so a wallet connecting on its own later does
  // not find it waiting. A successful pick cannot close the picker ahead of its account: wagmi
  // stores the connection before RainbowKit reacts to it.
  useEffect(() => {
    if (!fundOnConnect) return
    if (canFund) {
      setFundOnConnect(false)
      beginFunding()
    } else if (!l1.pickerOpen) {
      setFundOnConnect(false)
    }
  }, [fundOnConnect, canFund, l1.pickerOpen, beginFunding])

  // A target's sweep takes its own fee, not the plain deposit fee. Priced in the settlement token,
  // which a stablecoin matches one to one.
  const depositFee = target
    ? target.fee !== undefined
      ? formatUnits(target.fee, settlement.decimals)
      : undefined
    : fee
  const ready = !!shown && !generating && fee != null
  const qrToken = token.address
  // A swapped token is converted into its row's token before the portal credits it.
  const swap = token.swapped
  const route: AddressRoute = {
    kind: "deposit",
    decimals: token.decimals,
    swap,
    feeAtomic: target ? target.fee : facts?.sweepFeeAtomic,
    txAmountCap: facts?.txAmountCap,
  }
  const valuation = depositValuation(token, tokens)
  const maxSend = maximumSendAtomic(route, valuation)
  // The address on this screen is derived from the active deployment, so its bucket is the active one.
  const capacity = useTargetCapacity({ kind: "active", token: token.settlesIn })
  const arrivalMinutes = useDepositArrivalMinutes(obsidionWallet?.node)
  const capacityEligibility = targetEligibility(capacity, { status: "unknown" })
  const capacityView = fundingCapacityView({
    eligibility: capacityEligibility,
    mode: "address",
    symbol: settlement.symbol,
    sentSymbol: token.symbol,
    exactCredit: !swap,
  })
  const capacityKnown = capacityEligibility.kind === "amount-unknown"
  // No figure fits a swap: the settlement credited is set by the swap.
  const fitsNow =
    !swap && capacityKnown && !capacityEligibility.zero
      ? maximumSendForCapacity(route, capacityEligibility.snapshot.availableAtomic, valuation)
      : undefined
  const limitNow =
    capacityKnown && capacityEligibility.zero
      ? "$0"
      : fitsNow !== undefined && maxSend !== undefined && fitsNow < maxSend
      ? usdFigureGrouped(formatUnits(fitsNow, token.decimals))
      : formatPublicLimit()
  const capacityNote =
    capacityView.tone === "ok" || capacityView.tone === "checking"
      ? undefined
      : [capacityView.statusText, capacityView.detailText].filter(Boolean).join(" ")
  // A swapped coin's credit is set by the swap rate, so no figure is promised for it.
  // The sweep floors each coin on its own, so only what the address holds in the picked coin counts.
  const held = token.symbol === settlement.symbol ? target?.held ?? 0n : 0n
  // The least to send, before the address: a target's ask, less what its address holds.
  const askLeft =
    target?.ask === undefined
      ? undefined
      : held > 0n && held < target.ask
      ? target.ask - held
      : target.ask
  const depositMinimum = !target
    ? MINIMUM_DEPOSIT
    : askLeft === undefined
    ? QUOTE_PENDING
    : formatDepositDue(askLeft, settlement.decimals).replace(/\.00$/, "")
  const limitsDrawer = (
    <>
      <LimitsRow
        label="Minimum deposit"
        value={depositMinimum}
        info={
          <InfoButton label="About the deposit limit" onClick={() => setAboutLimits("limit")} />
        }
      />
      <LimitsRow
        label="Limit right now"
        value={
          capacityKnown
            ? `${limitNow} incl. fees`
            : capacityEligibility.kind === "checking"
            ? QUOTE_PENDING
            : "Could not check"
        }
        testId="deposit-limit-now"
        info={
          <InfoButton
            label="About network capacity"
            testId="about-capacity-link"
            onClick={() => setAboutLimits("capacity")}
          />
        }
        action={
          <CheckAgainPill
            checking={capacityEligibility.kind === "checking"}
            onClick={capacity.retry}
            testId="funding-capacity-retry"
          />
        }
      />
      <LimitsRow
        label="Fee"
        value={
          depositFee != null
            ? tokenFigure(depositFee, settlement.symbol)
            : quoteFailed
            ? "Unavailable"
            : QUOTE_PENDING
        }
        testId="deposit-fee"
        info={<InfoButton label="About the deposit fee" onClick={() => setAboutLimits("limit")} />}
        action={
          quoteFailed && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              data-testid="deposit-facts-retry"
              onClick={reloadFacts}
            >
              Retry
            </button>
          )
        }
      />
      <LimitsRow
        label="Deposit arrival time"
        value={arrivalMinutes === undefined ? "A few minutes" : `~${arrivalMinutes} minutes`}
      />
      {quoteFailed && (
        <p className="ww-deposit-sheet__fine" data-testid="deposit-fee-unavailable">
          {FEE_UNAVAILABLE_NOTE}
        </p>
      )}
      <p
        className="ww-deposit-sheet__fine"
        data-testid={swap ? "deposit-swap-note" : "deposit-credit-note"}
      >
        {depositCreditNote(token, settlement)}
      </p>
    </>
  )
  const limitsDetails = {
    limit: (
      <AddressLimitsDetail
        symbol={token.symbol}
        decimals={token.decimals}
        checking={quoteLoading}
        maxSendAtomic={maxSend}
        maxCreditAtomic={maximumCreditAtomic(route, valuation)}
        swapInto={swap ? settlement.symbol : undefined}
      />
    ),
    capacity: (
      <>
        {swap && (
          <p className="ww-about-limits__note" data-testid="address-capacity-swap">
            {swapCapacityNote(settlement.symbol, token.symbol)}
          </p>
        )}
        <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>
      </>
    ),
  }

  // Terminal: overlapping slow reads can both settle funded in the same tick.
  const fundedSeen = useRef(false)
  const markFunded = useCallback(
    (next: bigint) => {
      if (fundedSeen.current) return
      fundedSeen.current = true
      const funded = targetRef.current
      fireEvent("deposit_funded", {
        funding: "external",
        amount_bucket: amountBucket(next, token.decimals),
        ...(funded?.kind === "registration" && { registration: true }),
      })
      setFunded(next)
      // The scanner moves the record on; back on its per-tick lane, the row shows within a tick.
      if (funded) funded.onFunded(next, token.decimals)
    },
    [token.decimals],
  )
  // The ask is priced in the settlement token; any stablecoin funds it one to one, in its own units.
  const settledToToken = (settled: bigint) =>
    (settled * 10n ** BigInt(token.decimals)) / 10n ** BigInt(settlement.decimals)
  // A target's address short of its floor is not funded: the sweep refuses it, so it waits. Rounded
  // up, so a coin with fewer decimals still covers all of it.
  const floorRef = useRef<bigint | undefined>(undefined)
  const unit = 10n ** BigInt(settlement.decimals)
  floorRef.current =
    target?.floor === undefined
      ? undefined
      : (target.floor * 10n ** BigInt(token.decimals) + unit - 1n) / unit
  const recordRead = useCallback(
    (next: bigint, at: number) => {
      setReadError(false)
      setBalance(next)
      setLastReadAt(at)
      if (next === 0n) return
      const floor = floorRef.current
      if (targetRef.current && (floor === undefined || next < floor)) return
      markFunded(next)
    },
    [markFunded],
  )

  // A third-party send leaves no local trace: the rail's record of the address is what moves the
  // sheet to spotted, and the sweep credits it. The demo's fake L1 reports a balance for every
  // address, which would read as an instant external send; the connected-wallet path is tracked by
  // its own detail sheet.
  const watched = useDepositWatch(
    shown &&
      qrToken &&
      !fundOpen &&
      !sent &&
      funded == null &&
      !(import.meta.env.DEV && isDemoMode())
      ? shown.address
      : null,
  )
  const watchedBalance = settledToToken(watched.balance)
  useEffect(() => {
    if (watched.readAt !== undefined) recordRead(watchedBalance, watched.readAt)
  }, [watched.readAt, watchedBalance, recordRead])

  /** An observe pass, on demand. */
  const refresh = () => {
    if (!shown || !qrToken || refreshing) return
    setRefreshing(true)
    watched
      .read()
      .catch((e) => {
        setReadError(true)
        console.warn("[deposit] balance read failed:", e)
      })
      .finally(() => setRefreshing(false))
  }

  // Once per address per mount, when the sheet shows it.
  const reportedShown = useRef(new Set<string>())
  useEffect(() => {
    if (!sheetOpen || !shown || reportedShown.current.has(shown.address)) return
    reportedShown.current.add(shown.address)
    if (targetRef.current) targetRef.current.onShown(shown.address)
    else fireEvent("deposit_address_shown", { address_source: shown.source })
  }, [sheetOpen, shown])

  // A sheet with nothing to show and nothing coming closes: the derivation failed or never started.
  useEffect(() => {
    if (sheetOpen && !shown && !generating && !capped) setSheetOpen(false)
  }, [sheetOpen, shown, generating])

  const waitTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(waitTimer.current), [])
  // Copying is the hand-off: after the copied feedback the sheet waits for the funds. A refused
  // clipboard copies nothing, so the sheet stays put.
  const copyAddress = () => {
    if (!shown) return
    void copy(shown.address).then((ok) => {
      if (!ok || step !== "address") return
      clearTimeout(waitTimer.current)
      waitTimer.current = setTimeout(() => setStep("awaiting"), COPIED_MS)
    })
  }
  /** Back to the address: a copy's pending hand-off goes with it. */
  const showAddress = () => {
    clearTimeout(waitTimer.current)
    setStep("address")
  }
  /** A coin row: the sheet for that coin, deriving an address when none is held yet. */
  const openSheet = (next: DepositTokenOption) => {
    setSheetOpen(true)
    // Spotted funds belong to the coin they were read in.
    if (funded != null) return
    // The same coin reopens where it was, waiting included; another coin starts at its address.
    if (next.symbol !== token.symbol) {
      showAddress()
      setBalance(0n)
      setLastReadAt(undefined)
    }
    setToken(next)
    if (shown) return
    void resolveAddress()
  }
  /** The held address was spent or may be: the next sheet derives a fresh one. */
  const dropAddress = () => {
    setDeposit(undefined)
    setSheetOpen(false)
    showAddress()
    setBalance(0n)
    setLastReadAt(undefined)
  }
  const phase: DepositSheetPhase =
    funded != null ? "spotted" : !shown ? "creating" : step === "awaiting" ? "waiting" : "ready"
  const paymentUri =
    ready && qrToken
      ? buildErc20TransferUriWithoutAmount({
          token: qrToken,
          chainId: l1ChainId,
          to: shown.address,
        })
      : undefined
  // The sweep cannot credit an amount over the per-transaction limit; over current capacity, or with
  // none, it waits. Unknown capacity promises nothing either way.
  const spottedProblem: DepositSpottedProblem | undefined =
    funded == null
      ? undefined
      : maxSend !== undefined && funded > maxSend
      ? "limit"
      : (capacityKnown && capacityEligibility.zero) || (fitsNow !== undefined && funded > fitsNow)
      ? "capacity"
      : undefined
  // The least the funding sheet may credit, in the picked coin: the floor less what the sweep
  // takes (the sheet adds that fee to what it sends) and less what the address already holds.
  const targetMinimum =
    target?.floor !== undefined && target.fee !== undefined
      ? formatUnits(
          settledToToken(
            target.floor - target.fee - held > 0n ? target.floor - target.fee - held : 0n,
          ),
          token.decimals,
        )
      : undefined
  const arriving =
    !swap && funded != null && depositFee != null
      ? tokenFigure(
          String(Math.max(0, Number(formatUnits(funded, token.decimals)) - Number(depositFee))),
          token.symbol,
        )
      : undefined
  const tagLabel = handle ? `@${handle}` : "your @tag"
  const walletLabel = l1.account
    ? `Deposit from ${l1.walletName ?? "wallet"} · ${shortL1Addr(l1.account)}`
    : bridgeMode
    ? "Or deposit from your browser"
    : "Or connect a wallet to fund"
  const connectLink = (
    <p className="ww-deposit__note">
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        data-testid="deposit-connect-link"
        // An unconfirmed tag has no broadcast queued to sweep what arrives, so nothing may be sent yet.
        disabled={fee == null || (claiming && !target) || (owed && !tagConfirmed)}
        onClick={() => {
          if (!canFund) {
            setFundOnConnect(true)
            return void l1.connect()
          }
          beginFunding()
        }}
      >
        {walletLabel}
      </button>
      {l1.account && (
        <>
          {" "}
          <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={l1.disconnect}>
            Disconnect
          </button>
        </>
      )}
    </p>
  )

  // Web has no background re-sign; the claim page owns the status check.
  const claimingBlock = claiming && !target && (
    <>
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate ww-deposit__claiming"
        data-testid="deposit-claiming"
        onClick={() => navigate(handle ? `/claim/${handle}` : "/claim")}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {owed ? "Registration needs a check" : `Claiming ${tagLabel}`}
          </span>
          <span className="ww-banner__body">
            {owed
              ? `Check on ${tagLabel} before you deposit.`
              : `Your tag is still being claimed. ${
                  escalated
                    ? "This is taking longer than usual. Check on it."
                    : "This usually takes about a minute."
                }`}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {owed || escalated ? (
            <Icon name="chevron-right" size={12} color="#fff" />
          ) : (
            <Spinner size={12} color="#fff" />
          )}
        </span>
      </button>
      <p className="ww-deposit__note">
        Deposit addresses will be available here once {tagLabel} is successfully registered.
      </p>
    </>
  )
  const holdBlock = hold.status !== "none" && (
    <div className="ww-deposit__unresolved" role="status" data-testid="deposit-send-unresolved">
      {unresolved ? (
        <>
          <b>Waiting for your browser wallet</b>
          <p>
            A transfer to {shortL1Addr(unresolved.address)} may still be sent from your browser
            wallet. If it is, the deposit appears in your activity.
          </p>
        </>
      ) : (
        <>
          <b>Deposit state unavailable</b>
          <p>This browser's saved deposit state can't be read.</p>
        </>
      )}
      <p>New deposits are paused here so the same funds are not sent twice.</p>
      {holdError && (
        <p data-testid="deposit-send-unresolved-error">
          This browser couldn't update its saved state. Try again.
        </p>
      )}
      <div className="ww-deposit__unresolved-actions">
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          onClick={() =>
            unresolved
              ? navigate("/activity")
              : setHold(readUnresolvedSend(network, unresolvedScope))
          }
        >
          {unresolved ? "View activity" : "Check again"}
        </button>
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          data-testid="deposit-send-unresolved-restart"
          onClick={startNewDeposit}
        >
          Start a new deposit
        </button>
      </div>
    </div>
  )
  const shownCoin = (!owed || tagConfirmed) && !claimingBlock && !holdBlock

  const sheets = (
    <>
      {sheetOpen && (
        <DepositAddressSheet
          token={token}
          chainName={chainName}
          phase={phase}
          address={shown?.address}
          paymentUri={paymentUri}
          publishing={!!shown?.publishing}
          creatingNote={capped ? new AddressesPublishingError().message : undefined}
          canCopy={ready}
          copied={copied}
          onCopy={copyAddress}
          balance={balance}
          lastReadAt={lastReadAt}
          checking={refreshing}
          onCheck={refresh}
          funded={funded}
          arriving={arriving}
          swapInto={swap ? settlement.symbol : undefined}
          limitNow={limitNow}
          limits={limitsDrawer}
          capacityNote={capacityNote}
          arrivalMinutes={arrivalMinutes}
          onPayWithWallet={() => {
            setSheetOpen(false)
            if (!canFund) {
              setFundOnConnect(true)
              return void l1.connect()
            }
            beginFunding()
          }}
          walletLabel={walletLabel}
          readError={readError}
          problem={spottedProblem}
          limitLabel={formatPublicLimit()}
          onOpenActivity={() => navigate("/activity")}
          ask={owed && <RegistrationAskLine />}
          onClose={() => {
            setSheetOpen(false)
            // Funds spotted: the deposit carries on in Activity, so the screen is done.
            if (phase === "spotted") return onClose ? onClose() : navigate("/")
            // A copy's pending hand-off is dropped; a sheet already waiting keeps waiting.
            clearTimeout(waitTimer.current)
            // Over Home there is no page behind the sheet.
            onClose?.()
          }}
        />
      )}

      {fundOpen && shown && canFund && (
        <DepositFromWalletModal
          l1={l1}
          deposit={shown}
          token={token}
          fee={depositFee}
          target={target?.kind}
          minimum={targetMinimum}
          valuation={valuation}
          onClose={() => setFundOpen(false)}
          onSent={(next) => {
            setFundOpen(false)
            setSent(next)
            // The address was spent; the next visit derives a fresh one.
            dropAddress()
            // A known hash replaces the hold; if the marker cannot be removed, the funded record ends it.
            clearUnresolvedSend(network, unresolvedScope, { address: next.address }).catch(
              (err: unknown) => console.warn("[deposit] could not remove the unresolved send", err),
            )
          }}
          onSendFailed={() => setSent(undefined)}
          onFeeChanged={reloadFacts}
          onApproving={async (submission) => {
            try {
              await holdUnresolvedSend(network, unresolvedScope, {
                address: shown.address,
                at: Date.now(),
                submission,
              })
            } catch (err) {
              // A saved hold this screen is not showing: it waits on it too.
              if (err instanceof UnresolvedSendHeldError) {
                setHold(readUnresolvedSend(network, unresolvedScope))
              }
              throw err
            }
          }}
          onNotApproved={(submission) =>
            // Its hold can land after the refusal; nothing was sent, so it goes.
            clearUnresolvedSend(network, unresolvedScope, { submission }).catch((err: unknown) =>
              console.warn("[deposit] could not remove the unresolved send", err),
            )
          }
          onSendUnresolved={() => {
            // The marker was saved before the approval; this page holds even if it is gone now.
            const saved = readUnresolvedSend(network, unresolvedScope)
            setHold(
              saved.status === "held"
                ? saved
                : { status: "held", send: { address: shown.address, at: Date.now() } },
            )
            setFundOpen(false)
            // That address may already hold the transfer; it is never offered again.
            dropAddress()
          }}
        />
      )}
      {discovered && (
        <DepositDetailModal record={discovered} onClose={() => setDiscovered(undefined)} />
      )}

      {sentRecord && <DepositDetailModal record={sentRecord} onClose={() => setSent(undefined)} />}

      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={limitsDetails}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={settlement.symbol}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )

  if (onClose)
    return (
      <>
        {registration && <OweRegistrationBroadcast record={registration} />}
        {!sheetOpen && !fundOpen && !sentRecord && !discovered && (
          <DepositCoinModal
            title={owed ? "Deposit to activate your account" : "Deposit funds"}
            coins={coins}
            coinName={coinName}
            token={token}
            onPick={setToken}
            rows={
              <>
                <LimitsRow
                  label="Fee"
                  value={
                    depositFee != null
                      ? tokenFigure(depositFee, settlement.symbol)
                      : quoteFailed
                      ? "Unavailable"
                      : QUOTE_PENDING
                  }
                  testId="deposit-fee"
                  info={
                    <InfoButton
                      label="About the deposit fee"
                      onClick={() => setAboutLimits("limit")}
                    />
                  }
                />
                <LimitsRow
                  label="Minimum deposit"
                  value={depositMinimum}
                  testId="deposit-minimum"
                  info={
                    <InfoButton
                      label="About the deposit limit"
                      onClick={() => setAboutLimits("limit")}
                    />
                  }
                />
              </>
            }
            status={claimingBlock || holdBlock || undefined}
            canContinue={shownCoin && !(busy && !shown)}
            onContinue={() => openSheet(token)}
            onClose={onClose}
          />
        )}
        {sheets}
      </>
    )

  return (
    <div className="ww-panel ww-deposit">
      {registration && <OweRegistrationBroadcast record={registration} />}
      <div className="ww-deposit__stealth ww-deposit__stealth--top">
        <GradientText size={24} weight={700}>
          Deposit funds
        </GradientText>

        {claimingBlock || holdBlock || (
          <>
            <div className="ww-deposit__fields">
              {owed && (
                <div className="ww-deposit__tag" data-testid="deposit-tag-row">
                  <span>Your name</span>
                  <b>@{handle}</b>
                  {tagConfirmed ? (
                    <Icon name="lock" size={14} color="var(--text-secondary)" />
                  ) : (
                    <button
                      type="button"
                      className="zkm-btn-reset ww-deposit__link"
                      onClick={() => setChoosingName(true)}
                    >
                      Choose your own
                    </button>
                  )}
                </div>
              )}
              {owed && !tagConfirmed && registration && (
                <div className="ww-deposit__confirm" data-testid="deposit-confirm-tag">
                  <p>
                    Keep @{handle} or choose your own. Once you confirm, your name can&apos;t change
                    while it registers.
                  </p>
                  <PrimaryGradientButton
                    title={`Keep @${handle}`}
                    onClick={() => confirmRegistrationTag(registration)}
                  />
                </div>
              )}
              {owed && <RegistrationAskLine />}
              {(!owed || tagConfirmed) && (
                <>
                  <p className="ww-deposit__label">Which token are you sending?</p>
                  <div className="ww-deposit__coins">
                    {coins.map((t) => (
                      <button
                        key={t.symbol}
                        type="button"
                        className="zkm-btn-reset ww-deposit__coin"
                        data-testid={`deposit-coin-${t.symbol}`}
                        disabled={busy && !shown}
                        onClick={() => openSheet(t)}
                      >
                        <CoinIcon token={t} />
                        <span className="ww-deposit__coin-name">
                          {t.symbol}
                          <small>{coinName(t)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="ww-deposit__network">
                    <span>
                      Network
                      <Icon name="lock" size={14} />
                    </span>
                    <b>{chainName}</b>
                  </div>
                </>
              )}
            </div>
            <section className="ww-deposit__info">
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__info-head"
                aria-expanded={infoOpen}
                onClick={() => setInfoOpen((o) => !o)}
              >
                Important information
                <Icon name={infoOpen ? "chevron-up" : "chevron-down"} size={16} />
              </button>
              {infoOpen && <OneTimeAddressPoints points={DEPOSIT_INFO_POINTS} />}
            </section>
            {connectLink}
          </>
        )}
      </div>

      {sheets}
      {choosingName && handle && (
        <ChooseNameSheet tag={handle} onClose={() => setChoosingName(false)} />
      )}

      {/* The fresh-address model applies to deposits, not the registration address. */}
      {disclaimer && !owed && (
        <DepositPrivacyDisclaimer handle={handle} onClose={() => setDisclaimer(false)} />
      )}
    </div>
  )
}

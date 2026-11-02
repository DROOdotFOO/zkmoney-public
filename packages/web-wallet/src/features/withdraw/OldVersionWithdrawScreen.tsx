/**
 * Withdraw while old versions hold the account's funds: one run refunds all of them. Withdraw to
 * Ethereum sends them privately to any address. Withdraw with my own wallet sends each refund from
 * the user's Ethereum wallet, which pays the gas. Funds on this version stay.
 */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { formatUnits, isAddress, type Address, type Hex } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { savingsValue, useSavingsPosition } from "@obsidion/front-core"
import { estimateFrozenSelfRefundCost, planFrozenSelfRefunds } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"
import { showReportableError } from "../../errors/errorModal"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { usdAtomicFloor } from "../../ui/format"
import { useScreenedAddress } from "../../ui/screening"
import { isWalletRejection, useL1Wallet } from "../deposit/l1Wallet"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import {
  noteOldVersionWithdrawn,
  openOldVersionExit,
  skipUnrefundableSource,
  useWithdrawableSources,
  type WithdrawableSource,
} from "../migration/oldVersionWithdraw"
import { openMigrationDialog } from "../migration/migrationDialog"
import { isFlowCancelled, runOperation } from "../operations/operations"
import {
  frozenExitSummary,
  runFrozenExit,
  type FrozenExitDone,
  type FrozenExitRead,
  type FrozenExitSent,
  type FrozenFunds,
  type FrozenSourceFunds,
} from "./frozenExitRun"
import { reviewCopy, withdrawDoneCopy, withdrawingCopy } from "../cutover/cutoverCopy"
import { useNetworkReady } from "../cutover/networkReady"
import { notifyIfArmed } from "../cutover/notify"
import { TextButton } from "../cutover/parts"
import { WINDOW_ENDS } from "../../upgradeFreeze"
import { DestinationSheet, ReviewSheet } from "../cutover/withdrawSheets"
import { WalletProgress, WithdrawChoice, WithdrawDone, ZkProgress } from "./withdrawScreens"
import { zkMoneyExit, type ZkMoneyExitStage, type ZkMoneyQuote } from "./zkMoneyExit"

const NONE: FrozenSourceFunds = { refundable: 0n, links: 0n, waiting: 0n }
const add = (a: FrozenSourceFunds, b: FrozenSourceFunds) => ({
  refundable: a.refundable + b.refundable,
  links: a.links + b.links,
  waiting: a.waiting + b.waiting,
})

type SourceRead = { ws: WithdrawableSource; read: FrozenExitRead; symbol: string }

/** Each source's candidates, read once to its tip: every figure on the screen comes from them. */
async function scanSources(sources: readonly WithdrawableSource[]) {
  const read = async (ws: WithdrawableSource): Promise<SourceRead> => {
    const exit = await openOldVersionExit(ws)
    return { ws, read: await exit.runtime.candidates({ fresh: true }), symbol: exit.symbol }
  }
  const [main, savings] = await Promise.all([
    Promise.all(sources.filter((s) => !s.savings).map(read)),
    Promise.allSettled(sources.filter((s) => s.savings).map(read)),
  ])
  const savingsRead = savings.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
  const sum = (reads: SourceRead[]) => reads.map((r) => frozenExitSummary(r.read)).reduce(add, NONE)
  const total = sum(main)
  // This version keeps no record of the old version's links, so the refund's count stands.
  const funds: FrozenFunds = { main: total, openLinks: total.links }
  if (savingsRead.length) funds.savings = sum(savingsRead)
  if (savingsRead.length < savings.length) funds.savingsFailed = true
  return {
    funds,
    savingsSymbol: savingsRead[0]?.symbol ?? "sUSDS",
    reads: [...main, ...savingsRead],
  }
}

/** The own-wallet route's gas, in USD: every refund it sends, at the withdrawal subsidy's model. */
async function refundGasUsd(reads: readonly SourceRead[]) {
  const config = getConfig()
  const subsidy = (await getOxideTuple(config)).withdrawalSubsidy
  if (!subsidy) return undefined
  const kinds = reads.flatMap(({ read }) => planFrozenSelfRefunds(read).map((batch) => batch.kind))
  if (!kinds.length) return undefined
  return (await estimateFrozenSelfRefundCost(l1PublicClient(config), subsidy as Address, kinds)).usd
}

export function OldVersionWithdrawScreen() {
  const config = getConfig()
  const navigate = useNavigate()
  const sources = useWithdrawableSources()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const bridgeMode = isDesktopL1SubmitActive()
  const sharePrice = useSavingsPosition().position?.sharePrice
  // The sources the screen opened with: a scan after the withdrawal must not reset them.
  const opened = useRef(sources)
  const [destination, setDestination] = useState("")
  const [scanned, setScanned] = useState<{ funds: FrozenFunds; savingsSymbol: string }>()
  const [scan, setScan] = useState(0)
  const [failed, setFailed] = useState(false)
  const [gasUsd, setGasUsd] = useState<bigint>()
  const [stage, setStage] = useState<L1ExitStage | "proving">()
  const [sent, setSent] = useState<FrozenExitSent>()
  const [done, setDone] = useState<FrozenExitDone>()
  const [view, setView] = useState<"choose" | "destination" | "zk-review" | "review">("choose")
  const [zk] = useState(zkMoneyExit)
  const [route, setRoute] = useState<"zk-money" | "wallet">("zk-money")
  const [typed, setTyped] = useState("")
  const [checked, setChecked] = useState(false)
  const [quote, setQuote] = useState<ZkMoneyQuote>()
  const [feeFailed, setFeeFailed] = useState(false)
  const [zkStage, setZkStage] = useState<ZkMoneyExitStage>()
  const [zkDone, setZkDone] = useState<{ sent: bigint; left: bigint; hash?: Hex; to: Address }>()
  const zkRoute = route === "zk-money"
  const shareUsd = (shares: bigint) =>
    sharePrice === undefined ? shares : savingsValue(shares, sharePrice)
  const fee = quote && quote.tips.main + shareUsd(quote.tips.savings)
  const moving = quote && quote.moving.main + shareUsd(quote.moving.savings)
  // Each refund's dollar figure is saved, so Savings waits for a real share price.
  const priced = !quote?.moving.savings || sharePrice !== undefined
  const sourceUsd = (source: WithdrawableSource, amount: bigint) =>
    source.savings ? shareUsd(amount) : amount
  const home = () => navigate("/")
  const networkReady = useNetworkReady()
  const funds = scanned?.funds

  useEffect(() => {
    let live = true
    setScanned(undefined)
    setFailed(false)
    // A quote from before the last run must not price the next one.
    setQuote(undefined)
    setFeeFailed(false)
    setGasUsd(undefined)
    scanSources(opened.current)
      .then(({ reads, ...next }) => {
        if (!live) return
        setScanned(next)
        // Both routes refund every source, so an unread one leaves neither priced.
        if (next.funds.savingsFailed) return setFeeFailed(true)
        zk.fee(reads)
          .then((q) => live && setQuote(q))
          .catch((e) => {
            if (!live) return
            setFeeFailed(true)
            showReportableError(e, "withdraw:zk-money-fee")
          })
        // The estimate is optional: without it the screens name the gas without a figure.
        refundGasUsd(reads)
          .then((usd) => live && setGasUsd(usd))
          .catch((e) => console.warn("withdraw: gas estimate failed", e))
      })
      .catch((e) => {
        if (!live) return
        setFailed(true)
        setFeeFailed(true)
        showReportableError(e, "withdraw:old-version-scan")
      })
    return () => {
      live = false
    }
  }, [zk, scan])
  // Withdraw stops offering what no batch refunds, such as a note above the portal's cap.
  useEffect(() => {
    if (!funds || done) return
    if (!funds.main.refundable)
      opened.current.filter((s) => !s.savings).forEach((s) => skipUnrefundableSource(s.source))
    if (funds.savings && !funds.savings.refundable)
      opened.current.filter((s) => s.savings).forEach((s) => skipUnrefundableSource(s.source))
  }, [funds, done])
  // Read again once the user leaves: before that, the gate would replace this screen.
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  useEffect(() => {
    if (done || zkDone) return noteOldVersionWithdrawn
  }, [done, zkDone])
  // The desktop helper page picks its account after the refund is proven, so the user names it and
  // the helper refuses any other payer.
  const typedAddress = (zkRoute ? typed : destination).trim()
  const to =
    zkRoute || bridgeMode
      ? isAddress(typedAddress)
        ? (typedAddress as Address)
        : null
      : l1.wrongChain
      ? null
      : l1.account
  const screening = useScreenedAddress(to, "withdraw")
  const refundable = !!funds && funds.main.refundable + (funds.savings?.refundable ?? 0n) > 0n
  // A run must refund every source, so an unread Savings asks for another scan first.
  const unread = failed || !!funds?.savingsFailed
  const ready = !!to && screening.cleared && refundable && !unread
  const total = funds ? funds.main.refundable + shareUsd(funds.savings?.refundable ?? 0n) : 0n
  const walletName = bridgeMode ? null : l1.walletName

  const submitZk = async () => {
    if (!to) return
    setZkStage("preparing")
    try {
      const result = await runOperation(
        { operationId: crypto.randomUUID(), flow: "withdraw", summary: "Withdraw old version" },
        () => zk.run(opened.current, to, setZkStage, sourceUsd),
      )
      notifyIfArmed(withdrawDoneCopy.title, withdrawDoneCopy.notice)
      if (mounted.current) setZkDone({ ...result, to })
      else noteOldVersionWithdrawn()
    } catch (e) {
      noteOldVersionWithdrawn()
      if (!isFlowCancelled(e))
        showReportableError(e, "withdraw:zk-money", { title: "Withdrawal stopped" })
      setScan((n) => n + 1)
    } finally {
      setZkStage(undefined)
    }
  }

  const submit = async () => {
    if (!to || !funds) return
    setStage("proving")
    setSent(undefined)
    const progress: FrozenExitSent = { refunded: 0n, hashes: [] }
    let left = 0n
    let moved = false
    try {
      await runOperation(
        { operationId: crypto.randomUUID(), flow: "withdraw", summary: "Withdraw old version" },
        async () => {
          const channel = bridgeMode
            ? desktopBridgeChannel({
                destination: to,
                from: to,
                chainId: config.l1ChainId,
                publicClient: l1PublicClient(config),
                display: { title: "Withdraw from zk.money", lines: [["To", to]] },
                onStage: setStage,
              })
            : await injectedWalletChannel(config, { from: to, onStage: setStage })
          // Main first, then Savings, which pays out its own token.
          const order = [
            ...opened.current.filter((s) => !s.savings),
            ...opened.current.filter((s) => s.savings && funds.savings?.refundable),
          ]
          for (const source of order) {
            const usd = (amount: bigint) => (source.savings ? shareUsd(amount) : amount)
            const exit = await openOldVersionExit(source, to)
            let before = 0n
            const result = await exit.lock(() =>
              runFrozenExit(exit.runtime, channel, (batch) => {
                moved = true
                progress.refunded += usd(batch.refunded - before)
                progress.hashes.push(batch.hashes[batch.hashes.length - 1]!)
                before = batch.refunded
                setSent({ ...progress, hashes: [...progress.hashes] })
                setStage("proving")
              }),
            )
            left += usd(result.stranded + result.waiting)
          }
        },
      )
      notifyIfArmed(withdrawDoneCopy.title, withdrawDoneCopy.notice)
      if (mounted.current) setDone({ ...progress, left, to })
      else noteOldVersionWithdrawn()
    } catch (e) {
      if (moved) noteOldVersionWithdrawn()
      if (!isFlowCancelled(e) && !isWalletRejection(e))
        showReportableError(e, "withdraw:old-version", { title: "Withdrawal stopped" })
      setScan((n) => n + 1)
    } finally {
      setStage(undefined)
    }
  }

  if (zkDone)
    return (
      <WithdrawDone
        amount={zkDone.sent}
        left={zkDone.left}
        wallet={null}
        to={zkDone.to}
        hashes={zkDone.hash ? [zkDone.hash] : []}
        onClose={home}
      />
    )
  if (zkStage && to) return <ZkProgress stage={zkStage} to={to} total={moving ?? total} />
  if (done)
    return (
      <WithdrawDone
        amount={done.refunded}
        left={done.left}
        wallet={walletName}
        to={done.to}
        hashes={done.hashes}
        onClose={home}
      />
    )
  if (stage)
    return (
      <WalletProgress
        stage={stage === "proving" ? undefined : stage}
        approveIn={bridgeMode ? withdrawingCopy.browser : walletName ?? "your wallet"}
        total={total}
        sent={sent?.refunded}
      />
    )

  const usd = (amount?: bigint) => (amount === undefined ? "…" : usdAtomicFloor(amount))
  const status = funds ? undefined : failed ? "Couldn't find your funds" : "Finding your funds…"
  const upgrade = () => {
    navigate("/")
    openMigrationDialog()
  }
  const destinationSheet = (
    <DestinationSheet
      address={zkRoute ? typed : destination}
      onAddress={(value) => {
        if (zkRoute) setTyped(value)
        else setDestination(value)
        setChecked(false)
      }}
      checked={checked}
      onChecked={setChecked}
      screening={screening}
      onContinue={() => setView(zkRoute ? "zk-review" : "review")}
      onClose={() => setView("choose")}
    />
  )
  const zkAmount = moving ?? total
  const zkFee =
    !refundable || moving === undefined || !priced
      ? undefined
      : moving === 0n
      ? // No refund covers its tip, so the route moves nothing: its fee takes the whole balance.
        total > WITHDRAW_RELAYER_TIP
        ? total
        : WITHDRAW_RELAYER_TIP
      : fee
  const zkReview = to && (
    <ReviewSheet
      route="zk-money"
      lead={<code style={{ overflowWrap: "anywhere" }}>{to}</code>}
      figures={{
        total: status ?? usd(zkAmount),
        spendable: usd(quote?.moving.main),
        savings: usd(quote && shareUsd(quote.moving.savings)),
        fee: zkFee === undefined ? "…" : `-${usdAtomicFloor(zkFee)}`,
        receive:
          zkFee === undefined ? "…" : usdAtomicFloor(zkAmount > zkFee ? zkAmount - zkFee : 0n),
      }}
      failed={unread || feeFailed}
      disabled={zkFee === undefined || moving === 0n}
      onConfirm={() => void submitZk()}
      onRetry={() => setScan((n) => n + 1)}
      onUpgrade={upgrade}
      onClose={() => setView("destination")}
    />
  )
  const savingsFunds = funds?.savings
  // Open links this browser recorded that the refund found no escrow notes for.
  const missing =
    funds && funds.openLinks > funds.main.links ? funds.openLinks - funds.main.links : 0n
  const waiting = funds ? funds.main.waiting + shareUsd(savingsFunds?.waiting ?? 0n) : 0n
  // Savings pays out its own token, so both tokens are named only when both pay out.
  const receive = !savingsFunds?.refundable
    ? usd(funds?.main.refundable)
    : [
        ...(funds?.main.refundable ? [`${usdAtomicFloor(funds.main.refundable)} in DAI`] : []),
        `${shares(savingsFunds.refundable)} ${scanned?.savingsSymbol ?? "sUSDS"}`,
      ].join(" + ")
  const notes = [
    ...(missing
      ? [
          "The refund couldn't find some of your payment links. Contact support before you clear this browser's data.",
        ]
      : []),
    ...(funds?.savingsFailed ? ["Couldn't check Savings. Try again later."] : []),
    ...(waiting ? [`${usdAtomicFloor(waiting)} is not withdrawable yet.`] : []),
    ...(sent
      ? [`${usdAtomicFloor(sent.refunded)} already sent. Withdraw again to send the rest.`]
      : []),
  ]
  const walletReview = to && (
    <ReviewSheet
      route="wallet"
      lead={reviewCopy.walletBody(walletName ?? "your wallet")}
      wallet={bridgeMode ? withdrawingCopy.browser : walletName ?? undefined}
      figures={{
        total: status ?? usdAtomicFloor(total),
        spendable: usd(funds?.main.refundable),
        savings: usd(funds && shareUsd(savingsFunds?.refundable ?? 0n)),
        fee: gasUsd === undefined ? "Gas in ETH" : `~${usdAtomicFloor(gasUsd)}`,
        receive,
      }}
      notes={
        <div className="ww-cutover__notes">
          <p className="ww-cutover__lead">
            {reviewCopy.to} <code style={{ overflowWrap: "anywhere" }}>{to}</code>
          </p>
          {!bridgeMode && (
            <TextButton testId="cutover-other-wallet" onClick={() => void l1.connect()}>
              {reviewCopy.otherWallet}
            </TextButton>
          )}
          {notes.map((note) => (
            <p key={note} className="ww-cutover__lead">
              {note}
            </p>
          ))}
        </div>
      }
      screening={screening}
      lowBalance={!!funds && gasUsd !== undefined && gasUsd > total}
      failed={unread}
      disabled={!ready}
      onConfirm={() => void submit()}
      onRetry={() => setScan((n) => n + 1)}
      onUpgrade={upgrade}
      onClose={() => setView("choose")}
    />
  )
  const next = (shown: "zk-money" | "wallet") => {
    setChecked(false)
    setRoute(shown)
    if (shown === "zk-money" || bridgeMode) return setView("destination")
    if (!l1.account) void l1.connect()
    else if (l1.wrongChain) void l1.switchNetwork()
    setView("review")
  }
  return (
    <WithdrawChoice
      total={funds ? total : undefined}
      zkMoneyFee={zkFee}
      zkMoneyFeeFailed={feeFailed}
      zkMoneyMoving={moving}
      waiting={
        networkReady
          ? undefined
          : { until: `${new Date(WINDOW_ENDS).toISOString().slice(11, 16)} UTC` }
      }
      walletFee={gasUsd}
      route={route}
      onRoute={setRoute}
      onBack={home}
      onContinue={next}
      onUpgrade={upgrade}
      overlay={
        view === "destination"
          ? destinationSheet
          : view === "zk-review"
          ? zkReview
          : view === "review"
          ? walletReview
          : undefined
      }
    />
  )
}

/** sUSDS share count, to two decimals. */
const shares = (amount: bigint) => Number(formatUnits(amount, DEFAULT_DECIMALS)).toFixed(2)

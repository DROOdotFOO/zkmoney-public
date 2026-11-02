import { formatUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  ActivityListRow,
  GradientInitialAvatar,
  avatarColors,
  type StatusLabel,
} from "@obsidion/web-ds"
import {
  SIPA_PROCESSING_COPY,
  WITHDRAWAL_FUNDS_UNSENT,
  WITHDRAWAL_PHASE_COPY,
  depositDetailId,
  isSettledSipaPhase,
  upgradeRunValue,
  useEnsName,
  withdrawalGroupAmount,
  worstWithdrawalPhase,
  type FeedItem,
  type SavingsItem,
  type WithdrawalExit,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { ensClient } from "../../../lib/ens"
import { fmt } from "../../../lib/fmt"
import { REMIND_TITLE } from "../../../features/contacts/useRemind"
import { contactDisplayName } from "../../../features/contacts/contactsView"
import { SavingsMoveRow } from "../../../features/savings/SavingsMoveRow"
import { paylinkRowShareUrl } from "../../../features/shortLinks"
import { upgradeRunTitle } from "../../../features/migration/upgradeCopy"
import { upgradeRunAccount } from "../../../features/migration/upgradeRunAccount"
import {
  oldVersionRefundOffer,
  withdrawalSent,
} from "../../../features/withdraw/oldVersionWithdrawals"
import { l1TxUrl } from "../../detailRows"
import { rowTimestamp, shortL1Addr, usdFigure } from "../../format"
import { usePhoneLayout } from "../../usePhoneLayout"
import {
  depositRowAmount,
  depositRowStatusLabel,
  requestAmountText,
  txRowView,
  upgradeRowStatusLabel,
} from "../../screens/activityView"
import copy from "../ActivityRow.copy"
import { useActivityHost } from "../ActivityDetailHost/ActivityDetailHost"

type Of<K extends FeedItem["kind"]> = Extract<FeedItem, { kind: K }>

/** Feed-row wording per phase, from the shared copy table; a `done` withdrawal carries no status. */
const phaseLabel = (phase: WithdrawalRecord["phase"]) =>
  WITHDRAWAL_PHASE_COPY[phase].pill as StatusLabel | undefined

const gradient = "gradient" as const

export function exitTitle(exit: WithdrawalExit): string {
  if (exit.kind === "finalize") return copy.action.finalize
  return exit.reason === "stuck" ? copy.action.runSwap : copy.action.recover
}

/** Pending request: Decline/Send incoming, Cancel/Remind to a contact, Cancel/Share on a link. */
function RequestRow({ item, compact }: { item: Of<"request">; compact: boolean }) {
  const host = useActivityHost()
  const { request, role, contact } = item
  const link = role === "outgoingLink"
  const tag = request.contactTag
  const remind = host.remindState(request.id, request.remindedAt)
  const open = () =>
    host.open(
      link
        ? { kind: "requestLink", id: request.id }
        : role === "incoming"
        ? { kind: "incomingRequest", id: request.id }
        : { kind: "sentRequest", id: request.id },
    )
  const actions =
    role === "incoming"
      ? [
          { title: copy.action.decline, onClick: () => host.decline(request.id) },
          { title: copy.action.send, actionStyle: gradient, onClick: () => host.send(request) },
        ]
      : role === "outgoingContact"
      ? [
          {
            title: copy.action.cancel,
            onClick: () => host.open({ kind: "cancelRequest", id: request.id }),
          },
          {
            title: REMIND_TITLE[remind],
            actionStyle: gradient,
            isLoading: remind === "sending",
            isDisabled: remind === "sent",
            onClick: () => host.remind(request.id),
          },
        ]
      : [
          {
            title: copy.action.cancel,
            onClick: () => host.open({ kind: "cancelLink", id: request.id }),
          },
          { title: copy.action.share, actionStyle: gradient, onClick: open },
        ]
  const status =
    role === "incoming"
      ? copy.status.youOwe
      : role === "outgoingContact"
      ? copy.status.owesYou
      : item.detected
      ? copy.status.paymentDetected
      : copy.status.unpaid
  return (
    <ActivityListRow
      counterparty={
        link
          ? copy.counterparty.requestLink
          : contact
          ? contactDisplayName(contact)
          : fmt(copy.counterparty.tag, { tag })
      }
      counterpartyBadge={link ? undefined : copy.badge.requested}
      timestamp={rowTimestamp(item.ts)}
      amount={requestAmountText(item.amount, role === "incoming" ? "-" : "+", link)}
      statusLabel={status}
      avatarIcon={link ? "link" : undefined}
      avatar={
        tag ? (
          <GradientInitialAvatar
            name={(contact ? contactDisplayName(contact) : tag).replace(/^@/, "")}
            colors={avatarColors(tag)}
            size={44}
          />
        ) : undefined
      }
      actions={compact ? [] : actions}
      onClick={open}
      ariaLabel={copy.aria.request}
    />
  )
}

function TxRow({ item }: { item: Of<"tx"> }) {
  const host = useActivityHost()
  const phone = usePhoneLayout()
  const row = txRowView(item)
  const figure = row.amount.replace(/^[+-]/, "")
  return (
    <ActivityListRow
      counterparty={row.counterparty}
      timestamp={row.timestamp}
      amount={row.amount}
      statusLabel={row.statusLabel}
      avatarIcon={row.avatarIcon}
      avatar={
        row.contact ? (
          <GradientInitialAvatar
            name={row.contact.name}
            colors={avatarColors(row.contact.id)}
            size={44}
          />
        ) : undefined
      }
      onClick={() => host.open({ kind: "tx", item })}
      ariaLabel={copy.aria.transaction}
      actions={[
        ...(row.creatorAction
          ? [
              {
                title:
                  row.creatorAction === "reclaim" ? copy.action.reclaim : copy.action.cancelLink,
                onClick: () => host.linkRecovery(item),
              },
            ]
          : []),
        ...(row.paylink && row.canShare
          ? [
              phone
                ? {
                    title: copy.action.share,
                    actionStyle: gradient,
                    onClick: () =>
                      host.shareLink(
                        paylinkRowShareUrl(row.paylink!),
                        fmt(copy.shareText, { amount: figure }),
                      ),
                  }
                : {
                    title: host.copiedLinkId === row.id ? copy.action.copied : copy.action.copyLink,
                    actionStyle: gradient,
                    onClick: () => host.copyLink(row.id, paylinkRowShareUrl(row.paylink!)),
                  },
            ]
          : []),
      ]}
    />
  )
}

function WithdrawalRow({ item }: { item: Of<"withdrawal"> }) {
  const host = useActivityHost()
  const { record, exit, registrationTag, delayed } = item
  const migration = record.intent === "migration"
  // A burn to a backup passkey's deposit address pays for the key.
  const backup = record.intent === "backup"
  const ensName = useEnsName(record.recipient, ensClient)
  const hash = record.l2TxHash
  return (
    <ActivityListRow
      counterparty={
        migration
          ? copy.counterparty.upgrade
          : backup
          ? copy.counterparty.backupPasskey
          : registrationTag
          ? fmt(copy.counterparty.tag, { tag: registrationTag })
          : record.recipientAlias ?? ensName ?? shortL1Addr(record.recipient)
      }
      counterpartyBadge={
        // In flight, the status pill says where the exit is.
        migration
          ? record.phase === "done"
            ? copy.badge.leftOldVersion
            : undefined
          : backup
          ? copy.badge.funding
          : registrationTag
          ? copy.badge.registration
          : record.source === "paylink"
          ? copy.badge.paylinkToEthereum
          : copy.badge.withdrawal
      }
      timestamp={delayed ? copy.stuck : rowTimestamp(item.ts)}
      amount={`-${usdFigure(record.amount)}`}
      statusLabel={phaseLabel(record.phase)}
      avatarIcon="wallet"
      onClick={() => host.open({ kind: "withdrawal", id: record.localId })}
      ariaLabel={copy.aria.withdrawal}
      actions={[
        ...(delayed && hash
          ? [{ title: copy.action.checkAgain, onClick: () => host.checkAgain(hash) }]
          : []),
        ...(exit
          ? [
              {
                title: exitTitle(exit),
                actionStyle: gradient,
                onClick: () => host.withdrawalExit(record, exit),
              },
            ]
          : []),
      ]}
    />
  )
}

function GroupRow({ item }: { item: Of<"withdrawalGroup"> }) {
  const host = useActivityHost()
  const { group, head, delayed, exit } = item
  const hash = delayed?.l2TxHash
  return (
    <ActivityListRow
      counterparty={head.recipientAlias ?? shortL1Addr(head.recipient)}
      counterpartyBadge={copy.badge.freshAddress}
      timestamp={delayed ? copy.stuck : rowTimestamp(item.ts)}
      amount={`-${usdFigure(withdrawalGroupAmount(group))}`}
      statusLabel={item.unsent ? WITHDRAWAL_FUNDS_UNSENT : phaseLabel(worstWithdrawalPhase(group))}
      avatarIcon="wallet"
      onClick={() => host.open({ kind: "withdrawal", id: group.groupId })}
      ariaLabel={copy.aria.withdrawal}
      actions={[
        ...(hash ? [{ title: copy.action.checkAgain, onClick: () => host.checkAgain(hash) }] : []),
        ...(exit
          ? [
              {
                title: exitTitle(exit.exit),
                actionStyle: gradient,
                onClick: () => host.withdrawalExit(exit.record, exit.exit),
              },
            ]
          : []),
      ]}
    />
  )
}

/** One upgrade: its batches and the deposits they bring, as one row until every one has arrived. */
function UpgradeRow({ item }: { item: Of<"upgrade"> }) {
  const host = useActivityHost()
  const { run } = item
  const total = run.legs.length
  const value = upgradeRunValue(run, host.upgradePricing)
  return (
    <ActivityListRow
      counterparty={upgradeRunTitle[upgradeRunAccount(run.run)]}
      counterpartyBadge={
        run.complete
          ? total === 1
            ? copy.badge.oneTransfer
            : fmt(copy.badge.transfers, { count: total })
          : fmt(copy.badge.arrivedOf, { arrived: run.arrived, total })
      }
      timestamp={rowTimestamp(run.time)}
      amount={
        value === undefined
          ? copy.amount.unknown
          : `+${usdFigure(formatUnits(value, DEFAULT_DECIMALS))}`
      }
      statusLabel={upgradeRowStatusLabel(run)}
      avatarIcon="wallet"
      onClick={() => host.open({ kind: "upgradeRun", id: run.run })}
      ariaLabel={copy.aria.upgrade}
    />
  )
}

function DepositRow({ item }: { item: Of<"deposit"> }) {
  const host = useActivityHost()
  const { record, offer, subline, arriving, intent } = item
  return (
    <ActivityListRow
      counterparty={
        intent === "registration"
          ? fmt(copy.counterparty.tag, { tag: item.tag! })
          : intent === "migration"
          ? copy.counterparty.upgrade
          : copy.counterparty.deposit
      }
      counterpartyBadge={
        intent === "registration"
          ? copy.badge.registration
          : intent === "migration" && isSettledSipaPhase(record.phase)
          ? copy.badge.arrived
          : undefined
      }
      timestamp={
        subline === "stuck"
          ? copy.stuck
          : subline
          ? SIPA_PROCESSING_COPY[subline.reason].short
          : rowTimestamp(item.ts)
      }
      amount={
        arriving
          ? arriving.net !== undefined
            ? `+${usdFigure(formatUnits(arriving.net, DEFAULT_DECIMALS))}`
            : ""
          : depositRowAmount(record, !!offer, host.depositDecimals(record.tokenAddress))
      }
      statusLabel={arriving ? copy.status.pending : depositRowStatusLabel(record)}
      avatarIcon="arrow-down-circle"
      onClick={() => host.open({ kind: "deposit", address: depositDetailId(item) })}
      ariaLabel={copy.aria.deposit}
      actions={
        offer
          ? [
              {
                title: offer.action === "sweep" ? copy.action.sweep : copy.action.recover,
                actionStyle: gradient,
                onClick: () => host.depositExit(item),
              },
            ]
          : []
      }
    />
  )
}

/** A "Withdraw to Ethereum" run from old versions; it opens its last refund on Ethereum. */
function OldVersionWithdrawalRow({ item }: { item: Of<"oldVersionWithdrawal"> }) {
  const host = useActivityHost()
  const { record } = item
  const stuck = oldVersionRefundOffer(record)
  const hash = record.refunds.at(-1)?.l1TxHash
  const url = hash && l1TxUrl(hash)
  return (
    <ActivityListRow
      counterparty={shortL1Addr(record.to)}
      counterpartyBadge={copy.badge.oldVersion}
      timestamp={stuck ? copy.stuck : rowTimestamp(record.startTime)}
      amount={`-${usdFigure(formatUnits(withdrawalSent(record), DEFAULT_DECIMALS))}`}
      statusLabel={record.phase === "done" ? undefined : copy.status.releasing}
      avatarIcon="arrow.up.right"
      onClick={() => url && window.open(url, "_blank", "noopener")}
      ariaLabel={copy.aria.oldVersionWithdrawal}
      actions={
        stuck
          ? [
              {
                title: copy.action.processManually,
                actionStyle: gradient,
                onClick: () => host.oldVersionExit(record, stuck),
              },
            ]
          : []
      }
    />
  )
}

/** The rows a feed item draws. `compact`: an unpaid request as a plain row that opens its detail. */
export function ActivityRow({ item, compact = false }: { item: FeedItem; compact?: boolean }) {
  const host = useActivityHost()
  switch (item.kind) {
    case "request":
      return <RequestRow item={item} compact={compact} />
    case "paidLink":
      return (
        <ActivityListRow
          counterparty={copy.counterparty.requestLink}
          timestamp={rowTimestamp(item.ts)}
          amount={requestAmountText(item.amount, "+", true)}
          statusLabel={copy.status.paid}
          avatarIcon="link"
          onClick={() => host.open({ kind: "requestLink", id: item.id })}
          ariaLabel={copy.aria.requestLink}
        />
      )
    case "tx":
      return <TxRow item={item} />
    case "upgrade":
      return <UpgradeRow item={item} />
    case "withdrawalGroup":
      return <GroupRow item={item} />
    case "withdrawal":
      return <WithdrawalRow item={item} />
    case "savingsMove":
      return (
        <SavingsMoveRow
          move={item.move}
          burn={item.burn}
          perspective="main"
          sharePrice={host.sharePrice}
          eta={host.savingsEta(item.move, item.burn)}
          onOpen={() => host.open({ kind: "savings", id: item.id })}
        />
      )
    case "deposit":
      return <DepositRow item={item} />
    case "tagPurchase":
      return (
        <ActivityListRow
          counterparty={copy.counterparty.tagPurchase}
          counterpartyBadge={fmt(copy.counterparty.tag, { tag: item.tag })}
          timestamp={rowTimestamp(item.ts + 1)}
          amount={`-${usdFigure(formatUnits(item.price, DEFAULT_DECIMALS))}`}
          avatarIcon="at"
          onClick={() => host.open({ kind: "tag", address: item.record.sipaAddress })}
          ariaLabel={copy.aria.tagPurchase}
        />
      )
    case "registration":
      return <>{host.registrationNode}</>
    case "oldVersionWithdrawal":
      return <OldVersionWithdrawalRow item={item} />
  }
}

/** A Savings move as the Savings account's feed shows it. */
export function SavingsActivityRow({ item }: { item: SavingsItem }) {
  const host = useActivityHost()
  return (
    <SavingsMoveRow
      move={item.move}
      burn={item.burn}
      perspective="savings"
      sharePrice={host.sharePrice}
      eta={host.savingsEta(item.move, item.burn)}
      onOpen={() => host.open({ kind: "savings", id: item.id })}
    />
  )
}

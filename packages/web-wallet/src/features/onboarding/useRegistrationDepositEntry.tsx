import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { formatUnits, type Address } from "viem"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import {
  SIPADepositStore,
  depositOwed,
  fundsIn,
  isUnfundedSipaDeposit,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { ActivityListRow } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { RegistrationDepositDetailModal } from "./RegistrationDepositDetailModal/RegistrationDepositDetailModal"
import { useFundingTransfer } from "./registrationFunding"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { rowTimestamp, usdFigure } from "../../ui/format"
import { DETECTING_AMOUNT } from "../../ui/screens/activityView"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useDepositAdmission } from "../identity/admission"
import {
  quotedRegistrationKind,
  recordRegistrationDeposit,
  registrationDepositCredit,
  registrationDepositGross,
  registrationQuote,
  scheduleForRecord,
  signedWithoutSchedule,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useRegistrationTerms,
} from "./registrationTerms"
import { registrationRecordForSipa } from "./registrationSweep"
import {
  reportRegistrationDepositFunded,
  reportRegistrationDepositSwept,
} from "./registrationFunnel"
import { formatTokenAmount } from "./steps/DepositTermsRows"
import { useDepositWatch } from "./useDepositWatch"
import { getPendingStore } from "./webRegistration"
import { useRegistrationStage } from "./openRegistration"

/** The feed's placeholder, re-exported: the registration surfaces speak the same words as the rail. */
export { DETECTING_AMOUNT }

/**
 * The tag a SIPA deposit registered, when the address is one of this wallet's registration SIPAs —
 * the rail's own row and detail then keep the registration identity instead of morphing into an
 * anonymous deposit once they take over.
 */
export function registrationTagForSipa(sipaAddress: string): string | undefined {
  const pending = registrationRecordForSipa(sipaAddress)
  if (pending) return pending.tag
  // Discovered from the note on another device: no registration record, but the rail's record
  // carries the intent, and the name a registration SIPA registered is this wallet's own.
  const record = SIPADepositStore.get(webStorage).get(sipaAddress as Address)
  return record?.intent === "registration" ? loadWalletIdentity()?.handle : undefined
}

/** The tag a deposit row wears: none once the deposit went back and left the name unpaid. */
export function registrationTagForDeposit(sipaAddress: string): string | undefined {
  const pending = registrationRecordForSipa(sipaAddress)
  return pending && refundedAwaitingPayment(pending)
    ? undefined
    : registrationTagForSipa(sipaAddress)
}

/**
 * The deposit was recovered and the registration is waiting for payment again, so the feed shows
 * the returned funds and the registration as two rows.
 */
function refundedAwaitingPayment(record: PendingRegistrationRecord): boolean {
  const deposit = SIPADepositStore.get(webStorage).get(record.sipaAddress as Address)
  return (
    deposit?.phase === "recovered" &&
    record.phase === "awaiting_deposit" &&
    record.fundedAt === undefined
  )
}

/**
 * The active wallet's registration the feed should still speak for: the open one, else the latest
 * confirmed one — unless the SIPA rail has taken the deposit over (its record holds the funds; from
 * there the rail's own deposit row and detail show, as for any deposit, instead of a duplicate).
 * A registration whose deposit was recovered speaks again while it waits for payment.
 */
export function registrationForFeed(): PendingRegistrationRecord | null {
  const identity = loadWalletIdentity()
  if (!identity) return null
  const mine = (r: PendingRegistrationRecord) =>
    r.l2Address.toLowerCase() === identity.address.toLowerCase()
  const store = getPendingStore()
  const speaking =
    store.current(identity.address) ??
    store.list().find((r) => r.phase === "confirmed" && mine(r)) ??
    null
  if (!speaking) return null
  const deposit = SIPADepositStore.get(webStorage).get(speaking.sipaAddress as never)
  return !deposit || isUnfundedSipaDeposit(deposit) || refundedAwaitingPayment(speaking)
    ? speaking
    : null
}

export interface RegistrationDepositEntry {
  ts: number
  /** The registration's address, so the feed can tell a burn from this wallet funded it. */
  sipaAddress: string
  node: ReactNode
  /** The detail the row opens; hosted with the feed's other modals. */
  modal: ReactNode
}

/**
 * The registration deposit as a pending row in the activity feed, read from the registration
 * record: once a deposit has been seen at the address, a "Registration deposit" row opens its
 * detail (pay QR + address inline while the address still needs funds), and stays after the name
 * confirms until the SIPA rail's own deposit row takes over.
 */
export function useRegistrationDepositEntry(): RegistrationDepositEntry | null {
  const config = getConfig()
  const key = useSyncExternalStore(
    (onChange) => {
      const offRegistration = getPendingStore().onListChanged(onChange)
      const offDeposits = SIPADepositStore.get(webStorage).onListChanged(onChange)
      return () => {
        offRegistration()
        offDeposits()
      }
    },
    () => {
      const r = registrationForFeed()
      return r ? `${r.account}:${r.phase}` : null
    },
  )
  const record = key === null ? null : registrationForFeed()
  const stage = useRegistrationStage(record)
  const depositAdmitted = useDepositAdmission(record)
  // Cross-session funnel laps observed from the durable record (the onboarding tab may be gone);
  // the reporters latch per address/account, so re-renders and reloads never double-count.
  useEffect(() => {
    if (!record) return
    if (record.fundedAt !== undefined) {
      reportRegistrationDepositFunded(record.sipaAddress, record.fundedAt - record.startTime)
    }
    if (record.sweptAt !== undefined) {
      reportRegistrationDepositSwept(
        record.account,
        record.sweptAt - (record.fundedAt ?? record.startTime),
      )
    }
  }, [record])
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  const unsignedFallback = signedWithoutSchedule(terms)
  // The detail this row opens is priced off the same reads, so they are held here and handed down.
  const sweepFee = useDepositSkim(config, record !== null, readAttempt)
  const chainAmounts = useRegistrationSchedule(
    config,
    record !== null && unsignedFallback,
    readAttempt,
    sweepFee,
  )
  // Before the sweep the address still holds the deposit; after it, the stamped terms or the
  // funding transfer do.
  const watch = useDepositWatch(
    record && stage != null && depositOwed(stage) ? (record.sipaAddress as never) : null,
  )
  const live = watch.balance
  // Stamp the live gross; the sweep empties the address.
  useEffect(() => {
    if (!record || live <= 0n) return
    recordRegistrationDeposit(record.account, record.tag, live)
  }, [record, live])
  const funding = useFundingTransfer(record, readAttempt)
  useChainReadRetry(
    record !== null &&
      ((unsignedFallback && chainAmounts === undefined) ||
        funding === undefined ||
        sweepFee === undefined),
    retryReads,
  )
  const [open, setOpen] = useState(false)
  // Unknown while the withdrawals load: the row waits.
  if (!record || stage == null) return null
  const gross = registrationDepositGross(
    live,
    funding === undefined ? undefined : funding?.normalized ?? 0n,
    terms?.depositAmount ? BigInt(terms.depositAmount) : 0n,
  )
  const returned = refundedAwaitingPayment(record)
  const seen =
    returned || depositAdmitted || stage === "registered" || fundsIn(stage) || (gross ?? 0n) > 0n
  if (!seen) return null
  const decimals = tokenDecimalsForNetwork(config.network)
  const committedFee = record.fee !== undefined ? BigInt(record.fee) : undefined
  const amounts = unsignedFallback ? chainAmounts ?? undefined : undefined
  // A schedule prices this record only while it names the fee the address committed to. Committed
  // fee on the record wins; the schedule is only for pre-intent records. A waived tag still owes
  // that fee (the relayer's cut).
  const schedule = scheduleForRecord(terms, amounts, committedFee)
  // Nothing prices this record and no read is outstanding, so no placeholder will be replaced. The
  // row names what was deposited instead.
  const scheduleUnavailable =
    schedule === undefined && !(unsignedFallback && chainAmounts === undefined)
  const feeOwed = committedFee ?? schedule?.fee
  // The floor decides whether the deposit is taken; the asked total is what a row still waiting for
  // one quotes.
  const kind = quotedRegistrationKind(terms?.feeWaived, schedule)
  const quote = registrationQuote(schedule, kind)
  const { credit, short } = registrationDepositCredit({ gross, floor: quote.floor, feeOwed })
  // A short deposit credits nothing, so the row names what was deposited, unsigned, the way the
  // rail's own rows name a deposit no sweep will move. An unpriceable one names it the same way.
  const amountLabel = returned
    ? ""
    : credit !== undefined
    ? credit > 0n
      ? `+${usdFigure(formatUnits(credit, decimals))}`
      : ""
    : (short || scheduleUnavailable) && gross !== undefined && gross > 0n
    ? usdFigure(formatUnits(gross, decimals))
    : undefined
  const feeLabel =
    feeOwed === undefined
      ? undefined
      : `${formatTokenAmount(feeOwed, decimals, WALLET_TOKEN_SYMBOL)}${
          terms?.feeWaived ? " (tag price waived)" : ""
        }`
  const ts = record.fundedAt ?? record.startTime
  // Only a deposit the machine has not credited yet still needs the pay QR + address; once funded
  // the modal's facts take over.
  const pay =
    // A deployment that prices no registration a sweep could take has nothing to ask for.
    !(unsignedFallback && chainAmounts === null) && depositOwed(stage) && !depositAdmitted
      ? {
          token: record.depositToken as Address,
          chainId: record.l1ChainId,
          total: quote.total,
          tokenSymbol: WALLET_TOKEN_SYMBOL,
          kind,
          heldToken: live > 0n ? watch.token : undefined,
          terms:
            live > 0n
              ? undefined
              : {
                  total: quote.total,
                  fee: feeOwed,
                  sweepFee,
                  tokenSymbol: WALLET_TOKEN_SYMBOL,
                  tokenDecimals: decimals,
                  kind,
                  scheduleUnavailable,
                },
        }
      : undefined
  return {
    ts,
    sipaAddress: record.sipaAddress,
    node: (
      <ActivityListRow
        key={`registration:${record.sipaAddress}`}
        counterparty={`@${record.tag}`}
        counterpartyBadge="Registration"
        timestamp={rowTimestamp(ts)}
        amount={amountLabel ?? (scheduleUnavailable ? "" : DETECTING_AMOUNT)}
        statusLabel="Pending"
        avatarIcon="arrow-down-circle"
        onClick={() => setOpen(true)}
        ariaLabel="Open registration deposit details"
      />
    ),
    modal: open ? (
      <RegistrationDepositDetailModal
        record={record}
        terms={terms}
        funding={funding}
        sweepFee={sweepFee}
        amount={amountLabel || "Deposit"}
        deposited={
          funding
            ? formatTokenAmount(funding.amount, funding.token.decimals, funding.token.symbol)
            : gross !== undefined && gross > 0n
            ? formatTokenAmount(gross, decimals, WALLET_TOKEN_SYMBOL)
            : undefined
        }
        feeLabel={feeLabel}
        pay={pay}
        onClose={() => setOpen(false)}
      />
    ) : null,
  }
}

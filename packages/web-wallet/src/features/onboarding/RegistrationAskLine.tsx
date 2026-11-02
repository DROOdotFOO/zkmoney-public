import { useCallback, useState } from "react"
import type { Address } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { useStore } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { ticketActivation } from "../paylink/ticketContinuation"
import { useOpenRegistration } from "./openRegistration"
import {
  quoteExpired,
  quotedRegistrationKind,
  registrationQuote,
  scheduleForRecord,
  signedWithoutSchedule,
  termsUnpriced,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useRegistrationTerms,
} from "./registrationTerms"
import { formatDepositDue, formatDepositSeen } from "./steps/DepositTermsRows"
import { useDepositWatch } from "./useDepositWatch"
import { useRegistrationPublishStalled } from "./webRegistration"
import { session } from "../../platform/session"

export interface RegistrationAsk {
  /** The asked total, undefined while it is read. */
  total?: bigint
  /** The least the registration's sweep accepts, undefined while it is read. */
  floor?: bigint
  /** What the sweep takes before crediting: the registration fee. */
  spent?: bigint
  /** Already at the address. */
  seen: bigint
  /** What is left to send, once part of the total is at the address. */
  remaining?: bigint
}

/**
 * The open registration's ask, priced as the registration sheet prices it, and what its address
 * already holds. Null where the deposit surfaces send the user elsewhere.
 */
export function useRegistrationAsk(): RegistrationAsk | null {
  const config = getConfig()
  const record = useOpenRegistration()?.record ?? null
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  const readSchedule = record !== null && unsignedFallback
  const sweepFee = useDepositSkim(config, readSchedule, readAttempt)
  const chainAmounts = useRegistrationSchedule(config, readSchedule, readAttempt, sweepFee)
  useChainReadRetry(readSchedule && chainAmounts === undefined, retryReads)
  const watch = useDepositWatch(record ? (record.sipaAddress as Address) : null)
  const stalled = useRegistrationPublishStalled(record)
  const burns = useStore(session().withdrawals.list)
  // Unknown while the withdrawals load: a ticket's burn may already fund it.
  if (!record || !burns.hydrated || stalled || record.l1ChainId !== config.l1ChainId) return null
  if (quoteExpired(terms, Date.now()) || (unsignedFallback && chainAmounts === null)) return null
  if (ticketActivation(record, terms, burns.records)) return null
  const schedule = scheduleForRecord(
    terms,
    unsignedFallback ? chainAmounts ?? undefined : undefined,
    record.fee !== undefined ? BigInt(record.fee) : undefined,
  )
  const kind = quotedRegistrationKind(feeWaived, schedule)
  const quote = kind && registrationQuote(schedule, kind)
  const total = quote?.total
  const floor = quote?.floor
  const recorded = terms?.depositAmount ? BigInt(terms.depositAmount) : 0n
  const seen = watch.balance > recorded ? watch.balance : recorded
  const remaining = total !== undefined && seen > 0n && seen < total ? total - seen : undefined
  const feeOwed = record.fee !== undefined ? BigInt(record.fee) : schedule?.fee
  return { total, floor, spent: feeOwed, seen, remaining }
}

/** The registration's ask on the deposit screen, less what its address already holds. */
export function RegistrationAskLine() {
  const ask = useRegistrationAsk()
  if (!ask) return null
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  return (
    <p className="ww-deposit__ask" data-testid="deposit-registration-ask">
      {ask.total === undefined ? (
        "Checking how much to deposit…"
      ) : ask.remaining !== undefined ? (
        <>
          {formatDepositSeen(ask.seen, decimals)} of {formatDepositDue(ask.total, decimals)}{" "}
          received. Deposit at least <strong>{formatDepositDue(ask.remaining, decimals)}</strong>{" "}
          more to activate your account.
        </>
      ) : (
        <>
          Deposit at least <strong>{formatDepositDue(ask.total, decimals)}</strong> to activate your
          account.
        </>
      )}
    </p>
  )
}

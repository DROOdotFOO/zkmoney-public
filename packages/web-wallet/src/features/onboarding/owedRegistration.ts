import { depositOwed, useStore, type PendingRegistrationRecord } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { useDepositAdmission } from "../identity/admission"
import { ticketActivation } from "../paylink/ticketContinuation"
import { useOpenRegistration } from "./openRegistration"
import { useRegistrationRefunded } from "./registrationQuoteRecovery"
import { quoteExpired, signedWithoutSchedule, useRegistrationTerms } from "./registrationTerms"
import { useRegistrationPublishStalled } from "./webRegistration"
import { session } from "../../platform/session"

export interface OwedRegistration {
  record: PendingRegistrationRecord
  /** The deposit screen cannot ask for this deposit: the pending step resolves it first. */
  needsCheck: boolean
}

/** The open registration while it owes its deposit, null otherwise. */
export function useOwedRegistration(): OwedRegistration | null {
  const open = useOpenRegistration()
  const record = open?.stage !== undefined && depositOwed(open.stage) ? open.record : null
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const stalled = useRegistrationPublishStalled(record)
  const admitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const burns = useStore(session().withdrawals.list)
  // Unknown while the withdrawals load: a ticket's burn may already fund it.
  if (!record || !burns.hydrated) return null
  const nowMs = Date.now()
  const needsCheck =
    record.l1ChainId !== getConfig().l1ChainId ||
    ticketActivation(record, terms, burns.records, nowMs) !== null ||
    quoteExpired(terms, nowMs) ||
    signedWithoutSchedule(terms) ||
    stalled ||
    admitted ||
    refunded
  return { record, needsCheck }
}
